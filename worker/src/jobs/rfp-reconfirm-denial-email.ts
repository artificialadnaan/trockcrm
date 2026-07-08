import { pool } from "../db.js";
import { sendSystemEmailWithMetadata, type SendSystemEmailResult } from "../lib/system-email.js";
// Reuse #611's frontend-URL + branded-template primitives so the link points at trockcrm.com and the email
// matches the RFP-decline / project-number look.
import { resolveFrontendUrl, TROCK_LOGO_EMAIL_URL } from "./project-number-email.js";
// Leadership recipients ("the denier"/go-no-go authority) derive from the SAME config as the decline email +
// the server's reviewer allowlist (RFP_REJECTION_EMAIL_RECIPIENTS), so they can never drift apart.
import { resolveRfpReviewerEmails } from "@trock-crm/shared/lib/rfpReviewerEmails";

export const RFP_RECONFIRM_DENIAL_JOB = "rfp_reconfirm_denial_email";

interface RfpReconfirmDenialPayload {
  tenantSchema?: string;
  dealId?: string;
  dealNumber?: string | null;
  dealName?: string;
  declinedReason?: string | null;
  rfpApprovalRequestId?: number;
  // finding: the VOTING-path re-confirm carries no SyncHub request id (reconfirmRfpDecline enqueues this job
  // app-side because the 0154 trigger skips a NULL request id). It passes the round event id for idempotency.
  rfpVoteRoundId?: string | null;
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
 * Email the requesting rep + leadership when a reviewer RE-CONFIRMS a declined RFP (the terminal "denial
 * upheld" outcome of the override-review gate). Enqueued by migration 0154's
 * `deals_rfp_reconfirm_denial_email_trg` on the rfp_override_decision -> 'denial_reconfirmed' transition.
 *
 * Recipients = [requesting rep (resolved per-deal from rfp_approval_requested_by)] + RFP_REJECTION_EMAIL_RECIPIENTS
 * (the go-no-go leadership — there is no recorded individual "denier"; declines relay from SyncHub). Both are
 * NULL-SAFE: a missing rep still sends to leadership; missing leadership still sends to the rep; if NEITHER
 * resolves we log and skip (never crash — the re-confirm itself already committed). De-duped case-insensitively
 * so the rep is never double-emailed if they also appear in the leadership list.
 *
 * Exactly-once per RFP cycle: keyed (tenant_schema, deal_id, rfp_approval_request_id) via the receipts ledger +
 * the Resend idempotencyKey. A repeated re-confirm makes no transition (no enqueue), so no duplicate.
 */
export async function handleRfpReconfirmDenialEmail(
  payload: RfpReconfirmDenialPayload,
  _officeId: string | null,
  deps: HandlerDeps = {}
) {
  const logger = deps.logger ?? console;
  const tenantSchema = payload.tenantSchema;
  const dealId = payload.dealId;
  const rfpApprovalRequestId = normalizePositiveInt(payload.rfpApprovalRequestId);
  // finding: the VOTING-path re-confirm has no request id; it's keyed on the round event id. Accept EITHER a
  // request id (the legacy trigger-enqueued path) OR a round id (the app-enqueued voting path).
  const rfpVoteRoundId = normalizeText(payload.rfpVoteRoundId);
  if (!isSafeTenantSchema(tenantSchema) || !dealId || (rfpApprovalRequestId == null && rfpVoteRoundId == null)) {
    logger.warn("[RfpReconfirmDenialEmail] Invalid job payload - skipping", { tenantSchema, dealId, rfpApprovalRequestId, rfpVoteRoundId });
    return;
  }

  const query = deps.query ?? pool.query.bind(pool);

  // Exactly-once guard: skip if this RFP cycle's re-confirm already sent. The receipts ledger is keyed on the
  // request id, so it only applies to the request-BACKED path. The request-less (voting) path is instead made
  // once-only by its enqueue site (reconfirmRfpDecline enqueues only on the actual denial_reconfirmed transition,
  // once per round) + the round-scoped Resend idempotencyKey below.
  if (rfpApprovalRequestId != null) {
    const receiptResult = await query(
      `SELECT resend_message_id, sent_at
         FROM public.rfp_reconfirm_email_receipts
        WHERE tenant_schema = $1
          AND deal_id = $2::uuid
          AND rfp_approval_request_id = $3
        LIMIT 1`,
      [tenantSchema, dealId, rfpApprovalRequestId]
    );
    if (receiptResult.rows.length > 0) {
      logger.log("[RfpReconfirmDenialEmail] Notification already sent - skipping duplicate job", {
        dealId,
        rfpApprovalRequestId,
        messageId: receiptResult.rows[0]?.resend_message_id ?? null,
      });
      return;
    }
  }

  // Leadership recipients (the go-no-go authority that "denied" it). Unlike the decline email, an unset
  // leadership list is NOT a hard error here: we still notify the rep if we can, and only skip when NOBODY
  // resolves (see below) — per the null-safe spec for this terminal notification.
  const leadershipRecipients = resolveRfpReviewerEmails(deps.env ?? process.env);

  // Resolve the requesting rep's email (dynamic, per-deal). Degrade gracefully: a missing/unresolvable
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
        "[RfpReconfirmDenialEmail] Requesting rep could not be resolved to an email - using leadership recipients only",
        { dealId, rfpApprovalRequestId, requestedByUserId }
      );
    }
  } else {
    logger.warn(
      "[RfpReconfirmDenialEmail] No requesting-rep id on the re-confirm - using leadership recipients only",
      { dealId, rfpApprovalRequestId }
    );
  }

  // Final recipient list = [requesting rep] + [leadership], de-duplicated case-insensitively.
  const recipients = dedupeEmails([...(requesterEmail ? [requesterEmail] : []), ...leadershipRecipients]);

  // Null-safe terminal case: if NEITHER the rep nor leadership resolves there is no one to notify. Log loudly
  // (a misconfigured leadership list + an unresolvable rep is worth surfacing) and skip — the re-confirm has
  // already committed, so we must never crash or retry-loop here.
  if (recipients.length === 0) {
    logger.error(
      "[RfpReconfirmDenialEmail] No resolvable recipients (no requesting rep AND RFP_REJECTION_EMAIL_RECIPIENTS unset) - skipping the re-confirm notification",
      { dealId, rfpApprovalRequestId }
    );
    return;
  }

  // Re-read the deal's office id so cross-office recipients (leadership) get a link that resolves (the #611
  // P1 fix). Display fields come from the payload snapshot taken at re-confirm time.
  const officeResult = await query(
    `SELECT id
       FROM public.offices
      WHERE ('office_' || slug) = $1
        AND is_active = true
      LIMIT 1`,
    [tenantSchema]
  );
  const officeId = (officeResult.rows[0]?.id as string | undefined) ?? null;

  const email = buildRfpReconfirmDenialEmail({
    dealId,
    dealName: normalizeText(payload.dealName) ?? "Deal",
    dealNumber: normalizeText(payload.dealNumber),
    declinedReason: normalizeText(payload.declinedReason),
    officeId,
    frontendUrl: resolveFrontendUrl(deps.env ?? process.env),
  });

  try {
    const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;
    // Idempotency dimension: the request id when present, else the round event id (voting path).
    const idDimension = rfpApprovalRequestId != null ? String(rfpApprovalRequestId) : `round-${rfpVoteRoundId}`;
    const sendResult = await sendEmail(recipients, email.subject, email.html, {
      text: email.text,
      idempotencyKey: `rfp-reconfirm-denial-${tenantSchema}-${dealId}-${idDimension}`,
    });
    if (!sendResult.success) {
      throw new Error("Email provider returned unsuccessful result");
    }
    // Persist the receipt only for the request-BACKED path (the ledger is keyed on the integer request id). The
    // request-less voting path relies on its once-only enqueue + the round-scoped idempotencyKey above.
    if (rfpApprovalRequestId != null) {
      await query(
        `INSERT INTO public.rfp_reconfirm_email_receipts (
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
    }
    logger.log("[RfpReconfirmDenialEmail] Sent RFP denial-upheld notification", {
      dealId,
      rfpApprovalRequestId,
      recipientCount: recipients.length,
      hadRequesterEmail: requesterEmail != null,
      messageId: sendResult.messageId,
    });
  } catch (error) {
    logger.error("[RfpReconfirmDenialEmail] Failed to send RFP denial-upheld notification", {
      dealId,
      rfpApprovalRequestId,
      error,
    });
    throw error;
  }
}

export function buildRfpReconfirmDenialEmail(input: {
  dealId: string;
  dealName: string;
  dealNumber: string | null;
  declinedReason: string | null;
  officeId?: string | null;
  frontendUrl: string;
}) {
  // The re-confirm is terminal and the deal is now archived (is_active=false). getDealById 404s inactive
  // deals, so a "View Deal in CRM" link would 404 for the recipient. Remove the CTA entirely and note the
  // archive instead.
  const baseUrl = input.frontendUrl.replace(/\/+$/, "");
  // baseUrl retained for any future use; dealUrl intentionally removed — see FIX 5.
  void baseUrl;

  const subject = input.dealNumber
    ? `RFP denial confirmed: ${input.dealNumber} (${input.dealName})`
    : `RFP denial confirmed: ${input.dealName}`;

  const rows = [
    ["Deal name", input.dealName, false],
    ["Project number", input.dealNumber ?? "Pending", false],
    ["Decline reason", input.declinedReason ?? "No reason provided", true],
  ] as const;

  const htmlRows = rows
    .map(([label, value, emphasize]) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;vertical-align:top;width:150px;">${escapeHtml(label)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:${emphasize ? "15px" : "14px"};line-height:20px;font-weight:${emphasize ? "bold" : "normal"};vertical-align:top;">${escapeHtml(value)}</td>
        </tr>`)
    .join("");

  // Same Outlook-safe scaffold as the RFP-decline email (#611): table-only layout, inline CSS, hosted PNG
  // logo, VML "bulletproof button" with an <a> fallback — but a single CTA and terminal copy.
  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>RFP Denial Confirmed</title>
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
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">RFP Denial Confirmed</h1>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:6px 24px 16px 24px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;">After a second-look review, leadership confirmed the denial of this RFP. It will not proceed &mdash; no further action is needed.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid #e2e8f0;">${htmlRows}
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 24px 8px 24px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;color:#64748b;">This deal has been archived.</p>
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
    `After a second-look review, leadership confirmed the denial of this RFP. It will not proceed.\n\n` +
    rows.map(([label, value]) => `${label}: ${value}`).join("\n") +
    `\n\nThis deal has been archived.`;
  return { subject, html, text, dealNumber: input.dealNumber };
}

// --- small local utilities (mirror the private helpers in rfp-rejection-email.ts) ---

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
