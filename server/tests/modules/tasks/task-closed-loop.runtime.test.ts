// REAL-SQL (PGlite) proof for the task closed loop: thread, acknowledgement, "needs your attention",
// and the merged timeline.
//
// THE ACK MODEL IS THE PART THAT IS EASY TO GET GREEN AND WRONG. The obvious design clears
// `assigner_ack_at` whenever a new reply lands. Under that design the comparison
// `assigner_ack_at < last_reply_at` is UNREACHABLE — an ack only ever writes a timestamp at least as
// new as the reply it acknowledges, so every "a reply after an ack re-raises it" case runs through the
// `IS NULL` branch, and deleting the comparison leaves the whole suite green. This design keeps the
// column MONOTONIC and has the ack carry the timestamp the client actually RENDERED, which makes the
// comparison load-bearing and closes the read-modify-write race at the same time. The tests below
// therefore assert on `assigner_ack_at IS NOT NULL` at the moment the task is re-raised — without that
// assertion they would pass against the unreachable-branch design too.
//
// THE TIMELINE'S AUDIT HALF IS EXERCISED THROUGH THE REAL TRIGGER, not a hand-written fixture. The rows
// come from migration 0035's actual `audit_trigger_func()` executed from disk, because the entire point
// of the adapter is that `changes` is `{col: {old, new}}` keyed by COLUMN with TEXT values — not the
// `FormattedAuditFieldChange[]` array the existing activity feed renders. A fixture that retyped the
// shape could agree with the adapter and disagree with production.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { auditLog, jobQueue, taskComments, tasks } from "@trock-crm/shared/schema";
import {
  ackTaskReplies,
  getTaskTimeline,
  getTasksAwaitingMe,
  listTaskComments,
  mapTaskAuditChanges,
  postTaskComment,
} from "../../../src/modules/tasks/closed-loop-service.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { migrationSql } from "../../helpers/migration-sql.js";

const uid = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, "0")}`;

const ASSIGNEE = uid("a1");
const ASSIGNER = uid("a2");
const STRANGER = uid("a3");
const DEPARTED = uid("a4"); // deactivated — this repo deactivates rather than deletes
const OFFICE = uid("0f");

const TASK = uid("b1");
const DONE_TASK = uid("b2");
const MACHINE_TASK = uid("b3"); // created_by IS NULL, source 'automated'
const DEPARTED_TASK = uid("b4"); // assigner exists but is inactive
const OTHER_TASK = uid("b5"); // assigned out by somebody else
const SELF_TASK = uid("b6"); // assigned to and created by the SAME person

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

async function taskRow(id: string) {
  const result = await pg.query<{
    last_reply_at: Date | null;
    last_reply_by: string | null;
    assigner_ack_at: Date | null;
  }>(`SELECT last_reply_at, last_reply_by, assigner_ack_at FROM tasks WHERE id = $1`, [id]);
  return result.rows[0]!;
}

async function replyJobs() {
  const result = await pg.query<{ payload: any }>(
    `SELECT payload FROM job_queue WHERE payload->>'eventName' = 'task.replied' ORDER BY id`
  );
  return result.rows.map((r) => r.payload);
}

async function seedTasks() {
  await pg.exec(`
    DELETE FROM job_queue;
    DELETE FROM audit_log;
    DELETE FROM task_comments;
    DELETE FROM tasks;

    INSERT INTO tasks (id, title, type, priority, status, assigned_to, created_by, last_assigned_by, source, origin_rule) VALUES
      ('${TASK}',          'Send the roof photos', 'manual','normal','pending',  '${ASSIGNEE}', '${ASSIGNER}', NULL, 'manual',    NULL),
      ('${DONE_TASK}',     'Closed then answered', 'manual','normal','completed','${ASSIGNEE}', '${ASSIGNER}', NULL, 'manual',    NULL),
      ('${MACHINE_TASK}',  'Deal has stalled',     'system','normal','pending',  '${ASSIGNEE}', NULL,          NULL,          'automated', 'deal_stalled'),
      ('${DEPARTED_TASK}', 'Chase the permit',     'manual','normal','pending',  '${ASSIGNEE}', '${DEPARTED}', NULL, 'manual',    NULL),
      ('${OTHER_TASK}',    'Not mine to watch',    'manual','normal','pending',  '${ASSIGNEE}', '${STRANGER}', NULL, 'manual',    NULL),
      -- Assigned to and created by the SAME person: the only shape in which the author IS the
      -- assignee AND the assigner at once, and therefore the only one that reaches the self-reply
      -- skip. Every other fixture short-circuits on "the author is not the assignee" before it.
      ('${SELF_TASK}',     'My own reminder',      'manual','normal','pending',  '${ASSIGNEE}', '${ASSIGNEE}', NULL, 'manual',    NULL);
  `);
}

/** Post a reply with an explicit created_at so interleavings are deterministic, not clock-dependent. */
async function replyAt(taskId: string, authorId: string, body: string, at: string) {
  await pg.exec(`
    INSERT INTO task_comments (task_id, author_id, body, kind, created_at)
    VALUES ('${taskId}', '${authorId}', '${body}', 'reply', '${at}');
    UPDATE tasks
       SET last_reply_at = GREATEST(COALESCE(last_reply_at, '-infinity'::timestamptz), '${at}'::timestamptz),
           last_reply_by = '${authorId}'
     WHERE id = '${taskId}';
  `);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(tenantSchemaSql("public", [tasks, taskComments, auditLog, jobQueue]));
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE deals (id uuid PRIMARY KEY, name text, is_change_order boolean NOT NULL DEFAULT false,
      deal_number text, project_number text, is_active boolean NOT NULL DEFAULT true,
      assigned_rep_id uuid, procore_project_id text);
    INSERT INTO users (id, display_name, is_active) VALUES
      ('${ASSIGNEE}','Derek Barr', true),
      ('${ASSIGNER}','Adam Shaw',  true),
      ('${STRANGER}','Someone Else', true),
      ('${DEPARTED}','Gone Person', false);
  `);
  // The REAL audit trigger function, executed from disk, so the timeline adapter is tested against the
  // `changes` shape production actually writes.
  await pg.exec(migrationSql("0035_fix_public_audit_enum_cast"));
  await pg.exec(`
    CREATE TRIGGER audit_tasks AFTER INSERT OR UPDATE OR DELETE ON tasks
      FOR EACH ROW EXECUTE FUNCTION audit_trigger_func();
  `);
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await seedTasks();
});

const POST = { officeId: OFFICE };

describe("posting a comment", () => {
  it("stamps last_reply_at / last_reply_by when the ASSIGNEE replies", async () => {
    const result = await postTaskComment(tdb, TASK, { body: "On my way", ...POST }, "rep", ASSIGNEE);

    const row = await taskRow(TASK);
    expect(row.last_reply_at).not.toBeNull();
    expect(row.last_reply_by).toBe(ASSIGNEE);
    // The stamp is the comment's OWN created_at, not a second now() — two clock reads can straddle a
    // concurrent ack and mark a reply seen that nobody rendered.
    expect(row.last_reply_at!.toISOString()).toBe(new Date(result.comment.createdAt).toISOString());
    expect(result.comment.kind).toBe("reply");
  });

  it("does NOT stamp last_reply_at when the ASSIGNER comments on their own task", async () => {
    const result = await postTaskComment(
      tdb, TASK, { body: "Any update?", ...POST }, "rep", ASSIGNER
    );

    const row = await taskRow(TASK);
    expect(row.last_reply_at).toBeNull();
    expect(row.last_reply_by).toBeNull();
    // ...and it is recorded as a note, not a reply, so the kind column means what it says.
    expect(result.comment.kind).toBe("note");
  });

  it("403s a user who is neither assignee, assigner nor admin", async () => {
    await expect(
      postTaskComment(tdb, TASK, { body: "butting in", ...POST }, "construction", STRANGER)
    ).rejects.toMatchObject({ statusCode: 403 });

    const comments = await pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM task_comments`);
    expect(comments.rows[0]?.n).toBe(0);
  });

  // "It was closed and then they answered" is a real sequence. updateTask's no-edits-after-completion
  // rule is about task FIELDS; a comment is not a field edit and conflicts with no invariant.
  it("is allowed on a COMPLETED task", async () => {
    await expect(
      postTaskComment(tdb, DONE_TASK, { body: "Sorry — just saw this", ...POST }, "rep", ASSIGNEE)
    ).resolves.toBeDefined();

    const row = await taskRow(DONE_TASK);
    expect(row.last_reply_at).not.toBeNull();
  });

  // The reply side is monotonic for the same reason the ack side is. A comment carrying an older
  // created_at than the head — a backfill, a replayed request, two API nodes with skewed clocks —
  // must not walk `last_reply_at` backwards, because doing so would silently drop the task out of the
  // assigner's bucket (the head would fall back below an existing acknowledgement).
  it("cannot walk last_reply_at BACKWARDS when a reply lands out of order", async () => {
    await pg.exec(`
      UPDATE tasks
         SET last_reply_at = '2099-01-01T00:00:00Z', last_reply_by = '${STRANGER}'
       WHERE id = '${TASK}'
    `);

    await postTaskComment(tdb, TASK, { body: "late arrival", ...POST }, "rep", ASSIGNEE);

    const row = await taskRow(TASK);
    expect(row.last_reply_at!.toISOString()).toBe("2099-01-01T00:00:00.000Z");
    expect(row.last_reply_by, "the older reply must not claim the head either").toBe(STRANGER);
  });

  it("400s a blank or whitespace-only body", async () => {
    for (const body of ["", "   ", "\n\t "]) {
      await expect(
        postTaskComment(tdb, TASK, { body, ...POST }, "rep", ASSIGNEE),
        JSON.stringify(body)
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it("keeps the thread in insertion order, oldest first", async () => {
    await postTaskComment(tdb, TASK, { body: "first", ...POST }, "rep", ASSIGNEE);
    await postTaskComment(tdb, TASK, { body: "second", ...POST }, "rep", ASSIGNER);
    await postTaskComment(tdb, TASK, { body: "third", ...POST }, "rep", ASSIGNEE);

    const { comments } = await listTaskComments(tdb, TASK, "rep", ASSIGNER);
    expect(comments.map((c) => c.body)).toEqual(["first", "second", "third"]);
    expect(comments.map((c) => c.authorName)).toEqual(["Derek Barr", "Adam Shaw", "Derek Barr"]);
  });
});

describe("the reply notification outbox", () => {
  it("enqueues exactly one task.replied job per reply, addressed to the assigner", async () => {
    await postTaskComment(tdb, TASK, { body: "On my way", ...POST }, "rep", ASSIGNEE);

    const jobs = await replyJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ taskId: TASK, assignerId: ASSIGNER, replyBody: "On my way" });

    // The office is NOT on the payload — job_queue.office_id is the single persisted authority for
    // which tenant this event belongs to, and a second copy could disagree with it.
    expect(jobs[0]).not.toHaveProperty("officeId");
    const row = await pg.query<{ office_id: string }>(
      `SELECT office_id FROM job_queue WHERE payload->>'eventName' = 'task.replied'`
    );
    expect(row.rows[0]?.office_id).toBe(OFFICE);
  });

  // The route hands this straight to the reply email, whose deep link 404s for a recipient sitting in
  // a different office without it. In-process rather than persisted, hence asserted on the return.
  it("returns the office on the notification so the email's deep link can carry it", async () => {
    const result = await postTaskComment(
      tdb, TASK, { body: "On my way", ...POST }, "rep", ASSIGNEE
    );
    expect(result.notify?.officeId).toBe(OFFICE);
  });

  it("enqueues NOTHING for a self-reply — the assigner talking to themselves", async () => {
    await postTaskComment(tdb, TASK, { body: "Any update?", ...POST }, "rep", ASSIGNER);
    expect(await replyJobs()).toHaveLength(0);
  });

  // The self-reply skip's ONLY reachable case. On every other shape the author is not the assignee, so
  // `isAssigneeReply` already short-circuits and the `assignerId !== authorId` term never runs — a
  // skip rule that can never fire is indistinguishable from one that is missing. On a task somebody
  // assigned to themselves, the author is BOTH parties, and without the term the reply mails the
  // person who just wrote it.
  it("enqueues NOTHING when the author is the assignee AND the assigner", async () => {
    await postTaskComment(tdb, SELF_TASK, { body: "note to self", ...POST }, "rep", ASSIGNEE);

    expect(await replyJobs()).toHaveLength(0);
    // ...and the reply is still stamped, because the assignee did reply — only the mail is skipped.
    expect((await taskRow(SELF_TASK)).last_reply_at).not.toBeNull();
  });

  // C6. `created_by` is NULL for every rules-engine and AI-disconnect task, and `author === assigner`
  // is FALSE against NULL — so the naive skip rule enqueues an undeliverable job on every automated
  // task, which is the majority of them.
  it("enqueues NOTHING when the task has no assigner at all", async () => {
    await postTaskComment(tdb, MACHINE_TASK, { body: "looking", ...POST }, "rep", ASSIGNEE);

    expect(await replyJobs()).toHaveLength(0);
    // The comment itself is still recorded — the thread is a record even with no one to notify.
    const { comments, loop } = await listTaskComments(tdb, MACHINE_TASK, "rep", ASSIGNEE);
    expect(comments).toHaveLength(1);
    expect(loop.notifiesAssigner).toBe(false);
    expect(loop.reason).toBe("no_assigner");
  });

  // The case that actually happens: this repo DEACTIVATES rather than deletes. Mailing a departed
  // employee is the visible half; the invisible half is a task stranded as "needs attention" forever.
  it("enqueues NOTHING when the assigner is deactivated", async () => {
    await postTaskComment(tdb, DEPARTED_TASK, { body: "permit is in", ...POST }, "rep", ASSIGNEE);

    expect(await replyJobs()).toHaveLength(0);
    const { loop } = await listTaskComments(tdb, DEPARTED_TASK, "rep", ASSIGNEE);
    expect(loop.notifiesAssigner).toBe(false);
    expect(loop.reason).toBe("assigner_inactive");
  });

  // The client must not offer a Send button the server will 403. Answered BY THE SERVER rather than
  // re-derived in the browser: construction and field_contractor users can OPEN any task in the office
  // (visibility only narrows reps) while the comment rule admits only the assignee, the assigner and
  // admin/director — two different rules, and duplicating the second one client-side is how they drift.
  it("reports whether the viewer may actually comment", async () => {
    for (const [role, id] of [["rep", ASSIGNEE], ["rep", ASSIGNER], ["admin", STRANGER]] as const) {
      const { canComment } = await listTaskComments(tdb, TASK, role, id);
      expect(canComment, `${role}/${id}`).toBe(true);
    }

    const { canComment } = await listTaskComments(tdb, TASK, "construction", STRANGER);
    expect(canComment, "an unrelated construction user").toBe(false);
  });

  it("reports a live loop on an ordinary task so the composer can say so", async () => {
    const { loop } = await listTaskComments(tdb, TASK, "rep", ASSIGNEE);
    expect(loop).toMatchObject({
      assignerId: ASSIGNER,
      assignerName: "Adam Shaw",
      assignerIsActive: true,
      notifiesAssigner: true,
      reason: "ok",
    });
  });
});

// WHO IS WAITING ON THIS TASK once it has changed hands.
//
// `created_by` answers "who typed this into existence" and never moves. PATCH /tasks/:id moves
// `assigned_to` and sends an assignment email naming the CURRENT requester as the assigner -- so
// before this, the new assignee replied and it went to whoever originally created the task. On a
// machine-created task (created_by IS NULL) it went to nobody at all, despite a human assignment
// email having just gone out.
describe("a task that has changed hands", () => {
  it("delivers the reply to the person who ASSIGNED it, not the one who created it", async () => {
    // STRANGER hands ASSIGNER's task to the assignee.
    await pg.exec(`UPDATE tasks SET last_assigned_by = '${STRANGER}' WHERE id = '${TASK}'`);

    await postTaskComment(tdb, TASK, { body: "on it", ...POST }, "rep", ASSIGNEE);

    const jobs = await replyJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].assignerId, "the current assigner, not the creator").toBe(STRANGER);
    expect(jobs[0].assignerId).not.toBe(ASSIGNER);
  });

  it("moves the task into the NEW assigner's bucket and out of the creator's", async () => {
    await pg.exec(`UPDATE tasks SET last_assigned_by = '${STRANGER}' WHERE id = '${TASK}'`);
    await replyAt(TASK, ASSIGNEE, "r1", "2026-05-01T10:00:00Z");

    expect((await getTasksAwaitingMe(tdb, STRANGER)).map((t) => t.id)).toContain(TASK);
    expect((await getTasksAwaitingMe(tdb, ASSIGNER)).map((t) => t.id)).not.toContain(TASK);
  });

  it("lets the NEW assigner acknowledge, and refuses the original creator", async () => {
    await pg.exec(`UPDATE tasks SET last_assigned_by = '${STRANGER}' WHERE id = '${TASK}'`);
    await replyAt(TASK, ASSIGNEE, "r1", "2026-05-01T10:00:00Z");

    await expect(
      ackTaskReplies(tdb, TASK, new Date("2026-05-01T10:00:00Z"), "rep", ASSIGNER)
    ).rejects.toMatchObject({ statusCode: 403 });

    const result = await ackTaskReplies(tdb, TASK, new Date("2026-05-01T10:00:00Z"), "rep", STRANGER);
    expect(result.acknowledged).toBe(true);
  });

  // The case the old model could not express at all: a human hands out a task the SYSTEM created, so
  // there is now somebody waiting on it even though created_by is still NULL.
  it("gives a machine-created task a live loop once a human assigns it", async () => {
    const before = await listTaskComments(tdb, MACHINE_TASK, "rep", ASSIGNEE);
    expect(before.loop.notifiesAssigner).toBe(false);
    expect(before.loop.reason).toBe("no_assigner");

    await pg.exec(`UPDATE tasks SET last_assigned_by = '${ASSIGNER}' WHERE id = '${MACHINE_TASK}'`);

    const after = await listTaskComments(tdb, MACHINE_TASK, "rep", ASSIGNEE);
    expect(after.loop).toMatchObject({ assignerId: ASSIGNER, notifiesAssigner: true, reason: "ok" });

    await postTaskComment(tdb, MACHINE_TASK, { body: "looking", ...POST }, "rep", ASSIGNEE);
    const jobs = await replyJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].assignerId).toBe(ASSIGNER);
  });

  // The FALLBACK, which is the other half of the resolution and the reason no backfill was needed:
  // a task that has never changed hands still delivers to the person who created it.
  it("delivers to the creator while the task has never been reassigned", async () => {
    const row = await pg.query<{ last_assigned_by: string | null }>(
      `SELECT last_assigned_by FROM tasks WHERE id = '${TASK}'`
    );
    expect(row.rows[0]!.last_assigned_by, "fixture must be un-reassigned").toBeNull();

    await postTaskComment(tdb, TASK, { body: "on it", ...POST }, "rep", ASSIGNEE);

    const jobs = await replyJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].assignerId).toBe(ASSIGNER);
  });
});

// The write sites. A column nothing stamps is a column that is always NULL.
describe("who gets recorded as the assigner", () => {
  // Creation writes NOTHING here: created_by already IS the assigner, and readers resolve
  // COALESCE(last_assigned_by, created_by). Stamping it at creation would make "never reassigned"
  // indistinguishable from "reassigned back to the creator" — the state this column exists to tell
  // apart — so the NULL is load-bearing.
  it("createTask leaves last_assigned_by NULL and still resolves the creator as the assigner", async () => {
    const { createTask } = await import("../../../src/modules/tasks/service.js");
    const created = await createTask(tdb, {
      title: "Call the roofer", type: "manual", assignedTo: ASSIGNEE, createdBy: ASSIGNER,
    });
    expect(created.lastAssignedBy).toBeNull();

    const { loop } = await listTaskComments(tdb, created.id, "rep", ASSIGNER);
    expect(loop.assignerId).toBe(ASSIGNER);
    expect(loop.notifiesAssigner).toBe(true);
  });

  // THE REASSIGNMENT. The ACTOR performing the PATCH becomes the assigner -- which is the same
  // person the assignment email already names, so the mail and the loop finally agree.
  it("updateTask re-stamps the assigner to the ACTOR when the assignment moves", async () => {
    const { updateTask } = await import("../../../src/modules/tasks/service.js");
    const updated = await updateTask(
      tdb, TASK, { assignedTo: STRANGER }, "admin", DEPARTED
    );
    expect(updated.assignedTo).toBe(STRANGER);
    expect(updated.lastAssignedBy, "the actor, not the previous assigner").toBe(DEPARTED);
    // created_by is untouched -- it still answers "who typed this into existence".
    expect(updated.createdBy).toBe(ASSIGNER);
  });

  it("leaves the assigner alone on an edit that does not move the assignment", async () => {
    const { updateTask } = await import("../../../src/modules/tasks/service.js");
    const updated = await updateTask(tdb, TASK, { title: "Renamed" }, "admin", DEPARTED);
    expect(updated.lastAssignedBy).toBeNull();
  });

  // A PATCH that names the SAME assignee is not a reassignment, and must not quietly transfer who is
  // waiting on the task to whoever happened to touch it.
  it("leaves the assigner alone when the assignment is re-sent unchanged", async () => {
    const { updateTask } = await import("../../../src/modules/tasks/service.js");
    const updated = await updateTask(tdb, TASK, { assignedTo: ASSIGNEE }, "admin", DEPARTED);
    expect(updated.lastAssignedBy).toBeNull();
  });
});

describe("acknowledgement", () => {

  it("403s anyone who is not the assigner — including an admin", async () => {
    await replyAt(TASK, ASSIGNEE, "r1", "2026-05-01T10:00:00Z");

    for (const [role, id] of [["rep", ASSIGNEE], ["admin", STRANGER], ["construction", STRANGER]] as const) {
      await expect(
        ackTaskReplies(tdb, TASK, new Date("2026-05-01T10:00:00Z"), role, id),
        role
      ).rejects.toMatchObject({ statusCode: 403 });
    }
    expect((await taskRow(TASK)).assigner_ack_at).toBeNull();
  });

  it("sets assigner_ack_at and drops the task out of awaiting-me", async () => {
    await replyAt(TASK, ASSIGNEE, "r1", "2026-05-01T10:00:00Z");
    expect((await getTasksAwaitingMe(tdb, ASSIGNER)).map((t) => t.id)).toContain(TASK);

    const result = await ackTaskReplies(
      tdb, TASK, new Date("2026-05-01T10:00:00Z"), "rep", ASSIGNER
    );

    expect(result.acknowledged).toBe(true);
    expect((await taskRow(TASK)).assigner_ack_at!.toISOString()).toBe("2026-05-01T10:00:00.000Z");
    expect((await getTasksAwaitingMe(tdb, ASSIGNER)).map((t) => t.id)).not.toContain(TASK);
  });

  // THE ONE THE WHOLE MODEL EXISTS FOR. The assertion on `assigner_ack_at IS NOT NULL` is what makes
  // this a test of the COMPARISON rather than of the IS NULL branch: under a design that cleared the
  // ack, this task would be back in the bucket with a NULL ack and the comparison would never run.
  it("re-raises the task when a reply lands AFTER an acknowledgement, via the comparison", async () => {
    await replyAt(TASK, ASSIGNEE, "r1", "2026-05-01T10:00:00Z");
    await ackTaskReplies(tdb, TASK, new Date("2026-05-01T10:00:00Z"), "rep", ASSIGNER);
    expect((await getTasksAwaitingMe(tdb, ASSIGNER)).map((t) => t.id)).not.toContain(TASK);

    await replyAt(TASK, ASSIGNEE, "r2", "2026-05-01T11:00:00Z");

    const row = await taskRow(TASK);
    expect(row.assigner_ack_at, "the ack must SURVIVE the new reply").not.toBeNull();
    expect(row.assigner_ack_at!.getTime()).toBeLessThan(row.last_reply_at!.getTime());
    expect((await getTasksAwaitingMe(tdb, ASSIGNER)).map((t) => t.id)).toContain(TASK);
  });

  // THE LOST UPDATE. Assigner loads the thread and sees r1 -> assignee posts r2 -> the assigner's ack
  // arrives. An ack that wrote now() would cover r2 and bury a reply nobody read, forever. Carrying
  // the timestamp the client RENDERED is what makes that impossible.
  it("does not bury a reply that landed between the render and the acknowledgement", async () => {
    await replyAt(TASK, ASSIGNEE, "r1", "2026-05-01T10:00:00Z");
    const renderedUpTo = new Date("2026-05-01T10:00:00Z"); // what the assigner actually saw
    await replyAt(TASK, ASSIGNEE, "r2", "2026-05-01T10:00:30Z"); // lands mid-flight

    const result = await ackTaskReplies(tdb, TASK, renderedUpTo, "rep", ASSIGNER);

    expect(result.acknowledged).toBe(true);
    expect((await taskRow(TASK)).assigner_ack_at!.toISOString()).toBe("2026-05-01T10:00:00.000Z");
    expect((await getTasksAwaitingMe(tdb, ASSIGNER)).map((t) => t.id)).toContain(TASK);
  });

  it("refuses an acknowledgement that runs AHEAD of the newest reply", async () => {
    await replyAt(TASK, ASSIGNEE, "r1", "2026-05-01T10:00:00Z");

    const result = await ackTaskReplies(
      tdb, TASK, new Date("2026-05-01T23:00:00Z"), "rep", ASSIGNER
    );

    expect(result.acknowledged).toBe(false);
    expect((await taskRow(TASK)).assigner_ack_at).toBeNull();
    expect((await getTasksAwaitingMe(tdb, ASSIGNER)).map((t) => t.id)).toContain(TASK);
  });

  it("is monotonic — a late acknowledgement of an older render cannot walk the ack backwards", async () => {
    await replyAt(TASK, ASSIGNEE, "r1", "2026-05-01T10:00:00Z");
    await replyAt(TASK, ASSIGNEE, "r2", "2026-05-01T11:00:00Z");
    await ackTaskReplies(tdb, TASK, new Date("2026-05-01T11:00:00Z"), "rep", ASSIGNER);

    await ackTaskReplies(tdb, TASK, new Date("2026-05-01T10:00:00Z"), "rep", ASSIGNER);

    expect((await taskRow(TASK)).assigner_ack_at!.toISOString()).toBe("2026-05-01T11:00:00.000Z");
  });

  it("acknowledges nothing on a task that has had no replies", async () => {
    const result = await ackTaskReplies(tdb, TASK, new Date("2026-05-01T10:00:00Z"), "rep", ASSIGNER);
    expect(result.acknowledged).toBe(false);
    expect((await taskRow(TASK)).assigner_ack_at).toBeNull();
  });
});

describe("/tasks/awaiting-me", () => {
  it("returns only tasks I ASSIGNED that have an unread reply", async () => {
    await replyAt(TASK, ASSIGNEE, "mine", "2026-05-01T10:00:00Z");
    await replyAt(OTHER_TASK, ASSIGNEE, "not mine", "2026-05-01T10:05:00Z");

    const rows = await getTasksAwaitingMe(tdb, ASSIGNER);
    expect(rows.map((t) => t.id)).toEqual([TASK]);
  });

  // The direct answer to "Adam forgets what he assigned": these tasks are assigned to somebody ELSE,
  // so they appear nowhere in his own list (getTasks filters assigned_to).
  it("surfaces a task assigned to someone else, which the normal list never shows", async () => {
    const { getTasks } = await import("../../../src/modules/tasks/service.js");
    await replyAt(TASK, ASSIGNEE, "mine", "2026-05-01T10:00:00Z");

    const normal = await getTasks(tdb, {}, "rep", ASSIGNER);
    expect(normal.tasks.map((t: { id: string }) => t.id)).not.toContain(TASK);
    expect((await getTasksAwaitingMe(tdb, ASSIGNER)).map((t) => t.id)).toContain(TASK);
  });

  it("counts only the replies made SINCE the last acknowledgement", async () => {
    await replyAt(TASK, ASSIGNEE, "r1", "2026-05-01T10:00:00Z");
    await replyAt(TASK, ASSIGNEE, "r2", "2026-05-01T11:00:00Z");
    expect((await getTasksAwaitingMe(tdb, ASSIGNER))[0]!.unreadReplyCount).toBe(2);

    await ackTaskReplies(tdb, TASK, new Date("2026-05-01T10:00:00Z"), "rep", ASSIGNER);
    const rows = await getTasksAwaitingMe(tdb, ASSIGNER);
    expect(rows[0]!.unreadReplyCount).toBe(1);
    expect(rows[0]!.lastReplyBody).toBe("r2");
  });

  it("returns the projection the task row renders from", async () => {
    await replyAt(TASK, ASSIGNEE, "r1", "2026-05-01T10:00:00Z");
    const row = await getTasksAwaitingMe(tdb, ASSIGNER);
    expect(row[0]).toMatchObject({
      id: TASK,
      title: "Send the roof photos",
      assignedToName: "Derek Barr",
      status: "pending",
      source: "manual",
    });
  });

  it("excludes seeded demo rows, like every other task projection", async () => {
    await replyAt(TASK, ASSIGNEE, "r1", "2026-05-01T10:00:00Z");
    await pg.exec(`UPDATE tasks SET is_test_data = true WHERE id = '${TASK}'`);
    expect(await getTasksAwaitingMe(tdb, ASSIGNER)).toHaveLength(0);
  });
});

describe("the merged timeline", () => {
  it("maps the trigger's {col: {old, new}} shape, not the activity feed's array shape", () => {
    const changes = {
      status: { old: "pending", new: "completed" },
      due_date: { old: null, new: "2026-05-09" },
      priority: { old: "high", new: null },
    };

    const mapped = mapTaskAuditChanges(changes);
    const byKey = Object.fromEntries(mapped.map((c) => [c.key, c]));

    expect(byKey.status).toMatchObject({
      label: "Status", fromDisplay: "pending", toDisplay: "completed", transition: "changed",
    });
    expect(byKey.due_date).toMatchObject({ label: "Due date", transition: "set" });
    expect(byKey.priority).toMatchObject({ label: "Priority", transition: "cleared" });
  });

  it("drops bookkeeping columns nobody edited", () => {
    const mapped = mapTaskAuditChanges({
      updated_at: { old: "a", new: "b" },
      last_reply_at: { old: null, new: "x" },
      assigner_ack_at: { old: null, new: "x" },
      title: { old: "old", new: "new" },
    });
    expect(mapped.map((c) => c.key)).toEqual(["title"]);
  });

  it("survives a malformed changes payload instead of throwing", () => {
    for (const bad of [null, undefined, "nope", 7, [], { status: "not an object" }]) {
      expect(() => mapTaskAuditChanges(bad), JSON.stringify(bad)).not.toThrow();
    }
  });

  it("merges audit rows and comments in timestamp order", async () => {
    await pg.exec(`SELECT set_config('app.current_user_id', '${ASSIGNER}', false)`);
    await pg.exec(`UPDATE tasks SET priority = 'urgent' WHERE id = '${TASK}'`);
    await postTaskComment(tdb, TASK, { body: "On it", ...POST }, "rep", ASSIGNEE);
    await pg.exec(`UPDATE tasks SET status = 'in_progress' WHERE id = '${TASK}'`);
    await pg.exec(`SELECT set_config('app.current_user_id', '', false)`);

    const entries = await getTaskTimeline(tdb, TASK, "rep", ASSIGNER);

    const times = entries.map((e) => new Date(e.occurredAt).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(entries.some((e) => e.kind === "comment" && e.body === "On it")).toBe(true);
    expect(entries.some((e) => e.kind === "audit")).toBe(true);
  });

  // C3: the trigger never writes entity_type — filtering on it returns nothing at all.
  it("filters on table_name/record_id and finds rows whose entity_type is NULL", async () => {
    await pg.exec(`SELECT set_config('app.current_user_id', '${ASSIGNER}', false)`);
    await pg.exec(`UPDATE tasks SET title = 'Renamed' WHERE id = '${TASK}'`);
    await pg.exec(`SELECT set_config('app.current_user_id', '', false)`);

    const nulls = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE table_name = 'tasks' AND entity_type IS NULL`
    );
    expect(nulls.rows[0]!.n).toBeGreaterThan(0);

    const entries = await getTaskTimeline(tdb, TASK, "rep", ASSIGNER);
    expect(entries.filter((e) => e.kind === "audit").length).toBeGreaterThan(0);
  });

  it("does not leak another task's audit rows", async () => {
    await pg.exec(`SELECT set_config('app.current_user_id', '${ASSIGNER}', false)`);
    await pg.exec(`UPDATE tasks SET title = 'Other renamed' WHERE id = '${OTHER_TASK}'`);
    await pg.exec(`SELECT set_config('app.current_user_id', '', false)`);

    const entries = await getTaskTimeline(tdb, TASK, "rep", ASSIGNER);
    expect(entries.every((e) => !e.summary.includes("Other renamed"))).toBe(true);
  });

  it("names the human who made the change on a MANUAL task", async () => {
    await pg.exec(`SELECT set_config('app.current_user_id', '${ASSIGNER}', false)`);
    await pg.exec(`UPDATE tasks SET priority = 'urgent' WHERE id = '${TASK}'`);
    await pg.exec(`SELECT set_config('app.current_user_id', '', false)`);

    const audit = (await getTaskTimeline(tdb, TASK, "rep", ASSIGNER)).filter((e) => e.kind === "audit");
    expect(audit.at(-1)).toMatchObject({ actorLabel: "Adam Shaw", actorType: "user" });
  });

  // C4 — THE MISATTRIBUTION THIS RULE EXISTS TO PREVENT, scoped to the event it is true of.
  //
  // The worker DOES set app.current_user_id (email-sync.ts:1348, via withTenantAuditContext), and one
  // of its call sites wraps the whole 25-rule engine — so a cron-written task's CREATION lands in
  // audit_log with changed_by = a REAL HUMAN whose GUC the job borrowed, and rendering it would
  // caption a machine's work "Adam Shaw created this task".
  //
  // That is true of the creation event and of nothing else. A task's `source` describes who MADE it,
  // not who touched it afterwards, so applying the rule to every row was an over-correction in the
  // opposite direction: a person who later re-prioritises a machine-generated task had their own edit
  // captured as "System". Same insight as comments staying author-derived, one level down.
  it("renders a machine task's CREATION as System even though changed_by is a real person", async () => {
    await pg.exec(`SELECT set_config('app.current_user_id', '${ASSIGNER}', false)`);
    await pg.exec(`
      INSERT INTO tasks (id, title, type, priority, status, assigned_to, created_by, source, origin_rule)
      VALUES ('${uid("b7")}', 'Cron made this', 'system','normal','pending','${ASSIGNEE}', NULL, 'automated', 'deal_stalled');
    `);
    await pg.exec(`SELECT set_config('app.current_user_id', '', false)`);

    const changed = await pg.query<{ changed_by: string }>(
      `SELECT changed_by FROM audit_log WHERE record_id = '${uid("b7")}' AND action = 'insert'`
    );
    expect(changed.rows[0]!.changed_by, "the fixture must really carry a human").toBe(ASSIGNER);

    const entries = await getTaskTimeline(tdb, uid("b7"), "rep", ASSIGNEE);
    const creation = entries.find((e) => e.kind === "audit" && e.action === "insert")!;
    expect(creation.actorType).toBe("system");
    expect(creation.actorLabel).toBe("System (deal_stalled)");
    expect(creation.actorLabel).not.toContain("Adam");
  });

  // The other half. Over-correcting here is its own misattribution: the person who made the edit is
  // recorded on the row, and calling their work "System" hides a real human decision in an
  // accountability surface.
  it("names the HUMAN who later edits a machine-created task", async () => {
    await pg.exec(`SELECT set_config('app.current_user_id', '${ASSIGNER}', false)`);
    await pg.exec(`UPDATE tasks SET priority = 'urgent' WHERE id = '${MACHINE_TASK}'`);
    await pg.exec(`SELECT set_config('app.current_user_id', '', false)`);

    const audit = (await getTaskTimeline(tdb, MACHINE_TASK, "rep", ASSIGNEE)).filter(
      (e) => e.kind === "audit" && e.action === "update"
    );
    expect(audit.at(-1)).toMatchObject({ actorLabel: "Adam Shaw", actorType: "user" });
  });

  // ...and an UPDATE with no attributable actor still reads as System rather than as an empty name.
  it("renders an unattributed edit to a machine task as System", async () => {
    await pg.exec(`UPDATE tasks SET priority = 'low' WHERE id = '${MACHINE_TASK}'`);

    const audit = (await getTaskTimeline(tdb, MACHINE_TASK, "rep", ASSIGNEE)).filter(
      (e) => e.kind === "audit" && e.action === "update"
    );
    expect(audit.at(-1)).toMatchObject({ actorLabel: "System", actorType: "system" });
  });

  // ...but a COMMENT on that same machine task was written by a person, and must say so. The source
  // rule is about `changed_by` on audit rows, and applying it to authored rows would be a new lie.
  it("still names the human author of a comment on a machine task", async () => {
    await postTaskComment(tdb, MACHINE_TASK, { body: "looking now", ...POST }, "rep", ASSIGNEE);

    const entries = await getTaskTimeline(tdb, MACHINE_TASK, "rep", ASSIGNEE);
    const comment = entries.find((e) => e.kind === "comment")!;
    expect(comment).toMatchObject({ actorLabel: "Derek Barr", actorType: "user" });
  });

  it("renders a NULL actor on a manual task as System", async () => {
    // No app.current_user_id set — this is what a script or an unattributed write looks like.
    await pg.exec(`UPDATE tasks SET priority = 'low' WHERE id = '${TASK}'`);

    const audit = (await getTaskTimeline(tdb, TASK, "rep", ASSIGNER)).filter((e) => e.kind === "audit");
    expect(audit.at(-1)).toMatchObject({ actorLabel: "System", actorType: "system" });
  });

  // A timeline capped with an ASCENDING limit shows a busy task its FIRST 200 events and hides
  // everything recent — the exact opposite of what the surface is for. The window is taken
  // newest-first and then presented in chronological order.
  it("keeps the NEWEST events when a task has more history than the window", async () => {
    await pg.exec(`SELECT set_config('app.current_user_id', '${ASSIGNER}', false)`);
    // Each UPDATE must change the value: audit_trigger_func only writes a row for columns that
    // actually differ, so a loop writing the same title produces ONE audit row, not thirty.
    for (let i = 0; i < 30; i += 1) {
      await pg.exec(`UPDATE tasks SET title = 'edit ${i}' WHERE id = '${TASK}'`);
    }
    await pg.exec(`SELECT set_config('app.current_user_id', '', false)`);

    const entries = await getTaskTimeline(tdb, TASK, "rep", ASSIGNER, { limit: 5 });

    expect(entries).toHaveLength(5);
    // Still oldest-first for display...
    const times = entries.map((e) => new Date(e.occurredAt).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // ...but the window is the tail of the history, not its head.
    expect(entries.at(-1)!.summary).toContain("edit 29");
    expect(entries.some((e) => e.summary.includes("created this task"))).toBe(false);
  });

  it("403s a user who cannot see the task", async () => {
    await expect(getTaskTimeline(tdb, TASK, "rep", STRANGER)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(listTaskComments(tdb, TASK, "rep", STRANGER)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});
