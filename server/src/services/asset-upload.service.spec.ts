import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { AssetMetadataKey, AssetStatus, AssetType, AssetVisibility, JobName, JobStatus } from 'src/enum.js';
import { AssetUploadService } from 'src/services/asset-upload.service.js';
import { ASSET_CHECKSUM_CONSTRAINT } from 'src/utils/database.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const res = () => ({
  status: vi.fn().mockReturnThis(),
  setHeader: vi.fn().mockReturnThis(),
  contentType: vi.fn().mockReturnThis(),
  send: vi.fn(),
});

const getUploadLimit = async (sut: AssetUploadService) => {
  const response = res();
  await sut.getUploadOptions(response as any);
  return response.setHeader.mock.calls.find(([name]) => name === 'Upload-Limit')?.[1];
};

describe(AssetUploadService.name, () => {
  let sut: AssetUploadService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AssetUploadService));
    mocks.asset.setComplete.mockResolvedValue({ id: factory.uuid() } as any);
    mocks.asset.claimUpload.mockResolvedValue(true);
    mocks.asset.hasPartialUpload.mockResolvedValue(true);
    mocks.asset.releaseUploadClaim.mockResolvedValue();
    mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(undefined);
    mocks.asset.countPartialUploads.mockResolvedValue(0);
    mocks.asset.getUploadCreator.mockResolvedValue({
      status: AssetStatus.Partial,
      sessionId: null,
      apiKeyId: null,
      sharedLinkId: null,
    });
  });

  describe('onStart', () => {
    const mockDto = {
      assetData: {
        filename: 'test.jpg',
        deviceAssetId: 'device-asset-1',
        deviceId: 'device-1',
        fileCreatedAt: new Date('2025-01-01T00:00:00Z'),
        fileModifiedAt: new Date('2025-01-01T12:00:00Z'),
        isFavorite: false,
        iCloudId: '',
      },
      checksum: Buffer.from('checksum'),
      uploadLength: 1024,
      uploadComplete: true,
      contentLength: 1024,
      isComplete: true,
      version: 8,
    };

    it('should create a new asset and return upload metadata', async () => {
      const assetId = factory.uuid();
      mocks.crypto.randomUUID.mockReturnValue(assetId);

      const result = await sut.onStart(authStub.user1, mockDto);

      expect(result).toEqual({
        id: assetId,
        path: expect.stringContaining(assetId),
        status: AssetStatus.Partial,
        createdAt: expect.any(Date),
        isDuplicate: false,
      });

      expect(mocks.asset.createWithMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          id: assetId,
          ownerId: authStub.user1.user.id,
          checksum: mockDto.checksum,
          fileCreatedAt: mockDto.assetData.fileCreatedAt,
          fileModifiedAt: mockDto.assetData.fileModifiedAt,
          type: AssetType.Image,
          isFavorite: false,
          status: AssetStatus.Partial,
          visibility: AssetVisibility.Hidden,
          originalFileName: 'test.jpg',
        }),
        1024,
        undefined,
        { sessionId: authStub.user1.session?.id, apiKeyId: undefined, sharedLinkId: undefined },
      );
    });

    it('should determine asset type from filename extension', async () => {
      const videoDto = { ...mockDto, assetData: { ...mockDto.assetData, filename: 'video.mp4' } };
      mocks.crypto.randomUUID.mockReturnValue(factory.uuid());

      await sut.onStart(authStub.user1, videoDto);

      expect(mocks.asset.createWithMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AssetType.Video,
        }),
        expect.anything(),
        undefined,
        expect.anything(),
      );
    });

    it('should throw BadRequestException for unsupported file types', async () => {
      const unsupportedDto = { ...mockDto, assetData: { ...mockDto.assetData, filename: 'document.xyz' } };

      await expect(sut.onStart(authStub.user1, unsupportedDto)).rejects.toThrow(BadRequestException);
      await expect(sut.onStart(authStub.user1, unsupportedDto)).rejects.toThrow('unsupported file type');
    });

    it('should validate quota before creating asset', async () => {
      const authWithQuota = {
        ...authStub.user1,
        user: {
          ...authStub.user1.user,
          quotaSizeInBytes: 2000,
          quotaUsageInBytes: 1500,
        },
      };

      await expect(sut.onStart(authWithQuota, mockDto)).rejects.toThrow(BadRequestException);
      await expect(sut.onStart(authWithQuota, mockDto)).rejects.toThrow('Quota has been exceeded');
    });

    it('should allow upload when quota is null (unlimited)', async () => {
      const authWithUnlimitedQuota = {
        ...authStub.user1,
        user: {
          ...authStub.user1.user,
          quotaSizeInBytes: null,
          quotaUsageInBytes: 1000,
        },
      };

      mocks.crypto.randomUUID.mockReturnValue(factory.uuid());

      await expect(sut.onStart(authWithUnlimitedQuota, mockDto)).resolves.toBeDefined();
    });

    it('should allow upload when within quota', async () => {
      const authWithQuota = {
        ...authStub.user1,
        user: {
          ...authStub.user1.user,
          quotaSizeInBytes: 5000,
          quotaUsageInBytes: 1000,
        },
      };

      mocks.crypto.randomUUID.mockReturnValue(factory.uuid());

      const result = await sut.onStart(authWithQuota, mockDto);

      expect(result.isDuplicate).toBe(false);
    });

    it('should handle duplicate detection via checksum constraint', async () => {
      const existingAssetId = factory.uuid();
      const checksumError = new Error('duplicate key value violates unique constraint');
      (checksumError as any).constraint_name = ASSET_CHECKSUM_CONSTRAINT;

      const createdAt = new Date();
      mocks.asset.createWithMetadata.mockRejectedValue(checksumError);
      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
        id: existingAssetId,
        status: AssetStatus.Partial,
        createdAt,
      });

      const result = await sut.onStart(authStub.user1, mockDto);

      expect(result).toEqual({
        id: existingAssetId,
        path: expect.any(String),
        status: AssetStatus.Partial,
        createdAt,
        isDuplicate: true,
      });

      expect(mocks.asset.getUploadAssetIdByChecksum).toHaveBeenCalledWith(authStub.user1.user.id, mockDto.checksum);
    });

    it('should refuse a new upload once the user has the maximum number of unfinished uploads', async () => {
      mocks.asset.countPartialUploads.mockResolvedValue(20);

      await expect(sut.onStart(authStub.user1, mockDto)).rejects.toMatchObject({ status: 429 });
      expect(mocks.asset.createWithMetadata).not.toHaveBeenCalled();
    });

    it('should only count unfinished uploads that have not expired', async () => {
      await sut.onStart(authStub.user1, mockDto);

      const [ownerId, createdAfter] = mocks.asset.countPartialUploads.mock.calls[0];
      expect(ownerId).toBe(authStub.user1.user.id);
      expect(Date.now() - createdAfter.getTime()).toBeCloseTo(72 * 3_600_000, -4);
    });

    it('should not count against the cap when the file already has an upload', async () => {
      mocks.asset.countPartialUploads.mockResolvedValue(20);
      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue({
        id: 'existing',
        status: AssetStatus.Partial,
        createdAt: new Date(),
      });

      await expect(sut.onStart(authStub.user1, mockDto)).resolves.toMatchObject({ id: 'existing', isDuplicate: true });
      expect(mocks.asset.countPartialUploads).not.toHaveBeenCalled();
    });

    it('should not cap uploads when the limit is 0', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ backup: { upload: { maxPartialUploads: 0 } } });

      await sut.onStart(authStub.user1, mockDto);

      expect(mocks.asset.countPartialUploads).not.toHaveBeenCalled();
    });

    it('should throw InternalServerErrorException if duplicate lookup fails', async () => {
      const checksumError = new Error('duplicate key value violates unique constraint');
      (checksumError as any).constraint_name = ASSET_CHECKSUM_CONSTRAINT;

      mocks.asset.createWithMetadata.mockRejectedValue(checksumError);

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(undefined);

      await expect(sut.onStart(authStub.user1, mockDto)).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw InternalServerErrorException for non-checksum errors', async () => {
      const genericError = new Error('database connection failed');
      mocks.asset.createWithMetadata.mockRejectedValue(genericError);

      await expect(sut.onStart(authStub.user1, mockDto)).rejects.toThrow(InternalServerErrorException);
    });

    it('should include iCloud metadata when provided', async () => {
      const dtoWithICloud = {
        ...mockDto,
        assetData: {
          ...mockDto.assetData,
          iCloudId: 'icloud-123',
        },
      };

      mocks.crypto.randomUUID.mockReturnValue(factory.uuid());

      await sut.onStart(authStub.user1, dtoWithICloud);

      expect(mocks.asset.createWithMetadata).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        [{ key: AssetMetadataKey.MobileApp, value: { iCloudId: 'icloud-123' } }],
        expect.anything(),
      );
    });

    it('should set isFavorite when true', async () => {
      const favoriteDto = {
        ...mockDto,
        assetData: {
          ...mockDto.assetData,
          isFavorite: true,
        },
      };

      mocks.crypto.randomUUID.mockReturnValue(factory.uuid());

      await sut.onStart(authStub.user1, favoriteDto);

      expect(mocks.asset.createWithMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          isFavorite: true,
        }),
        expect.anything(),
        undefined,
        expect.anything(),
      );
    });
  });

  describe('onComplete', () => {
    const assetId = factory.uuid();
    const path = `/upload/${assetId}/file.jpg`;
    const fileModifiedAt = new Date('2025-01-01T12:00:00Z');

    it('should mark asset as complete and queue metadata extraction job', async () => {
      await sut.onComplete({ id: assetId, path, fileModifiedAt });

      expect(mocks.asset.setComplete).toHaveBeenCalledWith(assetId, undefined);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: assetId, source: 'upload' },
      });
    });

    it('should update file modification time', async () => {
      await sut.onComplete({ id: assetId, path, fileModifiedAt });

      expect(mocks.storage.utimes).toHaveBeenCalledWith(path, expect.any(Date), fileModifiedAt);
    });

    it('should handle utimes failure gracefully', async () => {
      mocks.storage.utimes.mockRejectedValue(new Error('Permission denied'));

      await expect(sut.onComplete({ id: assetId, path, fileModifiedAt })).resolves.toBeUndefined();

      // Should still complete asset and queue job
      expect(mocks.asset.setComplete).toHaveBeenCalled();
      expect(mocks.job.queue).toHaveBeenCalled();
    });

    it('should retry setComplete on transient failures', async () => {
      mocks.asset.setComplete
        .mockRejectedValueOnce(new Error('Transient error'))
        .mockRejectedValueOnce(new Error('Transient error'))
        .mockResolvedValue(void 0);

      await sut.onComplete({ id: assetId, path, fileModifiedAt });

      expect(mocks.asset.setComplete).toHaveBeenCalledTimes(3);
    });

    it('should retry job queueing on transient failures', async () => {
      mocks.job.queue.mockRejectedValueOnce(new Error('Transient error')).mockResolvedValue();

      await sut.onComplete({ id: assetId, path, fileModifiedAt });

      expect(mocks.job.queue).toHaveBeenCalledTimes(2);
    });
  });

  describe('onCancel', () => {
    const assetId = factory.uuid();
    const path = `/upload/${assetId}/file.jpg`;

    it('should delete file and remove asset record', async () => {
      await sut.onCancel(assetId, path);

      expect(mocks.storage.unlink).toHaveBeenCalledWith(path);
      expect(mocks.asset.removeAndDecrementQuota).toHaveBeenCalledWith(assetId);
    });

    it('should retry unlink on transient failures', async () => {
      mocks.storage.unlink.mockRejectedValueOnce(new Error('Transient error')).mockResolvedValue();

      await sut.onCancel(assetId, path);

      expect(mocks.storage.unlink).toHaveBeenCalledTimes(2);
    });

    it('should retry removeAndDecrementQuota on transient failures', async () => {
      mocks.asset.removeAndDecrementQuota.mockRejectedValueOnce(new Error('Transient error')).mockResolvedValue();

      await sut.onCancel(assetId, path);

      expect(mocks.asset.removeAndDecrementQuota).toHaveBeenCalledTimes(2);
    });
  });

  describe('access', () => {
    const resumeDto = { contentLength: 10, version: 8, uploadOffset: 0, uploadComplete: false } as any;

    it('should reject an upload from a shared link that does not allow uploads', async () => {
      const auth = factory.auth({ sharedLink: { allowUpload: false } });

      await expect(sut.startUpload(auth, {} as any, res() as any, {} as any)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.asset.createWithMetadata).not.toHaveBeenCalled();
    });

    it('should reject resuming from a shared link that does not allow uploads', async () => {
      const auth = factory.auth({ sharedLink: { allowUpload: false } });

      await expect(sut.resumeUpload(auth, {} as any, res() as any, factory.uuid(), resumeDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.asset.getCompletionMetadata).not.toHaveBeenCalled();
    });

    it('should only let the shared link that created an upload see or change it', async () => {
      const id = factory.uuid();
      const creator = factory.auth({ sharedLink: { allowUpload: true } });
      const otherLink = factory.auth({ sharedLink: { allowUpload: true } });
      mocks.asset.getUploadCreator.mockResolvedValue({
        status: AssetStatus.Partial,
        sessionId: null,
        apiKeyId: null,
        sharedLinkId: creator.sharedLink!.id,
      });
      mocks.asset.getCompletionMetadata.mockResolvedValue(undefined);

      const fromOtherLink = res();
      await sut.cancelUpload(otherLink, id, fromOtherLink as any);
      expect(fromOtherLink.status).toHaveBeenCalledWith(404);
      expect(mocks.asset.claimUpload).not.toHaveBeenCalled();

      const fromOwnerSession = res();
      await sut.cancelUpload(factory.auth(), id, fromOwnerSession as any);
      expect(fromOwnerSession.status).toHaveBeenCalledWith(404);
      expect(mocks.asset.claimUpload).not.toHaveBeenCalled();

      await sut.cancelUpload(creator, id, res() as any);
      expect(mocks.asset.claimUpload).toHaveBeenCalled();
    });

    it("should keep a shared link away from the owner's own uploads", async () => {
      mocks.asset.getUploadCreator.mockResolvedValue({
        status: AssetStatus.Partial,
        sessionId: factory.uuid(),
        apiKeyId: null,
        sharedLinkId: null,
      });
      const response = res();

      await sut.getUploadStatus(factory.auth({ sharedLink: { allowUpload: true } }), response as any, factory.uuid(), {
        version: 8,
      });

      expect(response.status).toHaveBeenCalledWith(404);
    });

    it('should not report a finished upload to a shared link', async () => {
      mocks.asset.getUploadCreator.mockResolvedValue({
        status: AssetStatus.Active,
        sessionId: null,
        apiKeyId: null,
        sharedLinkId: null,
      });
      const response = res();

      await sut.getUploadStatus(factory.auth({ sharedLink: { allowUpload: true } }), response as any, factory.uuid(), {
        version: 8,
      });

      expect(response.status).toHaveBeenCalledWith(404);
      expect(mocks.storage.stat).not.toHaveBeenCalled();
    });

    it('should refuse a resumable upload from a shared link before creating anything', async () => {
      const response = res();
      const dto = { contentLength: 10, uploadLength: 100, uploadComplete: false, version: 8 } as any;

      await sut.startUpload(factory.auth({ sharedLink: { allowUpload: true } }), {} as any, response as any, dto);

      expect(response.status).toHaveBeenCalledWith(403);
      expect(mocks.asset.createWithMetadata).not.toHaveBeenCalled();
    });

    it('should refuse to resume from a shared link that may upload', async () => {
      const response = res();

      await sut.resumeUpload(
        factory.auth({ sharedLink: { allowUpload: true } }),
        {} as any,
        response as any,
        factory.uuid(),
        { contentLength: 10, version: 8, uploadOffset: 0, uploadComplete: false } as any,
      );

      expect(response.status).toHaveBeenCalledWith(403);
      expect(mocks.asset.getUploadCreator).not.toHaveBeenCalled();
    });

    it('should let any of the owner sessions act on an upload another of them started', async () => {
      mocks.asset.getUploadCreator.mockResolvedValue({
        status: AssetStatus.Partial,
        sessionId: factory.uuid(),
        apiKeyId: null,
        sharedLinkId: null,
      });
      mocks.asset.getCompletionMetadata.mockResolvedValue(undefined);
      const response = res();

      await sut.cancelUpload(factory.auth({ session: { id: factory.uuid() } }), factory.uuid(), response as any);

      expect(mocks.asset.claimUpload).toHaveBeenCalled();
    });

    it("should count only the requester's own kind of uploads against the cap", async () => {
      await sut.onStart(authStub.user1, {
        assetData: { filename: 'a.jpg', fileCreatedAt: new Date(), fileModifiedAt: new Date() },
        checksum: Buffer.from('c'),
        uploadLength: 10,
      } as any);
      const linkAuth = factory.auth({ sharedLink: { allowUpload: true } });
      await sut.onStart(linkAuth, {
        assetData: { filename: 'b.jpg', fileCreatedAt: new Date(), fileModifiedAt: new Date() },
        checksum: Buffer.from('d'),
        uploadLength: 10,
      } as any);

      expect(mocks.asset.countPartialUploads.mock.calls.map((call) => call[2])).toEqual([
        null,
        linkAuth.sharedLink!.id,
      ]);
    });

    it("should not hand a shared link the location of the owner's upload of the same file", async () => {
      const response = res();
      const dto = {
        contentLength: 100,
        uploadLength: 100,
        uploadComplete: true,
        version: 8,
        checksum: Buffer.from('x'),
      };
      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue({
        id: 'owner-upload',
        status: AssetStatus.Partial,
        createdAt: new Date(),
      });
      mocks.asset.getUploadCreator.mockResolvedValue({
        status: AssetStatus.Partial,
        sessionId: factory.uuid(),
        apiKeyId: null,
        sharedLinkId: null,
      });

      await sut.startUpload(
        factory.auth({ sharedLink: { allowUpload: true } }),
        {} as any,
        response as any,
        { ...dto, assetData: { filename: 'a.jpg', fileCreatedAt: new Date(), fileModifiedAt: new Date() } } as any,
      );

      expect(response.status).toHaveBeenCalledWith(409);
      expect(response.setHeader).not.toHaveBeenCalledWith('Location', expect.anything());
      expect(mocks.asset.claimUpload).not.toHaveBeenCalled();
    });

    it("should answer 404 without aborting the owner's request when another user touches an upload", async () => {
      const id = factory.uuid();
      const ownerRequest = { destroy: vi.fn(), on: vi.fn() };
      (sut as any).activeRequests.set(id, { req: ownerRequest, startTime: new Date(0), settled: Promise.resolve() });
      mocks.asset.getUploadCreator.mockResolvedValue(undefined);
      mocks.asset.getCompletionMetadata.mockResolvedValue(undefined);
      const response = res();

      await sut.getUploadStatus(factory.auth(), response as any, id, { version: 8 });
      await sut.cancelUpload(factory.auth(), id, response as any);
      await sut.resumeUpload(factory.auth(), {} as any, response as any, id, resumeDto);

      expect(response.status).toHaveBeenCalledWith(404);
      expect(response.status).toHaveBeenCalledTimes(3);
      expect(ownerRequest.destroy).not.toHaveBeenCalled();
      expect(mocks.websocket.serverSend).not.toHaveBeenCalled();
    });
  });

  describe('getUploadOptions', () => {
    it('should advertise a 90 MiB max-append-size by default', async () => {
      mocks.systemMetadata.get.mockResolvedValue({});

      await expect(getUploadLimit(sut)).resolves.toBe('min-size=1, max-age=259200, max-append-size=94371840');
    });

    it('should advertise a configured max-append-size', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ backup: { upload: { maxAppendSizeBytes: 50_000_000 } } });

      await expect(getUploadLimit(sut)).resolves.toBe('min-size=1, max-age=259200, max-append-size=50000000');
    });

    it('should reject a request body larger than max-append-size with 413 and Upload-Limit', async () => {
      const response = res();
      const dto = { contentLength: 94_371_841, uploadLength: 200_000_000, uploadComplete: false, version: 8 } as any;

      await sut.startUpload(factory.auth(), {} as any, response as any, dto);

      expect(response.status).toHaveBeenCalledWith(413);
      expect(response.setHeader).toHaveBeenCalledWith(
        'Upload-Limit',
        expect.stringContaining('max-append-size=94371840'),
      );
      expect(mocks.asset.createWithMetadata).not.toHaveBeenCalled();
    });

    it('should advertise the remaining lifetime of an existing upload as max-age', async () => {
      const response = res();
      mocks.asset.getCompletionMetadata.mockResolvedValue({
        path: '/upload/file.jpg',
        status: AssetStatus.Partial,
        createdAt: new Date(Date.now() - 3_600_000),
        fileModifiedAt: new Date(),
        checksum: Buffer.from('checksum'),
        size: 10,
      });
      mocks.storage.stat.mockResolvedValue({ size: 5 } as any);

      await sut.getUploadStatus(factory.auth(), response as any, factory.uuid(), { version: 8 });

      const limit = response.setHeader.mock.calls.find(([name]) => name === 'Upload-Limit')?.[1] as string;
      const maxAge = Number(/max-age=(\d+)/.exec(limit)?.[1]);
      expect(maxAge).toBeGreaterThan(71 * 3600 - 5);
      expect(maxAge).toBeLessThanOrEqual(71 * 3600);
    });

    it('should answer 404 for an upload past its max-age', async () => {
      const response = res();
      mocks.asset.getCompletionMetadata.mockResolvedValue({
        path: '/upload/file.jpg',
        status: AssetStatus.Partial,
        createdAt: new Date(Date.now() - 73 * 3_600_000),
        fileModifiedAt: new Date(),
        checksum: Buffer.from('checksum'),
        size: 10,
      });

      await sut.getUploadStatus(factory.auth(), response as any, factory.uuid(), { version: 8 });

      expect(response.status).toHaveBeenCalledWith(404);
    });

    it('should not advertise max-append-size when it is 0', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ backup: { upload: { maxAppendSizeBytes: 0 } } });

      await expect(getUploadLimit(sut)).resolves.toBe('min-size=1, max-age=259200');
    });
  });

  describe('removeStaleUploads', () => {
    it('should queue cleanup jobs for stale partial assets', async () => {
      const staleAssets = [{ id: factory.uuid() }, { id: factory.uuid() }, { id: factory.uuid() }];

      mocks.assetJob.streamForPartialAssetCleanupJob.mockReturnValue(
        // eslint-disable-next-line @typescript-eslint/require-await
        (async function* () {
          for (const asset of staleAssets) {
            yield asset;
          }
        })(),
      );

      await sut.removeStaleUploads();

      expect(mocks.assetJob.streamForPartialAssetCleanupJob).toHaveBeenCalledWith(expect.any(Date));

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.PartialAssetCleanup, data: staleAssets[0] },
        { name: JobName.PartialAssetCleanup, data: staleAssets[1] },
        { name: JobName.PartialAssetCleanup, data: staleAssets[2] },
      ]);
    });

    it('should batch cleanup jobs', async () => {
      const assets = Array.from({ length: 1500 }, () => ({ id: factory.uuid() }));

      mocks.assetJob.streamForPartialAssetCleanupJob.mockReturnValue(
        // eslint-disable-next-line @typescript-eslint/require-await
        (async function* () {
          for (const asset of assets) {
            yield asset;
          }
        })(),
      );

      await sut.removeStaleUploads();

      // Should be called twice: once for 1000, once for 500
      expect(mocks.job.queueAll).toHaveBeenCalledTimes(2);
    });

    it('should handle empty stream', async () => {
      mocks.assetJob.streamForPartialAssetCleanupJob.mockReturnValue((async function* () {})());

      await sut.removeStaleUploads();

      expect(mocks.job.queueAll).toHaveBeenCalledWith([]);
    });
  });

  describe('removeStaleUpload', () => {
    const assetId = factory.uuid();
    const path = `/upload/${assetId}/file.jpg`;

    it('should skip an upload another request is writing to', async () => {
      mocks.asset.claimUpload.mockResolvedValue(false);

      await expect(sut.removeStaleUpload({ id: assetId })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.asset.claimUpload).toHaveBeenCalledTimes(1);
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
      expect(mocks.asset.removeAndDecrementQuota).not.toHaveBeenCalled();
    });

    it('should release its claim after cleaning up', async () => {
      mocks.assetJob.getForPartialAssetCleanupJob.mockResolvedValue({
        path,
        checksum: Buffer.from('checksum'),
        fileModifiedAt: new Date(),
        size: 1024,
      });
      mocks.storage.stat.mockResolvedValue({ size: 512 } as any);

      await sut.removeStaleUpload({ id: assetId });

      const [, writerId] = mocks.asset.claimUpload.mock.calls[0];
      expect(mocks.asset.releaseUploadClaim).toHaveBeenCalledWith(assetId, writerId);
    });

    it('should skip if asset not found', async () => {
      mocks.assetJob.getForPartialAssetCleanupJob.mockResolvedValue(undefined);

      const result = await sut.removeStaleUpload({ id: assetId });

      expect(result).toBe(JobStatus.Skipped);
      expect(mocks.storage.stat).not.toHaveBeenCalled();
    });

    it('should complete asset if file matches expected state', async () => {
      const checksum = Buffer.from('checksum');
      const fileModifiedAt = new Date();

      mocks.assetJob.getForPartialAssetCleanupJob.mockResolvedValue({
        path,
        checksum,
        fileModifiedAt,
        size: 1024,
      });

      mocks.storage.stat.mockResolvedValue({ size: 1024 } as any);
      mocks.crypto.hashFile.mockResolvedValue(checksum);

      const result = await sut.removeStaleUpload({ id: assetId });

      expect(result).toBe(JobStatus.Success);
      expect(mocks.asset.setComplete).toHaveBeenCalledWith(assetId, undefined);
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should cancel asset if file size does not match', async () => {
      mocks.assetJob.getForPartialAssetCleanupJob.mockResolvedValue({
        path,
        checksum: Buffer.from('checksum'),
        fileModifiedAt: new Date(),
        size: 1024,
      });

      mocks.storage.stat.mockResolvedValue({ size: 512 } as any);

      const result = await sut.removeStaleUpload({ id: assetId });

      expect(result).toBe(JobStatus.Success);
      expect(mocks.storage.unlink).toHaveBeenCalledWith(path);
      expect(mocks.asset.removeAndDecrementQuota).toHaveBeenCalledWith(assetId);
    });

    it('should cancel asset if checksum does not match', async () => {
      mocks.assetJob.getForPartialAssetCleanupJob.mockResolvedValue({
        path,
        checksum: Buffer.from('expected-checksum'),
        fileModifiedAt: new Date(),
        size: 1024,
      });

      mocks.storage.stat.mockResolvedValue({ size: 1024 } as any);
      mocks.crypto.hashFile.mockResolvedValue(Buffer.from('actual-checksum'));

      const result = await sut.removeStaleUpload({ id: assetId });

      expect(result).toBe(JobStatus.Success);
      expect(mocks.storage.unlink).toHaveBeenCalledWith(path);
      expect(mocks.asset.removeAndDecrementQuota).toHaveBeenCalledWith(assetId);
    });

    it('should cancel asset if file does not exist', async () => {
      mocks.assetJob.getForPartialAssetCleanupJob.mockResolvedValue({
        path,
        checksum: Buffer.from('checksum'),
        fileModifiedAt: new Date(),
        size: 1024,
      });

      const error = new Error('File not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mocks.storage.stat.mockRejectedValue(error);

      const result = await sut.removeStaleUpload({ id: assetId });

      expect(result).toBe(JobStatus.Success);
      expect(mocks.asset.removeAndDecrementQuota).toHaveBeenCalledWith(assetId);
    });

    it('should cancel asset if stat fails with permission error', async () => {
      mocks.assetJob.getForPartialAssetCleanupJob.mockResolvedValue({
        path,
        checksum: Buffer.from('checksum'),
        fileModifiedAt: new Date(),
        size: 1024,
      });

      const error = new Error('Permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      mocks.storage.stat.mockRejectedValue(error);

      const result = await sut.removeStaleUpload({ id: assetId });

      expect(result).toBe(JobStatus.Success);
      expect(mocks.asset.removeAndDecrementQuota).toHaveBeenCalledWith(assetId);
    });
  });
});
