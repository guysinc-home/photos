# Chunked, resumable uploads for Immich: what has to change

Research only. No application code was changed.

## Summary

**Recommendation: build on upstream PR #22385 for the server, and write our own client chunking on its wire protocol (RUFH). Do not invent a protocol, do not adopt tus, and do not wait.**

- **#22385 already chunks.** Its server accepts any number of `PATCH` appends at offsets the client chooses. A client sending ≤ 90 MiB per request gets past a 100 MB proxy cap (upstream maintainer, 2026‑10‑08).
- **Upstream is blocked on Apple, not the server.** URLSession sends the whole file in one request and ignores the server's `Upload-Limit` header. Our own Dart client avoids that.
- **Server work is small.** #22385 rebases onto `main` with 4 conflicting files, plus three small fixes:
  - make two removed device fields optional;
  - stop partial uploads leaking to phones through sync, where they look backed up;
  - stop holding a database connection for each upload's whole duration.
- **Android benefits most.** Its WorkManager backup already runs the Dart foreground uploader, so one Dart client covers Android background and iOS foreground.
- **iOS background is the hard part.** `background_downloader` cannot chunk.
  - Phase 1: route large files to the Dart uploader in the foreground and in `BGProcessingTask`.
  - Phase 2, optional: a native Swift chain of background chunk uploads.
- **We need our own iOS build** with our own bundle id, team and app group, distributed through TestFlight or ad hoc. The OAuth scheme can stay.
- **Size:** about 10 PRs. Server ≈1–1.5 weeks, mobile ≈3–4 weeks (+2–3 for native background), web and CLI ≈1 week, build ≈1 week. The server ships first and stays compatible with stock apps.

**Main risks:** upstream reshapes #22385; we carry an unmerged migration; mobile backup code changes upstream about every two weeks; iOS throttles background chains.

### Corrections to our starting assumptions

| Assumption                                                 | What the code says                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every client sends one multipart `POST /api/assets`        | **True** for mobile, web and CLI; no client does anything else. `[code]`                                                                                                                                                                                                                                                                                                  |
| "On error, retries once from byte 0"                       | **Only true for the mobile foreground path**, and only when the connection fails before any response arrives (`ClientException`). Other paths differ: <br>• iOS background (`background_downloader`): `retries: 3`. <br>• Web: no automatic retry; the retry button re-hashes and re-uploads everything. <br>• CLI: up to 3 attempts in total, each from byte 0. `[code]` |
| No upload-session, chunk or offset endpoint in OpenAPI     | **True.** I searched all 199 paths. `[code]`                                                                                                                                                                                                                                                                                                                              |
| `x-immich-checksum` is used for dedupe                     | The server supports it, but **no client sends it**. Mobile, web and CLI dedupe through `POST /assets/bulk-upload-check` or the database's unique constraint. `[code]`                                                                                                                                                                                                     |
| `deviceAssetId` takes part in dedupe                       | **No.** The `deviceAssetId` and `deviceId` columns were dropped (`server/src/schema/migrations/1776263790468-DropDeviceIdAndDeviceAssetId.ts`). Mobile still sends them for older servers. `[code]`                                                                                                                                                                       |
| #31685 was closed with "we will continue waiting for RUFH" | **True.** bo0tzz, 2026‑09‑20, no other reason given. `[PR]`                                                                                                                                                                                                                                                                                                               |

### Sources

- **Upstream `main`** is `76dedb65851897cf0add8541d0c3163157fb25ea` (2026‑11‑04). Our fork's `main` is the same commit, with no fork-only commits.
  - Paths below are at that sha unless marked otherwise. Line numbers are approximate to ±2.
- **#22385** ([immich-app/immich#22385](https://github.com/immich-app/immich/pull/22385)): head `41dd5fa2fbe2`, base `e598e1089668`.
- **#31685** ([immich-app/immich#31685](https://github.com/immich-app/immich/pull/31685)): head `829f638f2cae`.

I read both PR conversations on github.com.

- **#22385** is locked, and 77 timeline items were collapsed and not shown to me, so my reading of that thread is incomplete.
- **IETF pages** (ietf.org, datatracker) are blocked by this session's network policy. I took details of the RUFH draft from the PR thread, the server code and search summaries.

Each claim is tagged:

- `[code]`: read in code.
- `[PR]`: read in a PR or its discussion.
- `[doc]`: read in documentation.
- `[inferred]`: my reasoning, not checked by running anything.

---

## 1. Server

### 1.1 Today's upload path

All `[code]`.

- **Endpoint and auth.** `POST /api/assets` is `AssetMediaController.uploadAsset` (`server/src/controllers/asset-media.controller.ts:51-90`), requiring `Permission.AssetUpload = 'asset.upload'` with shared links allowed (`server/src/enum.ts:156`).
  - Auth tries a shared-link key or slug, then a session, then an API key (`x-api-key` or `apiKey`). An API key must carry the route's permission (`server/src/services/auth.service.ts:230-267`).
  - Shared-link uploads need `allowUpload` (`server/src/utils/access.ts:41-46`).
  - Auth runs before any of the body is read.
- **Interceptors.**
  - `AssetUploadInterceptor` returns 200 `duplicate` without reading the body when `x-immich-checksum` matches (`server/src/middleware/asset-upload.interceptor.ts:18-23`).
  - `FileUploadInterceptor` runs multer with **no size limit**, accepts `assetData` and `sidecarData`, and streams to `<media>/upload/<userId>/<aa>/<bb>/<uuid><ext>` while computing SHA‑1 (`server/src/middleware/file-upload.interceptor.ts:54-144`; `server/src/cores/storage.core.ts:356-358`).
  - On a client disconnect it queues a `FileDelete` job (lines 98-105). **A partial body is thrown away.**
- **Service** (`server/src/services/asset-media.service.ts:127-242`).
  - Quota is checked only after the whole file is on disk (lines 142, 371-375). Usage is incremented later by the `AssetCreate` event (`server/src/services/user.service.ts:234-239`), so concurrent uploads can overshoot the quota.
  - A live photo's `livePhotoVideoId` must point at the uploader's own video, which is then hidden (lines 144-162).
  - It writes the asset row, a sidecar `asset_file` row, `utimes`, and the EXIF size (lines 164-200).
  - It queues `AssetExtractMetadata` and emits `AssetCreate` (lines 202-208). Storage-template migration, thumbnails and the upload notification follow as a chain (`server/src/services/job.service.ts:117-121`).
  - Duplicates hit the unique index `UQ_assets_owner_checksum WHERE libraryId IS NULL` (`server/src/schema/tables/asset.table.ts:38-43`) and get 200 `duplicate` (lines 213-232).
- **Limits.** JSON bodies are capped at 10 MB, but multipart has no cap. `requestTimeout` is 24 h. The API is a single process (`server/src/app.common.ts:56-57, 89-90`; `server/src/main.ts:100-102`).
- **Cleanup.** No nightly job sweeps `upload/`. The 03:00 integrity check only _reports_ untracked files there, and skips dot-directories (`server/src/services/integrity.service.ts:220-236`).

### 1.2 Where a session model sits: what #22385 does

#22385 does **not** add a session table. It is the right design to start from, with three fixes.

**State: a partial asset** `[PR]`

- A migration adds `'partial'` to `assets_status_enum` (`1790289252000-AddPartialAssetStatus.ts`). Nothing else changes in the schema.
- `POST /api/upload` immediately creates a `partial`, `hidden` asset row, its EXIF size row, and the quota increment, all in one statement (`asset.repository.ts` `createWithMetadata`).
- Live-photo linking and the `iCloudId` metadata are handled at that point too.
- About 26 job and query sites in `asset-job.repository.ts` and `asset.repository.ts` gain `status != 'partial'`.

**Temp storage = the final path** `[PR]`

- Bytes are appended directly to the asset's `originalPath` in `upload/<user>/…` (`createOrAppendWriteStream`).
- The current offset is the file's size on disk (`getCurrentOffset`).
- There is no assembly step, and the file is never staged anywhere else.
- The integrity check sees the file as tracked, so there are no false "untracked file" reports. `[inferred]`

**Finalise** (`AssetUploadService.onComplete`) `[PR]`

1. Check SHA‑1 against the `Repr-Digest` header sent at creation. A mismatch returns status 460, deletes the file and gives the quota back.
2. `setComplete` sets the status to `active` and visibility to `timeline` (or `hidden` for a live-photo video), and adds the asset to a shared link or album.
3. Emits `AssetCreate` and queues `AssetExtractMetadata`.

It **bypasses** `AssetMediaService.uploadAsset`, so:

- **Sidecars are not supported** on this path. The CLI is the only client that sends them.
- Quota is not counted twice, because the `AssetCreate` event carries no `file` (`user.service.ts:234-239`). `[code]`

**Expiry** `[PR]`

- A nightly task (`PartialAssetCleanupQueueAll`, config `backup.upload.maxAgeHours` = 72, toggled by `nightlyTasks.removeStaleUploads`) checks each partial upload older than that.
- If the file is complete and its checksum matches, it is promoted to `active`. Otherwise the file is deleted and the quota given back.

**Concurrency** `[PR]`

- Each request takes a PostgreSQL advisory lock on the asset id: `withUuidLock` → `pg_advisory_lock(uuid_hash_extended(id,0))`.
- A newer request aborts an older one for the same asset: an in-memory map plus an `UploadAbort` event sent to other server instances.
- Socket timeout is 30 s.

**Idempotency** `[PR]`

- A repeated `POST` with the same checksum finds the existing partial asset.
- RUFH clients get a 5xx telling them to ask for the current offset and resume.
- A "conventional" single-request client overwrites the partial file.
- Appends at the wrong offset get 409 with the expected offset.

**Limits** `[PR]`

- Quota is reserved up front from `Upload-Length`. A request that would exceed it fails immediately.
- `Upload-Limit` advertises only `min-size=1, max-age=…`. `max-append-size` was deferred to a follow-up.
- Clients may still split the upload into appends of any size.

**Fixes we would need on top of #22385**

1. **Columns removed since the PR was written.** The `x-immich-asset-data` header still _requires_ `device-asset-id` and `device-id` (`asset-upload.dto.ts:18-27` at `41dd5fa2`), but `main` dropped those columns. Make them optional. `[code]`
2. **Partial uploads leak through sync.** `AssetSync.getUpserts` (`server/src/repositories/sync.repository.ts:404-410`) has no status filter, and #22385 doesn't add one. The synced columns include `checksum` and `visibility` but not `status` (`server/src/database.ts:440-448`). `[code]`
   - Mobile treats a local asset as backed up whenever a remote asset with the same checksum exists, whatever its visibility (`mobile/lib/infrastructure/repositories/backup.repository.dart:38-46, 97-104`). `[code]`
   - So an interrupted upload would look finished to the phone, which would stop retrying until the 72 h cleanup deletes the partial. `[inferred]`
   - Fix: filter `partial` out of the asset sync streams, including partner and album sync.
3. **One database connection per upload, held for its whole duration.** `withUuidLock` reserves a pooled connection for the full upload (`database.repository.ts` at `41dd5fa2`). The pool is built through `@immich/sql-tools` `createPostgres` with no explicit `max` (`server/src/utils/database.ts:55-60`). `[code]`
   - postgres.js defaults to 10 connections, so about 10 concurrent slow uploads could stall every other query. `[inferred]`
   - Fix: hold the lock only around the metadata reads and the final step, and protect the append with a row lock or a compare-and-set on offset.
4. **Advertise a per-request size.** Add `max-append-size` to `Upload-Limit`, driven by config (e.g. `backup.upload.maxAppendSizeBytes`, default 0 = unlimited). Our clients will read it from `OPTIONS /api/upload`.

**Per-user limits.** Quota is reserved at creation, which is better than today, where it is checked only after the upload has finished. `[PR]` A cap on concurrent partial uploads per user (say 20) would be a cheap guard against abuse. `[inferred]`

---

## 2. Protocol choice

### RUFH (IETF draft, as in #22385)

**iOS** `[doc][PR]`

- Since iOS 17, URLSession handles RUFH by itself.
- Uploads are automatically resumable when the server signals support. Background sessions resume on their own.
- `cancel(byProducingResumeData:)` and `uploadTask(withResumeData:)` handle manual pause and resume ([Apple: Pausing and resuming uploads](https://developer.apple.com/tutorials/data/documentation/foundation/pausing-and-resuming-uploads.md)).
- But URLSession **does not split the file**: the first request carries the whole body. Behind a 100 MB proxy that request fails (#22385, mertalev 2025‑10‑13).
- iOS 27's PhotoKit background upload speaks RUFH. Background uploads over 100 MiB through Cloudflare still fail (benmccann 2026‑09‑26).
- Apple requires an `Upload-Limit` header but does not use its value yet (mertalev 2026‑10‑29).

**Our own client**

- A client that sends explicit `PATCH` appends of ≤ 90 MiB works with #22385 today.
- The e2e test "should handle multiple chunks" covers this. `[PR]`

**Proxies** `[inferred]`

- Plain `POST`, `PATCH`, `HEAD`, `DELETE` and `OPTIONS` requests with custom headers pass Cloudflare and nginx.
- Our clients do not need the 104 interim response, which proxies may drop: #22385 also returns `Location` in the `201` for an incomplete upload.
- `HEAD` responses are marked `Cache-Control: no-store`.

**Draft churn**

- The draft is at ‑12 (July 2026). #22385 accepts interop versions 3–8 and handles the header rename between drafts. `[PR][doc]`
- The base draft forbids parallel appends. A separate individual draft proposes them (`draft-spk-httpbis-parallel-upload-00`). `[doc]`

**Server complexity and reuse**

- Already written: 465 lines of service, 109 of controller, plus about 1,100 lines of e2e tests and about 900 of unit tests. `[code]`
- About 90% reusable. `[inferred]`

### tus 1.0

- **iOS.** TUSKit supports background sessions, though there are reports of uploads pausing there. It doesn't use Apple's RUFH support. There is no first-party Flutter tus client. `[doc][inferred]`
- **Proxies.** Fine: the client chooses chunk size. `[inferred]`
- **Server.** Either a tusd sidecar or `@tus/server`, with upload state kept in files. The maintainer rejected tusd as an operational burden and `tus-node-server` for lacking RUFH (#22385, 2025‑10‑02). `[PR]`
- **Reuse of #22385.** None. Fork-only for good, and incompatible with whatever upstream ships.

### Our own chunk API (like #31685)

- **Shape.** Init, `PUT` chunk by index, complete, status and delete, with an `upload_session` table. `[PR]`
- **iOS.** The one real advantage is that chunks are **independent of order**, so a background session could queue them all at once. `[inferred]`
- **Proxies.** Fine.
- **Server.** Needs an assembly step and a second state table. Upstream refused it ("we will continue waiting for RUFH"). It reuses none of #22385 and would have to be dropped later.

### Verdict: RUFH, via #22385

- It is the only option with an upstream future, and our server work then shrinks to the fixes in §1.2.
- Its one weakness for us is that appends must arrive in order, which makes iOS _background_ chunking harder.
- We handle that in client design (§3.1) rather than by forking the protocol. `[inferred]`

---

## 3. Clients

### 3.1 iOS (Flutter + native)

**Today** `[code]`

- **Foreground.** `ForegroundUploadService` runs 3 workers that `POST` a `ProgressMultipartRequest` through a shared `CupertinoClient` (`mobile/lib/services/foreground_upload.service.dart:203-243, 327-378`; `mobile/lib/repositories/upload.repository.dart:71-114`).
  - It resends once on `ClientException` (`upload.repository.dart:86-93`).
  - It downloads iCloud originals with progress first (lines 271-295).
- **Background.** `buildUploadTask` enqueues `background_downloader` `UploadTask`s (multipart, `retries: 3`, 100 per batch) on the plugin's background URLSession (`mobile/lib/services/background_upload.service.dart:151-178, 390-455`). That session is patched for cookies and mTLS (`mobile/ios/Runner/Core/URLSessionManager.swift:161-203`).
- **Scheduling.** `BGAppRefreshTask` (20 s) and `BGProcessingTask` (no cap) start a headless engine that runs `onIosUpload`. That enqueues work for the URLSession (`mobile/ios/Runner/Background/BackgroundWorkerApiImpl.swift:54-126`; `mobile/lib/domain/services/background_worker.service.dart:138-184, 295-297`).
- **Interaction.** A foreground backup cancels the background queue, because `clearCache()` wipes all of tmp (`mobile/lib/providers/backup/backup.provider.dart:137-141`; `mobile/lib/infrastructure/repositories/storage.repository.dart:135-155`).
- **Not present:** no PhotoKit background-upload code and no native upload code.

**What changes**

1. **Dart RUFH client**, a new `ResumableUploadRepository`. `[inferred]`
   - Calls `OPTIONS /api/upload` to detect support and read `max-append-size`.
   - Sends `POST` with `Upload-Complete: ?0`, `Repr-Digest`, `x-immich-asset-data` and `Upload-Length`.
   - Then sequential `PATCH` requests of ≤ min(server limit, user setting, 90 MiB), reading from a `RandomAccessFile` at the right offset, so no chunk files are needed.
   - On any failure: `HEAD` to get the server's offset, then continue.
   - Progress is bytes acknowledged by the server plus in-flight bytes, which removes today's progress jump on a retry.
2. **Persist sessions on the phone.** A new Drift table keyed by local asset id stores: upload URL, checksum, length, last known offset and creation time. That lets uploads resume after the app is suspended or killed, or the network switches. Rows older than the server's `max-age` are dropped.
3. **Hash the exact bytes uploaded.** `Repr-Digest` must equal SHA‑1 of those bytes. Today's local checksum comes from native hashing of the `PHAssetResource` (`mobile/ios/Runner/Sync/MessagesImpl.swift:384-437`), while the upload file comes from photo_manager's `originFile`.
   - The two may differ for edited, adjusted or re-exported assets.
   - Safer: hash the exported file before `POST` (one extra read) and keep it on the session row. `[inferred]`
4. **Staging the source file.** Exported originals live in tmp, which `clearCache()` wipes. A resume therefore re-exports the original and checks the hash against the stored one. Alternatively, stage large exports under Application Support. `[inferred]`
5. **Routing large files.**
   - _Phase 1:_ when the server supports RUFH, skip files over the chunk limit in the URLSession enqueue. Upload them with the Dart client in the foreground and in `BGProcessingTask` runs, which have no time cap and run when charging. `[inferred]`
   - _Phase 2 (optional):_ a native Swift `ChunkUploader` behind a Pigeon API. It owns its own background URLSession, writes chunk _N_ to a file, and in `didCompleteWithError` schedules chunk _N+1_ (or does `HEAD` and resumes) without starting Flutter.
     - Risk: iOS slows down tasks started from background relaunches.
     - Test on a device before committing to this phase. `[inferred]`
6. **PhotoKit background upload.** Revisit only once Apple honours `Upload-Limit`. Upstream will likely go that way (#22385, 2026‑10‑29). `[PR]`

### 3.2 Android (WorkManager)

- Android background backup does **not** use `background_downloader`.
- `BackgroundWorker.kt` starts a headless engine that calls `onAndroidUpload(20 min)`. That runs `ForegroundUploadService.uploadCandidates(useSequentialUpload: true)` (`mobile/android/app/src/main/kotlin/app/alextran/immich/background/BackgroundWorker.kt:133`; `background_worker.service.dart:300-310`).
- Failures trigger a retry worker that requires a network connection (`mobile/android/app/src/main/kotlin/app/alextran/immich/background/BackgroundWorkerApiImpl.kt:106-133`). `[code]`
- So the Dart RUFH client from §3.1 items 1–2 covers Android foreground and background with no Kotlin work.
- A worker killed after 20 minutes resumes from the server's offset on its next run. `[inferred]`

### 3.3 Web

- `web/src/lib/utils/file-uploader.ts` hashes in a worker (lines 117-139), pre-checks with `checkBulkUpload` (lines 183-194), and sends one `XMLHttpRequest` through `uploadRequest` (`web/src/lib/utils.ts:100-128`), 2 at a time. `[code]`
- Change: above a threshold, use `POST` + `PATCH` with `file.slice()` per chunk.
- Resume works within a page session. Across reloads, the browser can't reopen the file, so the user must pick it again; matching by checksum then finds the partial upload. `[inferred]`
- Size: about 150 lines plus tests.

### 3.4 CLI

- `packages/cli/src/commands/asset.ts:407-448` sends `fetch` with a `FormData` stream (sidecar included). The queue retries up to 3 times from byte 0 (`packages/cli/src/queue.ts:113-125`). `[code]`
- Change: a RUFH path for files over the threshold that have no sidecar, using `fs.createReadStream({start,end})` per append.
- Files with sidecars keep `POST /assets` until the RUFH path supports sidecars. `[inferred]`

---

## 4. Compatibility

**Old apps against a new server** `[code][inferred]`

- `POST /assets` is unchanged. #22385 only adds `/api/upload*` routes and an enum value.
- The sync filter in §1.2 fix 2 keeps partial uploads away from any app, old or new.
- The server returns a `partial` status only from the new routes.

**New apps against an old server**

- Detect support by calling `OPTIONS /api/upload`: 204 with `Upload-Limit` means supported. Old servers answer 404 (no route) or serve the web page.
- If not supported, fall back to today's multipart upload.
- **Don't use `featureLevel`.** It is one integer that upstream bumps (`ServerFeatureLevel { FeatureLevel = 1, Passkeys = 2 }`, `server/src/enum.ts:1344-1347`, Passkeys added 2026‑10‑28 in `f5d33ff6`). A fork-assigned 3 would clash with upstream's next feature. `[code][inferred]`
- The mobile `ServerCapability` version gate (`mobile/lib/domain/models/server_capability.model.dart`) has the same problem, because our server reports upstream's version numbers. `[inferred]`

**Version policy**

- "The mobile app is typically compatible with the current and prior major version… the server is only compatible with the matching major version" (`docs/docs/install/upgrading.md:29-39`). `[doc]`
- The login screen blocks an app that is behind the server's major version, or more than one major ahead (`mobile/lib/utils/version_compatibility.dart:3-17`).
- A banner warns about any version mismatch (`mobile/lib/providers/server_info.provider.dart:43-78`).
- Our iOS build should therefore keep upstream's version number. `[code]`

**OpenAPI** `[code][PR]`

- Run `mise //:open-api` after the server PRs. It regenerates the spec, the TypeScript SDK and the Dart client, and CI's "OpenAPI Clients" check fails if the result is stale.
- #22385 adds about 350 lines to the spec and about 100 to the SDK.
- The generated functions are not useful for streaming request bodies, so clients write their own requests.
- No response field becomes required, so no Dart patch under `open-api/patch` is needed.

---

## 5. Tests

**Today** `[code]`

- **Server:** `server/src/services/asset-media.service.spec.ts` (`uploadAsset` at line 307) and the medium test `server/test/medium/specs/services/asset-media.service.spec.ts`. The interceptors have no specs.
- **e2e:** `e2e/src/specs/server/api/asset.e2e-spec.ts` (`POST /assets` at line 668) and `e2e/src/specs/server/cli/upload.e2e-spec.ts`.
- **Mobile:** `mobile/test/repositories/upload_repository_test.dart:71-129` (resend once, cancel), plus the foreground-upload, background-upload and backup-provider tests.
- **Web:** `web/src/lib/utils/file-uploader.spec.ts` (error handling only).
- **Network faults:** nothing simulates them anywhere.

**#22385 brings** `[PR]` about 900 lines of unit tests and a 1,090-line e2e spec (`asset-upload.e2e-spec.ts`). It covers interop versions, conventional fallback, offset mismatch, multiple chunks, aborting a stale request, cancel, quota, live photo and `OPTIONS`.

**We would add** `[inferred]`

1. **Server tests for our fixes:** partial uploads excluded from sync (medium test against sync streams); the concurrency test from fix 3 (20 parallel slow appends must not block `GET /server/ping`); `max-append-size` advertised.
2. **e2e with a 100 MB proxy:** an nginx service in `e2e/docker-compose.yml` with `client_max_body_size 100m`. Assert that a 300 MB chunked upload succeeds and a single 300 MB `POST` gets 413.
3. **Flaky connection:** a Toxiproxy container between the test runner and the server. The `limit_data` toxic cuts each connection after N bytes, and `timeout` and `bandwidth` add delay. Assert the final file's SHA‑1 equals the source and the offset never goes backwards. Run it in CI as one fixed-seed scenario.
4. **Mobile unit tests:** a fake `http.Client` that fails partway through the stream, then resume via `HEAD`; persisting sessions across a "restart"; checksum mismatch (460) causing a restart from scratch.
5. **On a device:**
   - iOS: Network Link Conditioner (Developer settings → "Very Bad Network" / 100 % loss).
   - Android: `adb shell svc data disable` and `svc wifi disable`.
   - Both: switch Wi‑Fi to cellular mid-upload, background the app, force-quit it, and lock the phone during a `BGProcessingTask`.
   - Watch server logs for 409 and 204 offsets.
   - Use a 2–4 GB HEVC video behind the real proxy.

---

## 6. Effort and slicing (dependency order)

Sizes: S ≤ 2 days, M 3–5 days, L 1–2 weeks. All estimates `[inferred]`.

| #   | PR                                                                                                                                                                                                              | Size | Depends on | Upstream?                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------- | -------------------------------------------------------------------------------------- |
| S1  | Rebase #22385 onto `main`: resolve 4 conflicts (`pnpm-lock.yaml`, `asset-job.repository.ts`, `migrations/ORDER`, `asset-media.service.ts`), make the removed device fields optional, regenerate OpenAPI and SQL | M    | none       | No; it's upstream's PR. Keep it as a separate commit to drop when upstream merges.     |
| S2  | Exclude `partial` from sync streams, with medium tests                                                                                                                                                          | S    | S1         | **Yes**: a real bug in #22385. A human would need to raise it (thread locked, §8).     |
| S3  | Rework locking so no connection is held for the whole upload; concurrency test                                                                                                                                  | M    | S1         | **Yes**, if measurements confirm the problem                                           |
| S4  | `max-append-size` in `Upload-Limit` plus admin setting                                                                                                                                                          | S    | S1         | **Yes**: it was planned upstream as a follow-up                                        |
| E1  | e2e behind an nginx 100 MB proxy, plus Toxiproxy                                                                                                                                                                | M    | S1         | Maybe                                                                                  |
| M1  | Dart `ResumableUploadRepository` plus Drift session table plus capability detection                                                                                                                             | L    | S1         | Upstream wants client PRs only after the server merges. Treat it as fork-only for now. |
| M2  | Use M1 in `ForegroundUploadService` above a size threshold (this covers Android background)                                                                                                                     | M    | M1         | Fork-only for now                                                                      |
| M3  | iOS phase 1: keep large files out of the URLSession path and run them in foreground or `BGProcessingTask`                                                                                                       | S–M  | M2         | Fork-only; upstream's iOS plan differs                                                 |
| M4  | iOS phase 2: native Swift chained background session (optional)                                                                                                                                                 | L    | M3         | Fork-only                                                                              |
| W1  | Web chunked path                                                                                                                                                                                                | S–M  | S1         | Possibly, after #22385 merges                                                          |
| C1  | CLI chunked path (no sidecar)                                                                                                                                                                                   | S    | S1         | Possibly                                                                               |
| F1  | Fork iOS build: signing, ids, CI lane (§7)                                                                                                                                                                      | M    | none       | Fork-only                                                                              |

- **Server-first.** S1–S4 and E1 can be deployed straight away and change nothing for stock apps.
- **Next:** W1 and C1 give immediate relief on desktop.
- **Then:** M1 and M2 fix Android, foreground and background, and iOS foreground. M3 covers most iOS cases.

---

## 7. Fork upkeep and our own iOS build

### How fast upstream moves

Commit counts on `main` from 2026‑05‑04 to 2026‑11‑04 `[code]`:

| Area                                                 | Commits               |
| ---------------------------------------------------- | --------------------- |
| Whole repo                                           | 1,513 (about 8 a day) |
| `server/src`                                         | 309                   |
| `mobile/lib`                                         | 376                   |
| `web/src`                                            | 315                   |
| `server/src/enum.ts`                                 | 39                    |
| `server/src/repositories/asset.repository.ts`        | 18                    |
| `server/src/services/asset-media.service.ts`         | 12                    |
| `server/src/schema/migrations/ORDER`                 | 9                     |
| `mobile/lib/services/foreground_upload.service.dart` | 20                    |
| `mobile/lib/services/background_upload.service.dart` | 18                    |
| `mobile/lib/repositories/upload.repository.dart`     | 5                     |
| `web/src/lib/utils/file-uploader.ts`                 | 7                     |
| `open-api/immich-openapi-specs.json`                 | 106                   |

- **Releases:** v3.0.0 (2026‑06‑30), then minor releases about monthly up to v3.4.0‑rc.1, with frequent patch releases. `[code]`
- **Server rebase burden.**
  - #22385 picked up 4 conflicts over 386 commits in 6 weeks. That is low: mostly the migration `ORDER` file and the lockfile.
  - The ongoing risk is that **new upstream asset queries won't exclude `partial` uploads** until #22385 merges. Each rebase needs a grep for new `selectFrom('asset')` calls. `[inferred]`
- **Migration risk.** Keep #22385's migration file name exactly. If upstream later merges a migration with a different name, our databases will have already applied ours; that needs a manual reconciliation step. `ADD VALUE IF NOT EXISTS` makes the SQL itself repeatable. `[inferred]`
- **Mobile rebase burden.** Upload and backup files change upstream about every 1–2 weeks: `14cd2fdb`, `02063972`, `c68ecb38`, `962ffaac`, `1539ae8b`. Keep our code in new files with thin hooks to limit conflicts. `[code][inferred]`

### Building and distributing our own iOS app

**What to change** `[code]`

- **`mobile/ios/Signing.xcconfig:14-26`:**
  - `IMMICH_TEAM_ID` (`2W7AC6T8T5`);
  - `IMMICH_BUNDLE_ID_PROD` (`app.alextran.immich`);
  - `IMMICH_BUNDLE_ID_DEV`;
  - `IMMICH_GROUP_ID` (`group.app.immich.share`).
  - Or put overrides in the git-ignored `Signing.local.xcconfig`.
  - The extension ids (`.ShareExtension`, `.Widget`) and the per-build-type group suffixes follow automatically (`project.pbxproj`).
- **Hard-coded values elsewhere:**
  - background task ids `app.alextran.immich.background.*` in `mobile/ios/Runner/Info.plist:7-10`;
  - the keychain label `CLIENT_CERT_LABEL` (`URLSessionManager.swift:4`);
  - `mobile/ios/fastlane/Fastfile:20-24` (FUTO team, signing identity, bundle ids) and `mobile/ios/fastlane/Appfile`.
- **Universal links.** `Runner.entitlements` has `applinks:my.immich.app`, and `mobile/lib/main.dart:202` checks that host. Upstream's domain won't serve an association file for our bundle id, so remove the entitlement or host our own `apple-app-site-association`. `[inferred]`
- **OIDC.**
  - The callback scheme `app.immich:///oauth-callback` is hard-coded (`mobile/lib/services/oauth.service.dart:6-10`) and is not registered in `Info.plist`.
  - It works through `ASWebAuthenticationSession` regardless of bundle id, so it can stay.
  - The server's `oauth.mobileOverrideEnabled` and `mobileRedirectUri` (`server/src/dtos/config.dto.ts:319-327`) and the identity provider's allowed redirects are unchanged. `[code][inferred]`
- **Deep links.** The `immich://` scheme can stay. If the stock app is also installed, iOS picks one of the two apps unpredictably. `[inferred]`
- **Android (if we ever ship it).** `applicationId` is `app.alextran.immich` (`mobile/android/app/build.gradle:40,80`). `[code]`

**Distribution without the App Store** `[inferred; general knowledge of Apple's programme, not re-read this session]`

- All options need a paid Apple Developer Program membership.
- **TestFlight** is the simplest update path: no public listing, internal testers (≤100) need no review, updates arrive automatically, and builds expire after 90 days.
- **Ad hoc** means registering each device's UDID, installing through a self-hosted `itms-services` manifest, no automatic updates, and renewing profiles every year.
- **CI:** clone the iOS job in `.github/workflows/build-mobile.yml:325-341` with our own `FASTLANE_TEAM_ID` and `IOS_CERTIFICATE_*` secrets.
- **Users:** the fork's app is a separate app. Users log in again and the local database is rebuilt, but checksum dedupe prevents re-uploads. The stock app should be removed.

---

## 8. Recommendation and risks

**Build on #22385 (server), with our own RUFH clients. Don't write our own protocol, and don't wait.**

**Why**

- #22385 already does what our 100 MB proxy needs: appends at offsets the client chooses.
- Upstream's blocker is Apple's behaviour, which our Dart client avoids.
- Waiting has no end date. The thread is locked, and the maintainer's latest word is "nothing is set in stone" (2026‑10‑29). `[PR]`
- Our own protocol repeats #31685, which upstream rejected outright, and would have to be thrown away later.
- tus loses the RUFH ecosystem and upstream compatibility.

**Main risks**

1. **#22385 changes before merging** (headers, database model, dropping interop versions). Mitigation:
   - keep S1 as one commit we can drop;
   - keep our clients to the draft's core messages;
   - check the protocol against each upstream release.
2. **Partial uploads leaking and the connection pool.** These are real defects (§1.2 fixes 2–3) and must ship in S2 and S3 before any client uses the new routes.
3. **iOS background chaining.** Phase 1 avoids it. Phase 2 is a spike before any commitment.
4. **Mobile merge churn.** Keep our code in separate files with narrow hooks.
5. **Distribution cost.** We would run an Apple developer account, TestFlight builds every 90 days, and re-signing on every rebase.
6. **Upstream policy.** `AGENTS.md` and `CONTRIBUTING.md` forbid pull requests of LLM-written code. Anything offered upstream (S2, S3, S4, and later W1 and C1) must be written and explained by a human contributor.
   - The #22385 thread is locked to collaborators.
   - Raise S2 and S3 as an issue or on Discord rather than as comments there.
