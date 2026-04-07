import {
  pgTable,
  uuid,
  varchar,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";
import { offices } from "./offices.js";
import { users } from "./users.js";

export const procoreSyncModeEnum = pgEnum("procore_sync_mode", ["active", "dry_run", "paused"]);

export const procoreSyncControls = pgTable(
  "procore_sync_controls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id").references(() => offices.id).notNull(),
    syncMode: procoreSyncModeEnum("sync_mode").default("active").notNull(),
    crmToProcoreLocked: boolean("crm_to_procore_locked").default(false).notNull(),
    procoreToCrmLocked: boolean("procore_to_crm_locked").default(false).notNull(),
    manualOverrideRequired: boolean("manual_override_required").default(false).notNull(),
    reviewState: jsonb("review_state").default({}).notNull(),
    updatedBy: uuid("updated_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("procore_sync_controls_office_id_idx").on(table.officeId),
  ]
);
