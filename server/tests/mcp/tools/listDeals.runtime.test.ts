import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@trock-crm/shared/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeListDeals, clampLimit } from "../../../src/mcp/tools/listDeals.js";
import { WON_STAGE_SLUGS } from "../../../src/mcp/data/applyBaseDealFilters.js";
import type { TenantDb } from "../../../src/mcp/data/withOfficeSchema.js";

const u = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const ST_OPEN = u(902);
const ST_WON = u(901);
const REP_A = u(1);
const REP_B = u(2);

let pg: PGlite;
let db: TenantDb;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA office_test;
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, slug text NOT NULL, name text, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE office_test.deals (
      id uuid PRIMARY KEY, name text, deal_number text, assigned_rep_id uuid, stage_id uuid,
      won_closed_date date, expected_close_date date,
      on_hold boolean DEFAULT false, is_active boolean DEFAULT true, is_test_data boolean DEFAULT false,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric
    );
    SET search_path TO office_test, public;
    INSERT INTO public.users (id, display_name) VALUES ('${REP_A}', 'Kaleb Marshall'), ('${REP_B}', 'Sidney Monroe');
    INSERT INTO public.pipeline_stage_config (id, slug, name, is_terminal) VALUES
      ('${ST_OPEN}', 'opportunity', 'Opportunity', false),
      ('${ST_WON}',  '${WON_STAGE_SLUGS[0]}', 'Won', true);
    INSERT INTO office_test.deals (id, name, deal_number, assigned_rep_id, stage_id, won_closed_date, expected_close_date, on_hold, is_active, is_test_data, awarded_amount, bid_estimate) VALUES
      ('${u(11)}', 'D1 Anthem',  'DFW-1', '${REP_A}', '${ST_OPEN}', NULL,         DATE '2026-03-01', false, true,  false, 100000, NULL),
      ('${u(12)}', 'D2 Haskell', 'DFW-2', '${REP_B}', '${ST_OPEN}', NULL,         DATE '2026-09-01', false, true,  false, NULL,   50000),
      ('${u(13)}', 'D3 Tower',   'DFW-3', '${REP_A}', '${ST_WON}',  DATE '2026-02-01', NULL,         false, true,  false, 200000, NULL),
      ('${u(14)}', 'D4 OnHold',  'DFW-4', '${REP_A}', '${ST_OPEN}', NULL,         DATE '2026-03-01', true,  true,  false, 999,    NULL),
      ('${u(15)}', 'D5 Test',    'DFW-5', '${REP_A}', '${ST_OPEN}', NULL,         DATE '2026-03-01', false, true,  true,  888,    NULL),
      ('${u(16)}', 'D6 Inactive','DFW-6', '${REP_A}', '${ST_OPEN}', NULL,         DATE '2026-03-01', false, false, false, 777,    NULL);
  `);
  db = drizzle(pg, { schema }) as unknown as TenantDb;
});

afterAll(async () => {
  await pg?.close();
});

describe("clampLimit", () => {
  it("defaults to 25, floors at 1, caps at 100, truncates", () => {
    expect(clampLimit(undefined)).toBe(25);
    expect(clampLimit(5)).toBe(5);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-3)).toBe(1);
    expect(clampLimit(500)).toBe(100);
    expect(clampLimit(33.7)).toBe(33);
  });
});

describe("computeListDeals (PGlite, synthetic Dallas data)", () => {
  it("lists reportable deals (excludes on-hold/test/inactive), value DESC", async () => {
    const rows = await computeListDeals(db, {});
    expect(rows.map((r) => r.name)).toEqual(["D3 Tower", "D1 Anthem", "D2 Haskell"]);
    expect(rows[0]).toMatchObject({ stage: "Won", owner: "Kaleb Marshall", value: 200000 });
  });

  it("filters by stage (slug or name fragment)", async () => {
    const rows = await computeListDeals(db, { stage: "won" });
    expect(rows.map((r) => r.name)).toEqual(["D3 Tower"]);
  });

  it("filters by owner name fragment (case-insensitive)", async () => {
    const rows = await computeListDeals(db, { owner: "sidney" });
    expect(rows.map((r) => r.name)).toEqual(["D2 Haskell"]);
  });

  it("filters by value range", async () => {
    expect((await computeListDeals(db, { minValue: 60000 })).map((r) => r.name)).toEqual([
      "D3 Tower",
      "D1 Anthem",
    ]);
    expect((await computeListDeals(db, { maxValue: 60000 })).map((r) => r.name)).toEqual(["D2 Haskell"]);
  });

  it("filters by expected close-date window", async () => {
    const rows = await computeListDeals(db, { closeDateFrom: "2026-06-01" });
    expect(rows.map((r) => r.name)).toEqual(["D2 Haskell"]); // only D2 closes after Jun 1
  });

  it("respects the limit", async () => {
    expect(await computeListDeals(db, { limit: 1 })).toHaveLength(1);
  });
});
