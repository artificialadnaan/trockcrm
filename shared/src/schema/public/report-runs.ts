import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { savedReports } from "./saved-reports.js";
import { reportSchedules } from "./report-schedules.js";

export const reportRunStatusEnum = pgEnum("report_run_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "not_implemented",
]);

export const reportRuns = pgTable(
  "report_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id").notNull().references(() => savedReports.id, { onDelete: "cascade" }),
    scheduleId: uuid("schedule_id").references(() => reportSchedules.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: reportRunStatusEnum("status").default("queued").notNull(),
    resultUri: text("result_uri"),
    error: text("error"),
    runtimeMs: integer("runtime_ms"),
  },
  (table) => [
    index("report_runs_report_idx").on(table.reportId),
    index("report_runs_schedule_idx").on(table.scheduleId),
    index("report_runs_status_idx").on(table.status, table.startedAt),
  ]
);
