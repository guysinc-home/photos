# Runbook: roll back from the fork image to a stock Immich image

Use this to go back from `ghcr.io/guysinc-home/immich-server` to the stock `ghcr.io/immich-app/immich-server` image. The fork adds two migrations that stock Immich doesn't have:

- `1793825597040-AddPartialAssetStatus` adds `partial` to `assets_status_enum`.
- `1793826084186-AddAssetUploadTable` adds the `asset_upload` table.

## What fails if you just swap the image

The stock server refuses to start:

```
Migration "1793825597040-AddPartialAssetStatus" was already applied to this database but is not in this version of Immich (…).
This usually means the database was migrated by a newer version. Downgrades are not supported.
```

Nothing is changed by that failure. Put the fork image back, or follow the steps below.

Fork-only settings left in the system config (`backup.upload.*`, `nightlyTasks.removeStaleUploads`) only make stock log "Unknown keys found"; they're harmless.

## Safe order

1. **Pick the stock version the fork is based on.** It's the version on the fork image's server info page. An older stock version refuses the database for the same reason as above.
2. **Stop uploads.** Tell users, or put the server in maintenance mode, so no new resumable uploads start.
3. **Wait for background tasks to go idle** (Administration → Jobs), so no `upload-cleanup` job is queued or running. A stock server won't know that job.
4. **Back up the database** (Administration → Backups, or `pg_dump`).
5. **Stop the fork server** and the microservices worker, leaving Postgres running.
6. **Undo the fork's migrations.** Run [the SQL below](#rollback-sql) with `psql` against the Immich database. It is both migrations' `down()`, newest first, plus removing their rows from `kysely_migrations`. It runs in one transaction, so it applies completely or not at all.
7. **Start the stock image.**

### If partial rows exist

Unfinished uploads can't survive the rollback, because stock Immich has no `partial` status.

- The SQL deletes their rows and gives back the quota they reserved.
- Their files stay in `<UPLOAD_LOCATION>/upload/<user id>/…`. The integrity check reports them as untracked files, and the first `SELECT` in the SQL prints their paths, so you can delete them after the rollback.
- Clients that were part-way through those uploads upload the files again from the start.

To keep an unfinished upload, let its client finish it before step 2.

### Rollback SQL

```sql
BEGIN;

SELECT "originalPath" FROM "asset" WHERE "status" = 'partial';

DROP TABLE "asset_upload";

UPDATE "user"
SET "quotaUsageInBytes" = "quotaUsageInBytes" - partial."reserved"
FROM (
  SELECT "asset"."ownerId", sum(coalesce("asset_exif"."fileSizeInByte", 0)) AS "reserved"
  FROM "asset"
  LEFT JOIN "asset_exif" ON "asset_exif"."assetId" = "asset"."id"
  WHERE "asset"."status" = 'partial'
  GROUP BY "asset"."ownerId"
) AS partial
WHERE "user"."id" = partial."ownerId";
DELETE FROM "asset" WHERE "status" = 'partial';
ALTER TYPE "assets_status_enum" RENAME TO "assets_status_enum_old";
CREATE TYPE "assets_status_enum" AS ENUM ('active', 'trashed', 'deleted');
ALTER TABLE "asset" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "asset" ALTER COLUMN "status" TYPE "assets_status_enum" USING "status"::text::"assets_status_enum";
ALTER TABLE "asset" ALTER COLUMN "status" SET DEFAULT 'active';
DROP TYPE "assets_status_enum_old";

DELETE FROM "kysely_migrations"
WHERE "name" IN ('1793826084186-AddAssetUploadTable', '1793825597040-AddPartialAssetStatus');

COMMIT;
```

## Going forward again

Deploying the fork image later re-applies both migrations on startup; nothing else is needed.

## Tested

On a scratch database migrated by the fork, holding one finished asset and one partial upload:

- A stock-equivalent build (the fork build minus these two migrations) refused to start before the SQL and started afterwards.
- The partial row was removed and its 2000-byte reservation returned (quota 5000 → 3000).
- The fork build then re-applied both migrations.

Not tested: a real stock image (it couldn't be pulled where this was written), or a queued `upload-cleanup` job meeting a stock worker.
