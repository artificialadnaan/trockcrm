import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getExecutiveTrendsReport, computePreviousPeriod } from "../../../src/modules/reports/analytics-tier4-service.js";
import { WON_STAGE_SLUGS, LOST_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) proof for Wave-1 PR-C — Executive Trends rebuild.
 *
 * CC2 — won/lost/win-rate are keyed off the CURRENT stage_id with COUNT(DISTINCT), NOT
 *       deal_stage_history transition rows. A reopened (won->lost->won) deal counts ONCE, not once
 *       per transition (the old winRateRows used non-DISTINCT COUNT(*) over dsh -> counted it 3x).
 * CC1 — Won is windowed/bucketed by canonical won_closed_date (+ usable guard), not created_at; a deal
 *       created before the window but won inside it counts, and one created-in but won-before does not.
 *       Monthly wonDeals no longer drops a deal whose won-TRANSITION is out of window but whose
 *       won_closed_date is in window (the old dsh won_history/won_fallback dropped it).
 * Win-rate UNIFIED — the KPI win rate === the period aggregate of the monthly trend (one definition).
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON = WON_STAGE_SLUGS[0];
const LOST = LOST_STAGE_SLUGS[0];
const ST = { won: U("57001"), lost: U("57002"), open: U("57003") };
const REP = U("a01");
const D = { reopened: U("d01"), wonBefore: U("d02"), wonClosedBefore: U("d03"), lost: U("d04"), open: U("d05") };
const RANGE = { from: "2026-01-01", to: "2026-03-31" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text, is_terminal boolean NOT NULL DEFAULT false, display_order int);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE deal_stage_history (deal_id uuid, from_stage_id uuid, to_stage_id uuid, created_at timestamptz);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, stage_id uuid NOT NULL, assigned_rep_id uuid, estimator_user_id uuid,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false, expected_close_date date,
      created_at timestamptz, won_closed_date date, lost_at timestamptz, updated_at timestamptz,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric, forecast_revenue numeric
    );
    CREATE TABLE deal_change_orders (
      id uuid PRIMARY KEY, deal_id uuid NOT NULL, signed_date date NOT NULL,
      amount numeric(14,2) NOT NULL, description text, created_at timestamptz NOT NULL DEFAULT NOW()
    );
    INSERT INTO users (id, display_name) VALUES ('${REP}','Alice');
    INSERT INTO pipeline_stage_config (id, slug, name, is_terminal, display_order) VALUES
      ('${ST.won}','${WON}','Won', true, 90),
      ('${ST.lost}','${LOST}','Lost', true, 95),
      ('${ST.open}','opportunity','Opportunity', false, 30);

    -- reopened won->lost->won: current stage WON, canonical won 2026-02-15 (Feb). Its dsh won-transitions
    -- are in Feb AND Mar — the old dsh-based monthly counted it in BOTH months; the new design counts it
    -- ONCE, in Feb (its won_closed_date). So "Mar won === 0" is the CC2 double-count discriminator.
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, created_at, won_closed_date, awarded_amount) VALUES
      ('${D.reopened}','Reopened','${ST.won}','${REP}','2025-12-01','2026-02-15', 200000);
    INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, created_at) VALUES
      ('${D.reopened}','${ST.open}','${ST.won}','2026-02-10T00:00:00Z'),
      ('${D.reopened}','${ST.won}','${ST.lost}','2026-02-20T00:00:00Z'),
      ('${D.reopened}','${ST.lost}','${ST.won}','2026-03-05T00:00:00Z');

    -- created BEFORE window, won 2026-01-10 (Jan); its only won-TRANSITION is 2025-11 (OUT of window).
    -- Old dsh won_history missed it (transition out) and won_fallback missed it (it HAS a won transition).
    -- New design counts it by won_closed_date (Jan).
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, created_at, won_closed_date, awarded_amount) VALUES
      ('${D.wonBefore}','Won Jan','${ST.won}','${REP}','2025-11-01','2026-01-10', 100000);
    INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, created_at) VALUES
      ('${D.wonBefore}','${ST.open}','${ST.won}','2025-11-15T00:00:00Z');

    -- created IN window but won BEFORE it (won_closed_date 2025-12) -> excluded from period won (CC1).
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, created_at, won_closed_date, awarded_amount) VALUES
      ('${D.wonClosedBefore}','Won Dec','${ST.won}','${REP}','2026-02-01','2025-12-20', 999000);

    -- lost in Feb (lost_at 2026-02-20) -> win-rate denominator.
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, created_at, lost_at, updated_at, bid_estimate) VALUES
      ('${D.lost}','Lost Feb','${ST.lost}','${REP}','2026-01-15','2026-02-20T00:00:00Z','2026-02-20T00:00:00Z', 40000);

    -- open deal created Jan -> new deal + active pipeline.
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, created_at, bid_estimate) VALUES
      ('${D.open}','Open','${ST.open}','${REP}','2026-01-08', 50000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("Executive Trends — current-stage outcomes, won_closed_date, unified win rate (PR-C)", () => {
  it("counts a reopened deal once (CC2), by won_closed_date period (CC1)", async () => {
    const report = await getExecutiveTrendsReport(tdb, RANGE);
    const byMonth = Object.fromEntries(report.monthlyTrends.map((m) => [m.month, m]));
    // Reopened deal (3 won/lost transitions) counts ONCE, in Feb (its won_closed_date) — not 3x.
    expect(byMonth["2026-02"].wonDeals).toBe(1);
    // Won-before-created counts in Jan (won_closed_date), despite its won-transition being out of window.
    expect(byMonth["2026-01"].wonDeals).toBe(1);
    expect(byMonth["2026-03"].wonDeals).toBe(0);
    // Lost lands in Feb.
    expect(byMonth["2026-02"].lostDeals).toBe(1);
    // Total won across the period = 2 (reopened + wonBefore); the won-before-window deal is excluded.
    const totalWon = report.monthlyTrends.reduce((acc, m) => acc + m.wonDeals, 0);
    expect(totalWon).toBe(2);
  });

  it("KPI win rate === the period aggregate of the monthly trend (one definition)", async () => {
    const report = await getExecutiveTrendsReport(tdb, RANGE);
    const totalWon = report.monthlyTrends.reduce((acc, m) => acc + m.wonDeals, 0);
    const totalLost = report.monthlyTrends.reduce((acc, m) => acc + m.lostDeals, 0);
    const expectedWinRate = Math.round((totalWon / (totalWon + totalLost)) * 1000) / 10; // 2/3 -> 66.7
    const kpiWinRate = report.kpis.find((k) => k.label === "Win Rate")?.value;
    expect(kpiWinRate).toBeCloseTo(expectedWinRate, 1);
    expect(kpiWinRate).toBeCloseTo(66.7, 1);
  });

  it("KPI Won Revenue is the won_closed_date cohort (Jan 100k + Feb 200k = 300k)", async () => {
    const report = await getExecutiveTrendsReport(tdb, RANGE);
    expect(report.kpis.find((k) => k.label === "Won Revenue")?.value).toBeCloseTo(300000, 2);
  });

  it("win-rate trend matches the monthly won/lost (Jan 100, Feb 50, Mar 0)", async () => {
    const report = await getExecutiveTrendsReport(tdb, RANGE);
    const byMonth = Object.fromEntries(report.winRateTrend.map((m) => [m.month, m.winRate]));
    expect(byMonth["2026-01"]).toBeCloseTo(100, 1);
    expect(byMonth["2026-02"]).toBeCloseTo(50, 1);
    expect(byMonth["2026-03"]).toBeCloseTo(0, 1);
  });
});

// C1 regression: under a NON-UTC (Central) DB session — the prod basis — a lost deal near a month/period
// boundary must be windowed AND bucketed on the SAME (UTC) basis, so the KPI win rate still equals the
// monthly trend aggregate. The UTC-session suite above cannot catch a session-TZ vs UTC bucket mismatch.
describe("Executive Trends — win-rate unification holds under a Central session (C1)", () => {
  it("a boundary lost deal is windowed and bucketed consistently (KPI win rate === trend aggregate)", async () => {
    const cpg = new PGlite();
    await cpg.exec(`SET TimeZone='America/Chicago';`);
    await cpg.exec(`
      CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text, is_terminal boolean NOT NULL DEFAULT false, display_order int);
      CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
      CREATE TABLE deal_stage_history (deal_id uuid, from_stage_id uuid, to_stage_id uuid, created_at timestamptz);
      CREATE TABLE deals (
        id uuid PRIMARY KEY, name text, stage_id uuid NOT NULL, assigned_rep_id uuid, estimator_user_id uuid,
        is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false, expected_close_date date,
        created_at timestamptz, won_closed_date date, lost_at timestamptz, updated_at timestamptz,
        awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric, forecast_revenue numeric
      );
      CREATE TABLE deal_change_orders (
        id uuid PRIMARY KEY, deal_id uuid NOT NULL, signed_date date NOT NULL,
        amount numeric(14,2) NOT NULL, description text, created_at timestamptz NOT NULL DEFAULT NOW()
      );
      INSERT INTO pipeline_stage_config (id, slug, name, is_terminal, display_order) VALUES
        ('${ST.won}','${WON}','Won', true, 90), ('${ST.lost}','${LOST}','Lost', true, 95), ('${ST.open}','opportunity','Opportunity', false, 30);
      -- won in Feb.
      INSERT INTO deals (id, name, stage_id, won_closed_date, created_at, awarded_amount) VALUES
        ('${U("e01")}','Won Feb','${ST.won}','2026-02-10','2026-02-01', 100000);
      -- lost at 2026-03-01 02:00 UTC = 2026-02-28 20:00 Central. UTC date = Mar 1 (outside the Feb window);
      -- the buggy session-TZ window would have placed it in Feb (KPI) while the UTC bucket dropped it (trend).
      INSERT INTO deals (id, name, stage_id, lost_at, updated_at, created_at, bid_estimate) VALUES
        ('${U("e02")}','Lost boundary','${ST.lost}','2026-03-01T02:00:00Z','2026-03-01T02:00:00Z','2026-02-15', 40000);
    `);
    const ctdb = drizzle(cpg);
    const report = await getExecutiveTrendsReport(ctdb, { from: "2026-02-01", to: "2026-02-28" });
    const totalWon = report.monthlyTrends.reduce((acc, m) => acc + m.wonDeals, 0);
    const totalLost = report.monthlyTrends.reduce((acc, m) => acc + m.lostDeals, 0);
    const trendAggregate = totalWon + totalLost ? Math.round((totalWon / (totalWon + totalLost)) * 1000) / 10 : 0;
    const kpiWinRate = report.kpis.find((k) => k.label === "Win Rate")?.value;
    expect(kpiWinRate).toBeCloseTo(trendAggregate, 1);
    await cpg.close?.();
  });
});

// Preserved from the deleted src/-co-located mock test (superseded by the runtime tests above): the
// previous-period window math used for KPI change% is inclusive of both endpoints.
describe("computePreviousPeriod", () => {
  it("computes the inclusive previous period", () => {
    expect(computePreviousPeriod("2026-01-01", "2026-01-31")).toEqual({
      previousFrom: "2025-12-01",
      previousToExclusive: "2026-01-01",
      days: 31,
    });
  });
});
