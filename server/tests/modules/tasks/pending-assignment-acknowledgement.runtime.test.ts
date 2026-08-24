// REAL-SQL (PGlite) proof for the new-assignment login modal's server half.
//
// THE ORDERING TEST IS THE REASON THIS SUITE EXISTS. `priority` is a Postgres ENUM declared
// ('urgent','high','normal','low') (0001_initial.sql:82), and enum comparison is DECLARATION order, not
// alphabetical and not severity. So the obvious `ORDER BY priority DESC` sorts low -> normal -> high ->
// urgent, and with LIMIT 5 the urgent and high rows are the LAST five the query would ever return. The
// urgent-repeat rule then re-selects those same never-displayed rows on every login, so the modal
// becomes a permanent nag showing the least important work in the office. Every one of those steps is
// individually plausible and the whole thing is green against any fixture with fewer than six tasks in
// it -- hence the six-task fixture below, which is the smallest one that can tell the two orderings
// apart at LIMIT 5.
//
// The acknowledgement assertions all check the ACK ROW as well as the visibility, because "an urgent
// task is still returned after acknowledging it" is also true when acknowledgement is broken and writes
// nothing at all.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { tasks, taskAssignmentAcknowledgements } from "@trock-crm/shared/schema";
import {
  getPendingAssignmentTasks,
  acknowledgeTaskAssignments,
  PENDING_ASSIGNMENT_MODAL_LIMIT,
} from "../../../src/modules/tasks/service.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const uid = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, "0")}`;

const ALICE = uid("a1");
const BOB = uid("b1");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

/** YYYY-MM-DD in America/Chicago, the bucket the service uses. */
function todayCt() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function shiftDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

type SeedTask = {
  id: string;
  title?: string;
  priority?: "urgent" | "high" | "normal" | "low";
  status?: string;
  assignedTo?: string;
  createdBy?: string | null;
  dueDate?: string | null;
  source?: "manual" | "automated";
  isTestData?: boolean;
};

async function seed(rows: SeedTask[]) {
  for (const row of rows) {
    await tdb.insert(tasks).values({
      id: row.id,
      title: row.title ?? `task ${row.id.slice(-2)}`,
      type: "manual",
      priority: row.priority ?? "normal",
      status: (row.status ?? "pending") as never,
      assignedTo: row.assignedTo ?? ALICE,
      createdBy: row.createdBy === undefined ? BOB : row.createdBy,
      dueDate: row.dueDate ?? null,
      source: row.source ?? "manual",
      isTestData: row.isTestData ?? false,
    });
  }
}

async function ackRowCount(taskId: string, userId: string) {
  const result = await pg.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM task_assignment_acknowledgements WHERE task_id = $1 AND user_id = $2`,
    [taskId, userId]
  );
  return result.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(tenantSchemaSql("public", [tasks, taskAssignmentAcknowledgements]));
  // tenantSchemaSql deliberately omits UNIQUE constraints and indexes (it builds ISLANDS: see its
  // header). Acknowledgement writes are ON CONFLICT DO NOTHING against this exact constraint, so it has
  // to be added back or every write here raises "no unique or exclusion constraint matching". The
  // constraint that actually ships is proved separately, against the migration, in
  // tests/migrations/0235-task-assignment-acknowledgements.runtime.test.ts.
  await pg.exec(`
    ALTER TABLE public.task_assignment_acknowledgements
      ADD CONSTRAINT task_assignment_ack_uq UNIQUE (task_id, user_id);
    CREATE TABLE IF NOT EXISTS public.users (
      id uuid PRIMARY KEY,
      display_name varchar(255)
    );
    INSERT INTO public.users (id, display_name) VALUES
      ('${BOB}', 'Adam Shaw'),
      ('${ALICE}', 'Alice Rep');
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM public.task_assignment_acknowledgements; DELETE FROM public.tasks;`);
});

describe("getPendingAssignmentTasks — what the login modal shows", () => {
  it("returns a pending manual task with no ack row", async () => {
    await seed([{ id: uid("1"), title: "Call the roofer back" }]);

    const result = await getPendingAssignmentTasks(tdb, ALICE);

    expect(result.tasks.map((t) => t.id)).toEqual([uid("1")]);
    expect(result.total).toBe(1);
  });

  // The person who put it on your list, which is what the feature exists to surface. Named from
  // `created_by`, and reported as the CREATOR rather than the assigner: the PATCH flow changes
  // assigned_to without touching created_by, so after a reassignment this is the original author and
  // nothing in the schema records who actually routed it.
  it("names the person the task came from", async () => {
    await seed([{ id: uid("1"), createdBy: BOB }]);

    const result = await getPendingAssignmentTasks(tdb, ALICE);

    expect(result.tasks[0]?.createdByName).toBe("Adam Shaw");
  });

  // C1. Six tasks, LIMIT 5, exactly one urgent -- the smallest fixture that can distinguish
  // `ORDER BY priority DESC` (enum declaration order: low first, urgent last, urgent dropped by the
  // LIMIT) from the rank-based ascending order the feature needs.
  it("puts the URGENT task inside the returned five, not off the end of the limit", async () => {
    await seed([
      { id: uid("1"), priority: "low" },
      { id: uid("2"), priority: "low" },
      { id: uid("3"), priority: "normal" },
      { id: uid("4"), priority: "normal" },
      { id: uid("5"), priority: "low" },
      { id: uid("6"), priority: "urgent", title: "Roof is leaking onto the server rack" },
    ]);

    const result = await getPendingAssignmentTasks(tdb, ALICE);

    expect(result.tasks).toHaveLength(PENDING_ASSIGNMENT_MODAL_LIMIT);
    expect(result.tasks.map((t) => t.id)).toContain(uid("6"));
    // ...and it is FIRST, not merely present: severity is the sort key, not a tiebreak.
    expect(result.tasks[0]?.id).toBe(uid("6"));
    expect(result.total).toBe(6);
  });

  it("orders urgent -> high -> normal -> low across the whole ladder", async () => {
    await seed([
      { id: uid("1"), priority: "low" },
      { id: uid("2"), priority: "urgent" },
      { id: uid("3"), priority: "normal" },
      { id: uid("4"), priority: "high" },
    ]);

    const result = await getPendingAssignmentTasks(tdb, ALICE);

    expect(result.tasks.map((t) => t.priority)).toEqual(["urgent", "high", "normal", "low"]);
  });

  it("breaks a priority tie by due date, undated last", async () => {
    const today = todayCt();
    await seed([
      { id: uid("1"), priority: "normal", dueDate: null },
      { id: uid("2"), priority: "normal", dueDate: shiftDays(today, 9) },
      { id: uid("3"), priority: "normal", dueDate: shiftDays(today, 2) },
    ]);

    const result = await getPendingAssignmentTasks(tdb, ALICE);

    expect(result.tasks.map((t) => t.id)).toEqual([uid("3"), uid("2"), uid("1")]);
  });

  it("reports the FULL matching count alongside the capped page, for the 'and N more' line", async () => {
    await seed(Array.from({ length: 8 }, (_, i) => ({ id: uid(String(i + 1)) })));

    const result = await getPendingAssignmentTasks(tdb, ALICE);

    expect(result.tasks).toHaveLength(PENDING_ASSIGNMENT_MODAL_LIMIT);
    expect(result.total).toBe(8);
  });

  it("never returns a completed or dismissed task", async () => {
    await seed([
      { id: uid("1"), status: "completed" },
      { id: uid("2"), status: "dismissed" },
    ]);

    const result = await getPendingAssignmentTasks(tdb, ALICE);

    expect(result.tasks).toEqual([]);
    expect(result.total).toBe(0);
  });

  // C4. created_by is NULL on every rules-engine and AI-disconnect task, so without this filter the
  // modal is mostly robot output under a blank "assigned by" -- and "who assigned it" is the ask.
  it("excludes automated tasks, however urgent", async () => {
    await seed([
      { id: uid("1"), source: "automated", priority: "urgent", createdBy: null },
      { id: uid("2"), source: "manual", priority: "low" },
    ]);

    const result = await getPendingAssignmentTasks(tdb, ALICE);

    expect(result.tasks.map((t) => t.id)).toEqual([uid("2")]);
  });

  it("excludes seeded demo rows", async () => {
    await seed([
      { id: uid("1"), isTestData: true },
      { id: uid("2"), isTestData: false },
    ]);

    const result = await getPendingAssignmentTasks(tdb, ALICE);

    expect(result.tasks.map((t) => t.id)).toEqual([uid("2")]);
  });

  it("never shows another person's assignment", async () => {
    await seed([{ id: uid("1"), assignedTo: BOB }]);

    const result = await getPendingAssignmentTasks(tdb, ALICE);

    expect(result.tasks).toEqual([]);
  });
});

describe("unseen assignments are never crowded out by repeats", () => {
  // THE EMERGENT DEFECT. Neither half is wrong on its own: LIMIT 5 keeps the modal from being a wall,
  // and the urgent/high/overdue repeat rule keeps important work in front of people until they deal
  // with it. Together they invert the feature. Once somebody holds five repeating tasks, those five
  // are eligible on every login AND they sort first, so they occupy all five slots forever and a
  // genuinely new assignment is never shown at all -- the modal becomes a permanent display of things
  // the user has already seen while the one thing they have not stays invisible.
  //
  // It is not theoretical: the worst-affected person in production holds 14 pending manual tasks, so
  // three urgent or overdue ones already take three of the five slots.
  //
  // The invariant chosen: A NEVER-ACKNOWLEDGED ASSIGNMENT IS NEVER DISPLACED BY AN ALREADY-SEEN ONE.
  // Unseen rows sort ahead of repeats outright, so repeats only ever occupy slots unseen work does not
  // need. Priority still orders WITHIN each group, so the C1 fix keeps working and does not become the
  // mechanism that buries new work.

  it("shows a brand-new NORMAL task even when five acknowledged URGENT ones are eligible", async () => {
    const repeating = [uid("1"), uid("2"), uid("3"), uid("4"), uid("5")];
    await seed(repeating.map((id) => ({ id, priority: "urgent" as const })));
    await acknowledgeTaskAssignments(tdb, ALICE, repeating);
    await seed([{ id: uid("9"), priority: "normal", title: "Nobody has seen this one" }]);

    const result = await getPendingAssignmentTasks(tdb, ALICE);

    expect(result.tasks.map((t) => t.id)).toContain(uid("9"));
    // ...and it is FIRST. "Somewhere in the five" would still let a sixth repeat push it out.
    expect(result.tasks[0]?.id).toBe(uid("9"));
  });

  it("still shows it when the repeats are OVERDUE rather than urgent", async () => {
    const yesterday = shiftDays(todayCt(), -1);
    const repeating = [uid("1"), uid("2"), uid("3"), uid("4"), uid("5")];
    await seed(repeating.map((id) => ({ id, priority: "high" as const, dueDate: yesterday })));
    await acknowledgeTaskAssignments(tdb, ALICE, repeating);
    await seed([{ id: uid("9"), priority: "low", dueDate: null }]);

    const result = await getPendingAssignmentTasks(tdb, ALICE);

    expect(result.tasks[0]?.id).toBe(uid("9"));
  });

  it("orders every unseen task ahead of every repeat, whatever their priorities", async () => {
    await seed([
      { id: uid("1"), priority: "urgent" },
      { id: uid("2"), priority: "urgent" },
    ]);
    await acknowledgeTaskAssignments(tdb, ALICE, [uid("1"), uid("2")]);
    await seed([
      { id: uid("8"), priority: "low" },
      { id: uid("9"), priority: "normal" },
    ]);

    const result = await getPendingAssignmentTasks(tdb, ALICE);

    // Unseen first (normal before low, so C1's ordering still applies inside the group), then repeats.
    expect(result.tasks.map((t) => t.id)).toEqual([uid("9"), uid("8"), uid("1"), uid("2")]);
  });

  it("marks which rows are new so the modal can stop calling a repeat a new assignment", async () => {
    await seed([{ id: uid("1"), priority: "urgent" }]);
    await acknowledgeTaskAssignments(tdb, ALICE, [uid("1")]);
    await seed([{ id: uid("9"), priority: "normal" }]);

    const result = await getPendingAssignmentTasks(tdb, ALICE);

    expect(result.tasks.find((t) => t.id === uid("9"))?.isNew).toBe(true);
    expect(result.tasks.find((t) => t.id === uid("1"))?.isNew).toBe(false);
  });

  it("counts the unseen ones separately from the total", async () => {
    const repeating = [uid("1"), uid("2"), uid("3")];
    await seed(repeating.map((id) => ({ id, priority: "urgent" as const })));
    await acknowledgeTaskAssignments(tdb, ALICE, repeating);
    await seed([{ id: uid("8") }, { id: uid("9") }]);

    const result = await getPendingAssignmentTasks(tdb, ALICE);

    expect(result.total).toBe(5);
    expect(result.newTotal).toBe(2);
  });

  it("reports newTotal 0 when everything eligible is a repeat", async () => {
    await seed([{ id: uid("1"), priority: "urgent" }]);
    await acknowledgeTaskAssignments(tdb, ALICE, [uid("1")]);

    const result = await getPendingAssignmentTasks(tdb, ALICE);

    expect(result.total).toBe(1);
    expect(result.newTotal).toBe(0);
  });
});

describe("a reassignment is a new assignment to the person receiving it", () => {
  // The PATCH flow changes assigned_to without touching status, so a task Alice had already started
  // arrives on Bob's list as 'in_progress'. Gating FIRST-TIME visibility on status = 'pending' drops it
  // before ever asking whether Bob has seen it -- and "somebody assigned me something" is the entire
  // reason this feature exists. Repeats stay pending-only: a task the assignee has themselves moved to
  // in_progress has visibly been seen, so it has no business interrupting them again.

  for (const status of ["in_progress", "waiting_on", "blocked"] as const) {
    it(`shows an unseen ${status} task to its new assignee`, async () => {
      await seed([{ id: uid("1"), status, priority: "normal" }]);

      const result = await getPendingAssignmentTasks(tdb, ALICE);

      expect(result.tasks.map((t) => t.id)).toEqual([uid("1")]);
      expect(result.tasks[0]?.isNew).toBe(true);
    });

    it(`does NOT repeat an acknowledged urgent ${status} task`, async () => {
      await seed([{ id: uid("1"), status, priority: "urgent" }]);
      await acknowledgeTaskAssignments(tdb, ALICE, [uid("1")]);

      expect((await getPendingAssignmentTasks(tdb, ALICE)).tasks).toEqual([]);
    });
  }

  // Scheduled work carries an explicit future surfacing date. Interrupting somebody at login about
  // something deliberately deferred is the opposite of what the status means, and it reappears on its
  // own date anyway.
  it("does not show a scheduled task, seen or unseen", async () => {
    await seed([{ id: uid("1"), status: "scheduled", priority: "urgent" }]);

    expect((await getPendingAssignmentTasks(tdb, ALICE)).tasks).toEqual([]);
  });

  it("still never shows completed or dismissed work", async () => {
    await seed([
      { id: uid("1"), status: "completed", priority: "urgent" },
      { id: uid("2"), status: "dismissed", priority: "urgent" },
    ]);

    expect((await getPendingAssignmentTasks(tdb, ALICE)).tasks).toEqual([]);
  });
});

describe("acknowledgement — once per task, with urgent/high/overdue repeats", () => {
  it("stops showing a NORMAL priority task once it has been acknowledged", async () => {
    await seed([{ id: uid("1"), priority: "normal" }]);

    await acknowledgeTaskAssignments(tdb, ALICE, [uid("1")]);

    expect(await ackRowCount(uid("1"), ALICE)).toBe(1);
    expect((await getPendingAssignmentTasks(tdb, ALICE)).tasks).toEqual([]);
  });

  it("stops showing a LOW priority task once it has been acknowledged", async () => {
    await seed([{ id: uid("1"), priority: "low" }]);

    await acknowledgeTaskAssignments(tdb, ALICE, [uid("1")]);

    expect(await ackRowCount(uid("1"), ALICE)).toBe(1);
    expect((await getPendingAssignmentTasks(tdb, ALICE)).tasks).toEqual([]);
  });

  // C11. Asserting only "still returned" is green when the POST is broken and writes nothing, so the
  // ack row is asserted FIRST -- the repeat rule only means something once the row provably exists.
  it("KEEPS showing an urgent task after it has been acknowledged (and the ack row is really there)", async () => {
    await seed([{ id: uid("1"), priority: "urgent" }]);

    await acknowledgeTaskAssignments(tdb, ALICE, [uid("1")]);

    expect(await ackRowCount(uid("1"), ALICE)).toBe(1);
    expect((await getPendingAssignmentTasks(tdb, ALICE)).tasks.map((t) => t.id)).toEqual([uid("1")]);
  });

  it("KEEPS showing a high-priority task after acknowledgement (and the ack row is really there)", async () => {
    await seed([{ id: uid("1"), priority: "high" }]);

    await acknowledgeTaskAssignments(tdb, ALICE, [uid("1")]);

    expect(await ackRowCount(uid("1"), ALICE)).toBe(1);
    expect((await getPendingAssignmentTasks(tdb, ALICE)).tasks.map((t) => t.id)).toEqual([uid("1")]);
  });

  it("KEEPS showing an OVERDUE low-priority task after acknowledgement", async () => {
    await seed([{ id: uid("1"), priority: "low", dueDate: shiftDays(todayCt(), -1) }]);

    await acknowledgeTaskAssignments(tdb, ALICE, [uid("1")]);

    expect(await ackRowCount(uid("1"), ALICE)).toBe(1);
    expect((await getPendingAssignmentTasks(tdb, ALICE)).tasks.map((t) => t.id)).toEqual([uid("1")]);
  });

  it("does NOT treat a task due TODAY as overdue", async () => {
    await seed([{ id: uid("1"), priority: "normal", dueDate: todayCt() }]);

    await acknowledgeTaskAssignments(tdb, ALICE, [uid("1")]);

    expect((await getPendingAssignmentTasks(tdb, ALICE)).tasks).toEqual([]);
  });

  it("stops repeating once an urgent task leaves pending", async () => {
    await seed([{ id: uid("1"), priority: "urgent" }]);
    await acknowledgeTaskAssignments(tdb, ALICE, [uid("1")]);
    await pg.exec(`UPDATE public.tasks SET status = 'completed' WHERE id = '${uid("1")}'`);

    expect((await getPendingAssignmentTasks(tdb, ALICE)).tasks).toEqual([]);
  });

  it("ignores ids for tasks assigned to somebody else — no row, no error", async () => {
    await seed([{ id: uid("1"), assignedTo: BOB, priority: "normal" }]);

    const acknowledged = await acknowledgeTaskAssignments(tdb, ALICE, [uid("1")]);

    expect(acknowledged).toBe(0);
    expect(await ackRowCount(uid("1"), ALICE)).toBe(0);
    // ...and Bob is still shown his own task: acknowledging is not a way to silence someone else's.
    expect((await getPendingAssignmentTasks(tdb, BOB)).tasks.map((t) => t.id)).toEqual([uid("1")]);
  });

  it("acknowledges the caller's own ids in a mixed payload and drops the rest", async () => {
    await seed([
      { id: uid("1"), assignedTo: ALICE, priority: "normal" },
      { id: uid("2"), assignedTo: BOB, priority: "normal" },
    ]);

    const acknowledged = await acknowledgeTaskAssignments(tdb, ALICE, [uid("1"), uid("2")]);

    expect(acknowledged).toBe(1);
    expect(await ackRowCount(uid("1"), ALICE)).toBe(1);
    expect(await ackRowCount(uid("2"), ALICE)).toBe(0);
  });

  it("is a no-op on a duplicate acknowledge, not an error (StrictMode double-invoke, retries)", async () => {
    await seed([{ id: uid("1"), priority: "normal" }]);

    await acknowledgeTaskAssignments(tdb, ALICE, [uid("1")]);
    await expect(acknowledgeTaskAssignments(tdb, ALICE, [uid("1")])).resolves.toBe(1);
    await expect(acknowledgeTaskAssignments(tdb, ALICE, [uid("1"), uid("1")])).resolves.toBe(1);

    expect(await ackRowCount(uid("1"), ALICE)).toBe(1);
  });

  // A stale client sending a non-uuid must not reach Postgres: `invalid input syntax for type uuid`
  // is 22P02, which the error handler turns into a 500 on what is meant to be a silent no-op.
  it("drops ids that are not uuids instead of handing them to Postgres", async () => {
    await seed([{ id: uid("1"), priority: "normal" }]);

    await expect(acknowledgeTaskAssignments(tdb, ALICE, ["not-a-uuid", uid("1")])).resolves.toBe(1);
    await expect(acknowledgeTaskAssignments(tdb, ALICE, ["", "  "])).resolves.toBe(0);
    await expect(acknowledgeTaskAssignments(tdb, ALICE, [])).resolves.toBe(0);
  });

  it("records the acknowledgement against the CALLER, so a reassignment pops for the new assignee", async () => {
    await seed([{ id: uid("1"), assignedTo: ALICE, priority: "normal" }]);
    await acknowledgeTaskAssignments(tdb, ALICE, [uid("1")]);

    await pg.exec(`UPDATE public.tasks SET assigned_to = '${BOB}' WHERE id = '${uid("1")}'`);

    expect((await getPendingAssignmentTasks(tdb, BOB)).tasks.map((t) => t.id)).toEqual([uid("1")]);
  });
});
