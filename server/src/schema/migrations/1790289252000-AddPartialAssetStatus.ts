import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TYPE "assets_status_enum" ADD VALUE IF NOT EXISTS 'partial'`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    UPDATE "user"
    SET "quotaUsageInBytes" = "quotaUsageInBytes" - partial."reserved"
    FROM (
      SELECT "asset"."ownerId", sum(coalesce("asset_exif"."fileSizeInByte", 0)) AS "reserved"
      FROM "asset"
      LEFT JOIN "asset_exif" ON "asset_exif"."assetId" = "asset"."id"
      WHERE "asset"."status" = 'partial'
      GROUP BY "asset"."ownerId"
    ) AS partial
    WHERE "user"."id" = partial."ownerId"
  `.execute(db);
  await sql`DELETE FROM "asset" WHERE "status" = 'partial'`.execute(db);
  await sql`ALTER TYPE "assets_status_enum" RENAME TO "assets_status_enum_old"`.execute(db);
  await sql`CREATE TYPE "assets_status_enum" AS ENUM ('active', 'trashed', 'deleted')`.execute(db);
  await sql`ALTER TABLE "asset" ALTER COLUMN "status" DROP DEFAULT`.execute(db);
  await sql`ALTER TABLE "asset" ALTER COLUMN "status" TYPE "assets_status_enum" USING "status"::text::"assets_status_enum"`.execute(
    db,
  );
  await sql`ALTER TABLE "asset" ALTER COLUMN "status" SET DEFAULT 'active'`.execute(db);
  await sql`DROP TYPE "assets_status_enum_old"`.execute(db);
}
