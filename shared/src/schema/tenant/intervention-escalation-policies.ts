import { integer, pgTable, timestamp, uuid, varchar, uniqueIndex } from "drizzle-orm/pg-core";
import { offices } from "../public/offices.js";

export const interventionEscalationPolicies = pgTable(
  "intervention_escalation_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id").references(() => offices.id).notNull(),
    disconnectTypeKey: varchar("disconnect_type_key", { length: 120 }).notNull(),
    routingMode: varchar("routing_mode", { length: 40 }).notNull(),
    escalationThresholdPercent: integer("escalation_threshold_percent").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("intervention_escalation_policies_office_type_uidx").on(table.officeId, table.disconnectTypeKey),
  ]
);
