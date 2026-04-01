import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  bigint,
  jsonb,
  text,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { offices } from "./offices.js";
import { PROCORE_ENTITY_TYPES, SYNC_DIRECTIONS, SYNC_STATUSES } from "../../types/enums.js";

export const procoreEntityTypeEnum = pgEnum("procore_entity_type", PROCORE_ENTITY_TYPES);
export const syncDirectionEnum = pgEnum("sync_direction", SYNC_DIRECTIONS);
export const syncStatusEnum = pgEnum("sync_status", SYNC_STATUSES);

export const procoreSyncState = pgTable(
  "procore_sync_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: procoreEntityTypeEnum("entity_type").notNull(),
    procoreId: bigint("procore_id", { mode: "number" }).notNull(),
    crmEntityType: varchar("crm_entity_type", { length: 50 }).notNull(),
    crmEntityId: uuid("crm_entity_id").notNull(),
    officeId: uuid("office_id")
      .references(() => offices.id)
      .notNull(),
    syncDirection: syncDirectionEnum("sync_direction").notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastProcoreUpdatedAt: timestamp("last_procore_updated_at", { withTimezone: true }),
    lastCrmUpdatedAt: timestamp("last_crm_updated_at", { withTimezone: true }),
    syncStatus: syncStatusEnum("sync_status").default("synced").notNull(),
    conflictData: jsonb("conflict_data"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique().on(table.entityType, table.procoreId, table.officeId),
    index("procore_sync_out_of_sync_idx")
      .on(table.syncStatus)
      .where(sql`sync_status != 'synced'`),
  ]
);
