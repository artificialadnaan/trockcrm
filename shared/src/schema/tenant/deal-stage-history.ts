import { pgTable, uuid, boolean, text, interval, timestamp } from "drizzle-orm/pg-core";

export const dealStageHistory = pgTable("deal_stage_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull(),
  fromStageId: uuid("from_stage_id"),
  toStageId: uuid("to_stage_id").notNull(),
  /**
   * The SESSION actor, or null when none was identified.
   *
   * Nullable since 0207. The 0143 backstop used to fall back to the deal's assigned rep because this was
   * NOT NULL, which made every script/sync/raw-SQL stage write read as that rep's own action — misdirecting
   * two investigations and inflating usage-rollup's active-user counts. Null means "no actor identified".
   */
  changedBy: uuid("changed_by"),
  isBackwardMove: boolean("is_backward_move").default(false).notNull(),
  isDirectorOverride: boolean("is_director_override").default(false).notNull(),
  overrideReason: text("override_reason"),
  durationInPreviousStage: interval("duration_in_previous_stage"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
