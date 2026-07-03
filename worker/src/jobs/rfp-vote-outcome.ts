import { pool } from "../db.js";
import { sendSystemEmailWithMetadata, type SendSystemEmailResult } from "../lib/system-email.js";
// Reuse #611's branded-template primitives so the vote-outcome email points at trockcrm.com and matches
// the project-number email's look. Mirrors rfp-rejection-email.ts plumbing.
import { resolveFrontendUrl, TROCK_LOGO_EMAIL_URL } from "./project-number-email.js";
// Single source of truth shared with the server's override-review gate: the notified leadership set and
// the authorized-reviewer set both derive from RFP_REJECTION_EMAIL_RECIPIENTS, so they can never drift.
import { resolveRfpReviewerEmails } from "@trock-crm/shared/lib/rfpReviewerEmails";
import { escapeHtml, normalizeText, isSafeTenantSchema } from "../lib/email-format.js";

export const RFP_VOTE_OUTCOME_JOB = "rfp_vote_outcome";

interface RfpVoteOutcomePayload {
  tenantSchema?: string;
  dealId?: string;
  dealName?: string;
  dealNumber?: string | null;
  requestedByUserId?: string | null;
  rfpVoteRoundId?: string | null;
  outcome?: "approved" | "rejected";
  approvals?: number;
  rejections?: number;
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
 * Outcome notification for a DECIDED vote round. GO (approved): email the requesting rep that the RFP
 * passed and the Bid Board project is being created. NO-GO (rejected): email the requesting rep + the
 * Takashi/Adam reviewers (resolveRfpReviewerEmails) the escalation with the /rfp-review link — the
 * APP-DRIVEN no-go escalation, because migration 0148's trigger stays inert for a null-request-id voting
 * decline (no double-send). Enqueued by castRfpVote in BOTH decided branches (enqueueRfpVoteOutcome,
 * carrying `outcome`). If no recipient resolves we log + no-op (the create/decline already happened —
 * this is an FYI notification, not a gate).
 */
export async function handleRfpVoteOutcomeEmail(
  payload: RfpVoteOutcomePayload,
  _officeId: string | null,
  deps: HandlerDeps = {}
) {
  const logger = deps.logger ?? console;
  const tenantSchema = payload.tenantSchema;
  const dealId = payload.dealId;
  if (!isSafeTenantSchema(tenantSchema) || !dealId) {
    logger.warn("[RfpVoteOutcome] Invalid job payload - skipping", { tenantSchema, dealId });
    return;
  }

  const query = deps.query ?? pool.query.bind(pool);
  const env = deps.env ?? process.env;
  // FIX 4: warn when outcome is missing or not a known value before defaulting.
  if (payload.outcome !== "approved" && payload.outcome !== "rejected") {
    logger.warn("[RfpVoteOutcome] Missing/unknown outcome; defaulting to approved", {
      dealId,
      outcome: payload.outcome,
    });
  }
  const outcome = payload.outcome === "rejected" ? "rejected" : "approved";
  const roundId = normalizeText(payload.rfpVoteRoundId);

  // Resolve the requesting rep's email (dynamic, per-deal). Degrade gracefully: a missing/unresolvable
  // requester on the NO-GO path still sends to the reviewer set. On the GO path, if there's no rep there
  // is nobody to notify and we no-op.
  const requestedByUserId = normalizeText(payload.requestedByUserId);
  let repEmail: string | null = null;
  if (requestedByUserId) {
    const repResult = await query(
      `SELECT email FROM public.users WHERE id = $1::uuid LIMIT 1`,
      [requestedByUserId]
    );
    repEmail = normalizeText(repResult.rows[0]?.email ?? null);
    // FIX 3: warn when the rep id was present but didn't resolve to an email.
    if (!repEmail) {
      logger.warn("[RfpVoteOutcome] Requesting rep could not be resolved to an email", {
        dealId,
        requestedByUserId,
      });
    }
  } else {
    // FIX 3: warn when there is no requestedByUserId at all.
    logger.warn("[RfpVoteOutcome] Requesting rep could not be resolved to an email", {
      dealId,
      requestedByUserId: null,
    });
  }

  // GO -> just the requesting rep. NO-GO -> rep + the Takashi/Adam reviewers (same allowlist the
  // DB-trigger escalation would have used), deduped case-insensitively.
  const reviewerEmails = outcome === "rejected" ? resolveRfpReviewerEmails(env) : [];
  // For a REJECTED outcome, reviewer emails are load-bearing: the /rfp-review gate only admits users in
  // that set, so if the set is empty nobody can act on the escalation. Fail loud (throw → retry →
  // dead-letter) rather than silently completing after emailing only the rep. Mirrors legacy
  // rfp_rejected_email hard-fail behaviour. The GO/approved path is unaffected — rep-only is correct.
  if (outcome === "rejected" && reviewerEmails.length === 0) {
    throw new Error(
      "[RfpVoteOutcome] RFP_REJECTION_EMAIL_RECIPIENTS is not configured — cannot send rejection escalation. " +
        "Configure the env var and redeploy, or dead-letter this job."
    );
  }
  // FIX 2: case-insensitive dedup — mirrors rfp-rejection-email.ts dedupeEmails helper.
  const recipients = dedupeEmails([repEmail, ...reviewerEmails].filter((e): e is string => !!e));
  if (recipients.length === 0) {
    logger.warn(
      "[RfpVoteOutcome] No resolvable recipients - skipping outcome notification",
      { dealId, outcome }
    );
    return;
  }

  // Re-read the deal's office id so the link carries the deal's tenant (cross-office recipients like
  // leadership don't 404). Mirrors the #611 P1 fix in rfp-rejection-email.ts.
  const officeResult = await query(
    `SELECT id FROM public.offices WHERE ('office_' || slug) = $1 AND is_active = true LIMIT 1`,
    [tenantSchema]
  );
  const officeId = (officeResult.rows[0]?.id as string | undefined) ?? null;

  const emailInput = {
    dealId,
    dealName: normalizeText(payload.dealName) ?? "Deal",
    dealNumber: normalizeText(payload.dealNumber),
    officeId,
    frontendUrl: resolveFrontendUrl(env),
  };
  const email =
    outcome === "rejected"
      ? buildRfpVoteRejectedEmail(emailInput)
      : buildRfpVoteApprovedEmail(emailInput);

  try {
    const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;
    const sendResult = await sendEmail(recipients, email.subject, email.html, {
      text: email.text,
      idempotencyKey: `rfp-vote-${outcome}-${tenantSchema}-${dealId}-${roundId ?? "noround"}`,
    });
    if (!sendResult.success) {
      throw new Error("Email provider returned unsuccessful result");
    }
    logger.log("[RfpVoteOutcome] Sent outcome notification", {
      dealId,
      outcome,
      recipientCount: recipients.length,
      messageId: sendResult.messageId,
    });
  } catch (error) {
    logger.error("[RfpVoteOutcome] Failed to send outcome notification", { dealId, outcome, error });
    throw error;
  }
}

export function buildRfpVoteApprovedEmail(input: {
  dealId: string;
  dealName: string;
  dealNumber: string | null;
  officeId?: string | null;
  frontendUrl: string;
}) {
  // Deal URL: /deals/{id}?officeId={deal's office} so the link loads the correct office even for a
  // recipient whose default office differs. Mirrors #611's project-number link builder.
  const officeParam = input.officeId ? `?officeId=${encodeURIComponent(input.officeId)}` : "";
  const baseUrl = input.frontendUrl.replace(/\/+$/, "");
  const dealUrl = `${baseUrl}/deals/${encodeURIComponent(input.dealId)}${officeParam}`;
  const safeDealUrl = escapeHtml(dealUrl);

  const subject = input.dealNumber
    ? `RFP approved (2/3): ${input.dealNumber} (${input.dealName})`
    : `RFP approved (2/3): ${input.dealName}`;

  const text =
    `Your RFP for ${input.dealName}${input.dealNumber ? ` (${input.dealNumber})` : ""} was approved by vote (2 of 3). ` +
    `We're creating the Bid Board project now. Open the deal: ${dealUrl}`;

  // Outlook-compatible table-based layout with fully inline CSS, hosted PNG logo,
  // and green accent bar — mirrors rfp-rejection-email.ts scaffold.
  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>RFP Approved</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;">
          <tr>
            <td style="background-color:#059669;height:4px;line-height:4px;font-size:4px;mso-line-height-rule:exactly;">&nbsp;</td>
          </tr>
          <tr>
            <td align="center" style="padding:28px 24px 8px 24px;background-color:#ffffff;">
              <img src="${TROCK_LOGO_EMAIL_URL}" alt="T Rock Construction" width="220" height="246" style="display:block;width:220px;height:246px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:4px 24px 0 24px;">
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">RFP Approved (2 of 3)</h1>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:6px 24px 16px 24px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;">
                Your RFP for ${escapeHtml(input.dealName)} was approved by vote. We're creating the Bid Board project now — the deal will advance to Estimating automatically when it's done.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 24px 28px 24px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeDealUrl}" style="height:44px;v-text-anchor:middle;width:240px;" arcsize="9%" stroke="f" fillcolor="#059669">
                <w:anchorlock/>
                <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">View Deal in CRM</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-- -->
              <a href="${safeDealUrl}" style="display:inline-block;background-color:#059669;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:44px;text-align:center;text-decoration:none;width:240px;border-radius:4px;">View Deal in CRM</a>
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

  return { subject, html, text, dealNumber: input.dealNumber };
}

export function buildRfpVoteRejectedEmail(input: {
  dealId: string;
  dealName: string;
  dealNumber: string | null;
  officeId?: string | null;
  frontendUrl: string;
}) {
  const officeParam = input.officeId ? `?officeId=${encodeURIComponent(input.officeId)}` : "";
  const baseUrl = input.frontendUrl.replace(/\/+$/, "");
  // Primary CTA: the dedicated override-review page for THIS deal (same route as rfp-rejection-email.ts).
  const reviewUrl = `${baseUrl}/rfp-review/${encodeURIComponent(input.dealId)}${officeParam}`;
  const safeReviewUrl = escapeHtml(reviewUrl);

  const subject = input.dealNumber
    ? `RFP rejected (2/3) — review needed: ${input.dealNumber} (${input.dealName})`
    : `RFP rejected (2/3) — review needed: ${input.dealName}`;

  const text =
    `The RFP for ${input.dealName}${input.dealNumber ? ` (${input.dealNumber})` : ""} was rejected by vote (2 of 3). ` +
    `Review & decide (approve the override or confirm the denial): ${reviewUrl}`;

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>RFP Rejected — Review Needed</title>
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
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">RFP Rejected (2 of 3) — Review Needed</h1>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:6px 24px 16px 24px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;">
                The RFP for ${escapeHtml(input.dealName)} was rejected by a 2-of-3 vote. The RFP reviewers can approve the override (create the Bid Board project anyway) or confirm the denial on the review page.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 24px 8px 24px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeReviewUrl}" style="height:44px;v-text-anchor:middle;width:240px;" arcsize="9%" stroke="f" fillcolor="#CC0000">
                <w:anchorlock/>
                <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">Review &amp; Decide</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-- -->
              <a href="${safeReviewUrl}" style="display:inline-block;background-color:#CC0000;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:44px;text-align:center;text-decoration:none;width:240px;border-radius:4px;">Review &amp; Decide</a>
              <!--<![endif]-->
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 24px 4px 24px;">
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

  return { subject, html, text, dealNumber: input.dealNumber };
}

// --- local utilities ---

/** Case-insensitive dedup: preserves first-seen casing, mirrors rfp-rejection-email.ts. */
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
