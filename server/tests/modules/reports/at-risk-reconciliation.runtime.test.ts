import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { SQL } from "drizzle-orm";
import { buildProjectionCoverageSql } from "../../../src/modules/reports/monday-showcase-service.js";
import { buildAtRiskDealsSql, getAtRiskWatchlist } from "../../../src/modules/reports/at-risk-service.js";

/**
 * REAL-SQL (PGlite) reconciliation for the At-Risk watchlist: the at-risk set is the forecast's blind
 * spots, so its count MUST equal the projection coverage's (M − N) over the same open-deal scope. We seed
 * future / past / null-dated open deals plus excluded shapes (on-hold, test, terminal, inactive) and prove
 * the tie, and that the summary equals the listed rows.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const REP_A = U("a01");
const REP_B = U("b01");
const ST = { open: U("57001"), won: U("57002") };
const D = {
  pa: U("11001"), pb: U("11002"), sa: U("11003"), sb: U("11004"),
  na: U("11005"), nu: U("11006"), onhold: U("11007"), test: U("11008"),
  term: U("11009"), inactive: U("11010"),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;
function execRows(q: SQL): Promise<Array<Record<string, unknown>>> {
  return tdb.execute(q).then((r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows ?? [])) as Array<Record<string, unknown>>);
}
const n = (v: unknown) => Number(v ?? 0);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text NOT NULL);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, name text NOT NULL, slug text UNIQUE NOT NULL, workflow_family text NOT NULL DEFAULT 'standard_deal', is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid, deal_number text, name text NOT NULL, stage_id uuid NOT NULL, assigned_rep_id uuid,
      is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true,
      expected_close_date date, stage_entered_at timestamptz,
      dd_estimate numeric, bid_estimate numeric, awarded_amount numeric, bid_board_total_sales numeric
    );
    INSERT INTO users (id, display_name) VALUES ('${REP_A}','Alice'), ('${REP_B}','Bob');
    INSERT INTO pipeline_stage_config (id, name, slug, is_terminal) VALUES
      ('${ST.open}','Opportunity','opportunity', false),
      ('${ST.won}','Won','closed_won', true);

    -- future-dated (in N, NOT at-risk)
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, expected_close_date, stage_entered_at, bid_board_total_sales) VALUES
      ('${D.pa}','P-A','Future A','${ST.open}','${REP_A}', (now() AT TIME ZONE 'America/Chicago')::date + 10, now() - interval '5 days', 90000),
      ('${D.pb}','P-B','Future B','${ST.open}','${REP_B}', (now() AT TIME ZONE 'America/Chicago')::date + 40, now() - interval '5 days', 80000);
    -- stale-dated (at-risk: stale_dated)
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, expected_close_date, stage_entered_at, bid_board_total_sales) VALUES
      ('${D.sa}','S-A','Stale A','${ST.open}','${REP_A}', (now() AT TIME ZONE 'America/Chicago')::date - 5, now() - interval '40 days', 30000),
      ('${D.sb}','S-B','Stale B','${ST.open}','${REP_B}', (now() AT TIME ZONE 'America/Chicago')::date - 20, now() - interval '60 days', 40000);
    -- null-dated (at-risk: no_date)
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, expected_close_date, stage_entered_at, bid_board_total_sales) VALUES
      ('${D.na}','N-A','NoDate A','${ST.open}','${REP_A}', NULL, now() - interval '10 days', 15000),
      ('${D.nu}','N-U','NoDate Unassigned','${ST.open}', NULL, NULL, now() - interval '10 days', 12000);
    -- excluded shapes (must NOT appear, must NOT inflate M)
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, expected_close_date, on_hold, is_test_data, is_active, bid_board_total_sales) VALUES
      ('${D.onhold}','X-H','On hold','${ST.open}','${REP_A}', (now() AT TIME ZONE 'America/Chicago')::date - 5, true, false, true, 99999),
      ('${D.test}','X-T','Test','${ST.open}','${REP_A}', (now() AT TIME ZONE 'America/Chicago')::date - 5, false, true, true, 99999),
      ('${D.term}','X-W','Terminal won','${ST.won}','${REP_A}', (now() AT TIME ZONE 'America/Chicago')::date - 5, false, false, true, 99999),
      ('${D.inactive}','X-I','Inactive','${ST.open}','${REP_A}', (now() AT TIME ZONE 'America/Chicago')::date - 5, false, false, false, 99999);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("At-risk watchlist reconciles to the projection coverage (M − N)", () => {
  it("office at-risk count === M − N, summary === rows, excluded shapes absent", async () => {
    const cov = await execRows(buildProjectionCoverageSql());
    const officeM = cov.reduce((s, r) => s + n(r.m), 0);
    const officeN = cov.reduce((s, r) => s + n(r.n), 0);
    expect(officeM).toBe(6); // P-A,P-B,S-A,S-B,N-A,N-U
    expect(officeN).toBe(2); // P-A,P-B

    const watch = await getAtRiskWatchlist(tdb);
    expect(watch.summary.count).toBe(officeM - officeN); // 4 -- the blind spots
    expect(watch.records.length).toBe(watch.summary.count);
    expect(watch.summary.valueAtRisk).toBeCloseTo(30000 + 40000 + 15000 + 12000, 2);
    // reasons split correctly
    expect(watch.byReason.stale_dated.count).toBe(2);
    expect(watch.byReason.no_date.count).toBe(2);
    // excluded shapes never appear
    const nums = watch.records.map((r) => r.dealNumber);
    expect(nums).not.toContain("P-A"); // future-dated (in N)
    for (const x of ["X-H", "X-T", "X-W", "X-I"]) expect(nums).not.toContain(x);
  });

  it("per-rep at-risk reconciles and sums to office", async () => {
    const cov = await execRows(buildProjectionCoverageSql());
    const office = await getAtRiskWatchlist(tdb);
    let repSum = 0;
    for (const r of cov) {
      const repId = (r.rep_id as string | null) ?? null;
      const expected = n(r.m) - n(r.n);
      const watch = await getAtRiskWatchlist(tdb, { repId });
      expect(watch.summary.count).toBe(expected);
      repSum += watch.summary.count;
    }
    expect(repSum).toBe(office.summary.count);
  });

  it("buildAtRiskDealsSql excludes future-dated rows directly", async () => {
    const rows = await execRows(buildAtRiskDealsSql());
    expect(rows.every((r) => r.reason === "no_date" || r.reason === "stale_dated")).toBe(true);
  });
});
