import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getPipelineVelocityReport, type SalesReportFilters } from "../../../src/modules/reports/sales-tier1-service.js";

/**
 * REAL-SQL (PGlite) proof that Pipeline Velocity's stage age is HOLD-AWARE (Wave-0 PR-B / CC3):
 * days-in-stage uses aliasedEffectiveStageAgeDaysSql, not raw NOW()-stage_entered_at. A deal that sat
 * 40 wall-clock days in stage but spent 35 of them on hold (now resumed) has an EFFECTIVE age of ~5
 * days, so it is NOT counted as "stuck" (>30d) and does not inflate the aging stats.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const ST_OPEN = U("57002");
const REP = U("a01");
const D = { clean: U("d01"), resumed: U("d02") };
// Wide window so both deals' created_at qualify; the hold-aware age is measured off now().
const FILTERS: SalesReportFilters = {
  dateFrom: "2000-01-01",
  dateTo: "2100-01-01",
  ownerIds: [],
  ownerNames: [],
  ownerEmails: [],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text, display_order int);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text, email text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid, name text, stage_id uuid NOT NULL, assigned_rep_id uuid,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      created_at timestamptz, stage_entered_at timestamptz,
      on_hold boolean NOT NULL DEFAULT false, expected_close_date date, on_hold_started_at timestamptz,
      on_hold_accumulated_seconds numeric, on_hold_accumulated_seconds_at_stage_entry numeric,
      is_bid_board_owned boolean NOT NULL DEFAULT false, bid_board_stage_entered_at timestamptz,
      forecast_revenue numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric, awarded_amount numeric
    );
    INSERT INTO users (id, display_name) VALUES ('${REP}','Alice');
    INSERT INTO pipeline_stage_config (id, slug, name, display_order) VALUES ('${ST_OPEN}','opportunity','Opportunity', 30);

    -- clean: 40 wall-clock days in stage, never on hold -> effective ~40 -> STUCK (>30)
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, created_at, stage_entered_at, bid_estimate) VALUES
      ('${D.clean}', 'Clean 40d', '${ST_OPEN}', '${REP}', now() - INTERVAL '50 days', now() - INTERVAL '40 days', 100000);
    -- resumed: 40 wall-clock days, 35 of them on hold (now resumed) -> effective ~5 -> NOT stuck
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, created_at, stage_entered_at, on_hold, on_hold_accumulated_seconds, on_hold_accumulated_seconds_at_stage_entry, bid_estimate) VALUES
      ('${D.resumed}', 'Resumed', '${ST_OPEN}', '${REP}', now() - INTERVAL '50 days', now() - INTERVAL '40 days', false, ${35 * 86400}, 0, 50000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("Pipeline Velocity — hold-aware stage age (CC3)", () => {
  it("does not flag a resumed (mostly-on-hold) deal as stuck", async () => {
    const report = await getPipelineVelocityReport(tdb, FILTERS, "holdage-test");
    const stuckIds = report.stuckDeals.map((d) => d.dealId);
    expect(stuckIds).toContain(D.clean);
    expect(stuckIds).not.toContain(D.resumed);
    expect(report.kpis.stuckDealCount).toBe(1);
    // The clean deal's displayed age is its full ~40 days; the resumed deal's effective age (~5d) keeps
    // it out of the 60+/stuck reckoning even though its wall-clock age is also 40 days.
    expect(report.stuckDeals.find((d) => d.dealId === D.clean)!.daysInStage).toBeGreaterThanOrEqual(39);
  });
});
