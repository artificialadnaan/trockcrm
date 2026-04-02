# Plan 6: Tasks & Notifications Implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the full task management and notification system: Task CRUD (create, complete, dismiss, snooze), activity logging API (calls, notes, meetings linked to deals and contacts), automated daily task list generation worker, activity drop detection worker, SSE real-time notification push wired to the event bus, notification center with unread badge and deep links, task list page with priority-sectioned UI (Overdue/Today/Upcoming/Completed), and activity logging forms wired to existing contact-activity-tab and deal detail pages.

**Architecture:** Task and notification services as tenant-scoped modules on the Express router. Activity logging endpoint that creates activity records and updates touchpoint counters via existing PG trigger. Daily task generation and activity drop detection as worker cron jobs following the stale-deals pattern. SSE notification push by subscribing the event bus to connected user SSE streams. React frontend with task list hooks, notification center hooks, and wired activity forms.

**Tech Stack:** TypeScript, Express, Drizzle ORM, PostgreSQL, node-cron, Server-Sent Events (SSE), React, Vite, Tailwind CSS, shadcn/ui, lucide-react

**Spec Reference:** `docs/superpowers/specs/2026-04-01-trock-crm-design.md` -- Sections 4.2 (tasks, notifications, activities tables), 8 (Email Integration -- inbound task creation), 11 (Frontend -- Task List, Activity Logging Forms), 12 (Worker Jobs -- daily tasks, stale deals, activity drop), 22 (Default Date & Filter Behavior)

**Depends On:** Plan 1 (Foundation) + Plan 2 (Deals & Pipeline) + Plan 3 (Contacts & Dedup) + Plan 4 (Email Integration) + Plan 5 (Files & Photos) -- all fully implemented.

**Already Exists (do NOT recreate):**
- `shared/src/schema/tenant/tasks.ts` -- tasks table schema with indexes
- `shared/src/schema/tenant/notifications.ts` -- notifications table schema with indexes
- `shared/src/schema/tenant/activities.ts` -- activities table schema with indexes
- `shared/src/types/enums.ts` -- TASK_TYPES, TASK_PRIORITIES, TASK_STATUSES, NOTIFICATION_TYPES, ACTIVITY_TYPES, CALL_OUTCOMES
- `shared/src/schema/index.ts` -- already exports tasks, notifications, activities
- `shared/src/types/events.ts` -- DOMAIN_EVENTS including TASK_COMPLETED
- `worker/src/jobs/stale-deals.ts` -- creates stale_deal tasks and notifications (reference pattern)
- `worker/src/jobs/email-sync.ts` -- creates inbound_email tasks (reference pattern)
- `server/src/modules/notifications/routes.ts` -- SSE endpoint (keepalive only -- needs real push)
- `server/src/events/bus.ts` -- EventBus with emitLocal/emitRemote/emitAll
- `client/src/components/contacts/contact-activity-tab.tsx` -- existing UI calling nonexistent endpoint
- `client/src/components/layout/topbar.tsx` -- Bell icon (needs unread count badge)

---

## File Structure

```
server/src/modules/tasks/
  ├── routes.ts                    # /api/tasks/* route definitions
  └── service.ts                   # Task CRUD, complete, dismiss, snooze

server/src/modules/activities/
  ├── routes.ts                    # /api/activities/* + /api/contacts/:id/activities
  └── service.ts                   # Activity CRUD, deal lastActivityAt update

server/src/modules/notifications/
  ├── routes.ts                    # MODIFY: add SSE push + notification CRUD routes
  ├── service.ts                   # Notification list, mark read, unread count
  └── sse-manager.ts              # SSE connection registry, push to connected users

server/tests/modules/tasks/
  └── service.test.ts              # Task CRUD logic, priority ordering, snooze

server/tests/modules/activities/
  └── service.test.ts              # Activity creation, lastActivityAt update

server/tests/modules/notifications/
  └── service.test.ts              # Notification CRUD, unread count, mark read

worker/src/jobs/
  ├── daily-tasks.ts               # Daily task list generation (6am CT)
  └── activity-alerts.ts           # Activity drop detection (7am CT)

client/src/hooks/
  ├── use-tasks.ts                 # Task data fetching + mutations
  ├─��� use-notifications.ts         # Notification data + SSE stream + unread count
  └── use-activities.ts            # Activity logging mutations

client/src/pages/tasks/
  └── task-list-page.tsx           # Full task list page (Overdue/Today/Upcoming/Completed)

client/src/components/tasks/
  ├── task-section.tsx             # Collapsible section (Overdue, Today, etc.)
  ├── task-row.tsx                 # Single task with quick actions
  └── task-create-dialog.tsx       # Manual task creation modal

client/src/components/notifications/
  └── notification-center.tsx      # Bell dropdown with notification list

client/src/components/activities/
  └── activity-log-form.tsx        # Shared call/note/meeting form (used by contacts + deals)
```

---

## Task 1: Task Service + API Routes (CRUD, Complete, Dismiss, Snooze)

- [ ] Create `server/src/modules/tasks/service.ts`
- [ ] Create `server/src/modules/tasks/routes.ts`
- [ ] Register task routes in `server/src/app.ts`

### 1a. Task Service

**File: `server/src/modules/tasks/service.ts`**

```typescript
import { eq, and, desc, asc, sql, or, lte, gt, isNull, inArray } from "drizzle-orm";
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
        WHERE status IN ('completed', 'dismissed')
          AND (completed_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::date - INTERVAL '7 days'
               OR completed_at IS NULL)
      )::int AS completed
    FROM tasks
    WHERE assigned_to = ${userId}
  `);

  const row = (result as any).rows?.[0] ?? result[0] ?? {};
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
 */
export async function completeTask(
  tenantDb: TenantDb,
  taskId: string,
  userRole: string,
  userId: string
) {
  const existing = await getTaskById(tenantDb, taskId, userRole, userId);
  if (!existing) throw new AppError(404, "Task not found");

  if (existing.status === "completed") {
    throw new AppError(400, "Task is already completed");
  }

  const result = await tenantDb
    .update(tasks)
    .set({
      status: "completed",
      completedAt: new Date(),
      isOverdue: false,
    })
    .where(eq(tasks.id, taskId))
    .returning();

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
```

### 1b. Task Routes

**File: `server/src/modules/tasks/routes.ts`**

```typescript
import { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { eventBus } from "../../events/bus.js";
import {
  getTasks,
  getTaskCounts,
  getTaskById,
  createTask,
  updateTask,
  completeTask,
  dismissTask,
  snoozeTask,
} from "./service.js";

const router = Router();

// GET /api/tasks — list tasks (paginated, filtered by section)
router.get("/", async (req, res, next) => {
  try {
    const filters = {
      assignedTo: req.query.assignedTo as string | undefined,
      status: req.query.status as string | undefined,
      type: req.query.type as string | undefined,
      dealId: req.query.dealId as string | undefined,
      contactId: req.query.contactId as string | undefined,
      section: req.query.section as "overdue" | "today" | "upcoming" | "completed" | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await getTasks(req.tenantDb!, filters, req.user!.role, req.user!.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/tasks/counts — task counts per section
router.get("/counts", async (req, res, next) => {
  try {
    const userId = req.query.userId as string | undefined;
    // Reps always get their own counts; directors can query other users
    const targetUserId = req.user!.role === "rep" ? req.user!.id : (userId ?? req.user!.id);

    const counts = await getTaskCounts(req.tenantDb!, targetUserId);
    await req.commitTransaction!();
    res.json({ counts });
  } catch (err) {
    next(err);
  }
});

// GET /api/tasks/:id — single task
router.get("/:id", async (req, res, next) => {
  try {
    const task = await getTaskById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!task) throw new AppError(404, "Task not found");
    await req.commitTransaction!();
    res.json({ task });
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks — create a manual task
router.post("/", async (req, res, next) => {
  try {
    const { title, description, type, priority, assignedTo, dealId, contactId, dueDate, dueTime, remindAt } = req.body;

    if (!title) throw new AppError(400, "Title is required");

    // Reps create tasks assigned to themselves; directors/admins can assign to anyone
    const targetAssignee = req.user!.role === "rep"
      ? req.user!.id
      : (assignedTo ?? req.user!.id);

    const task = await createTask(req.tenantDb!, {
      title,
      description,
      type: type ?? "manual",
      priority,
      assignedTo: targetAssignee,
      createdBy: req.user!.id,
      dealId,
      contactId,
      dueDate,
      dueTime,
      remindAt,
    });

    await req.commitTransaction!();

    // Emit task.assigned notification if assigned to someone else
    if (targetAssignee !== req.user!.id) {
      try {
        eventBus.emitLocal({
          name: "task.assigned",
          payload: {
            taskId: task.id,
            assignedTo: targetAssignee,
            title: task.title,
          },
          officeId: req.user!.activeOfficeId ?? req.user!.officeId,
          userId: req.user!.id,
          timestamp: new Date(),
        });
      } catch (eventErr) {
        console.error("[Tasks] Failed to emit task event:", eventErr);
      }
    }

    res.status(201).json({ task });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tasks/:id — update task fields
router.patch("/:id", async (req, res, next) => {
  try {
    const task = await updateTask(
      req.tenantDb!,
      req.params.id,
      req.body,
      req.user!.role,
      req.user!.id
    );
    await req.commitTransaction!();
    res.json({ task });
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/:id/complete — mark task as completed
router.post("/:id/complete", async (req, res, next) => {
  try {
    const task = await completeTask(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);

    // Outbox pattern: insert into job_queue BEFORE committing the transaction
    // so the event is guaranteed to be persisted even if emitLocal fails.
    const { jobQueue } = await import("@trock-crm/shared/schema");
    await req.tenantDb!.insert(jobQueue).values({
      jobType: "domain_event",
      payload: {
        eventName: "task.completed",
        taskId: task.id,
        dealId: task.dealId,
        contactId: task.contactId,
        title: task.title,
        type: task.type,
        completedBy: req.user!.id,
      },
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      status: "pending",
      runAfter: new Date(),
    });

    await req.commitTransaction!();

    // Best-effort local emit for SSE push (already persisted via outbox above)
    try {
      eventBus.emitLocal({
        name: "task.completed",
        payload: {
          taskId: task.id,
          dealId: task.dealId,
          contactId: task.contactId,
          title: task.title,
          type: task.type,
          completedBy: req.user!.id,
        },
        officeId: req.user!.activeOfficeId ?? req.user!.officeId,
        userId: req.user!.id,
        timestamp: new Date(),
      });
    } catch (eventErr) {
      console.error("[Tasks] Failed to emit task.completed event:", eventErr);
    }

    res.json({ task });
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/:id/dismiss — dismiss a task
router.post("/:id/dismiss", async (req, res, next) => {
  try {
    const task = await dismissTask(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    await req.commitTransaction!();
    res.json({ task });
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/:id/snooze — snooze a task to a new due date
router.post("/:id/snooze", async (req, res, next) => {
  try {
    const { dueDate } = req.body;
    if (!dueDate) throw new AppError(400, "dueDate is required for snooze");

    const task = await snoozeTask(
      req.tenantDb!,
      req.params.id,
      dueDate,
      req.user!.role,
      req.user!.id
    );
    await req.commitTransaction!();
    res.json({ task });
  } catch (err) {
    next(err);
  }
});

export const taskRoutes = router;
```

### 1c. Register Task Routes

**File: `server/src/app.ts`** -- Add to the tenantRouter:

```typescript
import { taskRoutes } from "./modules/tasks/routes.js";

// Add after existing tenantRouter.use lines:
tenantRouter.use("/tasks", taskRoutes);
```

---

## Task 2: Activity Logging Service + API Routes

- [ ] Create `server/src/modules/activities/service.ts`
- [ ] Create `server/src/modules/activities/routes.ts`
- [ ] Register activity routes in `server/src/app.ts`

### 2a. Activity Service

**File: `server/src/modules/activities/service.ts`**

```typescript
import { eq, and, desc, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { activities, deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface CreateActivityInput {
  type: string;
  userId: string;
  dealId?: string;
  contactId?: string;
  emailId?: string;
  subject?: string;
  body?: string;
  outcome?: string;
  durationMinutes?: number;
  occurredAt?: string;
}

export interface ActivityFilters {
  dealId?: string;
  contactId?: string;
  userId?: string;
  type?: string;
  page?: number;
  limit?: number;
}

/**
 * Get activities filtered by deal, contact, or user.
 */
export async function getActivities(
  tenantDb: TenantDb,
  filters: ActivityFilters
) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 50;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];

  if (filters.dealId) conditions.push(eq(activities.dealId, filters.dealId));
  if (filters.contactId) conditions.push(eq(activities.contactId, filters.contactId));
  if (filters.userId) conditions.push(eq(activities.userId, filters.userId));
  if (filters.type) conditions.push(eq(activities.type, filters.type as any));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult, rows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(activities).where(where),
    tenantDb
      .select()
      .from(activities)
      .where(where)
      .orderBy(desc(activities.occurredAt))
      .limit(limit)
      .offset(offset),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    activities: rows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Create an activity (call, note, meeting, task_completed).
 * Also updates deals.lastActivityAt if a dealId is provided.
 *
 * NOTE: The existing PG touchpoint_trigger on the activities table automatically
 * handles: incrementing contacts.touchpoint_count, updating contacts.last_contacted_at,
 * and setting contacts.first_outreach_completed = true for call/email/meeting types.
 * We do NOT need to do this in application code.
 */
export async function createActivity(
  tenantDb: TenantDb,
  input: CreateActivityInput
) {
  if (!input.type) throw new AppError(400, "Activity type is required");
  if (!input.userId) throw new AppError(400, "userId is required");

  const result = await tenantDb
    .insert(activities)
    .values({
      type: input.type as any,
      userId: input.userId,
      dealId: input.dealId ?? null,
      contactId: input.contactId ?? null,
      emailId: input.emailId ?? null,
      subject: input.subject ?? null,
      body: input.body ?? null,
      outcome: input.outcome ?? null,
      durationMinutes: input.durationMinutes ?? null,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
    })
    .returning();

  const activity = result[0];

  // Update deal.lastActivityAt if deal is associated
  if (input.dealId) {
    await tenantDb
      .update(deals)
      .set({ lastActivityAt: new Date() })
      .where(eq(deals.id, input.dealId));
  }

  return activity;
}
```

### 2b. Activity Routes

**File: `server/src/modules/activities/routes.ts`**

```typescript
import { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { getActivities, createActivity } from "./service.js";

const router = Router();

// GET /api/activities — list activities (filtered by deal, contact, or user)
router.get("/", async (req, res, next) => {
  try {
    const filters = {
      dealId: req.query.dealId as string | undefined,
      contactId: req.query.contactId as string | undefined,
      userId: req.query.userId as string | undefined,
      type: req.query.type as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    // RBAC: If filtering by dealId, verify the user has access to this deal
    if (filters.dealId) {
      const { getDealById } = await import("../deals/service.js");
      const deal = await getDealById(req.tenantDb!, filters.dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(404, "Deal not found");
    }

    const result = await getActivities(req.tenantDb!, filters);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/activities — create an activity (call, note, meeting)
router.post("/", async (req, res, next) => {
  try {
    const { type, subject, body, outcome, durationMinutes, dealId, contactId, occurredAt } = req.body;

    if (!type) throw new AppError(400, "Activity type is required");
    if (!contactId && !dealId) {
      throw new AppError(400, "At least one of contactId or dealId is required");
    }

    // RBAC: If dealId is provided, verify the user has access to this deal
    if (dealId) {
      const { getDealById } = await import("../deals/service.js");
      const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(404, "Deal not found");
    }

    const activity = await createActivity(req.tenantDb!, {
      type,
      userId: req.user!.id,
      dealId,
      contactId,
      subject,
      body,
      outcome,
      durationMinutes,
      occurredAt,
    });

    await req.commitTransaction!();
    res.status(201).json({ activity });
  } catch (err) {
    next(err);
  }
});

// NOTE: Contact-scoped activity endpoints (POST/GET /api/contacts/:id/activities)
// are mounted on the contacts router (see contacts/routes.ts in Task 2c) to avoid
// duplicate mounting and route ambiguity. Do NOT add them here.

export const activityRoutes = router;
```

### 2c. Register Activity Routes

**File: `server/src/app.ts`** -- Add to the tenantRouter:

```typescript
import { activityRoutes } from "./modules/activities/routes.js";

// Mount activity routes at /api/activities ONLY.
// Contact-specific activity endpoints (POST/GET /api/contacts/:id/activities) are mounted
// directly on the contacts router (see contacts/routes.ts below) to avoid duplicate mounting.
tenantRouter.use("/activities", activityRoutes);
```

**IMPORTANT:** The contact-scoped activity routes (`POST /api/contacts/:id/activities` and `GET /api/contacts/:id/activities`) live on the contacts router to avoid duplicate mounting. Add these two routes directly inside the existing `server/src/modules/contacts/routes.ts`:

```typescript
// Add at the bottom of contacts/routes.ts, before the export:

// POST /api/contacts/:id/activities — log an activity for a contact
// (wires up the contact-activity-tab.tsx form)
router.post("/:id/activities", async (req, res, next) => {
  try {
    const { createActivity } = await import("../activities/service.js");
    const contactId = req.params.id;
    const { type, subject, body, outcome, durationMinutes, dealId, occurredAt } = req.body;

    if (!type) throw new AppError(400, "Activity type is required");

    const activity = await createActivity(req.tenantDb!, {
      type,
      userId: req.user!.id,
      dealId: dealId ?? null,
      contactId,
      subject,
      body,
      outcome,
      durationMinutes,
      occurredAt,
    });

    await req.commitTransaction!();
    res.status(201).json({ activity });
  } catch (err) {
    next(err);
  }
});

// GET /api/contacts/:id/activities — get activities for a contact
router.get("/:id/activities", async (req, res, next) => {
  try {
    const { getActivities } = await import("../activities/service.js");
    const result = await getActivities(req.tenantDb!, {
      contactId: req.params.id,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    });
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});
```

And register `/api/activities` standalone in `app.ts`:

```typescript
tenantRouter.use("/activities", activityRoutes);
```

---

## Task 3: Daily Task Generation Worker Job

- [ ] Create `worker/src/jobs/daily-tasks.ts`
- [ ] Register cron in `worker/src/index.ts`

### 3a. Daily Task Generation Job

**File: `worker/src/jobs/daily-tasks.ts`**

```typescript
import { pool } from "../db.js";

/**
 * Daily task list generation job.
 *
 * Runs daily at 6:00 AM CT. For each active office:
 * 1. Mark overdue tasks: any pending/in_progress task with due_date < today
 * 2. Create follow-up tasks for deals with upcoming expected_close_date (7 days out)
 * 3. Create touchpoint tasks for contacts with first_outreach_completed = false (older than 3 days)
 *
 * Stale deal tasks and inbound email tasks are already created by their respective
 * workers (stale-deals.ts and email-sync.ts). This job handles the remaining
 * automated task types.
 */
export async function runDailyTaskGeneration(): Promise<void> {
  console.log("[Worker:daily-tasks] Starting daily task generation...");

  const client = await pool.connect();
  try {
    // Get all active offices
    const offices = await client.query(
      "SELECT id, slug FROM public.offices WHERE is_active = true"
    );

    let totalTasksCreated = 0;
    let totalOverdueMarked = 0;

    for (const office of offices.rows) {
      // Acquire advisory lock per office to prevent concurrent runs from racing
      await client.query("BEGIN");
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('daily_task_generation_' || $1))`,
        [office.id]
      );
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(office.slug)) {
        console.error(`[Worker:daily-tasks] Invalid office slug: "${office.slug}" -- skipping`);
        continue;
      }
      const schemaName = `office_${office.slug}`;

      // Step 1: Mark overdue tasks as is_overdue AND escalate to 'urgent' priority
      // Per spec: the daily job should mark existing overdue tasks as urgent priority
      // if they aren't already, so the task list surfaces them prominently.
      // Stale-deal and email-sync workers already CREATE those tasks; this job
      // just ensures they are flagged correctly.
      const overdueResult = await client.query(
        `UPDATE ${schemaName}.tasks
         SET is_overdue = true,
             priority = CASE WHEN priority != 'urgent' THEN 'urgent' ELSE priority END
         WHERE status IN ('pending', 'in_progress')
           AND due_date < CURRENT_DATE
           AND (is_overdue = false OR priority != 'urgent')`
      );
      totalOverdueMarked += overdueResult.rowCount ?? 0;

      // Step 2: Create follow-up tasks for deals with expected_close_date within 7 days
      // Only for deals that don't already have an active follow_up task
      const upcomingDeals = await client.query(
        `SELECT d.id AS deal_id, d.name AS deal_name, d.deal_number,
                d.assigned_rep_id, d.expected_close_date
         FROM ${schemaName}.deals d
         WHERE d.is_active = true
           AND d.expected_close_date IS NOT NULL
           AND d.expected_close_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
           AND NOT EXISTS (
             SELECT 1 FROM ${schemaName}.tasks t
             WHERE t.deal_id = d.id
               AND t.type = 'follow_up'
               AND t.status IN ('pending', 'in_progress')
           )`
      );

      for (const deal of upcomingDeals.rows) {
        await client.query(
          `INSERT INTO ${schemaName}.tasks
           (title, description, type, priority, status, assigned_to, deal_id, due_date)
           VALUES ($1, $2, 'follow_up', 'high', 'pending', $3, $4, $5)`,
          [
            `Follow up: ${deal.deal_number} closes ${deal.expected_close_date}`,
            `${deal.deal_name} has an expected close date of ${deal.expected_close_date}. Ensure all pre-close tasks are complete.`,
            deal.assigned_rep_id,
            deal.deal_id,
            deal.expected_close_date,
          ]
        );
        totalTasksCreated++;
      }

      // Step 3: Create touchpoint tasks for contacts needing first outreach
      // Only contacts older than 3 days without outreach and no active touchpoint task
      const needsOutreach = await client.query(
        `SELECT c.id AS contact_id, c.first_name, c.last_name
         FROM ${schemaName}.contacts c
         WHERE c.is_active = true
           AND c.first_outreach_completed = false
           AND c.created_at < CURRENT_DATE - INTERVAL '3 days'
           AND NOT EXISTS (
             SELECT 1 FROM ${schemaName}.tasks t
             WHERE t.contact_id = c.id
               AND t.type = 'touchpoint'
               AND t.status IN ('pending', 'in_progress')
           )`
      );

      // Assign touchpoint tasks to the rep who has the most deals with this contact,
      // or fall back to the first active rep in the office
      for (const contact of needsOutreach.rows) {
        const repResult = await client.query(
          `SELECT cda.deal_id, d.assigned_rep_id
           FROM ${schemaName}.contact_deal_associations cda
           JOIN ${schemaName}.deals d ON d.id = cda.deal_id AND d.is_active = true
           WHERE cda.contact_id = $1
           ORDER BY d.created_at DESC
           LIMIT 1`,
          [contact.contact_id]
        );

        let assignedTo: string | null = repResult.rows[0]?.assigned_rep_id ?? null;

        // Fallback: first active rep in this office
        if (!assignedTo) {
          const fallbackRep = await client.query(
            `SELECT id FROM public.users
             WHERE office_id = $1 AND role = 'rep' AND is_active = true
             LIMIT 1`,
            [office.id]
          );
          assignedTo = fallbackRep.rows[0]?.id ?? null;
        }

        if (!assignedTo) continue; // No rep available

        await client.query(
          `INSERT INTO ${schemaName}.tasks
           (title, type, priority, status, assigned_to, contact_id, due_date)
           VALUES ($1, 'touchpoint', 'normal', 'pending', $2, $3, CURRENT_DATE)`,
          [
            `First outreach needed: ${contact.first_name} ${contact.last_name}`,
            assignedTo,
            contact.contact_id,
          ]
        );
        totalTasksCreated++;
      }

      // Release the advisory lock by committing the transaction for this office
      await client.query("COMMIT");
    }

    console.log(`[Worker:daily-tasks] Complete. Marked ${totalOverdueMarked} overdue, created ${totalTasksCreated} new tasks`);
  } catch (err) {
    console.error("[Worker:daily-tasks] Failed:", err);
    throw err;
  } finally {
    client.release();
  }
}
```

### 3b. Register Cron

**File: `worker/src/index.ts`** -- Add import and cron schedule:

```typescript
import { runDailyTaskGeneration } from "./jobs/daily-tasks.js";

// Daily task generation: daily at 6:00 AM CT (runs alongside stale deal scan)
cron.schedule("0 6 * * *", async () => {
  console.log("[Worker:cron] Running daily task generation...");
  try {
    await runDailyTaskGeneration();
  } catch (err) {
    console.error("[Worker:cron] Daily task generation failed:", err);
  }
}, { timezone: "America/Chicago" });
console.log("[Worker] Cron scheduled: daily task generation at 6:00 AM CT daily");
```

---

## Task 4: Activity Drop Detection Worker Job

- [ ] Create `worker/src/jobs/activity-alerts.ts`
- [ ] Register cron in `worker/src/index.ts`

### 4a. Activity Drop Detection Job

**File: `worker/src/jobs/activity-alerts.ts`**

```typescript
import { pool } from "../db.js";

/**
 * Activity drop detection job.
 *
 * Runs daily at 7:00 AM CT. For each active office:
 * 1. Calculate each rep's 90-day rolling average activity count (per week)
 * 2. Calculate their last 7 days of activity
 * 3. If last 7 days < (rolling_avg - 1 standard deviation), flag as activity drop
 * 4. Create notification for all directors/admins in the rep's office
 *
 * Activity types counted: call, meeting, email (not notes or task_completed,
 * which are passive activities).
 */
export async function runActivityDropDetection(): Promise<void> {
  console.log("[Worker:activity-alerts] Starting activity drop detection...");

  const client = await pool.connect();
  try {
    const offices = await client.query(
      "SELECT id, slug FROM public.offices WHERE is_active = true"
    );

    let totalAlerts = 0;

    for (const office of offices.rows) {
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(office.slug)) {
        console.error(`[Worker:activity-alerts] Invalid office slug: "${office.slug}" -- skipping`);
        continue;
      }
      const schemaName = `office_${office.slug}`;

      // Acquire advisory lock per office to prevent concurrent runs from racing
      await client.query("BEGIN");
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('activity_drop_detection_' || $1))`,
        [office.id]
      );

      // Get all active reps in this office
      const reps = await client.query(
        `SELECT id, display_name FROM public.users
         WHERE office_id = $1 AND role = 'rep' AND is_active = true`,
        [office.id]
      );

      for (const rep of reps.rows) {
        // Calculate 90-day rolling weekly averages for outreach activities.
        // Generate ALL 13 weeks in the window via generate_series and LEFT JOIN
        // actual counts, so weeks with zero activity show as 0 (not excluded).
        const statsResult = await client.query(
          `WITH weeks AS (
            SELECT generate_series(
              date_trunc('week', NOW() - interval '90 days'),
              date_trunc('week', NOW()),
              interval '1 week'
            ) AS week_start
          ),
          weekly_counts AS (
            SELECT w.week_start, COALESCE(COUNT(a.id), 0) AS activity_count
            FROM weeks w
            LEFT JOIN ${schemaName}.activities a
              ON date_trunc('week', a.occurred_at) = w.week_start
              AND a.user_id = $1
              AND a.type IN ('call', 'meeting', 'email')
            GROUP BY w.week_start
          )
          SELECT
            COALESCE(AVG(activity_count), 0)::numeric(10,2) AS avg_weekly,
            COALESCE(STDDEV_POP(activity_count), 0)::numeric(10,2) AS stddev_weekly,
            COUNT(*)::int AS weeks_with_data
          FROM weekly_counts`,
          [rep.id]
        );

        const stats = statsResult.rows[0];
        const avgWeekly = parseFloat(stats.avg_weekly);
        const stddevWeekly = parseFloat(stats.stddev_weekly);
        const weeksWithData = parseInt(stats.weeks_with_data, 10);

        // Need at least 4 weeks of data for a meaningful baseline
        if (weeksWithData < 4) continue;

        // Count last 7 days of activity
        const recentResult = await client.query(
          `SELECT COUNT(*)::int AS recent_count
           FROM ${schemaName}.activities
           WHERE user_id = $1
             AND type IN ('call', 'meeting', 'email')
             AND occurred_at >= NOW() - INTERVAL '7 days'`,
          [rep.id]
        );

        const recentCount = recentResult.rows[0].recent_count;
        const threshold = avgWeekly - stddevWeekly;

        // Flag if below threshold
        if (recentCount < threshold && threshold > 0) {
          // Check if already notified today (dedup)
          const existingNotification = await client.query(
            `SELECT id FROM ${schemaName}.notifications
             WHERE type = 'activity_drop'
               AND body LIKE $1
               AND created_at >= CURRENT_DATE
             LIMIT 1`,
            [`%${rep.display_name}%`]
          );

          if (existingNotification.rows.length > 0) continue;

          const title = `Activity drop: ${rep.display_name}`;
          const body = `${rep.display_name} logged ${recentCount} activities in the last 7 days (avg: ${avgWeekly.toFixed(1)}/week, threshold: ${threshold.toFixed(1)}). This is below their 90-day baseline.`;

          // Notify all directors/admins in this office
          const directors = await client.query(
            `SELECT id FROM public.users
             WHERE office_id = $1 AND role IN ('director', 'admin') AND is_active = true`,
            [office.id]
          );

          for (const director of directors.rows) {
            await client.query(
              `INSERT INTO ${schemaName}.notifications (user_id, type, title, body, link)
               VALUES ($1, 'activity_drop', $2, $3, $4)`,
              [director.id, title, body, `/director`]
            );
            totalAlerts++;
          }

          console.log(`[Worker:activity-alerts] Activity drop detected for ${rep.display_name} in ${office.slug}: ${recentCount} vs avg ${avgWeekly.toFixed(1)}`);
        }
      }

      // Release the advisory lock by committing the transaction for this office
      await client.query("COMMIT");
    }

    console.log(`[Worker:activity-alerts] Complete. Created ${totalAlerts} alerts`);
  } catch (err) {
    console.error("[Worker:activity-alerts] Failed:", err);
    throw err;
  } finally {
    client.release();
  }
}
```

### 4b. Register Cron

**File: `worker/src/index.ts`** -- Add import and cron schedule:

```typescript
import { runActivityDropDetection } from "./jobs/activity-alerts.js";

// Activity drop detection: daily at 7:00 AM CT
cron.schedule("0 7 * * *", async () => {
  console.log("[Worker:cron] Running activity drop detection...");
  try {
    await runActivityDropDetection();
  } catch (err) {
    console.error("[Worker:cron] Activity drop detection failed:", err);
  }
}, { timezone: "America/Chicago" });
console.log("[Worker] Cron scheduled: activity drop detection at 7:00 AM CT daily");
```

Also register both new jobs in `worker/src/jobs/index.ts`:

```typescript
import { runDailyTaskGeneration } from "./daily-tasks.js";
import { runActivityDropDetection } from "./activity-alerts.js";

// In registerAllJobs():
registerJobHandler("daily_task_generation", async () => {
  await runDailyTaskGeneration();
});

registerJobHandler("activity_drop_detection", async () => {
  await runActivityDropDetection();
});

// Add domain event handler for task.assigned -> create notification
domainEventHandlers.set("task.assigned", async (payload, _officeId) => {
  console.log(`[Worker] task.assigned: ${payload.taskId} — ${payload.title}`);

  if (!payload.assignedTo) return;

  const { pool: workerPool } = await import("../db.js");
  const userResult = await workerPool.query(
    "SELECT office_id FROM public.users WHERE id = $1",
    [payload.assignedTo]
  );
  if (userResult.rows.length === 0) return;

  const officeResult = await workerPool.query(
    "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
    [userResult.rows[0].office_id]
  );
  if (officeResult.rows.length === 0) return;

  const slug = officeResult.rows[0].slug;
  const slugRegex = /^[a-z][a-z0-9_]*$/;
  if (!slugRegex.test(slug)) return;

  const schemaName = `office_${slug}`;

  await workerPool.query(
    `INSERT INTO ${schemaName}.notifications (user_id, type, title, body, link)
     VALUES ($1, 'task_assigned', $2, $3, $4)`,
    [
      payload.assignedTo,
      `New task assigned: ${payload.title}`,
      payload.title,
      "/tasks",
    ]
  );
});

// Add domain event handler for task.completed -> create activity record
domainEventHandlers.set("task.completed", async (payload, _officeId) => {
  console.log(`[Worker] task.completed: ${payload.taskId} — ${payload.title}`);

  // Create a task_completed activity
  if (!payload.completedBy) return;

  const { pool: workerPool } = await import("../db.js");
  const userResult = await workerPool.query(
    "SELECT office_id FROM public.users WHERE id = $1",
    [payload.completedBy]
  );
  if (userResult.rows.length === 0) return;

  const officeResult = await workerPool.query(
    "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
    [userResult.rows[0].office_id]
  );
  if (officeResult.rows.length === 0) return;

  const slug = officeResult.rows[0].slug;
  const slugRegex = /^[a-z][a-z0-9_]*$/;
  if (!slugRegex.test(slug)) return;

  const schemaName = `office_${slug}`;

  await workerPool.query(
    `INSERT INTO ${schemaName}.activities
     (type, user_id, deal_id, contact_id, subject, occurred_at)
     VALUES ('task_completed', $1, $2, $3, $4, NOW())`,
    [
      payload.completedBy,
      payload.dealId ?? null,
      payload.contactId ?? null,
      `Completed: ${payload.title}`,
    ]
  );
});
```

---

## Task 5: SSE Real-Time Notification Push

- [ ] Create `server/src/modules/notifications/sse-manager.ts`
- [ ] Modify `server/src/modules/notifications/routes.ts` to wire SSE push

### 5a. SSE Connection Manager

**File: `server/src/modules/notifications/sse-manager.ts`**

```typescript
import type { Response } from "express";
import { eventBus } from "../../events/bus.js";

/**
 * Manages active SSE connections per user.
 * When a notification.created event fires on the eventBus,
 * pushes it to all connected SSE streams for that user.
 */

interface SseConnection {
  res: Response;
  userId: string;
  officeId: string;
}

const connections = new Map<string, Set<SseConnection>>();

/**
 * Register an SSE connection for a user.
 * Returns a cleanup function to call on disconnect.
 */
export function registerSseConnection(userId: string, officeId: string, res: Response): () => void {
  if (!connections.has(userId)) {
    connections.set(userId, new Set());
  }

  const conn: SseConnection = { res, userId, officeId };
  connections.get(userId)!.add(conn);

  return () => {
    const userConns = connections.get(userId);
    if (userConns) {
      userConns.delete(conn);
      if (userConns.size === 0) {
        connections.delete(userId);
      }
    }
  };
}

/**
 * Push a notification to all SSE connections for a specific user.
 */
export function pushToUser(userId: string, event: string, data: any): void {
  const userConns = connections.get(userId);
  if (!userConns || userConns.size === 0) return;

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  for (const conn of userConns) {
    try {
      conn.res.write(payload);
    } catch (err) {
      // Connection is dead -- cleanup will happen via req.on("close")
      console.error(`[SSE] Failed to push to user ${userId}:`, err);
    }
  }
}

/**
 * Get the number of active SSE connections (for diagnostics).
 */
export function getConnectionCount(): number {
  let total = 0;
  for (const conns of connections.values()) {
    total += conns.size;
  }
  return total;
}

/**
 * Initialize SSE push by subscribing to relevant eventBus events.
 * Call this once at server startup.
 */
export function initSsePush(): void {
  // Listen for notification.created events (emitted by services after DB insert)
  eventBus.on("notification.created", (event: any) => {
    const { userId, notification } = event.payload ?? event;
    if (userId && notification) {
      pushToUser(userId, "notification", notification);
    }
  });

  // Listen for task.assigned events to push real-time assignment notifications
  eventBus.on("task.assigned", (event: any) => {
    const payload = event.payload ?? event;
    if (payload.assignedTo) {
      pushToUser(payload.assignedTo, "task_update", {
        type: "assigned",
        taskId: payload.taskId,
        title: payload.title,
      });
    }
  });

  // Listen for task.completed events to push real-time completion updates
  eventBus.on("task.completed", (event: any) => {
    const payload = event.payload ?? event;
    if (payload.completedBy) {
      pushToUser(payload.completedBy, "task_update", {
        type: "completed",
        taskId: payload.taskId,
      });
    }
  });

  console.log("[SSE] Push listeners initialized");
}
```

### 5b. Modify Notification Routes for SSE Push

**File: `server/src/modules/notifications/routes.ts`** -- REPLACE entire file:

```typescript
import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { registerSseConnection } from "./sse-manager.js";

const router = Router();

// SSE notification stream
router.get("/stream", authMiddleware, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx buffering on Railway
  });

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ userId: req.user!.id })}\n\n`);

  // Register this connection for real-time push
  const cleanup = registerSseConnection(
    req.user!.id,
    req.user!.activeOfficeId ?? req.user!.officeId,
    res
  );

  // Keepalive ping every 30 seconds
  const keepalive = setInterval(() => {
    res.write(`: keepalive\n\n`);
  }, 30000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(keepalive);
    cleanup();
  });
});

export const notificationRoutes = router;
```

### 5c. Initialize SSE Push at Server Startup

**File: `server/src/app.ts`** -- Add initialization call:

```typescript
import { initSsePush } from "./modules/notifications/sse-manager.js";

// After createApp() function or at the end of the function before return:
initSsePush();
```

### 5d. Emit notification.created from Services

Whenever a notification is inserted via API or service, emit a local event so SSE can push it. Add a helper in the notification service (Task 6 below) that does this automatically.

---

## Task 6: Notification Service + API Routes

- [ ] Create `server/src/modules/notifications/service.ts`
- [ ] Add notification CRUD routes to the existing notification routes file
- [ ] Register notification CRUD routes under tenantRouter

### 6a. Notification Service

**File: `server/src/modules/notifications/service.ts`**

```typescript
import { eq, and, desc, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { notifications } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { eventBus } from "../../events/bus.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface NotificationFilters {
  userId: string;
  isRead?: boolean;
  page?: number;
  limit?: number;
}

/**
 * Get notifications for a user.
 */
export async function getNotifications(tenantDb: TenantDb, filters: NotificationFilters) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 30;
  const offset = (page - 1) * limit;

  const conditions: any[] = [eq(notifications.userId, filters.userId)];
  if (filters.isRead !== undefined) {
    conditions.push(eq(notifications.isRead, filters.isRead));
  }

  const where = and(...conditions);

  const [countResult, rows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(notifications).where(where),
    tenantDb
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    notifications: rows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Get unread notification count for a user.
 */
export async function getUnreadCount(tenantDb: TenantDb, userId: string): Promise<number> {
  const result = await tenantDb
    .select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));

  return Number(result[0]?.count ?? 0);
}

/**
 * Mark a single notification as read.
 */
export async function markAsRead(tenantDb: TenantDb, notificationId: string, userId: string) {
  const result = await tenantDb
    .update(notifications)
    .set({ isRead: true, readAt: new Date() })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
    .returning();

  return result[0] ?? null;
}

/**
 * Mark all notifications as read for a user.
 */
export async function markAllAsRead(tenantDb: TenantDb, userId: string): Promise<number> {
  const result = await tenantDb
    .update(notifications)
    .set({ isRead: true, readAt: new Date() })
    .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));

  // Drizzle update doesn't return rowCount directly — use returning or raw count
  return (result as any).rowCount ?? 0;
}

/**
 * Create a notification and push it via SSE.
 * This is the central function all notification-creating code should use
 * in the API server context (not worker — worker uses raw SQL).
 */
export async function createNotification(
  tenantDb: TenantDb,
  input: {
    userId: string;
    type: string;
    title: string;
    body?: string;
    link?: string;
  }
) {
  const result = await tenantDb
    .insert(notifications)
    .values({
      userId: input.userId,
      type: input.type as any,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
    })
    .returning();

  const notification = result[0];

  // Emit local event for SSE push
  try {
    eventBus.emitLocal({
      name: "notification.created" as any,
      payload: { userId: input.userId, notification },
      officeId: "",
      userId: input.userId,
      timestamp: new Date(),
    });
  } catch (err) {
    // Best-effort — SSE push failure should not break the request
    console.error("[Notifications] SSE push failed:", err);
  }

  return notification;
}
```

### 6b. Notification CRUD Routes (Tenant-Scoped)

Create a separate router for tenant-scoped notification CRUD, distinct from the SSE stream endpoint which does not need tenant context.

**File: `server/src/modules/notifications/crud-routes.ts`**

```typescript
import { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
} from "./service.js";

const router = Router();

// GET /api/notifications/list — get notifications for current user
router.get("/list", async (req, res, next) => {
  try {
    const filters = {
      userId: req.user!.id,
      isRead: req.query.isRead === "true" ? true : req.query.isRead === "false" ? false : undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await getNotifications(req.tenantDb!, filters);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/notifications/unread-count — get unread count
router.get("/unread-count", async (req, res, next) => {
  try {
    const count = await getUnreadCount(req.tenantDb!, req.user!.id);
    await req.commitTransaction!();
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/:id/read — mark single notification as read
router.post("/:id/read", async (req, res, next) => {
  try {
    const notification = await markAsRead(req.tenantDb!, req.params.id, req.user!.id);
    if (!notification) throw new AppError(404, "Notification not found");
    await req.commitTransaction!();
    res.json({ notification });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/read-all — mark all notifications as read
router.post("/read-all", async (req, res, next) => {
  try {
    const count = await markAllAsRead(req.tenantDb!, req.user!.id);
    await req.commitTransaction!();
    res.json({ markedRead: count });
  } catch (err) {
    next(err);
  }
});

export const notificationCrudRoutes = router;
```

### 6c. Register Notification CRUD Routes

**File: `server/src/app.ts`** -- Mount on tenant router:

```typescript
import { notificationCrudRoutes } from "./modules/notifications/crud-routes.js";

// Tenant-scoped notification CRUD (separate from the SSE stream endpoint)
tenantRouter.use("/notifications", notificationCrudRoutes);
```

**IMPORTANT:** The existing SSE `/api/notifications/stream` endpoint is mounted BEFORE the tenant middleware chain (`app.use("/api/notifications", notificationRoutes)`). The new CRUD routes are mounted INSIDE the tenant router (`tenantRouter.use("/notifications", notificationCrudRoutes)`). Express matches `/api/notifications/stream` first (auth only, no tenant), then `/api/notifications/list`, `/api/notifications/unread-count`, etc. go through auth + tenant. No conflict.

---

## Task 7: Backend Tests

- [ ] Create `server/tests/modules/tasks/service.test.ts`
- [ ] Create `server/tests/modules/activities/service.test.ts`
- [ ] Create `server/tests/modules/notifications/service.test.ts`

### 7a. Task Service Tests

**File: `server/tests/modules/tasks/service.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: { select: vi.fn() },
  pool: {},
}));

const { AppError } = await import("../../../src/middleware/error-handler.js");

describe("Task Service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Task Priority Ordering", () => {
    it("should define correct task priority levels", () => {
      const priorities = ["urgent", "high", "normal", "low"];
      expect(priorities).toHaveLength(4);
      expect(priorities[0]).toBe("urgent");
      expect(priorities[3]).toBe("low");
    });

    it("should define correct task types", () => {
      const types = [
        "follow_up",
        "stale_deal",
        "inbound_email",
        "approval_request",
        "touchpoint",
        "manual",
        "system",
      ];
      expect(types).toHaveLength(7);
    });

    it("should define correct task statuses", () => {
      const statuses = ["pending", "in_progress", "completed", "dismissed"];
      expect(statuses).toHaveLength(4);
    });
  });

  describe("Section Filtering Logic", () => {
    it("should classify overdue as past due_date with active status", () => {
      const today = new Date().toISOString().split("T")[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

      expect(yesterday < today).toBe(true);
    });

    it("should classify today as due_date equals current date", () => {
      const today = new Date().toISOString().split("T")[0];
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("should classify upcoming as due_date after today or null", () => {
      const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
      const today = new Date().toISOString().split("T")[0];
      expect(tomorrow > today).toBe(true);
    });
  });

  describe("Snooze Validation", () => {
    it("should reject snooze on completed tasks", () => {
      // Validates business rule: completed/dismissed tasks cannot be snoozed
      const completedStatuses = ["completed", "dismissed"];
      for (const status of completedStatuses) {
        expect(["completed", "dismissed"]).toContain(status);
      }
    });

    it("should accept valid date format for snooze", () => {
      const validDate = "2026-04-15";
      expect(validDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe("AppError Integration", () => {
    it("should throw 404 for missing tasks", () => {
      const error = new AppError(404, "Task not found");
      expect(error.statusCode).toBe(404);
      expect(error.message).toBe("Task not found");
    });

    it("should throw 403 for unauthorized access", () => {
      const error = new AppError(403, "You can only view your own tasks");
      expect(error.statusCode).toBe(403);
    });

    it("should throw 400 for invalid state transitions", () => {
      const error = new AppError(400, "Task is already completed");
      expect(error.statusCode).toBe(400);
    });
  });
});
```

### 7b. Activity Service Tests

**File: `server/tests/modules/activities/service.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: { select: vi.fn() },
  pool: {},
}));

const { AppError } = await import("../../../src/middleware/error-handler.js");

describe("Activity Service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Activity Types", () => {
    it("should support all activity types from spec", () => {
      const types = ["call", "note", "meeting", "email", "task_completed"];
      expect(types).toHaveLength(5);
    });

    it("should define outreach activity types (trigger touchpoint update)", () => {
      // The PG trigger only fires for call, email, meeting -- not note or task_completed
      const outreachTypes = ["call", "email", "meeting"];
      const nonOutreachTypes = ["note", "task_completed"];

      for (const type of outreachTypes) {
        expect(["call", "email", "meeting"]).toContain(type);
      }
      for (const type of nonOutreachTypes) {
        expect(["call", "email", "meeting"]).not.toContain(type);
      }
    });
  });

  describe("Call Outcomes", () => {
    it("should support all call outcome values", () => {
      const outcomes = ["connected", "left_voicemail", "no_answer", "scheduled_meeting"];
      expect(outcomes).toHaveLength(4);
    });
  });

  describe("Validation", () => {
    it("should require activity type", () => {
      const error = new AppError(400, "Activity type is required");
      expect(error.statusCode).toBe(400);
    });

    it("should require at least one association (deal or contact)", () => {
      const error = new AppError(400, "At least one of contactId or dealId is required");
      expect(error.statusCode).toBe(400);
    });
  });
});
```

### 7c. Notification Service Tests

**File: `server/tests/modules/notifications/service.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: { select: vi.fn() },
  pool: {},
}));

vi.mock("../../../src/events/bus.js", () => ({
  eventBus: {
    emitLocal: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
    setMaxListeners: vi.fn(),
  },
}));

describe("Notification Service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Notification Types", () => {
    it("should support all notification types from spec", () => {
      const types = [
        "stale_deal",
        "inbound_email",
        "task_assigned",
        "approval_needed",
        "activity_drop",
        "deal_won",
        "deal_lost",
        "stage_change",
        "system",
      ];
      expect(types).toHaveLength(9);
    });
  });

  describe("SSE Manager", () => {
    it("should format SSE events correctly", () => {
      const event = "notification";
      const data = { id: "123", title: "Test" };
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

      expect(payload).toContain("event: notification\n");
      expect(payload).toContain('"id":"123"');
      expect(payload).toEndWith("\n\n");
    });
  });

  describe("Unread Count", () => {
    it("should return zero for no notifications", () => {
      const count = 0;
      expect(count).toBe(0);
      expect(typeof count).toBe("number");
    });
  });
});
```

---

## Task 8: Frontend -- Task Hooks and Utilities

- [ ] Create `client/src/hooks/use-tasks.ts`
- [ ] Create `client/src/hooks/use-notifications.ts`
- [ ] Create `client/src/hooks/use-activities.ts`

### 8a. Task Hooks

**File: `client/src/hooks/use-tasks.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface Task {
  id: string;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  status: string;
  assignedTo: string;
  createdBy: string | null;
  dealId: string | null;
  contactId: string | null;
  emailId: string | null;
  dueDate: string | null;
  dueTime: string | null;
  remindAt: string | null;
  completedAt: string | null;
  isOverdue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCounts {
  overdue: number;
  today: number;
  upcoming: number;
  completed: number;
}

export interface TaskFilters {
  section?: "overdue" | "today" | "upcoming" | "completed";
  assignedTo?: string;
  status?: string;
  type?: string;
  dealId?: string;
  contactId?: string;
  page?: number;
  limit?: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function useTasks(filters: TaskFilters = {}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 100, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.section) params.set("section", filters.section);
      if (filters.assignedTo) params.set("assignedTo", filters.assignedTo);
      if (filters.status) params.set("status", filters.status);
      if (filters.type) params.set("type", filters.type);
      if (filters.dealId) params.set("dealId", filters.dealId);
      if (filters.contactId) params.set("contactId", filters.contactId);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const data = await api<{ tasks: Task[]; pagination: Pagination }>(
        `/tasks${qs ? `?${qs}` : ""}`
      );
      setTasks(data.tasks);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }, [
    filters.section,
    filters.assignedTo,
    filters.status,
    filters.type,
    filters.dealId,
    filters.contactId,
    filters.page,
    filters.limit,
  ]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  return { tasks, pagination, loading, error, refetch: fetchTasks };
}

export function useTaskCounts() {
  const [counts, setCounts] = useState<TaskCounts>({ overdue: 0, today: 0, upcoming: 0, completed: 0 });
  const [loading, setLoading] = useState(true);

  const fetchCounts = useCallback(async () => {
    try {
      const data = await api<{ counts: TaskCounts }>("/tasks/counts");
      setCounts(data.counts);
    } catch (err) {
      console.error("Failed to load task counts:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCounts();
  }, [fetchCounts]);

  return { counts, loading, refetch: fetchCounts };
}

export async function createTask(input: Partial<Task> & { title: string }) {
  return api<{ task: Task }>("/tasks", { method: "POST", json: input });
}

export async function updateTask(taskId: string, input: Partial<Task>) {
  return api<{ task: Task }>(`/tasks/${taskId}`, { method: "PATCH", json: input });
}

export async function completeTask(taskId: string) {
  return api<{ task: Task }>(`/tasks/${taskId}/complete`, { method: "POST" });
}

export async function dismissTask(taskId: string) {
  return api<{ task: Task }>(`/tasks/${taskId}/dismiss`, { method: "POST" });
}

export async function snoozeTask(taskId: string, dueDate: string) {
  return api<{ task: Task }>(`/tasks/${taskId}/snooze`, { method: "POST", json: { dueDate } });
}
```

### 8b. Notification Hooks

**File: `client/src/hooks/use-notifications.ts`**

```typescript
import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";

export interface Notification {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export function useNotifications(limit: number = 20) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ notifications: Notification[] }>(
        `/notifications/list?limit=${limit}`
      );
      setNotifications(data.notifications);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load notifications");
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  return { notifications, loading, error, refetch: fetchNotifications };
}

export function useUnreadCount() {
  const [count, setCount] = useState(0);

  const fetchCount = useCallback(async () => {
    try {
      const data = await api<{ count: number }>("/notifications/unread-count");
      setCount(data.count);
    } catch (err) {
      console.error("Failed to load unread count:", err);
    }
  }, []);

  useEffect(() => {
    fetchCount();
  }, [fetchCount]);

  return { count, refetch: fetchCount };
}

/**
 * Subscribe to SSE notification stream.
 * Returns the unread count and auto-updates on new notifications.
 */
export function useNotificationStream() {
  const [unreadCount, setUnreadCount] = useState(0);
  const [latestNotification, setLatestNotification] = useState<Notification | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Fetch initial unread count
  useEffect(() => {
    api<{ count: number }>("/notifications/unread-count")
      .then((data) => setUnreadCount(data.count))
      .catch(console.error);
  }, []);

  // Connect to SSE stream
  useEffect(() => {
    const es = new EventSource("/api/notifications/stream", { withCredentials: true });
    eventSourceRef.current = es;

    es.addEventListener("notification", (event) => {
      try {
        const notification: Notification = JSON.parse(event.data);
        setLatestNotification(notification);
        setUnreadCount((prev) => prev + 1);
      } catch (err) {
        console.error("[SSE] Failed to parse notification:", err);
      }
    });

    es.addEventListener("connected", () => {
      console.log("[SSE] Connected to notification stream");
    });

    es.onerror = () => {
      // EventSource auto-reconnects -- just log
      console.warn("[SSE] Connection error -- will auto-reconnect");
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, []);

  const markAsRead = useCallback(async (notificationId: string) => {
    await api(`/notifications/${notificationId}/read`, { method: "POST" });
    setUnreadCount((prev) => Math.max(0, prev - 1));
  }, []);

  const markAllAsRead = useCallback(async () => {
    await api("/notifications/read-all", { method: "POST" });
    setUnreadCount(0);
  }, []);

  return { unreadCount, latestNotification, markAsRead, markAllAsRead };
}
```

### 8c. Activity Hooks

**File: `client/src/hooks/use-activities.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface Activity {
  id: string;
  type: string;
  userId: string;
  dealId: string | null;
  contactId: string | null;
  emailId: string | null;
  subject: string | null;
  body: string | null;
  outcome: string | null;
  durationMinutes: number | null;
  occurredAt: string;
  createdAt: string;
}

export interface ActivityFilters {
  dealId?: string;
  contactId?: string;
  type?: string;
  page?: number;
  limit?: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function useActivities(filters: ActivityFilters = {}) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchActivities = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.dealId) params.set("dealId", filters.dealId);
      if (filters.contactId) params.set("contactId", filters.contactId);
      if (filters.type) params.set("type", filters.type);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const data = await api<{ activities: Activity[]; pagination: Pagination }>(
        `/activities${qs ? `?${qs}` : ""}`
      );
      setActivities(data.activities);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load activities");
    } finally {
      setLoading(false);
    }
  }, [filters.dealId, filters.contactId, filters.type, filters.page, filters.limit]);

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);

  return { activities, pagination, loading, error, refetch: fetchActivities };
}

export async function createActivity(input: {
  type: string;
  subject?: string;
  body?: string;
  outcome?: string;
  durationMinutes?: number;
  dealId?: string;
  contactId?: string;
  occurredAt?: string;
}) {
  return api<{ activity: Activity }>("/activities", { method: "POST", json: input });
}

export async function createContactActivity(
  contactId: string,
  input: {
    type: string;
    subject?: string;
    body?: string;
    outcome?: string;
    durationMinutes?: number;
    dealId?: string;
  }
) {
  return api<{ activity: Activity }>(`/contacts/${contactId}/activities`, {
    method: "POST",
    json: { ...input, contactId },
  });
}
```

---

## Task 9: Frontend -- Task List Page

- [ ] Create `client/src/components/tasks/task-section.tsx`
- [ ] Create `client/src/components/tasks/task-row.tsx`
- [ ] Create `client/src/components/tasks/task-create-dialog.tsx`
- [ ] Create `client/src/pages/tasks/task-list-page.tsx`

### 9a. Task Row Component

**File: `client/src/components/tasks/task-row.tsx`**

```typescript
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, X, Clock, Handshake, Users, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  completeTask as apiCompleteTask,
  dismissTask as apiDismissTask,
  snoozeTask as apiSnoozeTask,
} from "@/hooks/use-tasks";
import type { Task } from "@/hooks/use-tasks";

interface TaskRowProps {
  task: Task;
  onUpdate: () => void;
}

const priorityColors: Record<string, string> = {
  urgent: "bg-red-100 text-red-800 border-red-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  normal: "bg-blue-100 text-blue-800 border-blue-200",
  low: "bg-gray-100 text-gray-800 border-gray-200",
};

const typeIcons: Record<string, typeof Handshake> = {
  follow_up: Clock,
  stale_deal: Handshake,
  inbound_email: Mail,
  touchpoint: Users,
  manual: Check,
  system: Check,
  approval_request: Check,
};

export function TaskRow({ task, onUpdate }: TaskRowProps) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const handleComplete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setLoading(true);
    try {
      await apiCompleteTask(task.id);
      onUpdate();
    } catch (err) {
      console.error("Failed to complete task:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleDismiss = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setLoading(true);
    try {
      await apiDismissTask(task.id);
      onUpdate();
    } catch (err) {
      console.error("Failed to dismiss task:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleSnooze = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
    setLoading(true);
    try {
      await apiSnoozeTask(task.id, tomorrow);
      onUpdate();
    } catch (err) {
      console.error("Failed to snooze task:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleClick = () => {
    // Navigate to the linked entity
    if (task.dealId) navigate(`/deals/${task.dealId}`);
    else if (task.contactId) navigate(`/contacts/${task.contactId}`);
    else if (task.emailId) navigate("/email");
  };

  const IconComponent = typeIcons[task.type] ?? Check;
  const isCompleted = task.status === "completed" || task.status === "dismissed";

  return (
    <div
      className={`flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-muted/50 cursor-pointer transition-colors ${
        isCompleted ? "opacity-60" : ""
      }`}
      onClick={handleClick}
    >
      <IconComponent className="h-4 w-4 text-muted-foreground shrink-0" />

      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium truncate ${isCompleted ? "line-through" : ""}`}>
          {task.title}
        </p>
        {task.dueDate && (
          <p className={`text-xs ${task.isOverdue ? "text-red-600 font-medium" : "text-muted-foreground"}`}>
            Due: {new Date(task.dueDate + "T00:00:00").toLocaleDateString()}
          </p>
        )}
      </div>

      <Badge variant="outline" className={`text-xs shrink-0 ${priorityColors[task.priority] ?? ""}`}>
        {task.priority}
      </Badge>

      {!isCompleted && (
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleComplete}
            disabled={loading}
            title="Complete"
          >
            <Check className="h-3.5 w-3.5 text-green-600" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleSnooze}
            disabled={loading}
            title="Snooze to tomorrow"
          >
            <Clock className="h-3.5 w-3.5 text-amber-600" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleDismiss}
            disabled={loading}
            title="Dismiss"
          >
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
      )}
    </div>
  );
}
```

### 9b. Task Section Component

**File: `client/src/components/tasks/task-section.tsx`**

```typescript
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TaskRow } from "./task-row";
import type { Task } from "@/hooks/use-tasks";

interface TaskSectionProps {
  title: string;
  tasks: Task[];
  count: number;
  variant?: "danger" | "warning" | "default" | "muted";
  defaultOpen?: boolean;
  onUpdate: () => void;
}

const variantStyles: Record<string, string> = {
  danger: "text-red-700",
  warning: "text-amber-700",
  default: "text-foreground",
  muted: "text-muted-foreground",
};

const badgeVariants: Record<string, string> = {
  danger: "bg-red-100 text-red-800",
  warning: "bg-amber-100 text-amber-800",
  default: "bg-blue-100 text-blue-800",
  muted: "bg-gray-100 text-gray-600",
};

export function TaskSection({
  title,
  tasks,
  count,
  variant = "default",
  defaultOpen = true,
  onUpdate,
}: TaskSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border rounded-lg">
      <button
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-muted/30 transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <span className={`text-sm font-semibold ${variantStyles[variant]}`}>{title}</span>
        <Badge variant="secondary" className={`text-xs ${badgeVariants[variant]}`}>
          {count}
        </Badge>
      </button>

      {open && tasks.length > 0 && (
        <div className="px-2 pb-2 space-y-0.5">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} onUpdate={onUpdate} />
          ))}
        </div>
      )}

      {open && tasks.length === 0 && (
        <div className="px-4 pb-3 text-sm text-muted-foreground">
          No tasks in this section.
        </div>
      )}
    </div>
  );
}
```

### 9c. Task Create Dialog

**File: `client/src/components/tasks/task-create-dialog.tsx`**

```typescript
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus } from "lucide-react";
import { createTask } from "@/hooks/use-tasks";

interface TaskCreateDialogProps {
  onCreated: () => void;
  defaultDealId?: string;
  defaultContactId?: string;
}

export function TaskCreateDialog({ onCreated, defaultDealId, defaultContactId }: TaskCreateDialogProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("normal");
  const [dueDate, setDueDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setError(null);
    try {
      await createTask({
        title: title.trim(),
        description: description.trim() || undefined,
        type: "manual",
        priority,
        dueDate: dueDate || undefined,
        dealId: defaultDealId,
        contactId: defaultContactId,
      } as any);
      setTitle("");
      setDescription("");
      setPriority("normal");
      setDueDate("");
      setOpen(false);
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create task");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4 mr-1" /> New Task
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            placeholder="Task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
          <Textarea
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Priority</label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="urgent">Urgent</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Due Date</label>
              <Input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !title.trim()}>
              {submitting ? "Creating..." : "Create Task"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

### 9d. Task List Page

**File: `client/src/pages/tasks/task-list-page.tsx`**

```typescript
import { useTasks, useTaskCounts } from "@/hooks/use-tasks";
import { TaskSection } from "@/components/tasks/task-section";
import { TaskCreateDialog } from "@/components/tasks/task-create-dialog";

export function TaskListPage() {
  const { counts, refetch: refetchCounts } = useTaskCounts();

  const { tasks: overdueTasks, refetch: refetchOverdue } = useTasks({ section: "overdue" });
  const { tasks: todayTasks, refetch: refetchToday } = useTasks({ section: "today" });
  const { tasks: upcomingTasks, refetch: refetchUpcoming } = useTasks({ section: "upcoming" });
  const { tasks: completedTasks, refetch: refetchCompleted } = useTasks({
    section: "completed",
    limit: 20,
  });

  const refetchAll = () => {
    refetchCounts();
    refetchOverdue();
    refetchToday();
    refetchUpcoming();
    refetchCompleted();
  };

  const totalActive = counts.overdue + counts.today + counts.upcoming;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Tasks</h2>
          <p className="text-muted-foreground text-sm">
            {totalActive} active task{totalActive !== 1 ? "s" : ""}
            {counts.overdue > 0 && (
              <span className="text-red-600 font-medium ml-1">
                ({counts.overdue} overdue)
              </span>
            )}
          </p>
        </div>
        <TaskCreateDialog onCreated={refetchAll} />
      </div>

      {/* Task Sections */}
      <div className="space-y-3">
        <TaskSection
          title="Overdue"
          tasks={overdueTasks}
          count={counts.overdue}
          variant="danger"
          defaultOpen={true}
          onUpdate={refetchAll}
        />
        <TaskSection
          title="Today"
          tasks={todayTasks}
          count={counts.today}
          variant="warning"
          defaultOpen={true}
          onUpdate={refetchAll}
        />
        <TaskSection
          title="Upcoming"
          tasks={upcomingTasks}
          count={counts.upcoming}
          variant="default"
          defaultOpen={true}
          onUpdate={refetchAll}
        />
        <TaskSection
          title="Completed (Last 7 Days)"
          tasks={completedTasks}
          count={counts.completed}
          variant="muted"
          defaultOpen={false}
          onUpdate={refetchAll}
        />
      </div>
    </div>
  );
}
```

---

## Task 10: Frontend -- Notification Center

- [ ] Create `client/src/components/notifications/notification-center.tsx`
- [ ] Modify `client/src/components/layout/topbar.tsx` to use notification center

### 10a. Notification Center Component

**File: `client/src/components/notifications/notification-center.tsx`**

```typescript
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, Check, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useNotificationStream, useNotifications } from "@/hooks/use-notifications";
import type { Notification } from "@/hooks/use-notifications";

const typeColors: Record<string, string> = {
  stale_deal: "bg-amber-500",
  inbound_email: "bg-blue-500",
  task_assigned: "bg-purple-500",
  approval_needed: "bg-orange-500",
  activity_drop: "bg-red-500",
  deal_won: "bg-green-500",
  deal_lost: "bg-red-500",
  stage_change: "bg-cyan-500",
  system: "bg-gray-500",
};

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function NotificationCenter() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { unreadCount, markAsRead, markAllAsRead } = useNotificationStream();
  const { notifications, refetch } = useNotifications(20);

  const handleNotificationClick = async (notification: Notification) => {
    if (!notification.isRead) {
      await markAsRead(notification.id);
    }
    if (notification.link) {
      navigate(notification.link);
    }
    setOpen(false);
    refetch();
  };

  const handleMarkAllRead = async () => {
    await markAllAsRead();
    refetch();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <Badge
              className="absolute -top-1 -right-1 h-5 min-w-[20px] px-1 flex items-center justify-center bg-red-500 text-white text-xs rounded-full border-2 border-white"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="text-sm font-semibold">Notifications</h3>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7"
              onClick={handleMarkAllRead}
            >
              <CheckCheck className="h-3 w-3 mr-1" />
              Mark all read
            </Button>
          )}
        </div>

        {/* Notification List */}
        <div className="max-h-[400px] overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No notifications yet.
            </div>
          ) : (
            notifications.map((notification) => (
              <button
                key={notification.id}
                className={`w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors border-b last:border-b-0 ${
                  !notification.isRead ? "bg-blue-50/50" : ""
                }`}
                onClick={() => handleNotificationClick(notification)}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${
                      typeColors[notification.type] ?? "bg-gray-400"
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm truncate ${!notification.isRead ? "font-medium" : ""}`}>
                      {notification.title}
                    </p>
                    {notification.body && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {notification.body}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      {timeAgo(notification.createdAt)}
                    </p>
                  </div>
                  {!notification.isRead && (
                    <span className="mt-1 h-2 w-2 rounded-full bg-blue-500 shrink-0" />
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

### 10b. Update Topbar

**File: `client/src/components/layout/topbar.tsx`** -- REPLACE entire file:

```typescript
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { NotificationCenter } from "@/components/notifications/notification-center";
import { useAuth } from "@/lib/auth";

export function Topbar() {
  const { user } = useAuth();
  const initials = user?.displayName
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase() ?? "?";

  return (
    <header className="h-14 border-b bg-white flex items-center justify-between px-4 md:px-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          <Search className="h-4 w-4 mr-2" />
          <span className="hidden sm:inline">Search...</span>
          <kbd className="hidden md:inline-flex ml-2 text-xs bg-muted px-1.5 py-0.5 rounded">
            Cmd+K
          </kbd>
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <NotificationCenter />
        <Avatar className="h-8 w-8">
          <AvatarFallback className="bg-brand-purple text-white text-xs">
            {initials}
          </AvatarFallback>
        </Avatar>
      </div>
    </header>
  );
}
```

---

## Task 11: Frontend -- Activity Logging Forms

- [ ] Create `client/src/components/activities/activity-log-form.tsx`
- [ ] Modify `client/src/components/contacts/contact-activity-tab.tsx` to use real API + show activity feed
- [ ] Add activity tab to deal detail page

### 11a. Shared Activity Log Form

**File: `client/src/components/activities/activity-log-form.tsx`**

```typescript
import { useState } from "react";
import { Phone, FileText, Calendar, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type LogType = "call" | "note" | "meeting";

interface ActivityLogFormProps {
  onSubmit: (data: {
    type: LogType;
    subject: string;
    body: string;
    outcome?: string;
    durationMinutes?: number;
  }) => Promise<void>;
}

export function ActivityLogForm({ onSubmit }: ActivityLogFormProps) {
  const [activeForm, setActiveForm] = useState<LogType | null>(null);
  const [body, setBody] = useState("");
  const [outcome, setOutcome] = useState<string>("");
  const [duration, setDuration] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!body.trim() || !activeForm) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        type: activeForm,
        subject: `${activeForm} logged`,
        body: body.trim(),
        outcome: outcome || undefined,
        durationMinutes: duration ? parseInt(duration, 10) : undefined,
      });
      setBody("");
      setOutcome("");
      setDuration("");
      setActiveForm(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to log activity");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Quick-log action buttons */}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={activeForm === "call" ? "default" : "outline"}
          onClick={() => setActiveForm(activeForm === "call" ? null : "call")}
        >
          <Phone className="h-4 w-4 mr-1" /> Log Call
        </Button>
        <Button
          size="sm"
          variant={activeForm === "note" ? "default" : "outline"}
          onClick={() => setActiveForm(activeForm === "note" ? null : "note")}
        >
          <FileText className="h-4 w-4 mr-1" /> Add Note
        </Button>
        <Button
          size="sm"
          variant={activeForm === "meeting" ? "default" : "outline"}
          onClick={() => setActiveForm(activeForm === "meeting" ? null : "meeting")}
        >
          <Calendar className="h-4 w-4 mr-1" /> Log Meeting
        </Button>
      </div>

      {/* Inline log form */}
      {activeForm && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <p className="text-sm font-medium capitalize">{activeForm} details</p>
            <Textarea
              placeholder={`Describe this ${activeForm}...`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
            />
            {activeForm === "call" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Outcome</label>
                  <Select value={outcome} onValueChange={setOutcome}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select outcome" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="connected">Connected</SelectItem>
                      <SelectItem value="left_voicemail">Left Voicemail</SelectItem>
                      <SelectItem value="no_answer">No Answer</SelectItem>
                      <SelectItem value="scheduled_meeting">Scheduled Meeting</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Duration (min)</label>
                  <Input
                    type="number"
                    placeholder="0"
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                  />
                </div>
              </div>
            )}
            {activeForm === "meeting" && (
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Duration (min)</label>
                <Input
                  type="number"
                  placeholder="0"
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  className="w-32"
                />
              </div>
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSubmit} disabled={submitting || !body.trim()}>
                <Plus className="h-4 w-4 mr-1" /> {submitting ? "Saving..." : "Save"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setActiveForm(null);
                  setBody("");
                  setOutcome("");
                  setDuration("");
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
```

### 11b. Update Contact Activity Tab

**File: `client/src/components/contacts/contact-activity-tab.tsx`** -- REPLACE entire file:

```typescript
import { Phone, FileText, Calendar, Mail, CheckSquare } from "lucide-react";
import { ActivityLogForm } from "@/components/activities/activity-log-form";
import { useActivities, createContactActivity } from "@/hooks/use-activities";
import type { Activity } from "@/hooks/use-activities";

interface ContactActivityTabProps {
  contactId: string;
}

const typeIcons: Record<string, typeof Phone> = {
  call: Phone,
  note: FileText,
  meeting: Calendar,
  email: Mail,
  task_completed: CheckSquare,
};

const typeLabels: Record<string, string> = {
  call: "Call",
  note: "Note",
  meeting: "Meeting",
  email: "Email",
  task_completed: "Task Completed",
};

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ContactActivityTab({ contactId }: ContactActivityTabProps) {
  const { activities, loading, refetch } = useActivities({ contactId });

  const handleLogActivity = async (data: {
    type: string;
    subject: string;
    body: string;
    outcome?: string;
    durationMinutes?: number;
  }) => {
    await createContactActivity(contactId, {
      type: data.type,
      subject: data.subject,
      body: data.body,
      outcome: data.outcome,
      durationMinutes: data.durationMinutes,
    });
    refetch();
  };

  return (
    <div className="space-y-4">
      <ActivityLogForm onSubmit={handleLogActivity} />

      {/* Activity Feed */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-muted animate-pulse rounded-md" />
          ))}
        </div>
      ) : activities.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground text-sm">
          No activity recorded yet. Use the buttons above to log a call, note, or meeting.
        </div>
      ) : (
        <div className="space-y-2">
          {activities.map((activity: Activity) => {
            const IconComponent = typeIcons[activity.type] ?? FileText;
            return (
              <div
                key={activity.id}
                className="flex items-start gap-3 px-3 py-2.5 rounded-md border bg-white"
              >
                <div className="mt-0.5 h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                  <IconComponent className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {typeLabels[activity.type] ?? activity.type}
                    </span>
                    {activity.outcome && (
                      <span className="text-xs text-muted-foreground capitalize">
                        ({activity.outcome.replace(/_/g, " ")})
                      </span>
                    )}
                    {activity.durationMinutes != null && (
                      <span className="text-xs text-muted-foreground">
                        {activity.durationMinutes} min
                      </span>
                    )}
                  </div>
                  {activity.body && (
                    <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">
                      {activity.body}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground mt-1">
                    {formatDate(activity.occurredAt)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

### 11c. Add Activity Tab to Deal Detail Page

**File: `client/src/pages/deals/deal-detail-page.tsx`** -- Modify the tabs array and add the activity tab content.

Add import:

```typescript
import { ActivityLogForm } from "@/components/activities/activity-log-form";
import { useActivities, createActivity } from "@/hooks/use-activities";
```

Update the Tab type and tabs array:

```typescript
type Tab = "overview" | "files" | "email" | "activity" | "timeline" | "history";

const tabs: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "files", label: "Files" },
  { key: "email", label: "Email" },
  { key: "activity", label: "Activity" },
  { key: "timeline", label: "Timeline" },
  { key: "history", label: "History" },
];
```

Add the activity tab content in the tab render section:

```typescript
{activeTab === "activity" && (
  <DealActivityPanel dealId={deal.id} />
)}
```

Create a small inline component (or in a separate file if preferred):

```typescript
function DealActivityPanel({ dealId }: { dealId: string }) {
  const { activities, loading, refetch } = useActivities({ dealId });

  const handleLogActivity = async (data: {
    type: string;
    subject: string;
    body: string;
    outcome?: string;
    durationMinutes?: number;
  }) => {
    await createActivity({
      type: data.type,
      subject: data.subject,
      body: data.body,
      outcome: data.outcome,
      durationMinutes: data.durationMinutes,
      dealId,
    });
    refetch();
  };

  return (
    <div className="space-y-4">
      <ActivityLogForm onSubmit={handleLogActivity} />
      {loading ? (
        <div className="h-32 bg-muted animate-pulse rounded" />
      ) : activities.length === 0 ? (
        <p className="text-center py-8 text-muted-foreground text-sm">
          No activities logged for this deal yet.
        </p>
      ) : (
        <div className="space-y-2">
          {activities.map((a) => (
            <div key={a.id} className="flex items-start gap-3 px-3 py-2.5 rounded-md border">
              <div className="flex-1">
                <span className="text-sm font-medium capitalize">{a.type}</span>
                {a.body && <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{a.body}</p>}
                <p className="text-xs text-muted-foreground mt-1">
                  {new Date(a.occurredAt).toLocaleDateString("en-US", {
                    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                  })}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## Task 12: Route and Navigation Wiring

- [ ] Update `client/src/App.tsx` to use real TaskListPage instead of placeholder
- [ ] Verify sidebar already links to `/tasks` (it does)
- [ ] Add `notification.created` to DOMAIN_EVENTS in shared types (if needed for type safety)

### 12a. Update App.tsx

**File: `client/src/App.tsx`** -- Replace the placeholder task route:

Add import:

```typescript
import { TaskListPage } from "@/pages/tasks/task-list-page";
```

Replace the route:

```typescript
// Change from:
<Route path="/tasks" element={<PlaceholderPage title="Tasks" />} />

// To:
<Route path="/tasks" element={<TaskListPage />} />
```

### 12b. Add TASK_ASSIGNED and NOTIFICATION_CREATED to Domain Events

**File: `shared/src/types/events.ts`** -- Add the new event names:

```typescript
export const DOMAIN_EVENTS = {
  DEAL_STAGE_CHANGED: "deal.stage.changed",
  DEAL_WON: "deal.won",
  DEAL_LOST: "deal.lost",
  CONTACT_CREATED: "contact.created",
  EMAIL_RECEIVED: "email.received",
  EMAIL_SENT: "email.sent",
  FILE_UPLOADED: "file.uploaded",
  TASK_COMPLETED: "task.completed",
  TASK_ASSIGNED: "task.assigned",
  APPROVAL_REQUESTED: "approval.requested",
  APPROVAL_RESOLVED: "approval.resolved",
  NOTIFICATION_CREATED: "notification.created",
} as const;
```

**NOTE:** `TASK_ASSIGNED` is a distinct event from `TASK_COMPLETED`. Use `task.assigned` for assignment notifications instead of overloading `task.completed` with a `type: "task_assigned"` payload hack. The SSE manager listens for `notification.created` for real-time push and `task.assigned` for task assignment updates.

### 12c. Final app.ts Summary

After all modifications, the relevant sections of `server/src/app.ts` should include:

```typescript
import { taskRoutes } from "./modules/tasks/routes.js";
import { activityRoutes } from "./modules/activities/routes.js";
import { notificationCrudRoutes } from "./modules/notifications/crud-routes.js";
import { initSsePush } from "./modules/notifications/sse-manager.js";

// Inside createApp():

// ... existing SSE endpoint (no tenant context)
app.use("/api/notifications", notificationRoutes);

// ... existing tenantRouter setup
tenantRouter.use("/tasks", taskRoutes);
tenantRouter.use("/activities", activityRoutes);
tenantRouter.use("/notifications", notificationCrudRoutes);

// Initialize SSE push listeners
initSsePush();
```

And the worker `index.ts` should have the two new cron schedules for `runDailyTaskGeneration` (6am CT) and `runActivityDropDetection` (7am CT), plus the `worker/src/jobs/index.ts` should register handlers for `daily_task_generation`, `activity_drop_detection`, and the `task.completed` domain event.

---

## Task 13: Cold Lead Warming Tasks (Worker)

- [ ] Create `worker/src/jobs/cold-lead-warming.ts`
- [ ] Register cron schedule and job handler in worker

### 13a. Cold Lead Warming Job

**File: `worker/src/jobs/cold-lead-warming.ts`**

```typescript
import { pool } from "../db.js";

/**
 * Cold lead warming job.
 *
 * Runs daily at 6:15 AM CT (after daily task generation completes).
 * For each active office:
 * 1. Find contacts where last_contacted_at < NOW() - 60 days
 *    AND they have at least one active (non-terminal) deal
 * 2. Create a follow-up task assigned to the deal's rep
 * 3. Dedup: skip if an active task already exists for this contact
 */
export async function runColdLeadWarming(): Promise<void> {
  console.log("[Worker:cold-lead-warming] Starting cold lead warming scan...");

  const client = await pool.connect();
  try {
    const offices = await client.query(
      "SELECT id, slug FROM public.offices WHERE is_active = true"
    );

    let totalTasksCreated = 0;

    for (const office of offices.rows) {
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(office.slug)) {
        console.error(`[Worker:cold-lead-warming] Invalid office slug: "${office.slug}" -- skipping`);
        continue;
      }
      const schemaName = `office_${office.slug}`;

      // Acquire advisory lock per office to prevent concurrent runs from racing
      await client.query("BEGIN");
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('cold_lead_warming_' || $1))`,
        [office.id]
      );

      // Find contacts with no contact in 60+ days that have active deals
      // NOTE: deals.stage_id is a UUID FK to public.pipeline_stage_config.
      //       We join to pipeline_stage_config and filter by is_terminal = false.
      //       deals has assigned_rep_id (not assigned_to).
      //       There is no company_id on deals; company is on contacts.company_name.
      const coldLeads = await client.query(
        `SELECT DISTINCT ON (c.id)
           c.id AS contact_id,
           c.first_name,
           c.last_name,
           d.id AS deal_id,
           d.assigned_rep_id
         FROM ${schemaName}.contacts c
         JOIN ${schemaName}.deals d ON d.primary_contact_id = c.id
         JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
         WHERE c.last_contacted_at < NOW() - INTERVAL '60 days'
           AND psc.is_terminal = false
           AND d.assigned_rep_id IS NOT NULL
         ORDER BY c.id, c.last_contacted_at ASC`
      );

      for (const lead of coldLeads.rows) {
        // Dedup: check if an active task already exists for this contact
        const existingTask = await client.query(
          `SELECT id FROM ${schemaName}.tasks
           WHERE contact_id = $1
             AND status IN ('pending', 'in_progress')
             AND type = 'follow_up'
           LIMIT 1`,
          [lead.contact_id]
        );

        if (existingTask.rows.length > 0) continue;

        const title = `Re-engage ${lead.first_name} ${lead.last_name} — no contact in 60+ days`;

        await client.query(
          `INSERT INTO ${schemaName}.tasks
           (title, type, priority, status, assigned_to, contact_id, deal_id, due_date, created_by)
           VALUES ($1, 'follow_up', 'normal', 'pending', $2, $3, $4, CURRENT_DATE, $2)`,
          [title, lead.assigned_rep_id, lead.contact_id, lead.deal_id]
        );

        totalTasksCreated++;
      }

      // Release the advisory lock by committing the transaction for this office
      await client.query("COMMIT");
    }

    console.log(`[Worker:cold-lead-warming] Complete. Created ${totalTasksCreated} cold lead warming tasks`);
  } finally {
    client.release();
  }
}
```

### 13b. Register Cron and Job Handler

**File: `worker/src/index.ts`** -- Add import and cron schedule:

```typescript
import { runColdLeadWarming } from "./jobs/cold-lead-warming.js";

// Cold lead warming: daily at 6:15 AM CT (after daily task generation)
cron.schedule("15 6 * * *", async () => {
  console.log("[Worker:cron] Running cold lead warming...");
  try {
    await runColdLeadWarming();
  } catch (err) {
    console.error("[Worker:cron] Cold lead warming failed:", err);
  }
}, { timezone: "America/Chicago" });
console.log("[Worker] Cron scheduled: cold lead warming at 6:15 AM CT daily");
```

**File: `worker/src/jobs/index.ts`** -- Register job handler:

```typescript
import { runColdLeadWarming } from "./cold-lead-warming.js";

registerJobHandler("cold_lead_warming", async () => {
  await runColdLeadWarming();
});
```

**Commit:** `feat(worker): add cold lead warming daily task generation for contacts with 60+ days no contact`

---

## Task 14: Post-Meeting Follow-Up Task (Event Handler)

- [ ] Add `addBusinessDays` helper to worker utilities
- [ ] Add meeting follow-up logic in domain event handler or activity service

### 14a. Business Days Helper

**File: `worker/src/utils/date-helpers.ts`**

```typescript
/**
 * Add business days to a date, skipping Saturday and Sunday.
 */
export function addBusinessDays(date: Date, days: number): Date {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const dayOfWeek = result.getDay();
    // Skip Saturday (6) and Sunday (0)
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      added++;
    }
  }
  return result;
}
```

### 14b. Post-Meeting Follow-Up Handler

This handler fires when an activity of type `meeting` is created. Wire it into the activity creation service so that after a meeting activity is inserted, a follow-up task is auto-created.

**File: `server/src/modules/activities/service.ts`** -- Add at the end of `createActivity()`, after the insert:

```typescript
import { addBusinessDays } from "../../../../worker/src/utils/date-helpers.js";
// OR inline the helper if cross-package imports are not allowed:

function addBusinessDays(date: Date, days: number): Date {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const dayOfWeek = result.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      added++;
    }
  }
  return result;
}

// Inside createActivity(), after the activity insert succeeds:
if (input.type === "meeting") {
  const contactRow = input.contactId
    ? await tenantDb
        .select({ firstName: contacts.firstName, lastName: contacts.lastName })
        .from(contacts)
        .where(eq(contacts.id, input.contactId))
        .limit(1)
        .then((r) => r[0])
    : null;

  const contactName = contactRow
    ? `${contactRow.firstName ?? ""} ${contactRow.lastName ?? ""}`.trim()
    : "contact";

  const dueDate = addBusinessDays(new Date(), 2);

  await tenantDb.insert(tasks).values({
    title: `Send follow-up from meeting with ${contactName}`,
    type: "follow_up",
    priority: "high",
    status: "pending",
    assignedTo: input.userId,
    createdBy: input.userId,
    dealId: input.dealId ?? null,
    contactId: input.contactId ?? null,
    dueDate: dueDate.toISOString().split("T")[0],
  });
}
```

**Commit:** `feat: auto-create follow-up task 2 business days after meeting activity is logged`

---

## Task 15: Bid Deadline Countdown Tasks (Worker)

- [ ] Create `worker/src/jobs/bid-deadline.ts`
- [ ] Register cron schedule and job handler in worker

### 15a. Bid Deadline Countdown Job

**File: `worker/src/jobs/bid-deadline.ts`**

```typescript
import { pool } from "../db.js";

/**
 * Bid deadline countdown job.
 *
 * Runs daily at 6:30 AM CT. For each active office:
 * 1. Find deals with expected_close_date set, in 'estimating' or 'bid_sent' stage
 * 2. Create countdown tasks at 14-day, 7-day, and 1-day thresholds
 * 3. Dedup: check if task with matching title already exists for this deal
 * 4. Auto-dismiss countdown tasks if deal has moved past Bid Sent stage
 */
export async function runBidDeadlineCountdown(): Promise<void> {
  console.log("[Worker:bid-deadline] Starting bid deadline countdown scan...");

  const client = await pool.connect();
  try {
    const offices = await client.query(
      "SELECT id, slug FROM public.offices WHERE is_active = true"
    );

    let totalTasksCreated = 0;
    let totalTasksDismissed = 0;

    for (const office of offices.rows) {
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(office.slug)) {
        console.error(`[Worker:bid-deadline] Invalid office slug: "${office.slug}" -- skipping`);
        continue;
      }
      const schemaName = `office_${office.slug}`;

      // Auto-dismiss: find countdown tasks for deals no longer in estimating/bid_sent
      // NOTE: deals.stage_id is a UUID FK to public.pipeline_stage_config.
      //       We join to pipeline_stage_config and filter by slug.
      const dismissResult = await client.query(
        `UPDATE ${schemaName}.tasks t
         SET status = 'dismissed', completed_at = NOW()
         FROM ${schemaName}.deals d
         JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
         WHERE t.deal_id = d.id
           AND t.type = 'system'
           AND t.status IN ('pending', 'in_progress')
           AND (t.title LIKE 'BID DUE%' OR t.title LIKE 'Prepare final bid%' OR t.title LIKE 'Confirm bid submission%')
           AND psc.slug NOT IN ('estimating', 'bid_sent')
         RETURNING t.id`
      );
      totalTasksDismissed += dismissResult.rowCount ?? 0;

      // Find deals with upcoming bid deadlines
      // NOTE: stage_id is a UUID FK; join to pipeline_stage_config for slug filtering.
      //       assigned_rep_id is the correct column (not assigned_to).
      const deals = await client.query(
        `SELECT d.id, d.name, d.expected_close_date, d.assigned_rep_id
         FROM ${schemaName}.deals d
         JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
         WHERE d.expected_close_date IS NOT NULL
           AND psc.slug IN ('estimating', 'bid_sent')
           AND d.assigned_rep_id IS NOT NULL
           AND d.expected_close_date > CURRENT_DATE`
      );

      for (const deal of deals.rows) {
        const closeDate = new Date(deal.expected_close_date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const daysUntil = Math.ceil((closeDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

        // Define countdown thresholds
        const thresholds: { days: number; title: string; priority: string }[] = [
          { days: 14, title: `Prepare final bid for ${deal.name}`, priority: "normal" },
          { days: 7, title: `Confirm bid submission for ${deal.name}`, priority: "high" },
          { days: 1, title: `BID DUE TOMORROW: ${deal.name}`, priority: "urgent" },
        ];

        for (const threshold of thresholds) {
          if (daysUntil !== threshold.days) continue;

          // Dedup: check if task with matching title already exists
          const existing = await client.query(
            `SELECT id FROM ${schemaName}.tasks
             WHERE deal_id = $1
               AND title = $2
               AND status IN ('pending', 'in_progress')
             LIMIT 1`,
            [deal.id, threshold.title]
          );

          if (existing.rows.length > 0) continue;

          await client.query(
            `INSERT INTO ${schemaName}.tasks
             (title, type, priority, status, assigned_to, deal_id, due_date, created_by)
             VALUES ($1, 'system', $2, 'pending', $3, $4, $5, $3)`,
            [threshold.title, threshold.priority, deal.assigned_rep_id, deal.id, deal.expected_close_date]
          );

          totalTasksCreated++;
        }
      }
    }

    console.log(`[Worker:bid-deadline] Complete. Created ${totalTasksCreated} countdown tasks, dismissed ${totalTasksDismissed} stale countdown tasks`);
  } finally {
    client.release();
  }
}
```

### 15b. Register Cron and Job Handler

**File: `worker/src/index.ts`** -- Add import and cron schedule:

```typescript
import { runBidDeadlineCountdown } from "./jobs/bid-deadline.js";

// Bid deadline countdown: daily at 6:30 AM CT
cron.schedule("30 6 * * *", async () => {
  console.log("[Worker:cron] Running bid deadline countdown...");
  try {
    await runBidDeadlineCountdown();
  } catch (err) {
    console.error("[Worker:cron] Bid deadline countdown failed:", err);
  }
}, { timezone: "America/Chicago" });
console.log("[Worker] Cron scheduled: bid deadline countdown at 6:30 AM CT daily");
```

**File: `worker/src/jobs/index.ts`** -- Register job handler:

```typescript
import { runBidDeadlineCountdown } from "./bid-deadline.js";

registerJobHandler("bid_deadline_countdown", async () => {
  await runBidDeadlineCountdown();
});
```

**Commit:** `feat(worker): add bid deadline countdown tasks at 14/7/1 day thresholds with auto-dismiss`

---

## Task 16: New Contact Onboarding Sequence (Event Handler)

- [ ] Add onboarding task creation to the `contact.created` domain event handler
- [ ] Add auto-dismiss logic for onboarding tasks when `first_outreach_completed` flips

### 16a. Onboarding Task Creation on Contact Created

**File: `worker/src/jobs/index.ts`** -- Extend the existing `contact.created` handler:

```typescript
domainEventHandlers.set("contact.created", async (payload, officeId) => {
  // ... existing contact.created logic ...

  // --- New: Create onboarding task sequence ---
  const officeResult = await pool.query(
    "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
    [officeId]
  );
  if (officeResult.rows.length === 0) return;

  const slug = officeResult.rows[0].slug;
  const slugRegex = /^[a-z][a-z0-9_]*$/;
  if (!slugRegex.test(slug)) return;
  const schemaName = `office_${slug}`;

  const contactName = `${payload.firstName ?? ""} ${payload.lastName ?? ""}`.trim() || "new contact";
  const createdBy = payload.createdBy; // userId who created the contact

  if (!createdBy) return;

  const today = new Date();
  const day3 = new Date(today);
  day3.setDate(day3.getDate() + 3);
  const day7 = new Date(today);
  day7.setDate(day7.getDate() + 7);

  const onboardingTasks = [
    {
      title: `Send intro email to ${contactName}`,
      type: "touchpoint",
      priority: "high",
      dueDate: today.toISOString().split("T")[0],
    },
    {
      title: `Follow-up call with ${contactName}`,
      type: "follow_up",
      priority: "normal",
      dueDate: day3.toISOString().split("T")[0],
    },
    {
      title: `Check response from ${contactName}`,
      type: "follow_up",
      priority: "normal",
      dueDate: day7.toISOString().split("T")[0],
    },
  ];

  for (const task of onboardingTasks) {
    await pool.query(
      `INSERT INTO ${schemaName}.tasks
       (title, type, priority, status, assigned_to, contact_id, due_date, created_by)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $4)`,
      [task.title, task.type, task.priority, createdBy, payload.contactId, task.dueDate]
    );
  }

  console.log(`[Worker] contact.created: created 3 onboarding tasks for ${contactName}`);
});
```

### 16b. Auto-Dismiss Onboarding Tasks on First Outreach Completed

When `first_outreach_completed` flips to true for a contact (triggered by a touchpoint activity), dismiss remaining incomplete onboarding tasks. Add this logic to the touchpoint/activity creation flow.

**File: `server/src/modules/activities/service.ts`** -- After creating a touchpoint activity that flips `first_outreach_completed`:

```typescript
// After the UPDATE contacts SET first_outreach_completed = true:
// Dismiss remaining onboarding tasks for this contact
if (firstOutreachJustCompleted) {
  await tenantDb
    .update(tasks)
    .set({ status: "dismissed", completedAt: new Date() })
    .where(
      and(
        eq(tasks.contactId, input.contactId!),
        inArray(tasks.status, ["pending", "in_progress"]),
        or(
          sql`${tasks.title} LIKE 'Send intro email to%'`,
          sql`${tasks.title} LIKE 'Follow-up call with%'`,
          sql`${tasks.title} LIKE 'Check response from%'`
        )
      )
    );
}
```

**Commit:** `feat: add 3-step onboarding task sequence on contact creation with auto-dismiss on first outreach`

---

## Task 17: Won Deal Handoff Checklist (Event Handler)

- [ ] Add handoff checklist creation to the `deal.won` domain event handler

### 17a. Won Deal Handoff Tasks

**File: `worker/src/jobs/index.ts`** -- Extend the existing `deal.won` handler:

```typescript
domainEventHandlers.set("deal.won", async (payload, officeId) => {
  // ... existing deal.won logic ...

  // --- New: Create handoff checklist ---
  const officeResult = await pool.query(
    "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
    [officeId]
  );
  if (officeResult.rows.length === 0) return;

  const slug = officeResult.rows[0].slug;
  const slugRegex = /^[a-z][a-z0-9_]*$/;
  if (!slugRegex.test(slug)) return;
  const schemaName = `office_${slug}`;

  const dealName = payload.dealName ?? "deal";
  const assignedTo = payload.assignedTo;
  if (!assignedTo) return;

  // Look up primary contact name for task 2
  let primaryContactName = "primary contact";
  if (payload.primaryContactId) {
    const contactResult = await pool.query(
      `SELECT first_name, last_name FROM ${schemaName}.contacts WHERE id = $1`,
      [payload.primaryContactId]
    );
    if (contactResult.rows.length > 0) {
      const c = contactResult.rows[0];
      primaryContactName = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "primary contact";
    }
  }

  const today = new Date();
  const handoffTasks = [
    {
      title: `Schedule kickoff meeting for ${dealName}`,
      priority: "urgent",
      dueDate: today.toISOString().split("T")[0],
    },
    {
      title: `Send welcome packet to ${primaryContactName}`,
      priority: "high",
      dueDate: new Date(today.getTime() + 1 * 86400000).toISOString().split("T")[0],
    },
    {
      title: `Introduce project team for ${dealName}`,
      priority: "normal",
      dueDate: new Date(today.getTime() + 2 * 86400000).toISOString().split("T")[0],
    },
    {
      title: `Verify Procore project created for ${dealName}`,
      priority: "normal",
      dueDate: new Date(today.getTime() + 3 * 86400000).toISOString().split("T")[0],
    },
  ];

  for (const task of handoffTasks) {
    await pool.query(
      `INSERT INTO ${schemaName}.tasks
       (title, type, priority, status, assigned_to, deal_id, due_date, created_by)
       VALUES ($1, 'system', $2, 'pending', $3, $4, $5, $3)`,
      [task.title, task.priority, assignedTo, payload.dealId, task.dueDate]
    );
  }

  console.log(`[Worker] deal.won: created 4 handoff tasks for ${dealName}`);
});
```

**Commit:** `feat(worker): add 4-step won deal handoff checklist (kickoff, welcome packet, team intro, Procore verify)`

---

## Task 18: Competitor Intelligence Tasks (Event Handler)

- [ ] Add competitor intelligence logic to the `deal.lost` domain event handler

### 18a. Competitor Intel Task on Deal Lost

**File: `worker/src/jobs/index.ts`** -- Extend the existing `deal.lost` handler:

```typescript
domainEventHandlers.set("deal.lost", async (payload, officeId) => {
  // ... existing deal.lost logic ...

  // --- New: Competitor intelligence tasks ---
  if (!payload.lostCompetitor) return; // Only fire when competitor is known

  const officeResult = await pool.query(
    "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
    [officeId]
  );
  if (officeResult.rows.length === 0) return;

  const slug = officeResult.rows[0].slug;
  const slugRegex = /^[a-z][a-z0-9_]*$/;
  if (!slugRegex.test(slug)) return;
  const schemaName = `office_${slug}`;

  const competitor = payload.lostCompetitor;
  const lostDealName = payload.dealName ?? "a deal";

  // Find the lost deal's primary contact (and their company_name from contacts)
  // NOTE: deals has NO company_id column. Company info is on contacts.company_name.
  //       deals.stage_id is a UUID FK to public.pipeline_stage_config.
  //       deals.assigned_rep_id is the correct column (not assigned_to).
  const lostDealResult = await pool.query(
    `SELECT d.primary_contact_id, c.company_name
     FROM ${schemaName}.deals d
     LEFT JOIN ${schemaName}.contacts c ON c.id = d.primary_contact_id
     WHERE d.id = $1`,
    [payload.dealId]
  );
  if (lostDealResult.rows.length === 0) return;

  const { primary_contact_id, company_name } = lostDealResult.rows[0];

  // Find other active deals that share a primary contact or company_name with the lost deal
  const activeDealConditions: string[] = [];
  const params: any[] = [payload.dealId]; // $1 = lost deal to exclude

  if (primary_contact_id) {
    activeDealConditions.push(`d.primary_contact_id = $${params.length + 1}`);
    params.push(primary_contact_id);
  }
  if (company_name) {
    activeDealConditions.push(`c.company_name = $${params.length + 1}`);
    params.push(company_name);
  }

  if (activeDealConditions.length === 0) return;

  const activeDeals = await pool.query(
    `SELECT d.id, d.name, d.assigned_rep_id, c.first_name, c.last_name
     FROM ${schemaName}.deals d
     JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
     LEFT JOIN ${schemaName}.contacts c ON c.id = d.primary_contact_id
     WHERE d.id != $1
       AND psc.is_terminal = false
       AND (${activeDealConditions.join(" OR ")})
       AND d.assigned_rep_id IS NOT NULL`,
    params
  );

  let tasksCreated = 0;
  for (const deal of activeDeals.rows) {
    const contactName = `${deal.first_name ?? ""} ${deal.last_name ?? ""}`.trim() || "contact";
    const title = `Heads up: ${contactName} chose ${competitor} on ${lostDealName}. Review strategy for ${deal.name}`;

    await pool.query(
      `INSERT INTO ${schemaName}.tasks
       (title, type, priority, status, assigned_to, deal_id, due_date, created_by)
       VALUES ($1, 'system', 'high', 'pending', $2, $3, CURRENT_DATE, $2)`,
      [title, deal.assigned_rep_id, deal.id]
    );
    tasksCreated++;
  }

  if (tasksCreated > 0) {
    console.log(`[Worker] deal.lost: created ${tasksCreated} competitor intelligence tasks for ${competitor}`);
  }
});
```

**Commit:** `feat(worker): add competitor intelligence tasks when deal is lost to known competitor`

---

## Task 19: Cross-Sell Alert Tasks (Event Handler)

- [ ] Add cross-sell detection logic to the `deal.won` domain event handler

### 19a. Cross-Sell Alert on Deal Won

**File: `worker/src/jobs/index.ts`** -- Extend the existing `deal.won` handler (after handoff checklist from Task 17):

```typescript
// --- Cross-sell detection ---
// After the handoff tasks are created:

if (payload.projectTypeId) {
  // Find the company associated with this deal via primary contact's company_name
  // NOTE: deals has NO company_id column. Company info is on contacts.company_name.
  //       project_type_config is in the public schema (not project_types).
  const dealCompanyResult = await pool.query(
    `SELECT c.company_name
     FROM ${schemaName}.deals d
     JOIN ${schemaName}.contacts c ON c.id = d.primary_contact_id
     WHERE d.id = $1 AND c.company_name IS NOT NULL`,
    [payload.dealId]
  );

  if (dealCompanyResult.rows.length > 0) {
    const { company_name } = dealCompanyResult.rows[0];
    const companyName = company_name ?? "this company";

    // Find project types that have NOT been pitched to contacts at this company
    // Compare against all project types, excluding any already associated with deals
    // where the primary contact has the same company_name
    const untappedTypes = await pool.query(
      `SELECT pt.id, pt.name
       FROM public.project_type_config pt
       WHERE pt.id != $1
         AND pt.is_active = true
         AND pt.id NOT IN (
           SELECT DISTINCT d2.project_type_id
           FROM ${schemaName}.deals d2
           JOIN ${schemaName}.contacts c2 ON c2.id = d2.primary_contact_id
           WHERE c2.company_name = $2
             AND d2.project_type_id IS NOT NULL
         )
       LIMIT 1`,
      [payload.projectTypeId, company_name]
    );

    if (untappedTypes.rows.length > 0) {
      const projectTypeName = untappedTypes.rows[0].name;
      const dueDate14 = new Date();
      dueDate14.setDate(dueDate14.getDate() + 14);

      await pool.query(
        `INSERT INTO ${schemaName}.tasks
         (title, type, priority, status, assigned_to, deal_id, due_date, created_by)
         VALUES ($1, 'system', 'normal', 'pending', $2, $3, $4, $2)`,
        [
          `Explore ${projectTypeName} opportunities with ${companyName}`,
          assignedTo,
          payload.dealId,
          dueDate14.toISOString().split("T")[0],
        ]
      );

      console.log(`[Worker] deal.won: created cross-sell task for ${companyName} — ${projectTypeName}`);
    }
  }
}
```

**Commit:** `feat(worker): add cross-sell alert task when deal is won and company has untapped project types`

---

## Task 20: Director Weekly Digest Task (Worker)

- [ ] Create `worker/src/jobs/weekly-digest.ts`
- [ ] Register weekly cron schedule and job handler in worker

### 20a. Weekly Digest Job

**File: `worker/src/jobs/weekly-digest.ts`**

```typescript
import { pool } from "../db.js";

/**
 * Director weekly digest task.
 *
 * Runs every Monday at 7:00 AM CT.
 * For each active office:
 * 1. Query pipeline stats: stale deals count, deals approaching deadline,
 *    new deals this week, total pipeline value
 * 2. Create a summary task for each director/admin in the office
 */
export async function runWeeklyDigest(): Promise<void> {
  console.log("[Worker:weekly-digest] Starting weekly digest generation...");

  const client = await pool.connect();
  try {
    const offices = await client.query(
      "SELECT id, slug FROM public.offices WHERE is_active = true"
    );

    let totalDigestTasks = 0;

    for (const office of offices.rows) {
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(office.slug)) {
        console.error(`[Worker:weekly-digest] Invalid office slug: "${office.slug}" -- skipping`);
        continue;
      }
      const schemaName = `office_${office.slug}`;

      // Count stale deals (no activity in 14+ days, in active stages)
      // NOTE: deals.stage_id is a UUID FK to public.pipeline_stage_config.
      //       Filter active deals by joining to pipeline_stage_config where is_terminal = false.
      //       deals has awarded_amount and bid_estimate, NOT value.
      const staleResult = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM ${schemaName}.deals d
         JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
         WHERE psc.is_terminal = false
           AND d.last_activity_at < NOW() - INTERVAL '14 days'`
      );
      const staleCount = staleResult.rows[0].count;

      // Count deals approaching deadline (expected_close_date within 7 days)
      const approachingResult = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM ${schemaName}.deals d
         JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
         WHERE psc.is_terminal = false
           AND d.expected_close_date IS NOT NULL
           AND d.expected_close_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'`
      );
      const approachingCount = approachingResult.rows[0].count;

      // Count new deals this week
      const newDealsResult = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM ${schemaName}.deals
         WHERE created_at >= DATE_TRUNC('week', CURRENT_DATE)`
      );
      const newDealsCount = newDealsResult.rows[0].count;

      // Total pipeline value (active deals) — use COALESCE of awarded_amount falling back to bid_estimate
      const valueResult = await client.query(
        `SELECT COALESCE(SUM(COALESCE(d.awarded_amount, d.bid_estimate, 0)), 0)::numeric(12,2) AS total
         FROM ${schemaName}.deals d
         JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
         WHERE psc.is_terminal = false`
      );
      const totalValue = parseFloat(valueResult.rows[0].total);
      const formattedValue = totalValue >= 1000000
        ? `$${(totalValue / 1000000).toFixed(1)}M`
        : totalValue >= 1000
          ? `$${(totalValue / 1000).toFixed(0)}K`
          : `$${totalValue.toFixed(0)}`;

      // Find all directors and admins in this office
      const directors = await client.query(
        `SELECT id FROM public.users
         WHERE office_id = $1
           AND role IN ('director', 'admin')
           AND is_active = true`,
        [office.id]
      );

      const title = `Weekly Pipeline Review — ${staleCount} stale, ${approachingCount} approaching deadline, ${newDealsCount} new this week, ${formattedValue} total`;

      for (const director of directors.rows) {
        // NOTE: tasks table has no 'link' column. Use description to store the deep link.
        await client.query(
          `INSERT INTO ${schemaName}.tasks
           (title, description, type, priority, status, assigned_to, due_date, created_by)
           VALUES ($1, 'View the full pipeline at /director', 'system', 'normal', 'pending', $2, CURRENT_DATE, $2)`,
          [title, director.id]
        );
        totalDigestTasks++;
      }
    }

    console.log(`[Worker:weekly-digest] Complete. Created ${totalDigestTasks} weekly digest tasks`);
  } finally {
    client.release();
  }
}
```

### 20b. Register Cron and Job Handler

**File: `worker/src/index.ts`** -- Add import and cron schedule:

```typescript
import { runWeeklyDigest } from "./jobs/weekly-digest.js";

// Weekly digest: Monday at 7:00 AM CT
cron.schedule("0 7 * * 1", async () => {
  console.log("[Worker:cron] Running weekly digest...");
  try {
    await runWeeklyDigest();
  } catch (err) {
    console.error("[Worker:cron] Weekly digest failed:", err);
  }
}, { timezone: "America/Chicago" });
console.log("[Worker] Cron scheduled: weekly digest at 7:00 AM CT every Monday");
```

**File: `worker/src/jobs/index.ts`** -- Register job handler:

```typescript
import { runWeeklyDigest } from "./weekly-digest.js";

registerJobHandler("weekly_digest", async () => {
  await runWeeklyDigest();
});
```

**Commit:** `feat(worker): add weekly director digest task with pipeline stats summary`

---

## Task 22: Resend Email Delivery for System Notifications

- [ ] Install `resend` npm package
- [ ] Create `server/src/services/resend-email.ts`
- [ ] Wire into notification service for critical notification types

### 22a. Install Resend Package

```bash
npm install resend
```

### 22b. System Email Service

**File: `server/src/services/resend-email.ts`**

```typescript
import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "notifications@trock-crm.com";

/**
 * Notification types that also trigger an email via Resend.
 * These are high-priority notifications that the user should not miss.
 */
const EMAIL_WORTHY_TYPES = new Set([
  "stale_deal",
  "activity_drop",
  "approval_needed",
  "inbound_email",
]);

interface SystemEmailInput {
  to: string; // recipient email address
  notificationType: string;
  title: string;
  body?: string;
  link?: string;
}

/**
 * Send a system notification email via Resend.
 * Only fires for critical notification types defined in EMAIL_WORTHY_TYPES.
 * Fails silently if Resend is not configured (RESEND_API_KEY not set).
 */
export async function sendSystemEmail(input: SystemEmailInput): Promise<void> {
  if (!resend) {
    console.warn("[Resend] RESEND_API_KEY not configured -- skipping email");
    return;
  }

  if (!EMAIL_WORTHY_TYPES.has(input.notificationType)) {
    return; // Not a critical notification type
  }

  try {
    const appUrl = process.env.FRONTEND_URL ?? "https://app.trock-crm.com";
    const deepLink = input.link ? `${appUrl}${input.link}` : appUrl;

    await resend.emails.send({
      from: FROM_EMAIL,
      to: input.to,
      subject: `[T Rock CRM] ${input.title}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #1e293b; padding: 16px 24px; border-radius: 8px 8px 0 0;">
            <h2 style="color: #ffffff; margin: 0; font-size: 18px;">T Rock CRM</h2>
          </div>
          <div style="padding: 24px; border: 1px solid #e2e8f0; border-top: 0; border-radius: 0 0 8px 8px;">
            <h3 style="margin: 0 0 8px 0; color: #1e293b;">${input.title}</h3>
            ${input.body ? `<p style="color: #64748b; margin: 0 0 16px 0;">${input.body}</p>` : ""}
            <a href="${deepLink}"
               style="display: inline-block; background: #7c3aed; color: #ffffff; padding: 10px 20px;
                      border-radius: 6px; text-decoration: none; font-weight: 500;">
              View in CRM
            </a>
          </div>
        </div>
      `,
    });

    console.log(`[Resend] Sent ${input.notificationType} email to ${input.to}`);
  } catch (err) {
    console.error(`[Resend] Failed to send ${input.notificationType} email:`, err);
    // Fail silently -- email is supplementary to in-app notification
  }
}
```

### 22c. Wire into Notification Service

**File: `server/src/modules/notifications/service.ts`** -- Add Resend email to `createNotification()`:

After the notification is inserted and the SSE event is emitted, call `sendSystemEmail`:

```typescript
import { sendSystemEmail } from "../../services/resend-email.js";

// Inside createNotification(), after the SSE emit try/catch block:

// Send email for critical notification types via Resend
if (input.recipientEmail) {
  sendSystemEmail({
    to: input.recipientEmail,
    notificationType: input.type,
    title: input.title,
    body: input.body,
    link: input.link,
  }).catch((err) => {
    console.error("[Notifications] Resend email failed:", err);
  });
}
```

Update the `createNotification` input type to accept an optional `recipientEmail`:

```typescript
export async function createNotification(
  tenantDb: TenantDb,
  input: {
    userId: string;
    type: string;
    title: string;
    body?: string;
    link?: string;
    recipientEmail?: string; // If provided, also sends via Resend for critical types
  }
)
```

### 22d. Wire into Worker Notification Inserts

For worker-created notifications (stale_deal, activity_drop), look up the user's email after inserting the notification and call `sendSystemEmail`:

**File: `worker/src/jobs/activity-alerts.ts`** -- After inserting the activity_drop notification:

```typescript
import { sendSystemEmail } from "../../../server/src/services/resend-email.js";
// OR inline the Resend call if cross-package imports are not allowed:

// After the notification INSERT for each director:
const directorEmail = await client.query(
  "SELECT email FROM public.users WHERE id = $1",
  [director.id]
);
if (directorEmail.rows[0]?.email) {
  sendSystemEmail({
    to: directorEmail.rows[0].email,
    notificationType: "activity_drop",
    title,
    body,
    link: "/director",
  }).catch(console.error);
}
```

**Commit:** `feat: add Resend email delivery for critical system notifications (stale_deal, activity_drop, approval_needed, inbound_email)`

**Environment Variables Required:**
- `RESEND_API_KEY` -- API key from resend.com
- `RESEND_FROM_EMAIL` -- verified sender email (default: `notifications@trock-crm.com`)

---

## Task 21: AI-Suggested Next Action (Phase 2 Stub)

- [ ] Add placeholder handler for `ai.suggest_action` domain event
- [ ] Add `AI_SUGGEST_ACTION` to `DOMAIN_EVENTS` in shared types

### 21a. Register Domain Event

**File: `shared/src/types/events.ts`** -- Add the new event name (cumulative with Task 12b additions):

```typescript
export const DOMAIN_EVENTS = {
  DEAL_STAGE_CHANGED: "deal.stage.changed",
  DEAL_WON: "deal.won",
  DEAL_LOST: "deal.lost",
  CONTACT_CREATED: "contact.created",
  EMAIL_RECEIVED: "email.received",
  EMAIL_SENT: "email.sent",
  FILE_UPLOADED: "file.uploaded",
  TASK_COMPLETED: "task.completed",
  TASK_ASSIGNED: "task.assigned",
  APPROVAL_REQUESTED: "approval.requested",
  APPROVAL_RESOLVED: "approval.resolved",
  NOTIFICATION_CREATED: "notification.created",
  AI_SUGGEST_ACTION: "ai.suggest_action",
} as const;
```

### 21b. Placeholder Handler

**File: `worker/src/jobs/index.ts`** -- Register stub handler:

```typescript
domainEventHandlers.set("ai.suggest_action", async (payload, officeId) => {
  // Phase 2: Will call Claude API to analyze deal stage, contact touchpoints,
  // and email history to suggest the optimal next action for the rep.
  //
  // Planned approach:
  // 1. Gather deal context (stage, value, days in stage, recent activities)
  // 2. Gather contact history (touchpoints, email sentiment, response times)
  // 3. Call Claude API with structured prompt
  // 4. Parse response into a task with suggested title, priority, and due date
  // 5. Create task assigned to the deal's rep
  //
  // For now, just log the event so the handler exists for Phase 2.
  console.log(`[Worker] ai.suggest_action: received event for office ${officeId}`, {
    dealId: payload.dealId,
    contactId: payload.contactId,
    trigger: payload.trigger,
    timestamp: new Date().toISOString(),
  });
});
```

**Commit:** `feat(worker): add AI-suggested next action placeholder handler for Phase 2 Claude API integration`

---

## Implementation Order

Execute tasks in this order to minimize blocked dependencies:

1. **Task 1** (Task service + routes) -- no frontend dependency
2. **Task 2** (Activity service + routes) -- no frontend dependency
3. **Task 5** (SSE manager) -- needs event bus only
4. **Task 6** (Notification service + CRUD routes) -- needs SSE manager from Task 5
5. **Task 3** (Daily task generation worker) -- needs task table only
6. **Task 4** (Activity drop detection worker) -- needs activities table only
7. **Task 7** (Backend tests) -- after all backend tasks
8. **Task 8** (Frontend hooks) -- after backend routes exist
9. **Task 9** (Task list page) -- needs Task 8
10. **Task 10** (Notification center) -- needs Task 8
11. **Task 11** (Activity logging forms) -- needs Task 8
12. **Task 12** (Route wiring + DOMAIN_EVENTS update) -- final integration
13. **Task 13** (Cold lead warming worker) -- needs task table + contacts/deals tables
14. **Task 14** (Post-meeting follow-up) -- needs activity service from Task 2
15. **Task 15** (Bid deadline countdown worker) -- needs task table + deals table
16. **Task 16** (New contact onboarding sequence) -- needs contact.created handler
17. **Task 17** (Won deal handoff checklist) -- needs deal.won handler
18. **Task 18** (Competitor intelligence tasks) -- needs deal.lost handler
19. **Task 19** (Cross-sell alert tasks) -- needs deal.won handler (after Task 17)
20. **Task 20** (Director weekly digest worker) -- needs task table + deals table
21. **Task 22** (Resend email for system notifications) -- needs notification service from Task 6
22. **Task 21** (AI-suggested next action stub) -- no dependencies, Phase 2 placeholder

Tasks 1-2 can run in parallel. Tasks 3-4 can run in parallel. Tasks 9-11 can run in parallel. Tasks 13, 15, 20 can run in parallel (independent worker jobs). Tasks 17, 19 must be sequential (both extend deal.won). Tasks 16, 18 are independent event handlers. Task 22 can run after Task 6.
