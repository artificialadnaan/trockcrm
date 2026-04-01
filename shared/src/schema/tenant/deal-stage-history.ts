import { pgTable, uuid, boolean, text, interval, timestamp } from "drizzle-orm/pg-core";

export const dealStageHistory = pgTable("deal_stage_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull(),
  fromStageId: uuid("from_stage_id"),
  toStageId: uuid("to_stage_id").notNull(),
  changedBy: uuid("changed_by").notNull(),
  isBackwardMove: boolean("is_backward_move").default(false).notNull(),
  isDirectorOverride: boolean("is_director_override").default(false).notNull(),
  overrideReason: text("override_reason"),
  durationInPreviousStage: interval("duration_in_previous_stage"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
