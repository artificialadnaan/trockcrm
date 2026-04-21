import { numeric, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "../public/users.js";
import { deals, workflowRouteEnum } from "./deals.js";

export const dealRoutingHistory = pgTable("deal_routing_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").references(() => deals.id).notNull(),
  fromWorkflowRoute: workflowRouteEnum("from_workflow_route"),
  toWorkflowRoute: workflowRouteEnum("to_workflow_route").notNull(),
  valueSource: varchar("value_source", { length: 80 }).notNull(),
  triggeringValue: numeric("triggering_value", { precision: 14, scale: 2 }).notNull(),
  reason: text("reason"),
  changedBy: uuid("changed_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
