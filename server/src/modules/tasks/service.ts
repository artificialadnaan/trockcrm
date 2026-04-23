import { eq, and, desc, asc, sql, or, isNull, isNotNull, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals, jobQueue, taskResolutionState, tasks } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { TASK_RULES } from "./rules/config.js";

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

export interface TaskFilters {
  assignedTo?: string;
  status?: string;
  type?: string;
  dealId?: string;
  contactId?: string;
  section?: "overdue" | "today" | "upcoming" | "completed";
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
  const existing = (await getTaskById(tenantDb, taskId, userRole, userId)) as any;
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
    .where(eq(tasks.id, taskId))
    .returning();

  const updatedTask = result[0];
  if (resolvedAt) {
    await writeDismissalResolutionState(tenantDb, updatedTask, resolvedAt);
  }

  return updatedTask;
}

/**
 * Get tasks for a user, optionally filtered by section.
 * Sections map to the UI layout: Overdue, Today, Upcoming, Completed.
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

  // Section-based filtering
  // Use office timezone (CT for T Rock) for date bucketing instead of UTC.
  // This ensures "today" matches the user's local date, not UTC midnight.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); // YYYY-MM-DD in CT

  const openStatusCondition = buildOpenTaskStatusCondition(new Date());

  if (filters.section === "overdue") {
    conditions.push(openStatusCondition, sql`${tasks.dueDate} < ${today}`);
  } else if (filters.section === "today") {
    conditions.push(openStatusCondition, sql`${tasks.dueDate} = ${today}`);
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

  const [countResult, taskRows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(tasks).where(where),
    tenantDb
      .select({
        id: tasks.id,
        title: tasks.title,
        description: tasks.description,
        type: tasks.type,
        priority: tasks.priority,
        status: tasks.status,
        assignedTo: tasks.assignedTo,
        assignedToName,
        createdBy: tasks.createdBy,
        dealId: tasks.dealId,
        dealName: deals.name,
        dealNumber: deals.dealNumber,
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
      .orderBy(
        // Priority-sectioned ordering per spec:
        // Overdue first (is_overdue DESC), then by priority rank ASC, then by due_date ASC.
        // Completed section: order by completedAt DESC instead.
        ...(filters.section === "completed"
          ? [desc(tasks.completedAt)]
          : filters.status === "scheduled"
            ? [asc(taskColumns.scheduledFor), asc(priorityRank), asc(tasks.title)]
            : [desc(tasks.isOverdue), asc(priorityRank), asc(tasks.dueDate)])
      )
      .limit(limit)
      .offset(offset),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    tasks: taskRows,
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

  return tenantDb
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      type: tasks.type,
      priority: tasks.priority,
      status: tasks.status,
      assignedTo: tasks.assignedTo,
      assignedToName,
      createdBy: tasks.createdBy,
      dealId: tasks.dealId,
      dealName: deals.name,
      dealNumber: deals.dealNumber,
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
    .where(eq(tasks.dealId, dealId))
    .orderBy(desc(tasks.isOverdue), asc(priorityRank), asc(tasks.dueDate), asc(tasks.title));
}

/**
 * Get task counts per section for the current user.
 * Used by the task list page header and sidebar badge.
 */
export async function getTaskCounts(
  tenantDb: TenantDb,
  userRole: string,
  currentUserId: string,
  targetUserId?: string | null
) {
  // Use office timezone (CT for T Rock) for date bucketing
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); // YYYY-MM-DD in CT
  const effectiveUserId = userRole === "rep" ? currentUserId : (targetUserId ?? null);
  const scopeClause = effectiveUserId ? sql`WHERE assigned_to = ${effectiveUserId}` : sql``;

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
      )::int AS completed
    FROM tasks
    ${scopeClause}
  `);

  const rows = (result as any).rows ?? result;
  const row = rows[0] ?? {};
  return {
    overdue: Number(row.overdue ?? 0),
    today: Number(row.today ?? 0),
    upcoming: Number(row.upcoming ?? 0),
    completed: Number(row.completed ?? 0),
  };
}

/**
 * Get a single task by ID.
 */
export async function getTaskById(
  tenantDb: TenantDb,
  taskId: string,
  userRole: string,
  userId: string
) {
  const result = await tenantDb
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  const task = (result[0] ?? null) as any;
  if (!task) return null;

  // Reps can only see their own tasks
  if (userRole === "rep" && task.assignedTo !== userId) {
    throw new AppError(403, "You can only view your own tasks");
  }

  return task;
}

/**
 * Create a new task.
 */
export async function createTask(tenantDb: TenantDb, input: CreateTaskInput) {
  const result = await tenantDb
    .insert(tasks)
    .values({
      title: input.title,
      description: input.description ?? null,
      type: input.type as any,
      priority: (input.priority as any) ?? "normal",
      status: "pending",
      assignedTo: input.assignedTo,
      createdBy: input.createdBy ?? null,
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
  const existing = await getTaskById(tenantDb, taskId, userRole, userId);
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
  if (input.assignedTo !== undefined) updates.assignedTo = input.assignedTo;

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
  userId: string
) {
  // RBAC check: getTaskById enforces rep-only-own-tasks
  const existing = await getTaskById(tenantDb, taskId, userRole, userId);
  if (!existing) throw new AppError(404, "Task not found");

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
    .where(and(eq(tasks.id, taskId), inArray(tasks.status as any, ["pending", "in_progress", "waiting_on", "blocked"] as any)))
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
  userId: string
) {
  const existing = await getTaskById(tenantDb, taskId, userRole, userId);
  if (!existing) throw new AppError(404, "Task not found");

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
    .where(eq(tasks.id, taskId))
    .returning();

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
  const existing = await getTaskById(tenantDb, taskId, userRole, userId);
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
