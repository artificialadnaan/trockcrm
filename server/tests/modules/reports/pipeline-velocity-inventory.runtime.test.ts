import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getPipelineVelocityReport, type SalesReportFilters } from "../../../src/modules/reports/sales-tier1-service.js";

/**
 * REAL-SQL (PGlite) proof for Wave-1 PR-D: Pipeline Velocity reports CURRENT open inventory, not deals
 * created within the date window. A deal created long ago (outside the selected range) but still open
 * today MUST appear in the stage-aging / stuck views — the old `buildDealFilterSql(filters,"created_at")`
 * windowed on created_at and silently dropped old-but-stuck inventory (the velocity report's whole point
 * is current pipeline aged by stage). (Hold-aware days-in-stage already shipped in PR-B #639.)
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const ST_OPEN = U("57002");
const REP = U("a01");
const D = { old: U("d01"), recent: U("d02") };
const FILTERS: SalesReportFilters = {
  dateFrom: "2026-01-01",
  dateTo: "2026-12-31",
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
      on_hold boolean NOT NULL DEFAULT false, expected_close_date date, bid_due_date timestamptz, on_hold_started_at timestamptz,
      on_hold_accumulated_seconds numeric, on_hold_accumulated_seconds_at_stage_entry numeric,
      is_bid_board_owned boolean NOT NULL DEFAULT false, bid_board_stage_entered_at timestamptz,
      forecast_revenue numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric, awarded_amount numeric
    );
    INSERT INTO users (id, display_name) VALUES ('${REP}','Alice');
    INSERT INTO pipeline_stage_config (id, slug, name, display_order) VALUES ('${ST_OPEN}','opportunity','Opportunity', 30);

    -- created 2 years before the date window, but still OPEN and stuck (entered stage 40 days ago).
    -- Old created_at window dropped it; current-inventory must include it.
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, created_at, stage_entered_at, bid_estimate) VALUES
      ('${D.old}', 'Old but open', '${ST_OPEN}', '${REP}', '2024-06-01', now() - INTERVAL '40 days', 100000);
    -- created inside the window, recent (control).
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, created_at, stage_entered_at, bid_estimate) VALUES
      ('${D.recent}', 'Recent', '${ST_OPEN}', '${REP}', '2026-03-01', now() - INTERVAL '10 days', 50000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("Pipeline Velocity reports current open inventory, not created-in-window deals (PR-D)", () => {
  it("includes an old-created but still-open deal in the open count and stuck list", async () => {
    const report = await getPipelineVelocityReport(tdb, FILTERS, "inventory-test");
    // Both open deals are counted regardless of created_at — the old one is no longer dropped.
    expect(report.kpis.openDealCount).toBe(2);
    // The old deal (40d in stage) is stuck (>30d); the recent one (10d) is not.
    const stuckIds = report.stuckDeals.map((d) => d.dealId);
    expect(stuckIds).toContain(D.old);
    expect(stuckIds).not.toContain(D.recent);
    expect(report.stuckDeals.find((d) => d.dealId === D.old)!.daysInStage).toBeGreaterThanOrEqual(39);
  });
});
