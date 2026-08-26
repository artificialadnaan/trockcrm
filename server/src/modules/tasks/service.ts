import { eq, and, desc, asc, sql, or, isNull, isNotNull, inArray, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import crypto from "crypto";
import {
  deals,
  jobQueue,
  taskResolutionState,
  tasks,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { TASK_RULES } from "./rules/config.js";
import {
  buildPendingAssignmentPredicate,
  buildUnseenAssignmentSql,
  pendingAssignmentTodayCt,
} from "./pending-assignment-predicate.js";

type TenantDb = NodePgDatabase<typeof schema>;

const TASK_STATUS_VALUES = [
  "pending",
  "scheduled",
  "in_progress",
  "waiting_on",
  "blocked",
  "completed",
  "dismissed",
] as const;

type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

export type TaskSection = "overdue" | "today" | "this_week" | "later" | "upcoming" | "completed";
export const TASK_SECTIONS = ["overdue", "today", "this_week", "later", "upcoming", "completed"] as const;

export function isTaskSection(value: unknown): value is TaskSection {
  return typeof value === "string" && (TASK_SECTIONS as readonly string[]).includes(value);
}

/** Fields a task bucket can be sorted by (server-side, over the full bucket). */
export type TaskSortBy = "due_date" | "priority" | "assignee" | "created_at" | "completed_at";
export type TaskSortDir = "asc" | "desc";
export const TASK_SORT_FIELDS = ["due_date", "priority", "assignee", "created_at", "completed_at"] as const;

export function isTaskSortBy(value: unknown): value is TaskSortBy {
  return typeof value === "string" && (TASK_SORT_FIELDS as readonly string[]).includes(value);
}

/** Who created a task: a person, or the system. Recorded on the row (migration 0233), never derived. */
export type TaskSource = "manual" | "automated";
export const TASK_SOURCES = ["manual", "automated"] as const;

export function isTaskSource(value: unknown): value is TaskSource {
  return typeof value === "string" && (TASK_SOURCES as readonly string[]).includes(value);
}

export interface TaskFilters {
  assignedTo?: string;
  status?: string;
  type?: string;
  dealId?: string;
  contactId?: string;
  section?: TaskSection;
  source?: TaskSource;
  sortBy?: TaskSortBy;
  sortDir?: TaskSortDir;
  page?: number;
  limit?: number;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  type: string;
  priority?: string;
  assignedTo: string;
  createdBy?: string;
  dealId?: string;
  contactId?: string;
  emailId?: string;
  dueDate?: string;
  dueTime?: string;
  remindAt?: string;
}

type CreatedTaskSideEffectsInput = {
  actorUserId: string;
  officeId: string;
};

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: string;
  dueDate?: string | null;
  dueTime?: string | null;
  remindAt?: string | null;
  assignedTo?: string;
}

export interface TransitionTaskStatusInput {
  nextStatus: TaskStatus;
  scheduledFor?: string | Date | null;
  waitingOn?: unknown;
  blockedBy?: unknown;
}

const ACTIVE_BUCKET_STATUSES: TaskStatus[] = ["pending", "in_progress", "waiting_on", "blocked"];
const COMPLETED_BUCKET_STATUSES: TaskStatus[] = ["completed", "dismissed"];

/**
 * Every status that can surface in an OPEN bucket, and the single denominator behind the per-source
 * tab counts.
 *
 * It is ACTIVE_BUCKET_STATUSES plus 'scheduled', and the 'scheduled' is the whole reason this constant
 * exists rather than the counts reusing ACTIVE_BUCKET_STATUSES directly. The four open buckets between
 * them cover every active row (overdue / today / this_week partition by due_date, and `later` mops up
 * the far-future AND the undated), and `later` additionally unions in everything with status
 * 'scheduled'. The date-bucket counts below scope to ACTIVE_BUCKET_STATUSES only, so a scheduled task
 * shows up in the list and in no count at all. Deriving the tab totals from this set instead is what
 * makes a tab's number agree with the rows underneath it.
 */
export const OPEN_WORK_STATUSES: TaskStatus[] = [...ACTIVE_BUCKET_STATUSES, "scheduled"];
const TERMINAL_STATUSES: TaskStatus[] = ["completed", "dismissed"];

const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["scheduled", "in_progress", "waiting_on", "blocked", "completed", "dismissed"],
  scheduled: ["pending", "dismissed"],
  in_progress: ["scheduled", "waiting_on", "blocked", "completed", "dismissed"],
  waiting_on: ["scheduled", "pending", "in_progress", "blocked", "completed", "dismissed"],
  blocked: ["scheduled", "pending", "in_progress", "waiting_on", "completed", "dismissed"],
  completed: [],
  dismissed: [],
};

function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUS_VALUES as readonly string[]).includes(value);
}

function addSuppressionWindow(resolvedAt: Date, suppressionWindowDays: number) {
  return new Date(resolvedAt.getTime() + suppressionWindowDays * 24 * 60 * 60 * 1000);
}

async function writeDismissalResolutionState(
  tenantDb: TenantDb,
  task: Record<string, any>,
  resolvedAt: Date
) {
  if (!task.originRule || !task.dedupeKey || !task.officeId) return;

  const rule = TASK_RULES.find((candidate) => candidate.id === task.originRule);
  if (!rule) return;

  await tenantDb
    .insert(taskResolutionState)
    .values({
      officeId: task.officeId,
      taskId: task.id,
      originRule: task.originRule,
      dedupeKey: task.dedupeKey,
      resolutionStatus: "dismissed",
      resolutionReason: task.reasonCode ?? task.originRule,
      resolvedAt,
      suppressedUntil: addSuppressionWindow(resolvedAt, rule.suppressionWindowDays),
      entitySnapshot: task.entitySnapshot ?? null,
    })
    .onConflictDoUpdate({
      target: [taskResolutionState.originRule, taskResolutionState.dedupeKey],
      set: {
        officeId: task.officeId,
        taskId: task.id,
        resolutionStatus: "dismissed",
        resolutionReason: task.reasonCode ?? task.originRule,
        resolvedAt,
        suppressedUntil: addSuppressionWindow(resolvedAt, rule.suppressionWindowDays),
        entitySnapshot: task.entitySnapshot ?? null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Excludes seeded demo/test rows from every task read path.
 *
 * COALESCE rather than a bare `= false` because the column is only reliably set by one of the two
 * seeders: scripts/seedTestUsersAndData.ts sets it, and the auth demo seed used to omit it from its
 * INSERT column list entirely, leaving those rows to the column default. Rows written before that was
 * fixed still exist.
 */
function excludeTestTasks() {
  return sql`COALESCE(${tasks.isTestData}, false) = false`;
}

function buildOpenTaskStatusCondition(now: Date) {
  void now;
  return inArray(tasks.status as any, ACTIVE_BUCKET_STATUSES as any);
}

type TaskBucketCandidate = {
  status: TaskStatus;
  scheduledFor: Date | string | null;
};

export function isTaskIncludedInActiveBuckets(
  task: TaskBucketCandidate,
  now = new Date()
) {
  void now;
  if (task.status === "scheduled") {
    return false;
  }

  return ACTIVE_BUCKET_STATUSES.includes(task.status);
}

export async function transitionTaskStatus(
  tenantDb: TenantDb,
  taskId: string,
  input: TransitionTaskStatusInput,
  userRole: string,
  userId: string
) {
  const existing = (await getTaskRowById(tenantDb, taskId, userRole, userId)) as any;
  if (!existing) throw new AppError(404, "Task not found");

  if (existing.status === "completed" || existing.status === "dismissed") {
    throw new AppError(400, `Task is already ${existing.status}`);
  }

  if (!isTaskStatus(input.nextStatus)) {
    throw new AppError(400, "Invalid task status");
  }

  if (!ALLOWED_TRANSITIONS[existing.status as TaskStatus].includes(input.nextStatus)) {
    throw new AppError(400, `Cannot move task from ${existing.status} to ${input.nextStatus}`);
  }

  // Scoped to TERMINAL targets only. `pending -> completed` is an allowed transition, so without this
  // line /transition closes a task without ever entering completeTask — the bypass that made a guard
  // on completeTask alone decorative. Non-terminal moves stay open to anyone who can see the task:
  // "somebody else picked this up" was never the accountability concern.
  const isTerminalTransition = TERMINAL_STATUSES.includes(input.nextStatus);
  if (isTerminalTransition) {
    assertTaskCloseAuthority(existing, userRole, userId);
  }

  const updates: Record<string, any> = {
    status: input.nextStatus,
  };

  if (input.nextStatus === "scheduled") {
    if (input.scheduledFor == null) {
      throw new AppError(400, "scheduledFor is required when moving a task to scheduled");
    }
    updates.scheduledFor = input.scheduledFor instanceof Date ? input.scheduledFor : new Date(input.scheduledFor);
    updates.dueDate = null;
    updates.dueTime = null;
    updates.remindAt = null;
    updates.waitingOn = null;
    updates.blockedBy = null;
  }

  if (input.nextStatus === "waiting_on") {
    if (input.waitingOn == null) {
      throw new AppError(400, "waitingOn is required when moving a task to waiting_on");
    }
    updates.waitingOn = input.waitingOn;
    updates.blockedBy = null;
  }

  if (input.nextStatus === "blocked") {
    if (input.blockedBy == null) {
      throw new AppError(400, "blockedBy is required when moving a task to blocked");
    }
    updates.blockedBy = input.blockedBy;
    updates.waitingOn = null;
  }

  if (existing.status === "waiting_on" && input.nextStatus !== "waiting_on") {
    updates.waitingOn = null;
  }

  if (existing.status === "blocked" && input.nextStatus !== "blocked") {
    updates.blockedBy = null;
  }

  if (input.nextStatus === "in_progress" && existing.startedAt == null) {
    updates.startedAt = new Date();
  }

  if (input.nextStatus === "completed") {
    updates.completedAt = new Date();
    updates.isOverdue = false;
    updates.waitingOn = null;
    updates.blockedBy = null;
  }

  if (input.nextStatus === "dismissed") {
    updates.isOverdue = false;
    updates.waitingOn = null;
    updates.blockedBy = null;
  }

  const resolvedAt = input.nextStatus === "dismissed" ? new Date() : null;
  if (resolvedAt) {
    updates.completedAt = resolvedAt;
  }

  const result = await tenantDb
    .update(tasks)
    .set(updates)
    .where(
      and(
        eq(tasks.id, taskId),
        isTerminalTransition ? terminalTaskCloseAuthorityCondition(userRole, userId) : undefined
      )
    )
    .returning();

  if (result.length === 0) {
    throw new AppError(
      409,
      isTerminalTransition ? "Task changed before it could be closed" : "Task changed before it could be updated"
    );
  }

  const updatedTask = result[0];
  if (resolvedAt) {
    await writeDismissalResolutionState(tenantDb, updatedTask, resolvedAt);
  }

  return updatedTask;
}

// Raw column refs for ORDER BY expressions that aren't a plain Drizzle column
// (the assignee name is a correlated subquery; the id tiebreak is referenced raw).
const taskIdSqlRaw = sql.raw('"tasks"."id"');
const taskAssignedToSqlRaw = sql.raw('"tasks"."assigned_to"');

/** Assignee display name as an orderable SQL expression (mirrors the select alias). */
export function buildTaskAssigneeNameSql(): SQL<string | null> {
  return sql<string | null>`(SELECT display_name FROM public.users WHERE id = ${taskAssignedToSqlRaw})`;
}

/** Priority urgency rank: urgent=0 (most urgent) … low=3, unknown last. */
function taskPriorityRankSql(): SQL<number> {
  return sql<number>`CASE ${tasks.priority}
    WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4
  END`;
}

/**
 * Server-side ORDER BY for a single task bucket. Returns SQL order expressions
 * (the chosen key + a stable `id` tiebreak) so the FULL bucket is ordered in the
 * database, not via an in-memory re-sort of one page. Every nullable key uses
 * NULLS LAST so undated / unassigned rows sink regardless of direction; the
 * priority rank and the `id` tiebreak are non-nullable so they need no NULLS LAST.
 *
 * Injection-safe by construction: `sortBy`/`sortDir` only select a fixed SQL
 * fragment through the switch — no caller string is ever interpolated into SQL.
 */
export function buildTaskSortOrder(sortBy: TaskSortBy, sortDir: TaskSortDir = "asc"): SQL[] {
  const tiebreak = sql`${taskIdSqlRaw} ASC`;
  switch (sortBy) {
    case "priority": {
      const rank = taskPriorityRankSql();
      // "desc" surfaces the most urgent first (rank ascending); "asc" the least urgent.
      return [sortDir === "desc" ? sql`${rank} ASC` : sql`${rank} DESC`, tiebreak];
    }
    case "assignee": {
      const name = buildTaskAssigneeNameSql();
      return [sortDir === "asc" ? sql`${name} ASC NULLS LAST` : sql`${name} DESC NULLS LAST`, tiebreak];
    }
    case "created_at":
      // created_at is NOT NULL, but keep NULLS LAST for uniformity/safety.
      return [sortDir === "asc" ? sql`${tasks.createdAt} ASC NULLS LAST` : sql`${tasks.createdAt} DESC NULLS LAST`, tiebreak];
    case "completed_at":
      return [sortDir === "asc" ? sql`${tasks.completedAt} ASC NULLS LAST` : sql`${tasks.completedAt} DESC NULLS LAST`, tiebreak];
    case "due_date":
    default: {
      // Order by a status-aware EFFECTIVE date: scheduled tasks by scheduled_for (their surfacing
      // time — even if the edit/PATCH flow has stamped a stray due_date on them), everything else by
      // due_date. This interleaves the Later bucket's scheduled follow-ups by their real date instead
      // of sinking them to NULLS LAST, so a row limit can't categorically truncate them below
      // far-future dated rows. Elsewhere (no scheduled rows, non-null due_date) it === due_date.
      const effectiveDate = sql`CASE
        WHEN ${tasks.status} = 'scheduled' THEN COALESCE(${tasks.scheduledFor}, ${tasks.dueDate})
        ELSE COALESCE(${tasks.dueDate}, ${tasks.scheduledFor})
      END`;
      return sortDir === "asc"
        ? [sql`${effectiveDate} ASC NULLS LAST`, tiebreak]
        : [sql`${effectiveDate} DESC NULLS LAST`, tiebreak];
    }
  }
}

/** Add `days` to a YYYY-MM-DD date string (date-only math; the result stays YYYY-MM-DD). */
function addDaysToIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map((part) => Number(part));
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Get tasks for a user, optionally filtered by section.
 * Sections map to the UI layout: Overdue, Today, This week, Later, Completed.
 */
export async function getTasks(
  tenantDb: TenantDb,
  filters: TaskFilters,
  userRole: string,
  userId: string
) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 100;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];

  // Reps see only their own tasks; directors/admins can filter by assignee
  if (userRole === "rep") {
    conditions.push(eq(tasks.assignedTo, userId));
  } else if (filters.assignedTo) {
    conditions.push(eq(tasks.assignedTo, filters.assignedTo));
  }

  // Filter by status
  if (filters.status) {
    conditions.push(eq(tasks.status, filters.status as any));
  }

  // Filter by type
  if (filters.type) {
    conditions.push(eq(tasks.type, filters.type as any));
  }

  // Filter by deal
  if (filters.dealId) {
    conditions.push(eq(tasks.dealId, filters.dealId));
  }

  // Filter by contact
  if (filters.contactId) {
    conditions.push(eq(tasks.contactId, filters.contactId));
  }

  // Automated vs manual. Omitted means BOTH, so every existing caller keeps its current result set —
  // the ask was the ability to filter, not a change to what people see by default.
  if (filters.source) {
    conditions.push(eq(tasks.source, filters.source));
  }

  // Seeded demo tasks never belong in a real person's list. Applied here, in getTaskById,
  // getProjectTasks and getTaskCounts together: a filter on the lists but not the counts would make
  // every tab label disagree with its own rows by however many demo rows the office has.
  conditions.push(excludeTestTasks());

  // Section-based filtering
  // Use office timezone (CT for T Rock) for date bucketing instead of UTC.
  // This ensures "today" matches the user's local date, not UTC midnight.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); // YYYY-MM-DD in CT
  const weekEnd = addDaysToIsoDate(today, 7); // inclusive upper bound for "this week" (CT)

  const openStatusCondition = buildOpenTaskStatusCondition(new Date());

  if (filters.section === "overdue") {
    conditions.push(openStatusCondition, sql`${tasks.dueDate} < ${today}`);
  } else if (filters.section === "today") {
    conditions.push(openStatusCondition, sql`${tasks.dueDate} = ${today}`);
  } else if (filters.section === "this_week") {
    // Open work due after today, within the next 7 days.
    conditions.push(openStatusCondition, sql`${tasks.dueDate} > ${today}`, sql`${tasks.dueDate} <= ${weekEnd}`);
  } else if (filters.section === "later") {
    // The "Later" bucket the page used to assemble client-side: far-future / undated open
    // work UNION everything explicitly scheduled. Membership-identical to (upcoming-tail +
    // the separate scheduled fetch); only the ordering is now server-controlled.
    conditions.push(
      or(
        and(openStatusCondition, or(sql`${tasks.dueDate} > ${weekEnd}`, isNull(tasks.dueDate))),
        eq(tasks.status, "scheduled" as any)
      )
    );
  } else if (filters.section === "upcoming") {
    conditions.push(
      openStatusCondition,
      or(sql`${tasks.dueDate} > ${today}`, isNull(tasks.dueDate))
    );
  } else if (filters.section === "completed") {
    conditions.push(inArray(tasks.status as any, COMPLETED_BUCKET_STATUSES as any));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Priority rank: urgent=0, high=1, normal=2, low=3
  const priorityRank = sql<number>`CASE ${tasks.priority}
    WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4
  END`;
  const taskColumns = tasks as typeof tasks & {
    scheduledFor: typeof tasks.dueDate;
    waitingOn: typeof tasks.dueDate;
    blockedBy: typeof tasks.dueDate;
    startedAt: typeof tasks.createdAt;
  };

  // Subquery to resolve assignee display name from public.users
  const assignedToName = sql<string | null>`(SELECT display_name FROM public.users WHERE id = ${tasks.assignedTo})`.as("assignedToName");

  // Per-bucket sort: when the caller picks a sort, order the FULL filtered set in the DB.
  // Otherwise keep the legacy section-aware default ordering (back-compat for other callers).
  const orderBy = filters.sortBy
    ? buildTaskSortOrder(filters.sortBy, filters.sortDir)
    : filters.section === "completed"
      ? [desc(tasks.completedAt)]
      : filters.status === "scheduled"
        ? [asc(taskColumns.scheduledFor), asc(priorityRank), asc(tasks.title)]
        : [desc(tasks.isOverdue), asc(priorityRank), asc(tasks.dueDate)];

  const countResult = await tenantDb.select({ count: sql<number>`count(*)` }).from(tasks).where(where);
  const taskRows = await tenantDb
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      type: tasks.type,
      priority: tasks.priority,
      status: tasks.status,
      source: tasks.source,
      assignedTo: tasks.assignedTo,
      assignedToName,
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
    })
    .from(tasks)
    .leftJoin(deals, eq(tasks.dealId, deals.id))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    // The server's own verdict on each row, so the list's completion checkbox and the edit dialog's
    // Dismiss can be gated rather than offered-then-refused.
    tasks: taskRows.map((row) => ({ ...row, canClose: canUserCloseTask(row, userRole, userId) })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getProjectTaskScope(
  tenantDb: TenantDb,
  dealId: string,
  userRole: string,
  userId: string
) {
  const conditions = [
    eq(deals.id, dealId),
    eq(deals.isActive, true),
    isNotNull(deals.procoreProjectId),
  ];

  if (userRole === "rep") {
    conditions.push(eq(deals.assignedRepId, userId));
  }

  const [project] = await tenantDb
    .select({
      id: deals.id,
      dealNumber: deals.dealNumber,
      projectNumber: deals.projectNumber,
      name: deals.name,
      procoreProjectId: deals.procoreProjectId,
    })
    .from(deals)
    .where(and(...conditions))
    .limit(1);

  return project ?? null;
}

export async function getProjectTasks(
  tenantDb: TenantDb,
  dealId: string,
  userRole: string,
  userId: string
) {
  const project = await getProjectTaskScope(tenantDb, dealId, userRole, userId);
  if (!project) {
    throw new AppError(404, "Project not found");
  }

  const priorityRank = sql<number>`CASE ${tasks.priority}
    WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4
  END`;
  const taskColumns = tasks as typeof tasks & {
    scheduledFor: typeof tasks.dueDate;
    waitingOn: typeof tasks.dueDate;
    blockedBy: typeof tasks.dueDate;
    startedAt: typeof tasks.createdAt;
  };
  const assignedToName = sql<string | null>`(SELECT display_name FROM public.users WHERE id = ${tasks.assignedTo})`.as("assignedToName");

  const projectRows = await tenantDb
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      type: tasks.type,
      priority: tasks.priority,
      status: tasks.status,
      source: tasks.source,
      assignedTo: tasks.assignedTo,
      assignedToName,
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
    })
    .from(tasks)
    .leftJoin(deals, eq(tasks.dealId, deals.id))
    .where(and(eq(tasks.dealId, dealId), excludeTestTasks()))
    .orderBy(desc(tasks.isOverdue), asc(priorityRank), asc(tasks.dueDate), asc(tasks.title));

  // The Procore project surface renders the same completion controls as the tasks list, so it needs
  // the same verdict.
  return projectRows.map((row) => ({ ...row, canClose: canUserCloseTask(row, userRole, userId) }));
}

/**
 * Get task counts per section for the current user.
 * Used by the task list page header and sidebar badge.
 */
export async function getTaskCounts(
  tenantDb: TenantDb,
  userRole: string,
  currentUserId: string,
  targetUserId?: string | null,
  source?: TaskSource
) {
  // Use office timezone (CT for T Rock) for date bucketing
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); // YYYY-MM-DD in CT
  const effectiveUserId = userRole === "rep" ? currentUserId : (targetUserId ?? null);
  const assigneeClause = effectiveUserId ? sql` AND assigned_to = ${effectiveUserId}` : sql``;
  const sourceClause = source ? sql` AND source = ${source}` : sql``;

  // Demo rows are excluded here exactly as they are in the three read projections. If the counts kept
  // them and the lists dropped them, every tab label would be over by the office's demo-row count and
  // the two would never reconcile.
  const scopeClause = sql`WHERE COALESCE(is_test_data, false) = false${assigneeClause}`;

  // The DATE buckets carry the tab selection, because they feed the summary cards that sit directly
  // above the buckets. The per-source totals deliberately use scopeClause WITHOUT the source: those
  // are the tab LABELS, and each needs its own number no matter which tab is active — scoping them
  // would zero the Automated label the moment somebody selected Manual.
  const bucketScopeClause = sql`${scopeClause}${sourceClause}`;

  // The open-work denominator, shared with the list rather than restated: the four open buckets
  // between them return exactly the rows with one of these statuses, so a per-source total built from
  // it reconciles with the rows under each tab. Built from the constant so the two cannot drift.
  const openWorkList = sql.join(
    OPEN_WORK_STATUSES.map((status) => sql`${status}`),
    sql`, `
  );

  // Two queries, because the two halves answer different questions over different row sets: the tab
  // labels are unscoped by source, the cards are scoped to the selected tab.
  const sourceResult = await tenantDb.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status IN (${openWorkList}) AND source = 'manual')::int AS source_manual,
      COUNT(*) FILTER (WHERE status IN (${openWorkList}) AND source = 'automated')::int AS source_automated
    FROM tasks
    ${scopeClause}
  `);

  const result = await tenantDb.execute(sql`
    SELECT
      COUNT(*) FILTER (
        WHERE status IN ('pending', 'in_progress', 'waiting_on', 'blocked')
        AND due_date < ${today}
      )::int AS overdue,
      COUNT(*) FILTER (
        WHERE status IN ('pending', 'in_progress', 'waiting_on', 'blocked')
        AND due_date = ${today}
      )::int AS today,
      COUNT(*) FILTER (
        WHERE status IN ('pending', 'in_progress', 'waiting_on', 'blocked')
        AND (due_date > ${today} OR due_date IS NULL)
      )::int AS upcoming,
      COUNT(*) FILTER (
        WHERE status = 'completed'
      )::int AS completed,
      COUNT(*) FILTER (
        WHERE status IN ('completed', 'dismissed')
        AND completed_at >= NOW() - INTERVAL '7 days'
      )::int AS completed_this_week
    FROM tasks
    ${bucketScopeClause}
  `);

  const rows = (result as any).rows ?? result;
  const row = rows[0] ?? {};
  const sourceRows = (sourceResult as any).rows ?? sourceResult;
  const sourceRow = sourceRows[0] ?? {};
  const sourceManual = Number(sourceRow.source_manual ?? 0);
  const sourceAutomated = Number(sourceRow.source_automated ?? 0);
  return {
    overdue: Number(row.overdue ?? 0),
    today: Number(row.today ?? 0),
    upcoming: Number(row.upcoming ?? 0),
    completed: Number(row.completed ?? 0),
    // Resolved-in-the-last-7-days (completed or dismissed). Authoritative source for the
    // "Completed this week" summary card so it stays correct regardless of the Completed
    // bucket's sort/limit (the old client calc was capped at the 20 fetched rows).
    completedThisWeek: Number(row.completed_this_week ?? 0),
    // Tab labels. `all` is the sum of the two rather than its own COUNT so the three numbers cannot
    // contradict each other — a separate aggregate could disagree with its own parts if the CHECK
    // constraint ever admitted a third value.
    bySource: {
      manual: sourceManual,
      automated: sourceAutomated,
      all: sourceManual + sourceAutomated,
    },
  };
}

/**
 * Reps may only ever see their own tasks — shared by both read paths so the rule can't drift.
 *
 * "Their own" now means ASSIGNED TO THEM **or** ASSIGNED BY THEM. The second half is new, and without
 * it the closed loop simply does not exist for a rep: the ask is "Adam assigns a task and then forgets
 * what he assigned", and until now a rep who assigned a task to somebody else got a 403 from
 * `getTaskById` on the task they had themselves created — so they could not open it, could not read
 * the reply, could not acknowledge it and could not close it. Every closed-loop endpoint funnels
 * through here, so widening it here is what makes /:id/comments, /:id/timeline, /:id/ack and the
 * assigner-only close rule reachable by the person the feature is FOR.
 *
 * The list is deliberately NOT widened with it: `getTasks` keeps its own `assigned_to = me` clause for
 * reps, so a rep's task list still shows only their own work. Tasks they assigned surface in the
 * separate "Needs your attention" bucket (/tasks/awaiting-me), which is scoped to `created_by = me`.
 */
export function assertTaskVisible(
  task: { assignedTo: string; createdBy?: string | null; lastAssignedBy?: string | null } | null,
  userRole: string,
  userId: string
) {
  if (!task || userRole !== "rep") return;
  if (task.assignedTo === userId) return;
  // Both identities, because they diverge the moment a task changes hands: `createdBy` is who typed
  // it into existence and `assignedBy` is who currently has somebody working on it. A rep who was
  // handed a task to distribute must be able to reach it even though they did not create it, and the
  // original creator does not lose sight of their own task when it is passed on.
  //
  // Both are NULL on machine-generated work, so the truthiness tests matter: a NULL must never match
  // a caller, whatever their id is.
  if (task.createdBy && task.createdBy === userId) return;
  if (task.lastAssignedBy && task.lastAssignedBy === userId) return;
  throw new AppError(403, "You can only view tasks assigned to you or by you");
}

/**
 * Roles that may close ANY task they can see.
 *
 * An ALLOWLIST, not "everything except rep" — and that distinction is the bug it fixes. The old rule
 * was `assertTaskVisible` alone, which narrows `rep` and nothing else, so `construction` and
 * `field_contractor` users could complete or dismiss any task in the office. Both are enumerated as
 * excluded by their ABSENCE here rather than by a negative test, so adding a new role defaults it to
 * "no close authority" instead of silently granting it.
 */
export const TASK_CLOSE_ELEVATED_ROLES = ["admin", "director"] as const;

/**
 * The two INTERNAL callers that close tasks as neither assignee nor assigner.
 *
 * Enumerated rather than accepting a free-form string so the bypass cannot be widened by accident, and
 * a route cannot construct one: both values name a specific server-side code path.
 *   email_association        email/service.ts completeInboundEmailTasks — auto-completes the open
 *                            inbound_email tasks for a message when ANY user associates it to a deal.
 *                            Those tasks are assigned to the MAILBOX OWNER, who is usually not the
 *                            person doing the associating.
 *   ai_disconnect_resolution ai-copilot/intervention-service.ts syncGeneratedTaskResolution — the
 *                            AI-disconnect task carries created_by = NULL, so there is no assigner to
 *                            fall back on at all.
 */
export const TASK_CLOSE_SYSTEM_ACTORS = ["email_association", "ai_disconnect_resolution"] as const;
export type TaskCloseSystemActor = (typeof TASK_CLOSE_SYSTEM_ACTORS)[number];

export interface TaskCloseOptions {
  /** Set ONLY by an internal caller. No HTTP handler constructs one. */
  systemActor?: TaskCloseSystemActor;
}

/** Shared predicate behind both "may close" and "may comment" — one definition, two error messages. */
function isTaskParticipant(
  task: { assignedTo: string; createdBy?: string | null; lastAssignedBy?: string | null },
  userRole: string,
  userId: string
) {
  if ((TASK_CLOSE_ELEVATED_ROLES as readonly string[]).includes(userRole)) return true;
  if (task.assignedTo === userId) return true;
  // BOTH the creator and the current assigner are stakeholders in closing a task, and after a
  // reassignment they are different people. Deliberately wider than reply DELIVERY, which must pick
  // exactly ONE recipient and therefore uses the RESOLVED assigner alone: accepting the work is
  // something either party can legitimately do, whereas mailing the reply to both would be noise and
  // mailing it to the wrong one is the defect this whole column exists to fix.
  //
  // `x === null` is false for every real user id, but spelling the null checks out keeps a future
  // `userId` of undefined/null from ever matching a NULL.
  if (Boolean(task.createdBy) && task.createdBy === userId) return true;
  return Boolean(task.lastAssignedBy) && task.lastAssignedBy === userId;
}

/**
 * WHO MAY MOVE A TASK TO A TERMINAL STATUS. Called from completeTask, dismissTask AND
 * transitionTaskStatus, because all three reach `completed`/`dismissed` and a guard on one of them is
 * one HTTP call from being bypassed (`pending -> completed` is an allowed transition, so /transition
 * never enters completeTask; /dismiss had no check at all while `dismissed` is just as terminal, and
 * additionally writes a suppression window that stops the rules engine ever raising the task again).
 */
export function assertTaskCloseAuthority(
  task: { assignedTo: string; createdBy?: string | null; lastAssignedBy?: string | null },
  userRole: string,
  userId: string,
  options: TaskCloseOptions = {}
) {
  if (options.systemActor !== undefined) {
    if (!(TASK_CLOSE_SYSTEM_ACTORS as readonly string[]).includes(options.systemActor)) {
      throw new AppError(500, `Unknown task close system actor: ${String(options.systemActor)}`);
    }
    return;
  }

  if (isTaskParticipant(task, userRole, userId)) return;
  throw new AppError(
    403,
    "Only the assignee, the person who assigned this task, or an admin can close it"
  );
}

/**
 * The same authority rule, expressed against the row the terminal UPDATE actually changes.
 *
 * The initial read above is still needed for visibility and useful errors, but it is only a snapshot:
 * a reassignment can commit after that read and before the write. System actors and elevated roles
 * have explicit global authority; ordinary callers must still be a participant at write time.
 */
function terminalTaskCloseAuthorityCondition(
  userRole: string,
  userId: string,
  options: TaskCloseOptions = {}
): SQL | undefined {
  if (options.systemActor !== undefined) return undefined;
  if ((TASK_CLOSE_ELEVATED_ROLES as readonly string[]).includes(userRole)) return undefined;

  return or(
    eq(tasks.assignedTo, userId),
    eq(tasks.createdBy, userId),
    eq(tasks.lastAssignedBy, userId)
  );
}

/**
 * The close-authority rule as a BOOLEAN, for the read path.
 *
 * Every task projection carries it so the client can gate its close controls on the server's own
 * verdict instead of re-deriving the rule. That matters because visibility and close authority are
 * different rules -- `getTasks` only scopes REPS, so a construction user is handed every task in the
 * office -- and a second copy of the authority rule in the browser is how the two drift. Derived from
 * the SAME predicate the write path asserts on, so the answer cannot disagree with what happens on
 * submit.
 */
export function canUserCloseTask(
  task: { assignedTo: string; createdBy?: string | null; lastAssignedBy?: string | null },
  userRole: string,
  userId: string
) {
  return isTaskParticipant(task, userRole, userId);
}

/** WHO MAY SPEAK ON A TASK. Same participant set as closing it, deliberately a separate assertion so
 *  the two rules can diverge later without one silently carrying the other. */
export function assertTaskCommentAuthority(
  task: { assignedTo: string; createdBy?: string | null },
  userRole: string,
  userId: string
) {
  if (isTaskParticipant(task, userRole, userId)) return;
  throw new AppError(
    403,
    "Only the assignee, the person who assigned this task, or an admin can comment on it"
  );
}

/**
 * Raw task row by ID — no deal/assignee enrichment.
 *
 * The mutation guards (transition/update/complete/dismiss/snooze) only read `status`, `startedAt`
 * and `assignedTo`, and their handlers return the raw `.returning()` row. Keeping this lean means
 * those paths neither pay for the join nor return a shape that differs from the row they write.
 */
export async function getTaskRowById(
  tenantDb: TenantDb,
  taskId: string,
  userRole: string,
  userId: string,
  options: TaskCloseOptions = {}
) {
  const result = await tenantDb.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);

  const task = (result[0] ?? null) as any;
  if (!task) return null;
  // A system actor is not a person and has no "own tasks": completeInboundEmailTasks closes a task
  // assigned to the MAILBOX OWNER on behalf of whoever associated the email, so the visibility rule
  // would 403 the machine path before assertTaskCloseAuthority ever got to allow it. Only the two
  // enumerated internal callers can reach this — no route constructs a systemActor.
  if (options.systemActor === undefined) {
    assertTaskVisible(task, userRole, userId);
  }
  return task;
}

/**
 * Get a single task by ID, enriched for display.
 */
export async function getTaskById(
  tenantDb: TenantDb,
  taskId: string,
  userRole: string,
  userId: string
) {
  // Mirrors the list projection in getTasks — a bare `select()` here returned the raw `tasks`
  // columns only, so a task opened by id (e.g. from the assignment email's deep link) arrived
  // with `dealId` but no deal name/number and no assignee name. The UI then rendered the
  // "Project linked" / "Unassigned" fallbacks even for a correctly linked task.
  const taskColumns = tasks as typeof tasks & {
    scheduledFor: typeof tasks.dueDate;
    waitingOn: typeof tasks.dueDate;
    blockedBy: typeof tasks.dueDate;
    startedAt: typeof tasks.createdAt;
  };
  const assignedToName = sql<string | null>`(SELECT display_name FROM public.users WHERE id = ${tasks.assignedTo})`.as("assignedToName");

  const result = await tenantDb
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      type: tasks.type,
      priority: tasks.priority,
      status: tasks.status,
      source: tasks.source,
      assignedTo: tasks.assignedTo,
      assignedToName,
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
    })
    .from(tasks)
    .leftJoin(deals, eq(tasks.dealId, deals.id))
    .where(and(eq(tasks.id, taskId), excludeTestTasks()))
    .limit(1);

  const task = (result[0] ?? null) as any;
  if (!task) return null;
  assertTaskVisible(task, userRole, userId);
  return { ...task, canClose: canUserCloseTask(task, userRole, userId) };
}

/**
 * Create a new task.
 *
 * This is the HUMAN task constructor, and `source: 'manual'` is set here rather than by the callers on
 * purpose. All three of them are a person filling in a form — the New Task dialog (tasks/routes.ts),
 * the Procore project task form (procore/routes.ts), and accepting an AI suggestion
 * (ai-copilot/task-suggestion-service.ts, where a person chose to accept it, which is what makes it
 * theirs). Deciding this at one route would leave the other two on the column DEFAULT of 'automated'
 * and file a task somebody typed into the automated tab. A machine path must not call this function;
 * the rules engine, the crons and the reassignment writer all insert directly and set 'automated'.
 */
export async function createTask(tenantDb: TenantDb, input: CreateTaskInput) {
  const result = await tenantDb
    .insert(tasks)
    .values({
      source: "manual",
      title: input.title,
      description: input.description ?? null,
      type: input.type as any,
      priority: (input.priority as any) ?? "normal",
      status: "pending",
      assignedTo: input.assignedTo,
      createdBy: input.createdBy ?? null,
      // NO lastAssignedBy here, deliberately: until a task changes hands the creator IS the assigner,
      // and readers resolve COALESCE(lastAssignedBy, createdBy). Writing createdBy into a second
      // column at creation would make "never reassigned" indistinguishable from "reassigned back to
      // the creator", and it is the state this column exists to tell apart.
      dealId: input.dealId ?? null,
      contactId: input.contactId ?? null,
      emailId: input.emailId ?? null,
      dueDate: input.dueDate ?? null,
      dueTime: input.dueTime ?? null,
      remindAt: input.remindAt ? new Date(input.remindAt) : null,
    })
    .returning();

  return result[0];
}

export async function queueTaskCreateSideEffects(
  tenantDb: TenantDb,
  task: {
    id: string;
    title: string;
    assignedTo: string;
    dealId: string | null;
  },
  input: CreatedTaskSideEffectsInput
) {
  if (task.assignedTo !== input.actorUserId) {
    await tenantDb.insert(jobQueue).values({
      jobType: "domain_event",
      payload: {
        eventName: "task.assigned",
        taskId: task.id,
        assignedTo: task.assignedTo,
        title: task.title,
      },
      officeId: input.officeId,
      status: "pending",
      runAfter: new Date(),
    });
  }

  if (task.dealId) {
    await tenantDb.insert(jobQueue).values({
      jobType: "ai_refresh_copilot",
      payload: {
        dealId: task.dealId,
        reason: "task_created",
        taskId: task.id,
        requestedBy: input.actorUserId,
      },
      officeId: input.officeId,
      status: "pending",
      runAfter: new Date(),
    });
  }

  return {
    shouldEmitAssignmentEvent: task.assignedTo !== input.actorUserId,
  };
}

/**
 * Update a task (field edits).
 */
export async function updateTask(
  tenantDb: TenantDb,
  taskId: string,
  input: UpdateTaskInput,
  userRole: string,
  userId: string
) {
  const existing = await getTaskRowById(tenantDb, taskId, userRole, userId);
  if (!existing) throw new AppError(404, "Task not found");

  if (existing.status === "completed" || existing.status === "dismissed") {
    throw new AppError(400, `Cannot edit a ${existing.status} task`);
  }

  const updates: Record<string, any> = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.description !== undefined) updates.description = input.description;
  if (input.priority !== undefined) updates.priority = input.priority;
  if (input.dueDate !== undefined) updates.dueDate = input.dueDate;
  if (input.dueTime !== undefined) updates.dueTime = input.dueTime;
  if (input.remindAt !== undefined) updates.remindAt = input.remindAt ? new Date(input.remindAt) : null;
  if (input.assignedTo !== undefined) {
    updates.assignedTo = input.assignedTo;
    // A CHANGE OF HANDS IS AN EVENT, and this is the only place it is recorded. The comparisons have
    // to happen INSIDE this UPDATE rather than against `existing`: another PATCH can move the task
    // between that permission/status read and this write. In that race, a stale comparison can either
    // invent a new assignment (invalidating a valid acknowledgement), miss a real hand-back, or transfer
    // the reply loop's assigner to somebody who only touched an already-current assignment. The database
    // sees the row this statement actually writes, so both fields move only when that assignee moves.
    updates.lastAssignedBy = sql`CASE
      WHEN ${tasks.assignedTo} IS DISTINCT FROM ${input.assignedTo} THEN ${userId}
      ELSE ${tasks.lastAssignedBy}
    END`;
    // `NOW()` is the TRANSACTION-start timestamp in PostgreSQL: a request that sat open while another
    // assignment was acknowledged could stamp this new handoff before that acknowledgement and silently
    // make it look seen. clock_timestamp() is volatile and evaluates at the actual row change instead.
    // A title edit still omits assignedAt entirely — re-stamping on every PATCH would make the login
    // modal repeat forever. Migration 0239 explains why an acknowledgement must answer this specific
    // assignment, rather than an earlier time the task belonged to the same person.
    updates.assignedAt = sql`CASE
      WHEN ${tasks.assignedTo} IS DISTINCT FROM ${input.assignedTo} THEN clock_timestamp()
      ELSE ${tasks.assignedAt}
    END`;
  }

  if (Object.keys(updates).length === 0) return existing;

  const result = await tenantDb
    .update(tasks)
    .set(updates)
    .where(eq(tasks.id, taskId))
    .returning();

  return result[0];
}

/**
 * Complete a task. Sets status to 'completed' and records completedAt.
 * Uses a conditional update to prevent race conditions — only succeeds
 * if the task is in a completable state (pending or in_progress).
 */
export async function completeTask(
  tenantDb: TenantDb,
  taskId: string,
  userRole: string,
  userId: string,
  options: TaskCloseOptions = {}
) {
  // RBAC check: getTaskRowById enforces rep-only-own-tasks
  const existing = await getTaskRowById(tenantDb, taskId, userRole, userId, options);
  if (!existing) throw new AppError(404, "Task not found");

  assertTaskCloseAuthority(existing, userRole, userId, options);

  // Conditional update: only complete if task is in a completable state
  const result = await tenantDb
    .update(tasks)
    .set({
      status: "completed",
      completedAt: new Date(),
      isOverdue: false,
      waitingOn: null,
      blockedBy: null,
    } as any)
    .where(
      and(
        eq(tasks.id, taskId),
        inArray(tasks.status as any, ["pending", "in_progress", "waiting_on", "blocked"] as any),
        terminalTaskCloseAuthorityCondition(userRole, userId, options)
      )
    )
    .returning();

  if (result.length === 0) {
    throw new AppError(400, "Task already completed or dismissed");
  }

  return result[0];
}

/**
 * Dismiss a task. Sets status to 'dismissed'.
 */
export async function dismissTask(
  tenantDb: TenantDb,
  taskId: string,
  userRole: string,
  userId: string,
  options: TaskCloseOptions = {}
) {
  const existing = await getTaskRowById(tenantDb, taskId, userRole, userId, options);
  if (!existing) throw new AppError(404, "Task not found");

  // `dismissed` is terminal AND writes a suppression window that stops the rules engine ever raising
  // the task again, so it needs the same authority as completing — it had none at all before.
  assertTaskCloseAuthority(existing, userRole, userId, options);

  if (existing.status === "completed" || existing.status === "dismissed") {
    throw new AppError(400, `Task is already ${existing.status}`);
  }

  const resolvedAt = new Date();

  const result = await tenantDb
    .update(tasks)
    .set({
      status: "dismissed",
      completedAt: resolvedAt,
      isOverdue: false,
      waitingOn: null,
      blockedBy: null,
    } as any)
    .where(and(eq(tasks.id, taskId), terminalTaskCloseAuthorityCondition(userRole, userId, options)))
    .returning();

  if (result.length === 0) {
    throw new AppError(409, "Task changed before it could be dismissed");
  }

  await writeDismissalResolutionState(tenantDb, result[0], resolvedAt);

  return result[0];
}

/**
 * Snooze a task by moving its due date forward.
 */
export async function snoozeTask(
  tenantDb: TenantDb,
  taskId: string,
  newDueDate: string,
  userRole: string,
  userId: string
) {
  const existing = await getTaskRowById(tenantDb, taskId, userRole, userId);
  if (!existing) throw new AppError(404, "Task not found");

  if (existing.status === "completed" || existing.status === "dismissed") {
    throw new AppError(400, `Cannot snooze a ${existing.status} task`);
  }

  const result = await tenantDb
    .update(tasks)
    .set({ dueDate: newDueDate, isOverdue: false })
    .where(eq(tasks.id, taskId))
    .returning();

  return result[0];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// F6 — new-assignment login modal
//
// Reads and writes the per-office `task_assignment_acknowledgements` table (migration 0235). The
// SELECT half decides what interrupts somebody at login; the INSERT half records that it did.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How many assignments the modal shows at once.
 *
 * Five, with an "and N more" line, because a modal listing forty tasks is a wall and a wall is what
 * gets reflex-dismissed. The number is exported so the test that proves urgent work survives the cap
 * cannot drift away from the cap it is proving.
 */
export const PENDING_ASSIGNMENT_MODAL_LIMIT = 5;

export type PendingAssignmentTask = {
  id: string;
  /**
   * Opaque, lossless rendering of assigned_at for the assignment this modal displayed.
   *
   * JavaScript Dates lose Postgres microseconds, so returning assignedAt as a Date and posting it back
   * would make an equality check fail for perfectly current assignments. This UTC text form retains all
   * six fractional digits and is accepted only as an optimistic-concurrency version by /acknowledge.
   */
  assignmentVersion: string;
  /**
   * Server-signed receipt for this exact card on the capped modal page.
   *
   * A user can read assignedAt from ordinary task APIs, so a bare id/version pair is not evidence that
   * this assignment was actually put in front of them. The acknowledgement endpoint requires this
   * receipt in addition to re-checking owner/version under a row lock.
   */
  acknowledgementToken: string;
  title: string;
  priority: string;
  dueDate: string | null;
  /**
   * Display name of the person who last handed this task to the recipient.
   *
   * `lastAssignedBy` records every reassignment; before the first one, the creator is necessarily
   * the assigner. Resolving `COALESCE(lastAssignedBy, createdBy)` therefore preserves the creator
   * fallback without misattributing a later handoff to the original author.
   */
  assignedByName: string | null;
  /**
   * TRUE when this person has never been shown this task; FALSE when it is a repeat of something they
   * have already acknowledged. Drives both the ordering below and the modal's copy — without it the
   * modal calls a months-old urgent task a new assignment.
   */
  isNew: boolean;
};

/**
 * The assignments to put in front of `userId` at login, most urgent first, capped at five.
 *
 * ⚠️ TWO ORDERING RULES, AND THEY HAVE TO BE IN THIS ORDER.
 *
 * UNSEEN FIRST. `LIMIT 5` and the urgent/high/overdue repeat rule are each reasonable and together
 * they invert the feature: repeats stay eligible on every login, so once somebody holds five of them
 * those five fill every slot forever and a genuinely new assignment is never shown at all. The modal
 * becomes a permanent display of things the user has already seen while the one thing they have not
 * stays invisible. The invariant that fixes it is that a never-acknowledged assignment is never
 * displaced by an already-seen one — repeats get only the slots unseen work does not need.
 *
 * THEN PRIORITY, WITHIN each group. `priority` is a Postgres ENUM declared
 * ('urgent','high','normal','low') and enum comparison follows DECLARATION order, so the obvious
 * `ORDER BY priority DESC` sorts low → normal → high → urgent and, at LIMIT 5, drops urgent and high
 * off the end entirely. `taskPriorityRankSql()` (rank 0 = urgent) ordered ASC is the fix, reused rather
 * than re-derived because the CASE already exists twice in this file. Keeping it SECOND is what stops
 * the correct urgent-first ordering from becoming the mechanism that buries new work.
 *
 * `total` counts everything matching, not the page — it feeds the "and N more" line, and counting the
 * returned array would just report the limit. `newTotal` counts the unseen ones, so the modal can say
 * how many are actually new instead of calling a months-old repeat a new assignment.
 */
export async function getPendingAssignmentTasks(
  tenantDb: TenantDb,
  userId: string,
  officeId?: string
): Promise<{ tasks: PendingAssignmentTask[]; total: number; newTotal: number }> {
  const todayCt = pendingAssignmentTodayCt();
  const predicate = buildPendingAssignmentPredicate({ userId, todayCt });
  const unseen = buildUnseenAssignmentSql({ userId });
  const acknowledgementOfficeId = acknowledgementOfficeScope(officeId);

  const result = await tenantDb.execute(sql`
    SELECT
      ${tasks.id}                AS id,
      to_char(${tasks.assignedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS assignment_version,
      ${tasks.title}             AS title,
      ${tasks.priority}::text    AS priority,
      ${tasks.dueDate}::text     AS due_date,
      (SELECT display_name
         FROM public.users
        WHERE id = COALESCE(${tasks.lastAssignedBy}, ${tasks.createdBy})) AS assigned_by_name,
      ${unseen}                  AS is_new,
      -- Computed over the full matching set BEFORE the LIMIT applies, so one round trip answers all of
      -- "what do we show", "how many more are there" and "how many of those are actually new".
      COUNT(*) OVER ()::int      AS total,
      COUNT(*) FILTER (WHERE ${unseen}) OVER ()::int AS new_total
    FROM tasks
    WHERE ${predicate}
    ORDER BY is_new DESC, ${taskPriorityRankSql()} ASC, ${tasks.dueDate} ASC NULLS LAST, ${taskIdSqlRaw} ASC
    LIMIT ${PENDING_ASSIGNMENT_MODAL_LIMIT}
  `);

  const rows = ((result as any).rows ?? result) as Array<Record<string, unknown>>;

  return {
    tasks: rows.map((row) => {
      const id = String(row.id);
      const assignmentVersion = String(row.assignment_version);
      return {
        id,
        assignmentVersion,
        acknowledgementToken: createAcknowledgementToken({
          userId,
          officeId: acknowledgementOfficeId,
          taskId: id,
          assignmentVersion,
        }),
        title: String(row.title),
        priority: String(row.priority),
        dueDate: (row.due_date as string | null) ?? null,
        assignedByName: (row.assigned_by_name as string | null) ?? null,
        isNew: row.is_new === true,
      };
    }),
    total: Number(rows[0]?.total ?? 0),
    newTotal: Number(rows[0]?.new_total ?? 0),
  };
}

/** A task id we are willing to hand to Postgres. Anything else is dropped before it can raise 22P02. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The only lossless timestamp representation this endpoint issues and accepts as an assignment version. */
const ASSIGNMENT_VERSION_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

type AssignmentAcknowledgementCandidate = {
  taskId: string;
  assignmentVersion: string;
};

/** Keep the exact server-issued assigned_at version in SQL rather than round-tripping through JS Date. */
const assignmentVersionSql = sql<string>`to_char(${tasks.assignedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const TASK_ASSIGNMENT_ACKNOWLEDGEMENT_TOKEN_VERSION = "v1";
const TASK_ASSIGNMENT_ACKNOWLEDGEMENT_TEST_OFFICE = "test-office";
const TASK_ASSIGNMENT_ACKNOWLEDGEMENT_TOKEN_PREFIX =
  `${TASK_ASSIGNMENT_ACKNOWLEDGEMENT_TOKEN_VERSION}.`;
// SHA-256 is 32 bytes, whose unpadded base64url encoding is always 43 ASCII characters.
const TASK_ASSIGNMENT_ACKNOWLEDGEMENT_SIGNATURE_LENGTH = 43;
const TASK_ASSIGNMENT_ACKNOWLEDGEMENT_SIGNATURE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function acknowledgementTokenSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
    throw new Error("JWT_SECRET must be set before issuing task-assignment acknowledgement receipts");
  }
  return "dev-secret-change-in-production";
}

function acknowledgementOfficeScope(officeId: string | undefined): string {
  // Direct service tests have no authenticated request/office context. Production routes always pass the
  // active office id, which binds a receipt to the tenant it was rendered from.
  return officeId ?? TASK_ASSIGNMENT_ACKNOWLEDGEMENT_TEST_OFFICE;
}

function acknowledgementTokenPayload({
  userId,
  officeId,
  taskId,
  assignmentVersion,
}: {
  userId: string;
  officeId: string;
  taskId: string;
  assignmentVersion: string;
}): string {
  return [
    "trockcrm:task-assignment-acknowledgement",
    TASK_ASSIGNMENT_ACKNOWLEDGEMENT_TOKEN_VERSION,
    userId,
    officeId,
    taskId,
    assignmentVersion,
  ].join("\u0000");
}

function signAcknowledgementToken(input: Parameters<typeof acknowledgementTokenPayload>[0]): string {
  return crypto
    .createHmac("sha256", acknowledgementTokenSecret())
    .update(acknowledgementTokenPayload(input), "utf8")
    .digest("base64url");
}

function createAcknowledgementToken(input: Parameters<typeof acknowledgementTokenPayload>[0]): string {
  return `${TASK_ASSIGNMENT_ACKNOWLEDGEMENT_TOKEN_VERSION}.${signAcknowledgementToken(input)}`;
}

function hasValidAcknowledgementToken(
  token: string,
  input: Parameters<typeof acknowledgementTokenPayload>[0]
): boolean {
  // Do the fixed-size, canonical wire-shape check BEFORE signing or allocating a Buffer. Node's
  // base64url decoder intentionally ignores non-alphabet characters, so decoding first would accept a
  // valid signature padded with arbitrary junk and make a malformed 10 MB request allocate needlessly.
  if (
    token.length !==
      TASK_ASSIGNMENT_ACKNOWLEDGEMENT_TOKEN_PREFIX.length +
        TASK_ASSIGNMENT_ACKNOWLEDGEMENT_SIGNATURE_LENGTH ||
    !token.startsWith(TASK_ASSIGNMENT_ACKNOWLEDGEMENT_TOKEN_PREFIX)
  ) {
    return false;
  }
  const signature = token.slice(TASK_ASSIGNMENT_ACKNOWLEDGEMENT_TOKEN_PREFIX.length);
  if (!TASK_ASSIGNMENT_ACKNOWLEDGEMENT_SIGNATURE_SHAPE.test(signature)) return false;

  // This receipt stays valid for the exact assignment it names. Expiry would create a lost-ack window
  // after a person has actually seen a card but before they close the modal; its user/office/task/version
  // binding and the locked version re-check make a stale receipt harmless once the assignment changes.
  const expected = signAcknowledgementToken(input);
  return crypto.timingSafeEqual(Buffer.from(signature, "ascii"), Buffer.from(expected, "ascii"));
}

/**
 * Record that `userId` has been shown these assignments. Returns how many displayed assignments were
 * still theirs at the exact assignment version the modal rendered.
 *
 * A SERVER-SIGNED RECEIPT must bind the caller, active office, task and displayed version before a row
 * is eligible at all. `assigned_at` is readable through ordinary task APIs, so ownership + version alone
 * would let a caller silently pre-acknowledge a normal task the capped modal never put in front of them.
 * The receipt is issued only by the capped GET page and remains valid for that exact assignment: expiry
 * would lose a legitimate acknowledgement when somebody leaves the modal open, while a reassignment
 * invalidates it through the locked version re-check. OWNERSHIP AND THE DISPLAYED VERSION are then
 * re-derived under a row lock: a task can leave Alice and come back before she closes an old modal, and
 * checking only id/current owner would acknowledge the NEW handoff with the OLD modal. Stale or malformed
 * receipts are dropped SILENTLY rather than 403'd, so the modal can close and reappear at the next login
 * with the current assignment.
 *
 * Non-uuid ids are filtered before the query, not caught after it: `invalid input syntax for type uuid`
 * is a 22P02 that surfaces as a 500 on a path whose entire contract is to fail quietly.
 *
 * ON CONFLICT UPDATE is the idempotency guarantee — a double click, a StrictMode double-invoke and a
 * retried request still leave one row, while a task handed away and back can replace its old acknowledgement
 * with one that answers the current assignment. The acknowledgement is derived entirely in PostgreSQL:
 * `GREATEST(NOW(), tasks.assigned_at)` covers a handoff whose exact database timestamp is ahead of this
 * transaction clock, and the conflict branch preserves an already-later acknowledgement. That keeps the
 * acknowledgement monotonic without ever round-tripping `assigned_at` through a millisecond JS Date.
 */
export async function acknowledgeTaskAssignments(
  tenantDb: TenantDb,
  userId: string,
  assignments: unknown,
  officeId?: string
): Promise<number> {
  const candidates: AssignmentAcknowledgementCandidate[] = [];
  const seen = new Set<string>();
  const acknowledgementOfficeId = acknowledgementOfficeScope(officeId);
  // The browser can send only the five cards from its capped GET page. Bound raw entries BEFORE token
  // verification too: a crafted body full of unique, plausible ids and bogus signatures must not turn
  // this quiet no-op endpoint into unbounded HMAC work or Buffer allocation.
  const rawAssignments = Array.isArray(assignments) ? assignments : [];
  const entriesToInspect = Math.min(rawAssignments.length, PENDING_ASSIGNMENT_MODAL_LIMIT);
  for (let index = 0; index < entriesToInspect; index += 1) {
    const value = rawAssignments[index];
    if (!value || typeof value !== "object") continue;
    const taskId = (value as Record<string, unknown>).taskId;
    const assignmentVersion = (value as Record<string, unknown>).assignmentVersion;
    const acknowledgementToken = (value as Record<string, unknown>).acknowledgementToken;
    if (
      typeof taskId !== "string" ||
      typeof assignmentVersion !== "string" ||
      typeof acknowledgementToken !== "string" ||
      !UUID_SHAPE.test(taskId.trim()) ||
      !ASSIGNMENT_VERSION_SHAPE.test(assignmentVersion)
    ) {
      continue;
    }
    const normalizedTaskId = taskId.trim();
    const key = `${normalizedTaskId}:${assignmentVersion}`;
    if (seen.has(key)) continue;
    // The receipt is emitted only for rows in the GET endpoint's ordered five-card page. A task's
    // assigned_at is visible through ordinary task APIs, so ownership + version alone would let a user
    // manufacture an acknowledgement for a normal task they have not been shown, including page six.
    if (
      !hasValidAcknowledgementToken(acknowledgementToken, {
        userId,
        officeId: acknowledgementOfficeId,
        taskId: normalizedTaskId,
        assignmentVersion,
      })
    ) {
      continue;
    }
    seen.add(key);
    candidates.push({ taskId: normalizedTaskId, assignmentVersion });
  }
  if (candidates.length === 0) return 0;

  // This runs inside the tenant middleware's BEGIN/COMMIT transaction. FOR UPDATE retains each row lock
  // through the following upsert and the route's commit, so another assignment PATCH cannot slip a new
  // assigned_at between the test below and the acknowledgement write.
  const owned = await tenantDb
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.assignedTo, userId),
        or(
          ...candidates.map(({ taskId, assignmentVersion }) =>
            and(eq(tasks.id, taskId), sql`${assignmentVersionSql} = ${assignmentVersion}`)
          )
        )
      )
    )
    .for("update");
  if (owned.length === 0) return 0;

  // Keep `assigned_at` inside this SQL statement. Drizzle decodes a timestamptz into a JS Date, which
  // drops its final three microseconds; an acknowledgement must compare against the exact locked value.
  // The first SELECT locked these ids until the tenant transaction commits, so this second read cannot
  // observe a different handoff. A timestamp from a future/long-running transaction must still settle
  // the modal, and an existing future acknowledgement must never be moved backwards on a duplicate POST.
  await tenantDb.execute(sql`
    INSERT INTO task_assignment_acknowledgements (task_id, user_id, acknowledged_at)
    SELECT
      ${tasks.id},
      ${userId}::uuid,
      GREATEST(NOW(), ${tasks.assignedAt})
    FROM tasks
    WHERE ${inArray(
      tasks.id,
      owned.map((row) => row.id)
    )}
    ON CONFLICT (task_id, user_id) DO UPDATE
    SET acknowledged_at = GREATEST(
      task_assignment_acknowledgements.acknowledged_at,
      EXCLUDED.acknowledged_at
    )
  `);

  return owned.length;
}
