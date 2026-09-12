// Real-types (PGlite) coverage for "no automated task on a closed deal".
//
// THE BUG (prod, 2026-09-12): the daily generators never consulted the deal's stage, so Won/Lost deals kept
// being handed fresh follow-ups. DFW-4-22226-ag went Won on 2026-08-10 and was minted a
// "Follow up: … closes 2026-09-10" task on 2026-09-03 — 24 days after it closed. Office-wide: 3,395 open
// tasks sat on terminal deals across 14 reps.
//
// It was self-sustaining, which is the part worth pinning: stage-change.ts dismisses open tasks AT the
// terminal transition, and that dismissal is exactly what cleared each generator's "no open task exists"
// guard — so closing a deal granted the next 6 AM run permission to re-mint. Create-side filter and
// dismissal pass therefore have to be complements on ONE axis (the deal's stage), or the loop reopens.
//
// METHOD: the create-side assertions do not inspect the SQL text. They CAPTURE the query the job really
// issues and EXECUTE it against a seeded database, then assert which deals come back — so a reworded
// comment proves nothing and a deleted predicate cannot hide.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const queryMock = vi.fn();
const evaluateTaskRulesMock = vi.fn();
const createTenantTaskRulePersistenceMock = vi.fn();
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "log").mockImplementation(() => {});

vi.mock("../../src/db.js", () => ({
  pool: { connect: async () => ({ query: queryMock, release: vi.fn() }) },
}));
vi.mock("../../../server/src/modules/tasks/rules/evaluator.js", () => ({
  evaluateTaskRules: evaluateTaskRulesMock,
}));
vi.mock("../../../server/src/modules/tasks/rules/config.js", () => ({
  TASK_RULES: [{ id: "daily_close_date_follow_up" }, { id: "daily_cadence_overdue_follow_up" }],
}));
vi.mock("../../../server/src/modules/tasks/rules/persistence.js", () => ({
  createTenantTaskRulePersistence: createTenantTaskRulePersistenceMock,
}));

const mod = await import("../../src/jobs/daily-tasks.js");
const { runDailyTaskGeneration } = mod;
const dismissResolvedTerminalDealTasks = (mod as any).dismissResolvedTerminalDealTasks as (
  client: any,
  schemaName: string,
  officeId: string,
  resolvedAt?: Date
) => Promise<number>;
const TERMINAL_DEAL_DISMISSIBLE_ORIGIN_RULES = (mod as any)
  .TERMINAL_DEAL_DISMISSIBLE_ORIGIN_RULES as readonly string[];

const SCHEMA = "office_test";
const OFFICE_ID = "00000000-0000-4000-8000-000000000fff";
const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;

// Stages. Won/Lost mirror prod exactly, INCLUDING touchpoint_cadence_days=14 — the non-null cadence on a
// terminal stage is what made the cadence rule re-mint on every closed deal, so a fixture that left it null
// would quietly remove the condition under test.
const STAGE_OPEN = U("50e0");
const STAGE_WON = U("50e1");
const STAGE_LOST = U("50e2");

const DEAL_OPEN = U("d001");
const DEAL_WON = U("d002");
const DEAL_LOST = U("d003");

async function setup(pg: PGlite) {
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS ${SCHEMA};
    CREATE TABLE public.pipeline_stage_config (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL,
      is_terminal boolean NOT NULL DEFAULT false,
      touchpoint_cadence_days integer
    );
    CREATE TABLE ${SCHEMA}.deals (
      id uuid PRIMARY KEY,
      name text,
      deal_number text,
      stage_id uuid,
      assigned_rep_id uuid,
      expected_close_date date,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE ${SCHEMA}.contacts (
      id uuid PRIMARY KEY,
      first_name text,
      last_name text,
      last_contacted_at timestamptz,
      is_active boolean NOT NULL DEFAULT true,
      first_outreach_completed boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${SCHEMA}.contact_deal_associations (
      contact_id uuid NOT NULL,
      deal_id uuid NOT NULL
    );
    CREATE TABLE ${SCHEMA}.tasks (
      id uuid PRIMARY KEY,
      title text,
      origin_rule text,
      dedupe_key text,
      reason_code text,
      type text,
      status text NOT NULL,
      priority text NOT NULL DEFAULT 'normal',
      deal_id uuid,
      contact_id uuid,
      description text,
      due_date date,
      is_overdue boolean NOT NULL DEFAULT false,
      -- jsonb, matching prod (office_dallas.tasks) -- NOT uuid. A fixture that narrows a column's type
      -- is a fixture that cannot reproduce what production stores in it.
      waiting_on jsonb,
      blocked_by jsonb,
      completed_at timestamptz,
      entity_snapshot jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    -- Production's guard against two OPEN tasks sharing a business key (migrations/0013:52-58, verified
    -- present on prod as tasks_active_origin_rule_dedupe_key_uidx). Declared here because omitting it let
    -- this suite assert a state production cannot hold -- see the duplicate-key case below.
    CREATE UNIQUE INDEX tasks_active_origin_rule_dedupe_key_uidx
      ON ${SCHEMA}.tasks (origin_rule, dedupe_key)
      WHERE origin_rule IS NOT NULL
        AND dedupe_key IS NOT NULL
        AND status IN ('scheduled', 'pending', 'in_progress', 'waiting_on', 'blocked');
    CREATE TABLE ${SCHEMA}.task_resolution_state (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      office_id uuid,
      task_id uuid,
      origin_rule text NOT NULL,
      dedupe_key text NOT NULL,
      resolution_status text NOT NULL,
      resolution_reason text,
      resolved_at timestamptz,
      suppressed_until timestamptz,
      entity_snapshot jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (origin_rule, dedupe_key)
    );

    INSERT INTO public.pipeline_stage_config (id, name, slug, is_terminal, touchpoint_cadence_days) VALUES
      ('${STAGE_OPEN}', 'Estimate Sent to Client', 'estimate_sent', false, 14),
      ('${STAGE_WON}',  'Won',  'won',  true, 14),
      ('${STAGE_LOST}', 'Lost', 'lost', true, 14);

    -- All three deals close INSIDE the rule's 7-day window, so stage is the only thing separating them.
    INSERT INTO ${SCHEMA}.deals (id, name, deal_number, stage_id, assigned_rep_id, expected_close_date) VALUES
      ('${DEAL_OPEN}', 'Open Job',  'DFW-4-OPEN', '${STAGE_OPEN}', '${U("ae01")}', CURRENT_DATE + 2),
      ('${DEAL_WON}',  'Won Job',   'DFW-4-WON',  '${STAGE_WON}',  '${U("ae01")}', CURRENT_DATE + 2),
      ('${DEAL_LOST}', 'Lost Job',  'DFW-4-LOST', '${STAGE_LOST}', '${U("ae01")}', CURRENT_DATE + 2);

    INSERT INTO ${SCHEMA}.contacts (id, first_name, last_name, last_contacted_at) VALUES
      ('${U("c001")}', 'Pat', 'Open', now() - interval '90 days'),
      ('${U("c002")}', 'Dana', 'Won',  now() - interval '90 days'),
      ('${U("c003")}', 'Sam', 'Lost',  now() - interval '90 days');
    INSERT INTO ${SCHEMA}.contact_deal_associations (contact_id, deal_id) VALUES
      ('${U("c001")}', '${DEAL_OPEN}'),
      ('${U("c002")}', '${DEAL_WON}'),
      ('${U("c003")}', '${DEAL_LOST}');
  `);
}

/**
 * Run the REAL job against a recording stub and hand back every SQL string it issued. Rows come back empty,
 * so the job takes its shortest path; we only want the verbatim query text to execute ourselves.
 */
async function captureJobSql(): Promise<string[]> {
  const captured: string[] = [];
  queryMock.mockReset();
  evaluateTaskRulesMock.mockReset();
  createTenantTaskRulePersistenceMock.mockReset();
  createTenantTaskRulePersistenceMock.mockReturnValue({});
  evaluateTaskRulesMock.mockResolvedValue([]);
  queryMock.mockImplementation(async (sql: string) => {
    captured.push(sql);
    if (sql.includes("FROM public.offices")) return { rows: [{ id: OFFICE_ID, slug: "test" }] };
    return { rows: [], rowCount: 0 };
  });
  await runDailyTaskGeneration();
  return captured;
}

/** Select the one query the job issues for a given generator. Asserts uniqueness — a selector that matches
 *  nothing (or two things) would make every assertion built on it vacuous. */
function theQuery(captured: string[], ...markers: string[]): string {
  const hits = captured.filter((sql) => markers.every((m) => sql.includes(m)));
  expect(hits).toHaveLength(1);
  return hits[0];
}

let db: PGlite;
beforeEach(async () => {
  db = new PGlite();
  await setup(db);
});

describe("the close-date follow-up generator", () => {
  it("returns the OPEN deal and neither closed one — executed, not read", async () => {
    const sql = theQuery(await captureJobSql(), "expected_close_date BETWEEN", "AS deal_id");
    const { rows } = await db.query<{ deal_number: string }>(sql.replace(/\$\{schemaName\}/g, SCHEMA));
    expect(rows.map((r) => r.deal_number)).toEqual(["DFW-4-OPEN"]);
  });

  it("still re-mints once a closed deal is REOPENED (the filter tracks stage, it does not blacklist)", async () => {
    const sql = theQuery(await captureJobSql(), "expected_close_date BETWEEN", "AS deal_id");
    await db.exec(`UPDATE ${SCHEMA}.deals SET stage_id = '${STAGE_OPEN}' WHERE id = '${DEAL_WON}'`);
    const { rows } = await db.query<{ deal_number: string }>(sql.replace(/\$\{schemaName\}/g, SCHEMA));
    expect(rows.map((r) => r.deal_number).sort()).toEqual(["DFW-4-OPEN", "DFW-4-WON"]);
  });
});

describe("the touchpoint-cadence follow-up generator", () => {
  it("returns only the contact on the OPEN deal, though all three stages carry a 14-day cadence", async () => {
    const sql = theQuery(await captureJobSql(), "touchpoint_cadence_days", "contact_deal_associations");
    const { rows } = await db.query<{ deal_number: string }>(sql.replace(/\$\{schemaName\}/g, SCHEMA));
    expect(rows.map((r) => r.deal_number)).toEqual(["DFW-4-OPEN"]);
  });
});

describe("the is_overdue flag", () => {
  // The flag was write-once-true: nothing reset it, so a task snoozed into December kept emailing its
  // assignee "Task … is overdue (due 2026-12-01)" every morning and kept sorting to the top as urgent.
  it("is re-derived from TODAY's due date, not held as a high-water mark", async () => {
    const captured = await captureJobSql();
    const clearSql = theQuery(captured, "SET is_overdue = false", "due_date IS NULL OR due_date >= CURRENT_DATE");
    const markSql = theQuery(captured, "SET is_overdue = true");

    await db.exec(`
      INSERT INTO ${SCHEMA}.tasks (id, title, status, deal_id, due_date, is_overdue) VALUES
        ('${U("f101")}', 'snoozed forward', 'pending', '${DEAL_OPEN}', CURRENT_DATE + 80, true),
        ('${U("f102")}', 'due today',       'pending', '${DEAL_OPEN}', CURRENT_DATE,      true),
        ('${U("f103")}', 'no due date',     'pending', '${DEAL_OPEN}', NULL,              true),
        ('${U("f104")}', 'genuinely late',  'pending', '${DEAL_OPEN}', CURRENT_DATE - 3,  false),
        ('${U("f105")}', 'blocked, future', 'blocked', '${DEAL_OPEN}', CURRENT_DATE + 5,  true);
    `);

    await db.exec(clearSql.replace(/\$\{schemaName\}/g, SCHEMA));
    await db.exec(markSql.replace(/\$\{schemaName\}/g, SCHEMA));

    const { rows } = await db.query<{ title: string; is_overdue: boolean }>(
      `SELECT title, is_overdue FROM ${SCHEMA}.tasks ORDER BY title`
    );
    expect(rows).toEqual([
      { title: "blocked, future", is_overdue: false },
      { title: "due today", is_overdue: false },
      { title: "genuinely late", is_overdue: true },
      { title: "no due date", is_overdue: false },
      { title: "snoozed forward", is_overdue: false },
    ]);
  });

  it("clears the flag BEFORE the overdue notification is built, so the draining run does not also nag", async () => {
    const captured = await captureJobSql();
    const clearAt = captured.findIndex((s) => s.includes("SET is_overdue = false") && s.includes("CURRENT_DATE"));
    const dismissAt = captured.findIndex((s) => s.includes("deals d") && s.includes("psc.is_terminal = true"));
    const notifyAt = captured.findIndex((s) => s.includes("'Overdue Task'"));
    expect(dismissAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThan(dismissAt);
    expect(notifyAt).toBeGreaterThan(clearAt);
  });
});

describe("dismissResolvedTerminalDealTasks", () => {
  const ALL = [
    // [id, origin_rule, dedupe_key, status, deal, expectation]
    [U("a001"), "daily_close_date_follow_up", "k1", "pending", DEAL_WON, "dismissed"],
    [U("a002"), "daily_close_date_follow_up", "k2", "pending", DEAL_LOST, "dismissed"],
    [U("a003"), "inbound_email_reply_needed", "k3", "pending", DEAL_WON, "dismissed"],
    [U("a004"), "ai_disconnect_admin_task", "k4", "waiting_on", DEAL_WON, "dismissed"],
    [U("a005"), "cold_lead_warming", "k5", "scheduled", DEAL_LOST, "dismissed"],
    [U("a006"), "daily_cadence_overdue_follow_up", "k6", "in_progress", DEAL_WON, "dismissed"],
    // Controls — the filter must LEAVE something, or a pass proves only that it refuses everything.
    [U("b001"), "daily_close_date_follow_up", "k7", "pending", DEAL_OPEN, "pending"],
    [U("b002"), "deal_won_cross_sell", "k8", "pending", DEAL_WON, "pending"],
    [U("b003"), "scoping_estimating_review_handoff", "k9", "pending", DEAL_LOST, "pending"],
    [U("b004"), null, null, "pending", DEAL_WON, "pending"],
    [U("b005"), "daily_close_date_follow_up", "k10", "completed", DEAL_WON, "completed"],
    [U("b006"), "daily_close_date_follow_up", "k11", "pending", null, "pending"],
  ] as const;

  beforeEach(async () => {
    for (const [id, rule, dedupe, status, deal] of ALL) {
      await db.query(
        `INSERT INTO ${SCHEMA}.tasks (id, title, origin_rule, dedupe_key, status, deal_id, is_overdue, waiting_on, blocked_by)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7::jsonb, $7::jsonb)`,
        [id, `t-${id.slice(-4)}`, rule, dedupe, status, deal, JSON.stringify({ userId: U("9999") })]
      );
    }
  });

  it("dismisses forward-motion tasks on closed deals and leaves every other population alone", async () => {
    const count = await dismissResolvedTerminalDealTasks(db as any, SCHEMA, OFFICE_ID);
    expect(count).toBe(ALL.filter(([, , , , , want]) => want === "dismissed").length);

    const { rows } = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM ${SCHEMA}.tasks ORDER BY id`
    );
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    for (const [id, rule, , , , want] of ALL) {
      expect(byId.get(id), `${rule ?? "(manual)"} ${id}`).toBe(want);
    }
  });

  it("clears is_overdue and the waiting/blocked pointers on what it dismisses", async () => {
    await dismissResolvedTerminalDealTasks(db as any, SCHEMA, OFFICE_ID);
    const { rows } = await db.query<{ is_overdue: boolean; waiting_on: string | null; blocked_by: string | null }>(
      `SELECT is_overdue, waiting_on, blocked_by FROM ${SCHEMA}.tasks WHERE id = $1`,
      [U("a004")]
    );
    expect(rows[0]).toEqual({ is_overdue: false, waiting_on: null, blocked_by: null });
  });

  // "Completed this week" counts status IN ('completed','dismissed') AND completed_at >= NOW() - 7 days.
  // Stamping completed_at here would report thousands of completions nobody made, and leave that card
  // disagreeing with its own sibling (which counts 'completed' only) for a week. stage-change.ts -- the
  // human-equivalent dismissal -- leaves it null too. The timestamp lives in task_resolution_state.
  it("does NOT stamp completed_at, so the drain cannot read as a week of completions", async () => {
    const resolvedAt = new Date("2026-09-12T11:00:00Z");
    await dismissResolvedTerminalDealTasks(db as any, SCHEMA, OFFICE_ID, resolvedAt);

    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM ${SCHEMA}.tasks
       WHERE status = 'dismissed' AND completed_at IS NOT NULL`
    );
    expect(rows[0].n).toBe(0);

    // ...and the moment is still recorded, on the audit row rather than the task.
    const { rows: audit } = await db.query<{ resolved_at: string }>(
      `SELECT resolved_at FROM ${SCHEMA}.task_resolution_state LIMIT 1`
    );
    expect(new Date(audit[0].resolved_at).toISOString()).toBe(resolvedAt.toISOString());
  });

  it("audits each dismissal with suppressed_until NULL, so a reopened deal can mint again", async () => {
    const resolvedAt = new Date("2026-09-12T11:00:00Z");
    await dismissResolvedTerminalDealTasks(db as any, SCHEMA, OFFICE_ID, resolvedAt);
    const { rows } = await db.query<{
      origin_rule: string;
      resolution_status: string;
      resolution_reason: string;
      suppressed_until: string | null;
    }>(`SELECT origin_rule, resolution_status, resolution_reason, suppressed_until
        FROM ${SCHEMA}.task_resolution_state ORDER BY origin_rule`);
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.resolution_status).toBe("dismissed");
      expect(row.resolution_reason).toBe("deal_reached_terminal_stage");
      expect(row.suppressed_until).toBeNull();
    }
  });

  // task_resolution_state.dedupe_key is NOT NULL. Auditing a keyless task would raise, and because the job
  // wraps each office in one transaction that error would roll the DISMISSAL back too — the pass would
  // report a number and change nothing. So a keyless task must still be dismissed, just not audited.
  it("dismisses an allowlisted task carrying NO dedupe_key without aborting the pass", async () => {
    await db.query(
      `INSERT INTO ${SCHEMA}.tasks (id, title, origin_rule, dedupe_key, status, deal_id)
       VALUES ($1, 'keyless', 'cold_lead_warming', NULL, 'pending', $2)`,
      [U("a099"), DEAL_WON]
    );
    await expect(dismissResolvedTerminalDealTasks(db as any, SCHEMA, OFFICE_ID)).resolves.toBeGreaterThan(0);
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM ${SCHEMA}.tasks WHERE id = $1`,
      [U("a099")]
    );
    expect(rows[0].status).toBe("dismissed");
    const { rows: audit } = await db.query(
      `SELECT 1 FROM ${SCHEMA}.task_resolution_state WHERE task_id = $1`,
      [U("a099")]
    );
    expect(audit).toHaveLength(0);
  });

  // DEFENSE-IN-DEPTH, and labelled as such. The pass audits through ON CONFLICT DO UPDATE, which raises
  // "cannot affect row a second time" on a duplicate business key — and inside a transaction that error
  // would roll the dismissal back, so the pass would report a count and change nothing.
  //
  // Production cannot currently produce that input: tasks_active_origin_rule_dedupe_key_uidx (declared in
  // the fixture above) forbids two OPEN tasks sharing (origin_rule, dedupe_key). So this case has to DROP
  // that index to reach the branch, and it is honest about what that means — it proves the CTE survives the
  // input if the index is ever dropped or made non-partial, and it proves nothing about today's prod.
  // Without dropping it the insert below fails on the index, which is the real guarantee.
  it("dismisses BOTH of two open tasks sharing one dedupe key, and audits the pair once", async () => {
    await db.exec(`DROP INDEX ${SCHEMA}.tasks_active_origin_rule_dedupe_key_uidx`);
    await db.query(
      `INSERT INTO ${SCHEMA}.tasks (id, title, origin_rule, dedupe_key, status, deal_id) VALUES
         ($1, 'dup a', 'daily_close_date_follow_up', 'shared-key', 'pending', $3),
         ($2, 'dup b', 'daily_close_date_follow_up', 'shared-key', 'pending', $3)`,
      [U("a201"), U("a202"), DEAL_WON]
    );

    await expect(dismissResolvedTerminalDealTasks(db as any, SCHEMA, OFFICE_ID)).resolves.toBeGreaterThan(0);

    const { rows: statuses } = await db.query<{ status: string }>(
      `SELECT status FROM ${SCHEMA}.tasks WHERE id IN ($1, $2) ORDER BY id`,
      [U("a201"), U("a202")]
    );
    expect(statuses.map((r) => r.status)).toEqual(["dismissed", "dismissed"]);

    const { rows: audit } = await db.query(
      `SELECT 1 FROM ${SCHEMA}.task_resolution_state WHERE dedupe_key = 'shared-key'`
    );
    expect(audit).toHaveLength(1);
  });

  it("refuses an unsafe schema name before it reaches a query", async () => {
    await expect(dismissResolvedTerminalDealTasks(db as any, 'x"; DROP TABLE tasks; --', OFFICE_ID)).rejects.toThrow(
      /Unsafe schema name/
    );
  });

  it("names only rules that exist, and excludes every post-close rule", () => {
    expect([...TERMINAL_DEAL_DISMISSIBLE_ORIGIN_RULES]).toEqual([
      "daily_close_date_follow_up",
      "daily_cadence_overdue_follow_up",
      "inbound_email_reply_needed",
      "ai_disconnect_admin_task",
      "cold_lead_warming",
    ]);
    for (const postClose of ["deal_won_cross_sell", "deal_lost_competitor_intel", "scoping_estimating_review_handoff"]) {
      expect(TERMINAL_DEAL_DISMISSIBLE_ORIGIN_RULES).not.toContain(postClose);
    }
  });
});
