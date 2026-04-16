import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  numeric,
  index,
} from "drizzle-orm/pg-core";

export const aiCopilotPackets = pgTable(
  "ai_copilot_packets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeType: varchar("scope_type", { length: 32 }).notNull(),
    scopeId: uuid("scope_id").notNull(),
    dealId: uuid("deal_id"),
    packetKind: varchar("packet_kind", { length: 32 }).notNull(),
    snapshotHash: varchar("snapshot_hash", { length: 128 }).notNull(),
    modelName: varchar("model_name", { length: 100 }),
    status: varchar("status", { length: 32 }).default("pending").notNull(),
    summaryText: text("summary_text"),
    nextStepJson: jsonb("next_step_json"),
    blindSpotsJson: jsonb("blind_spots_json"),
    evidenceJson: jsonb("evidence_json"),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("ai_copilot_packets_scope_idx").on(table.scopeType, table.scopeId, table.status),
    index("ai_copilot_packets_deal_idx").on(table.dealId, table.generatedAt),
  ]
);
