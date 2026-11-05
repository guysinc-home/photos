import { getMyUser, LoginResponseDto } from '@immich/sdk';
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { createUserDto } from 'src/fixtures.js';
import { asBearerAuth, baseUrl, utils } from 'src/utils.js';
import { serializeDictionary } from 'structured-headers';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const sha1 = (content: Buffer) => createHash('sha1').update(content).digest('base64');

const assetData = (filename: string) =>
  serializeDictionary({
    filename,
    'file-created-at': new Date('2025-01-02T00:00:00Z').toISOString(),
    'file-modified-at': new Date('2025-01-01T00:00:00Z').toISOString(),
  });

const start = (token: string, { body, length, digest }: { body: Buffer; length: number; digest: string }) =>
  request(baseUrl)
    .post('/api/upload')
    .set('Authorization', `Bearer ${token}`)
    .set('Upload-Draft-Interop-Version', '8')
    .set('Upload-Complete', '?0')
    .set('Upload-Length', length.toString())
    .set('Repr-Digest', `sha=:${digest}:`)
    .set('X-Immich-Asset-Data', assetData(`${randomBytes(4).toString('hex')}.jpg`))
    .send(body);

const append = (token: string, location: string, offset: number, body: Buffer, complete: boolean) =>
  request(baseUrl)
    .patch(location)
    .set('Authorization', `Bearer ${token}`)
    .set('Upload-Draft-Interop-Version', '8')
    .set('Upload-Offset', offset.toString())
    .set('Upload-Complete', complete ? '?1' : '?0')
    .set('Content-Type', 'application/partial-upload')
    .send(body);

const offsetOf = async (token: string, location: string) => {
  const { status, headers } = await request(baseUrl)
    .head(location)
    .set('Authorization', `Bearer ${token}`)
    .set('Upload-Draft-Interop-Version', '8');
  return { status, offset: Number(headers['upload-offset']) };
};

const quotaUsage = async (token: string) => {
  const { quotaUsageInBytes } = await getMyUser({ headers: asBearerAuth(token) });
  return quotaUsageInBytes ?? 0;
};

const inconsistentLength = expect.objectContaining({
  type: 'https://iana.org/assignments/http-problem-types#inconsistent-upload-length',
});

describe('resumable upload integrity', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    user = await utils.userSetup(admin.accessToken, createUserDto.user1);
  });

  describe('declared length', () => {
    it('should reject a creation request whose body is longer than the declared length', async () => {
      const before = await quotaUsage(user.accessToken);
      const body = randomBytes(100_000);

      const { status, body: problem } = await start(user.accessToken, {
        body,
        length: 10,
        digest: sha1(body),
      });

      expect(status).toBe(400);
      expect(problem).toEqual(inconsistentLength);
      await expect(quotaUsage(user.accessToken)).resolves.toBe(before);
    });

    it('should reject an append that would run past the declared length, across several appends', async () => {
      const content = randomBytes(3000);
      const first = await start(user.accessToken, {
        body: content.subarray(0, 1000),
        length: 3000,
        digest: sha1(content),
      });
      const location = first.headers['location'];

      await expect(
        append(user.accessToken, location, 1000, content.subarray(1000, 2500), false),
      ).resolves.toHaveProperty('status', 204);
      const overrun = await append(user.accessToken, location, 2500, randomBytes(1000), false);

      expect(overrun.status).toBe(400);
      expect(overrun.body).toEqual(inconsistentLength);
      await expect(offsetOf(user.accessToken, location)).resolves.toEqual({ status: 204, offset: 2500 });
    });

    it('should not finish an upload whose total differs from the declared length', async () => {
      const actual = randomBytes(2000);
      const before = await quotaUsage(user.accessToken);
      const first = await start(user.accessToken, {
        body: actual.subarray(0, 1000),
        length: 3000,
        digest: sha1(actual),
      });
      const location = first.headers['location'];

      const finish = await append(user.accessToken, location, 1000, actual.subarray(1000), true);

      expect(finish.status).toBe(400);
      expect(finish.body).toEqual(inconsistentLength);
      await expect(offsetOf(user.accessToken, location)).resolves.toEqual({ status: 204, offset: 1000 });
      await expect(quotaUsage(user.accessToken)).resolves.toBe(before + 3000);
    });

    it('should count exactly the stored bytes against quota once finished', async () => {
      const content = randomBytes(4321);
      const before = await quotaUsage(user.accessToken);
      const first = await start(user.accessToken, {
        body: content.subarray(0, 1000),
        length: content.length,
        digest: sha1(content),
      });

      const finish = await append(user.accessToken, first.headers['location'], 1000, content.subarray(1000), true);

      expect(finish.status).toBe(200);
      await setTimeout(500);
      await expect(quotaUsage(user.accessToken)).resolves.toBe(before + content.length);
      const downloaded = await utils.downloadAsset(user.accessToken, finish.body.id);
      expect(downloaded.size).toBe(content.length);
    });
  });

  describe('conventional retry over a partial upload', () => {
    it('should replace whatever the partial file held with the retried bytes', async () => {
      const content = randomBytes(8192);
      const garbage = randomBytes(4096);
      await start(user.accessToken, { body: garbage, length: content.length, digest: sha1(content) });

      const { status, body } = await request(baseUrl)
        .post('/api/upload')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .set('Repr-Digest', `sha=:${sha1(content)}:`)
        .set('X-Immich-Asset-Data', assetData('retry.jpg'))
        .send(content);

      expect(status).toBe(200);
      const downloaded = await utils.downloadAsset(user.accessToken, body.id);
      expect(sha1(Buffer.from(await downloaded.arrayBuffer()))).toBe(sha1(content));
    });
  });

  describe('concurrency', () => {
    it('should finish more uploads at once than the database pool has connections', async () => {
      const uploads = await Promise.all(
        Array.from({ length: 25 }, async () => {
          const content = randomBytes(2048);
          const first = await start(user.accessToken, {
            body: content.subarray(0, 1024),
            length: content.length,
            digest: sha1(content),
          });
          return { content, location: first.headers['location'] as string };
        }),
      );

      const finishes = await Promise.all(
        uploads.map(({ content, location }) =>
          append(user.accessToken, location, 1024, content.subarray(1024), true).timeout(20_000),
        ),
      );

      expect(finishes.map(({ status }) => status)).toEqual(uploads.map(() => 200));
    });

    it('should let a cancel stop an append that is still receiving data', async () => {
      const content = randomBytes(200_000);
      const first = await start(user.accessToken, {
        body: content.subarray(0, 1000),
        length: content.length,
        digest: sha1(content),
      });
      const location = first.headers['location'];

      const stalled = httpRequest({
        hostname: '127.0.0.1',
        port: 2285,
        path: location,
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          'Upload-Draft-Interop-Version': '8',
          'Upload-Offset': '1000',
          'Upload-Complete': '?1',
          'Content-Type': 'application/partial-upload',
          'Content-Length': (content.length - 1000).toString(),
        },
      });
      stalled.on('error', () => {});
      stalled.write(content.subarray(1000, 5000));
      await setTimeout(300);

      const cancelled = await request(baseUrl)
        .delete(location)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .timeout(10_000);
      stalled.destroy();

      expect(cancelled.status).toBe(204);
      await expect(offsetOf(user.accessToken, location)).resolves.toHaveProperty('status', 404);
      await expect(append(user.accessToken, location, 5000, content.subarray(5000), true)).resolves.toHaveProperty(
        'status',
        404,
      );
    });
  });
});
