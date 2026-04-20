import { integer, pgTable, timestamp, uuid, varchar, uniqueIndex } from "drizzle-orm/pg-core";
import { offices } from "../public/offices.js";

export const interventionAssigneeBalancingPolicies = pgTable(
  "intervention_assignee_balancing_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id").references(() => offices.id).notNull(),
    balancingMode: varchar("balancing_mode", { length: 40 }).notNull(),
    overloadSharePercent: integer("overload_share_percent").notNull(),
    minHighRiskCases: integer("min_high_risk_cases").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("intervention_assignee_balancing_policies_office_uidx").on(table.officeId)]
);
