import { pgTable, uuid, varchar, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { offices } from "../public/offices.js";
import { users } from "../public/users.js";

export const aiPolicyRecommendationFeedback = pgTable(
  "ai_policy_recommendation_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id").references(() => offices.id).notNull(),
    recommendationId: uuid("recommendation_id").notNull(),
    userId: uuid("user_id").references(() => users.id).notNull(),
    feedbackValue: varchar("feedback_value", { length: 24 }).notNull(),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("ai_policy_recommendation_feedback_office_id_recommendation_id_user_id_uidx").on(
      table.officeId,
      table.recommendationId,
      table.userId
    ),
    index("ai_policy_recommendation_feedback_recommendation_idx").on(
      table.officeId,
      table.recommendationId,
      table.createdAt
    ),
  ]
);
