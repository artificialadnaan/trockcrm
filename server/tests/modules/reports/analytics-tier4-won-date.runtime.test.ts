import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getMarketMixReport } from "../../../src/modules/reports/analytics-tier4-service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) by-construction proof for the analytics-tier4 Won-date migration (PR D):
 * getMarketMixReport's quarterly Won-by-vertical buckets each won deal into the quarter of its
 * canonical deals.won_closed_date (not the reseed-contaminated actual_close_date), and excludes
 * Won-stage deals with no usable won date.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON_SLUG = WON_STAGE_SLUGS[0];
const ST = { won: U("57001") };
const REP_A = U("a01");
const D = { w1: U("11001"), w2: U("11002") };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;
const RANGE = { from: "2026-01-01", to: "2026-12-31" };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE companies (id uuid PRIMARY KEY, industry text, region text);
    CREATE TABLE properties (id uuid PRIMARY KEY, property_type text, type text, city text, state text);
    CREATE TABLE region_config (id uuid PRIMARY KEY, name text);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, company_id uuid, property_id uuid, region_id uuid, assigned_rep_id uuid, stage_id uuid NOT NULL,
      is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false,
      project_type text, property_city text, property_state text,
      won_closed_date date, actual_close_date date, updated_at timestamptz, created_at timestamptz,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric
    );
    INSERT INTO users (id, display_name) VALUES ('${REP_A}','Alice');
    INSERT INTO pipeline_stage_config (id, slug, is_terminal) VALUES ('${ST.won}','${WON_SLUG}', true);

    -- W1: WON, won_closed_date in Q2 (Apr) but actual_close_date in Q1 (Jan) -> must bucket Q2
    INSERT INTO deals (id, assigned_rep_id, stage_id, project_type, won_closed_date, actual_close_date, updated_at, created_at, awarded_amount) VALUES
      ('${D.w1}','${REP_A}','${ST.won}','Roofing','2026-04-15','2026-01-10','2026-01-10T00:00:00Z','2026-01-05T00:00:00Z', 100000),
      -- W2: WON stage, NO won date (only contaminated actual_close_date) -> excluded from quarterly
      ('${D.w2}','${REP_A}','${ST.won}','Roofing', NULL, '2026-03-01','2026-03-01T00:00:00Z','2026-02-01T00:00:00Z', 50000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("getMarketMixReport quarterly Won value buckets by canonical won_closed_date (PR D)", () => {
  it("a won deal lands in its won_closed_date quarter; a null-won-date win is excluded", async () => {
    const report = await getMarketMixReport(tdb, RANGE);
    const q = report.quarterlyWonByVertical;

    // exactly one quarterly entry: W1 in 2026 Q2, $100k; W2 (null won date) absent.
    expect(q.length).toBe(1);
    expect(q[0].quarter).toBe("2026 Q2"); // won_closed_date Apr — NOT the actual_close_date Jan (Q1)
    expect(q[0].wonValue).toBeCloseTo(100000, 2);
    expect(q.some((r) => r.quarter === "2026 Q1")).toBe(false);
  });
});
