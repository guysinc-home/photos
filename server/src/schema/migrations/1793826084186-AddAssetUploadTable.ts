import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_upload" (
  "assetId" uuid NOT NULL,
  "sessionId" uuid,
  "apiKeyId" uuid,
  "sharedLinkId" uuid,
  "writerId" uuid,
  "writerHeartbeatAt" timestamp with time zone,
  CONSTRAINT "asset_upload_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_upload_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_upload";`.execute(db);
}
