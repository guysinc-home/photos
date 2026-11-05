import { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetStatus, AssetVisibility, JobName, JobStatus } from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetUploadService } from 'src/services/asset-upload.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;
let folder: string;

const setup = () =>
  newMediumService(AssetUploadService, {
    database: defaultDatabase,
    real: [
      AssetRepository,
      AssetJobRepository,
      ConfigRepository,
      CryptoRepository,
      DatabaseRepository,
      StorageRepository,
      SystemMetadataRepository,
      UserRepository,
    ],
    mock: [EventRepository, JobRepository, LoggingRepository, WebsocketRepository],
  });

const daysAgo = (days: number) => DateTime.now().minus({ days }).toJSDate();

const newStaleUpload = async (
  ctx: ReturnType<typeof setup>['ctx'],
  { content, written, createdAt = daysAgo(4) }: { content: Buffer; written: Buffer; createdAt?: Date },
) => {
  const { user } = await ctx.newUser({ quotaUsageInBytes: content.length });
  const originalPath = join(folder, `${randomBytes(8).toString('hex')}.jpg`);
  await writeFile(originalPath, written);
  const { asset } = await ctx.newAsset({
    ownerId: user.id,
    status: AssetStatus.Partial,
    visibility: AssetVisibility.Hidden,
    checksum: createHash('sha1').update(content).digest(),
    originalPath,
    createdAt,
  });
  await ctx.newExif({ assetId: asset.id, fileSizeInByte: content.length });
  return { asset, user, originalPath };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
  folder = await mkdtemp(join(tmpdir(), 'immich-upload-'));
});

afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe(AssetUploadService.name, () => {
  describe('removeStaleUploads', () => {
    it('should only queue partial uploads older than the configured max age', async () => {
      const { sut, ctx } = setup();
      const content = randomBytes(100);
      const { asset: stale } = await newStaleUpload(ctx, { content, written: content, createdAt: daysAgo(4) });
      const { asset: recent } = await newStaleUpload(ctx, {
        content: randomBytes(100),
        written: content,
        createdAt: daysAgo(1),
      });
      const { user } = await ctx.newUser();
      const { asset: active } = await ctx.newAsset({ ownerId: user.id, createdAt: daysAgo(10) });
      const jobs = ctx.getMock(JobRepository);
      jobs.queueAll.mockResolvedValue();

      await sut.removeStaleUploads();

      const queuedIds = jobs.queueAll.mock.calls.flatMap(([items]) =>
        items.map((item) => (item.data as { id: string }).id),
      );
      expect(queuedIds).toContain(stale.id);
      expect(queuedIds).not.toContain(recent.id);
      expect(queuedIds).not.toContain(active.id);
    });
  });

  describe('removeStaleUpload', () => {
    it('should promote an abandoned upload whose file is complete', async () => {
      const { sut, ctx } = setup();
      const content = randomBytes(2048);
      const { asset, user } = await newStaleUpload(ctx, { content, written: content });
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();

      await expect(sut.removeStaleUpload({ id: asset.id })).resolves.toBe(JobStatus.Success);

      const completed = await ctx.get(AssetRepository).getById(asset.id);
      expect(completed).toEqual(
        expect.objectContaining({ status: AssetStatus.Active, visibility: AssetVisibility.Timeline }),
      );
      expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: asset.id, source: 'upload' },
      });
      expect(ctx.getMock(EventRepository).emit).toHaveBeenCalledWith('AssetCreate', expect.anything());
      await expect(ctx.get(UserRepository).get(user.id, {})).resolves.toEqual(
        expect.objectContaining({ quotaUsageInBytes: content.length }),
      );
    });

    it('should delete an abandoned upload that never finished and give its quota back', async () => {
      const { sut, ctx } = setup();
      const content = randomBytes(2048);
      const { asset, user, originalPath } = await newStaleUpload(ctx, { content, written: content.subarray(0, 512) });

      await expect(sut.removeStaleUpload({ id: asset.id })).resolves.toBe(JobStatus.Success);

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toBeUndefined();
      expect(existsSync(originalPath)).toBe(false);
      await expect(ctx.get(UserRepository).get(user.id, {})).resolves.toEqual(
        expect.objectContaining({ quotaUsageInBytes: 0 }),
      );
    });

    it('should delete an abandoned upload whose bytes do not match its checksum', async () => {
      const { sut, ctx } = setup();
      const content = randomBytes(2048);
      const { asset, originalPath } = await newStaleUpload(ctx, { content, written: randomBytes(2048) });

      await expect(sut.removeStaleUpload({ id: asset.id })).resolves.toBe(JobStatus.Success);

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toBeUndefined();
      expect(existsSync(originalPath)).toBe(false);
    });

    it('should skip an upload that was completed before the job ran', async () => {
      const { sut, ctx } = setup();
      const content = randomBytes(64);
      const { asset } = await newStaleUpload(ctx, { content, written: content });
      await ctx.database.updateTable('asset').set({ status: AssetStatus.Active }).where('id', '=', asset.id).execute();

      await expect(sut.removeStaleUpload({ id: asset.id })).resolves.toBe(JobStatus.Skipped);
      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toEqual(
        expect.objectContaining({ status: AssetStatus.Active }),
      );
    });
  });
});
