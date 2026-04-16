import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const aiRiskFlags = pgTable(
  "ai_risk_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packetId: uuid("packet_id"),
    scopeType: varchar("scope_type", { length: 32 }).notNull(),
    scopeId: uuid("scope_id").notNull(),
    dealId: uuid("deal_id"),
    flagType: varchar("flag_type", { length: 64 }).notNull(),
    severity: varchar("severity", { length: 16 }).notNull(),
    status: varchar("status", { length: 32 }).default("open").notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    details: text("details"),
    evidenceJson: jsonb("evidence_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("ai_risk_flags_scope_idx").on(table.scopeType, table.scopeId, table.status),
    index("ai_risk_flags_deal_idx").on(table.dealId, table.severity),
  ]
);
