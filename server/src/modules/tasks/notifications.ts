import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { sendSystemEmail } from "../../lib/resend-client.js";

type TenantDb = NodePgDatabase<typeof schema>;

type TaskAssignmentEmailInput = {
  task: {
    id: string;
    title: string;
    description?: string | null;
    dueDate?: string | Date | null;
  };
  assigneeId: string;
  assigner: {
    id: string;
    displayName: string;
    email: string;
  };
};

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

async function getAssigneeEmailRecipient(tenantDb: TenantDb, assigneeId: string) {
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
}

export function buildTaskAssignmentEmail(input: {
  task: TaskAssignmentEmailInput["task"];
  assignee: AssigneeEmailRecipient;
  assignerName: string;
}) {
  const link = taskUrl(input.task.id);
  const due = formatDueDate(input.task.dueDate);
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
    `Due: ${due}`,
    ...(description ? [`Description: ${description}`] : []),
    `Click here to open the task: ${link}`,
  ].join("\n");

  return { subject, html, text, link };
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

  const email = buildTaskAssignmentEmail({
    task: input.task,
    assignee,
    assignerName: input.assigner.displayName,
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
