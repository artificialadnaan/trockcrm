import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  getWinLossRatioByRep,
  getRevenueByProjectType,
  getClosedWonSummary,
} from "../../../src/modules/reports/service.js";
import { WON_STAGE_SLUGS, LOST_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) by-construction reconciliation for the reports/service.ts Won-date migration
 * (PR C). Runs the LIVE service functions against a seeded DB:
 *  - getWinLossRatioByRep: WON wins/value windowed by canonical won_closed_date (touched-but-not-won
 *    and out-of-window wins excluded); LOST losses preserved on their own arm (denominator unchanged).
 *  - getRevenueByProjectType + getClosedWonSummary: won-only totals windowed by won_closed_date.
 *  - getClosedWonSummary cycle-time computed from won_closed_date (not the contaminated
 *    actual_close_date).
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON_SLUG = WON_STAGE_SLUGS[0];
const LOST_SLUG = LOST_STAGE_SLUGS[0];
const REP_A = U("a01");
const ST = { won: U("57001"), lost: U("57002"), open: U("57003") };
const PT = U("70001");
const D = {
  w1: U("11001"), w2: U("11002"), w3: U("11003"),
  l1: U("11004"), l2: U("11005"), o1: U("11006"),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;
const RANGE = { from: "2026-03-01", to: "2026-03-31" };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text NOT NULL);
    CREATE TABLE project_type_config (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid, assigned_rep_id uuid, stage_id uuid NOT NULL, project_type_id uuid,
      is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false,
      won_closed_date date, actual_close_date date, lost_at timestamptz, updated_at timestamptz, created_at timestamptz,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric
    );
    CREATE TABLE deal_change_orders (
      id uuid PRIMARY KEY, deal_id uuid NOT NULL, signed_date date NOT NULL,
      amount numeric(14,2) NOT NULL, description text, created_at timestamptz NOT NULL DEFAULT NOW()
    );
    INSERT INTO users (id, display_name) VALUES ('${REP_A}','Alice');
    INSERT INTO project_type_config (id, name) VALUES ('${PT}','Roofing');
    INSERT INTO pipeline_stage_config (id, slug, is_terminal) VALUES
      ('${ST.won}','${WON_SLUG}', true), ('${ST.lost}','${LOST_SLUG}', true), ('${ST.open}','opportunity', false);

    -- window = 2026-03-01 .. 2026-03-31
    INSERT INTO deals (id, assigned_rep_id, stage_id, project_type_id, won_closed_date, actual_close_date, lost_at, updated_at, created_at, awarded_amount) VALUES
      -- W1: WON, canonical in-window; actual_close_date deliberately far off to prove cycle-time uses won_closed_date
      ('${D.w1}','${REP_A}','${ST.won}','${PT}','2026-03-15','2026-01-01', NULL, '2026-01-01T00:00:00Z','2026-03-01T00:00:00Z', 100000),
      -- W2: WON stage, NO won date, touched/closed in-window -> excluded
      ('${D.w2}','${REP_A}','${ST.won}','${PT}', NULL, '2026-03-10', NULL, '2026-03-10T00:00:00Z','2026-02-01T00:00:00Z', 50000),
      -- W3: WON, won date OUTSIDE window, updated in-window -> excluded
      ('${D.w3}','${REP_A}','${ST.won}','${PT}','2026-02-01','2026-03-10', NULL, '2026-03-10T00:00:00Z','2026-01-01T00:00:00Z', 77000),
      -- L1: LOST, lost_at in-window -> counted (loss preserved on its own arm)
      ('${D.l1}','${REP_A}','${ST.lost}','${PT}', NULL, NULL, '2026-03-12T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z', NULL),
      -- L2: LOST, lost_at out-of-window -> not counted
      ('${D.l2}','${REP_A}','${ST.lost}','${PT}', NULL, NULL, '2026-01-05T00:00:00Z','2026-01-05T00:00:00Z','2026-01-05T00:00:00Z', NULL),
      -- O1: OPEN (non-terminal) -> never in won/loss or won-only totals
      ('${D.o1}','${REP_A}','${ST.open}','${PT}', NULL, NULL, NULL, '2026-03-10T00:00:00Z','2026-03-01T00:00:00Z', 20000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("reports/service.ts Won-date migration reconciles by construction (PR C)", () => {
  it("getWinLossRatioByRep: wins on won_closed_date, losses preserved on lost arm", async () => {
    const rows = await getWinLossRatioByRep(tdb, RANGE);
    expect(rows.length).toBe(1);
    const a = rows[0];
    expect(a.wins).toBe(1); // W1 only — W2 (no won date) and W3 (out of window) excluded
    expect(a.losses).toBe(1); // L1 only — lost denominator preserved on its own arm
    expect(a.winRate).toBe(50);
    expect(a.totalValue).toBeCloseTo(100000, 2); // canonical won value (W1)
  });

  it("getRevenueByProjectType: won-only revenue windowed by won_closed_date", async () => {
    const rows = await getRevenueByProjectType(tdb, RANGE);
    const roofing = rows.find((r) => r.projectTypeName === "Roofing");
    expect(roofing?.dealCount).toBe(1); // W1 only
    expect(roofing?.totalRevenue).toBeCloseTo(100000, 2);
  });

  it("getClosedWonSummary: totals + cycle-time from won_closed_date", async () => {
    const s = await getClosedWonSummary(tdb, RANGE);
    expect(s.totalWonDeals).toBe(1); // W1 only (W2 null-won-date and W3 out-of-window excluded)
    expect(s.totalWonValue).toBeCloseTo(100000, 2);
    // cycle = won_closed_date(2026-03-15) - created_at(2026-03-01) = 14 days; actual_close_date(2026-01-01)
    // would have produced a negative cycle, so this pins the canonical basis.
    expect(s.avgCycleTimeDays).toBe(14);
  });
});
