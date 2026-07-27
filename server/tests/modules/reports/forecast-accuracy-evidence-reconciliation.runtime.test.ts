import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  getForecastAccuracyReport,
  getForecastAccuracyEvidence,
} from "../../../src/modules/reports/performance-tier2-service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) drill-to-evidence reconciliation for Forecast Accuracy (PR-F Part 2b).
 *
 * Each headline number drills to exactly the deal rows it aggregates, reusing the SAME predicate + $ basis
 * as getForecastAccuracyReport, so SUM(evidence.value) === the number by construction:
 *   - commit / best_case -> dealScope, slug IN COMMIT / COMMIT+BEST_CASE, value = forecast-first.
 *   - pipeline_weighted  -> dealScope, slug NOT IN terminal, value = forecast-first * stage weight.
 *   - won_actual         -> archivedWonDealScope, slug IN WON, buildWonDateSql, value = awarded-first
 *                           (the CO-FREE, as-forecasted Won baseline -- change orders are excluded).
 *
 * Each metric carries BOTH a reconciliation-to-KPI assertion AND an ABSOLUTE anchor: the summary and the
 * pipeline_weighted evidence share forecastWeightedValueSql, so a wrong stage-weight constant would move both
 * sides together -- the hardcoded absolute totals are the independent oracle that catches it.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON = WON_STAGE_SLUGS[0];
const OFF = U("0ff1");
const ALICE = U("a01");
const BOB = U("b01");
const ST = { won: U("571"), contract: U("573"), estimating: U("574"), opp: U("575"), dd: U("576") };
const FILTERS = { dateFrom: "2026-02-01", dateTo: "2026-02-28", office: undefined, ownerIds: [], ownerNames: [] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;
const ev = (metric: string, repId?: string) =>
  getForecastAccuracyEvidence(tdb, FILTERS, { metric, repId } as never);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE offices (id uuid PRIMARY KEY, name text, slug text);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text, office_id uuid, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE companies (id uuid PRIMARY KEY, name text, region text);
    CREATE TABLE region_config (id uuid PRIMARY KEY, name text);
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE TABLE public.project_type_config (id uuid PRIMARY KEY, name text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid, deal_number text, name text, stage_id uuid NOT NULL, assigned_rep_id uuid,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false,
      won_closed_date date, lost_at timestamptz, contract_signed_at timestamptz, contract_signed_date date, actual_close_date date,
      expected_close_date date, bid_due_date timestamptz, updated_at timestamptz, stage_entered_at timestamptz,
      company_id uuid, region_id uuid, project_type_id uuid, project_type text, office_code text,
      forecast_revenue numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric, awarded_amount numeric,
      win_probability integer
    );

    INSERT INTO offices (id, name, slug) VALUES ('${OFF}','Dallas','dallas');
    INSERT INTO users (id, display_name, office_id, is_active) VALUES ('${ALICE}','Alice','${OFF}',true), ('${BOB}','Bob','${OFF}',true);
    INSERT INTO pipeline_stage_config (id, slug, name, is_terminal) VALUES
      ('${ST.won}','${WON}','Won', true), ('${ST.contract}','contract','Contract', false),
      ('${ST.estimating}','estimating','Estimating', false), ('${ST.opp}','opportunity','Opportunity', false),
      ('${ST.dd}','dd','Due Diligence', false);

    -- OPEN inventory (forecast-first value = forecast_revenue). 'dd' is an open stage NOT matched by the
    -- explicit weight CASE -> exercises the ELSE branch (win_probability / 100).
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, forecast_revenue, win_probability, expected_close_date, stage_entered_at) VALUES
      ('${U("d01")}','F-1','Alice Contract','${ST.contract}','${ALICE}', 200000, NULL,'2026-03-15','2026-02-01T00:00:00Z'),
      ('${U("d02")}','F-2','Alice Estimating','${ST.estimating}','${ALICE}', 100000, NULL,'2026-03-20','2026-02-01T00:00:00Z'),
      ('${U("d03")}','F-3','Alice Opportunity','${ST.opp}','${ALICE}', 50000, NULL,'2026-03-25','2026-02-01T00:00:00Z'),
      ('${U("d04")}','F-4','Alice DD (ELSE weight)','${ST.dd}','${ALICE}', 10000, 40,'2026-03-25','2026-02-01T00:00:00Z'),
      ('${U("d05")}','B-1','Bob Contract','${ST.contract}','${BOB}', 60000, NULL,'2026-03-18','2026-02-01T00:00:00Z');

    -- WON in Feb (won_actual on awarded-first / CO-free basis): W1 bid_estimate 80k, W2 awarded 120k, Bob 40k.
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, is_active, won_closed_date, bid_estimate, awarded_amount, stage_entered_at) VALUES
      ('${U("d06")}','W-1','Alice Won A','${ST.won}','${ALICE}', false, '2026-02-10', 80000, NULL,'2026-02-09T00:00:00Z'),
      ('${U("d07")}','W-2','Alice Won B','${ST.won}','${ALICE}', false, '2026-02-20', NULL, 120000,'2026-02-19T00:00:00Z'),
      ('${U("d08")}','B-2','Bob Won','${ST.won}','${BOB}', false, '2026-02-25', NULL, 40000,'2026-02-24T00:00:00Z');

    -- EXCLUSIONS + INNER-join / active-scope guards: on-hold, test, out-of-window, UNASSIGNED won, INACTIVE open.
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, is_active, on_hold, is_test_data, won_closed_date, forecast_revenue, awarded_amount, expected_close_date, stage_entered_at) VALUES
      ('${U("d09")}','X-1','OnHold Contract','${ST.contract}','${ALICE}', true, true, false, NULL, 99000, NULL,'2026-03-10','2026-02-01T00:00:00Z'),
      ('${U("d10")}','X-2','Test Contract','${ST.contract}','${ALICE}', true, false, true, NULL, 99000, NULL,'2026-03-10','2026-02-01T00:00:00Z'),
      ('${U("d11")}','X-3','OutOfWindow Won','${ST.won}','${ALICE}', false, false, false, '2026-01-05', NULL, 99000,'2026-01-04','2026-01-04T00:00:00Z'),
      ('${U("d12")}','U-1','Unassigned Won','${ST.won}', NULL, false, false, false, '2026-02-10', NULL, 70000,'2026-02-09','2026-02-09T00:00:00Z'),
      ('${U("d13")}','U-2','Inactive Contract','${ST.contract}','${ALICE}', false, false, false, NULL, 70000, NULL,'2026-03-10','2026-02-01T00:00:00Z');
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("Forecast Accuracy drill-to-evidence reconciles to the headline KPIs (PR-F Part 2b)", () => {
  it("commit + best_case reconcile to kpis (forecast-first $) with absolute anchors; exclude on-hold/test/inactive", async () => {
    const report = await getForecastAccuracyReport(tdb, FILTERS, "fa-ev");
    const commit = await ev("commit");
    const bestCase = await ev("best_case");
    expect(commit.total.value).toBeCloseTo(260000, 2); // F-1 200k + B-1 60k (independent anchor)
    expect(commit.total.value).toBeCloseTo(report.kpis.commit, 2);
    expect(bestCase.total.value).toBeCloseTo(360000, 2); // commit + estimating 100k
    expect(bestCase.total.value).toBeCloseTo(report.kpis.bestCase, 2);
    const nums = commit.records.map((r) => r.dealNumber);
    expect(nums).not.toContain("X-1"); // on-hold
    expect(nums).not.toContain("X-2"); // test
    expect(nums).not.toContain("U-2"); // inactive -> dropped by dealScope (requireActive)
  });

  it("pipeline_weighted reconciles with an ABSOLUTE anchor (catches a wrong shared stage-weight) + ELSE branch", async () => {
    const report = await getForecastAccuracyReport(tdb, FILTERS, "fa-ev");
    const pw = await ev("pipeline_weighted");
    // 200k*0.75 + 100k*0.25 + 50k*0.10 + 10k*(40/100 ELSE) + 60k*0.75 = 150000+25000+5000+4000+45000 = 229000
    expect(pw.total.value).toBeCloseTo(229000, 2);
    expect(pw.total.value).toBeCloseTo(report.kpis.pipelineWeighted, 2);
    expect(pw.records.map((r) => r.dealNumber)).toContain("F-4"); // ELSE-weight deal is counted
  });

  it("won_actual reconciles on the CO-free awarded-first basis; excludes out-of-window + unassigned", async () => {
    const report = await getForecastAccuracyReport(tdb, FILTERS, "fa-ev");
    const won = await ev("won_actual");
    expect(won.total.value).toBeCloseTo(240000, 2); // 80k + 120k + 40k (no change-order value)
    expect(won.total.value).toBeCloseTo(report.kpis.wonActual, 2);
    expect(won.total.count).toBe(3);
    const nums = won.records.map((r) => r.dealNumber);
    expect(nums).not.toContain("X-3"); // out of window
    expect(nums).not.toContain("U-1"); // unassigned -> dropped by the INNER join, exactly as the aggregate
  });

  it("rep-scoped evidence sums to the office (commit + won_actual)", async () => {
    const office = await ev("commit");
    const aliceCommit = await ev("commit", ALICE);
    const bobCommit = await ev("commit", BOB);
    expect((aliceCommit.total.value ?? 0) + (bobCommit.total.value ?? 0)).toBeCloseTo(office.total.value ?? 0, 2);
    expect(aliceCommit.total.value).toBeCloseTo(200000, 2);
    expect(bobCommit.total.value).toBeCloseTo(60000, 2);

    const officeWon = await ev("won_actual");
    const aliceWon = await ev("won_actual", ALICE);
    const bobWon = await ev("won_actual", BOB);
    expect((aliceWon.total.value ?? 0) + (bobWon.total.value ?? 0)).toBeCloseTo(officeWon.total.value ?? 0, 2);
    expect(aliceWon.total.value).toBeCloseTo(200000, 2);
    expect(bobWon.total.value).toBeCloseTo(40000, 2);
  });
});
