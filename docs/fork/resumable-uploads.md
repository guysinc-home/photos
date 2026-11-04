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

- `409`: wrong offset. `Upload-Offset` gives the right one.
- `400`: the upload is already complete, the lengths are inconsistent, or the quota would be exceeded. Quota is reserved from `Upload-Length` when the upload starts.
- `460`: the SHA‑1 doesn't match; the upload is deleted.
- `500` on `POST`: a resumable client re-sent a file that has an unfinished upload. Use `HEAD` and resume.
- `404`: the upload is unknown or belongs to someone else.

Auth: a session, an API key with `asset.upload`, or a shared link with uploads allowed.

## Settings

| Key                                | Default             | Effect                                                                                                                                                                      |
| ---------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup.upload.maxAppendSizeBytes` | `94371840` (90 MiB) | Sent as `max-append-size` in `Upload-Limit`. `0` sends none. Advertised only, not enforced, because the proxy enforces the real cap. Keep it below your proxy's body limit. |
| `backup.upload.maxAgeHours`        | `72`                | Unfinished uploads older than this are cleaned up. Also sent as `max-age`.                                                                                                  |
| `nightlyTasks.removeStaleUploads`  | `true`              | Runs that cleanup nightly: a complete, valid file is kept; anything else is deleted and its quota returned.                                                                 |

Set these through `PUT /api/system-config` or the config file. The web admin page has no fields for them.

## Behaviour to know

- Unfinished uploads are `partial` assets. They have `hidden` visibility, so they stay out of the timeline and default search. Sync, background jobs, `bulk-upload-check` and the `x-immich-checksum` pre-check filter them out by status.
- A stock `POST /api/assets` of the same file replaces a `partial` asset.
- Rolling back the migration deletes `partial` rows and leaves their files in `upload/`, where the integrity check reports them as untracked.
- Server image: `ghcr.io/guysinc-home/immich-server`, built by `.github/workflows/fork-server-image.yml` on tags like `v3.4.0-photos.1`.
