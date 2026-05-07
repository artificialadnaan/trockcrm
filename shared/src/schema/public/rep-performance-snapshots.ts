import {
  pgTable,
  pgEnum,
  uuid,
  date,
  numeric,
  integer,
  jsonb,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const perfPeriodKindEnum = pgEnum("perf_period_kind", [
  "mtd",
  "qtd",
  "ytd",
  "last_month",
  "last_quarter",
  "last_year",
  "week_8back",
]);

export const repPerformanceSnapshots = pgTable(
  "rep_performance_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repId: uuid("rep_id").references(() => users.id).notNull(),
    periodKind: perfPeriodKindEnum("period_kind").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    pipelineValue: numeric("pipeline_value", { precision: 14, scale: 2 }).default("0").notNull(),
    closedValue: numeric("closed_value", { precision: 14, scale: 2 }).default("0").notNull(),
    dealsCount: integer("deals_count").default(0).notNull(),
    winsCount: integer("wins_count").default(0).notNull(),
    lossesCount: integer("losses_count").default(0).notNull(),
    winRate: numeric("win_rate", { precision: 5, scale: 2 }).default("0").notNull(),
    avgDaysToClose: numeric("avg_days_to_close", { precision: 7, scale: 2 }).default("0").notNull(),
    atRiskCount: integer("at_risk_count").default(0).notNull(),
    activityTotal: integer("activity_total").default(0).notNull(),
    calls: integer("calls").default(0).notNull(),
    emails: integer("emails").default(0).notNull(),
    meetings: integer("meetings").default(0).notNull(),
    notes: integer("notes").default(0).notNull(),
    sparkline8w: jsonb("sparkline_8w").default([]).notNull(),
    region: text("region"),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    repPeriodIdx: index("rep_performance_snapshots_rep_period_idx").on(
      table.repId,
      table.periodKind,
      table.periodStart
    ),
  })
);
