import crypto from "crypto";
import { pool } from "../db.js";
import {
  sendSystemEmailWithMetadata,
  type SendSystemEmailResult,
} from "../lib/system-email.js";
import { escapeHtml, normalizeText, isSafeTenantSchema } from "../lib/email-format.js";
import { resolveFrontendUrl, TROCK_LOGO_EMAIL_URL } from "./project-number-email.js";

export const SCORECARD_CORRECTIVE_ACTION_EMAIL_JOB = "scorecard_corrective_action_email";

// Token lifetime for the email-only web responder link. Long enough that a super/PM has weeks to document the
// corrective action; the flow allows multiple submissions until close, so the token is NOT single-use.
const TOKEN_TTL_DAYS = 30;

export interface ScorecardCorrectiveActionEmailPayload {
  tenantSchema?: string;
  scorecardId?: string;
  dealId?: string;
  officeId?: string | null;
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

type RecipientRole = "superintendent" | "project_manager";

interface ResolvedRecipient {
  role: RecipientRole;
  name: string;
  email: string;
  userId: string | null;
}

interface FlaggedItem {
  itemType: string;
  itemLabel: string;
}

function basicValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** sha256 hex of the raw token — matches the server's hashCorrectiveActionToken so verify roundtrips. */
function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Below-band corrective-action notification. When a scorecard trips the corrective-action band, the server
 * seeds tracked items + enqueues this job in the SAME submit transaction (durable outbox). The handler
 * resolves the deal's superintendent + project_manager (hybrid: CRM users OR email-only members), and sends
 * ONE email per recipient:
 *   - a CRM user gets a TRock Cam deep link (trockcrm://scorecard/<id>/corrective-action);
 *   - an email-only member gets a freshly-minted recipient-bound web token appended to the responder URL.
 *
 * Idempotent per scorecard via field_scorecards.corrective_action_email_sent_at (mirrors email_sent_at):
 * checked before sending, stamped once after ALL recipients are sent. Plus the Resend idempotencyKey is
 * per (scorecard, recipient), so a re-delivery in the crash window (sent, not yet stamped) doesn't
 * double-email a recipient. A recipient with no resolvable email is skipped (logged), never emailed.
 */
export async function handleScorecardCorrectiveActionEmail(
  payload: ScorecardCorrectiveActionEmailPayload,
  _officeId: string | null,
  deps: HandlerDeps = {}
): Promise<void> {
  const logger = deps.logger ?? console;
  const tenantSchema = payload.tenantSchema;
  const scorecardId = normalizeText(payload.scorecardId);
  const dealId = normalizeText(payload.dealId);
  if (!isSafeTenantSchema(tenantSchema) || !scorecardId || !dealId) {
    logger.warn("[CorrectiveActionEmail] Invalid job payload - skipping", { tenantSchema, scorecardId, dealId });
    return;
  }

  const env = deps.env ?? process.env;
  const query = deps.query ?? pool.query.bind(pool);

  // Idempotency + scorecard snapshot. tenantSchema is regex-validated above (isSafeTenantSchema), so
  // interpolating it as the schema qualifier is safe — identifiers can't be $-parametrized.
  const scorecardRes = await query(
    `SELECT corrective_action_email_sent_at, deal_id, project_number, total_score, rating, form_version, kind, week_of
       FROM ${tenantSchema}.field_scorecards WHERE id = $1::uuid LIMIT 1`,
    [scorecardId]
  );
  const scorecard = scorecardRes.rows[0];
  if (!scorecard) {
    logger.warn("[CorrectiveActionEmail] Scorecard not found - skipping", { tenantSchema, scorecardId });
    return;
  }
  if (scorecard.corrective_action_email_sent_at) {
    logger.log("[CorrectiveActionEmail] Already notified - skipping duplicate job", { scorecardId });
    return;
  }

  // Resolve the deal's superintendent + project_manager (hybrid). Same selection as the server's
  // resolveCorrectiveActionRecipients (deal_team_members active rows; user/contact must be active; or an
  // email-only member with both fks null), reimplemented in raw SQL because the worker can't import server.
  const recipientRes = await query(
    `SELECT DISTINCT ON (dtm.role)
            dtm.role AS role,
            dtm.user_id AS user_id,
            COALESCE(
              CASE WHEN dtm.user_id IS NOT NULL AND u.is_active THEN u.display_name END,
              CASE WHEN dtm.contact_id IS NOT NULL AND c.is_active THEN TRIM(CONCAT(c.first_name, ' ', c.last_name)) END,
              dtm.member_name
            ) AS name,
            COALESCE(
              CASE WHEN dtm.user_id IS NOT NULL AND u.is_active THEN u.email END,
              CASE WHEN dtm.contact_id IS NOT NULL AND c.is_active THEN c.email END,
              dtm.member_email
            ) AS email
       FROM ${tenantSchema}.deal_team_members dtm
       LEFT JOIN public.users u ON dtm.user_id = u.id
       LEFT JOIN ${tenantSchema}.contacts c ON dtm.contact_id = c.id
      WHERE dtm.deal_id = $1::uuid
        AND dtm.is_active = TRUE
        AND dtm.role IN ('superintendent', 'project_manager')
        AND (
          (dtm.user_id IS NOT NULL AND u.is_active)
          OR (dtm.contact_id IS NOT NULL AND c.is_active)
          OR (dtm.user_id IS NULL AND dtm.contact_id IS NULL)
        )
      ORDER BY dtm.role, dtm.created_at DESC`,
    [dealId]
  );
  const recipients: ResolvedRecipient[] = [];
  for (const row of recipientRes.rows as any[]) {
    const email = normalizeText(row.email);
    const role = row.role as RecipientRole;
    if (!email || !basicValidEmail(email)) {
      logger.warn("[CorrectiveActionEmail] Recipient has no resolvable email - skipping", { scorecardId, role });
      continue;
    }
    if (role !== "superintendent" && role !== "project_manager") continue;
    recipients.push({ role, name: normalizeText(row.name) ?? email, email, userId: normalizeText(row.user_id) });
  }

  if (recipients.length === 0) {
    // No super/PM with an email on this deal. Not a misconfiguration we can fix by retrying (the fix is to
    // assign the deal team), so skip WITHOUT stamping — a later assignment + requeue can still notify.
    logger.warn(
      "[CorrectiveActionEmail] No superintendent/project-manager with an email on the deal - nothing to notify",
      { scorecardId, dealId }
    );
    return;
  }

  // Flagged items for the email body (the open corrective-action rows).
  const flaggedRes = await query(
    `SELECT item_type, item_label FROM ${tenantSchema}.scorecard_corrective_actions
      WHERE scorecard_id = $1::uuid AND status = 'open'
      ORDER BY item_type, item_ref`,
    [scorecardId]
  );
  const flagged: FlaggedItem[] = (flaggedRes.rows as any[]).map((r) => ({
    itemType: String(r.item_type),
    itemLabel: String(r.item_label),
  }));

  // Deal display fields for the email + link.
  const dealRes = await query(
    `SELECT name, deal_number, project_number FROM ${tenantSchema}.deals WHERE id = $1::uuid LIMIT 1`,
    [dealId]
  );
  const dealRow = dealRes.rows[0] ?? {};
  const dealName = normalizeText(dealRow.name) ?? "Project";
  const projectNumber = normalizeText(scorecard.project_number) ?? normalizeText(dealRow.project_number);

  const frontendUrl = resolveFrontendUrl(env).replace(/\/+$/, "");
  const ratingLabel = normalizeText(scorecard.rating);
  const scoreText = scorecard.total_score == null ? "—" : `${Number(scorecard.total_score)}/100`;

  const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;

  // Retry-orphan cleanup. This handler mints + inserts a fresh email-only token inside the send loop; a
  // crash AFTER a token insert but BEFORE the scorecard-level `corrective_action_email_sent_at` stamp leaves
  // orphan token rows that the retry would ADD to (each run mints anew). We only have the token HASH, not the
  // raw value, so a prior token can't be reused — instead, delete any prior UNEXPIRED, unconsumed tokens for
  // this scorecard before re-minting. This runs only on the retry path: a successful run stamps
  // corrective_action_email_sent_at and short-circuits above, so a completed notification never re-enters
  // here. A partially-delivered prior attempt (no stamp) had no reliably-working link for every recipient, so
  // re-minting + re-sending fresh links (deduped per-recipient by the Resend idempotencyKey) is correct.
  await query(
    `DELETE FROM ${tenantSchema}.scorecard_corrective_action_tokens
      WHERE scorecard_id = $1::uuid AND consumed_at IS NULL AND expires_at > NOW()`,
    [scorecardId]
  );

  // Send one email per recipient with the link appropriate to their identity.
  for (const recipient of recipients) {
    let link: string;
    if (recipient.userId) {
      // CRM user → TRock Cam deep link (they respond in-app). The scheme + path must match the app exactly:
      // the Expo config `scheme` is `trockcam` (app.config.ts) and the expo-router file route is
      // app/(app)/scorecards/corrective-action/[id].tsx, so the deep link is
      // trockcam://scorecards/corrective-action/<id> (the `(app)` group is transparent in the URL).
      link = `trockcam://scorecards/corrective-action/${encodeURIComponent(scorecardId)}`;
    } else {
      // Email-only → mint a recipient-bound web token and append it to the responder URL.
      const rawToken = crypto.randomBytes(32).toString("base64url");
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
      await query(
        `INSERT INTO ${tenantSchema}.scorecard_corrective_action_tokens
           (scorecard_id, token_hash, recipient_email, role, expires_at)
         VALUES ($1::uuid, $2, $3, $4, $5)`,
        [scorecardId, tokenHash, recipient.email, recipient.role, expiresAt.toISOString()]
      );
      link = `${frontendUrl}/scorecards/${encodeURIComponent(scorecardId)}/corrective-action?token=${encodeURIComponent(rawToken)}`;
    }

    const email = buildCorrectiveActionEmail({
      recipientName: recipient.name,
      dealName,
      projectNumber,
      scoreText,
      ratingLabel,
      flagged,
      link,
    });

    const result = await sendEmail(recipient.email, email.subject, email.html, {
      text: email.text,
      idempotencyKey: `corrective-action-${tenantSchema}-${scorecardId}-${recipient.email.toLowerCase()}`,
    });
    if (!result.success) throw new Error("Email provider returned unsuccessful result");
    logger.log("[CorrectiveActionEmail] Sent corrective-action email", {
      scorecardId,
      role: recipient.role,
      isUser: recipient.userId != null,
      messageId: result.messageId,
    });
  }

  // Stamp once after all recipients are sent (scorecard-level idempotency — mirrors email_sent_at).
  await query(
    `UPDATE ${tenantSchema}.field_scorecards
        SET corrective_action_email_sent_at = NOW()
      WHERE id = $1::uuid AND corrective_action_email_sent_at IS NULL`,
    [scorecardId]
  );
}

export function buildCorrectiveActionEmail(input: {
  recipientName: string;
  dealName: string;
  projectNumber: string | null;
  scoreText: string;
  ratingLabel: string | null;
  flagged: FlaggedItem[];
  link: string;
}) {
  const subject = input.projectNumber
    ? `Corrective action required: ${input.projectNumber} — ${input.scoreText}`
    : `Corrective action required: ${input.dealName} — ${input.scoreText}`;

  const itemsList = input.flagged.length
    ? input.flagged.map((f) => `• ${f.itemLabel}`).join("\n")
    : "• (see the CRM for the flagged items)";

  const htmlItems = input.flagged.length
    ? `<ul style="margin:8px 0 0 0;padding-left:20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#111111;">${input.flagged
        .map((f) => `<li>${escapeHtml(f.itemLabel)}</li>`)
        .join("")}</ul>`
    : `<p style="margin:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#64748b;">See the CRM for the flagged items.</p>`;

  const safeLink = escapeHtml(input.link);

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Corrective action required</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;">
          <tr><td style="background-color:#CC0000;height:4px;line-height:4px;font-size:4px;">&nbsp;</td></tr>
          <tr>
            <td align="center" style="padding:28px 24px 8px 24px;">
              <img src="${TROCK_LOGO_EMAIL_URL}" alt="T Rock Construction" width="220" height="246" style="display:block;width:220px;height:246px;border:0;" />
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:4px 24px 0 24px;">
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">Corrective Action Required</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 28px 0 28px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#111111;">Hi ${escapeHtml(input.recipientName)},</p>
              <p style="margin:12px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#111111;">A field scorecard for <strong>${escapeHtml(input.dealName)}</strong>${input.projectNumber ? ` (${escapeHtml(input.projectNumber)})` : ""} came in below standard (${escapeHtml(input.scoreText)}${input.ratingLabel ? ` · ${escapeHtml(input.ratingLabel)}` : ""}). Please document the corrective action taken for each flagged item:</p>
              ${htmlItems}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px;">
              <a href="${safeLink}" style="display:inline-block;background-color:#CC0000;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:44px;text-align:center;text-decoration:none;width:280px;border-radius:4px;">Document Corrective Action</a>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px;border-top:1px solid #e2e8f0;background-color:#fafafa;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;">This is an automated notification from T Rock Construction CRM. Please do not reply to this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text =
    `Corrective action required\n\n` +
    `Hi ${input.recipientName},\n\n` +
    `A field scorecard for ${input.dealName}${input.projectNumber ? ` (${input.projectNumber})` : ""} came in below standard ` +
    `(${input.scoreText}${input.ratingLabel ? ` · ${input.ratingLabel}` : ""}). Please document the corrective action taken for each flagged item:\n\n` +
    `${itemsList}\n\n` +
    `Document the corrective action: ${input.link}`;

  return { subject, html, text };
}
