import { Router } from "express";
import { jobQueue } from "@trock-crm/shared/schema";
import { TASK_PRIORITIES, TASK_TYPES } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { eventBus } from "../../events/bus.js";
import { getAccessibleOffices } from "../auth/service.js";
import { TASK_RULES } from "./rules/config.js";
import { listUsers } from "../admin/users-service.js";
import {
  getTasks,
  getTaskCounts,
  getTaskById,
  createTask,
  updateTask,
  transitionTaskStatus,
  completeTask,
  dismissTask,
  snoozeTask,
} from "./service.js";

const router = Router();

// GET /api/tasks/assignees — list users for assignee picker (directors/admins)
router.get("/assignees", async (req, res, next) => {
  try {
    // Reps only see themselves — they can only assign tasks to themselves
    if (req.user!.role === "rep") {
      await req.commitTransaction!();
      res.json({ users: [{ id: req.user!.id, displayName: req.user!.displayName }] });
      return;
    }

    const requestedOfficeId = req.headers["x-office-id"] as string | undefined;
    const accessibleOffices = await getAccessibleOffices(
      req.user!.id,
      req.user!.role,
      req.user!.activeOfficeId ?? req.user!.officeId
    );
    const officeId = requestedOfficeId ?? req.user!.activeOfficeId ?? req.user!.officeId;
    if (requestedOfficeId && !accessibleOffices.some((office) => office.id === requestedOfficeId)) {
      throw new AppError(403, "Requested office is not accessible");
    }
    const rows = (await listUsers(officeId)) as Array<{ id: string; displayName: string; isActive: boolean }>;
    const users = rows
      .filter((u) => u.isActive)
      .map((u) => ({ id: u.id, displayName: u.displayName }));
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

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
    const counts = await getTaskCounts(req.tenantDb!, req.user!.role, req.user!.id, userId);
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
    if (priority && !TASK_PRIORITIES.includes(priority)) {
      throw new AppError(400, `Invalid priority. Must be one of: ${TASK_PRIORITIES.join(", ")}`);
    }
    if (type && !TASK_TYPES.includes(type)) {
      throw new AppError(400, `Invalid task type. Must be one of: ${TASK_TYPES.join(", ")}`);
    }

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

    // Outbox pattern: insert durable event BEFORE commit so worker gets it
    if (targetAssignee !== req.user!.id) {
      await req.tenantDb!.insert(jobQueue).values({
        jobType: "domain_event",
        payload: {
          eventName: "task.assigned",
          taskId: task.id,
          assignedTo: targetAssignee,
          title: task.title,
        },
        officeId: req.user!.activeOfficeId ?? req.user!.officeId,
        status: "pending",
        runAfter: new Date(),
      });
    }

    if (task.dealId) {
      await req.tenantDb!.insert(jobQueue).values({
        jobType: "ai_refresh_copilot",
        payload: {
          dealId: task.dealId,
          reason: "task_created",
          taskId: task.id,
        },
        officeId: req.user!.activeOfficeId ?? req.user!.officeId,
        status: "pending",
        runAfter: new Date(),
      });
    }

    await req.commitTransaction!();

    // Best-effort local emit for SSE push (already persisted via outbox above)
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
        console.error("[Tasks] Failed to emit task.assigned event:", eventErr);
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
    const body = { ...req.body };

    if (body.priority && !TASK_PRIORITIES.includes(body.priority)) {
      throw new AppError(400, `Invalid priority. Must be one of: ${TASK_PRIORITIES.join(", ")}`);
    }

    // Reps cannot reassign tasks
    if (req.user!.role === "rep") {
      delete body.assignedTo;
    }

    const task = await updateTask(
      req.tenantDb!,
      req.params.id,
      body,
      req.user!.role,
      req.user!.id
    );
    await req.commitTransaction!();
    res.json({ task });
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/:id/transition — move a task through the lifecycle
router.post("/:id/transition", async (req, res, next) => {
  try {
    const { nextStatus, scheduledFor, waitingOn, blockedBy } = req.body;

    const task = await transitionTaskStatus(
      req.tenantDb!,
      req.params.id,
      {
        nextStatus,
        scheduledFor,
        waitingOn,
        blockedBy,
      },
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
    const completionRule = task.originRule
      ? TASK_RULES.find((rule) => rule.id === task.originRule)
      : null;
    if (task.originRule && !completionRule) {
      throw new AppError(
        500,
        `Missing rule configuration for completed task originRule ${task.originRule}`
      );
    }
    const completionPayload = {
      taskId: task.id,
      dealId: task.dealId,
      contactId: task.contactId,
      title: task.title,
      type: task.type,
      completedBy: req.user!.id,
      originRule: task.originRule,
      dedupeKey: task.dedupeKey,
      reasonCode: task.reasonCode,
      entitySnapshot: task.entitySnapshot,
      suppressionWindowDays: completionRule?.suppressionWindowDays ?? null,
    };

    // Outbox pattern: insert into job_queue BEFORE committing the transaction
    // so the event is guaranteed to be persisted even if emitLocal fails.
    await req.tenantDb!.insert(jobQueue).values({
      jobType: "domain_event",
      payload: {
        eventName: "task.completed",
        ...completionPayload,
      },
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      status: "pending",
      runAfter: new Date(),
    });

    if (task.dealId) {
      await req.tenantDb!.insert(jobQueue).values({
        jobType: "ai_refresh_copilot",
        payload: {
          dealId: task.dealId,
          reason: "task_completed",
          taskId: task.id,
        },
        officeId: req.user!.activeOfficeId ?? req.user!.officeId,
        status: "pending",
        runAfter: new Date(),
      });
    }

    await req.commitTransaction!();

    // Best-effort local emit for SSE push (already persisted via outbox above)
    try {
      eventBus.emitLocal({
        name: "task.completed",
        payload: completionPayload,
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
