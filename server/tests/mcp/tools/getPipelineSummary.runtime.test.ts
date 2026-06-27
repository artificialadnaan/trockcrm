import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@trock-crm/shared/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computePipelineSummary } from "../../../src/mcp/tools/getPipelineSummary.js";
import { WON_STAGE_SLUGS } from "../../../src/mcp/data/applyBaseDealFilters.js";
import type { TenantDb } from "../../../src/mcp/data/withOfficeSchema.js";

// Real Postgres (PGlite): won_closed_date is a real DATE, value columns real NUMERIC, the on-hold /
// active / test / terminal filters and the at-risk close-date predicate all execute for real.
const u = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const ST_WON = u(901);
const ST_OPEN = u(902);
const ST_LOST = u(903);
const REP = u(1);

let pg: PGlite;
let db: TenantDb;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA office_test;
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, role text, is_active boolean, is_test_data boolean);
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, slug text NOT NULL, name text, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE office_test.deals (
      id uuid PRIMARY KEY, name text, deal_number text, assigned_rep_id uuid, stage_id uuid,
      won_closed_date date, expected_close_date date, stage_entered_at timestamptz,
      on_hold boolean DEFAULT false, is_active boolean DEFAULT true, is_test_data boolean DEFAULT false,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric
    );
    SET search_path TO office_test, public;

    INSERT INTO public.users (id, display_name, role, is_active, is_test_data)
      VALUES ('${REP}', 'Kaleb Marshall', 'rep', true, false);
    INSERT INTO public.pipeline_stage_config (id, slug, name, is_terminal) VALUES
      ('${ST_WON}',  '${WON_STAGE_SLUGS[0]}', 'Won', true),
      ('${ST_OPEN}', 'opportunity',           'Opportunity', false),
      ('${ST_LOST}', 'closed_lost',           'Lost', true);

    -- WON: W1/W2 won today (in every window); W6 won in 2000 (only in "all").
    -- W3 on-hold, W4 test-data, W5 inactive -> all excluded by applyBaseDealFilters.
    INSERT INTO office_test.deals (id, name, assigned_rep_id, stage_id, won_closed_date, on_hold, is_active, is_test_data, awarded_amount, bid_estimate, stage_entered_at) VALUES
      ('${u(11)}', 'W1 awarded',  '${REP}', '${ST_WON}', (now() AT TIME ZONE 'America/Chicago')::date, false, true,  false, 100000, NULL,  '2026-01-01'),
      ('${u(12)}', 'W2 bid-only', '${REP}', '${ST_WON}', (now() AT TIME ZONE 'America/Chicago')::date, false, true,  false, NULL,   50000, '2026-01-01'),
      ('${u(13)}', 'W3 on-hold',  '${REP}', '${ST_WON}', (now() AT TIME ZONE 'America/Chicago')::date, true,  true,  false, 88888,  NULL,  '2026-01-01'),
      ('${u(14)}', 'W4 test',     '${REP}', '${ST_WON}', (now() AT TIME ZONE 'America/Chicago')::date, false, true,  true,  77777,  NULL,  '2026-01-01'),
      ('${u(15)}', 'W5 inactive', '${REP}', '${ST_WON}', (now() AT TIME ZONE 'America/Chicago')::date, false, false, false, 66666,  NULL,  '2026-01-01'),
      ('${u(16)}', 'W6 year2000', '${REP}', '${ST_WON}', DATE '2000-01-01',                             false, true,  false, 999,    NULL,  '2026-01-01');

    -- ACTIVE (open / non-terminal). A2 (no date) + A3 (past date) are also STALLED (at-risk).
    -- A1 has a far-future date -> active but not stalled. A4 on-hold, A5 test -> excluded everywhere.
    INSERT INTO office_test.deals (id, name, assigned_rep_id, stage_id, expected_close_date, on_hold, is_active, is_test_data, awarded_amount, bid_estimate, stage_entered_at) VALUES
      ('${u(21)}', 'A1 future', '${REP}', '${ST_OPEN}', (now() AT TIME ZONE 'America/Chicago')::date + 7, false, true,  false, 30000, NULL,  '2026-01-01'),
      ('${u(22)}', 'A2 no-date','${REP}', '${ST_OPEN}', NULL,                                                false, true,  false, NULL,  20000, '2026-01-01'),
      ('${u(23)}', 'A3 past',   '${REP}', '${ST_OPEN}', DATE '2020-01-01',                                   false, true,  false, 40000, NULL,  '2026-01-01'),
      ('${u(24)}', 'A4 on-hold','${REP}', '${ST_OPEN}', NULL,                                                true,  true,  false, 11111, NULL,  '2026-01-01'),
      ('${u(25)}', 'A5 test',   '${REP}', '${ST_OPEN}', NULL,                                                false, true,  true,  22222, NULL,  '2026-01-01');
  `);
  db = drizzle(pg, { schema }) as unknown as TenantDb;
});

afterAll(async () => {
  await pg?.close();
});

function seg(rows: { segment: string; count: number; value: number }[], name: string) {
  const r = rows.find((x) => x.segment === name);
  if (!r) throw new Error(`missing segment ${name}`);
  return r;
}

describe("computePipelineSummary (PGlite, synthetic Dallas data)", () => {
  it("returns exactly the three chartable segments in order", async () => {
    const rows = await computePipelineSummary(db, "all");
    expect(rows.map((r) => r.segment)).toEqual(["Won", "Active", "Stalled"]);
  });

  it("Won: excludes on-hold / test-data / inactive; values via awarded-first chain (all-time)", async () => {
    const won = seg(await computePipelineSummary(db, "all"), "Won");
    expect(won.count).toBe(3); // W1, W2, W6
    expect(won.value).toBe(150999); // 100000 + 50000 (bid fallback) + 999
  });

  it("Won: the won_closed_date window drops the year-2000 deal under ytd", async () => {
    const won = seg(await computePipelineSummary(db, "ytd"), "Won");
    expect(won.count).toBe(2); // W1, W2 (W6 is out of window)
    expect(won.value).toBe(150000);
  });

  it("Active: open non-terminal deals only (on-hold/test excluded), open best-estimate value", async () => {
    const active = seg(await computePipelineSummary(db, "all"), "Active");
    expect(active.count).toBe(3); // A1, A2, A3
    expect(active.value).toBe(90000); // 30000 + 20000 + 40000
  });

  it("Stalled: reuses the at-risk watchlist (missing/past close date), not a new threshold", async () => {
    const stalled = seg(await computePipelineSummary(db, "all"), "Stalled");
    expect(stalled.count).toBe(2); // A2 (no date) + A3 (past); A1 future excluded
    expect(stalled.value).toBe(60000); // 20000 + 40000
  });
});
