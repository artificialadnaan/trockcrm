import { pool } from "../db.js";
import { sendSystemEmailWithMetadata, type SendSystemEmailResult } from "../lib/system-email.js";
// Reuse #611's now-merged frontend-URL + branded-template primitives so the RFP-decline email points at
// trockcrm.com (never the old crm.trockconstruction.com) and matches the project-number email's look.
import { resolveFrontendUrl, TROCK_LOGO_EMAIL_URL } from "./project-number-email.js";
// Single source of truth shared with the server's override-review gate: the notified leadership set and the
// authorized-reviewer set both derive from RFP_REJECTION_EMAIL_RECIPIENTS, so they can never drift apart.
import {
  resolveRfpReviewerEmails,
  DEFAULT_NON_PROD_RFP_REVIEWER,
} from "@trock-crm/shared/lib/rfpReviewerEmails";

export const RFP_REJECTED_JOB = "rfp_rejected_email";

interface RfpRejectedPayload {
  tenantSchema?: string;
  dealId?: string;
  dealNumber?: string | null;
  dealName?: string;
  declinedReason?: string | null;
  rfpApprovalRequestId?: number;
  requestedByUserId?: string | null;
}

interface HandlerDeps {
  query?: typeof pool.query;
  sendEmail?: (
    to: string | string[],
    subject: string,
    html: string,
    options: { text: string; idempotencyKey: string }
  ) => Promise<SendSystemEmailResult>;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Email the requesting rep + the configured leadership recipients (Takashi + Adam Shaw) when a deal's
 * RFP is declined. Enqueued by migration 0148's `deals_rfp_rejected_email_trg` on the pending->declined
 * transition.
 *
 * Recipients = [requesting rep (resolved per-deal from rfp_approval_requested_by)] + RFP_REJECTION_EMAIL_RECIPIENTS.
 * If the rep can't be resolved (null/missing user), the email STILL goes to the env recipients — the rep
 * lookup degrading must not drop Takashi/Adam. If the env recipients are unset, that's a hard error
 * (re-thrown so the job retries then dead-letters), since the notification can't reach its primary audience.
 *
 * Exactly-once per rejection cycle: keyed (tenant_schema, deal_id, rfp_approval_request_id) via the
 * receipts ledger + the Resend idempotencyKey. A re-delivered decline makes no transition (no enqueue);
 * a genuine re-open issues a new request id -> a fresh cycle -> a new send.
 */
export async function handleRfpRejectedEmail(
  payload: RfpRejectedPayload,
  _officeId: string | null,
  deps: HandlerDeps = {}
) {
  const logger = deps.logger ?? console;
  const tenantSchema = payload.tenantSchema;
  const dealId = payload.dealId;
  const rfpApprovalRequestId = normalizePositiveInt(payload.rfpApprovalRequestId);
  if (!isSafeTenantSchema(tenantSchema) || !dealId || rfpApprovalRequestId == null) {
    logger.warn("[RfpRejectedEmail] Invalid job payload - skipping", { tenantSchema, dealId, rfpApprovalRequestId });
    return;
  }

  const envRecipients = resolveRfpRejectionRecipients(deps.env ?? process.env);
  if (envRecipients.length === 0) {
    const error = new Error("RFP_REJECTION_EMAIL_RECIPIENTS is not configured");
    // error (not warn): the primary leadership audience (Takashi + Adam) is missing, so the
    // notification cannot reach its intended recipients. Logged loudly and re-thrown so the failure is
    // VISIBLE and the job retries (then dead-letters after max_attempts) instead of silently no-op'ing.
    logger.error(
      "[RfpRejectedEmail] RFP_REJECTION_EMAIL_RECIPIENTS is not set - cannot send the RFP-decline notification. Set it (comma-separated) on the worker service; the job retries a few times, then dead-letters.",
      { dealId, rfpApprovalRequestId }
    );
    throw error;
  }

  const query = deps.query ?? pool.query.bind(pool);

  // Exactly-once guard: skip if this rejection cycle already sent.
  const receiptResult = await query(
    `SELECT resend_message_id, sent_at
       FROM public.rfp_rejection_email_receipts
      WHERE tenant_schema = $1
        AND deal_id = $2::uuid
        AND rfp_approval_request_id = $3
      LIMIT 1`,
    [tenantSchema, dealId, rfpApprovalRequestId]
  );
  if (receiptResult.rows.length > 0) {
    logger.log("[RfpRejectedEmail] Notification already sent - skipping duplicate job", {
      dealId,
      rfpApprovalRequestId,
      messageId: receiptResult.rows[0]?.resend_message_id ?? null,
    });
    return;
  }

  // Resolve the requesting rep's email (dynamic, per-deal). This is the REQUESTER
  // (rfp_approval_requested_by), not the assigned rep. Degrade gracefully: a missing/unresolvable
  // requester must NOT drop the leadership recipients.
  const requestedByUserId = normalizeText(payload.requestedByUserId);
  let requesterEmail: string | null = null;
  if (requestedByUserId) {
    const repResult = await query(
      `SELECT email FROM public.users WHERE id = $1::uuid LIMIT 1`,
      [requestedByUserId]
    );
    requesterEmail = normalizeText(repResult.rows[0]?.email ?? null);
    if (!requesterEmail) {
      logger.warn(
        "[RfpRejectedEmail] Requesting rep could not be resolved to an email - sending to leadership recipients only",
        { dealId, rfpApprovalRequestId, requestedByUserId }
      );
    }
  } else {
    logger.warn(
      "[RfpRejectedEmail] No requesting-rep id on the decline - sending to leadership recipients only",
      { dealId, rfpApprovalRequestId }
    );
  }

  // Final recipient list = [requesting rep] + [env recipients], de-duplicated case-insensitively so the
  // rep is never double-emailed if they also appear in the env list (the three are normally distinct).
  const recipients = dedupeEmails([...(requesterEmail ? [requesterEmail] : []), ...envRecipients]);

  // Re-read the deal for the office id (threads the deal's tenant into the link so cross-office
  // recipients like leadership don't 404 - the #611 P1 fix). The display fields come from the payload
  // snapshot taken at decline time, so the email reflects the rejection that fired it.
  const officeResult = await query(
    `SELECT id
       FROM public.offices
      WHERE ('office_' || slug) = $1
        AND is_active = true
      LIMIT 1`,
    [tenantSchema]
  );
  const officeId = (officeResult.rows[0]?.id as string | undefined) ?? null;

  const email = buildRfpRejectionEmail({
    dealId,
    dealName: normalizeText(payload.dealName) ?? "Deal",
    dealNumber: normalizeText(payload.dealNumber),
    declinedReason: normalizeText(payload.declinedReason),
    officeId,
    frontendUrl: resolveFrontendUrl(deps.env ?? process.env),
  });

  try {
    const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;
    const sendResult = await sendEmail(recipients, email.subject, email.html, {
      text: email.text,
      idempotencyKey: `rfp-rejected-${tenantSchema}-${dealId}-${rfpApprovalRequestId}`,
    });
    if (!sendResult.success) {
      throw new Error("Email provider returned unsuccessful result");
    }
    await query(
      `INSERT INTO public.rfp_rejection_email_receipts (
          tenant_schema,
          deal_id,
          rfp_approval_request_id,
          deal_number,
          recipient_emails,
          resend_message_id,
          sent_at,
          updated_at
        )
        VALUES ($1, $2::uuid, $3, $4, $5, $6, NOW(), NOW())
        ON CONFLICT (tenant_schema, deal_id, rfp_approval_request_id) DO UPDATE
          SET recipient_emails = EXCLUDED.recipient_emails,
              resend_message_id = EXCLUDED.resend_message_id,
              sent_at = EXCLUDED.sent_at,
              updated_at = NOW()`,
      [tenantSchema, dealId, rfpApprovalRequestId, email.dealNumber, recipients.join(", "), sendResult.messageId]
    );
    logger.log("[RfpRejectedEmail] Sent RFP-decline notification", {
      dealId,
      rfpApprovalRequestId,
      recipientCount: recipients.length,
      hadRequesterEmail: requesterEmail != null,
      messageId: sendResult.messageId,
    });
  } catch (error) {
    logger.error("[RfpRejectedEmail] Failed to send RFP-decline notification", {
      dealId,
      rfpApprovalRequestId,
      error,
    });
    throw error;
  }
}

export const DEFAULT_NON_PROD_RFP_REJECTION_RECIPIENTS = DEFAULT_NON_PROD_RFP_REVIEWER;

/**
 * Leadership recipients (Takashi + Adam Shaw) from RFP_REJECTION_EMAIL_RECIPIENTS — comma-separated,
 * trimmed, de-duplicated, never hardcoded. In dev/test only, falls back to a single dev address so
 * local runs work; in any other env (incl. a misconfigured prod) it returns [] so the handler fails loudly.
 *
 * Delegates to the shared resolver so this notified set stays identical to the server-side reviewer
 * allowlist (one config, RFP_REJECTION_EMAIL_RECIPIENTS).
 */
export function resolveRfpRejectionRecipients(env: NodeJS.ProcessEnv): string[] {
  return resolveRfpReviewerEmails(env);
}

export function buildRfpRejectionEmail(input: {
  dealId: string;
  dealName: string;
  dealNumber: string | null;
  declinedReason: string | null;
  officeId?: string | null;
  frontendUrl: string;
}) {
  // Deal URL: /deals/{id}?officeId={deal's office}. The officeId carries the deal's tenant so the link
  // loads the correct office even for a recipient whose default office differs (leadership often is
  // cross-office) - without it /deals/{id} queries the recipient's default office and 404s a cross-office
  // deal. This mirrors #611's project-number link builder (its Codex P1 fix); it appends ONLY officeId.
  const officeParam = input.officeId ? `?officeId=${encodeURIComponent(input.officeId)}` : "";
  const baseUrl = input.frontendUrl.replace(/\/+$/, "");
  const dealUrl = `${baseUrl}/deals/${encodeURIComponent(input.dealId)}${officeParam}`;
  const safeDealUrl = escapeHtml(dealUrl);
  // Primary CTA: the dedicated override-review page for THIS deal. Takashi & Adam land here to approve the
  // override (re-submit the RFP to SyncHub) or re-confirm the denial. officeId carries the deal's tenant so
  // a cross-office reviewer doesn't 404 (same #611 rationale as the deal link above).
  const reviewUrl = `${baseUrl}/rfp-review/${encodeURIComponent(input.dealId)}${officeParam}`;
  const safeReviewUrl = escapeHtml(reviewUrl);

  const subject = input.dealNumber
    ? `RFP declined: ${input.dealNumber} (${input.dealName})`
    : `RFP declined: ${input.dealName}`;

  const rows = [
    ["Deal name", input.dealName, false],
    ["Project number", input.dealNumber ?? "Pending", false],
    ["Reason", input.declinedReason ?? "No reason provided", true],
  ] as const;

  const htmlRows = rows
    .map(([label, value, emphasize]) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;vertical-align:top;width:150px;">${escapeHtml(label)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:${emphasize ? "15px" : "14px"};line-height:20px;font-weight:${emphasize ? "bold" : "normal"};vertical-align:top;">${escapeHtml(value)}</td>
        </tr>`)
    .join("");

  // Outlook (Windows) renders via the Word engine: table-only layout, fully inline CSS, hosted PNG logo
  // with HTML width/height, and a VML "bulletproof button" with an <a> fallback. Same scaffold as #611's
  // project-number email.
  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>RFP Declined</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;">
          <tr>
            <td style="background-color:#CC0000;height:4px;line-height:4px;font-size:4px;mso-line-height-rule:exactly;">&nbsp;</td>
          </tr>
          <tr>
            <td align="center" style="padding:28px 24px 8px 24px;background-color:#ffffff;">
              <img src="${TROCK_LOGO_EMAIL_URL}" alt="T Rock Construction" width="220" height="246" style="display:block;width:220px;height:246px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:4px 24px 0 24px;">
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">RFP Declined</h1>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:6px 24px 16px 24px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;">An RFP was declined. Open the deal to see why. RFP reviewers can approve the override or re-confirm the denial on the review page.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid #e2e8f0;">${htmlRows}
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 24px 8px 24px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeDealUrl}" style="height:44px;v-text-anchor:middle;width:240px;" arcsize="9%" stroke="f" fillcolor="#CC0000">
                <w:anchorlock/>
                <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">View Deal in CRM</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-- -->
              <a href="${safeDealUrl}" style="display:inline-block;background-color:#CC0000;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:44px;text-align:center;text-decoration:none;width:240px;border-radius:4px;">View Deal in CRM</a>
              <!--<![endif]-->
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:4px 24px 4px 24px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeReviewUrl}" style="height:44px;v-text-anchor:middle;width:240px;" arcsize="9%" stroke="t" strokecolor="#CC0000" fillcolor="#ffffff">
                <w:anchorlock/>
                <center style="color:#CC0000;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">Review &amp; Decide</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-- -->
              <a href="${safeReviewUrl}" style="display:inline-block;background-color:#ffffff;color:#CC0000;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:42px;text-align:center;text-decoration:none;width:238px;border:1px solid #CC0000;border-radius:4px;">Review &amp; Decide</a>
              <!--<![endif]-->
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 24px 24px 24px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;">&ldquo;Review &amp; Decide&rdquo; is for the designated RFP reviewers (Takashi &amp; Adam).</p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px;border-top:1px solid #e2e8f0;background-color:#fafafa;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;">This is an automated notification from T Rock Construction CRM. Please do not reply to this email.</p>
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text =
    rows.map(([label, value]) => `${label}: ${value}`).join("\n") +
    `\n\nView the deal in the CRM: ${dealUrl}` +
    `\n\nRFP reviewers (Takashi & Adam) — approve the override or re-confirm the denial: ${reviewUrl}`;
  return { subject, html, text, dealUrl, reviewUrl, dealNumber: input.dealNumber };
}

// --- small local utilities (mirror the private helpers in project-number-email.ts) ---

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

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function isSafeTenantSchema(value: unknown): value is string {
  return typeof value === "string" && /^office_[a-z0-9_]+$/.test(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
