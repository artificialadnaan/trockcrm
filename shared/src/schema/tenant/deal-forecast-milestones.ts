import {
  pgEnum,
  pgTable,
  uuid,
  varchar,
  numeric,
  date,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { deals } from "./deals.js";

export const forecastMilestoneKeyEnum = pgEnum("forecast_milestone_key", [
  "initial",
  "qualified",
  "estimating",
  "closed_won",
]);

export const forecastMilestoneCaptureSourceEnum = pgEnum("forecast_milestone_capture_source", [
  "live",
  "audit_backfill",
]);

export const dealForecastMilestones = pgTable(
  "deal_forecast_milestones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull().references(() => deals.id),
    milestoneKey: forecastMilestoneKeyEnum("milestone_key").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
    capturedBy: uuid("captured_by"),
    assignedRepId: uuid("assigned_rep_id").notNull(),
    stageId: uuid("stage_id"),
    workflowRoute: varchar("workflow_route", { length: 32 }).notNull(),
    expectedCloseDate: date("expected_close_date"),
    ddEstimate: numeric("dd_estimate", { precision: 14, scale: 2 }),
    bidEstimate: numeric("bid_estimate", { precision: 14, scale: 2 }),
    awardedAmount: numeric("awarded_amount", { precision: 14, scale: 2 }),
    forecastAmount: numeric("forecast_amount", { precision: 14, scale: 2 }).notNull(),
    source: varchar("source", { length: 100 }),
    captureSource: forecastMilestoneCaptureSourceEnum("capture_source").default("live").notNull(),
  },
  (table) => [
    uniqueIndex("deal_forecast_milestones_deal_milestone_uidx").on(table.dealId, table.milestoneKey),
    index("deal_forecast_milestones_captured_at_idx").on(table.capturedAt),
    index("deal_forecast_milestones_stage_idx").on(table.stageId, table.capturedAt),
  ]
);
