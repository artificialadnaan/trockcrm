import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import { readWonToday, readAdvancedToday, readHourly } from "../src/modules/daily-summary/service.js";

// Real-types harness (the hand-rolled-schema lesson, bitten 3×): won_closed_date is a real DATE, the value
// columns are real NUMERIC, the stage-slug filter uses a real text[] ANY(), and stage history is timestamptz
// windowed through AT TIME ZONE. A text-typed shortcut would hide a date/numeric/array mismatch.
let db: PGlite;
const client = () => ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as unknown[]) }) as never;

const DATE = "2026-06-12";
const REP_A = "11111111-1111-1111-1111-111111111111";
const REP_B = "11111111-1111-1111-1111-111111111112";
const REP_C = "11111111-1111-1111-1111-111111111113"; // director — excluded from hourly
const REP_D = "11111111-1111-1111-1111-111111111114"; // inactive rep — excluded from hourly
const IMP = "11111111-1111-1111-1111-1111111111ff"; // impersonator
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
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, role text, is_active boolean, is_test_data boolean);
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, slug text NOT NULL, name text, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE office_test.usage_session (id uuid PRIMARY KEY, user_id uuid, impersonator_id uuid);
    CREATE TABLE office_test.usage_heartbeat (id bigint, session_id uuid, user_id uuid, at timestamptz);
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
      changed_by uuid,
      is_backward_move boolean,
      created_at timestamptz NOT NULL
    );
    INSERT INTO public.users (id, display_name, role, is_active, is_test_data) VALUES
      ('${REP_A}', 'Kaleb Marshall', 'rep',      true,  false),
      ('${REP_B}', 'Sidney Monroe',  'rep',      true,  false),
      ('${REP_C}', 'Dana Director',  'director', true,  false),
      ('${REP_D}', 'Ivan Inactive',  'rep',      false, false),
      ('${IMP}',   'Admin Imp',      'admin',    true,  false);
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
  // DA "The Hayward": two non-terminal moves today; latest (Est->Neg) was made by REP_B (Sidney), while
  // the deal is ASSIGNED to REP_A — so the row must attribute to the mover, not the assignee.
  await db.exec(`
    INSERT INTO office_test.deals (id, name, assigned_rep_id, stage_id, is_test_data) VALUES
      ('${uuid(10)}', 'The Hayward',      '${REP_A}', '${ST_NEG}',  false),
      ('${uuid(11)}', 'Closed Deal',      '${REP_A}', '${ST_WON}',  false),
      ('${uuid(12)}', 'Lost Deal',        '${REP_A}', '${ST_LOST}', false),
      ('${uuid(13)}', 'Yesterday Move',   '${REP_A}', '${ST_EST}',  false),
      ('${uuid(14)}', 'Promoted then Won','${REP_A}', '${ST_WON}',  false),
      ('${uuid(15)}', 'Bounced Back',     '${REP_A}', '${ST_OPP}',  false),
      ('${uuid(16)}', 'Test Advanced',    '${REP_A}', '${ST_EST}',  true);
    INSERT INTO office_test.deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_by, is_backward_move, created_at) VALUES
      ('${uuid(10)}', '${ST_OPP}', '${ST_EST}', '${REP_A}', false, '2026-06-12 13:00:00-05'),
      ('${uuid(10)}', '${ST_EST}', '${ST_NEG}', '${REP_B}', false, '2026-06-12 14:00:00-05'),
      ('${uuid(11)}', '${ST_NEG}', '${ST_WON}', '${REP_A}', false, '2026-06-12 15:00:00-05'),
      ('${uuid(12)}', '${ST_NEG}', '${ST_LOST}','${REP_A}', false, '2026-06-12 15:30:00-05'),
      ('${uuid(13)}', '${ST_OPP}', '${ST_EST}', '${REP_A}', false, '2026-06-11 13:00:00-05'),
      ('${uuid(14)}', '${ST_EST}', '${ST_NEG}', '${REP_A}', false, '2026-06-12 13:00:00-05'),
      ('${uuid(14)}', '${ST_NEG}', '${ST_WON}', '${REP_A}', false, '2026-06-12 15:00:00-05'),
      ('${uuid(15)}', '${ST_OPP}', '${ST_EST}', '${REP_A}', false, '2026-06-12 13:00:00-05'),
      ('${uuid(15)}', '${ST_EST}', '${ST_OPP}', '${REP_A}', true,  '2026-06-12 14:00:00-05'),
      ('${uuid(16)}', '${ST_OPP}', '${ST_EST}', '${REP_A}', false, '2026-06-12 13:00:00-05');
  `);

  // ---- Hourly fixtures: only active non-test reps on NON-impersonated sessions should count ----
  const S_A = "44444444-4444-4444-4444-000000000001"; // REP_A, real session
  const S_BIMP = "44444444-4444-4444-4444-000000000002"; // REP_B, IMPERSONATED → excluded
  const S_C = "44444444-4444-4444-4444-000000000003"; // REP_C director → excluded by role
  const S_D = "44444444-4444-4444-4444-000000000004"; // REP_D inactive → excluded
  await db.exec(`
    INSERT INTO office_test.usage_session (id, user_id, impersonator_id) VALUES
      ('${S_A}',    '${REP_A}', NULL),
      ('${S_BIMP}', '${REP_B}', '${IMP}'),
      ('${S_C}',    '${REP_C}', NULL),
      ('${S_D}',    '${REP_D}', NULL);
    INSERT INTO office_test.usage_heartbeat (id, session_id, user_id, at) VALUES
      (1, '${S_A}',    '${REP_A}', '2026-06-12 13:10:00-05'),
      (2, '${S_A}',    '${REP_A}', '2026-06-12 14:10:00-05'),
      (3, '${S_BIMP}', '${REP_B}', '2026-06-12 13:20:00-05'),
      (4, '${S_C}',    '${REP_C}', '2026-06-12 13:30:00-05'),
      (5, '${S_D}',    '${REP_D}', '2026-06-12 13:40:00-05');
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

describe("readAdvancedToday — latest move per deal, terminal/backward-aware, mover-attributed", () => {
  it("lists a deal once at its latest transition, attributed to the mover (changed_by, not the assignee)", async () => {
    const adv = await readAdvancedToday(client(), "office_test", DATE);
    expect(adv.length).toBe(1);
    expect(adv[0]).toMatchObject({
      dealName: "The Hayward",
      fromStage: "Estimating",
      toStage: "Negotiation",
      repName: "Sidney Monroe", // the mover (changed_by REP_B), NOT the assignee (REP_A)
    });
  });
  it("excludes a deal whose LATEST move was terminal (advanced→Won same day is not 'advanced')", async () => {
    const adv = await readAdvancedToday(client(), "office_test", DATE);
    expect(adv.map((a) => a.dealName)).not.toContain("Promoted then Won");
  });
  it("excludes a deal whose latest move was a backward move, and test/terminal/prior-day deals", async () => {
    const adv = await readAdvancedToday(client(), "office_test", DATE);
    const names = adv.map((a) => a.dealName);
    expect(names).not.toContain("Bounced Back");   // latest move is_backward_move = true
    expect(names).not.toContain("Test Advanced");  // is_test_data = true
    expect(names).not.toContain("Closed Deal");     // moved into Won (terminal)
    expect(names).not.toContain("Lost Deal");       // moved into Lost (terminal)
    expect(names).not.toContain("Yesterday Move");  // prior day
  });
});

describe("readHourly — scoped to the same population as the headline/leaderboard", () => {
  it("counts only active non-test reps on non-impersonated sessions (excludes imp/director/inactive)", async () => {
    const hourly = await readHourly(client(), "office_test", DATE);
    // REP_A (real session) counts at 13 and 14; REP_B (impersonated), REP_C (director), REP_D (inactive)
    // are all excluded — so each hour shows exactly 1, never 4.
    expect(hourly).toEqual([{ hour: 13, reps: 1 }, { hour: 14, reps: 1 }]);
  });
});
