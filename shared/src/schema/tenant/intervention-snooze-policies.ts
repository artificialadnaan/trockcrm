import { integer, pgTable, timestamp, uuid, varchar, uniqueIndex } from "drizzle-orm/pg-core";
import { offices } from "../public/offices.js";

export const interventionSnoozePolicies = pgTable(
  "intervention_snooze_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id").references(() => offices.id).notNull(),
    snoozeReasonKey: varchar("snooze_reason_key", { length: 120 }).notNull(),
    maxSnoozeDays: integer("max_snooze_days").notNull(),
    breachReviewThresholdPercent: integer("breach_review_threshold_percent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("intervention_snooze_policies_office_reason_uidx").on(table.officeId, table.snoozeReasonKey),
  ]
);
