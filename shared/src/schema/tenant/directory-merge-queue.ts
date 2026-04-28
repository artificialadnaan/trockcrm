import {
  pgEnum,
  pgTable,
  uuid,
  varchar,
  numeric,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const directoryEntityTypeEnum = pgEnum("directory_entity_type", ["company", "contact"]);
export const directoryMergeStatusEnum = pgEnum("directory_merge_status", ["pending", "auto_merged", "merged", "dismissed"]);

export const directoryMergeQueue = pgTable(
  "directory_merge_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: directoryEntityTypeEnum("entity_type").notNull(),
    entityAId: uuid("entity_a_id").notNull(),
    entityBId: uuid("entity_b_id").notNull(),
    confidenceScore: numeric("confidence_score", { precision: 4, scale: 3 }).notNull(),
    matchReasons: jsonb("match_reasons").$type<string[]>().default([]).notNull(),
    status: directoryMergeStatusEnum("status").default("pending").notNull(),
    resolvedBy: uuid("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("directory_merge_queue_pair_uidx").on(table.entityType, table.entityAId, table.entityBId),
    index("directory_merge_queue_status_idx").on(table.status, table.entityType),
  ]
);

export const directoryMergeAudit = pgTable(
  "directory_merge_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    queueEntryId: uuid("queue_entry_id"),
    entityType: directoryEntityTypeEnum("entity_type").notNull(),
    winnerId: uuid("winner_id").notNull(),
    loserId: uuid("loser_id").notNull(),
    confidenceScore: numeric("confidence_score", { precision: 4, scale: 3 }).notNull(),
    matchReasons: jsonb("match_reasons").$type<string[]>().default([]).notNull(),
    mode: varchar("mode", { length: 32 }).notNull(),
    mergedBy: uuid("merged_by"),
    fieldChanges: jsonb("field_changes").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("directory_merge_audit_entity_idx").on(table.entityType, table.createdAt)]
);
