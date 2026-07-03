import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getMarketMixReport } from "../../../src/modules/reports/analytics-tier4-service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) by-construction proof for the analytics-tier4 Won-date migration (PR D).
 * getMarketMixReport's quarterly Won-by-vertical buckets each won deal into the quarter of its
 * canonical deals.won_closed_date (not the reseed-contaminated actual_close_date), excludes
 * Won-stage deals with no usable won date, and — running under a NON-UTC session (Asia/Tokyo,
 * UTC+9, like office_dallas runs non-UTC) — counts a win whose won_closed_date equals the period
 * start. The pre-fix buildWhere bounds (`AT TIME ZONE 'UTC'`) would have dropped that boundary win
 * under a UTC+ session (Codex P2); the date-typed bounds don't.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON_SLUG = WON_STAGE_SLUGS[0];
const ST = { won: U("57001") };
const REP_A = U("a01");
const D = { w1: U("11001"), w2: U("11002"), boundary: U("11003") };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;
const RANGE = { from: "2026-01-01", to: "2026-12-31" };

beforeAll(async () => {
  pg = new PGlite();
  // Non-UTC session: surfaces the AT-TIME-ZONE-'UTC' boundary bug the fix removes.
  await pg.exec(`SET TimeZone='Asia/Tokyo';`);
  await pg.exec(`
    CREATE TABLE companies (id uuid PRIMARY KEY, industry text, region text);
    CREATE TABLE properties (id uuid PRIMARY KEY, property_type text, type text, city text, state text);
    CREATE TABLE region_config (id uuid PRIMARY KEY, name text);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid, company_id uuid, property_id uuid, region_id uuid, assigned_rep_id uuid, stage_id uuid NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false,
      project_type text, property_city text, property_state text,
      won_closed_date date, actual_close_date date, updated_at timestamptz, created_at timestamptz,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric
    );
    CREATE TABLE deal_change_orders (
      id uuid PRIMARY KEY, deal_id uuid NOT NULL, signed_date date NOT NULL,
      amount numeric(14,2) NOT NULL, description text, created_at timestamptz NOT NULL DEFAULT NOW()
    );
    INSERT INTO users (id, display_name) VALUES ('${REP_A}','Alice');
    INSERT INTO pipeline_stage_config (id, slug, is_terminal) VALUES ('${ST.won}','${WON_SLUG}', true);

    -- W1: WON, won_closed_date in Q2 (Apr) but actual_close_date in Q1 (Jan) -> must bucket Q2
    INSERT INTO deals (id, assigned_rep_id, stage_id, project_type, won_closed_date, actual_close_date, updated_at, created_at, awarded_amount) VALUES
      ('${D.w1}','${REP_A}','${ST.won}','Roofing','2026-04-15','2026-01-10','2026-01-10T00:00:00Z','2026-01-05T00:00:00Z', 100000),
      -- W2: WON stage, NO won date (only contaminated actual_close_date) -> excluded from quarterly
      ('${D.w2}','${REP_A}','${ST.won}','Roofing', NULL, '2026-03-01','2026-03-01T00:00:00Z','2026-02-01T00:00:00Z', 50000),
      -- BOUNDARY: WON, won_closed_date == period start (2026-01-01, Q1). Must be counted even under a
      -- UTC+ session (date-typed bounds); the old AT-TIME-ZONE-'UTC' bounds would have dropped it.
      ('${D.boundary}','${REP_A}','${ST.won}','Roofing','2026-01-01','2026-01-01','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z', 30000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("getMarketMixReport quarterly Won value buckets by canonical won_closed_date (PR D)", () => {
  it("buckets by won date, excludes null-won-date, and counts a period-edge win under a non-UTC session", async () => {
    const report = await getMarketMixReport(tdb, RANGE);
    const q = report.quarterlyWonByVertical;

    // Two entries (W2 null-won excluded): Q1 (boundary) + Q2 (W1), ordered by quarter ASC.
    expect(q.map((r) => r.quarter)).toEqual(["2026 Q1", "2026 Q2"]);
    const q1 = q.find((r) => r.quarter === "2026 Q1")!;
    const q2 = q.find((r) => r.quarter === "2026 Q2")!;
    // Boundary win (won_closed_date == from) is COUNTED despite the UTC+9 session (the TZ fix).
    expect(q1.wonValue).toBeCloseTo(30000, 2);
    // W1 buckets by won_closed_date (Apr/Q2), NOT its actual_close_date (Jan/Q1).
    expect(q2.wonValue).toBeCloseTo(100000, 2);
    // W2 (null won date) never appears.
    expect(q.some((r) => Math.abs(r.wonValue - 50000) < 0.01)).toBe(false);
  });
});
