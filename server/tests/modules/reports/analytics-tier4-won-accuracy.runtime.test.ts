import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  getMarketMixReport,
  getCustomerConcentrationReport,
  getExecutiveTrendsReport,
} from "../../../src/modules/reports/analytics-tier4-service.js";
import { WON_STAGE_SLUGS, LOST_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) proof for Wave-0 PR-A (CC1 + CC4) across the three analytics-tier4 reports.
 *
 * CC1 — every WON-VALUE figure is windowed on the canonical deals.won_closed_date (+ usable-won-date
 *       guard + WON stage gate), NOT the deal's created_at. So a deal CREATED before the period but
 *       WON inside it counts; a deal CREATED inside the period but WON before it does not; a WON-stage
 *       deal with no won date never counts. Market Mix's total Won value therefore reconciles to its
 *       own quarterly panel by construction (both use the won-date cohort).
 * CC4 — the ACTIVE/open cohort excludes soft-deleted (is_active = false) deals. The WON cohort does
 *       NOT filter is_active (terminal wins get archived = is_active false; the canonical
 *       getWonCloseSummary counts them) — so archived wins stay in the Won totals. This guards the
 *       regression a naive global is_active=true would introduce.
 *
 * Reports are isolated by date window: Market Mix=2026, Customer Concentration=2030, Executive
 * Trends=2034 (gap years between hold "created-before-period" deals out of other reports' windows),
 * so each report's date filter sees only its own seeded deals.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON_SLUG = WON_STAGE_SLUGS[0];
const LOST_SLUG = LOST_STAGE_SLUGS[0];
const ST = { won: U("57001"), open: U("57002"), lost: U("57003") };
const REP_A = U("a01");
const CO = { mm: U("c0a"), cc: U("c0b"), et: U("c0c") };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE companies (id uuid PRIMARY KEY, name text, industry text, region text, last_activity_at timestamptz);
    CREATE TABLE properties (id uuid PRIMARY KEY, property_type text, type text, city text, state text);
    CREATE TABLE region_config (id uuid PRIMARY KEY, name text);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text, is_terminal boolean NOT NULL DEFAULT false, display_order int);
    CREATE TABLE activities (deal_id uuid, occurred_at timestamptz);
    CREATE TABLE deal_stage_history (deal_id uuid, from_stage_id uuid, to_stage_id uuid, created_at timestamptz);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, company_id uuid, property_id uuid, region_id uuid, assigned_rep_id uuid, estimator_user_id uuid,
      stage_id uuid NOT NULL, is_active boolean NOT NULL DEFAULT true,
      is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false,
      project_type text, property_city text, property_state text,
      won_closed_date date, actual_close_date date, lost_at timestamptz, last_activity_at timestamptz,
      updated_at timestamptz, created_at timestamptz,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric, forecast_revenue numeric
    );
    INSERT INTO users (id, display_name) VALUES ('${REP_A}','Alice');
    INSERT INTO pipeline_stage_config (id, slug, is_terminal, display_order) VALUES
      ('${ST.won}','${WON_SLUG}', true, 90),
      ('${ST.lost}','${LOST_SLUG}', true, 95),
      ('${ST.open}','opportunity', false, 30);
    INSERT INTO companies (id, name, industry) VALUES
      ('${CO.mm}','MM Co','Roofing'), ('${CO.cc}','CC Co','Roofing'), ('${CO.et}','ET Co','Roofing');

    -- ===== MARKET MIX (2026) =====
    INSERT INTO deals (id, company_id, assigned_rep_id, stage_id, is_active, project_type, won_closed_date, created_at, awarded_amount, bid_estimate) VALUES
      -- created BEFORE period, WON inside it -> counts in Won value (won-date), NOT in deal_count (created out)
      (${`'${U("d2601")}'`}, '${CO.mm}','${REP_A}','${ST.won}', true, 'Roofing', '2026-03-10', '2025-12-15T00:00:00Z', 100000, NULL),
      -- created INSIDE period, WON before it -> excluded from Won value; counts in deal_count (created in, active)
      (${`'${U("d2602")}'`}, '${CO.mm}','${REP_A}','${ST.won}', true, 'Roofing', '2025-11-01', '2026-02-01T00:00:00Z', 200000, NULL),
      -- WON stage, NO won date -> excluded from Won value (usable guard); counts in deal_count
      (${`'${U("d2603")}'`}, '${CO.mm}','${REP_A}','${ST.won}', true, 'Roofing', NULL, '2026-02-05T00:00:00Z', 50000, NULL),
      -- archived WON (is_active false) won inside period -> MUST stay in Won value; NOT in deal_count
      (${`'${U("d2604")}'`}, '${CO.mm}','${REP_A}','${ST.won}', false, 'Roofing', '2026-04-20', '2026-04-01T00:00:00Z', 70000, NULL),
      -- active open in period -> counts in deal_count, not Won
      (${`'${U("d2605")}'`}, '${CO.mm}','${REP_A}','${ST.open}', true, 'Roofing', NULL, '2026-02-10T00:00:00Z', NULL, 40000),
      -- inactive open (is_active false) -> excluded from deal_count (CC4)
      (${`'${U("d2606")}'`}, '${CO.mm}','${REP_A}','${ST.open}', false, 'Roofing', NULL, '2026-02-12T00:00:00Z', NULL, 30000);

    -- ===== CUSTOMER CONCENTRATION (2030; gap years 2029 keep "before-period" deals out of other windows) =====
    INSERT INTO deals (id, company_id, assigned_rep_id, stage_id, is_active, project_type, won_closed_date, created_at, awarded_amount, bid_estimate) VALUES
      -- active open -> makes CC Co appear (HAVING active_deals > 0)
      (${`'${U("d2701")}'`}, '${CO.cc}','${REP_A}','${ST.open}', true, 'Roofing', NULL, '2030-02-01T00:00:00Z', NULL, 80000),
      -- WON inside period, created BEFORE -> in total_won_lifetime (won-date), invisible to created_at window
      (${`'${U("d2702")}'`}, '${CO.cc}','${REP_A}','${ST.won}', true, 'Roofing', '2030-05-01', '2029-06-01T00:00:00Z', 120000, NULL),
      -- WON before period (created in period) -> NOT in total_won_lifetime
      (${`'${U("d2703")}'`}, '${CO.cc}','${REP_A}','${ST.won}', true, 'Roofing', '2029-12-01', '2030-03-01T00:00:00Z', 90000, NULL),
      -- archived WON inside period -> stays in total_won_lifetime (created mid-Jan, off the period-start boundary)
      (${`'${U("d2704")}'`}, '${CO.cc}','${REP_A}','${ST.won}', false, 'Roofing', '2030-02-01', '2030-01-15T00:00:00Z', 30000, NULL);

    -- ===== EXECUTIVE TRENDS (2034; gap years 2033 keep "before-period" deals out of other windows) =====
    INSERT INTO deals (id, company_id, assigned_rep_id, stage_id, is_active, project_type, won_closed_date, created_at, awarded_amount, bid_estimate) VALUES
      -- created BEFORE, WON inside -> in KPI Won Revenue (won-date)
      (${`'${U("d2801")}'`}, '${CO.et}','${REP_A}','${ST.won}', true, 'Roofing', '2034-03-01', '2033-12-01T00:00:00Z', 300000, NULL),
      -- created inside, WON before -> excluded from KPI Won Revenue
      (${`'${U("d2802")}'`}, '${CO.et}','${REP_A}','${ST.won}', true, 'Roofing', '2033-11-01', '2034-02-01T00:00:00Z', 400000, NULL),
      -- archived WON inside -> stays in KPI Won Revenue
      (${`'${U("d2803")}'`}, '${CO.et}','${REP_A}','${ST.won}', false, 'Roofing', '2034-02-15', '2034-01-15T00:00:00Z', 60000, NULL),
      -- active open -> in Total Pipeline KPI
      (${`'${U("d2804")}'`}, '${CO.et}','${REP_A}','${ST.open}', true, 'Roofing', NULL, '2034-02-01T00:00:00Z', NULL, 50000),
      -- inactive open -> excluded from Total Pipeline (CC4)
      (${`'${U("d2805")}'`}, '${CO.et}','${REP_A}','${ST.open}', false, 'Roofing', NULL, '2034-02-02T00:00:00Z', NULL, 20000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("Market Mix — Won value uses won_closed_date (CC1) and is_active scopes only the active cohort (CC4)", () => {
  it("total Won value is won-date-windowed, archived wins included, and reconciles to the quarterly panel", async () => {
    const report = await getMarketMixReport(tdb, { from: "2026-01-01", to: "2026-12-31" });
    // 100k (created-before/won-in) + 70k (archived, won-in). 200k won-before & 50k null-won excluded.
    expect(report.kpis.totalWonValue).toBeCloseTo(170000, 2);
    // Reconciliation: total Won value === sum of quarterly Won-by-vertical.
    const quarterlySum = report.quarterlyWonByVertical.reduce((acc, r) => acc + r.wonValue, 0);
    expect(quarterlySum).toBeCloseTo(170000, 2);
    expect(report.kpis.totalWonValue).toBeCloseTo(quarterlySum, 2);
    // Vertical mix Won value uses the same won-date cohort.
    const roofing = report.verticalMix.find((r) => r.name === "Roofing");
    expect(roofing?.wonValue).toBeCloseTo(170000, 2);
  });

  it("active deal count excludes soft-deleted and out-of-window deals (CC4)", async () => {
    const report = await getMarketMixReport(tdb, { from: "2026-01-01", to: "2026-12-31" });
    // created-in-window AND active: d2602 (won-before, still active), d2603 (null-won, active), d2605 (open).
    // Excluded: d2601 (created 2025), d2604 (archived/inactive), d2606 (inactive open).
    expect(report.kpis.totalDealCount).toBe(3);
  });
});

describe("Customer Concentration — total_won_lifetime uses won_closed_date (CC1/CC4)", () => {
  it("counts wins closed in the period (incl. archived), escaping the created_at window", async () => {
    const report = await getCustomerConcentrationReport(tdb, { from: "2030-01-01", to: "2030-12-31" });
    const ccCo = report.topCustomers.find((c) => c.companyId === CO.cc);
    expect(ccCo).toBeDefined();
    // 120k (won-in-period, created earlier) + 30k (archived, won-in-period). 90k won-before excluded.
    expect(ccCo?.totalWonLifetime).toBeCloseTo(150000, 2);
  });
});

describe("Executive Trends — KPI Won Revenue uses won_closed_date (CC1) and Total Pipeline excludes inactive (CC4)", () => {
  it("KPI Won Revenue is won-date-windowed with archived wins included", async () => {
    const report = await getExecutiveTrendsReport(tdb, { from: "2034-01-01", to: "2034-12-31" });
    const wonRevenue = report.kpis.find((k) => k.label === "Won Revenue");
    // 300k (created-before/won-in) + 60k (archived, won-in). 400k (won-before) excluded.
    expect(wonRevenue?.value).toBeCloseTo(360000, 2);
  });

  it("KPI Total Pipeline excludes soft-deleted open deals (CC4)", async () => {
    const report = await getExecutiveTrendsReport(tdb, { from: "2034-01-01", to: "2034-12-31" });
    const pipeline = report.kpis.find((k) => k.label === "Total Pipeline");
    // Only the active open deal (50k); the inactive open (20k) is excluded.
    expect(pipeline?.value).toBeCloseTo(50000, 2);
  });
});
