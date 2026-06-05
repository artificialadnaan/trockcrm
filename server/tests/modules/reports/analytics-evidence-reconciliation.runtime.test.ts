import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  getMarketMixReport,
  getCustomerConcentrationReport,
  getAnalyticsEvidence,
} from "../../../src/modules/reports/analytics-tier4-service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) drill-to-evidence reconciliation for Analytics Tier-4 (PR-F Part 2c).
 *
 * Each headline number drills to exactly the deal rows it aggregates, reusing the SAME predicate + $ basis as
 * its report, so COUNT/SUM(evidence) === the number by construction:
 *   - deal_count (Market Mix)            -> buildWhere(created_at, requireActive) -> count === totalDealCount.
 *   - open_value (Customer Concentration)-> buildWhere(created_at, requireActive) + non-terminal + reportable +
 *                                           company_id NOT NULL, forecast-first $ -> SUM === totalOpenValue.
 *
 * Unlike the Tier-2 (Director/Forecast) evidence, Tier-4 LEFT-joins users (it includes UNASSIGNED deals), so
 * the evidence must too — D7 (unassigned) is asserted PRESENT in both metrics. won_value is intentionally NOT
 * here: Market Mix totalWonValue folds in change-order value (disjoint base+CO), a CO-aware drill deferred
 * until BLUE's CO-as-child-deal model settles.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON = WON_STAGE_SLUGS[0];
const OFF = U("0ff1");
const ALICE = U("a01");
const CO = { a: U("c0a"), b: U("c0b"), c: U("c0c") };
const ST = { won: U("571"), contract: U("573"), opp: U("575") };
const FILTERS = { from: "2026-02-01", to: "2026-02-28", office: undefined, ownerIds: [], ownerNames: [] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;
const ev = (metric: string, repId?: string) => getAnalyticsEvidence(tdb, FILTERS, { metric, repId } as never);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE TABLE offices (id uuid PRIMARY KEY, slug text, name text);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text, office_id uuid, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE companies (id uuid PRIMARY KEY, name text, industry text, region text, last_activity_at timestamptz);
    CREATE TABLE properties (id uuid PRIMARY KEY, property_type text, type text, city text, state text);
    CREATE TABLE region_config (id uuid PRIMARY KEY, name text, slug text);
    CREATE TABLE public.project_type_config (id uuid PRIMARY KEY, name text);
    CREATE TABLE deal_change_orders (id uuid PRIMARY KEY, deal_id uuid NOT NULL, amount numeric, signed_date date);
    CREATE TABLE activities (id uuid PRIMARY KEY, deal_id uuid NOT NULL, occurred_at timestamptz NOT NULL);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, deal_number text, name text, stage_id uuid NOT NULL, assigned_rep_id uuid, estimator_user_id uuid,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL, updated_at timestamptz, won_closed_date date, lost_at timestamptz, stage_entered_at timestamptz,
      company_id uuid, property_id uuid, region_id uuid, project_type text, project_type_id uuid,
      property_city text, property_state text, office_code text, last_activity_at timestamptz,
      forecast_revenue numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric, awarded_amount numeric
    );

    INSERT INTO offices (id, slug, name) VALUES ('${OFF}','dallas','Dallas');
    INSERT INTO users (id, display_name, office_id, is_active) VALUES ('${ALICE}','Alice','${OFF}', true);
    INSERT INTO pipeline_stage_config (id, slug, name, is_terminal) VALUES
      ('${ST.won}','${WON}','Won', true), ('${ST.contract}','contract','Contract', false), ('${ST.opp}','opportunity','Opportunity', false);
    INSERT INTO companies (id, name, industry, region) VALUES ('${CO.a}','Acme','Healthcare','DFW'), ('${CO.b}','Beta','Retail','ATL'), ('${CO.c}','Gamma','Education','DFW');

    -- Active, created-in-window cohort. deal_count counts ALL of these (any stage); open_value keeps only the
    -- non-terminal, company-linked ones. D7 is UNASSIGNED (rep NULL) -> Tier-4 LEFT-joins users so it STAYS in.
    -- D6 = no company -> in deal_count, OUT of open_value. D7 = unassigned (rep NULL) -> Tier-4 LEFT-joins users so it stays in.
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, company_id, created_at, forecast_revenue, stage_entered_at) VALUES
      ('${U("d01")}','M-1','Opp Acme','${ST.opp}','${ALICE}','${CO.a}','2026-02-10T12:00:00Z', 50000,'2026-02-10T12:00:00Z'),
      ('${U("d02")}','M-2','Contract Beta','${ST.contract}','${ALICE}','${CO.b}','2026-02-15T12:00:00Z', 100000,'2026-02-15T12:00:00Z'),
      ('${U("d07")}','M-7','Opp Gamma (unassigned)','${ST.opp}', NULL,'${CO.c}','2026-02-13T12:00:00Z', 20000,'2026-02-13T12:00:00Z'),
      ('${U("d06")}','M-6','Opp no-company','${ST.opp}','${ALICE}', NULL,'2026-02-12T12:00:00Z', 30000,'2026-02-12T12:00:00Z');
    -- D3 = won (terminal) but still active -> in deal_count, OUT of open_value.
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, company_id, created_at, won_closed_date, forecast_revenue, stage_entered_at) VALUES
      ('${U("d03")}','M-3','Won Acme','${ST.won}','${ALICE}','${CO.a}','2026-02-20T12:00:00Z','2026-02-21', 0,'2026-02-20T12:00:00Z');

    -- EXCLUSIONS (in neither metric): on-hold, test, out-of-window created, inactive.
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, company_id, created_at, is_active, on_hold, is_test_data, forecast_revenue, stage_entered_at) VALUES
      ('${U("d11")}','X-1','OnHold','${ST.opp}','${ALICE}','${CO.a}','2026-02-11T12:00:00Z', true, true, false, 99000,'2026-02-11T12:00:00Z'),
      ('${U("d12")}','X-2','Test','${ST.opp}','${ALICE}','${CO.a}','2026-02-11T12:00:00Z', true, false, true, 99000,'2026-02-11T12:00:00Z'),
      ('${U("d13")}','X-3','OutOfWindow','${ST.opp}','${ALICE}','${CO.a}','2026-01-15T12:00:00Z', true, false, false, 99000,'2026-01-15T12:00:00Z'),
      ('${U("d14")}','X-4','Inactive','${ST.opp}','${ALICE}','${CO.a}','2026-02-11T12:00:00Z', false, false, false, 99000,'2026-02-11T12:00:00Z');
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("Analytics drill-to-evidence reconciles to the headline KPIs (PR-F Part 2c)", () => {
  it("deal_count evidence count === Market Mix totalDealCount; includes unassigned; excludes on-hold/test/out/inactive", async () => {
    const report = await getMarketMixReport(tdb, FILTERS);
    const dc = await ev("deal_count");
    expect(dc.total.count).toBe(5); // D1,D2,D3(won,active),D6(no-company),D7(unassigned) — absolute anchor
    expect(dc.total.count).toBe(report.kpis.totalDealCount);
    const nums = dc.records.map((r) => r.dealNumber);
    expect(nums).toContain("M-7"); // unassigned -> Tier-4 LEFT-joins users, so it STAYS in (unlike Tier-2)
    for (const x of ["X-1", "X-2", "X-3", "X-4"]) expect(nums).not.toContain(x);
  });

  it("open_value evidence SUM === Customer Concentration totalOpenValue; excludes terminal/no-company", async () => {
    const report = await getCustomerConcentrationReport(tdb, FILTERS);
    const ov = await ev("open_value");
    expect(ov.total.value).toBeCloseTo(170000, 2); // D1 50k + D2 100k + D7 20k — absolute anchor
    expect(ov.total.value).toBeCloseTo(report.kpis.totalOpenValue, 2);
    expect(ov.total.count).toBe(3);
    const nums = ov.records.map((r) => r.dealNumber);
    expect(nums).toContain("M-7"); // unassigned with a company -> included
    expect(nums).not.toContain("M-3"); // won (terminal) -> excluded from open value
    expect(nums).not.toContain("M-6"); // no company -> excluded
    for (const x of ["X-1", "X-2", "X-3", "X-4"]) expect(nums).not.toContain(x);
  });
});
