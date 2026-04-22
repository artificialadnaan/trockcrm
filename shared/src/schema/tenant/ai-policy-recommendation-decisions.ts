import { boolean, integer, jsonb, pgTable, timestamp, uuid, varchar, index } from "drizzle-orm/pg-core";
import { offices } from "../public/offices.js";

export const aiPolicyRecommendationDecisions = pgTable(
  "ai_policy_recommendation_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id").references(() => offices.id).notNull(),
    snapshotId: uuid("snapshot_id").notNull(),
    recommendationId: uuid("recommendation_id"),
    taxonomy: varchar("taxonomy", { length: 48 }).notNull(),
    groupingKey: varchar("grouping_key", { length: 120 }).notNull(),
    decision: varchar("decision", { length: 40 }).notNull(),
    suppressionReason: varchar("suppression_reason", { length: 40 }),
    score: integer("score"),
    impactScore: integer("impact_score"),
    volumeScore: integer("volume_score"),
    persistenceScore: integer("persistence_score"),
    actionabilityScore: integer("actionability_score"),
    confidence: varchar("confidence", { length: 16 }),
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
    renderedAt: timestamp("rendered_at", { withTimezone: true }),
    usedFallbackCopy: boolean("used_fallback_copy").notNull().default(false),
    usedFallbackStructuredPayload: boolean("used_fallback_structured_payload").notNull().default(false),
    metricsJson: jsonb("metrics_json").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("ai_policy_recommendation_decisions_snapshot_idx").on(table.officeId, table.snapshotId, table.createdAt),
    index("ai_policy_recommendation_decisions_recommendation_idx").on(table.officeId, table.recommendationId, table.createdAt),
  ]
);
