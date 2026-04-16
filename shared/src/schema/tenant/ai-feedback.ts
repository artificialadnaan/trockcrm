import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const aiFeedback = pgTable(
  "ai_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetType: varchar("target_type", { length: 32 }).notNull(),
    targetId: uuid("target_id").notNull(),
    userId: uuid("user_id").notNull(),
    feedbackType: varchar("feedback_type", { length: 32 }).notNull(),
    feedbackValue: varchar("feedback_value", { length: 32 }).notNull(),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("ai_feedback_target_idx").on(table.targetType, table.targetId, table.createdAt),
  ]
);
