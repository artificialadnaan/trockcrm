import { jsonb, pgTable, timestamp, uuid, varchar, integer, index } from "drizzle-orm/pg-core";
import { offices } from "../public/offices.js";
import { aiPolicyRecommendationSnapshots } from "./ai-policy-recommendation-snapshots.js";

export const aiPolicyRecommendationRows = pgTable(
  "ai_policy_recommendation_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id")
      .references(() => aiPolicyRecommendationSnapshots.id)
      .notNull(),
    officeId: uuid("office_id").references(() => offices.id).notNull(),
    recommendationId: uuid("recommendation_id").notNull(),
    taxonomy: varchar("taxonomy", { length: 48 }).notNull(),
    primaryGroupingKey: varchar("primary_grouping_key", { length: 120 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    statement: varchar("statement", { length: 500 }).notNull(),
    whyNow: varchar("why_now", { length: 500 }).notNull(),
    expectedImpact: varchar("expected_impact", { length: 500 }).notNull(),
    confidence: varchar("confidence", { length: 16 }).notNull(),
    priority: integer("priority").notNull(),
    suggestedAction: varchar("suggested_action", { length: 500 }).notNull(),
    counterSignal: varchar("counter_signal", { length: 500 }),
    renderStatus: varchar("render_status", { length: 24 }).notNull().default("active"),
    evidenceJson: jsonb("evidence_json").default([]).notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
    staleAt: timestamp("stale_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("ai_policy_recommendation_rows_snapshot_idx").on(table.snapshotId, table.priority),
    index("ai_policy_recommendation_rows_recommendation_id_idx").on(table.officeId, table.recommendationId),
  ]
);
