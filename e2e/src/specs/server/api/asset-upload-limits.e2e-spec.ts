import { getConfig, getMyUser, LoginResponseDto, ManualJobName, updateConfig } from '@immich/sdk';
import { createHash, randomBytes } from 'node:crypto';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, baseUrl, utils } from 'src/utils.js';
import { serializeDictionary } from 'structured-headers';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const sha1 = (content: Buffer) => createHash('sha1').update(content).digest('base64');

const start = (token: string, content: Buffer, sent: number) =>
  request(baseUrl)
    .post('/api/upload')
    .set('Authorization', `Bearer ${token}`)
    .set('Upload-Draft-Interop-Version', '8')
    .set('Upload-Complete', sent === content.length ? '?1' : '?0')
    .set('Upload-Length', content.length.toString())
    .set('Repr-Digest', `sha=:${sha1(content)}:`)
    .set(
      'X-Immich-Asset-Data',
      serializeDictionary({
        filename: `${randomBytes(4).toString('hex')}.jpg`,
        'file-created-at': new Date('2025-01-02T00:00:00Z').toISOString(),
        'file-modified-at': new Date('2025-01-01T00:00:00Z').toISOString(),
      }),
    )
    .send(content.subarray(0, sent));

const append = (token: string, location: string, offset: number, body: Buffer, complete: boolean) =>
  request(baseUrl)
    .patch(location)
    .set('Authorization', `Bearer ${token}`)
    .set('Upload-Draft-Interop-Version', '8')
    .set('Upload-Offset', offset.toString())
    .set('Upload-Complete', complete ? '?1' : '?0')
    .set('Content-Type', 'application/partial-upload')
    .send(body);

const head = (token: string, location: string) =>
  request(baseUrl).head(location).set('Authorization', `Bearer ${token}`).set('Upload-Draft-Interop-Version', '8');

const idOf = (location: string) => location.replace('/api/upload/', '');

const backdate = async (location: string, hours: number) => {
  const client = await utils.connectDatabase();
  await client.query(`UPDATE asset SET "createdAt" = now() - make_interval(hours => $2) WHERE id = $1`, [
    idOf(location),
    hours,
  ]);
};

describe('resumable upload limits', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;

  const setUploadConfig = async (upload: Record<string, number>) => {
    const config = await getConfig({ headers: asBearerAuth(admin.accessToken) });
    await updateConfig(
      { adminConfigDto: { ...config, backup: { ...config.backup, upload: { ...config.backup.upload, ...upload } } } },
      { headers: asBearerAuth(admin.accessToken) },
    );
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    user = await utils.userSetup(admin.accessToken, createUserDto.user1);
  });

  afterEach(async () => {
    await utils.resetAdminConfig(admin.accessToken);
  });

  describe('max-append-size', () => {
    it('should refuse creation and append requests larger than max-append-size with 413', async () => {
      await setUploadConfig({ maxAppendSizeBytes: 1000 });
      const content = randomBytes(3000);

      const tooLargeStart = await start(user.accessToken, content, 2000);
      expect(tooLargeStart.status).toBe(413);
      expect(tooLargeStart.headers['upload-limit']).toContain('max-append-size=1000');

      const started = await start(user.accessToken, content, 1000);
      expect(started.status).toBe(201);
      const tooLargeAppend = await append(
        user.accessToken,
        started.headers['location'],
        1000,
        content.subarray(1000),
        true,
      );
      expect(tooLargeAppend.status).toBe(413);
      expect(tooLargeAppend.headers['upload-limit']).toContain('max-append-size=1000');

      await expect(head(user.accessToken, started.headers['location'])).resolves.toHaveProperty(
        'headers.upload-offset',
        '1000',
      );
    });
  });

  describe('per-user cap', () => {
    it('should refuse a new upload over the cap until one is cancelled', async () => {
      await setUploadConfig({ maxPartialUploads: 2 });
      const owner = await utils.userSetup(admin.accessToken, createUserDto.create('cap'));
      const [first, second, third] = [randomBytes(500), randomBytes(500), randomBytes(500)];

      const firstStart = await start(owner.accessToken, first, 100);
      await start(owner.accessToken, second, 100);
      const refused = await start(owner.accessToken, third, 100);
      expect(refused.status).toBe(429);

      const otherUser = await start(user.accessToken, randomBytes(500), 100);
      expect(otherUser.status).toBe(201);

      await request(baseUrl).delete(firstStart.headers['location']).set('Authorization', `Bearer ${owner.accessToken}`);
      await expect(start(owner.accessToken, third, 100)).resolves.toHaveProperty('status', 201);
    });
  });

  describe('max-age', () => {
    it('should advertise less max-age as an upload gets older', async () => {
      const started = await start(user.accessToken, randomBytes(500), 100);
      await backdate(started.headers['location'], 2);

      const { headers } = await head(user.accessToken, started.headers['location']);

      const maxAge = Number(/max-age=(\d+)/.exec(headers['upload-limit'])?.[1]);
      expect(maxAge).toBeLessThanOrEqual(70 * 3600);
      expect(maxAge).toBeGreaterThan(70 * 3600 - 60);
    });

    it('should stop serving an expired upload and let the client start over', async () => {
      const content = randomBytes(500);
      const started = await start(user.accessToken, content, 100);
      const location = started.headers['location'];
      await backdate(location, 73);

      await expect(head(user.accessToken, location)).resolves.toHaveProperty('status', 404);
      await expect(append(user.accessToken, location, 100, content.subarray(100), true)).resolves.toHaveProperty(
        'status',
        404,
      );

      const restarted = await start(user.accessToken, content, 100);
      expect(restarted.status).toBe(201);
      expect(restarted.headers['location']).not.toBe(location);
      await expect(head(user.accessToken, location)).resolves.toHaveProperty('status', 404);
    });
  });

  describe('sweep', () => {
    it('should remove abandoned uploads, keep finished bytes and leave recent uploads alone', async () => {
      const owner = await utils.userSetup(admin.accessToken, createUserDto.create('sweep'));
      const abandoned = randomBytes(4000);
      const allBytes = randomBytes(3000);
      const recent = randomBytes(2000);

      const abandonedStart = await start(owner.accessToken, abandoned, 1000);
      const allBytesStart = await start(owner.accessToken, allBytes, 1000);
      await append(owner.accessToken, allBytesStart.headers['location'], 1000, allBytes.subarray(1000), false);
      const recentStart = await start(owner.accessToken, recent, 500);
      await backdate(abandonedStart.headers['location'], 73);
      await backdate(allBytesStart.headers['location'], 73);
      const before = await getMyUser({ headers: asBearerAuth(owner.accessToken) });
      expect(before.quotaUsageInBytes).toBe(4000 + 3000 + 2000);

      const { status } = await request(app)
        .post('/jobs')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ name: ManualJobName.UploadCleanup });
      expect(status).toBe(204);
      await utils.waitForQueueFinish(admin.accessToken, 'backgroundTask');

      const client = await utils.connectDatabase();
      const { rows } = await client.query(`SELECT id, status, visibility FROM asset WHERE "ownerId" = $1 ORDER BY id`, [
        owner.userId,
      ]);
      expect(rows).toEqual(
        expect.arrayContaining([
          { id: idOf(allBytesStart.headers['location']), status: 'active', visibility: 'timeline' },
          { id: idOf(recentStart.headers['location']), status: 'partial', visibility: 'hidden' },
        ]),
      );
      expect(rows.map(({ id }: { id: string }) => id)).not.toContain(idOf(abandonedStart.headers['location']));
      const after = await getMyUser({ headers: asBearerAuth(owner.accessToken) });
      expect(after.quotaUsageInBytes).toBe(3000 + 2000);
    });
  });
});
