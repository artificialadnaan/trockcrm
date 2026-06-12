import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import { readWonToday, readAdvancedToday } from "../src/modules/daily-summary/service.js";

// Real-types harness (the hand-rolled-schema lesson, bitten 3×): won_closed_date is a real DATE, the value
// columns are real NUMERIC, the stage-slug filter uses a real text[] ANY(), and stage history is timestamptz
// windowed through AT TIME ZONE. A text-typed shortcut would hide a date/numeric/array mismatch.
let db: PGlite;
const client = () => ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as unknown[]) }) as never;

const DATE = "2026-06-12";
const REP_A = "11111111-1111-1111-1111-111111111111";
const ST_WON = "22222222-2222-2222-2222-222222222221";
const ST_OPP = "22222222-2222-2222-2222-222222222222";
const ST_EST = "22222222-2222-2222-2222-222222222223";
const ST_NEG = "22222222-2222-2222-2222-222222222224";
const ST_LOST = "22222222-2222-2222-2222-222222222225";
const WON_SLUG = WON_DEAL_STAGE_SLUGS[0];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA office_test;
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, slug text NOT NULL, name text, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE office_test.deals (
      id uuid PRIMARY KEY,
      name text,
      assigned_rep_id uuid,
      stage_id uuid,
      won_closed_date date,
      on_hold boolean,
      awarded_amount numeric,
      bid_board_total_sales numeric,
      bid_estimate numeric,
      dd_estimate numeric,
      is_test_data boolean
    );
    CREATE TABLE office_test.deal_stage_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid,
      from_stage_id uuid,
      to_stage_id uuid,
      created_at timestamptz NOT NULL
    );
    INSERT INTO public.users (id, display_name) VALUES ('${REP_A}', 'Kaleb Marshall');
    INSERT INTO public.pipeline_stage_config (id, slug, name, is_terminal) VALUES
      ('${ST_WON}', '${WON_SLUG}', 'Won', true),
      ('${ST_OPP}', 'opportunity', 'Opportunity', false),
      ('${ST_EST}', 'estimating', 'Estimating', false),
      ('${ST_NEG}', 'negotiation', 'Negotiation', false),
      ('${ST_LOST}', 'closed_lost', 'Lost', true);
  `);

  // ---- Won-today fixtures ----
  await db.exec(`
    INSERT INTO office_test.deals (id, name, assigned_rep_id, stage_id, won_closed_date, on_hold, awarded_amount, bid_estimate, is_test_data) VALUES
      ('${uuid(1)}', 'Anthem on Ashley', '${REP_A}', '${ST_WON}', '2026-06-12', false, 186000, NULL, false),
      ('${uuid(2)}', '2711 N Haskell',  NULL,       '${ST_WON}', '2026-06-12', false, NULL,   126000, false),
      ('${uuid(3)}', 'Won Yesterday',   '${REP_A}', '${ST_WON}', '2026-06-11', false, 50000,  NULL, false),
      ('${uuid(4)}', 'Test Deal',       '${REP_A}', '${ST_WON}', '2026-06-12', false, 99999,  NULL, true),
      ('${uuid(5)}', 'On Hold Won',     '${REP_A}', '${ST_WON}', '2026-06-12', true,  88888,  NULL, false),
      ('${uuid(6)}', 'Not A Won Stage', '${REP_A}', '${ST_EST}', '2026-06-12', NULL,  77777,  NULL, false);
  `);

  // ---- Advanced-today fixtures (stage history) ----
  // DA "The Hayward": two moves today; DISTINCT ON keeps the latest (Estimating -> Negotiation).
  await db.exec(`
    INSERT INTO office_test.deals (id, name, assigned_rep_id, stage_id) VALUES
      ('${uuid(10)}', 'The Hayward',   '${REP_A}', '${ST_NEG}'),
      ('${uuid(11)}', 'Closed Deal',   '${REP_A}', '${ST_WON}'),
      ('${uuid(12)}', 'Lost Deal',     '${REP_A}', '${ST_LOST}'),
      ('${uuid(13)}', 'Yesterday Move','${REP_A}', '${ST_EST}');
    INSERT INTO office_test.deal_stage_history (deal_id, from_stage_id, to_stage_id, created_at) VALUES
      ('${uuid(10)}', '${ST_OPP}', '${ST_EST}', '2026-06-12 13:00:00-05'),
      ('${uuid(10)}', '${ST_EST}', '${ST_NEG}', '2026-06-12 14:00:00-05'),
      ('${uuid(11)}', '${ST_NEG}', '${ST_WON}', '2026-06-12 15:00:00-05'),
      ('${uuid(12)}', '${ST_NEG}', '${ST_LOST}','2026-06-12 15:30:00-05'),
      ('${uuid(13)}', '${ST_OPP}', '${ST_EST}', '2026-06-11 13:00:00-05');
  `);
});
afterAll(async () => { await db?.close(); });

function uuid(n: number): string {
  return `33333333-3333-3333-3333-${String(n).padStart(12, "0")}`;
}

describe("readWonToday — canonical won_closed_date cohort + effective-won value", () => {
  it("returns exactly today's reportable, non-test, non-held won deals, valued awarded-first, value-desc", async () => {
    const won = await readWonToday(client(), "office_test", DATE);
    expect(won.map((d) => d.dealName)).toEqual(["Anthem on Ashley", "2711 N Haskell"]);
    expect(won.map((d) => d.value)).toEqual([186000, 126000]); // awarded-first: D2 falls back to bid_estimate
    expect(won[1].repName).toBe("Unassigned"); // null rep -> honest label, never blank
  });
  it("the header reconciles: count and total derive from the same returned set", async () => {
    const won = await readWonToday(client(), "office_test", DATE);
    expect(won.length).toBe(2);
    expect(won.reduce((s, d) => s + d.value, 0)).toBe(312000); // exactly the '$312K' headline
  });
  it("excludes yesterday's win, test data, on-hold deals, and non-won stages", async () => {
    const won = await readWonToday(client(), "office_test", DATE);
    const names = won.map((d) => d.dealName);
    expect(names).not.toContain("Won Yesterday");
    expect(names).not.toContain("Test Deal");
    expect(names).not.toContain("On Hold Won");
    expect(names).not.toContain("Not A Won Stage");
  });
});

describe("readAdvancedToday — non-terminal moves, latest-per-deal", () => {
  it("lists a deal once at its latest transition; excludes moves into Won/Lost and prior days", async () => {
    const adv = await readAdvancedToday(client(), "office_test", DATE);
    expect(adv.length).toBe(1);
    expect(adv[0]).toMatchObject({ dealName: "The Hayward", fromStage: "Estimating", toStage: "Negotiation" });
  });
});
