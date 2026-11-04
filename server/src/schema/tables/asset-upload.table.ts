import { Column, ForeignKeyColumn, Table, Timestamp } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

@Table('asset_upload')
export class AssetUploadTable {
  @ForeignKeyColumn(() => AssetTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: false })
  assetId!: string;

  @Column({ type: 'uuid', nullable: true })
  sessionId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  apiKeyId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  sharedLinkId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  writerId!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  writerHeartbeatAt!: Timestamp | null;
}
