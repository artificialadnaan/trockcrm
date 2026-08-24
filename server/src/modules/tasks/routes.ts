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
  getTaskRowById,
  createTask,
  queueTaskCreateSideEffects,
  updateTask,
  transitionTaskStatus,
  completeTask,
  dismissTask,
  snoozeTask,
  isTaskSortBy,
  isTaskSection,
  isTaskSource,
  getPendingAssignmentTasks,
  acknowledgeTaskAssignments,
  type TaskSortDir,
} from "./service.js";
import {
  ackTaskReplies,
  getTaskTimeline,
  getTasksAwaitingMe,
  listTaskComments,
  postTaskComment,
  type TaskReplyNotification,
} from "./closed-loop-service.js";
import {
  prepareTaskAssignmentEmail,
  prepareTaskReplyEmail,
  sendPreparedTaskAssignmentEmail,
  sendPreparedTaskReplyEmail,
  TaskTransactionUnusableError,
  type PreparedTaskAssignmentEmail,
  type PreparedTaskReplyEmail,
} from "./notifications.js";

const router = Router();

async function resolveRequestedTaskOfficeId(req: any) {
  const requestedOfficeId = req.headers["x-office-id"] as string | undefined;
  const accessibleOffices = await getAccessibleOffices(
    req.user!.id,
    req.user!.role,
    req.user!.activeOfficeId ?? req.user!.officeId
  );
  if (requestedOfficeId && !accessibleOffices.some((office) => office.id === requestedOfficeId)) {
    throw new AppError(403, "Requested office is not accessible");
  }

  const officeId = requestedOfficeId ?? req.user!.activeOfficeId ?? req.user!.officeId;
  if (!officeId) {
    throw new AppError(400, "Task office context is required. Specify x-office-id.");
  }
  if (!accessibleOffices.some((office) => office.id === officeId)) {
    throw new AppError(403, "Requested office is not accessible");
  }

  return officeId;
}

async function listAssignableUsersForRequest(req: any) {
  const officeId = await resolveRequestedTaskOfficeId(req);
  const usersById = new Map<string, { id: string; displayName: string; isActive: boolean }>();

  const rows = (await listUsers(officeId)) as Array<{ id: string; displayName: string; isActive: boolean }>;
  for (const user of rows) {
    if (user.isActive && !usersById.has(user.id)) {
      usersById.set(user.id, user);
    }
  }

  return Array.from(usersById.values());
}

async function assertAssignableUser(req: any, userId: string) {
  const users = await listAssignableUsersForRequest(req);
  if (!users.some((user) => user.id === userId)) {
    throw new AppError(400, "Assigned user is not active or is outside the current office");
  }
}

async function prepareTaskAssignmentEmailBestEffort(
  req: any,
  task: {
    id: string;
    title: string;
    description?: string | null;
    dueDate?: string | Date | null;
    dealId?: string | null;
  },
  assigneeId: string
) {
  if (!assigneeId || assigneeId === req.user!.id) return null;

  try {
    return await prepareTaskAssignmentEmail(req.tenantDb!, {
      task,
      assigneeId,
      assigner: {
        id: req.user!.id,
        displayName: req.user!.displayName,
        email: req.user!.email,
      },
      // Pre-existing gap, fixed here because it is one argument in a helper this PR already owns: the
      // assignment email's deep link had the same cross-office defect as the reply email's.
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
    });
  } catch (err) {
    // Preparing the email is best-effort — EXCEPT when the failure means the task transaction can
    // no longer be committed safely. Swallowing that would let the COMMIT below degrade to a silent
    // ROLLBACK while we returned success for a task that was never written.
    if (err instanceof TaskTransactionUnusableError) throw err;
    console.error("[Tasks] Failed to prepare task assignment email:", err);
    return null;
  }
}

async function sendTaskAssignmentEmailBestEffort(email: PreparedTaskAssignmentEmail | null) {
  if (!email) return;

  try {
    await sendPreparedTaskAssignmentEmail(email);
  } catch (err) {
    console.error("[Tasks] Failed to send task assignment email:", err);
  }
}

async function prepareTaskReplyEmailBestEffort(
  tenantDb: any,
  notify: TaskReplyNotification
): Promise<PreparedTaskReplyEmail | null> {
  try {
    return await prepareTaskReplyEmail(tenantDb, {
      task: { id: notify.taskId, title: notify.taskTitle },
      assignerId: notify.assignerId,
      authorName: notify.authorName,
      replyBody: notify.replyBody,
      repliedAt: notify.repliedAt,
      // The office the comment was written into — the link 404s for a recipient sitting in a
      // different office without it. See notifications.ts taskUrl.
      officeId: notify.officeId,
    });
  } catch (err) {
    // Same rule as the assignment email: best-effort EXCEPT when the failure means the comment's
    // transaction can no longer be committed safely. Swallowing that would let the COMMIT below
    // degrade to a silent ROLLBACK while we returned 201 for a reply that was never written.
    if (err instanceof TaskTransactionUnusableError) throw err;
    console.error("[Tasks] Failed to prepare task reply email:", err);
    return null;
  }
}

async function sendTaskReplyEmailBestEffort(email: PreparedTaskReplyEmail | null) {
  if (!email) return;

  try {
    await sendPreparedTaskReplyEmail(email);
  } catch (err) {
    console.error("[Tasks] Failed to send task reply email:", err);
  }
}

// GET /api/tasks/assignees — list active users for the assignee picker.
router.get("/assignees", async (req, res, next) => {
  try {
    const users = (await listAssignableUsersForRequest(req))
      .map((u) => ({ id: u.id, displayName: u.displayName }));
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

// GET /api/tasks — list tasks (paginated, filtered by section)
router.get("/", async (req, res, next) => {
  try {
    // Validate sort params against the allowlist; unknown values fall back to the
    // section's default ordering (never reaches SQL — buildTaskSortOrder is a fixed switch).
    const sortByParam = req.query.sortBy;
    const sortBy = isTaskSortBy(sortByParam) ? sortByParam : undefined;
    const sortDirParam = req.query.sortDir;
    const sortDir: TaskSortDir | undefined =
      sortDirParam === "asc" || sortDirParam === "desc" ? sortDirParam : undefined;

    // Validate section against the allowlist; an unknown value becomes undefined (the base list,
    // same as omitting it) rather than being cast straight through to the service.
    const section = isTaskSection(req.query.section) ? req.query.section : undefined;

    // Same treatment for the automated/manual tab filter: anything outside the two known values
    // becomes undefined, which means BOTH — the pre-existing behaviour for every caller that has
    // never sent the param.
    const source = isTaskSource(req.query.source) ? req.query.source : undefined;

    const filters = {
      assignedTo: req.query.assignedTo as string | undefined,
      status: req.query.status as string | undefined,
      type: req.query.type as string | undefined,
      dealId: req.query.dealId as string | undefined,
      contactId: req.query.contactId as string | undefined,
      section,
      source,
      sortBy,
      sortDir,
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
    // Same allowlist as the list route: the cards must scope to whichever tab is selected, or a card
    // sits above a bucket it disagrees with.
    const source = isTaskSource(req.query.source) ? req.query.source : undefined;
    const counts = await getTaskCounts(req.tenantDb!, req.user!.role, req.user!.id, userId, source);
    await req.commitTransaction!();
    res.json({ counts });
  } catch (err) {
    next(err);
  }
});

// =============================================================================================
// F4 — TASK CLOSED LOOP (replies, acknowledgement, timeline, "needs your attention").
//
// ONE CONTIGUOUS BLOCK, on purpose: a parallel branch adding its own routes lands its block adjacent
// to this one and git produces a single clean conflict hunk instead of five interleaved ones.
//
// It sits ABOVE the anchor below because `GET /awaiting-me` is single-segment and would otherwise be
// swallowed by the catch-all `GET /:id` — see that comment for what that failure looks like.
// =============================================================================================

// GET /api/tasks/awaiting-me — tasks YOU assigned that carry a reply you have not acknowledged.
//
// No role gate: the scope is `created_by = you`, i.e. your own data by definition. Gating it on
// admin/director (as the sibling assignee filter is) would hide a rep's own assignments from them, and
// a rep who assigns work is precisely the person the ask describes.
router.get("/awaiting-me", async (req, res, next) => {
  try {
    const tasks = await getTasksAwaitingMe(req.tenantDb!, req.user!.id);
    await req.commitTransaction!();
    res.json({ tasks });
  } catch (err) {
    next(err);
  }
});

// GET /api/tasks/:id/comments — the thread, plus whether a reply on it reaches anybody.
router.get("/:id/comments", async (req, res, next) => {
  try {
    const result = await listTaskComments(
      req.tenantDb!,
      req.params.id,
      req.user!.role,
      req.user!.id
    );
    await req.commitTransaction!();
    res.json({
      comments: result.comments,
      loop: result.loop,
      unreadReplyCount: result.unreadReplyCount,
      // So the composer can hide itself rather than offering a Send the server will 403.
      canComment: result.canComment,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/:id/comments — reply to a task.
//
// Allowed on a COMPLETED task, deliberately: updateTask's "no edits after completion" rule is about
// task FIELDS, and "it was closed and then they answered" is a real sequence the loop must record.
router.post("/:id/comments", async (req, res, next) => {
  try {
    const { body } = req.body ?? {};
    if (typeof body !== "string") throw new AppError(400, "body is required");

    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    const result = await postTaskComment(
      req.tenantDb!,
      req.params.id,
      { body, officeId },
      req.user!.role,
      req.user!.id
    );

    // Prepared BEFORE the commit (inside the open transaction, savepointed) and sent AFTER it — the
    // same shape the assignment email uses. Deliberately NOT folded into the worker's task.replied
    // handler alongside the in-app notification: one unhandled throw there would take the whole job
    // down and lose the notification too, and the email is the channel this design actually leans on.
    const replyEmail = result.notify
      ? await prepareTaskReplyEmailBestEffort(req.tenantDb!, result.notify)
      : null;

    await req.commitTransaction!();

    await sendTaskReplyEmailBestEffort(replyEmail);

    res.status(201).json({ comment: result.comment, loop: result.loop });
  } catch (err) {
    next(err);
  }
});

// GET /api/tasks/:id/timeline — audit rows and comments, merged in timestamp order.
router.get("/:id/timeline", async (req, res, next) => {
  try {
    const entries = await getTaskTimeline(
      req.tenantDb!,
      req.params.id,
      req.user!.role,
      req.user!.id
    );
    await req.commitTransaction!();
    res.json({ entries });
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/:id/ack — the ASSIGNER marks replies read, up to the point they actually rendered.
//
// `seenUpTo` is required rather than defaulted to now(): defaulting it re-creates the lost-update race
// the whole ack model exists to close (a reply landing between the render and the click would be
// marked seen by somebody who never saw it), and it would make the service's comparison unreachable.
router.post("/:id/ack", async (req, res, next) => {
  try {
    const { seenUpTo } = req.body ?? {};
    if (typeof seenUpTo !== "string" || seenUpTo.trim().length === 0) {
      throw new AppError(400, "seenUpTo is required — send the timestamp of the newest reply you rendered");
    }
    const seenUpToDate = new Date(seenUpTo);
    if (Number.isNaN(seenUpToDate.getTime())) {
      throw new AppError(400, "seenUpTo must be a valid ISO timestamp");
    }

    const result = await ackTaskReplies(
      req.tenantDb!,
      req.params.id,
      // Preserve the wire value: Date normalizes a PostgreSQL microsecond timestamp to milliseconds,
      // which can acknowledge just before the reply the drawer actually rendered.
      seenUpTo.trim(),
      req.user!.role,
      req.user!.id
    );
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// =============================================================================================
// END F4 — TASK CLOSED LOOP
// =============================================================================================

// ═══ F6 — new-assignment login modal ═════════════════════════════════════════════════════════
// Both routes live in one block so a parallel branch adding its own literal routes at this anchor
// resolves as a block move rather than an interleave. Registered ABOVE the anchor banner below for
// the reason the banner gives: `GET /:id` would otherwise swallow /pending-acknowledgement.

// GET /api/tasks/pending-acknowledgement — assignments to interrupt this person with at login.
router.get("/pending-acknowledgement", async (req, res, next) => {
  try {
    // Scoped to the authenticated caller and to nothing else. There is deliberately no userId
    // parameter: this is somebody's personal "have you seen this" record, not a manager report.
    const result = await getPendingAssignmentTasks(req.tenantDb!, req.user!.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/acknowledge — record that the modal has shown these exact assignment versions to the caller.
router.post("/acknowledge", async (req, res, next) => {
  try {
    // 204 whatever the payload turns out to be. The service filters to assignments genuinely owned by
    // the caller AT the version the modal rendered, and silently drops stale/malformed rows. A 400 or
    // 403 would wedge a modal that lost a reassignment race into re-showing forever with no action
    // available to it. Ownership and version binding are enforced; they just are not announced.
    await acknowledgeTaskAssignments(req.tenantDb!, req.user!.id, req.body?.assignments);
    await req.commitTransaction!();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
// ═════════════════════════════════════════════════════════════════════════════════════════════

// ---------------------------------------------------------------------------------------------
// ADD NEW SINGLE-SEGMENT GET ROUTES ABOVE THIS LINE.
//
// `GET /:id` below matches ANY single path segment, and Express takes the first route that matches.
// A literal route registered after it — /awaiting-me, /pending-acknowledgement, /summary — is never
// reached: the request falls into this handler, the literal string is passed to getTaskById as a
// task id, and Postgres rejects it as malformed uuid input (22P07), so the caller gets a 500 with
// nothing in it that points at the routing. `/assignees` and `/counts` above are already ordered
// this way for exactly that reason.
// ---------------------------------------------------------------------------------------------

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

    const targetAssignee = assignedTo ?? req.user!.id;
    if (assignedTo) {
      await assertAssignableUser(req, targetAssignee);
    }

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

    const sideEffects = await queueTaskCreateSideEffects(req.tenantDb!, task, {
      actorUserId: req.user!.id,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
    });

    const taskAssignmentEmail = await prepareTaskAssignmentEmailBestEffort(req, task, targetAssignee);

    await req.commitTransaction!();

    await sendTaskAssignmentEmailBestEffort(taskAssignmentEmail);

    // Best-effort local emit for SSE push (already persisted via outbox above)
    if (sideEffects.shouldEmitAssignmentEvent) {
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

    if (body.assignedTo !== undefined) {
      await assertAssignableUser(req, body.assignedTo);
    }

    // Only the previous assignee is read here, so the lean row is enough.
    const existingTask = body.assignedTo !== undefined
      ? await getTaskRowById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id)
      : null;
    if (body.assignedTo !== undefined && !existingTask) {
      throw new AppError(404, "Task not found");
    }

    const task = await updateTask(
      req.tenantDb!,
      req.params.id,
      body,
      req.user!.role,
      req.user!.id
    );
    const taskAssignmentEmail =
      body.assignedTo !== undefined &&
      existingTask &&
      body.assignedTo !== existingTask.assignedTo
        ? await prepareTaskAssignmentEmailBestEffort(req, task, body.assignedTo)
        : null;

    await req.commitTransaction!();

    await sendTaskAssignmentEmailBestEffort(taskAssignmentEmail);

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
          requestedBy: req.user!.id,
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
