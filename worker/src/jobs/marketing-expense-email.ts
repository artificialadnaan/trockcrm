import { pool } from "../db.js";
import { sendSystemEmailWithMetadata, type SendSystemEmailResult } from "../lib/system-email.js";
import { renderBrandedEmail, renderDetailRows, resolveFrontendUrl } from "../lib/branded-email.js";
import { escapeHtml, isSafeTenantSchema, normalizeText } from "../lib/email-format.js";
import {
  MARKETING_EXPENSE_EMAIL_JOB,
  formatMoney,
  isMarketingExpenseEmailKind,
  type MarketingExpenseEmailKind,
  type MarketingExpenseEmailPayload,
  type MarketingExpenseEmailSnapshot,
} from "@trock-crm/shared/types";

export { MARKETING_EXPENSE_EMAIL_JOB };

/** How long a purpose can run in an email body before it stops being a summary. */
const PURPOSE_PREVIEW_LIMIT = 280;

const GREEN = "#059669";
const RED = "#CC0000";

interface HandlerDeps {
  query?: typeof pool.query;
  sendEmail?: (
    to: string | string[],
    subject: string,
    html: string,
    options: { text: string; idempotencyKey: string },
  ) => Promise<SendSystemEmailResult>;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

interface BuildInput {
  requestId: string;
  snapshot: MarketingExpenseEmailSnapshot;
  officeId: string | null;
  frontendUrl: string;
}

/**
 * The three marketing & advertising expense emails: the approver's "needs your approval", the submitter's
 * confirmation, and the submitter's decision notice.
 *
 * TENANT SCHEMA COMES FROM THE PAYLOAD. `job_queue.office_id` is a `UUID REFERENCES offices(id)` — not a
 * schema name — which is why the reference handler for this shape discards its `officeId` argument
 * entirely. Taking it from the payload and validating it with `isSafeTenantSchema` is the whole contract.
 *
 * EXACTLY ONCE, via the 0174-shaped ledger:
 *   1. INSERT a CLAIM row carrying a frozen snapshot (ON CONFLICT DO NOTHING). Never deleted.
 *   2. Read the claim back. The FIRST-seen values win, so a retry after a rename or a recipient change
 *      rebuilds a byte-identical Resend payload and the idempotency key stays valid.
 *   3. Send, then stamp `sent_at`. Only after a durable send. A crash between claim and send leaves it
 *      NULL and the retry goes again.
 * A failed send THROWS, so the queue retries and eventually dead-letters, rather than completing the job
 * as though the mail had gone.
 */
export async function handleMarketingExpenseEmail(
  payload: MarketingExpenseEmailPayload,
  _officeId: string | null,
  deps: HandlerDeps = {},
): Promise<void> {
  const logger = deps.logger ?? console;
  const tenantSchema = payload?.tenantSchema;
  const requestId = normalizeText(payload?.requestId);
  const emailKind = payload?.emailKind;

  if (!isSafeTenantSchema(tenantSchema) || !requestId || !isMarketingExpenseEmailKind(emailKind)) {
    logger.warn("[MarketingExpenseEmail] Invalid job payload - skipping", {
      tenantSchema,
      requestId,
      emailKind,
    });
    return;
  }

  const stepOrder = Number.isInteger(payload.stepOrder) ? payload.stepOrder : 0;
  const query = deps.query ?? pool.query.bind(pool);
  const env = deps.env ?? process.env;

  const claimed = await query(
    `SELECT sent_at FROM public.marketing_expense_request_email_receipts
      WHERE tenant_schema = $1 AND request_id = $2::uuid AND email_kind = $3 AND step_order = $4
      LIMIT 1`,
    [tenantSchema, requestId, emailKind, stepOrder],
  );
  if (claimed.rows[0]?.sent_at != null) {
    logger.log("[MarketingExpenseEmail] Already sent - skipping", { requestId, emailKind, stepOrder });
    return;
  }

  const recipients = dedupeEmails(
    (Array.isArray(payload.recipientEmails) ? payload.recipientEmails : [])
      .map((email) => normalizeText(email))
      .filter((email): email is string => Boolean(email)),
  );
  // An empty recipient list is not a thing to log past. The server refuses a submit whose approver group is
  // empty, so reaching here with nobody to write to means the payload is wrong — fail loud, retry, and
  // eventually dead-letter, rather than completing as though somebody had been told.
  if (recipients.length === 0) {
    throw new Error(
      `[MarketingExpenseEmail] No recipient emails on the payload for ${emailKind} ${requestId} — refusing to complete.`,
    );
  }

  const snapshot = payload.snapshot ?? ({} as MarketingExpenseEmailSnapshot);
  await query(
    `INSERT INTO public.marketing_expense_request_email_receipts
       (tenant_schema, request_id, email_kind, step_order, request_number, requested_by_name, vendor_event,
        needed_by, total_requested, purpose, decision, decision_reason, recipient_emails, created_at, updated_at)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8::date, $9::numeric, $10, $11, $12, $13, NOW(), NOW())
     ON CONFLICT (tenant_schema, request_id, email_kind, step_order) DO NOTHING`,
    [
      tenantSchema,
      requestId,
      emailKind,
      stepOrder,
      snapshot.requestNumber ?? null,
      snapshot.requestedByName ?? null,
      snapshot.vendorEvent ?? null,
      snapshot.neededBy ?? null,
      snapshot.totalRequested ?? "0",
      snapshot.purpose ?? null,
      snapshot.decision ?? null,
      snapshot.decisionReason ?? null,
      recipients.join(", "),
    ],
  );

  // Read back the AUTHORITATIVE claim. On a retry this returns the FIRST attempt's values even though the
  // INSERT above was a no-op, which is exactly the point.
  const stored = await query(
    `SELECT request_number, requested_by_name, vendor_event, needed_by, total_requested, purpose,
            decision, decision_reason, recipient_emails
       FROM public.marketing_expense_request_email_receipts
      WHERE tenant_schema = $1 AND request_id = $2::uuid AND email_kind = $3 AND step_order = $4
      LIMIT 1`,
    [tenantSchema, requestId, emailKind, stepOrder],
  );
  const row = stored.rows[0];
  const frozen: MarketingExpenseEmailSnapshot = row
    ? {
        requestNumber: row.request_number ?? snapshot.requestNumber ?? "",
        requestedByName: row.requested_by_name ?? snapshot.requestedByName ?? "",
        vendorEvent: row.vendor_event ?? snapshot.vendorEvent ?? "",
        neededBy: toDateOnly(row.needed_by) ?? snapshot.neededBy ?? null,
        totalRequested: row.total_requested ?? snapshot.totalRequested ?? "0",
        purpose: row.purpose ?? snapshot.purpose ?? "",
        decision: row.decision ?? snapshot.decision ?? null,
        decisionReason: row.decision_reason ?? snapshot.decisionReason ?? null,
        requestStatus: snapshot.requestStatus,
      }
    : snapshot;
  const frozenRecipients =
    typeof row?.recipient_emails === "string" && row.recipient_emails.trim()
      ? row.recipient_emails.split(",").map((email: string) => email.trim()).filter(Boolean)
      : recipients;

  const buildInput: BuildInput = {
    requestId,
    snapshot: frozen,
    officeId: normalizeText(payload.officeId),
    frontendUrl: resolveFrontendUrl(env),
  };
  const email = buildEmail(emailKind, buildInput);

  try {
    const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;
    const result = await sendEmail(frozenRecipients, email.subject, email.html, {
      text: email.text,
      idempotencyKey: `marketing-expense-${emailKind}-${tenantSchema}-${requestId}-${stepOrder}`,
    });
    if (!result.success) throw new Error("Email provider returned unsuccessful result");

    // Stamp only after a durable send. `sent_at IS NULL` makes the first completer the winner if two runs
    // ever overlap; recipient_emails is deliberately NOT rewritten — the claim's list is what we sent to.
    await query(
      `UPDATE public.marketing_expense_request_email_receipts
          SET sent_at = NOW(), resend_message_id = $5, updated_at = NOW()
        WHERE tenant_schema = $1 AND request_id = $2::uuid AND email_kind = $3 AND step_order = $4
          AND sent_at IS NULL`,
      [tenantSchema, requestId, emailKind, stepOrder, result.messageId],
    );
    logger.log("[MarketingExpenseEmail] Sent", {
      requestId,
      emailKind,
      stepOrder,
      recipientCount: frozenRecipients.length,
      messageId: result.messageId,
    });
  } catch (error) {
    logger.error("[MarketingExpenseEmail] Failed to send", { requestId, emailKind, stepOrder, error });
    throw error;
  }
}

function buildEmail(kind: MarketingExpenseEmailKind, input: BuildInput) {
  switch (kind) {
    case "submitted_approver":
      return buildMarketingExpenseApproverEmail(input);
    case "submitted_submitter":
      return buildMarketingExpenseSubmitterEmail(input);
    case "decided_submitter":
      return buildMarketingExpenseDecisionEmail(input);
  }
}

// ─── email bodies ────────────────────────────────────────────────────────────

export function buildMarketingExpenseApproverEmail(input: BuildInput) {
  const { snapshot } = input;
  const amount = formatMoney(snapshot.totalRequested);
  const subject = `Marketing expense request ${snapshot.requestNumber} — ${amount} — needs your approval`;
  const queueUrl = withOffice(`${baseUrl(input)}/admin/marketing-expense-requests`, input.officeId);

  const bodyHtml = `
    ${renderDetailRows([
      ["Requested by", snapshot.requestedByName],
      ["Vendor / event", snapshot.vendorEvent],
      ["Needed by", snapshot.neededBy ?? "Not specified"],
      ["Total requested", amount],
    ])}
    <p style="margin:18px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#111111;">
      <strong>What it is for</strong><br />${escapeHtml(truncate(snapshot.purpose))}
    </p>`;

  const html = renderBrandedEmail({
    title: `Expense request ${snapshot.requestNumber}`,
    preheader: `${snapshot.requestedByName} is requesting ${amount} for ${snapshot.vendorEvent}.`,
    bodyHtml,
    primaryLabel: "Review & Decide",
    primaryUrl: queueUrl,
  });

  const text =
    `${snapshot.requestedByName} submitted marketing expense request ${snapshot.requestNumber} for ${amount} ` +
    `(${snapshot.vendorEvent}${snapshot.neededBy ? `, needed by ${snapshot.neededBy}` : ""}). ` +
    `What it is for: ${truncate(snapshot.purpose)} Review & decide: ${queueUrl}`;

  return { subject, html, text };
}

export function buildMarketingExpenseSubmitterEmail(input: BuildInput) {
  const { snapshot } = input;
  const amount = formatMoney(snapshot.totalRequested);
  const subject = `We received your marketing expense request ${snapshot.requestNumber}`;
  // The submitter's OWN status page. Linking them at the approver queue would be a 403 for the rep who
  // just filled the form in.
  const statusUrl = withOffice(`${baseUrl(input)}/marketing-expense-requests`, input.officeId);

  const bodyHtml = `
    ${renderDetailRows([
      ["Request", snapshot.requestNumber],
      ["Vendor / event", snapshot.vendorEvent],
      ["Needed by", snapshot.neededBy ?? "Not specified"],
      ["Total requested", amount],
    ])}
    <p style="margin:18px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#111111;">
      It has gone to the marketing expense approver. You will get another email the moment there is a
      decision, and you can check the status of this and every other request you have submitted at any time.
    </p>`;

  const html = renderBrandedEmail({
    title: `Request ${snapshot.requestNumber} received`,
    preheader: `${amount} for ${snapshot.vendorEvent} is now with the approver.`,
    bodyHtml,
    primaryLabel: "View My Requests",
    primaryUrl: statusUrl,
  });

  const text =
    `We received your marketing expense request ${snapshot.requestNumber} for ${amount} ` +
    `(${snapshot.vendorEvent}). It is now with the marketing expense approver, and you will get another ` +
    `email when it is decided. Your requests: ${statusUrl}`;

  return { subject, html, text };
}

export function buildMarketingExpenseDecisionEmail(input: BuildInput) {
  const { snapshot } = input;
  const approved = snapshot.decision === "approved";
  const amount = formatMoney(snapshot.totalRequested);
  const verdict = approved ? "approved" : "denied";
  const statusUrl = withOffice(`${baseUrl(input)}/marketing-expense-requests`, input.officeId);
  const accent = approved ? GREEN : RED;

  // An approval that does NOT finalise the parent still has a step outstanding. Saying "approved" and
  // stopping there would read as "you may spend the money".
  const stillOutstanding = approved && snapshot.requestStatus === "pending";

  // The SUBJECT has to carry that too, not just the body. People act on subject lines without opening the
  // mail, and "was approved" at step 1 of 2 is an instruction to go and spend money that nobody has
  // authorised yet. Inert today at one step; `steps_required` exists so that day arrives without a rebuild.
  const subject = stillOutstanding
    ? `Marketing expense request ${snapshot.requestNumber} — one approval done, still awaiting final approval`
    : `Marketing expense request ${snapshot.requestNumber} was ${verdict}`;
  const closing = stillOutstanding
    ? "One approval step is done and the request is still moving — it is not finally approved yet."
    : approved
      ? "Your request is approved. Keep this email with your receipts."
      : "Your request was not approved.";

  const reasonBlock =
    !approved && snapshot.decisionReason
      ? `
    <p style="margin:18px 0 0 0;padding:12px 14px;background-color:#fef2f2;border-left:4px solid ${RED};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#111111;">
      <strong>Reason</strong><br />${escapeHtml(snapshot.decisionReason)}
    </p>`
      : "";

  const bodyHtml = `
    <p style="margin:0 0 4px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:${accent};font-weight:bold;">
      ${approved ? "Approved" : "Denied"}
    </p>
    ${renderDetailRows([
      ["Request", snapshot.requestNumber],
      ["Vendor / event", snapshot.vendorEvent],
      ["Total requested", amount],
    ])}${reasonBlock}
    <p style="margin:18px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#111111;">
      ${escapeHtml(closing)}
    </p>`;

  const html = renderBrandedEmail({
    title: `Request ${snapshot.requestNumber} ${verdict}`,
    preheader: `${amount} for ${snapshot.vendorEvent} was ${verdict}.`,
    bodyHtml,
    primaryLabel: "View My Requests",
    primaryUrl: statusUrl,
  });

  const text =
    `Your marketing expense request ${snapshot.requestNumber} (${amount}, ${snapshot.vendorEvent}) was ${verdict}.` +
    (!approved && snapshot.decisionReason ? ` Reason: ${snapshot.decisionReason}` : "") +
    ` ${closing} Your requests: ${statusUrl}`;

  return { subject, html, text };
}

// ─── local utilities ─────────────────────────────────────────────────────────

function baseUrl(input: BuildInput): string {
  return input.frontendUrl.replace(/\/+$/, "");
}

/** Carry the office so a recipient whose default office differs does not land on an empty page. */
function withOffice(url: string, officeId: string | null): string {
  return officeId ? `${url}?officeId=${encodeURIComponent(officeId)}` : url;
}

function truncate(value: string): string {
  const text = value ?? "";
  return text.length > PURPOSE_PREVIEW_LIMIT ? `${text.slice(0, PURPOSE_PREVIEW_LIMIT).trimEnd()}…` : text;
}

/** `date` comes back as a Date from node-postgres and as a string from PGlite. Both render as YYYY-MM-DD. */
function toDateOnly(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** Case-insensitive dedup, preserving first-seen casing. Mirrors rfp-rejection-email.ts. */
function dedupeEmails(emails: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const email of emails) {
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}
