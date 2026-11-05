import { Kysely, sql } from 'kysely';
import { AssetStatus, AssetType, AssetVisibility, ChecksumAlgorithm } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, {
    database: defaultDatabase,
    real: [AssetRepository],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AssetRepository) };
};

const newPartialUpload = async (
  ctx: ReturnType<typeof setup>['ctx'],
  credentials: { sessionId?: string; apiKeyId?: string; sharedLinkId?: string } = {},
) => {
  const { user } = await ctx.newUser();
  const id = factory.uuid();
  await ctx.get(AssetRepository).createWithMetadata(
    {
      id,
      ownerId: user.id,
      checksum: Buffer.from(factory.uuid()),
      originalPath: `/upload/${id}.jpg`,
      fileCreatedAt: new Date(),
      fileModifiedAt: new Date(),
      localDateTime: new Date(),
      type: AssetType.Image,
      originalFileName: 'claim.jpg',
      checksumAlgorithm: ChecksumAlgorithm.sha1File,
      visibility: AssetVisibility.Hidden,
      status: AssetStatus.Partial,
    },
    1024,
    undefined,
    credentials,
  );
  return id;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe('upload claims', () => {
  it('should record the credentials that created an upload', async () => {
    const { ctx } = setup();
    const sessionId = factory.uuid();
    const sharedLinkId = factory.uuid();

    const id = await newPartialUpload(ctx, { sessionId, sharedLinkId });

    const row = await ctx.database.selectFrom('asset_upload').selectAll().where('assetId', '=', id).executeTakeFirst();
    expect(row).toEqual(expect.objectContaining({ sessionId, sharedLinkId, apiKeyId: null, writerId: null }));
  });

  it("should count a shared link's uploads apart from the owner's", async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const sharedLinkId = factory.uuid();
    const newUpload = (credentials: { sessionId?: string; sharedLinkId?: string }) =>
      sut.createWithMetadata(
        {
          id: factory.uuid(),
          ownerId: user.id,
          checksum: Buffer.from(factory.uuid()),
          originalPath: '/upload/count.jpg',
          fileCreatedAt: new Date(),
          fileModifiedAt: new Date(),
          localDateTime: new Date(),
          type: AssetType.Image,
          originalFileName: 'count.jpg',
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
          visibility: AssetVisibility.Hidden,
          status: AssetStatus.Partial,
        },
        10,
        undefined,
        credentials,
      );
    await newUpload({ sessionId: factory.uuid() });
    await newUpload({ sessionId: factory.uuid() });
    await newUpload({ sharedLinkId });
    const since = new Date(Date.now() - 60_000);

    await expect(sut.countPartialUploads(user.id, since, null)).resolves.toBe(2);
    await expect(sut.countPartialUploads(user.id, since, sharedLinkId)).resolves.toBe(1);
    await expect(sut.countPartialUploads(user.id, since, factory.uuid())).resolves.toBe(0);
  });

  it('should give a partial upload to one writer at a time', async () => {
    const { ctx, sut } = setup();
    const id = await newPartialUpload(ctx);
    const [first, second] = [factory.uuid(), factory.uuid()];

    await expect(sut.claimUpload(id, first)).resolves.toBe(true);
    await expect(sut.claimUpload(id, second)).resolves.toBe(false);

    await sut.releaseUploadClaim(id, second);
    await expect(sut.claimUpload(id, second)).resolves.toBe(false);

    await sut.releaseUploadClaim(id, first);
    await expect(sut.claimUpload(id, second)).resolves.toBe(true);
  });

  it('should let only the holder refresh a claim', async () => {
    const { ctx, sut } = setup();
    const id = await newPartialUpload(ctx);
    const holder = factory.uuid();
    await sut.claimUpload(id, holder);

    await expect(sut.refreshUploadClaim(id, factory.uuid())).resolves.toBe(false);
    await expect(sut.refreshUploadClaim(id, holder)).resolves.toBe(true);
  });

  it('should hand over a claim whose holder stopped sending heartbeats', async () => {
    const { ctx, sut } = setup();
    const id = await newPartialUpload(ctx);
    await sut.claimUpload(id, factory.uuid());
    await ctx.database
      .updateTable('asset_upload')
      .set({ writerHeartbeatAt: sql`clock_timestamp() - interval '31 seconds'` })
      .where('assetId', '=', id)
      .execute();

    await expect(sut.claimUpload(id, factory.uuid())).resolves.toBe(true);
  });

  it('should claim a partial upload created before claims existed', async () => {
    const { ctx, sut } = setup();
    const id = await newPartialUpload(ctx);
    await ctx.database.deleteFrom('asset_upload').where('assetId', '=', id).execute();

    await expect(sut.claimUpload(id, factory.uuid())).resolves.toBe(true);
  });

  it('should not claim a finished or missing upload', async () => {
    const { ctx, sut } = setup();
    const id = await newPartialUpload(ctx);
    await sut.setComplete(id);

    await expect(sut.claimUpload(id, factory.uuid())).resolves.toBe(false);
    await expect(sut.hasPartialUpload(id)).resolves.toBe(false);
    await expect(sut.claimUpload(factory.uuid(), factory.uuid())).resolves.toBe(false);
    const rows = await ctx.database.selectFrom('asset_upload').selectAll().where('assetId', '=', id).execute();
    expect(rows).toEqual([]);
  });
});
