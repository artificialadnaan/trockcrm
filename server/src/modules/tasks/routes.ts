import { Router } from "express";
import { jobQueue } from "@trock-crm/shared/schema";
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
