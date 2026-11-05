import { Kysely } from 'kysely';
import { AssetMetadataKey, AssetStatus, AssetVisibility, SyncEntityType, SyncRequestType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getKyselyDB, wait } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = async () => {
  const ctx = new SyncTestContext(defaultDatabase);
  const { auth, user, session } = await ctx.newSyncAuthUser();
  return { auth, user, session, ctx };
};

const newPartialAsset = async (ctx: SyncTestContext, ownerId: string) => {
  const { asset } = await ctx.newAsset({ ownerId, status: AssetStatus.Partial, visibility: AssetVisibility.Hidden });
  await ctx.newExif({ assetId: asset.id, fileSizeInByte: 1024 });
  await ctx.newMetadata({ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'icloud-id' } });
  return asset;
};

const typesOf = (response: Array<{ type: string }>) => response.map(({ type }) => type);

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe('partial uploads', () => {
  const ownStreams = [SyncRequestType.AssetsV2, SyncRequestType.AssetExifsV1, SyncRequestType.AssetMetadataV1];

  it('should not sync a partial asset or its exif and metadata to its owner', async () => {
    const { auth, ctx } = await setup();
    await newPartialAsset(ctx, auth.user.id);

    await ctx.assertSyncIsComplete(auth, ownStreams);
  });

  it('should sync the asset, exif and metadata once the upload completes', async () => {
    const { auth, ctx } = await setup();
    const asset = await newPartialAsset(ctx, auth.user.id);

    const before = await ctx.syncStream(auth, ownStreams);
    await ctx.syncAckAll(auth, before);

    await ctx.get(AssetRepository).setComplete(asset.id);

    const after = await ctx.syncStream(auth, ownStreams);
    expect(typesOf(after)).toEqual([
      SyncEntityType.AssetV2,
      SyncEntityType.AssetExifV1,
      SyncEntityType.AssetMetadataV1,
      SyncEntityType.SyncCompleteV1,
    ]);
    expect(after[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ id: asset.id, visibility: AssetVisibility.Timeline }),
      }),
    );

    await ctx.syncAckAll(auth, after);
    await ctx.assertSyncIsComplete(auth, ownStreams);
  });

  it('should not sync a partner partial asset or its exif', async () => {
    const { auth, ctx } = await setup();
    const { user: partner } = await ctx.newUser();
    await ctx.newPartner({ sharedById: partner.id, sharedWithId: auth.user.id });
    const asset = await newPartialAsset(ctx, partner.id);

    const streams = [SyncRequestType.PartnersV1, SyncRequestType.PartnerAssetsV2, SyncRequestType.PartnerAssetExifsV1];
    const before = await ctx.syncStream(auth, streams);
    expect(typesOf(before)).toEqual([SyncEntityType.PartnerV1, SyncEntityType.SyncCompleteV1]);
    await ctx.syncAckAll(auth, before);

    await ctx.get(AssetRepository).setComplete(asset.id);

    const after = await ctx.syncStream(auth, streams);
    expect(typesOf(after)).toEqual([
      SyncEntityType.PartnerAssetV2,
      SyncEntityType.PartnerAssetExifV1,
      SyncEntityType.SyncCompleteV1,
    ]);
  });

  it('should not backfill a partner partial asset or its exif', async () => {
    const { auth, ctx } = await setup();
    const { user: firstPartner } = await ctx.newUser();
    const { user: laterPartner } = await ctx.newUser();
    const partial = await newPartialAsset(ctx, laterPartner.id);
    const { asset: active } = await ctx.newAsset({ ownerId: laterPartner.id });
    await ctx.newExif({ assetId: active.id, fileSizeInByte: 2048 });
    await wait(2);
    await ctx.newAsset({ ownerId: firstPartner.id });
    await ctx.newPartner({ sharedById: firstPartner.id, sharedWithId: auth.user.id });

    const streams = [SyncRequestType.PartnerAssetsV2, SyncRequestType.PartnerAssetExifsV1];
    await ctx.syncAckAll(auth, await ctx.syncStream(auth, streams));
    await ctx.newPartner({ sharedById: laterPartner.id, sharedWithId: auth.user.id });

    const response = await ctx.syncStream(auth, streams);
    expect(response).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: SyncEntityType.PartnerAssetBackfillV2,
          data: expect.objectContaining({ id: active.id }),
        }),
      ]),
    );
    expect(JSON.stringify(response)).not.toContain(partial.id);
  });

  it('should not sync a partial asset that was added to a shared album', async () => {
    const { auth, ctx } = await setup();
    const { user: owner } = await ctx.newUser();
    const asset = await newPartialAsset(ctx, owner.id);
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
    await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id });

    const streams = [
      SyncRequestType.AlbumsV1,
      SyncRequestType.AlbumAssetsV2,
      SyncRequestType.AlbumAssetExifsV1,
      SyncRequestType.AlbumToAssetsV1,
    ];
    const before = await ctx.syncStream(auth, streams);
    expect(typesOf(before)).toEqual([SyncEntityType.AlbumV1, SyncEntityType.SyncCompleteV1]);
    await ctx.syncAckAll(auth, before);

    await ctx.get(AssetRepository).setComplete(asset.id);

    const after = await ctx.syncStream(auth, streams);
    expect(typesOf(after)).toEqual(
      expect.arrayContaining([
        SyncEntityType.AlbumAssetCreateV2,
        SyncEntityType.AlbumAssetExifCreateV1,
        SyncEntityType.AlbumToAssetV1,
      ]),
    );
  });
});
