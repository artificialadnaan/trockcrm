/**
 * In-app notifications for the task loop: `task.assigned` (existing, moved here) and `task.replied`
 * (new). Both write a row into the recipient's office `notifications` table and PG NOTIFY so the
 * server's SSE manager can push it.
 *
 * EXTRACTED FROM jobs/index.ts so both handlers are testable. `worker/src/jobs/index.ts` imports ~40
 * job modules at load time, so a suite that imports it to reach one handler is a suite nobody writes —
 * which is how the `task_assigned` link below went years pointing at the bare list.
 *
 * ⚠️ THE EMAIL IS NOT SENT FROM HERE, DELIBERATELY. The reply email is prepared and sent by the API
 * route (server/src/modules/tasks/routes.ts) around its own commit. Writing both from this handler
 * couples them: an unhandled throw while sending — or, before migration 0234, an
 * `invalid input value for enum notification_type` on the INSERT below — takes the whole job down and
 * loses the other half with it. They fail independently on purpose.
 */

type WorkerPool = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, any>> }>;
};

/**
 * Resolve the tenant schema for a user, or null if it cannot be resolved safely.
 *
 * The slug regex is a SQL-injection guard, not a formatting nicety: the slug is interpolated into the
 * statement below because a schema name cannot be a bind parameter.
 */
async function resolveUserSchema(workerPool: WorkerPool, userId: string): Promise<string | null> {
  const userResult = await workerPool.query(
    "SELECT office_id FROM public.users WHERE id = $1",
    [userId]
  );
  if (userResult.rows.length === 0) return null;

  const officeResult = await workerPool.query(
    "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
    [userResult.rows[0].office_id]
  );
  if (officeResult.rows.length === 0) return null;

  const slug = officeResult.rows[0].slug;
  const slugRegex = /^[a-z][a-z0-9_]*$/;
  if (!slugRegex.test(slug)) return null;

  return `office_${slug}`;
}

async function insertNotification(
  workerPool: WorkerPool,
  schemaName: string,
  row: { userId: string; type: string; title: string; body: string | null; link: string }
) {
  const result = await workerPool.query(
    `INSERT INTO ${schemaName}.notifications (user_id, type, title, body, link)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [row.userId, row.type, row.title, row.body, row.link]
  );

  await workerPool.query(`SELECT pg_notify('crm_events', $1)`, [
    JSON.stringify({
      eventName: "notification.created",
      userId: row.userId,
      notificationId: result.rows[0]?.id,
    }),
  ]);
}

/** Deep link to the task itself. Both notification types use it — `task_assigned` linked to the bare
 *  `/tasks` list until now, which dropped the recipient into an unfiltered list and made them hunt for
 *  the task they had just been told about. */
export function taskNotificationLink(taskId: string | null | undefined) {
  return taskId ? `/tasks/${encodeURIComponent(taskId)}` : "/tasks";
}

export async function handleTaskAssignedEvent(payload: any, _officeId: string | null) {
  console.log(`[Worker] task.assigned: ${payload?.taskId} — ${payload?.title}`);
  if (!payload?.assignedTo) return;

  const { pool: workerPool } = await import("../db.js");
  const schemaName = await resolveUserSchema(workerPool as WorkerPool, payload.assignedTo);
  if (!schemaName) return;

  await insertNotification(workerPool as WorkerPool, schemaName, {
    userId: payload.assignedTo,
    type: "task_assigned",
    title: `New task assigned: ${payload.title}`,
    body: payload.title,
    link: taskNotificationLink(payload.taskId),
  });
}

/**
 * The assignee answered a task somebody assigned them — tell the assigner.
 *
 * The recipient is the ASSIGNER, not the assignee: this is the "and then tell Adam they replied" half
 * of the loop. The producing side (tasks/closed-loop-service.ts) has already established that there IS
 * an assigner and that they are still active, so a payload that reaches here always has one; the guard
 * below is a belt-and-braces check against a hand-enqueued or replayed job.
 */
export async function handleTaskRepliedEvent(payload: any, _officeId: string | null) {
  console.log(`[Worker] task.replied: ${payload?.taskId} — ${payload?.taskTitle}`);
  if (!payload?.assignerId || !payload?.taskId) return;

  const { pool: workerPool } = await import("../db.js");
  const schemaName = await resolveUserSchema(workerPool as WorkerPool, payload.assignerId);
  if (!schemaName) return;

  const replier = typeof payload.authorName === "string" && payload.authorName.trim().length > 0
    ? payload.authorName.trim()
    : "The assignee";

  await insertNotification(workerPool as WorkerPool, schemaName, {
    userId: payload.assignerId,
    type: "task_replied",
    title: `${replier} replied to: ${payload.taskTitle ?? "a task"}`,
    // The reply text itself, so the bell says what was said rather than only that something was.
    // notifications.body is TEXT, but the popover renders it inline — a wall of text there is its own
    // failure, so it is capped and the full thread is one click away.
    body: typeof payload.replyBody === "string" ? payload.replyBody.slice(0, 500) : null,
    link: taskNotificationLink(payload.taskId),
  });
}
