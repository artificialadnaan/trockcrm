import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { offices } from "../public/offices.js";

export const aiManagerAlertSnapshotModeEnum = pgEnum("ai_manager_alert_snapshot_mode", [
  "preview",
  "sent",
]);

export const aiManagerAlertSnapshots = pgTable(
  "ai_manager_alert_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id").references(() => offices.id).notNull(),
    snapshotKind: varchar("snapshot_kind", { length: 80 }).notNull(),
    snapshotMode: aiManagerAlertSnapshotModeEnum("snapshot_mode").notNull().default("preview"),
    snapshotJson: jsonb("snapshot_json").default({}).notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("ai_manager_alert_snapshots_office_id_snapshot_kind_uidx").on(
      table.officeId,
      table.snapshotKind
    ),
  ]
);
