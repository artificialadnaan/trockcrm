import { eq, and, desc, asc, sql, or, isNull, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { tasks } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

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

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: string;
  dueDate?: string | null;
  dueTime?: string | null;
  remindAt?: string | null;
  assignedTo?: string;
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

  if (filters.section === "overdue") {
    conditions.push(
      inArray(tasks.status, ["pending", "in_progress"]),
      sql`${tasks.dueDate} < ${today}`
    );
  } else if (filters.section === "today") {
    conditions.push(
      inArray(tasks.status, ["pending", "in_progress"]),
      sql`${tasks.dueDate} = ${today}`
    );
  } else if (filters.section === "upcoming") {
    conditions.push(
      inArray(tasks.status, ["pending", "in_progress"]),
      or(
        sql`${tasks.dueDate} > ${today}`,
        isNull(tasks.dueDate)
      )
    );
  } else if (filters.section === "completed") {
    conditions.push(
      inArray(tasks.status, ["completed", "dismissed"])
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Priority rank: urgent=0, high=1, normal=2, low=3
  const priorityRank = sql<number>`CASE ${tasks.priority}
    WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4
  END`;

  const [countResult, taskRows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(tasks).where(where),
    tenantDb
      .select()
      .from(tasks)
      .where(where)
      .orderBy(
        // Priority-sectioned ordering per spec:
        // Overdue first (is_overdue DESC), then by priority rank ASC, then by due_date ASC.
        // Completed section: order by completedAt DESC instead.
        ...(filters.section === "completed"
          ? [desc(tasks.completedAt)]
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

/**
 * Get task counts per section for the current user.
 * Used by the task list page header and sidebar badge.
 */
export async function getTaskCounts(
  tenantDb: TenantDb,
  userId: string
) {
  // Use office timezone (CT for T Rock) for date bucketing
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); // YYYY-MM-DD in CT

  const result = await tenantDb.execute(sql`
    SELECT
      COUNT(*) FILTER (
        WHERE status IN ('pending', 'in_progress') AND due_date < ${today}
      )::int AS overdue,
      COUNT(*) FILTER (
        WHERE status IN ('pending', 'in_progress') AND due_date = ${today}
      )::int AS today,
      COUNT(*) FILTER (
        WHERE status IN ('pending', 'in_progress') AND (due_date > ${today} OR due_date IS NULL)
      )::int AS upcoming,
      COUNT(*) FILTER (
        WHERE status = 'completed'
          AND completed_at IS NOT NULL
          AND completed_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::date - INTERVAL '7 days'
      )::int AS completed
    FROM tasks
    WHERE assigned_to = ${userId}
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

  const task = result[0] ?? null;
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
    })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, ["pending", "in_progress"])))
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

  const result = await tenantDb
    .update(tasks)
    .set({ status: "dismissed", isOverdue: false })
    .where(eq(tasks.id, taskId))
    .returning();

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
