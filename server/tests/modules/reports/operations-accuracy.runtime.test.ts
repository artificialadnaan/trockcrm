import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  getWorkflowBottlenecksReport,
  getPortfolioLoadReport,
  getProjectReadinessReport,
  clearOperationsReportsCache,
} from "../../../src/modules/reports/operations-tier3-service.js";

/**
 * REAL-SQL (PGlite) proof for Wave-0 PR-B (CC3 + CC5) on the operations-tier3 reports.
 *
 * CC3 — stage age is HOLD-AWARE (aliasedEffectiveStageAgeDaysSql), not raw NOW()-stage_entered_at.
 *       A deal that sat 40 wall-clock days in stage but spent 35 of them on hold (now resumed) has an
 *       EFFECTIVE age of ~5 days, so it is NOT "stuck" (>=30d) and does not inflate the aging stats.
 *       (Currently-on-hold deals are already excluded by the reportable filter; the bug is COMPLETED
 *       hold time wrongly counted in a resumed deal's age.)
 * CC5 — the shared baseOpenDealWhere excludes test data (COALESCE(is_test_data,false)=false), so test
 *       deals no longer leak into any operations report.
 *
 * Also executes all three reports end-to-end so a bad column/helper reference fails CI (the #621 lane).
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const ST_OPEN = U("57002");
const REP = U("a01");
const CO_A = U("c0a");
const CO_B = U("c0b");
const D = { clean: U("d01"), resumed: U("d02"), test: U("d03") };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  clearOperationsReportsCache();
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, name text, slug text UNIQUE NOT NULL, is_terminal boolean NOT NULL DEFAULT false, display_order int);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE offices (id uuid PRIMARY KEY, slug text, name text);
    CREATE TABLE companies (id uuid PRIMARY KEY, name text, city text, state text, region text, last_activity_at timestamptz);
    CREATE TABLE properties (id uuid PRIMARY KEY, name text, city text, state text, last_activity_at timestamptz);
    CREATE TABLE deal_scoping_intake (deal_id uuid, status text, completion_state jsonb, readiness_errors jsonb);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid, name text, stage_id uuid NOT NULL, assigned_rep_id uuid,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false, expected_close_date date, bid_due_date timestamptz, on_hold_started_at timestamptz,
      on_hold_accumulated_seconds numeric, on_hold_accumulated_seconds_at_stage_entry numeric,
      is_bid_board_owned boolean NOT NULL DEFAULT false, bid_board_stage_entered_at timestamptz,
      stage_entered_at timestamptz, last_activity_at timestamptz, project_number text,
      office_code text, company_id uuid, property_id uuid, property_address text,
      property_city text, property_state text, region_classification text, updated_at timestamptz,
      proposal_status text, proposal_sent_at timestamptz, proposal_accepted_at timestamptz,
      contract_signed_date date, contract_signed_at timestamptz, bid_board_assigned_pm text,
      next_milestone_at timestamptz,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric, forecast_revenue numeric
    );
    INSERT INTO users (id, display_name) VALUES ('${REP}','Alice');
    INSERT INTO pipeline_stage_config (id, name, slug, is_terminal, display_order) VALUES ('${ST_OPEN}','Opportunity','opportunity', false, 30);
    INSERT INTO companies (id, name) VALUES ('${CO_A}','Company A'), ('${CO_B}','Company B');

    -- clean: 40 wall-clock days in stage, never on hold -> effective ~40 -> STUCK
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, company_id, stage_entered_at, bid_estimate, updated_at) VALUES
      ('${D.clean}', 'Clean 40d', '${ST_OPEN}', '${REP}', '${CO_A}', now() - INTERVAL '40 days', 100000, now());
    -- resumed: 40 wall-clock days, but 35 days were on hold (now resumed) -> effective ~5 -> NOT stuck
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, company_id, stage_entered_at, on_hold, on_hold_accumulated_seconds, on_hold_accumulated_seconds_at_stage_entry, bid_estimate, updated_at) VALUES
      ('${D.resumed}', 'Resumed', '${ST_OPEN}', '${REP}', '${CO_A}', now() - INTERVAL '40 days', false, ${35 * 86400}, 0, 50000, now());
    -- test data: 40 days, would be stuck, but must be excluded everywhere (CC5)
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, company_id, is_test_data, stage_entered_at, bid_estimate, updated_at) VALUES
      ('${D.test}', 'Test Deal', '${ST_OPEN}', '${REP}', '${CO_B}', true, now() - INTERVAL '40 days', 999000, now());
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("Workflow Bottlenecks — hold-aware stage age (CC3) + test-data exclusion (CC5)", () => {
  it("a resumed deal's on-hold time is not counted as stuck, and test data is excluded", async () => {
    const report = await getWorkflowBottlenecksReport(tdb, {});
    const stage = report.stageAging.find((s) => s.stageName === "Opportunity");
    expect(stage).toBeDefined();
    // CC5: test deal excluded -> only clean + resumed are open.
    expect(stage?.openDealCount).toBe(2);
    // CC3: only the clean 40-day deal is stuck; the resumed deal's effective age (~5d) is < 30.
    expect(stage?.stuckDealCount).toBe(1);
    expect(report.kpis.totalStuckDeals).toBe(1);
    // The stuck list contains the clean deal only — not the resumed deal, not the test deal.
    const stuckIds = report.topStuckDeals.map((d) => d.dealId);
    expect(stuckIds).toContain(D.clean);
    expect(stuckIds).not.toContain(D.resumed);
    expect(stuckIds).not.toContain(D.test);
    // The clean deal's displayed age is its full ~40 days (no hold subtracted).
    expect(report.topStuckDeals.find((d) => d.dealId === D.clean)!.daysInStage).toBeGreaterThanOrEqual(39);
  });
});

describe("Portfolio Load — test-data exclusion (CC5)", () => {
  it("excludes test deals from active companies and totals", async () => {
    const report = await getPortfolioLoadReport(tdb, {});
    // Company B exists only via the test deal -> excluded. Only Company A remains.
    expect(report.kpis.activeCompanies).toBe(1);
    // Open value = clean (100k) + resumed (50k); the 999k test deal is excluded.
    expect(report.kpis.totalActiveValue).toBeCloseTo(150000, 2);
    expect(report.companyBreakdown.map((c) => c.companyName)).not.toContain("Company B");
  });
});

describe("Project Readiness — runs end-to-end and excludes test data (CC5)", () => {
  it("does not include the test deal in the missing-readiness list", async () => {
    const report = await getProjectReadinessReport(tdb, {});
    const ids = report.missingReadiness.map((d) => d.dealId);
    expect(ids).not.toContain(D.test);
    // clean + resumed are the only active deals considered.
    expect(ids).toContain(D.clean);
    expect(ids).toContain(D.resumed);
  });
});
