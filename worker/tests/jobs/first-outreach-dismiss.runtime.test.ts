// Real-types (PGlite) tests for the daily_first_outreach_touchpoint lifecycle fix.
//
// The rule mints a "first outreach needed" task per new uncontacted contact. Before this fix nothing ever
// dismissed it, so it lingered overdue forever (73% of the overdue pile). dismissResolvedFirstOutreachTasks
// closes the loop: it dismisses an open task when the contact no longer needs first outreach (outreach
// logged -> first_outreach_completed=true via the touchpoint trigger, contact inactive, or deleted) OR the
// contact has aged past the 30-day window. Re-mint is prevented STRUCTURALLY (the create predicate filters
// first_outreach_completed=false AND created_at within the window), which we assert here too.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// The worker module imports a real pg pool at load time — stub it; the test passes an explicit PGlite client.
vi.mock("../../src/db.js", () => ({
  pool: { connect: async () => ({ query: vi.fn(), release: vi.fn() }) },
}));

const mod = await import("../../src/jobs/daily-tasks.js");
const dismissResolvedFirstOutreachTasks = (mod as any).dismissResolvedFirstOutreachTasks as (
  client: any,
  schemaName: string,
  officeId: string,
  resolvedAt?: Date
) => Promise<number>;
const FIRST_OUTREACH_WINDOW_DAYS = (mod as any).FIRST_OUTREACH_WINDOW_DAYS as number;

const SCHEMA = "office_test";
const OFFICE_ID = "00000000-0000-4000-8000-000000000fff";
const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;

// Contacts exercising every branch.
const C_RESOLVED = U("c001"); // active, first_outreach_completed=true (outreach logged) -> dismiss (resolved)
const C_INACTIVE = U("c002"); // is_active=false, flag=false -> dismiss (resolved: no longer active)
const C_EXPIRED = U("c003"); // active, flag=false, created 40d ago -> dismiss (expired)
const C_NEEDED = U("c004"); // active, flag=false, created 10d ago -> KEEP (still needs, in window)
const C_BOUND_IN = U("c005"); // active, flag=false, created EXACTLY 30d ago -> KEEP (window inclusive of day 30)
const C_BOUND_OUT = U("c006"); // active, flag=false, created EXACTLY 31d ago -> dismiss (expired)
const C_WAITING = U("c007"); // active, flag=true, a task in 'waiting_on' status -> dismiss (resolved) + clear

const T_RESOLVED = U("a001");
const T_INACTIVE = U("a002");
const T_EXPIRED = U("a003");
const T_NEEDED = U("a004");
const T_ORPHAN = U("a005"); // first-outreach task whose contact_id has no contact row -> dismiss (resolved)
const T_OTHER_RULE = U("a006"); // a stale_lead task on the resolved contact -> MUST NOT be touched
const T_COMPLETED = U("a007"); // a first-outreach task already 'completed' -> MUST NOT be touched
const T_BOUND_IN = U("a008");
const T_BOUND_OUT = U("a009");
const T_WAITING = U("a010"); // status='waiting_on' (a non-pending ACTIVE status) with waiting_on/blocked_by set

let db: PGlite;

async function setup(pg: PGlite) {
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS ${SCHEMA};
    CREATE TABLE ${SCHEMA}.contacts (
      id uuid PRIMARY KEY,
      is_active boolean NOT NULL DEFAULT true,
      first_outreach_completed boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${SCHEMA}.tasks (
      id uuid PRIMARY KEY,
      origin_rule text,
      dedupe_key text,
      reason_code text,
      type text,
      status text NOT NULL,
      contact_id uuid,
      due_date date,
      is_overdue boolean NOT NULL DEFAULT false,
      waiting_on uuid,
      blocked_by uuid,
      completed_at timestamptz,
      entity_snapshot jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
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

    INSERT INTO ${SCHEMA}.contacts (id, is_active, first_outreach_completed, created_at) VALUES
      ('${C_RESOLVED}',  true,  true,  now() - interval '10 days'),
      ('${C_INACTIVE}',  false, false, now() - interval '10 days'),
      ('${C_EXPIRED}',   true,  false, now() - interval '40 days'),
      ('${C_NEEDED}',    true,  false, now() - interval '10 days'),
      ('${C_BOUND_IN}',  true,  false, CURRENT_DATE - 30),
      ('${C_BOUND_OUT}', true,  false, CURRENT_DATE - 31),
      ('${C_WAITING}',   true,  true,  now() - interval '10 days');

    INSERT INTO ${SCHEMA}.tasks (id, origin_rule, dedupe_key, type, status, contact_id, due_date, is_overdue, waiting_on, blocked_by) VALUES
      ('${T_RESOLVED}', 'daily_first_outreach_touchpoint', 'contact:${C_RESOLVED}:daily_first_outreach_touchpoint', 'touchpoint', 'pending', '${C_RESOLVED}', CURRENT_DATE - 5, true, NULL, NULL),
      ('${T_INACTIVE}', 'daily_first_outreach_touchpoint', 'contact:${C_INACTIVE}:daily_first_outreach_touchpoint', 'touchpoint', 'pending', '${C_INACTIVE}', CURRENT_DATE - 5, true, NULL, NULL),
      ('${T_EXPIRED}',  'daily_first_outreach_touchpoint', 'contact:${C_EXPIRED}:daily_first_outreach_touchpoint',  'touchpoint', 'pending', '${C_EXPIRED}',  CURRENT_DATE - 35, true, NULL, NULL),
      ('${T_NEEDED}',   'daily_first_outreach_touchpoint', 'contact:${C_NEEDED}:daily_first_outreach_touchpoint',   'touchpoint', 'pending', '${C_NEEDED}',   CURRENT_DATE - 5, true, NULL, NULL),
      ('${T_BOUND_IN}', 'daily_first_outreach_touchpoint', 'contact:${C_BOUND_IN}:daily_first_outreach_touchpoint', 'touchpoint', 'pending', '${C_BOUND_IN}', CURRENT_DATE - 5, true, NULL, NULL),
      ('${T_BOUND_OUT}','daily_first_outreach_touchpoint', 'contact:${C_BOUND_OUT}:daily_first_outreach_touchpoint','touchpoint', 'pending', '${C_BOUND_OUT}',CURRENT_DATE - 5, true, NULL, NULL),
      ('${T_WAITING}',  'daily_first_outreach_touchpoint', 'contact:${C_WAITING}:daily_first_outreach_touchpoint',  'touchpoint', 'waiting_on', '${C_WAITING}', CURRENT_DATE - 5, true, '${U("ffff")}', '${U("eeee")}'),
      ('${T_ORPHAN}',   'daily_first_outreach_touchpoint', 'contact:${U("dead")}:daily_first_outreach_touchpoint',  'touchpoint', 'pending', '${U("dead")}',  CURRENT_DATE - 5, true, NULL, NULL),
      ('${T_OTHER_RULE}', 'stale_lead', 'lead:x:stale_lead', 'follow_up', 'pending', '${C_RESOLVED}', CURRENT_DATE - 5, true, NULL, NULL),
      ('${T_COMPLETED}', 'daily_first_outreach_touchpoint', 'contact:${C_RESOLVED}:daily_first_outreach_touchpoint:done', 'touchpoint', 'completed', '${C_RESOLVED}', CURRENT_DATE - 5, false, NULL, NULL);
  `);
}

async function status(id: string): Promise<string> {
  const r = await db.query<{ status: string }>(`SELECT status FROM ${SCHEMA}.tasks WHERE id = $1`, [id]);
  return r.rows[0]!.status;
}

beforeEach(async () => {
  db = new PGlite();
  await setup(db);
});
afterEach(async () => {
  await db.close();
});

describe("dismissResolvedFirstOutreachTasks", () => {
  it("dismisses resolved/inactive/expired/orphan + a waiting_on task; keeps still-needed and in-window", async () => {
    const count = await dismissResolvedFirstOutreachTasks(db, SCHEMA, OFFICE_ID);

    // 6 dismissed: resolved + inactive + expired(40d) + boundary-out(31d) + waiting_on + orphan.
    expect(count).toBe(6);
    expect(await status(T_RESOLVED)).toBe("dismissed");
    expect(await status(T_INACTIVE)).toBe("dismissed");
    expect(await status(T_EXPIRED)).toBe("dismissed");
    expect(await status(T_BOUND_OUT)).toBe("dismissed"); // exactly 31d old -> expired
    expect(await status(T_WAITING)).toBe("dismissed"); // a non-pending ACTIVE status is still dismissed
    expect(await status(T_ORPHAN)).toBe("dismissed");
    // Kept:
    expect(await status(T_NEEDED)).toBe("pending"); // active, flag=false, in-window -> live reminder
    expect(await status(T_BOUND_IN)).toBe("pending"); // exactly 30d old -> window inclusive of day 30
    expect(await status(T_OTHER_RULE)).toBe("pending"); // different origin_rule untouched
    expect(await status(T_COMPLETED)).toBe("completed"); // non-active status untouched
  });

  it("at the window boundary: exactly 30 days is kept, exactly 31 days expires (pins the < vs >= edge)", async () => {
    await dismissResolvedFirstOutreachTasks(db, SCHEMA, OFFICE_ID);
    expect(await status(T_BOUND_IN)).toBe("pending"); // created_at = CURRENT_DATE - 30 -> NOT < CURRENT_DATE - 30
    expect(await status(T_BOUND_OUT)).toBe("dismissed"); // created_at = CURRENT_DATE - 31 -> < CURRENT_DATE - 30
  });

  it("clears overdue + waiting_on + blocked_by and stamps completed_at on dismissal", async () => {
    await dismissResolvedFirstOutreachTasks(db, SCHEMA, OFFICE_ID);
    const r = await db.query<{ is_overdue: boolean; completed_at: string | null; waiting_on: string | null; blocked_by: string | null }>(
      `SELECT is_overdue, completed_at, waiting_on, blocked_by FROM ${SCHEMA}.tasks WHERE id = $1`,
      [T_WAITING] // a task that HAD waiting_on + blocked_by set
    );
    expect(r.rows[0]!.is_overdue).toBe(false);
    expect(r.rows[0]!.completed_at).not.toBeNull();
    expect(r.rows[0]!.waiting_on).toBeNull();
    expect(r.rows[0]!.blocked_by).toBeNull();
  });

  it("records task_resolution_state with the right reason per task (resolved vs expired)", async () => {
    await dismissResolvedFirstOutreachTasks(db, SCHEMA, OFFICE_ID);
    const reasons = await db.query<{ dedupe_key: string; resolution_reason: string; resolution_status: string }>(
      `SELECT dedupe_key, resolution_reason, resolution_status FROM ${SCHEMA}.task_resolution_state ORDER BY dedupe_key`
    );
    const byKey = new Map(reasons.rows.map((r) => [r.dedupe_key, r]));
    expect(byKey.get(`contact:${C_RESOLVED}:daily_first_outreach_touchpoint`)?.resolution_reason).toBe("first_outreach_resolved");
    expect(byKey.get(`contact:${C_INACTIVE}:daily_first_outreach_touchpoint`)?.resolution_reason).toBe("first_outreach_resolved");
    expect(byKey.get(`contact:${C_EXPIRED}:daily_first_outreach_touchpoint`)?.resolution_reason).toBe("first_outreach_expired");
    for (const row of reasons.rows) expect(row.resolution_status).toBe("dismissed");
  });

  it("dismissed tasks do NOT re-qualify for the create predicate (no re-mint)", async () => {
    await dismissResolvedFirstOutreachTasks(db, SCHEMA, OFFICE_ID);
    // The exact create predicate from runDailyTaskGeneration (sans the open-task NOT EXISTS, which now
    // passes since the task is dismissed) — the structural guards must still exclude resolved + expired.
    const remintable = await db.query<{ contact_id: string }>(
      `SELECT c.id AS contact_id
       FROM ${SCHEMA}.contacts c
       WHERE c.is_active = true
         AND c.first_outreach_completed = false
         AND c.created_at < CURRENT_DATE - INTERVAL '3 days'
         AND c.created_at >= CURRENT_DATE - (${FIRST_OUTREACH_WINDOW_DAYS} * INTERVAL '1 day')`
    );
    const ids = remintable.rows.map((r) => r.contact_id);
    expect(ids).not.toContain(C_RESOLVED); // flag=true -> filtered
    expect(ids).not.toContain(C_EXPIRED); // 40d old -> outside the window
    expect(ids).not.toContain(C_INACTIVE); // inactive -> filtered
    expect(ids).toContain(C_NEEDED); // still genuinely needs first outreach
    expect(ids).toContain(C_BOUND_IN); // exactly 30d -> still mintable (window inclusive), and NOT dismissed
    expect(ids).not.toContain(C_BOUND_OUT); // 31d -> outside the create window (complements the dismiss)
  });

  it("re-running is idempotent — already-dismissed tasks are not re-touched", async () => {
    const first = await dismissResolvedFirstOutreachTasks(db, SCHEMA, OFFICE_ID);
    const second = await dismissResolvedFirstOutreachTasks(db, SCHEMA, OFFICE_ID);
    expect(first).toBe(6);
    expect(second).toBe(0); // dismissed tasks left the active-status set
  });
});
