import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@trock-crm/shared/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeBidAwardVariance } from "../../../src/mcp/tools/getBidAwardVariance.js";
import { WON_STAGE_SLUGS } from "../../../src/mcp/data/applyBaseDealFilters.js";
import type { TenantDb } from "../../../src/mcp/data/withOfficeSchema.js";

const u = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const ST_WON = u(901);
const ST_OPEN = u(902);
const REP_A = u(1);
const REP_B = u(2);
const TODAY = "(now() AT TIME ZONE 'America/Chicago')::date";

let pg: PGlite;
let db: TenantDb;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA office_test;
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, slug text NOT NULL, name text, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE office_test.deals (
      id uuid PRIMARY KEY, name text, assigned_rep_id uuid, stage_id uuid,
      won_closed_date date, on_hold boolean DEFAULT false, is_active boolean DEFAULT true,
      is_test_data boolean DEFAULT false, awarded_amount numeric, bid_estimate numeric
    );
    SET search_path TO office_test, public;
    INSERT INTO public.users (id, display_name) VALUES ('${REP_A}', 'Kaleb Marshall'), ('${REP_B}', 'Sidney Monroe');
    INSERT INTO public.pipeline_stage_config (id, slug, name, is_terminal) VALUES
      ('${ST_WON}',  '${WON_STAGE_SLUGS[0]}', 'Won', true),
      ('${ST_OPEN}', 'opportunity', 'Opportunity', false);

    -- Rep A: 5 qualifying won deals today -> variance % [10,-10,20,0,30]
    INSERT INTO office_test.deals (id, name, assigned_rep_id, stage_id, won_closed_date, bid_estimate, awarded_amount) VALUES
      ('${u(11)}', 'A1', '${REP_A}', '${ST_WON}', ${TODAY}, 100, 110),
      ('${u(12)}', 'A2', '${REP_A}', '${ST_WON}', ${TODAY}, 100, 90),
      ('${u(13)}', 'A3', '${REP_A}', '${ST_WON}', ${TODAY}, 200, 240),
      ('${u(14)}', 'A4', '${REP_A}', '${ST_WON}', ${TODAY}, 100, 100),
      ('${u(15)}', 'A5', '${REP_A}', '${ST_WON}', ${TODAY}, 100, 130),
      -- A6: qualifying but won in 2000 -> only counts under "all"
      ('${u(16)}', 'A6', '${REP_A}', '${ST_WON}', DATE '2000-01-01', 100, 100);

    -- Rep B: 2 qualifying won deals today -> variance % [20,-20]; lowSample
    INSERT INTO office_test.deals (id, name, assigned_rep_id, stage_id, won_closed_date, bid_estimate, awarded_amount) VALUES
      ('${u(21)}', 'B1', '${REP_B}', '${ST_WON}', ${TODAY}, 100, 120),
      ('${u(22)}', 'B2', '${REP_B}', '${ST_WON}', ${TODAY}, 100, 80);

    -- Won-in-window but NOT in the variance basis (missing award / missing bid)
    INSERT INTO office_test.deals (id, name, assigned_rep_id, stage_id, won_closed_date, bid_estimate, awarded_amount) VALUES
      ('${u(31)}', 'X1 no-award', '${REP_A}', '${ST_WON}', ${TODAY}, 100, NULL),
      ('${u(32)}', 'X2 no-bid',   '${REP_A}', '${ST_WON}', ${TODAY}, NULL, 150);

    -- Excluded entirely: on-hold won, and a non-won deal
    INSERT INTO office_test.deals (id, name, assigned_rep_id, stage_id, won_closed_date, on_hold, bid_estimate, awarded_amount) VALUES
      ('${u(41)}', 'X3 on-hold', '${REP_A}', '${ST_WON}',  ${TODAY}, true, 100, 100);
    INSERT INTO office_test.deals (id, name, assigned_rep_id, stage_id, bid_estimate, awarded_amount) VALUES
      ('${u(42)}', 'X4 open', '${REP_A}', '${ST_OPEN}', 100, 100);
  `);
  db = drizzle(pg, { schema }) as unknown as TenantDb;
});

afterAll(async () => {
  await pg?.close();
});

describe("computeBidAwardVariance (PGlite, synthetic Dallas data)", () => {
  it("computes per-rep n / avg / median / std-dev / dollar magnitude (ytd)", async () => {
    const res = await computeBidAwardVariance(db, "ytd");
    const a = res.rows.find((r) => r.rep === "Kaleb Marshall")!;
    expect(a.n).toBe(5);
    expect(a.avgVariancePct).toBe(10);
    expect(a.medianVariancePct).toBe(10);
    expect(a.variancePctStdDev).toBeCloseTo(15.81, 2);
    expect(a.dollarMagnitude).toBe(670); // 110+90+240+100+130
    expect(a.lowSample).toBe(false);
  });

  it("flags reps with fewer than 5 deals as lowSample", async () => {
    const res = await computeBidAwardVariance(db, "ytd");
    const b = res.rows.find((r) => r.rep === "Sidney Monroe")!;
    expect(b.n).toBe(2);
    expect(b.avgVariancePct).toBe(0);
    expect(b.medianVariancePct).toBe(0);
    expect(b.variancePctStdDev).toBeCloseTo(28.28, 2);
    expect(b.dollarMagnitude).toBe(200);
    expect(b.lowSample).toBe(true);
  });

  it("orders reps by n DESC and reports honest coverage", async () => {
    const res = await computeBidAwardVariance(db, "ytd");
    expect(res.rows.map((r) => r.rep)).toEqual(["Kaleb Marshall", "Sidney Monroe"]);
    // 9 won-in-window (5 A + 2 B + X1 + X2; on-hold & non-won & year-2000 excluded); 7 with both bid+award.
    expect(res.coverage.wonInWindow).toBe(9);
    expect(res.coverage.withVarianceBasis).toBe(7);
    expect(res.coverage.caption).toContain("7 of 9");
  });

  it("windows by won_closed_date: the year-2000 deal only counts under all-time", async () => {
    const ytd = await computeBidAwardVariance(db, "ytd");
    const all = await computeBidAwardVariance(db, "all");
    expect(ytd.rows.find((r) => r.rep === "Kaleb Marshall")!.n).toBe(5);
    expect(all.rows.find((r) => r.rep === "Kaleb Marshall")!.n).toBe(6);
    expect(all.coverage.withVarianceBasis).toBe(8);
  });
});
