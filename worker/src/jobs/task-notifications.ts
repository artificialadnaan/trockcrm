/**
 * In-app notifications for the task loop: `task.assigned` (existing, moved here) and `task.replied`
 * (new). Assignment rows live with the event; reply rows live in the recipient's readable notification
 * tenant while their deep link retains the task's event office. Both emit PG NOTIFY.
 *
 * ⚠️ THE NOTIFY DOES NOT CURRENTLY REACH A LISTENER, and this file must not claim otherwise. The only
 * `LISTEN crm_events` in the repository is worker/src/listener.ts, whose callback logs; the server's
 * SSE manager consumes its own in-process eventBus and never sees a worker-emitted event. So the row
 * is correct-on-open, not live — the bell shows it the next time the popover fetches, which is also
 * the only time it fetches. Bridging worker NOTIFY into the server's SSE process is a platform-level
 * change well outside this feature, and the closed loop is deliberately designed around the EMAIL as
 * the channel that actually arrives. The NOTIFY is kept because it costs nothing and becomes correct
 * the day that bridge exists.
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

import { resolveOfficeSchema, type OfficeSchemaPool } from "./office-schema.js";

type WorkerPool = OfficeSchemaPool;

/**
 * `notifications.title` is VARCHAR(500) (0001_initial). Every title here is COMPOSED -- a fixed
 * prefix plus a user-supplied task title, which is itself VARCHAR(500) -- so the sum can exceed the
 * column even though neither part does.
 *
 * That matters more than a truncated string, because this runs inside a DURABLE job: an over-long
 * title does not lose a bell row, it fails the INSERT, burns a retry, and eventually dead-letters the
 * job -- after the comment and the email have already succeeded. The least important of the three
 * channels would be consuming the retry budget that exists for the important ones.
 *
 * The ellipsis is inside the budget, so the result is always <= the limit.
 */
const NOTIFICATION_TITLE_MAX = 500;

function capNotificationTitle(title: string) {
  if (title.length <= NOTIFICATION_TITLE_MAX) return title;
  return `${title.slice(0, NOTIFICATION_TITLE_MAX - 1)}\u2026`;
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

  // See the file header: nothing in the server process listens for this yet.
  await workerPool.query(`SELECT pg_notify('crm_events', $1)`, [
    JSON.stringify({
      eventName: "notification.created",
      userId: row.userId,
      notificationId: result.rows[0]?.id,
    }),
  ]);
}

/**
 * Deep link to the task itself.
 *
 * `task_assigned` linked to the bare `/tasks` list until now, which dropped the recipient into an
 * unfiltered list and made them hunt for the task they had just been told about.
 *
 * ⚠️ IT CARRIES ?officeId, AND THAT IS NOT DECORATION. Office context in the CRM is URL-DRIVEN:
 * client/src/lib/api.ts reads `?officeId` off window.location and injects it as the `x-office-id`
 * header; with no param the server falls back to the reader's own active office. So a bare
 * `/tasks/<id>` for a task in another office resolves against the WRONG schema and 404s — the same
 * standing trap that sent property-edit users home. The office is appended only when known, so a
 * single-office link is byte-identical to what it was.
 */
export function taskNotificationLink(
  taskId: string | null | undefined,
  officeId?: string | null
) {
  if (!taskId) return "/tasks";
  const path = `/tasks/${encodeURIComponent(taskId)}`;
  return officeId ? `${path}?officeId=${encodeURIComponent(officeId)}` : path;
}

export async function handleTaskAssignedEvent(payload: any, officeId: string | null) {
  console.log(`[Worker] task.assigned: ${payload?.taskId} — ${payload?.title}`);
  if (!payload?.assignedTo) return;

  const { pool: workerPool } = await import("../db.js");
  // The EVENT's office, with the assignee's home office only as a fallback — see office-schema.ts.
  const resolved = await resolveOfficeSchema(workerPool as WorkerPool, officeId, payload.assignedTo);
  if (!resolved) return;

  await insertNotification(workerPool as WorkerPool, resolved.schemaName, {
    userId: payload.assignedTo,
    type: "task_assigned",
    title: capNotificationTitle(`New task assigned: ${payload.title}`),
    body: payload.title,
    link: taskNotificationLink(payload.taskId, resolved.officeId),
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
export async function handleTaskRepliedEvent(payload: any, officeId: string | null) {
  console.log(`[Worker] task.replied: ${payload?.taskId} — ${payload?.taskTitle}`);
  if (!payload?.assignerId || !payload?.taskId) return;

  const { pool: workerPool } = await import("../db.js");
  // Notifications are read from the recipient's active/home tenant, which can differ from the office
  // holding the task. Store the bell row where the assigner can actually see it, but keep the EVENT
  // office on the link below so opening the notification still resolves the cross-office task.
  const recipientStore = await resolveOfficeSchema(workerPool as WorkerPool, null, payload.assignerId);
  if (!recipientStore) return;

  const replier = typeof payload.authorName === "string" && payload.authorName.trim().length > 0
    ? payload.authorName.trim()
    : "The assignee";

  await insertNotification(workerPool as WorkerPool, recipientStore.schemaName, {
    userId: payload.assignerId,
    type: "task_replied",
    title: capNotificationTitle(`${replier} replied to: ${payload.taskTitle ?? "a task"}`),
    // The reply text itself, so the bell says what was said rather than only that something was.
    // notifications.body is TEXT, but the popover renders it inline — a wall of text there is its own
    // failure, so it is capped and the full thread is one click away.
    body: typeof payload.replyBody === "string" ? payload.replyBody.slice(0, 500) : null,
    // Legacy jobs have no event office; their recipient store is the only safe fallback.
    link: taskNotificationLink(payload.taskId, officeId ?? recipientStore.officeId),
  });
}
