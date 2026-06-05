import { pool } from "../db.js";
import { sendSystemEmailWithMetadata, type SendSystemEmailResult } from "../lib/system-email.js";
// Reuse #611's frontend-URL + branded-template primitives so the link points at trockcrm.com and the email
// matches the RFP-decline / re-confirm / project-number look.
import { resolveFrontendUrl, TROCK_LOGO_EMAIL_URL } from "./project-number-email.js";
// Leadership recipients derive from the SAME config as the decline/re-confirm emails + the server's reviewer
// allowlist (RFP_REJECTION_EMAIL_RECIPIENTS), so they can never drift apart.
import { resolveRfpReviewerEmails } from "@trock-crm/shared/lib/rfpReviewerEmails";

export const RFP_OVERRIDE_APPROVED_JOB = "rfp_override_approved_email";

interface RfpOverrideApprovedPayload {
  tenantSchema?: string;
  dealId?: string;
  dealNumber?: string | null;
  dealName?: string;
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
 * Email the requesting rep + leadership when an OVERRIDE-approve is CONFIRMED successful — the positive
 * counterpart to the re-confirm-denial email (#651). Enqueued by migration 0155's
 * `deals_rfp_override_approved_email_trg` on the rfp_approval_status -> 'approved' transition (decision still
 * 'override_approved'), i.e. AFTER the SyncHub `created` callback links the Bid Board project — NOT on the
 * initial approve click (which only parks the deal 'approving' and may still fail).
 *
 * Recipients = [requesting rep (rfp_approval_requested_by)] + RFP_REJECTION_EMAIL_RECIPIENTS leadership. Both
 * NULL-SAFE: missing rep -> leadership only; missing leadership -> rep only; if NEITHER resolves we log and
 * skip (never crash — the linkage already committed). De-duped case-insensitively.
 *
 * Exactly-once per RFP cycle: keyed (tenant_schema, deal_id, rfp_approval_request_id) via the receipts ledger +
 * the Resend idempotencyKey. A duplicate `created` callback makes no transition (no enqueue), so no duplicate.
 */
export async function handleRfpOverrideApprovedEmail(
  payload: RfpOverrideApprovedPayload,
  _officeId: string | null,
  deps: HandlerDeps = {}
) {
  const logger = deps.logger ?? console;
  const tenantSchema = payload.tenantSchema;
  const dealId = payload.dealId;
  const rfpApprovalRequestId = normalizePositiveInt(payload.rfpApprovalRequestId);
  if (!isSafeTenantSchema(tenantSchema) || !dealId || rfpApprovalRequestId == null) {
    logger.warn("[RfpOverrideApprovedEmail] Invalid job payload - skipping", { tenantSchema, dealId, rfpApprovalRequestId });
    return;
  }

  const query = deps.query ?? pool.query.bind(pool);

  // Exactly-once guard: skip if this RFP cycle's approval already sent.
  const receiptResult = await query(
    `SELECT resend_message_id, sent_at
       FROM public.rfp_override_approved_email_receipts
      WHERE tenant_schema = $1
        AND deal_id = $2::uuid
        AND rfp_approval_request_id = $3
      LIMIT 1`,
    [tenantSchema, dealId, rfpApprovalRequestId]
  );
  if (receiptResult.rows.length > 0) {
    logger.log("[RfpOverrideApprovedEmail] Notification already sent - skipping duplicate job", {
      dealId,
      rfpApprovalRequestId,
      messageId: receiptResult.rows[0]?.resend_message_id ?? null,
    });
    return;
  }

  // Leadership recipients. As with the re-confirm email, an unset leadership list is NOT a hard error here: we
  // still notify the rep if we can, and only skip when NOBODY resolves (null-safe).
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
        "[RfpOverrideApprovedEmail] Requesting rep could not be resolved to an email - using leadership recipients only",
        { dealId, rfpApprovalRequestId, requestedByUserId }
      );
    }
  } else {
    logger.warn(
      "[RfpOverrideApprovedEmail] No requesting-rep id on the approval - using leadership recipients only",
      { dealId, rfpApprovalRequestId }
    );
  }

  // Final recipient list = [requesting rep] + [leadership], de-duplicated case-insensitively.
  const recipients = dedupeEmails([...(requesterEmail ? [requesterEmail] : []), ...leadershipRecipients]);

  // Null-safe terminal case: if NEITHER the rep nor leadership resolves there is no one to notify. Log loudly
  // and skip — the linkage has already committed, so we must never crash or retry-loop here.
  if (recipients.length === 0) {
    logger.error(
      "[RfpOverrideApprovedEmail] No resolvable recipients (no requesting rep AND RFP_REJECTION_EMAIL_RECIPIENTS unset) - skipping the approval notification",
      { dealId, rfpApprovalRequestId }
    );
    return;
  }

  // Re-read the deal's office id so cross-office recipients (leadership) get a link that resolves (the #611
  // P1 fix). Display fields come from the payload snapshot taken at approval time.
  const officeResult = await query(
    `SELECT id
       FROM public.offices
      WHERE ('office_' || slug) = $1
        AND is_active = true
      LIMIT 1`,
    [tenantSchema]
  );
  const officeId = (officeResult.rows[0]?.id as string | undefined) ?? null;

  const email = buildRfpOverrideApprovedEmail({
    dealId,
    dealName: normalizeText(payload.dealName) ?? "Deal",
    dealNumber: normalizeText(payload.dealNumber),
    officeId,
    frontendUrl: resolveFrontendUrl(deps.env ?? process.env),
  });

  try {
    const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;
    const sendResult = await sendEmail(recipients, email.subject, email.html, {
      text: email.text,
      idempotencyKey: `rfp-override-approved-${tenantSchema}-${dealId}-${rfpApprovalRequestId}`,
    });
    if (!sendResult.success) {
      throw new Error("Email provider returned unsuccessful result");
    }
    await query(
      `INSERT INTO public.rfp_override_approved_email_receipts (
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
    logger.log("[RfpOverrideApprovedEmail] Sent RFP override-approved notification", {
      dealId,
      rfpApprovalRequestId,
      recipientCount: recipients.length,
      hadRequesterEmail: requesterEmail != null,
      messageId: sendResult.messageId,
    });
  } catch (error) {
    logger.error("[RfpOverrideApprovedEmail] Failed to send RFP override-approved notification", {
      dealId,
      rfpApprovalRequestId,
      error,
    });
    throw error;
  }
}

export function buildRfpOverrideApprovedEmail(input: {
  dealId: string;
  dealName: string;
  dealNumber: string | null;
  officeId?: string | null;
  frontendUrl: string;
}) {
  // Deal URL: /deals/{id}?officeId={deal's office} (officeId carries the deal's tenant so a cross-office
  // recipient doesn't 404 — same #611 rationale as the decline email). This is the ONLY CTA.
  const officeParam = input.officeId ? `?officeId=${encodeURIComponent(input.officeId)}` : "";
  const baseUrl = input.frontendUrl.replace(/\/+$/, "");
  const dealUrl = `${baseUrl}/deals/${encodeURIComponent(input.dealId)}${officeParam}`;
  const safeDealUrl = escapeHtml(dealUrl);

  const subject = input.dealNumber
    ? `RFP override approved: ${input.dealNumber} (${input.dealName})`
    : `RFP override approved: ${input.dealName}`;

  const rows = [
    ["Deal name", input.dealName, false],
    ["Project number", input.dealNumber ?? "Pending", false],
    ["Outcome", "Override approved — Bid Board project created", true],
  ] as const;

  const htmlRows = rows
    .map(([label, value, emphasize]) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;vertical-align:top;width:150px;">${escapeHtml(label)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:${emphasize ? "15px" : "14px"};line-height:20px;font-weight:${emphasize ? "bold" : "normal"};vertical-align:top;">${escapeHtml(value)}</td>
        </tr>`)
    .join("");

  // Same Outlook-safe scaffold as the RFP-decline / re-confirm emails (#611): table-only layout, inline CSS,
  // hosted PNG logo, VML "bulletproof button" with an <a> fallback — single CTA and positive copy.
  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>RFP Override Approved</title>
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
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">RFP Override Approved</h1>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:6px 24px 16px 24px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;">Good news &mdash; after a second-look review, leadership approved the override on this RFP. The Bid Board project has been created and the deal has advanced.</p>
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
    `Good news — after a second-look review, leadership approved the override on this RFP. The Bid Board project has been created and the deal has advanced.\n\n` +
    rows.map(([label, value]) => `${label}: ${value}`).join("\n") +
    `\n\nView the deal in the CRM: ${dealUrl}`;
  return { subject, html, text, dealUrl, dealNumber: input.dealNumber };
}

// --- small local utilities (mirror the private helpers in rfp-reconfirm-denial-email.ts) ---

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
