import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  getDirectorScorecard,
  getDirectorScorecardEvidence,
} from "../../../src/modules/reports/performance-tier2-service.js";
import { WON_STAGE_SLUGS, LOST_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) drill-to-evidence reconciliation for the Director Scorecard (PR-F Part 2a).
 *
 * Every headline number must DRILL to exactly the deal rows it aggregates, so the drawer total reconciles
 * to the clicked figure by construction — the gold-standard bar (mirrors Monday Showcase evidence). Each
 * metric builder reuses the SAME predicate as its aggregate in getDirectorScorecard:
 *   - won / lost  -> the win-rate cohort (closedDealScope AND buildWonDateSql AND slug IN WON|LOST).
 *                    winRate === won.count / (won.count + lost.count).
 *   - pipeline    -> open inventory (dealScope AND slug NOT IN terminal AND reportable). count === openDealCount,
 *                    sum(value) === totalPipelineValue.
 *   - commit      -> pipeline AND slug IN COMMIT.            sum(value) === forecastCommit.
 *   - best_case   -> pipeline AND slug IN COMMIT+BEST_CASE.  sum(value) === forecastBestCase.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON = WON_STAGE_SLUGS[0];
const LOST = LOST_STAGE_SLUGS[0];
const OFF = U("0ff1");
const ALICE = U("a01");
const BOB = U("b01");
const ST = { won: U("571"), lost: U("572"), contract: U("573"), estimating: U("574"), opp: U("575") };
const FILTERS = { dateFrom: "2026-02-01", dateTo: "2026-02-28", office: undefined, ownerIds: [], ownerNames: [] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;
const ev = (metric: string, repId?: string | null) =>
  getDirectorScorecardEvidence(tdb, FILTERS, { metric, repId } as never);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE offices (id uuid PRIMARY KEY, name text, slug text);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text, office_id uuid, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text);
    CREATE TABLE companies (id uuid PRIMARY KEY, name text, region text);
    CREATE TABLE region_config (id uuid PRIMARY KEY, name text);
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE TABLE public.project_type_config (id uuid PRIMARY KEY, name text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid, deal_number text, name text, stage_id uuid NOT NULL, assigned_rep_id uuid,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false,
      on_hold_started_at timestamptz, on_hold_accumulated_seconds numeric, on_hold_accumulated_seconds_at_stage_entry numeric,
      won_closed_date date, lost_at timestamptz, contract_signed_at timestamptz, actual_close_date date, updated_at timestamptz,
      stage_entered_at timestamptz, bid_board_stage_slug text, bid_board_stage_entered_at timestamptz, workflow_route text,
      company_id uuid, region_id uuid, project_type_id uuid, project_type text, expected_close_date date, bid_due_date timestamptz,
      last_activity_at timestamptz, office_code text,
      bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric, awarded_amount numeric
    );
    CREATE TABLE tasks (id uuid PRIMARY KEY, deal_id uuid, assigned_to uuid, status text, due_date date, is_test_data boolean NOT NULL DEFAULT false);
    CREATE TABLE activities (id uuid PRIMARY KEY, responsible_user_id uuid, occurred_at timestamptz);

    INSERT INTO offices (id, name, slug) VALUES ('${OFF}','Dallas','dallas');
    INSERT INTO users (id, display_name, office_id, is_active) VALUES ('${ALICE}','Alice','${OFF}',true), ('${BOB}','Bob','${OFF}',true);
    INSERT INTO pipeline_stage_config (id, slug, name) VALUES
      ('${ST.won}','${WON}','Won'), ('${ST.lost}','${LOST}','Lost'),
      ('${ST.contract}','contract','Contract'), ('${ST.estimating}','estimating','Estimating'), ('${ST.opp}','opportunity','Opportunity');

    -- WON in Feb (numerator): Alice x2, Bob x1.
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, won_closed_date, bid_estimate, stage_entered_at) VALUES
      ('${U("d01")}','W-1','Alice Won 1','${ST.won}','${ALICE}','2026-02-10',100000,'2026-02-09T00:00:00Z'),
      ('${U("d02")}','W-2','Alice Won 2','${ST.won}','${ALICE}','2026-02-20',50000,'2026-02-19T00:00:00Z'),
      ('${U("d03")}','W-3','Bob Won 1','${ST.won}','${BOB}','2026-02-15',80000,'2026-02-14T00:00:00Z');

    -- LOST in Feb by canonical lost_at (denominator): Alice x1, Bob x1.
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, lost_at, actual_close_date, updated_at, bid_estimate, stage_entered_at) VALUES
      ('${U("d04")}','L-1','Alice Lost 1','${ST.lost}','${ALICE}','2026-02-12T00:00:00Z','2025-11-01','2026-05-01T00:00:00Z',25000,'2025-10-01T00:00:00Z'),
      ('${U("d05")}','L-2','Bob Lost 1','${ST.lost}','${BOB}','2026-02-18T00:00:00Z','2025-11-01','2026-05-01T00:00:00Z',15000,'2025-10-01T00:00:00Z');

    -- OPEN inventory: contract (commit), estimating (best_case), opportunity (plain open).
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, bid_estimate, expected_close_date, stage_entered_at) VALUES
      ('${U("d06")}','O-1','Alice Contract','${ST.contract}','${ALICE}',200000,'2026-03-15','2026-02-01T00:00:00Z'),
      ('${U("d07")}','O-2','Bob Estimating','${ST.estimating}','${BOB}',40000,'2026-03-20','2026-02-01T00:00:00Z'),
      ('${U("d08")}','O-3','Alice Opportunity','${ST.opp}','${ALICE}',30000,'2026-03-25','2026-02-01T00:00:00Z');

    -- EXCLUSIONS: on-hold open (out of pipeline), test won, out-of-window won.
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, on_hold, is_test_data, won_closed_date, bid_estimate, stage_entered_at) VALUES
      ('${U("d09")}','X-1','OnHold Opp','${ST.opp}','${ALICE}', true, false, NULL, 99000,'2026-02-01T00:00:00Z'),
      ('${U("d10")}','X-2','Test Won','${ST.won}','${ALICE}', false, true, '2026-02-10', 99000,'2026-02-09T00:00:00Z'),
      ('${U("d11")}','X-3','OutOfWindow Won','${ST.won}','${ALICE}', false, false, '2026-01-05', 99000,'2026-01-04T00:00:00Z');

    -- INNER-join / active-scope guards. Both contribute to NO headline (getDirectorScorecard INNER-joins
    -- users on assigned_rep_id and the open cohort requires is_active), so the evidence must drop them on the
    -- SAME side: a LEFT-join or a requireActive:false regression would admit them and break reconciliation.
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, is_active, won_closed_date, bid_estimate, stage_entered_at) VALUES
      ('${U("d12")}','U-1','Unassigned Won', '${ST.won}', NULL,     true,  '2026-02-10', 70000,'2026-02-09T00:00:00Z'),
      ('${U("d13")}','U-2','Inactive Opp',   '${ST.opp}', '${ALICE}', false, NULL,        70000,'2026-02-01T00:00:00Z');
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("Director Scorecard drill-to-evidence reconciles to the headline KPIs (PR-F Part 2a)", () => {
  it("win-rate evidence: winRate === won.count / (won.count + lost.count), excludes test/out-of-window", async () => {
    const report = await getDirectorScorecard(tdb, FILTERS, "ev-recon");
    const won = await ev("won");
    const lost = await ev("lost");

    expect(won.total.count).toBe(3);
    expect(lost.total.count).toBe(2);
    const winRate = (won.total.count / (won.total.count + lost.total.count)) * 100;
    expect(winRate).toBeCloseTo(report.kpis.winRate, 1); // 60%

    const wonNums = won.records.map((r) => r.dealNumber);
    expect(wonNums).not.toContain("X-2"); // test
    expect(wonNums).not.toContain("X-3"); // out of window
    expect(wonNums).not.toContain("U-1"); // unassigned -> dropped by the INNER join, exactly as the aggregate
  });

  it("pipeline evidence: count === openDealCount and sum(value) === totalPipelineValue, excludes on-hold", async () => {
    const report = await getDirectorScorecard(tdb, FILTERS, "ev-recon");
    const pipeline = await ev("pipeline");
    expect(pipeline.total.count).toBe(report.kpis.openDealCount); // 3
    expect(pipeline.total.value).toBeCloseTo(report.kpis.totalPipelineValue, 2); // 270000
    const pipeNums = pipeline.records.map((r) => r.dealNumber);
    expect(pipeNums).not.toContain("X-1"); // on-hold
    expect(pipeNums).not.toContain("U-2"); // inactive -> dropped by the active scope, exactly as the aggregate
  });

  it("rep-scoped value reconciles: pipeline values per rep sum to the office totalPipelineValue", async () => {
    const report = await getDirectorScorecard(tdb, FILTERS, "ev-recon");
    const office = await ev("pipeline");
    const alice = await ev("pipeline", ALICE);
    const bob = await ev("pipeline", BOB);
    // INNER join + rep scope on the VALUE path: Alice (200k contract + 30k opp) + Bob (40k estimating) = office.
    expect((alice.total.value ?? 0) + (bob.total.value ?? 0)).toBeCloseTo(office.total.value ?? 0, 2);
    expect(office.total.value).toBeCloseTo(report.kpis.totalPipelineValue, 2);
    const aliceNums = alice.records.map((r) => r.dealNumber);
    expect(aliceNums).not.toContain("U-1"); // unassigned won is in neither rep slice nor the office total
    expect(aliceNums).not.toContain("U-2"); // inactive open dropped by the active scope
  });

  it("commit + best_case evidence reconcile to forecastCommit / forecastBestCase", async () => {
    const report = await getDirectorScorecard(tdb, FILTERS, "ev-recon");
    const commit = await ev("commit");
    const bestCase = await ev("best_case");
    expect(commit.total.value).toBeCloseTo(report.kpis.forecastCommit, 2); // 200000
    expect(bestCase.total.value).toBeCloseTo(report.kpis.forecastBestCase, 2); // 240000
  });

  it("per-rep won evidence reconciles to repPerformance[].wonThisPeriod and sums to office", async () => {
    const report = await getDirectorScorecard(tdb, FILTERS, "ev-recon");
    const alice = report.repPerformance.find((r) => r.repName === "Alice");
    const aliceWon = await ev("won", ALICE);
    expect(aliceWon.total.count).toBe(alice?.wonThisPeriod); // 2

    const office = await ev("won");
    const repSum = (await Promise.all(report.repPerformance.map((r) => ev("won", r.repName === "Alice" ? ALICE : BOB))))
      .reduce((s, e) => s + e.total.count, 0);
    expect(repSum).toBe(office.total.count);
  });
});
