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
  resolvedAt?: Date,
  windowDays?: number
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

const T_RESOLVED = U("a001");
const T_INACTIVE = U("a002");
const T_EXPIRED = U("a003");
const T_NEEDED = U("a004");
const T_ORPHAN = U("a005"); // first-outreach task whose contact_id has no contact row -> dismiss (resolved)
const T_OTHER_RULE = U("a006"); // a stale_lead task on the resolved contact -> MUST NOT be touched
const T_COMPLETED = U("a007"); // a first-outreach task already 'completed' -> MUST NOT be touched

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
      ('${C_RESOLVED}', true,  true,  now() - interval '10 days'),
      ('${C_INACTIVE}', false, false, now() - interval '10 days'),
      ('${C_EXPIRED}',  true,  false, now() - interval '40 days'),
      ('${C_NEEDED}',   true,  false, now() - interval '10 days');

    INSERT INTO ${SCHEMA}.tasks (id, origin_rule, dedupe_key, type, status, contact_id, due_date, is_overdue) VALUES
      ('${T_RESOLVED}', 'daily_first_outreach_touchpoint', 'contact:${C_RESOLVED}:daily_first_outreach_touchpoint', 'touchpoint', 'pending', '${C_RESOLVED}', CURRENT_DATE - 5, true),
      ('${T_INACTIVE}', 'daily_first_outreach_touchpoint', 'contact:${C_INACTIVE}:daily_first_outreach_touchpoint', 'touchpoint', 'pending', '${C_INACTIVE}', CURRENT_DATE - 5, true),
      ('${T_EXPIRED}',  'daily_first_outreach_touchpoint', 'contact:${C_EXPIRED}:daily_first_outreach_touchpoint',  'touchpoint', 'pending', '${C_EXPIRED}',  CURRENT_DATE - 35, true),
      ('${T_NEEDED}',   'daily_first_outreach_touchpoint', 'contact:${C_NEEDED}:daily_first_outreach_touchpoint',   'touchpoint', 'pending', '${C_NEEDED}',   CURRENT_DATE - 5, true),
      ('${T_ORPHAN}',   'daily_first_outreach_touchpoint', 'contact:${U("dead")}:daily_first_outreach_touchpoint',  'touchpoint', 'pending', '${U("dead")}',  CURRENT_DATE - 5, true),
      ('${T_OTHER_RULE}', 'stale_lead', 'lead:x:stale_lead', 'follow_up', 'pending', '${C_RESOLVED}', CURRENT_DATE - 5, true),
      ('${T_COMPLETED}', 'daily_first_outreach_touchpoint', 'contact:${C_RESOLVED}:daily_first_outreach_touchpoint:done', 'touchpoint', 'completed', '${C_RESOLVED}', CURRENT_DATE - 5, false);
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
  it("dismisses resolved (outreach done), inactive, expired, and orphaned tasks; keeps still-needed ones", async () => {
    const count = await dismissResolvedFirstOutreachTasks(db, SCHEMA, OFFICE_ID);

    // 4 dismissed: resolved + inactive + expired + orphan. NOT: the still-needed one, the other-rule one,
    // the already-completed one.
    expect(count).toBe(4);
    expect(await status(T_RESOLVED)).toBe("dismissed");
    expect(await status(T_INACTIVE)).toBe("dismissed");
    expect(await status(T_EXPIRED)).toBe("dismissed");
    expect(await status(T_ORPHAN)).toBe("dismissed");
    expect(await status(T_NEEDED)).toBe("pending"); // active, flag=false, in-window -> still a live reminder
    expect(await status(T_OTHER_RULE)).toBe("pending"); // different origin_rule untouched
    expect(await status(T_COMPLETED)).toBe("completed"); // non-active status untouched
  });

  it("clears overdue + waiting/blocked and stamps completed_at on dismissal", async () => {
    await dismissResolvedFirstOutreachTasks(db, SCHEMA, OFFICE_ID);
    const r = await db.query<{ is_overdue: boolean; completed_at: string | null }>(
      `SELECT is_overdue, completed_at FROM ${SCHEMA}.tasks WHERE id = $1`,
      [T_RESOLVED]
    );
    expect(r.rows[0]!.is_overdue).toBe(false);
    expect(r.rows[0]!.completed_at).not.toBeNull();
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
  });

  it("respects a custom window (expiry boundary moves with windowDays)", async () => {
    // With a 5-day window, the 10-day-old still-needed contact is now EXPIRED too.
    const count = await dismissResolvedFirstOutreachTasks(db, SCHEMA, OFFICE_ID, new Date(), 5);
    expect(count).toBe(5); // the 4 above + T_NEEDED (now expired at 5-day window)
    expect(await status(T_NEEDED)).toBe("dismissed");
  });
});
