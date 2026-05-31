import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getForecastAccuracyReport } from "../../../src/modules/reports/performance-tier2-service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) end-to-end run of getForecastAccuracyReport — validates that the restructured
 * monthly query (parenthesized `LEFT JOIN (deals JOIN psc)` + stage-gated month bucket + per-
 * aggregate scope) EXECUTES and that:
 *   1. SUM(monthly.wonActual) === summary.wonActual (Codex P2 reconciliation, across months).
 *   2. A reopened-active deal (was Won, keeps a stale Feb won_closed_date, now in an OPEN commit
 *      stage with a March expected-close) stays in MARCH's commit column — it is NOT mis-bucketed
 *      into its stale historical won month (which is outside the window and would drop it). [GREEN]
 *   3. Every generated month is present (no month dropped).
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON_SLUG = WON_STAGE_SLUGS[0];
const OFF = U("0ff1");
const REP = U("a01");
const ST = { won: U("57001"), contract: U("57002"), open: U("57003") };
const D = { won1: U("11001"), won2: U("11002"), reopened: U("11003"), openMar: U("11004") };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;
const FILTERS = { dateFrom: "2026-03-01", dateTo: "2026-04-30", office: undefined, ownerIds: [], ownerNames: [] };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE offices (id uuid PRIMARY KEY, name text, slug text);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text, office_id uuid, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, assigned_rep_id uuid, stage_id uuid NOT NULL,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false,
      won_closed_date date, expected_close_date date, actual_close_date date, contract_signed_date date, contract_signed_at timestamptz, updated_at timestamptz,
      forecast_revenue numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric, awarded_amount numeric,
      win_probability numeric
    );
    INSERT INTO offices (id, name, slug) VALUES ('${OFF}','Dallas','dallas');
    INSERT INTO users (id, display_name, office_id, is_active) VALUES ('${REP}','Alice','${OFF}', true);
    INSERT INTO pipeline_stage_config (id, slug, name, is_terminal) VALUES
      ('${ST.won}','${WON_SLUG}','Won', true), ('${ST.contract}','contract','Contract', false), ('${ST.open}','opportunity','Opportunity', false);

    -- months window = 2026-03 .. 2026-04
    -- WON1: won in March (is_active=false; counted via archivedWonDealScope) -> March won_actual 100000
    INSERT INTO deals (id, name, assigned_rep_id, stage_id, is_active, won_closed_date, awarded_amount) VALUES
      ('${D.won1}','Won March','${REP}','${ST.won}', false, '2026-03-15', 100000),
      -- WON2: won in April -> April won_actual 60000
      ('${D.won2}','Won April','${REP}','${ST.won}', false, '2026-04-10', 60000);
    -- REOPENED: was Won (stale Feb won date) but now OPEN 'contract' stage w/ March expected-close.
    -- Must bucket on March (expected) and feed March commit; the bug would bucket it into Feb (out of
    -- window) and drop its 80000 from the forecast entirely.
    INSERT INTO deals (id, name, assigned_rep_id, stage_id, is_active, won_closed_date, expected_close_date, forecast_revenue) VALUES
      ('${D.reopened}','Reopened active','${REP}','${ST.contract}', true, '2026-02-15', '2026-03-20', 80000),
      -- a plain open commit deal in April for contrast
      ('${D.openMar}','Open April','${REP}','${ST.contract}', true, NULL, '2026-04-12', 25000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("getForecastAccuracyReport monthly trend (restructured stage-gated bucket) executes + reconciles", () => {
  it("reconciles monthly won_actual to summary, keeps reopened-actives in their expected month, drops no month", async () => {
    const report = await getForecastAccuracyReport(tdb, FILTERS, "forecast-reconcile-runtime");

    // (3) both generated months present
    const months = report.monthly.map((m) => m.month);
    expect(months).toEqual(["2026-03", "2026-04"]);

    // (1) reconciliation: SUM(monthly.wonActual) === summary (kpis) wonActual
    const monthlyWon = report.monthly.reduce((s, m) => s + m.wonActual, 0);
    expect(report.kpis.wonActual).toBeCloseTo(160000, 2); // WON1 (Mar) + WON2 (Apr)
    expect(monthlyWon).toBeCloseTo(report.kpis.wonActual, 2);
    const mar = report.monthly.find((m) => m.month === "2026-03")!;
    const apr = report.monthly.find((m) => m.month === "2026-04")!;
    expect(mar.wonActual).toBeCloseTo(100000, 2);
    expect(apr.wonActual).toBeCloseTo(60000, 2);

    // (2) reopened-active is bucketed in MARCH commit (expected-close), not dropped to its stale Feb won month
    expect(mar.commit).toBeCloseTo(80000, 2);
    expect(apr.commit).toBeCloseTo(25000, 2);
  });
});
