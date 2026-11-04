import { AssetMediaStatus, getMyUser, LoginResponseDto, Permission, SharedLinkType } from '@immich/sdk';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Socket } from 'socket.io-client';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, baseUrl, testAssetDir, utils } from 'src/utils.js';
import { serializeDictionary } from 'structured-headers';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const sha1 = (content: Buffer) => createHash('sha1').update(content).digest('base64');

const assetDataFor = (filename: string) =>
  serializeDictionary({
    filename,
    'file-created-at': new Date('2025-01-02T00:00:00Z').toISOString(),
    'file-modified-at': new Date('2025-01-01T00:00:00Z').toISOString(),
  });

type Auth = { header: string; value: string };
const bearer = (accessToken: string): Auth => ({ header: 'Authorization', value: `Bearer ${accessToken}` });

const startUpload = (auth: Auth, content: Buffer, firstChunk: Buffer, filename = 'resume.jpg') =>
  request(baseUrl)
    .post('/api/upload')
    .set(auth.header, auth.value)
    .set('Upload-Draft-Interop-Version', '8')
    .set('Upload-Complete', firstChunk.length === content.length ? '?1' : '?0')
    .set('Upload-Length', content.length.toString())
    .set('Repr-Digest', `sha=:${sha1(content)}:`)
    .set('X-Immich-Asset-Data', assetDataFor(filename))
    .send(firstChunk);

const append = (auth: Auth, location: string, offset: number, chunk: Buffer, complete: boolean) =>
  request(baseUrl)
    .patch(location)
    .set(auth.header, auth.value)
    .set('Upload-Draft-Interop-Version', '8')
    .set('Upload-Offset', offset.toString())
    .set('Upload-Complete', complete ? '?1' : '?0')
    .set('Content-Type', 'application/partial-upload')
    .send(chunk);

const getOffset = async (auth: Auth, location: string) => {
  const { status, headers } = await request(baseUrl)
    .head(location)
    .set(auth.header, auth.value)
    .set('Upload-Draft-Interop-Version', '8');
  return { status, offset: Number(headers['upload-offset']), complete: headers['upload-complete'] };
};

const uploadInChunks = async (auth: Auth, content: Buffer, chunkSize: number, filename?: string) => {
  const first = await startUpload(auth, content, content.subarray(0, chunkSize), filename);
  expect(first.status).toBe(content.length <= chunkSize ? 200 : 201);
  if (content.length <= chunkSize) {
    return first.body.id as string;
  }

  const location = first.headers['location'];
  let offset = chunkSize;
  let response = first;
  while (offset < content.length) {
    const chunk = content.subarray(offset, offset + chunkSize);
    response = await append(auth, location, offset, chunk, offset + chunk.length === content.length);
    offset += chunk.length;
  }
  expect(response.status).toBe(200);
  return response.body.id as string;
};

const interruptedAppend = async (auth: Auth, location: string, offset: number, chunk: Buffer, sentBytes: number) => {
  const req = httpRequest({
    hostname: '127.0.0.1',
    port: 2285,
    path: location,
    method: 'PATCH',
    headers: {
      [auth.header]: auth.value,
      'Upload-Draft-Interop-Version': '8',
      'Upload-Offset': offset.toString(),
      'Upload-Complete': '?0',
      'Content-Type': 'application/partial-upload',
      'Content-Length': chunk.length.toString(),
    },
  });
  req.on('error', () => {});
  await new Promise<void>((resolve) => req.write(chunk.subarray(0, sentBytes), () => resolve()));
  await setTimeout(200);
  req.destroy();
};

const waitForStableOffset = async (auth: Auth, location: string) => {
  let previous = -1;
  for (let attempt = 0; attempt < 20; attempt++) {
    const { offset } = await getOffset(auth, location);
    if (offset === previous) {
      return offset;
    }
    previous = offset;
    await setTimeout(100);
  }
  return previous;
};

describe('resumable uploads', () => {
  let websocket: Socket;
  let userWebsocket: Socket;
  let admin: LoginResponseDto;
  let user: LoginResponseDto;
  let otherUser: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    websocket = await utils.connectWebsocket(admin.accessToken);
    user = await utils.userSetup(admin.accessToken, createUserDto.user1);
    otherUser = await utils.userSetup(admin.accessToken, createUserDto.user2);
    userWebsocket = await utils.connectWebsocket(user.accessToken);
  });

  afterAll(() => {
    utils.disconnectWebsocket(websocket);
    utils.disconnectWebsocket(userWebsocket);
  });

  describe('dropped connections', () => {
    it('should resume from the offset the server reports after a dropped append', async () => {
      const auth = bearer(user.accessToken);
      const content = randomBytes(3 * 1024 * 1024);
      const first = await startUpload(auth, content, content.subarray(0, 1024 * 1024));
      expect(first.status).toBe(201);
      const location = first.headers['location'];

      const second = content.subarray(1024 * 1024);
      await interruptedAppend(auth, location, 1024 * 1024, second, 512 * 1024);

      const offset = await waitForStableOffset(auth, location);
      expect(offset).toBeGreaterThan(1024 * 1024);
      expect(offset).toBeLessThanOrEqual(1024 * 1024 + 512 * 1024);

      const { status, body } = await append(auth, location, offset, content.subarray(offset), true);
      expect(status).toBe(200);

      const downloaded = await utils.downloadAsset(user.accessToken, body.id);
      expect(sha1(Buffer.from(await downloaded.arrayBuffer()))).toBe(sha1(content));
    });

    it('should resume after the creation request itself is dropped', async () => {
      const auth = bearer(user.accessToken);
      const content = randomBytes(2 * 1024 * 1024);
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: 2285,
        path: '/api/upload',
        method: 'POST',
        headers: {
          [auth.header]: auth.value,
          'Upload-Draft-Interop-Version': '8',
          'Upload-Complete': '?1',
          'Upload-Length': content.length.toString(),
          'Content-Length': content.length.toString(),
          'Repr-Digest': `sha=:${sha1(content)}:`,
          'X-Immich-Asset-Data': assetDataFor('dropped-create.jpg'),
        },
      });
      req.on('error', () => {});
      const location = await new Promise<string>((resolve) => {
        req.on('information', ({ headers }) => resolve(headers['location'] as string));
        req.write(content.subarray(0, 700 * 1024));
      });
      await setTimeout(200);
      req.destroy();

      const offset = await waitForStableOffset(auth, location);
      expect(offset).toBeGreaterThan(0);
      expect(offset).toBeLessThanOrEqual(700 * 1024);

      const { status, body } = await append(auth, location, offset, content.subarray(offset), true);
      expect(status).toBe(200);
      const downloaded = await utils.downloadAsset(user.accessToken, body.id);
      expect(sha1(Buffer.from(await downloaded.arrayBuffer()))).toBe(sha1(content));
    });
  });

  describe('out-of-order and duplicate appends', () => {
    const content = randomBytes(30_000);
    let location: string;

    beforeAll(async () => {
      const first = await startUpload(bearer(user.accessToken), content, content.subarray(0, 10_000));
      location = first.headers['location'];
    });

    it('should reject an append that skips ahead and report the real offset', async () => {
      const { status, headers, body } = await append(
        bearer(user.accessToken),
        location,
        20_000,
        content.subarray(20_000),
        true,
      );

      expect(status).toBe(409);
      expect(headers['upload-offset']).toBe('10000');
      expect(body).toEqual(expect.objectContaining({ 'expected-offset': 10_000, 'provided-offset': 20_000 }));
      await expect(getOffset(bearer(user.accessToken), location)).resolves.toEqual(
        expect.objectContaining({ offset: 10_000, complete: '?0' }),
      );
    });

    it('should reject a replayed append that was already applied', async () => {
      const auth = bearer(user.accessToken);
      await expect(append(auth, location, 10_000, content.subarray(10_000, 20_000), false)).resolves.toHaveProperty(
        'status',
        204,
      );

      const { status, headers } = await append(auth, location, 10_000, content.subarray(10_000, 20_000), false);

      expect(status).toBe(409);
      expect(headers['upload-offset']).toBe('20000');
      await expect(getOffset(auth, location)).resolves.toEqual(expect.objectContaining({ offset: 20_000 }));
    });

    it('should keep the file intact when the same append is sent twice at once', async () => {
      const auth = bearer(user.accessToken);
      const chunk = content.subarray(20_000);
      const results = await Promise.allSettled([
        append(auth, location, 20_000, chunk, true),
        append(auth, location, 20_000, chunk, true),
      ]);
      const statuses = results.map((result) => (result.status === 'fulfilled' ? result.value.status : 'aborted'));
      expect(statuses).toContain(200);

      const { offset, complete } = await getOffset(auth, location);
      if (complete !== '?1') {
        await expect(append(auth, location, offset, content.subarray(offset), true)).resolves.toHaveProperty(
          'status',
          200,
        );
      }

      const id = location.replace('/api/upload/', '');
      const downloaded = await utils.downloadAsset(user.accessToken, id);
      expect(sha1(Buffer.from(await downloaded.arrayBuffer()))).toBe(sha1(content));
    });
  });

  describe('finalise', () => {
    it('should hand off to asset processing: metadata, thumbnails, quota and duplicate checks', async () => {
      const content = await readFile(join(testAssetDir, 'formats/jpg/el_torcal_rocks.jpg'));
      const before = await getMyUser({ headers: asBearerAuth(user.accessToken) });

      const id = await uploadInChunks(bearer(user.accessToken), content, 20_000, 'el_torcal_rocks.jpg');
      await utils.waitForWebsocketEvent({ event: 'assetUpload', id });

      const asset = await utils.getAssetInfo(user.accessToken, id);
      expect(asset).toEqual(
        expect.objectContaining({
          id,
          checksum: sha1(content),
          originalFileName: 'el_torcal_rocks.jpg',
          visibility: 'timeline',
          exifInfo: expect.objectContaining({ make: 'SONY', model: 'DSLR-A550', fileSizeInByte: content.length }),
        }),
      );
      expect(asset.thumbhash).toBeTruthy();

      const thumbnail = await request(app)
        .get(`/assets/${id}/thumbnail`)
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers['content-type']).toMatch(/^image\//);

      const after = await getMyUser({ headers: asBearerAuth(user.accessToken) });
      expect((after.quotaUsageInBytes ?? 0) - (before.quotaUsageInBytes ?? 0)).toBe(content.length);

      const stock = await utils.createAsset(user.accessToken, {
        assetData: { bytes: content, filename: 'el_torcal_rocks.jpg' },
      });
      expect(stock).toEqual({ id, status: AssetMediaStatus.Duplicate });

      const again = await startUpload(bearer(user.accessToken), content, content);
      expect(again.status).toBe(400);
      expect(again.body).toEqual(expect.objectContaining({ title: 'upload is already completed' }));
    });
  });

  describe('stock clients', () => {
    it('should still accept a single multipart POST /assets and report duplicates', async () => {
      const bytes = randomBytes(2048);
      const created = await utils.createAsset(user.accessToken, { assetData: { bytes, filename: 'stock.jpg' } });
      expect(created.status).toBe(AssetMediaStatus.Created);

      const duplicate = await utils.createAsset(user.accessToken, { assetData: { bytes, filename: 'stock.jpg' } });
      expect(duplicate).toEqual({ id: created.id, status: AssetMediaStatus.Duplicate });
    });

    it('should not report a partial upload as already uploaded to a stock client', async () => {
      const bytes = randomBytes(4096);
      const partial = await startUpload(bearer(user.accessToken), bytes, bytes.subarray(0, 1024));
      expect(partial.status).toBe(201);

      const check = await request(app)
        .post('/assets/bulk-upload-check')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ assets: [{ id: 'local-1', checksum: createHash('sha1').update(bytes).digest('hex') }] });
      expect(check.status).toBe(200);
      expect(check.body.results).toEqual([{ id: 'local-1', action: 'accept' }]);

      const stock = await utils.createAsset(user.accessToken, { assetData: { bytes, filename: 'stock.jpg' } });
      expect(stock.status).toBe(AssetMediaStatus.Created);

      const downloaded = await utils.downloadAsset(user.accessToken, stock.id);
      expect(sha1(Buffer.from(await downloaded.arrayBuffer()))).toBe(sha1(bytes));
      const { status } = await getOffset(bearer(user.accessToken), partial.headers['location']);
      expect(status).toBe(404);
    });

    it('should not short-circuit a stock upload whose x-immich-checksum matches a partial upload', async () => {
      const bytes = randomBytes(4096);
      await startUpload(bearer(user.accessToken), bytes, bytes.subarray(0, 1024));

      const { status, body } = await request(app)
        .post('/assets')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .set('x-immich-checksum', createHash('sha1').update(bytes).digest('hex'))
        .attach('assetData', bytes, 'stock.jpg')
        .field('fileCreatedAt', new Date().toISOString())
        .field('fileModifiedAt', new Date().toISOString());

      expect(status).toBe(201);
      expect(body.status).toBe(AssetMediaStatus.Created);
    });
  });

  describe('auth and permissions', () => {
    it('should require authentication on every upload route', async () => {
      const content = randomBytes(100);
      const started = await startUpload(bearer(user.accessToken), content, content.subarray(0, 10));
      const location = started.headers['location'];

      const unauthenticated = [
        request(baseUrl).post('/api/upload').set('Upload-Draft-Interop-Version', '8').send(content),
        request(baseUrl).patch(location).set('Upload-Draft-Interop-Version', '8').send(content),
        request(baseUrl).head(location).set('Upload-Draft-Interop-Version', '8'),
        request(baseUrl).delete(location),
      ];
      for (const response of await Promise.all(unauthenticated)) {
        expect(response.status).toBe(401);
      }
    });

    it('should accept an API key with asset.upload', async () => {
      const { secret } = await utils.createApiKey(user.accessToken, [Permission.AssetUpload]);
      const content = randomBytes(5000);

      const id = await uploadInChunks({ header: 'x-api-key', value: secret }, content, 2000);

      const downloaded = await utils.downloadAsset(user.accessToken, id);
      expect(sha1(Buffer.from(await downloaded.arrayBuffer()))).toBe(sha1(content));
    });

    it('should reject an API key without asset.upload', async () => {
      const { secret } = await utils.createApiKey(user.accessToken, [Permission.AssetRead]);
      const content = randomBytes(100);

      const { status } = await startUpload({ header: 'x-api-key', value: secret }, content, content);

      expect(status).toBe(403);
    });

    it("should not let another user see, append to or cancel someone's upload", async () => {
      const content = randomBytes(1000);
      const started = await startUpload(bearer(user.accessToken), content, content.subarray(0, 100));
      const location = started.headers['location'];
      const other = bearer(otherUser.accessToken);

      await expect(getOffset(other, location)).resolves.toHaveProperty('status', 404);
      await expect(append(other, location, 100, content.subarray(100), true)).resolves.toHaveProperty('status', 404);
      await expect(request(baseUrl).delete(location).set(other.header, other.value)).resolves.toHaveProperty(
        'status',
        404,
      );
      await expect(getOffset(bearer(user.accessToken), location)).resolves.toEqual(
        expect.objectContaining({ status: 204, offset: 100 }),
      );
    });

    it('should only accept shared link uploads when the link allows uploads', async () => {
      const album = await utils.createAlbum(user.accessToken, { albumName: 'drop box' });
      const readOnly = await utils.createSharedLink(user.accessToken, {
        type: SharedLinkType.Album,
        albumId: album.id,
        allowUpload: false,
      });
      const uploads = await utils.createSharedLink(user.accessToken, {
        type: SharedLinkType.Album,
        albumId: album.id,
        allowUpload: true,
      });
      const content = randomBytes(3000);

      const rejected = await request(baseUrl)
        .post(`/api/upload?key=${readOnly.key}`)
        .set('Upload-Draft-Interop-Version', '8')
        .set('Upload-Complete', '?1')
        .set('Upload-Length', content.length.toString())
        .set('Repr-Digest', `sha=:${sha1(content)}:`)
        .set('X-Immich-Asset-Data', assetDataFor('shared.jpg'))
        .send(content);
      expect(rejected.status).toBe(400);
      expect(rejected.body).toEqual(expect.objectContaining({ message: 'Not found or no asset.upload access' }));

      const accepted = await request(baseUrl)
        .post(`/api/upload?key=${uploads.key}`)
        .set('Upload-Draft-Interop-Version', '8')
        .set('Upload-Complete', '?1')
        .set('Upload-Length', content.length.toString())
        .set('Repr-Digest', `sha=:${sha1(content)}:`)
        .set('X-Immich-Asset-Data', assetDataFor('shared.jpg'))
        .send(content);
      expect(accepted.status).toBe(200);

      const { body } = await request(app).get(`/albums/${album.id}`).set('Authorization', `Bearer ${user.accessToken}`);
      expect(body).toEqual(expect.objectContaining({ assetCount: 1 }));
    });
  });

  describe('who may touch an upload', () => {
    let linkA: Auth;
    let linkB: Auth;

    beforeAll(async () => {
      const album = await utils.createAlbum(user.accessToken, { albumName: 'uploads' });
      const [a, b] = await Promise.all(
        [1, 2].map(() =>
          utils.createSharedLink(user.accessToken, {
            type: SharedLinkType.Album,
            albumId: album.id,
            allowUpload: true,
          }),
        ),
      );
      linkA = { header: 'x-immich-share-key', value: a.key };
      linkB = { header: 'x-immich-share-key', value: b.key };
    });

    it('should only let the shared link that started an upload see, append to or cancel it', async () => {
      const content = randomBytes(1000);
      const started = await startUpload(linkA, content, content.subarray(0, 100));
      const location = started.headers['location'];

      for (const other of [linkB, bearer(user.accessToken)]) {
        await expect(getOffset(other, location)).resolves.toHaveProperty('status', 404);
        await expect(append(other, location, 100, content.subarray(100), true)).resolves.toHaveProperty('status', 404);
        await expect(request(baseUrl).delete(location).set(other.header, other.value)).resolves.toHaveProperty(
          'status',
          404,
        );
      }

      await expect(getOffset(linkA, location)).resolves.toEqual(expect.objectContaining({ status: 204, offset: 100 }));
      await expect(append(linkA, location, 100, content.subarray(100), true)).resolves.toHaveProperty('status', 200);
    });

    it("should keep a shared link away from the owner's uploads, even when it uploads the same file", async () => {
      const content = randomBytes(1000);
      const owners = await startUpload(bearer(user.accessToken), content, content.subarray(0, 100));
      const location = owners.headers['location'];

      await expect(getOffset(linkA, location)).resolves.toHaveProperty('status', 404);
      const sameFile = await startUpload(linkA, content, content.subarray(0, 100));
      expect(sameFile.status).toBe(409);
      expect(sameFile.headers['location']).toBeUndefined();

      await expect(getOffset(bearer(user.accessToken), location)).resolves.toEqual(
        expect.objectContaining({ status: 204, offset: 100 }),
      );
    });

    it('should let the owner restart an upload a shared link left unfinished', async () => {
      const content = randomBytes(1000);
      const linkUpload = await startUpload(linkA, content, content.subarray(0, 100));

      const restarted = await startUpload(bearer(user.accessToken), content, content.subarray(0, 100));

      expect(restarted.status).toBe(201);
      expect(restarted.headers['location']).not.toBe(linkUpload.headers['location']);
      await expect(getOffset(linkA, linkUpload.headers['location'])).resolves.toHaveProperty('status', 404);
    });

    it('should report a finished upload only to its owner, not to shared links', async () => {
      const content = randomBytes(1000);
      const id = await uploadInChunks(bearer(user.accessToken), content, 400);

      await expect(getOffset(bearer(user.accessToken), `/api/upload/${id}`)).resolves.toEqual(
        expect.objectContaining({ status: 204, complete: '?1' }),
      );
      await expect(getOffset(linkA, `/api/upload/${id}`)).resolves.toHaveProperty('status', 404);
    });

    it('should not let generic asset routes trash, restore or read a partial upload', async () => {
      const content = randomBytes(1000);
      const started = await startUpload(bearer(user.accessToken), content, content.subarray(0, 100));
      const id = started.headers['location'].replace('/api/upload/', '');

      const trashed = await request(app)
        .delete('/assets')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ ids: [id] });
      expect(trashed.status).toBe(400);
      const read = await request(app).get(`/assets/${id}`).set('Authorization', `Bearer ${user.accessToken}`);
      expect(read.status).toBe(400);

      await expect(getOffset(bearer(user.accessToken), started.headers['location'])).resolves.toEqual(
        expect.objectContaining({ status: 204, offset: 100 }),
      );
    });
  });

  describe('per-user limits', () => {
    let quotaUser: LoginResponseDto;

    beforeAll(async () => {
      quotaUser = await utils.userSetup(admin.accessToken, {
        ...createUserDto.create('upload-quota'),
        quotaSizeInBytes: 10_000,
      });
    });

    it('should reserve quota when an upload starts and refuse one that would exceed it', async () => {
      const auth = bearer(quotaUser.accessToken);
      const first = randomBytes(6000);
      const started = await startUpload(auth, first, first.subarray(0, 1000));
      expect(started.status).toBe(201);
      await expect(getMyUser({ headers: asBearerAuth(quotaUser.accessToken) })).resolves.toHaveProperty(
        'quotaUsageInBytes',
        6000,
      );

      const second = randomBytes(6000);
      const refused = await startUpload(auth, second, second.subarray(0, 1000));
      expect(refused.status).toBe(400);
      expect(refused.body).toEqual(expect.objectContaining({ message: 'Quota has been exceeded!' }));

      const cancelled = await request(baseUrl).delete(started.headers['location']).set(auth.header, auth.value);
      expect(cancelled.status).toBe(204);
      await expect(getMyUser({ headers: asBearerAuth(quotaUser.accessToken) })).resolves.toHaveProperty(
        'quotaUsageInBytes',
        0,
      );

      const retried = await startUpload(auth, second, second.subarray(0, 1000));
      expect(retried.status).toBe(201);
    });

    it('should count a completed upload once against the quota', async () => {
      const auth = bearer(quotaUser.accessToken);
      const { quotaUsageInBytes: before } = await getMyUser({ headers: asBearerAuth(quotaUser.accessToken) });
      const content = randomBytes(2000);

      await uploadInChunks(auth, content, 500);
      await setTimeout(500);

      const { quotaUsageInBytes: after } = await getMyUser({ headers: asBearerAuth(quotaUser.accessToken) });
      expect((after ?? 0) - (before ?? 0)).toBe(2000);
    });
  });
});
