import {
  pgTable,
  pgEnum,
  uuid,
  jsonb,
  text,
  boolean,
  timestamp,
  index,
  integer,
} from "drizzle-orm/pg-core";
import { savedReports } from "./saved-reports.js";
import { users } from "./users.js";

export const reportFrequencyEnum = pgEnum("report_frequency", [
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
]);

export const reportSchedules = pgTable(
  "report_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id").notNull().references(() => savedReports.id, { onDelete: "cascade" }),
    frequency: reportFrequencyEnum("frequency").notNull(),
    cronExpr: text("cron_expr").notNull(),
    recipients: jsonb("recipients").default([]).notNull(),
    anchorDay: integer("anchor_day"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    ownerId: uuid("owner_id").notNull().references(() => users.id),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("report_schedules_report_idx").on(table.reportId),
    index("report_schedules_owner_idx").on(table.ownerId),
    index("report_schedules_due_idx").on(table.isActive, table.nextRunAt),
  ]
);
