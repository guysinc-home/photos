import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { dirname, extname, join } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobItem, JobOf } from 'src/types.js';
import { JOBS_ASSET_PAGINATION_SIZE } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AuthSharedLink } from 'src/database.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { GetUploadStatusDto, ResumeUploadDto, StartUploadDto } from 'src/dtos/asset-upload.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import {
  AssetMetadataKey,
  AssetStatus,
  AssetType,
  AssetVisibility,
  ChecksumAlgorithm,
  ImmichWorker,
  JobName,
  JobStatus,
  QueueName,
  StorageFolder,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { UPLOAD_CLAIM_WAIT_MS, claimPartialUpload } from 'src/utils/asset.util.js';
import { isAssetChecksumConstraint } from 'src/utils/database.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { withRetry } from 'src/utils/misc.js';

export const MAX_RUFH_INTEROP_VERSION = 8;
type CompletionData = { id: string; path: string; fileModifiedAt: Date; sharedLink?: AuthSharedLink };
type ActiveRequest = { req: Readable; startTime: Date; settled: Promise<void> };
type Received = { id: string; path: string; expected: Buffer; fileModifiedAt: Date };
const UPLOAD_CLAIM_HEARTBEAT_MS = 10_000;

@Injectable()
export class AssetUploadService extends BaseService {
  // This is used to proactively abort previous requests for the same asset
  // when a new one arrives. The previous request still holds the asset lock
  // and will prevent the new request from proceeding until the previous one
  // times out. As normal client behavior will not have concurrent requests,
  // we can assume the previous request has already failed on the client end.
  private activeRequests = new Map<string, ActiveRequest>();

  @OnEvent({ name: 'UploadAbort', workers: [ImmichWorker.Api], server: true })
  onUploadAbort({ assetId, abortTime }: ArgOf<'UploadAbort'>) {
    const entry = this.activeRequests.get(assetId);
    if (!entry) {
      return false;
    }
    if (abortTime > entry.startTime) {
      entry.req.destroy();
      this.activeRequests.delete(assetId);
    }
    return true;
  }

  async startUpload(auth: AuthDto, req: Readable, res: Response, dto: StartUploadDto): Promise<void> {
    this.logger.verboseFn(() => `Starting upload: ${JSON.stringify(dto)}`);
    const { uploadComplete, assetData, uploadLength, contentLength, version } = dto;
    const isComplete = uploadComplete !== false;
    const isResumable = version && uploadComplete !== undefined;
    if (contentLength > uploadLength) {
      return this.sendInconsistentLength(res);
    }
    const { backup } = await this.getConfig({ withCache: true });
    if (this.exceedsAppendLimit(contentLength, backup)) {
      return this.sendAppendTooLarge(res, backup);
    }

    let started = await this.onStart(auth, dto);
    if (started.isDuplicate && started.status === AssetStatus.Partial && this.isExpired(started.createdAt, backup)) {
      await this.removeExpiredUpload(started.id);
      started = await this.onStart(auth, dto);
    }
    const { id, path, status, isDuplicate } = started;
    const location = `/api/upload/${id}`;
    if (isDuplicate) {
      if (status !== AssetStatus.Partial) {
        return this.sendAlreadyCompleted(res);
      }

      if (isResumable) {
        this.sendInterimResponse(res, location, version, this.getUploadLimits(backup));
        // this is a 5xx to indicate the client should do offset retrieval and resume
        res.status(500).send('Incomplete asset already exists');
        return;
      }
    }

    if (isComplete && uploadLength !== contentLength) {
      return this.sendInconsistentLength(res);
    }

    if (isResumable) {
      this.sendInterimResponse(res, location, version, this.getUploadLimits(backup));
    }

    await this.runExclusive(id, req, async () => {
      const claimed = await this.whileClaimed(id, req, async () => {
        let writePath = path;
        if (isDuplicate) {
          const existingAsset = await this.assetRepository.getCompletionMetadata(id, auth.user.id);
          if (existingAsset?.status !== AssetStatus.Partial) {
            return this.sendAlreadyCompleted(res);
          }
          if (existingAsset.size !== uploadLength) {
            return this.sendInconsistentLength(res);
          }
          writePath = existingAsset.path;
        }
        await this.storageRepository.mkdir(dirname(writePath));

        const writeStream = await this.storageRepository.createWriteStreamAt(writePath, 0, {
          flush: isComplete,
          truncate: true,
        });
        await this.receive(req, writeStream, contentLength);
        if (isResumable) {
          this.setCompleteHeader(res, version, uploadComplete);
        }
        if (!isComplete) {
          res.status(201).set('Location', location).setHeader('Upload-Limit', this.getUploadLimits(backup)).send();
          return;
        }

        const received = { id, path: writePath, expected: dto.checksum, fileModifiedAt: assetData.fileModifiedAt };
        await this.finishUpload(auth, res, received);
      });
      if (!claimed) {
        await this.sendUnclaimed(auth, res, id);
      }
    });
  }

  async resumeUpload(auth: AuthDto, req: Readable, res: Response, id: string, dto: ResumeUploadDto): Promise<void> {
    this.logger.verboseFn(() => `Resuming upload for ${id}: ${JSON.stringify(dto)}`);
    const { uploadComplete, uploadLength, uploadOffset, contentLength, version } = dto;
    this.setCompleteHeader(res, version, false);
    const { backup } = await this.getConfig({ withCache: true });
    if (this.exceedsAppendLimit(contentLength, backup)) {
      return this.sendAppendTooLarge(res, backup);
    }
    return this.runExclusive(id, req, async () => {
      const claimed = await this.whileClaimed(id, req, async () => {
        const completionData = await this.assetRepository.getCompletionMetadata(id, auth.user.id);
        if (!completionData) {
          res.status(404).send('Asset not found');
          return;
        }
        const { fileModifiedAt, path, status, checksum: providedChecksum, size: declaredLength } = completionData;

        if (status !== AssetStatus.Partial) {
          return this.sendAlreadyCompleted(res);
        }

        if (this.isExpired(completionData.createdAt, backup)) {
          res.status(404).send('Upload has expired');
          return;
        }

        if (declaredLength === null || (uploadLength !== undefined && uploadLength !== declaredLength)) {
          return this.sendInconsistentLength(res);
        }

        const expectedOffset = await this.getCurrentOffset(path);
        if (expectedOffset !== uploadOffset) {
          return this.sendOffsetMismatch(res, expectedOffset, uploadOffset);
        }

        const newLength = uploadOffset + contentLength;
        if (newLength > declaredLength || (uploadComplete && newLength !== declaredLength)) {
          return this.sendInconsistentLength(res);
        }

        if (contentLength === 0 && !uploadComplete) {
          res.status(204).setHeader('Upload-Offset', expectedOffset.toString()).send();
          return;
        }

        const writeStream = await this.storageRepository.createWriteStreamAt(path, uploadOffset, {
          flush: uploadComplete,
        });
        await this.receive(req, writeStream, contentLength);
        this.setCompleteHeader(res, version, uploadComplete);
        if (!uploadComplete) {
          try {
            const offset = await this.getCurrentOffset(path);
            res.status(204).setHeader('Upload-Offset', offset.toString()).send();
          } catch {
            this.logger.error(`Failed to get current offset for ${path} after write`);
            res.status(500).send();
          }
          return;
        }

        await this.finishUpload(auth, res, { id, path, expected: providedChecksum, fileModifiedAt });
      });
      if (!claimed) {
        await this.sendUnclaimed(auth, res, id);
      }
    });
  }

  async cancelUpload(auth: AuthDto, assetId: string, res: Response): Promise<void> {
    await this.settleExistingRequest(assetId);
    const claimed = await this.whileClaimed(assetId, undefined, async () => {
      const asset = await this.assetRepository.getCompletionMetadata(assetId, auth.user.id);
      if (!asset) {
        res.status(404).send('Asset not found');
        return;
      }
      if (asset.status !== AssetStatus.Partial) {
        return this.sendAlreadyCompleted(res);
      }
      await this.onCancel(assetId, asset.path);
      res.status(204).send();
    });
    if (!claimed) {
      await this.sendUnclaimed(auth, res, assetId);
    }
  }

  async getUploadStatus(auth: AuthDto, res: Response, id: string, { version }: GetUploadStatusDto): Promise<void> {
    this.logger.verboseFn(() => `Getting upload status for ${id} with version ${version}`);
    const { backup } = await this.getConfig({ withCache: true });
    await this.settleExistingRequest(id);
    const asset = await this.assetRepository.getCompletionMetadata(id, auth.user.id);
    if (!asset) {
      res.status(404).send('Asset not found');
      return;
    }
    if (asset.status === AssetStatus.Partial && this.isExpired(asset.createdAt, backup)) {
      res.status(404).send('Upload has expired');
      return;
    }

    const offset = await this.getCurrentOffset(asset.path);
    this.setCompleteHeader(res, version, asset.status !== AssetStatus.Partial);
    res.status(204).setHeader('Upload-Offset', offset.toString()).setHeader('Cache-Control', 'no-store');
    const { size } = asset;
    if (size !== null && size > 0) {
      res.setHeader('Upload-Length', size.toString());
    }
    res.setHeader('Upload-Limit', this.getUploadLimits(backup, asset.createdAt)).send();
  }

  async getUploadOptions(res: Response): Promise<void> {
    const { backup } = await this.getConfig({ withCache: true });
    res
      .status(204)
      .setHeader('Accept-Patch', 'application/partial-upload')
      .setHeader('Upload-Limit', this.getUploadLimits(backup))
      .send();
  }

  @OnJob({ name: JobName.PartialAssetCleanupQueueAll, queue: QueueName.BackgroundTask })
  async removeStaleUploads(): Promise<void> {
    const config = await this.getConfig({ withCache: false });
    const createdBefore = DateTime.now().minus({ hours: config.backup.upload.maxAgeHours }).toJSDate();
    let jobs: JobItem[] = [];
    const assets = this.assetJobRepository.streamForPartialAssetCleanupJob(createdBefore);
    for await (const asset of assets) {
      jobs.push({ name: JobName.PartialAssetCleanup, data: asset });
      if (jobs.length < JOBS_ASSET_PAGINATION_SIZE) {
        continue;
      }

      await this.jobRepository.queueAll(jobs);
      jobs = [];
    }
    await this.jobRepository.queueAll(jobs);
  }

  @OnJob({ name: JobName.PartialAssetCleanup, queue: QueueName.BackgroundTask })
  async removeStaleUpload({ id }: JobOf<JobName.PartialAssetCleanup>): Promise<JobStatus> {
    let status = JobStatus.Skipped;
    await this.whileClaimed(
      id,
      undefined,
      async () => {
        const asset = await this.assetJobRepository.getForPartialAssetCleanupJob(id);
        if (!asset) {
          return;
        }
        if (await this.isUploadedFileComplete(asset)) {
          await this.onComplete({ id, path: asset.path, fileModifiedAt: asset.fileModifiedAt });
        } else {
          await this.onCancel(id, asset.path);
        }
        status = JobStatus.Success;
      },
      0,
    );
    return status;
  }

  private async isUploadedFileComplete({
    checksum,
    path,
    size,
  }: {
    checksum: Buffer;
    path: string;
    size: number | null;
  }) {
    try {
      const stat = await this.storageRepository.stat(path);
      return size === stat.size && checksum.equals(await this.cryptoRepository.hashFile(path));
    } catch (error: any) {
      this.logger.debugFn(() => `Failed to check upload file ${path}: ${error.message}`);
      return false;
    }
  }

  async onStart(
    auth: AuthDto,
    { assetData, checksum, uploadLength }: StartUploadDto,
  ): Promise<{ id: string; path: string; status: AssetStatus; createdAt: Date; isDuplicate: boolean }> {
    const assetId = this.cryptoRepository.randomUUID();
    const folder = StorageCore.getNestedFolder(StorageFolder.Upload, auth.user.id, assetId);
    const extension = extname(assetData.filename);
    const path = join(folder, `${assetId}${extension}`);
    const type = mimeTypes.assetType(path);

    if (type === AssetType.Other) {
      throw new BadRequestException(`${assetData.filename} is an unsupported file type`);
    }

    this.validateQuota(auth, uploadLength);

    const existing = await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, checksum);
    if (existing) {
      return { id: existing.id, path, status: existing.status, createdAt: existing.createdAt, isDuplicate: true };
    }
    await this.validatePartialUploadCount(auth);

    try {
      await this.assetRepository.createWithMetadata(
        {
          id: assetId,
          ownerId: auth.user.id,
          libraryId: null,
          checksum,
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
          originalPath: path,
          fileCreatedAt: assetData.fileCreatedAt,
          fileModifiedAt: assetData.fileModifiedAt,
          localDateTime: assetData.fileCreatedAt,
          type,
          isFavorite: assetData.isFavorite,
          livePhotoVideoId: assetData.livePhotoVideoId,
          visibility: AssetVisibility.Hidden,
          originalFileName: assetData.filename,
          status: AssetStatus.Partial,
        },
        uploadLength,
        assetData.iCloudId ? [{ key: AssetMetadataKey.MobileApp, value: { iCloudId: assetData.iCloudId } }] : undefined,
        { sessionId: auth.session?.id, apiKeyId: auth.apiKey?.id, sharedLinkId: auth.sharedLink?.id },
      );
    } catch (error: any) {
      if (!isAssetChecksumConstraint(error)) {
        this.logger.error(`Error creating upload asset record: ${error.message}`);
        throw new InternalServerErrorException('Error creating asset');
      }

      const duplicate = await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, checksum);
      if (!duplicate) {
        throw new InternalServerErrorException('Error locating duplicate for checksum constraint');
      }

      return { id: duplicate.id, path, status: duplicate.status, createdAt: duplicate.createdAt, isDuplicate: true };
    }

    return { id: assetId, path, status: AssetStatus.Partial, createdAt: new Date(), isDuplicate: false };
  }

  async onComplete({ id, path, fileModifiedAt, sharedLink }: CompletionData) {
    this.logger.log('Completing upload for asset', id);
    const asset = await withRetry(() => this.assetRepository.setComplete(id, sharedLink));
    if (!asset) {
      this.logger.error(`Failed to mark asset ${id} as complete: not found or already completed`);
      return;
    }

    try {
      await withRetry(() => this.storageRepository.utimes(path, new Date(), fileModifiedAt));
      await this.eventRepository.emit('AssetCreate', { asset });
    } catch (error: any) {
      this.logger.error(`onComplete error for ${path}: ${error.message}`);
    }
    const jobData = { name: JobName.AssetExtractMetadata, data: { id, source: 'upload' } } as const;
    await withRetry(() => this.jobRepository.queue(jobData));
  }

  async onCancel(assetId: string, path: string): Promise<void> {
    this.logger.log('Cancelling upload for asset', assetId);
    await withRetry(() => this.storageRepository.unlink(path));
    await withRetry(() => this.assetRepository.removeAndDecrementQuota(assetId));
  }

  private async finishUpload(auth: AuthDto, res: Response, { id, path, expected, fileModifiedAt }: Received) {
    const asset = await this.assetRepository.getCompletionMetadata(id, auth.user.id);
    if (!asset) {
      res.status(404).send('Asset not found');
      return;
    }
    if (asset.status !== AssetStatus.Partial) {
      return this.sendAlreadyCompleted(res);
    }

    const { size } = await this.storageRepository.stat(path);
    if (size !== asset.size) {
      this.logger.warn(`Removing upload asset ${id}: ${size} bytes written, ${asset.size} declared`);
      await this.onCancel(id, path);
      return this.sendInconsistentLength(res);
    }

    const actual = await this.cryptoRepository.hashFile(path);
    if (!expected.equals(actual)) {
      return await this.sendChecksumMismatch(res, id, path);
    }

    await this.onComplete({ id, path, fileModifiedAt, sharedLink: auth.sharedLink });
    res.status(200).send({ id });
  }

  private async whileClaimed(
    assetId: string,
    req: Readable | undefined,
    handler: () => Promise<void>,
    waitMs = UPLOAD_CLAIM_WAIT_MS,
  ): Promise<boolean> {
    const writerId = this.cryptoRepository.randomUUID();
    if (!(await claimPartialUpload(this.assetRepository, assetId, writerId, waitMs))) {
      return false;
    }

    const heartbeat = setInterval(() => {
      this.assetRepository
        .refreshUploadClaim(assetId, writerId)
        .then((held) => held || req?.destroy())
        .catch(() => req?.destroy());
    }, UPLOAD_CLAIM_HEARTBEAT_MS);
    try {
      await handler();
    } finally {
      clearInterval(heartbeat);
      await this.assetRepository.releaseUploadClaim(assetId, writerId);
    }
    return true;
  }

  private async sendUnclaimed(auth: AuthDto, res: Response, id: string) {
    const asset = await this.assetRepository.getCompletionMetadata(id, auth.user.id);
    if (!asset) {
      res.status(404).send('Asset not found');
      return;
    }
    if (asset.status !== AssetStatus.Partial) {
      return this.sendAlreadyCompleted(res);
    }
    res.status(503).setHeader('Retry-After', '5').send('Upload is busy with another request');
  }

  private async runExclusive(assetId: string, req: Readable, handler: () => Promise<void>): Promise<void> {
    const previous = this.activeRequests.get(assetId);
    const startTime = new Date();
    this.abortExistingRequest(assetId, startTime);

    const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
    const entry = { req, startTime, settled };
    this.activeRequests.set(assetId, entry);
    try {
      await previous?.settled;
      await handler();
    } finally {
      settle();
      if (this.activeRequests.get(assetId) === entry) {
        this.activeRequests.delete(assetId);
      }
    }
  }

  private async settleExistingRequest(assetId: string) {
    const previous = this.activeRequests.get(assetId);
    this.abortExistingRequest(assetId);
    await previous?.settled;
  }

  private abortExistingRequest(assetId: string, abortTime = new Date()) {
    const abortEvent = { assetId, abortTime };
    // only emit if we didn't just abort it ourselves
    if (!this.onUploadAbort(abortEvent)) {
      this.websocketRepository.serverSend('UploadAbort', abortEvent);
    }
  }

  private async receive(req: Readable, writeStream: Writable, size: number) {
    let receivedLength = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedLength += chunk.length;
        if (receivedLength > size) {
          callback(new Error('Request body is longer than Content-Length'));
          return;
        }
        callback(null, chunk);
      },
    });

    if (req.destroyed) {
      writeStream.destroy();
      throw new Error('Request closed before all data received');
    }

    await pipeline(req, counter, writeStream);
    if (receivedLength < size) {
      throw new Error('Request closed before all data received');
    }
  }

  private sendInterimResponse({ socket }: Response, location: string, interopVersion: number, limits: string): void {
    if (socket && !socket.destroyed) {
      // Express doesn't understand interim responses, so write directly to socket
      socket.write(
        'HTTP/1.1 104 Upload Resumption Supported\r\n' +
          `Location: ${location}\r\n` +
          `Upload-Limit: ${limits}\r\n` +
          `Upload-Draft-Interop-Version: ${interopVersion}\r\n\r\n`,
      );
    }
  }

  private sendInconsistentLength(res: Response): void {
    res.status(400).contentType('application/problem+json').send({
      type: 'https://iana.org/assignments/http-problem-types#inconsistent-upload-length',
      title: 'inconsistent length values for upload',
    });
  }

  private sendAlreadyCompleted(res: Response): void {
    res.status(400).contentType('application/problem+json').send({
      type: 'https://iana.org/assignments/http-problem-types#completed-upload',
      title: 'upload is already completed',
    });
  }

  private sendOffsetMismatch(res: Response, expected: number, actual: number): void {
    res.status(409).contentType('application/problem+json').setHeader('Upload-Offset', expected.toString()).send({
      type: 'https://iana.org/assignments/http-problem-types#mismatching-upload-offset',
      title: 'offset from request does not match offset of resource',
      'expected-offset': expected,
      'provided-offset': actual,
    });
  }

  private sendChecksumMismatch(res: Response, assetId: string, path: string) {
    this.logger.warn(`Removing upload asset ${assetId} due to checksum mismatch`);
    res.status(460).send('File on server does not match provided checksum');
    return this.onCancel(assetId, path);
  }

  private async validatePartialUploadCount(auth: AuthDto) {
    const { backup } = await this.getConfig({ withCache: true });
    const { maxPartialUploads, maxAgeHours } = backup.upload;
    if (maxPartialUploads === 0) {
      return;
    }

    const createdAfter = DateTime.now().minus({ hours: maxAgeHours }).toJSDate();
    const count = await this.assetRepository.countPartialUploads(auth.user.id, createdAfter);
    if (count >= maxPartialUploads) {
      throw new HttpException(
        `Too many unfinished uploads: finish or cancel one of ${count} first`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async removeExpiredUpload(id: string) {
    await this.whileClaimed(id, undefined, async () => {
      const asset = await this.assetJobRepository.getForPartialAssetCleanupJob(id);
      if (asset) {
        await this.onCancel(id, asset.path);
      }
    });
  }

  private isExpired(createdAt: Date, { upload }: SystemConfig['backup']) {
    return Date.now() >= createdAt.getTime() + upload.maxAgeHours * 3_600_000;
  }

  private exceedsAppendLimit(contentLength: number, { upload }: SystemConfig['backup']) {
    return upload.maxAppendSizeBytes > 0 && contentLength > upload.maxAppendSizeBytes;
  }

  private sendAppendTooLarge(res: Response, backup: SystemConfig['backup']): void {
    res
      .status(413)
      .setHeader('Upload-Limit', this.getUploadLimits(backup))
      .contentType('application/problem+json')
      .send({
        title: 'request content is larger than max-append-size',
        'max-append-size': backup.upload.maxAppendSizeBytes,
      });
  }

  private validateQuota(auth: AuthDto, size: number): void {
    const { quotaSizeInBytes: quotaLimit, quotaUsageInBytes: currentUsage } = auth.user;
    if (quotaLimit === null) {
      return;
    }

    if (quotaLimit < currentUsage + size) {
      throw new BadRequestException('Quota has been exceeded!');
    }
  }

  private async getCurrentOffset(path: string): Promise<number> {
    try {
      const stat = await this.storageRepository.stat(path);
      return stat.size;
    } catch (error: any) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
  }

  private setCompleteHeader(res: Response, interopVersion: number | undefined, isComplete: boolean): void {
    if (interopVersion === undefined || interopVersion > 3) {
      res.setHeader('Upload-Complete', isComplete ? '?1' : '?0');
    } else {
      res.setHeader('Upload-Incomplete', isComplete ? '?0' : '?1');
    }
  }

  private getUploadLimits({ upload }: SystemConfig['backup'], createdAt?: Date) {
    const maxAge = upload.maxAgeHours * 3600;
    const remaining = createdAt ? Math.max(0, Math.floor((createdAt.getTime() - Date.now()) / 1000) + maxAge) : maxAge;
    const limits = `min-size=1, max-age=${remaining}`;
    return upload.maxAppendSizeBytes > 0 ? `${limits}, max-append-size=${upload.maxAppendSizeBytes}` : limits;
  }
}
