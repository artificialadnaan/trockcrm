import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_TYPES } from "../../../../shared/src/types/enums.js";
import {
  aiManagerAlertSendLedger,
  aiManagerAlertSnapshotModeEnum,
  aiManagerAlertSnapshots,
  notificationTypeEnum,
} from "../../../../shared/src/schema/index.js";

const migrationSql = readFileSync(
  new URL("../../../../migrations/0029_ai_manager_alerts.sql", import.meta.url),
  "utf8"
);

describe("manager alert schema contract", () => {
  it("adds the manager alert summary notification type", () => {
    expect(NOTIFICATION_TYPES).toContain("manager_alert_summary");
  });

  it("defines one snapshot row per office and snapshot kind", () => {
    const columns = getTableColumns(aiManagerAlertSnapshots);
    const config = getTableConfig(aiManagerAlertSnapshots);

    expect(columns.officeId.notNull).toBe(true);
    expect(columns.snapshotKind.notNull).toBe(true);
    expect(columns.snapshotMode.notNull).toBe(true);
    expect(columns.snapshotMode.hasDefault).toBe(true);
    expect(columns.snapshotMode.default).toBe("preview");
    expect(aiManagerAlertSnapshotModeEnum.enumValues).toEqual(["preview", "sent"]);
    expect(columns.snapshotJson.notNull).toBe(true);
    expect(columns.snapshotJson.hasDefault).toBe(true);
    expect(columns.snapshotJson.default).toEqual({});
    expect(columns.scannedAt.notNull).toBe(true);
    expect(columns.scannedAt.hasDefault).toBe(true);
    expect(columns.sentAt.notNull).toBe(false);
    expect(config.indexes.map((index) => ({ name: index.config.name, columns: index.config.columns.map((column) => column.name) }))).toEqual([
      {
        name: "ai_manager_alert_snapshots_office_id_snapshot_kind_uidx",
        columns: ["office_id", "snapshot_kind"],
      },
    ]);
  });

  it("defines a send ledger dedupe key for one send per office local day", () => {
    const columns = getTableColumns(aiManagerAlertSendLedger);
    const config = getTableConfig(aiManagerAlertSendLedger);

    expect(columns.officeId.notNull).toBe(true);
    expect(columns.recipientUserId.notNull).toBe(true);
    expect(columns.summaryType.notNull).toBe(true);
    expect(columns.summaryType.enumValues).toEqual(notificationTypeEnum.enumValues);
    expect(NOTIFICATION_TYPES).toContain("manager_alert_summary");
    expect(columns.officeLocalDate.notNull).toBe(true);
    expect(columns.claimedAt.notNull).toBe(true);
    expect(columns.claimedAt.hasDefault).toBe(true);
    expect(config.indexes.map((index) => ({ name: index.config.name, columns: index.config.columns.map((column) => column.name) }))).toEqual([
      {
        name: "ai_manager_alert_send_ledger_office_id_recipient_user_id_summary_type_office_local_date_uidx",
        columns: ["office_id", "recipient_user_id", "summary_type", "office_local_date"],
      },
    ]);
  });

  it("creates the manager alert tables inside the tenant schema loop", () => {
    expect(migrationSql).toContain("ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'manager_alert_summary'");
    expect(migrationSql).toContain("DO $tenant$");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_END");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS ai_manager_alert_snapshots");
    expect(migrationSql).toContain("snapshot_mode ai_manager_alert_snapshot_mode NOT NULL DEFAULT 'preview'");
    expect(migrationSql).toContain("scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
    expect(migrationSql).toContain("sent_at TIMESTAMPTZ");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS ai_manager_alert_send_ledger");
    expect(migrationSql).toContain("summary_type notification_type NOT NULL");
    expect(migrationSql).toContain("claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
    expect(migrationSql).toContain("FOR schema_name IN");
    expect(migrationSql).toContain("WHERE nspname LIKE 'office\\_%' ESCAPE '\\'");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS %I.ai_manager_alert_snapshots");
    expect(migrationSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS ai_manager_alert_snapshots_office_id_snapshot_kind_uidx");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS %I.ai_manager_alert_send_ledger");
    expect(migrationSql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS ai_manager_alert_send_ledger_office_id_recipient_user_id_summary_type_office_local_date_uidx"
    );
  });
});
