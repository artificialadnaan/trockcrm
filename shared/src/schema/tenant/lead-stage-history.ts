import {
  pgTable,
  uuid,
  boolean,
  interval,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { users } from "../public/users.js";
import { leads } from "./leads.js";

export const leadStageHistory = pgTable(
  "lead_stage_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id").references(() => leads.id).notNull(),
    fromStageId: uuid("from_stage_id"),
    toStageId: uuid("to_stage_id").notNull(),
    changedBy: uuid("changed_by").references(() => users.id).notNull(),
    isBackwardMove: boolean("is_backward_move").default(false).notNull(),
    durationInPreviousStage: interval("duration_in_previous_stage"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("lead_stage_history_lead_id_idx").on(table.leadId, table.createdAt),
  ]
);
