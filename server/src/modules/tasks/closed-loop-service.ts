/**
 * The task closed loop: the thread on a task, the assigner's acknowledgement of it, the
 * "needs your attention" projection built on the two, and the merged timeline.
 *
 * Kept OUT of service.ts on purpose. service.ts is a hot file with two other branches in flight; this
 * module owns everything the loop adds and imports only the visibility/authority assertions from it,
 * so the two can be reviewed and merged independently.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals, jobQueue, taskComments, tasks, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { assertTaskCommentAuthority, assertTaskVisible, getTaskRowById } from "./service.js";

type TenantDb = NodePgDatabase<typeof schema>;

/** A single comment body cannot be unbounded — the reply text is embedded verbatim in an email. */
export const TASK_COMMENT_MAX_LENGTH = 10_000;

/** Newest-first read caps. Both surfaces are "recent activity", not an archive. */
const TIMELINE_LIMIT = 200;
const AWAITING_ME_LIMIT = 50;

export interface TaskCommentRecord {
  id: string;
  taskId: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  kind: string;
  createdAt: string;
}

/**
 * Whether a reply on this task reaches a human, and if not, why.
 *
 * Surfaced to the client so the composer can SAY SO rather than silently posting into a void. Two of
 * the three states are structural, not edge cases: `created_by` is NULL on every rules-engine and
 * AI-disconnect task, and this repo deactivates departing employees rather than deleting them.
 */
export interface TaskLoopDescriptor {
  assignerId: string | null;
  assignerName: string | null;
  assignerIsActive: boolean;
  notifiesAssigner: boolean;
  reason: "ok" | "no_assigner" | "assigner_inactive";
}

export interface TaskReplyNotification {
  taskId: string;
  taskTitle: string;
  assignerId: string;
  authorId: string;
  authorName: string | null;
  replyBody: string;
  repliedAt: string;
  /** The tenant the comment was written into — carried so the email's deep link resolves for a
   *  recipient whose own active office is a different one. */
  officeId: string;
}

export interface TaskTimelineFieldChange {
  key: string;
  label: string;
  fromDisplay: string | null;
  toDisplay: string | null;
  transition: "changed" | "set" | "cleared";
}

export interface TaskTimelineEntry {
  id: string;
  kind: "audit" | "comment";
  occurredAt: string;
  actorId: string | null;
  actorLabel: string;
  actorType: "user" | "system";
  action: string;
  summary: string;
  body: string | null;
  fieldChanges: TaskTimelineFieldChange[];
}

type LoopTaskRow = {
  id: string;
  title: string;
  status: string;
  source: string;
  originRule: string | null;
  assignedTo: string;
  createdBy: string | null;
  /** WHO last handed this task over; NULL until it is reassigned. Resolved against createdBy — see
   *  resolveTaskAssignerId. */
  lastAssignedBy: string | null;
  lastReplyAt: Date | null;
  assignerAckAt: Date | null;
};

// ---------------------------------------------------------------------------------------------
// Timeline adapters
// ---------------------------------------------------------------------------------------------

/**
 * Columns that change on their own and are not an event anybody wants to read.
 *
 * `updated_at` is stamped by set_tasks_updated_at on EVERY update, so it appears in every audit row;
 * the three closed-loop columns are this feature's own bookkeeping and would narrate themselves
 * ("Adam changed Last reply at") on top of the comment the timeline already shows; entity_snapshot is
 * a large opaque blob. An audit row whose only changes are in this set is dropped entirely.
 */
const TIMELINE_NOISE_COLUMNS = new Set([
  "updated_at",
  "last_reply_at",
  "last_reply_by",
  "assigner_ack_at",
  "entity_snapshot",
  "is_overdue",
]);

const TIMELINE_FIELD_LABELS: Record<string, string> = {
  assigned_to: "Assignee",
  completed_at: "Completed at",
  due_date: "Due date",
  due_time: "Due time",
  priority: "Priority",
  scheduled_for: "Scheduled for",
  started_at: "Started at",
  status: "Status",
  title: "Title",
  description: "Description",
  waiting_on: "Waiting on",
  blocked_by: "Blocked by",
};

function humanizeColumn(column: string) {
  const known = TIMELINE_FIELD_LABELS[column];
  if (known) return known;
  const words = column.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function displayValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  return String(value);
}

/**
 * Adapt the audit trigger's `changes` payload into renderable field changes.
 *
 * WRITTEN AS AN ADAPTER, NOT REUSED. `audit_trigger_func` (0035:43) writes
 * `{ column_name: { old: text, new: text } }` — an OBJECT keyed by column, with TEXT values, produced
 * by a per-column `::TEXT` cast. The existing activity feed renders `FormattedAuditFieldChange[]`, an
 * ARRAY built by the application-level rich logger into `field_changes_jsonb` — a column that has no
 * task write surface at all and is NULL for every row this timeline reads. The two shapes have nothing
 * in common, so there is nothing to reuse.
 *
 * Total on its input: `changes` is jsonb and nothing constrains its shape, so a malformed payload
 * returns [] rather than taking the whole timeline request down.
 */
export function mapTaskAuditChanges(changes: unknown): TaskTimelineFieldChange[] {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];

  const out: TaskTimelineFieldChange[] = [];
  for (const [column, raw] of Object.entries(changes as Record<string, unknown>)) {
    if (TIMELINE_NOISE_COLUMNS.has(column)) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;

    const pair = raw as { old?: unknown; new?: unknown };
    const fromDisplay = displayValue(pair.old);
    const toDisplay = displayValue(pair.new);
    if (fromDisplay === null && toDisplay === null) continue;

    out.push({
      key: column,
      label: humanizeColumn(column),
      fromDisplay,
      toDisplay,
      transition: fromDisplay === null ? "set" : toDisplay === null ? "cleared" : "changed",
    });
  }
  return out;
}

/**
 * The actor label for an AUDIT row, derived from the task's own `source` — never from `changed_by`.
 *
 * The worker DOES set `app.current_user_id` (worker/src/jobs/email-sync.ts:1348, via
 * `withTenantAuditContext`), and one of its two call sites wraps `evaluateTaskRules(...)`, i.e. the
 * entire 25-rule engine when it runs from inbound email. So a machine-generated task lands in
 * audit_log with `changed_by = <a real human>`, and rendering `changed_by` would caption a cron job's
 * work "Sarah created this task" — the exact misattribution `tasks.source` was introduced to fix, one
 * layer up. `source` is recorded at write time by the site that made the row, so it cannot be fooled
 * by whichever GUC happened to be set.
 *
 * DELIBERATELY NOT USED FOR COMMENTS. A comment on a machine-generated task was still typed by a
 * person; attributing it to "System" would be a fresh lie in the other direction.
 */
export function buildTaskAuditActorLabel(
  task: { source: string; originRule: string | null },
  action: string,
  changedBy: string | null,
  actorDisplayName: string | null
): { actorLabel: string; actorType: "user" | "system" } {
  // SCOPED TO THE CREATION EVENT, and only that. `source` records who MADE the task; it says nothing
  // about who touched it afterwards. Applying it to every row was an over-correction in the opposite
  // direction — a person who later re-prioritises or reassigns a machine-generated task had their own
  // edit captured as "System", which hides a real human decision in an accountability surface.
  if (action === "insert" && task.source === "automated") {
    return {
      actorLabel: task.originRule ? `System (${task.originRule})` : "System",
      actorType: "system",
    };
  }
  if (changedBy && actorDisplayName) return { actorLabel: actorDisplayName, actorType: "user" };
  // No attributable actor: a script, a direct SQL edit, or a path that never set the GUC.
  return { actorLabel: "System", actorType: "system" };
}

function buildAuditSummary(
  actorLabel: string,
  action: string,
  fieldChanges: TaskTimelineFieldChange[]
): string {
  if (action === "insert") return `${actorLabel} created this task`;
  if (action === "delete") return `${actorLabel} deleted this task`;

  const first = fieldChanges[0];
  if (!first) return `${actorLabel} updated this task`;

  const extra = fieldChanges.length > 1 ? ` (+${fieldChanges.length - 1} more)` : "";
  if (first.key === "status") {
    return `${actorLabel} moved this task from ${first.fromDisplay ?? "—"} to ${first.toDisplay ?? "—"}${extra}`;
  }
  if (first.transition === "set") {
    return `${actorLabel} set ${first.label} to ${first.toDisplay}${extra}`;
  }
  if (first.transition === "cleared") {
    return `${actorLabel} cleared ${first.label}${extra}`;
  }
  return `${actorLabel} changed ${first.label} from ${first.fromDisplay} to ${first.toDisplay}${extra}`;
}

function buildCommentSummary(actorLabel: string, kind: string) {
  if (kind === "reply") return `${actorLabel} replied`;
  if (kind === "note") return `${actorLabel} added a note`;
  return `${actorLabel} recorded a system note`;
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** Load the task with the closed-loop columns, applying the ordinary visibility rule (403s a rep who
 *  is neither its assignee nor its assigner). Returns 404 rather than null so every caller agrees. */
async function loadLoopTask(
  tenantDb: TenantDb,
  taskId: string,
  userRole: string,
  userId: string
): Promise<LoopTaskRow> {
  const task = (await getTaskRowById(tenantDb, taskId, userRole, userId)) as LoopTaskRow | null;
  if (!task) throw new AppError(404, "Task not found");
  return task;
}

/**
 * The same load, under a ROW LOCK — for the write path only.
 *
 * `postTaskComment` makes four decisions from one task row: whether the author may comment, whether
 * their comment is a REPLY (author === assignee), the stamp on `last_reply_at`, and who the reply is
 * delivered to. Under READ COMMITTED a reassignment committing between an unlocked read and those
 * decisions makes them disagree with each other — a former assignee passes the stale authority check,
 * their comment is classified as a reply and raises the task in the NEW assigner's bucket, and the
 * notification, built from the same stale row, is delivered to the FORMER assigner. Each step is
 * individually correct and the result is incoherent.
 *
 * FOR UPDATE makes the reassignment's own UPDATE queue behind this transaction, so all four decisions
 * are made against one version of the row. Deliberately NOT used by the read paths: a thread or a
 * timeline has nothing to serialise against, and locking rows to render them would be a write-blocking
 * lock taken on every page view.
 */
export async function loadLoopTaskForUpdate(
  tenantDb: TenantDb,
  taskId: string,
  userRole: string,
  userId: string
): Promise<LoopTaskRow> {
  const rows = await tenantDb
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
    .for("update");

  const task = (rows[0] ?? null) as LoopTaskRow | null;
  if (!task) throw new AppError(404, "Task not found");
  // The visibility rule applies to the locked row exactly as it does to an unlocked read; taking the
  // lock must not become a way around it.
  assertTaskVisible(task, userRole, userId);
  return task;
}

/**
 * Resolve whether a reply on this task reaches anybody.
 *
 * Both negative answers are structural. `created_by IS NULL` covers the whole rules engine and the
 * AI-disconnect cron; an inactive assigner is the case that actually happens, because this repo
 * deactivates rather than deletes — and the naive "skip if author === assigner" rule catches neither,
 * since `x === null` is false and a deactivated user id still compares unequal. Left as a stated fact
 * on the payload rather than silently rerouted to an office admin: mailing somebody a reply to a task
 * they never assigned is a different wrong answer, not a fix.
 */
/**
 * WHO IS WAITING ON THIS TASK.
 *
 * `last_assigned_by` when the task has changed hands, `created_by` otherwise — because until it does,
 * the person who created it IS the person who assigned it. The distinction is the whole point:
 * PATCH /tasks/:id moves the assignment and mails the CURRENT requester as the assigner while
 * `created_by` never moves, so delivering to `created_by` sent the new assignee's reply to whoever
 * originally typed the task — and on a machine-created task, to nobody, despite a human assignment
 * email having just gone out.
 *
 * One definition, used by delivery, acknowledgement authority and the awaiting-me scope alike, and
 * mirrored EXACTLY by 0240's expression index. If this resolution and that index ever disagree the
 * bucket silently stops using the index.
 */
export function resolveTaskAssignerId(
  task: { lastAssignedBy: string | null; createdBy: string | null }
): string | null {
  return task.lastAssignedBy ?? task.createdBy;
}

export async function getTaskLoopDescriptor(
  tenantDb: TenantDb,
  task: { lastAssignedBy: string | null; createdBy: string | null }
): Promise<TaskLoopDescriptor> {
  const assignerId = resolveTaskAssignerId(task);
  if (!assignerId) {
    return {
      assignerId: null,
      assignerName: null,
      assignerIsActive: false,
      notifiesAssigner: false,
      reason: "no_assigner",
    };
  }

  const [assigner] = await tenantDb
    .select({ id: users.id, displayName: users.displayName, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, assignerId))
    .limit(1);

  // A missing row is treated exactly like an inactive one: there is nobody to notify either way.
  const isActive = Boolean(assigner?.isActive);
  return {
    assignerId,
    assignerName: assigner?.displayName ?? null,
    assignerIsActive: isActive,
    notifiesAssigner: isActive,
    reason: isActive ? "ok" : "assigner_inactive",
  };
}

export async function listTaskComments(
  tenantDb: TenantDb,
  taskId: string,
  userRole: string,
  userId: string
): Promise<{
  task: LoopTaskRow;
  comments: TaskCommentRecord[];
  loop: TaskLoopDescriptor;
  unreadReplyCount: number;
  canComment: boolean;
}> {
  const task = await loadLoopTask(tenantDb, taskId, userRole, userId);

  const rows = await tenantDb
    .select({
      id: taskComments.id,
      taskId: taskComments.taskId,
      authorId: taskComments.authorId,
      authorName: sql<string | null>`(SELECT display_name FROM public.users WHERE id = ${taskComments.authorId})`,
      body: taskComments.body,
      kind: taskComments.kind,
      createdAt: taskComments.createdAt,
    })
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    // Oldest first: a conversation reads top-down, and the ack timestamp the client sends back is the
    // LAST one it rendered.
    .orderBy(asc(taskComments.createdAt), asc(taskComments.id));

  const ackAt = task.assignerAckAt ? new Date(task.assignerAckAt).getTime() : null;
  const unreadReplyCount = rows.filter(
    (row) =>
      row.kind === "reply" && (ackAt === null || new Date(row.createdAt as any).getTime() > ackAt)
  ).length;

  return {
    task,
    comments: rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      authorId: row.authorId,
      authorName: row.authorName,
      body: row.body,
      kind: row.kind,
      createdAt: new Date(row.createdAt as any).toISOString(),
    })),
    loop: await getTaskLoopDescriptor(tenantDb, task),
    unreadReplyCount,
    // ANSWERED BY THE SERVER, not re-derived in the browser. Opening a task and speaking on it are
    // two different permissions -- visibility only narrows reps, so a construction or field_contractor
    // user can open any task in the office while the comment rule admits only the assignee, the
    // assigner and admin/director. A client that re-implements the second rule drifts from it; this
    // hands over the same assertion's verdict so the composer cannot offer a Send the server 403s.
    canComment: canUserCommentOnTask(task, userRole, userId),
  };
}

/** The comment-authority assertion as a boolean, so the read path can report it without throwing. */
function canUserCommentOnTask(
  task: { assignedTo: string; createdBy: string | null },
  userRole: string,
  userId: string
) {
  try {
    assertTaskCommentAuthority(task, userRole, userId);
    return true;
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 403) return false;
    throw err;
  }
}

export async function getTaskTimeline(
  tenantDb: TenantDb,
  taskId: string,
  userRole: string,
  userId: string,
  options: { limit?: number } = {}
): Promise<TaskTimelineEntry[]> {
  // NEWEST-FIRST UNDER THE CAP, then presented chronologically by the sort at the bottom of this
  // function. An ascending LIMIT would pin a busy task to its FIRST 200 events and hide everything
  // recent — the exact opposite of what a timeline is for.
  const limit = options.limit ?? TIMELINE_LIMIT;
  const task = await loadLoopTask(tenantDb, taskId, userRole, userId);

  // FILTERED ON table_name/record_id, NOT entity_type. The trigger writes only
  // (table_name, record_id, action, changed_by, changes, created_at); entity_type arrived in 0117 and
  // is written ONLY by the application-level rich logger, whose surface registry has no task entry —
  // so it is NULL for every row here and filtering on it would return an empty timeline forever.
  // `audit_record_idx` (table_name, record_id, created_at) serves this exactly.
  const auditResult = await tenantDb.execute(sql`
    SELECT a.id, a.action, a.changed_by, a.changes, a.created_at, u.display_name AS actor_display_name
      FROM audit_log a
      LEFT JOIN public.users u ON u.id = a.changed_by
     WHERE a.table_name = 'tasks' AND a.record_id = ${taskId}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ${limit}
  `);
  const auditRows = ((auditResult as any).rows ?? auditResult) as Array<{
    id: number | string;
    action: string;
    changed_by: string | null;
    changes: unknown;
    created_at: Date | string;
    actor_display_name: string | null;
  }>;

  const entries: TaskTimelineEntry[] = [];

  for (const row of auditRows) {
    const fieldChanges = mapTaskAuditChanges(row.changes);
    // An update whose every changed column is bookkeeping is not an event. Insert/delete rows carry
    // `full_row` rather than `changes`, so they must not be filtered on an empty change list.
    if (row.action === "update" && fieldChanges.length === 0) continue;

    const { actorLabel, actorType } = buildTaskAuditActorLabel(
      task,
      row.action,
      row.changed_by,
      row.actor_display_name
    );
    entries.push({
      id: `audit:${row.id}`,
      kind: "audit",
      occurredAt: new Date(row.created_at as any).toISOString(),
      actorId: row.changed_by,
      actorLabel,
      actorType,
      action: row.action,
      summary: buildAuditSummary(actorLabel, row.action, fieldChanges),
      body: null,
      fieldChanges,
    });
  }

  const commentRows = await tenantDb
    .select({
      id: taskComments.id,
      authorId: taskComments.authorId,
      authorName: sql<string | null>`(SELECT display_name FROM public.users WHERE id = ${taskComments.authorId})`,
      body: taskComments.body,
      kind: taskComments.kind,
      createdAt: taskComments.createdAt,
    })
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    // Same reason as the audit half: take the newest window, present it ascending.
    .orderBy(desc(taskComments.createdAt), desc(taskComments.id))
    .limit(limit);

  for (const row of commentRows) {
    // The author is recorded on the row, so it is used directly — see buildTaskAuditActorLabel for why
    // the `source`-derived label deliberately does not apply here.
    const actorLabel = row.authorName ?? "System";
    const actorType: "user" | "system" = row.authorId && row.authorName ? "user" : "system";
    entries.push({
      id: `comment:${row.id}`,
      kind: "comment",
      occurredAt: new Date(row.createdAt as any).toISOString(),
      actorId: row.authorId,
      actorLabel,
      actorType,
      action: row.kind,
      summary: buildCommentSummary(actorLabel, row.kind),
      body: row.body,
      fieldChanges: [],
    });
  }

  // Stable merge: timestamp first, then the entry id, so two events in the same millisecond keep a
  // deterministic order between requests instead of shuffling.
  return entries.sort((a, b) => {
    const delta = new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime();
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
}

export interface AwaitingMeTask {
  id: string;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  status: string;
  source: string;
  assignedTo: string;
  assignedToName: string | null;
  createdBy: string | null;
  lastAssignedBy: string | null;
  dealId: string | null;
  dealName: string | null;
  dealIsChangeOrder: boolean | null;
  dealNumber: string | null;
  projectNumber: string | null;
  contactId: string | null;
  emailId: string | null;
  dueDate: string | null;
  dueTime: string | null;
  remindAt: string | null;
  scheduledFor: string | null;
  waitingOn: unknown;
  blockedBy: unknown;
  startedAt: string | null;
  completedAt: string | null;
  isOverdue: boolean;
  createdAt: string;
  updatedAt: string;
  lastReplyAt: string | null;
  lastReplyBy: string | null;
  lastReplyByName: string | null;
  lastReplyBody: string | null;
  assignerAckAt: string | null;
  unreadReplyCount: number;
}

/**
 * Tasks YOU assigned that carry a reply you have not acknowledged.
 *
 * NO ROLE ARGUMENT, deliberately. The scope is `created_by = you`, which is your own data by
 * definition — a role filter on top could only ever hide a rep's own assignments from them, and a rep
 * who assigns work is exactly the person the ask describes. It is also why this cannot be a `getTasks`
 * filter: that projection scopes reps to `assigned_to = me`, and these tasks are by construction
 * assigned to somebody else, which is why they appear nowhere in the assigner's list today.
 *
 * The predicate is the one `tasks_creator_awaiting_ack_idx` is partial on, verbatim.
 */
export async function getTasksAwaitingMe(
  tenantDb: TenantDb,
  userId: string,
  limit = AWAITING_ME_LIMIT
): Promise<AwaitingMeTask[]> {
  const taskColumns = tasks as typeof tasks & {
    scheduledFor: typeof tasks.dueDate;
    waitingOn: typeof tasks.dueDate;
    blockedBy: typeof tasks.dueDate;
    startedAt: typeof tasks.createdAt;
  };

  const unreadReplyCount = sql<number>`(
    SELECT COUNT(*)::int FROM task_comments c
     WHERE c.task_id = ${tasks.id}
       AND c.kind = 'reply'
       AND c.created_at > COALESCE(${tasks.assignerAckAt}, '-infinity'::timestamptz)
  )`;
  const lastReplyBody = sql<string | null>`(
    SELECT c.body FROM task_comments c
     WHERE c.task_id = ${tasks.id} AND c.kind = 'reply'
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT 1
  )`;

  const rows = await tenantDb
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      type: tasks.type,
      priority: tasks.priority,
      status: tasks.status,
      source: tasks.source,
      assignedTo: tasks.assignedTo,
      assignedToName: sql<string | null>`(SELECT display_name FROM public.users WHERE id = ${tasks.assignedTo})`,
      createdBy: tasks.createdBy,
      lastAssignedBy: tasks.lastAssignedBy,
      dealId: tasks.dealId,
      dealName: deals.name,
      dealIsChangeOrder: deals.isChangeOrder,
      dealNumber: deals.dealNumber,
      projectNumber: deals.projectNumber,
      contactId: tasks.contactId,
      emailId: tasks.emailId,
      dueDate: tasks.dueDate,
      dueTime: tasks.dueTime,
      remindAt: tasks.remindAt,
      scheduledFor: taskColumns.scheduledFor,
      waitingOn: taskColumns.waitingOn,
      blockedBy: taskColumns.blockedBy,
      startedAt: taskColumns.startedAt,
      completedAt: tasks.completedAt,
      isOverdue: tasks.isOverdue,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
      lastReplyAt: tasks.lastReplyAt,
      lastReplyBy: tasks.lastReplyBy,
      lastReplyByName: sql<string | null>`(SELECT display_name FROM public.users WHERE id = ${tasks.lastReplyBy})`,
      lastReplyBody,
      assignerAckAt: tasks.assignerAckAt,
      unreadReplyCount,
    })
    .from(tasks)
    .leftJoin(deals, eq(tasks.dealId, deals.id))
    .where(
      and(
        // Scoped by the RESOLVED assigner, expression and all: a task reassigned away from you stops
        // being yours to chase, and one you handed out becomes yours even though you never created
        // it. Written as the same COALESCE 0240's index is built on -- a mismatch here would quietly
        // stop the bucket using that index.
        sql`COALESCE(${tasks.lastAssignedBy}, ${tasks.createdBy}) = ${userId}`,
        // Same demo-row exclusion as every other task projection: a filter here but not there would
        // make this bucket and the list disagree by the office's demo-row count.
        sql`COALESCE(${tasks.isTestData}, false) = false`,
        sql`${tasks.lastReplyAt} IS NOT NULL`,
        sql`(${tasks.assignerAckAt} IS NULL OR ${tasks.assignerAckAt} < ${tasks.lastReplyAt})`
      )
    )
    .orderBy(desc(tasks.lastReplyAt), desc(tasks.id))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    remindAt: row.remindAt ? new Date(row.remindAt as any).toISOString() : null,
    scheduledFor: row.scheduledFor ? new Date(row.scheduledFor as any).toISOString() : null,
    startedAt: row.startedAt ? new Date(row.startedAt as any).toISOString() : null,
    completedAt: row.completedAt ? new Date(row.completedAt as any).toISOString() : null,
    createdAt: new Date(row.createdAt as any).toISOString(),
    updatedAt: new Date(row.updatedAt as any).toISOString(),
    lastReplyAt: row.lastReplyAt ? new Date(row.lastReplyAt as any).toISOString() : null,
    assignerAckAt: row.assignerAckAt ? new Date(row.assignerAckAt as any).toISOString() : null,
    unreadReplyCount: Number(row.unreadReplyCount ?? 0),
  })) as AwaitingMeTask[];
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

export interface PostTaskCommentInput {
  body: string;
  officeId: string;
}

export async function postTaskComment(
  tenantDb: TenantDb,
  taskId: string,
  input: PostTaskCommentInput,
  userRole: string,
  userId: string
): Promise<{
  comment: TaskCommentRecord;
  task: LoopTaskRow;
  loop: TaskLoopDescriptor;
  notify: TaskReplyNotification | null;
}> {
  const body = (input.body ?? "").trim();
  if (body.length === 0) throw new AppError(400, "A comment cannot be empty");
  if (body.length > TASK_COMMENT_MAX_LENGTH) {
    throw new AppError(400, `A comment cannot be longer than ${TASK_COMMENT_MAX_LENGTH} characters`);
  }

  // NOT via loadLoopTask's visibility rule alone: viewing a task and speaking on it are different
  // permissions, and an admin/director who can see everything is explicitly allowed to speak.
  // LOCKED. Authority, reply classification, the last_reply_at stamp and the recipient are all
  // decided from this one row — see loadLoopTaskForUpdate for what happens when they are not.
  const task = await loadLoopTaskForUpdate(tenantDb, taskId, userRole, userId);
  assertTaskCommentAuthority(task, userRole, userId);
  // Deliberately NO completed/dismissed guard. updateTask's "no edits after completion" rule is about
  // task FIELDS; a comment is not a field edit, and "it was closed and then they answered" is a real
  // sequence that the loop has to be able to record.

  // DERIVED, never taken from the client. Only the assignee answering is a 'reply' — that is the event
  // the assigner is waiting on. Anyone else (the assigner chasing, an admin adding context) leaves a
  // 'note', which records the exchange without raising a loop against the person who raised it.
  const isAssigneeReply = task.assignedTo === userId;
  const kind = isAssigneeReply ? "reply" : "note";

  const [inserted] = await tenantDb
    .insert(taskComments)
    .values({ taskId, authorId: userId, body, kind })
    .returning();

  const createdAtIso = new Date(inserted.createdAt as any).toISOString();

  if (isAssigneeReply) {
    // MONOTONIC, and stamped with the COMMENT'S OWN created_at rather than a second now().
    //
    // Two clock reads are two different instants: with `now()` here, a concurrent acknowledgement can
    // land between the INSERT and this UPDATE carrying a timestamp that covers the reply, and the
    // reply is marked seen without anybody rendering it. GREATEST() additionally makes an
    // out-of-order write (a backdated import, a retried request) unable to walk the head backwards.
    await tenantDb.execute(sql`
      UPDATE tasks
         SET last_reply_at = GREATEST(COALESCE(last_reply_at, '-infinity'::timestamptz), ${createdAtIso}::timestamptz),
             last_reply_by = CASE
               WHEN last_reply_at IS NULL OR ${createdAtIso}::timestamptz >= last_reply_at
                 THEN ${userId}::uuid
               ELSE last_reply_by
             END
       WHERE id = ${taskId}::uuid
    `);
  }

  const loop = await getTaskLoopDescriptor(tenantDb, task);

  // THREE reasons to skip, and the body's single rule (`author === assigner`) covers only the first.
  // The other two are structural: a NULL assigner (the whole rules engine and the AI-disconnect cron)
  // and a deactivated one (this repo deactivates rather than deletes). Without them every reply on an
  // automated task enqueues a job with nobody to deliver to, and a departed employee keeps getting mail.
  const shouldNotify =
    isAssigneeReply && loop.notifiesAssigner && loop.assignerId !== null && loop.assignerId !== userId;

  let notify: TaskReplyNotification | null = null;
  if (shouldNotify) {
    const [author] = await tenantDb
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    notify = {
      taskId,
      taskTitle: task.title,
      assignerId: loop.assignerId!,
      authorId: userId,
      authorName: author?.displayName ?? null,
      replyBody: body,
      repliedAt: createdAtIso,
      officeId: input.officeId,
    };

    // Outbox: the in-app notification is written by the worker's task.replied handler, and the row goes
    // in BEFORE the caller commits so the event survives a crash between here and the response.
    await tenantDb.insert(jobQueue).values({
      jobType: "domain_event",
      // Listed explicitly rather than spread, so the payload carries only what the worker reads. In
      // particular it does NOT carry the office: `job_queue.office_id` below is the single persisted
      // authority for which tenant this event belongs to, and the worker resolves the schema from it
      // (queue.ts hands it to every handler). A second copy on the payload could disagree with it.
      payload: {
        eventName: "task.replied",
        taskId: notify.taskId,
        taskTitle: notify.taskTitle,
        assignerId: notify.assignerId,
        authorId: notify.authorId,
        authorName: notify.authorName,
        replyBody: notify.replyBody,
        repliedAt: notify.repliedAt,
      },
      officeId: input.officeId,
      status: "pending",
      runAfter: new Date(),
    });
  }

  return {
    comment: {
      id: inserted.id,
      taskId: inserted.taskId,
      authorId: inserted.authorId,
      authorName: null,
      body: inserted.body,
      kind: inserted.kind,
      createdAt: createdAtIso,
    },
    task,
    loop,
    notify,
  };
}

/**
 * Mark the assigner's replies as read up to the point the client actually RENDERED.
 *
 * `seenUpTo` is not a formality. An ack that wrote `now()` is a read-modify-write over a value the
 * client is concurrently racing: the assigner loads the thread (sees r1), the assignee posts r2, the
 * ack commits `now() > r2` — and r2 is marked seen forever, by somebody who never saw it. Sending back
 * the timestamp of the last rendered comment makes the ack describe what was read rather than when the
 * button was pressed.
 *
 * `seenUpTo <= last_reply_at` is the load-bearing guard and is what keeps the acknowledgement honest
 * in the other direction too: a client clock running fast cannot acknowledge into the future. It also
 * short-circuits a task with no replies at all, where `last_reply_at IS NULL` makes the comparison NULL
 * and the UPDATE matches nothing.
 */
export async function ackTaskReplies(
  tenantDb: TenantDb,
  taskId: string,
  seenUpTo: Date,
  userRole: string,
  userId: string
): Promise<{ acknowledged: boolean; lastReplyAt: string | null; assignerAckAt: string | null }> {
  if (!(seenUpTo instanceof Date) || Number.isNaN(seenUpTo.getTime())) {
    throw new AppError(400, "seenUpTo must be a valid timestamp");
  }

  const task = await loadLoopTask(tenantDb, taskId, userRole, userId);

  // ASSIGNER ONLY — not admin, not the assignee. This is not a visibility rule, it is a statement of
  // fact about a specific person: "Adam has read the reply". An admin acknowledging on Adam's behalf
  // would take the task out of Adam's bucket without Adam ever seeing it, which is the exact failure
  // the bucket exists to prevent.
  const assignerId = resolveTaskAssignerId(task);
  if (!assignerId || assignerId !== userId) {
    throw new AppError(403, "Only the person who assigned this task can acknowledge its replies");
  }

  const seenIso = seenUpTo.toISOString();
  const result = await tenantDb.execute(sql`
    UPDATE tasks
       SET assigner_ack_at = GREATEST(COALESCE(assigner_ack_at, '-infinity'::timestamptz), ${seenIso}::timestamptz)
     WHERE id = ${taskId}::uuid
       AND ${seenIso}::timestamptz <= last_reply_at
    RETURNING last_reply_at, assigner_ack_at
  `);
  const rows = ((result as any).rows ?? result) as Array<{
    last_reply_at: Date | string | null;
    assigner_ack_at: Date | string | null;
  }>;

  if (rows.length === 0) {
    // Not an error: either there is nothing to acknowledge, or the client is ahead of the server and
    // should refetch. A 400 here would make an ordinary double-click look like a failure.
    return {
      acknowledged: false,
      lastReplyAt: task.lastReplyAt ? new Date(task.lastReplyAt).toISOString() : null,
      assignerAckAt: task.assignerAckAt ? new Date(task.assignerAckAt).toISOString() : null,
    };
  }

  const row = rows[0]!;
  return {
    acknowledged: true,
    lastReplyAt: row.last_reply_at ? new Date(row.last_reply_at as any).toISOString() : null,
    assignerAckAt: row.assigner_ack_at ? new Date(row.assigner_ack_at as any).toISOString() : null,
  };
}
