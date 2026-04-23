import { jsonb, pgTable, timestamp, uuid, varchar, index, uniqueIndex } from "drizzle-orm/pg-core";
import { offices } from "../public/offices.js";
import { users } from "../public/users.js";

export const aiPolicyRecommendationApplyEvents = pgTable(
  "ai_policy_recommendation_apply_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id").references(() => offices.id).notNull(),
    recommendationId: uuid("recommendation_id").notNull(),
    snapshotId: uuid("snapshot_id").notNull(),
    taxonomy: varchar("taxonomy", { length: 48 }).notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id).notNull(),
    requestIdempotencyKey: varchar("request_idempotency_key", { length: 120 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    targetType: varchar("target_type", { length: 48 }).notNull(),
    targetId: varchar("target_id", { length: 120 }).notNull(),
    beforeStateJson: jsonb("before_state_json").notNull().default({}),
    proposedStateJson: jsonb("proposed_state_json").notNull().default({}),
    appliedStateJson: jsonb("applied_state_json").notNull().default({}),
    rejectionReason: varchar("rejection_reason", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("ai_policy_recommendation_apply_events_recommendation_idx").on(table.officeId, table.recommendationId, table.createdAt),
    index("ai_policy_recommendation_apply_events_idempotency_idx").on(
      table.officeId,
      table.recommendationId,
      table.requestIdempotencyKey
    ),
    uniqueIndex("ai_policy_recommendation_apply_events_idempotency_uidx").on(
      table.officeId,
      table.recommendationId,
      table.requestIdempotencyKey
    ),
  ]
);
