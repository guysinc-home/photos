# Resumable uploads (fork)

This fork's server accepts resumable, chunked uploads on `/api/upload`, using the IETF resumable upload protocol (RUFH, interop versions 3–8) from upstream [immich-app/immich#22385](https://github.com/immich-app/immich/pull/22385). `POST /api/assets` is unchanged, so stock apps keep working.

Not published on the docs site. Background and plan: `docs/research/chunked-uploads.md` (guysinc-home/photos#1).

## Flow

1. `OPTIONS /api/upload` → `204` with `Upload-Limit`. A client that gets anything else falls back to `POST /api/assets`.
2. `POST /api/upload` with the first bytes. The response gives the upload's `Location: /api/upload/<asset id>`.
3. `PATCH <Location>` for each further chunk. Each chunk is at most `max-append-size` bytes and is sent at `Upload-Offset`.
4. After any failure: `HEAD <Location>` reads the server's offset, and the client continues from it.
5. The request with `Upload-Complete: ?1` finishes the upload. The server checks the SHA‑1, then hands the asset to the normal pipeline: metadata, thumbnails, quota and the upload notification.

## Endpoints

| Route                           | Request headers                                                                                                                            | Responses                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `OPTIONS /api/upload` (no auth) |                                                                                                                                            | `204`, `Accept-Patch: application/partial-upload`, `Upload-Limit`                                         |
| `POST /api/upload`              | `X-Immich-Asset-Data`, `Repr-Digest: sha=:<base64>:`, `Upload-Draft-Interop-Version`, `Upload-Complete`, `Upload-Length`, `Content-Length` | `104` interim with `Location`; `201` + `Location` (incomplete); `200 {id}` (complete)                     |
| `PATCH /api/upload/:id`         | `Upload-Offset`, `Upload-Complete`, `Upload-Draft-Interop-Version`, `Content-Type: application/partial-upload` (v6+)                       | `204` + `Upload-Offset`; `200 {id}` when complete                                                         |
| `HEAD /api/upload/:id`          | `Upload-Draft-Interop-Version`                                                                                                             | `204` with `Upload-Offset`, `Upload-Complete`, `Upload-Length`, `Upload-Limit`, `Cache-Control: no-store` |
| `DELETE /api/upload/:id`        |                                                                                                                                            | `204`; the file is deleted and its quota returned                                                         |

`X-Immich-Asset-Data` is a structured dictionary:

- Required: `filename`, `file-created-at`, `file-modified-at`.
- Optional: `is-favorite`, `live-photo-video-id`, `icloud-id`.
- `device-asset-id` and `device-id` are accepted and ignored.

Errors:

- `400` with the `inconsistent-upload-length` problem type: a body longer than `Upload-Length`, an append past it, a completion that doesn't land exactly on it, or a file on disk of a different size at completion (the upload is then deleted).
- `400` with `completed-upload`: the upload is already finished.
- `400` "Quota has been exceeded!": quota is reserved from `Upload-Length` when the upload starts.
- `404`: unknown upload, past its `max-age`, or created with other credentials (see below).
- `409`: wrong offset; `Upload-Offset` gives the right one. Also returned when a shared link starts a file another client is already uploading; no `Location` is given.
- `413` with `Upload-Limit`: the request body is larger than `max-append-size`.
- `403`: a shared link tried to start or continue a resumable upload.
- `429`: the owner's own sessions and keys already have `maxPartialUploads` unfinished uploads. A shared link's uploads are counted separately and never block the owner.
- `460`: the SHA‑1 doesn't match; the upload is deleted.
- `500` on `POST`: the same client re-sent a file it is still uploading. Use `HEAD` and resume.
- `503` with `Retry-After`: another request is still writing to this upload.

Auth: a session, an API key with `asset.upload`, or a shared link with uploads allowed.

- **The owner's sessions and API keys share the owner's uploads.** A second device starting the same file gets `500` and resumes the same upload; nothing is deleted.
- **A shared link uploads a whole file in one request.** It can't start a resumable upload (`Upload-Complete: ?0`) or `PATCH` (`403`), and if its request is cut off, the upload is deleted at once. So nothing a link starts outlives its request or holds the owner's quota.
- **A shared link never sees the owner's uploads or other links' uploads.** For a file the owner is already uploading, it gets `409` with no `Location`.
- **The owner's sessions and keys may replace an upload a link left behind.**

## Settings

| Key                                | Default             | Effect                                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup.upload.maxAppendSizeBytes` | `94371840` (90 MiB) | Largest request body. Sent as `max-append-size` in `Upload-Limit`, and larger bodies get `413`. `0` means no limit. Keep it below your proxy's body limit, and set `0` for clients that send whole files in one request, such as iOS's URLSession. |
| `backup.upload.maxAgeHours`        | `72`                | An unfinished upload expires this long after it started. `max-age` in `Upload-Limit` counts down to that moment.                                                                                                                                   |
| `backup.upload.maxPartialUploads`  | `20`                | Unexpired unfinished uploads one user may have at once. `0` means no limit.                                                                                                                                                                        |
| `nightlyTasks.removeStaleUploads`  | `true`              | Runs the cleanup nightly: an expired upload whose file is complete and valid is kept, anything else is deleted and its quota returned.                                                                                                             |

Set these through `PUT /api/system-config` or the config file. The web admin page has no fields for them. To run the cleanup now: `POST /api/jobs` with `{"name": "upload-cleanup"}`.

## Behaviour to know

- Unfinished uploads are `partial` assets. They have `hidden` visibility, so they stay out of the timeline and default search. Sync, background jobs, `bulk-upload-check` and the `x-immich-checksum` pre-check filter them out by status.
- A stock `POST /api/assets` of the same file replaces a `partial` asset.
- Generic asset routes (`/api/assets/...`) and the integrity checker don't see unfinished uploads, so they can't be trashed, restored, edited or downloaded by id.
- A stock `POST /api/assets` that collides with an unfinished upload it can't replace gets `503` and retries later. It never gets "duplicate" for a file that isn't stored yet.
- Requests writing to one upload exclude each other, and the cleanup job, cancel and stock replacement, through a claim on the upload's `asset_upload` row. A writer that stops refreshing it for 30 seconds loses it.
- Migrations: `1793825597040-AddPartialAssetStatus` and `1793826084186-AddAssetUploadTable`. Both are reversible; to go back to a stock image, follow [rollback-to-stock.md](rollback-to-stock.md).
- Server image: `ghcr.io/guysinc-home/immich-server`, built by `.github/workflows/fork-server-image.yml` on tags like `v3.4.0-photos.1`.
