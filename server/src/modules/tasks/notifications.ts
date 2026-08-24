import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { formatDealDisplayNumber } from "@trock-crm/shared/types";
import { sendSystemEmail } from "../../lib/resend-client.js";

type TenantDb = NodePgDatabase<typeof schema>;

type TaskAssignmentEmailInput = {
  task: {
    id: string;
    title: string;
    description?: string | null;
    dueDate?: string | Date | null;
    dealId?: string | null;
  };
  assigneeId: string;
  assigner: {
    id: string;
    displayName: string;
    email: string;
  };
};

type LinkedProject = {
  name: string | null;
  dealNumber: string | null;
  projectNumber: string | null;
};

/**
 * "This task has no project" and "we could not read this task's project" are different facts, and
 * printing the first when the second is true is the same wrong-by-omission the Project line exists
 * to fix. Keep them distinct all the way to the label.
 */
type ProjectResolution =
  | { kind: "none" }
  | { kind: "resolved"; project: LinkedProject }
  | { kind: "unavailable" };

export const NO_PROJECT_LABEL = "No project linked";
export const UNAVAILABLE_PROJECT_LABEL = "Unavailable — open the task to see it";

export type PreparedTaskAssignmentEmail = {
  to: string;
  subject: string;
  html: string;
  options: {
    cc: string;
    text: string;
  };
};

type AssigneeEmailRecipient = {
  id: string;
  email: string;
  displayName: string;
  firstName: string | null;
};

function frontendBaseUrl() {
  return (process.env.FRONTEND_URL?.trim() || "https://trockcrm.com").replace(/\/+$/, "");
}

function taskUrl(taskId: string) {
  return `${frontendBaseUrl()}/tasks/${encodeURIComponent(taskId)}`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeSubject(value: string) {
  return value.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function firstNameFor(recipient: AssigneeEmailRecipient) {
  const fromFirstName = recipient.firstName?.trim();
  if (fromFirstName) return fromFirstName;
  return recipient.displayName.trim().split(/\s+/)[0] || recipient.displayName;
}

function formatDueDate(dueDate: string | Date | null | undefined) {
  if (!dueDate) return "No due date";
  if (dueDate instanceof Date) return dueDate.toLocaleDateString("en-US", { timeZone: "America/Chicago" });
  return dueDate;
}

/**
 * Human-facing label for the task's linked project, using the same resolver the web app uses so the
 * email and the CRM never disagree — and so the meaningless HubSpot deal id is never shown.
 */
export function formatLinkedProjectLabel(resolution: ProjectResolution): string {
  if (resolution.kind === "none") return NO_PROJECT_LABEL;
  if (resolution.kind === "unavailable") return UNAVAILABLE_PROJECT_LABEL;

  const { project } = resolution;
  const display = formatDealDisplayNumber(project);
  const name = project.name?.trim();

  // Same shape the task row uses (getTaskProjectContext), so the email and the CRM never disagree.
  if (name) return display.isPending ? name : `${display.label} - ${name}`;
  return display.isPending ? "Project linked" : display.label;
}

/**
 * The task transaction can no longer be protected, so the caller MUST NOT commit.
 *
 * Distinct from ordinary email failures, which are best-effort and deliberately swallowed: this one
 * has to escape the route's best-effort wrapper or the request would commit an aborted transaction
 * (a silent rollback) and still report success.
 */
export class TaskTransactionUnusableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "TaskTransactionUnusableError";
  }
}

// Fixed statements — no interpolation, so the savepoint name can never be caller-controlled.
const SAVEPOINT_OPEN = sql`SAVEPOINT task_assignment_email_read`;
const SAVEPOINT_RELEASE = sql`RELEASE SAVEPOINT task_assignment_email_read`;
const SAVEPOINT_ROLLBACK = sql`ROLLBACK TO SAVEPOINT task_assignment_email_read`;

/**
 * Run a best-effort read inside the caller's ALREADY-OPEN task transaction without risking it.
 *
 * `routes.ts` prepares this email before `commitTransaction()`. In PostgreSQL a failed statement
 * aborts the whole transaction, and catching the error in JS does NOT recover it — the later COMMIT
 * silently degrades to a ROLLBACK *without throwing*, so the task write would be lost while the
 * route still returned success and sent the assignee a deep link to a task that never existed.
 * A SAVEPOINT keeps any failure local to the read.
 */
async function readInSavepoint<T>(tenantDb: TenantDb, read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    await tenantDb.execute(SAVEPOINT_OPEN);
  } catch (err) {
    // A failing SAVEPOINT means the transaction is ALREADY unusable (e.g. 25P02
    // in_failed_sql_transaction) — and the failed statement leaves it that way. Returning a fallback
    // here would let the caller COMMIT, which degrades to a silent ROLLBACK while the route still
    // reports success. There is nothing to roll back to, so the request must fail.
    throw new TaskTransactionUnusableError("Could not open a savepoint for the assignment-email read", err);
  }

  try {
    const value = await read();
    await tenantDb.execute(SAVEPOINT_RELEASE);
    return value;
  } catch (err) {
    if (err instanceof TaskTransactionUnusableError) throw err;
    console.error("[Tasks] Assignment-email read failed; rolling back to savepoint:", err);
    try {
      await tenantDb.execute(SAVEPOINT_ROLLBACK);
    } catch (rollbackErr) {
      // Same reasoning: if we cannot get back to a good state, the caller must not commit.
      throw new TaskTransactionUnusableError(
        "Could not roll back to the assignment-email savepoint",
        rollbackErr
      );
    }
    return fallback;
  }
}

async function resolveLinkedProject(
  tenantDb: TenantDb,
  dealId: string | null | undefined
): Promise<ProjectResolution> {
  if (!dealId) return { kind: "none" };

  // Best-effort: a task assignment must still notify the assignee if this lookup fails — but it
  // must not then claim the task has no project, nor take the task transaction down with it.
  return readInSavepoint<ProjectResolution>(
    tenantDb,
    async () => {
      const [deal] = await tenantDb
        .select({
          name: deals.name,
          dealNumber: deals.dealNumber,
          projectNumber: deals.projectNumber,
        })
        .from(deals)
        .where(eq(deals.id, dealId))
        .limit(1);

      if (!deal) return { kind: "unavailable" };
      return { kind: "resolved", project: deal as LinkedProject };
    },
    { kind: "unavailable" }
  );
}

async function getAssigneeEmailRecipient(tenantDb: TenantDb, assigneeId: string) {
  // Savepointed for the same reason as the project lookup: this runs inside the open task
  // transaction, so its failure must not abort the task write.
  return readInSavepoint<AssigneeEmailRecipient | null>(
    tenantDb,
    async () => {
      const [assignee] = await tenantDb
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          firstName: users.firstName,
        })
        .from(users)
        .where(eq(users.id, assigneeId))
        .limit(1);

      return (assignee ?? null) as AssigneeEmailRecipient | null;
    },
    null
  );
}

export function buildTaskAssignmentEmail(input: {
  task: TaskAssignmentEmailInput["task"];
  assignee: AssigneeEmailRecipient;
  assignerName: string;
  project?: ProjectResolution;
}) {
  const link = taskUrl(input.task.id);
  const due = formatDueDate(input.task.dueDate);
  const project = formatLinkedProjectLabel(input.project ?? { kind: "none" });
  const assigneeFirstName = firstNameFor(input.assignee);
  const description = input.task.description?.trim() || null;
  const subject = `New task assigned: ${sanitizeSubject(input.task.title)}`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;color:#111827;line-height:1.5;">
      <p>Hi ${escapeHtml(assigneeFirstName)},</p>
      <p>${escapeHtml(input.assignerName)} assigned you a task: ${escapeHtml(input.task.title)}</p>
      <p>Project: ${escapeHtml(project)}</p>
      <p>Due: ${escapeHtml(due)}</p>
      ${description ? `<p>Description: ${escapeHtml(description)}</p>` : ""}
      <p>Click here to open the task: <a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>
    </div>
  </div>
</body>
</html>`;

  const text = [
    `Hi ${assigneeFirstName},`,
    "",
    `${input.assignerName} assigned you a task: ${input.task.title}`,
    `Project: ${project}`,
    `Due: ${due}`,
    ...(description ? [`Description: ${description}`] : []),
    `Click here to open the task: ${link}`,
  ].join("\n");

  return { subject, html, text, link };
}

// ---------------------------------------------------------------------------------------------
// F4 — task closed loop: the reply email back to the assigner
// ---------------------------------------------------------------------------------------------

type TaskReplyEmailRecipient = {
  id: string;
  email: string;
  displayName: string;
  firstName: string | null;
};

export type TaskReplyEmailInput = {
  task: { id: string; title: string };
  assigner: TaskReplyEmailRecipient;
  authorName: string | null;
  replyBody: string;
  repliedAt: string;
};

export type PreparedTaskReplyEmail = {
  to: string;
  subject: string;
  html: string;
  options: { text: string };
};

/** The one-click close CTA. No token auth — it deep-links to the task with the complete action
 *  focused, so the assigner still authenticates as themselves before anything is written. */
function taskCompleteUrl(taskId: string) {
  return `${taskUrl(taskId)}?complete=1`;
}

/** HTML-escape first, THEN turn newlines into <br> — the reverse order would emit unescaped markup. */
function escapeHtmlWithBreaks(value: string) {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, "<br />");
}

function formatRepliedAt(repliedAt: string) {
  const date = new Date(repliedAt);
  if (Number.isNaN(date.getTime())) return repliedAt;
  return date.toLocaleString("en-US", { timeZone: "America/Chicago" });
}

/**
 * "<Name> replied to: <task title>" — with the reply text IN the email.
 *
 * The ask is explicit that the assigner should be told "that they replied AND what they replied", and
 * this is the channel that actually gets there: worker-written in-app notifications never push over
 * SSE, and the bell only fetches while its popover is open. An email that says "you have a reply" and
 * nothing else makes the assigner open the CRM to read one sentence.
 */
export function buildTaskReplyEmail(input: TaskReplyEmailInput) {
  const link = taskUrl(input.task.id);
  const completeLink = taskCompleteUrl(input.task.id);
  const assignerFirstName = firstNameFor(input.assigner);
  // A display name is nullable on public.users, and "  replied to: X" reads as a bug.
  const replier = input.authorName?.trim() || "The assignee";
  const when = formatRepliedAt(input.repliedAt);
  const subject = sanitizeSubject(`${replier} replied to: ${input.task.title}`);

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;color:#111827;line-height:1.5;">
      <p>Hi ${escapeHtml(assignerFirstName)},</p>
      <p>${escapeHtml(replier)} replied to the task you assigned: ${escapeHtml(input.task.title)}</p>
      <blockquote style="margin:16px 0;padding:12px 16px;border-left:4px solid #e5e7eb;background:#f9fafb;color:#111827;">
        ${escapeHtmlWithBreaks(input.replyBody)}
      </blockquote>
      <p style="color:#6b7280;font-size:13px;">${escapeHtml(replier)} &middot; ${escapeHtml(when)}</p>
      <p>
        <a href="${escapeHtml(link)}">Open the task</a>
        &nbsp;&nbsp;|&nbsp;&nbsp;
        <a href="${escapeHtml(completeLink)}">Mark complete</a>
      </p>
      <p style="color:#6b7280;font-size:12px;">${escapeHtml(link)}</p>
    </div>
  </div>
</body>
</html>`;

  const text = [
    `Hi ${assignerFirstName},`,
    "",
    `${replier} replied to the task you assigned: ${input.task.title}`,
    "",
    input.replyBody,
    "",
    `${replier} - ${when}`,
    "",
    `Open the task: ${link}`,
    `Mark complete: ${completeLink}`,
  ].join("\n");

  return { subject, html, text, link, completeLink };
}

export async function prepareTaskReplyEmail(
  tenantDb: TenantDb,
  input: {
    task: { id: string; title: string };
    assignerId: string;
    authorName: string | null;
    replyBody: string;
    repliedAt: string;
  }
): Promise<PreparedTaskReplyEmail | null> {
  // Savepointed for the same reason the assignment reads are: this runs inside the OPEN comment
  // transaction, and a failed statement in Postgres poisons the whole transaction — the later COMMIT
  // would silently degrade to a ROLLBACK while the route still reported the comment as posted.
  const assigner = await readInSavepoint<TaskReplyEmailRecipient | null>(
    tenantDb,
    async () => {
      const [row] = await tenantDb
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          firstName: users.firstName,
        })
        .from(users)
        .where(eq(users.id, input.assignerId))
        .limit(1);
      return (row ?? null) as TaskReplyEmailRecipient | null;
    },
    null
  );

  if (!assigner?.email) {
    console.warn("[Tasks] No assigner email found — skipping task reply email");
    return null;
  }

  const email = buildTaskReplyEmail({
    task: input.task,
    assigner,
    authorName: input.authorName,
    replyBody: input.replyBody,
    repliedAt: input.repliedAt,
  });

  return {
    to: assigner.email,
    subject: email.subject,
    html: email.html,
    options: { text: email.text },
  };
}

export async function sendPreparedTaskReplyEmail(email: PreparedTaskReplyEmail) {
  return sendSystemEmail(email.to, email.subject, email.html, email.options);
}

export async function prepareTaskAssignmentEmail(
  tenantDb: TenantDb,
  input: TaskAssignmentEmailInput
): Promise<PreparedTaskAssignmentEmail | null> {
  const assignee = await getAssigneeEmailRecipient(tenantDb, input.assigneeId);
  if (!assignee?.email) {
    console.warn("[Tasks] No assignee email found — skipping task assignment email");
    return null;
  }

  const project = await resolveLinkedProject(tenantDb, input.task.dealId);

  const email = buildTaskAssignmentEmail({
    task: input.task,
    assignee,
    assignerName: input.assigner.displayName,
    project,
  });

  return {
    to: assignee.email,
    subject: email.subject,
    html: email.html,
    options: {
      cc: input.assigner.email,
      text: email.text,
    },
  };
}

export async function sendPreparedTaskAssignmentEmail(email: PreparedTaskAssignmentEmail) {
  return sendSystemEmail(email.to, email.subject, email.html, email.options);
}

export async function sendTaskAssignmentEmail(
  tenantDb: TenantDb,
  input: TaskAssignmentEmailInput
): Promise<boolean> {
  const email = await prepareTaskAssignmentEmail(tenantDb, input);
  if (!email) return false;
  return sendPreparedTaskAssignmentEmail(email);
}
