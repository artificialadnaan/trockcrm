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
 *   - a CRM user gets a TRock Cam deep link (trockcam://scorecards/corrective-action/<id>);
 *   - an email-only member gets a freshly-minted recipient-bound web token appended to the responder URL.
 *
 * Idempotent per scorecard via field_scorecards.corrective_action_email_sent_at (mirrors email_sent_at):
 * checked before sending, stamped once ONLY when every ASSIGNED super/PM role was delivered this run. An
 * assigned-but-unresolvable role — inactive identity or missing/invalid email — instead THROWS so the queue
 * retries (a normal return would COMPLETE the job and strand the un-notified role forever; finding 4). The
 * Resend idempotencyKey is scoped to the corrective-action CYCLE — for an email-only recipient it carries the
 * freshly-minted token hash (a reopen mints a fresh token → new key, so the new link is actually sent, not
 * false-deduped by Resend as a same-key/different-payload `invalid_idempotent_request`), and for a CRM user
 * (no token) it is per (scorecard, recipient) since their deep link is cycle-stable — so a re-delivery in the
 * crash window (sent, not yet stamped) or a throw-triggered retry doesn't double-email a recipient. Email-only
 * tokens carry a delivered_at set only AFTER a successful send, so a retry reuses a DELIVERED token but
 * (re)sends an undelivered one — delivery is never inferred from mere token existence (finding 5).
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
    `SELECT status, corrective_action_email_sent_at, deal_id, project_number, total_score, rating, form_version, kind, week_of
       FROM ${tenantSchema}.field_scorecards WHERE id = $1::uuid LIMIT 1`,
    [scorecardId]
  );
  const scorecard = scorecardRes.rows[0];
  if (!scorecard) {
    logger.warn("[CorrectiveActionEmail] Scorecard not found - skipping", { tenantSchema, scorecardId });
    return;
  }
  // The corrective action must still be OPEN to notify. This job runs after a delay, during which an edit may
  // lift the card above-band (status → 'submitted') or the team may resolve every item in-app (status →
  // 'corrective_action_closed'); reconciliation deleted the open items in the first case, so the responder link
  // would 404 anyway. If the card is no longer open there is nothing to notify — complete cleanly (no email,
  // no error), never stamping sent, so a later reopen (which re-enqueues) still notifies.
  if (scorecard.status !== "corrective_action_open") {
    logger.log("[CorrectiveActionEmail] Scorecard no longer corrective_action_open - skipping (nothing to notify)", {
      scorecardId,
      status: scorecard.status,
    });
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
  const resolvedRoles = new Set<RecipientRole>();
  for (const row of recipientRes.rows as any[]) {
    const email = normalizeText(row.email);
    const role = row.role as RecipientRole;
    if (role !== "superintendent" && role !== "project_manager") continue;
    if (!email || !basicValidEmail(email)) {
      logger.warn("[CorrectiveActionEmail] Recipient has no resolvable email - skipping", { scorecardId, role });
      continue;
    }
    recipients.push({ role, name: normalizeText(row.name) ?? email, email, userId: normalizeText(row.user_id) });
    resolvedRoles.add(role);
  }

  if (recipients.length === 0) {
    // No super/PM with an email on this deal RIGHT NOW. This is usually transient — the team is often assigned
    // shortly after the scorecard is filed — so completing-as-success here would drop the notification forever
    // (nothing re-enqueues on a later assignment). Instead THROW a retryable error so the queue retries with
    // backoff up to max_attempts, giving the team time to be assigned; the final attempt dead-letters with this
    // message (a loud, inspectable give-up). Residual limitation: a team assigned AFTER max_attempts is
    // exhausted still won't be notified — a fuller enqueue-on-team-change trigger is a noted follow-up
    // (out of scope here). We do NOT stamp corrective_action_email_sent_at, so a manual requeue can still notify.
    logger.warn(
      "[CorrectiveActionEmail] No superintendent/project-manager with an email on the deal - will retry",
      { scorecardId, dealId }
    );
    throw new Error(
      `No superintendent/project-manager with an email on deal ${dealId} - retrying until the team is assigned`,
    );
  }

  // Which super/PM roles are ASSIGNED AT ALL on this deal — an active deal_team_members row for the role,
  // REGARDLESS of whether its identity currently resolves to a usable email. This is deliberately broader than
  // the resolved-recipient query above (which drops inactive users/contacts and blank emails), so we can tell:
  //   - a role ASSIGNED but currently UNRESOLVABLE (inactive identity, or missing/invalid email) → the delivery
  //     is INCOMPLETE this run: that responder was never notified, so we must NOT stamp (leave re-runnable);
  //   - a role NOT ASSIGNED AT ALL → nothing owed for it, so a deal with only one of the two roles can still be
  //     complete once that one role is delivered.
  // "Required" = every role that IS assigned. This is the minimal coherent rule: don't stamp until every
  // assigned super/PM role has been delivered; unassigned roles owe nothing. (finding 4)
  const assignedRes = await query(
    `SELECT DISTINCT dtm.role AS role
       FROM ${tenantSchema}.deal_team_members dtm
      WHERE dtm.deal_id = $1::uuid
        AND dtm.is_active = TRUE
        AND dtm.role IN ('superintendent', 'project_manager')`,
    [dealId]
  );
  const assignedRoles = new Set<RecipientRole>();
  for (const row of assignedRes.rows as any[]) {
    const role = row.role as RecipientRole;
    if (role === "superintendent" || role === "project_manager") assignedRoles.add(role);
  }
  // Roles that ARE assigned but did NOT resolve into a deliverable recipient this run.
  const unresolvedAssignedRoles = [...assignedRoles].filter((role) => !resolvedRoles.has(role));

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

  // NOTE: we deliberately do NOT blanket-delete this scorecard's outstanding tokens up front. On a retry
  // after a PARTIAL delivery (recipient A sent, B failed before the scorecard-level stamp), a blanket delete
  // would drop A's ALREADY-DELIVERED token — and A can't be re-sent (we can't reconstruct A's raw token to
  // rebuild the link), so A would be stranded on the deleted one. Instead, token rotation is per-recipient
  // inside the loop: a recipient who already holds an
  // unexpired/unconsumed AND DELIVERED token was emailed on a prior attempt, so we reuse it (skip re-mint +
  // re-send); a recipient whose send fails has their just-minted token deleted before we rethrow, so the retry
  // re-mints and re-sends them a fresh, working link. Only the OFFICE tenant schema is interpolated (regex-
  // validated).

  // Send one email per recipient with the link appropriate to their identity.
  for (const recipient of recipients) {
    let link: string;
    let mintedTokenHash: string | null = null;
    if (recipient.userId) {
      // CRM user → TRock Cam deep link (they respond in-app). The scheme + path must match the app exactly:
      // the Expo config `scheme` is `trockcam` (app.config.ts) and the expo-router file route is
      // app/(app)/scorecards/corrective-action/[id].tsx, so the deep link is
      // trockcam://scorecards/corrective-action/<id> (the `(app)` group is transparent in the URL).
      link = `trockcam://scorecards/corrective-action/${encodeURIComponent(scorecardId)}`;
    } else {
      // Email-only → they respond via a tokenized web link. Reuse an existing token ONLY when it was actually
      // DELIVERED (delivered_at IS NOT NULL) — delivery ≠ token existence. The row is inserted BEFORE the send,
      // so a crash in that window (or a send failure whose cleanup delete didn't land) leaves an undelivered
      // token; skipping on mere existence would strand the recipient with a link they never got while the
      // scorecard is stamped sent. A delivered token means they were emailed on a prior attempt — we can't
      // reconstruct the raw token to re-send them anyway — so reuse it (skip re-mint + re-send, never rebuilding
      // the idempotency key for them), leaving their working link intact.
      const existing = await query(
        `SELECT 1 FROM ${tenantSchema}.scorecard_corrective_action_tokens
          WHERE scorecard_id = $1::uuid AND LOWER(recipient_email) = LOWER($2)
            AND consumed_at IS NULL AND expires_at > NOW() AND delivered_at IS NOT NULL
          LIMIT 1`,
        [scorecardId, recipient.email]
      );
      if ((existing.rows?.length ?? 0) > 0) {
        logger.log("[CorrectiveActionEmail] Recipient already has a DELIVERED token - reusing (no re-send)", {
          scorecardId,
          role: recipient.role,
        });
        continue;
      }
      // No reuse: mint a FRESH token below. An earlier UNDELIVERED remnant (crash window) is harmless — it
      // never authorizes reuse (delivered_at IS NULL) and token_hash is random-unique, so no collision — so we
      // deliberately don't pre-delete it (keeps rotation strictly per-recipient, no blanket/scan delete).
      const rawToken = crypto.randomBytes(32).toString("base64url");
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
      await query(
        `INSERT INTO ${tenantSchema}.scorecard_corrective_action_tokens
           (scorecard_id, token_hash, recipient_email, role, expires_at)
         VALUES ($1::uuid, $2, $3, $4, $5)`,
        [scorecardId, tokenHash, recipient.email, recipient.role, expiresAt.toISOString()]
      );
      mintedTokenHash = tokenHash;
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

    // The Resend idempotency key must be UNIQUE PER CORRECTIVE-ACTION CYCLE, not just per (scorecard,
    // recipient). A REOPEN deletes the prior cycle's tokens + re-enqueues a fresh job that mints a NEW token
    // (new payload/link). If the key were cycle-stable, Resend would see the same key with a DIFFERENT payload
    // and return `invalid_idempotent_request` — which sendSystemEmailWithMetadata treats as an already-
    // delivered success — so the worker would stamp delivered_at / the scorecard while the email-only
    // responder only holds the now-deleted old link: permanently stranded. Scoping the key to the freshly-
    // minted token hash makes it differ every cycle (each cycle mints a random token → new hash), so the new
    // payload is actually sent; WITHIN a cycle a retry reuses the same undelivered token (or, after a failed
    // send, its replacement) and a genuine crash-window duplicate of a DELIVERED token is skipped before we
    // reach here — so the only time this key is (re)built is at a real mint+send, where cycle-scoping is
    // exactly right. CRM users mint no token (mintedTokenHash === null): their deep link is stable and a
    // suppressed duplicate is never a strand (the app link is always valid), so the (scorecard, recipient)
    // key correctly dedups their within-cycle retries.
    const idempotencyKey = mintedTokenHash
      ? `corrective-action-${tenantSchema}-${scorecardId}-token-${mintedTokenHash}`
      : `corrective-action-${tenantSchema}-${scorecardId}-${recipient.email.toLowerCase()}`;

    let result: SendSystemEmailResult;
    try {
      result = await sendEmail(recipient.email, email.subject, email.html, {
        text: email.text,
        idempotencyKey,
      });
      if (!result.success) throw new Error("Email provider returned unsuccessful result");
    } catch (err) {
      // The send did not succeed. Delete the token we just minted for this recipient (if any) so its raw link
      // — which never reached them — is not left dangling; the retry then re-mints + re-sends a fresh, working
      // link. Delivered recipients' tokens are untouched (we never minted for them this run).
      if (mintedTokenHash) {
        await query(
          `DELETE FROM ${tenantSchema}.scorecard_corrective_action_tokens WHERE token_hash = $1`,
          [mintedTokenHash]
        ).catch(() => undefined);
      }
      throw err;
    }
    // The send succeeded → mark the just-minted token DELIVERED, so a later retry reuses it (skips re-send)
    // instead of re-minting. A crash BEFORE this stamp leaves delivered_at NULL, so the retry (re)sends it —
    // exactly the crash-safe behavior finding 5 requires.
    if (mintedTokenHash) {
      await query(
        `UPDATE ${tenantSchema}.scorecard_corrective_action_tokens SET delivered_at = NOW() WHERE token_hash = $1`,
        [mintedTokenHash]
      );
    }
    logger.log("[CorrectiveActionEmail] Sent corrective-action email", {
      scorecardId,
      role: recipient.role,
      isUser: recipient.userId != null,
      messageId: result.messageId,
    });
  }

  // An ASSIGNED super/PM role that did NOT resolve into a deliverable recipient this run (inactive identity, or
  // missing/invalid email) means the delivery is INCOMPLETE: that responder was never notified. A plain
  // `return` here would leave corrective_action_email_sent_at NULL but COMPLETE the job normally — and a
  // completed queue row never re-runs, so the un-notified role would be stranded forever (nothing re-enqueues
  // on a later identity/email fix). Instead THROW so the queue RETRIES with backoff (max_attempts = 6), giving
  // the role time to be fixed; the final attempt dead-letters (a loud, inspectable give-up that #945's dead-
  // letter sweep alerts on). We deliberately do NOT stamp, so a manual requeue after dead-lettering still
  // notifies.
  //
  // The throw is SAFE against double-notifying a recipient that DID send this run. The handler runs each query
  // via pool.query (NO wrapping transaction — see the worker queue: processJob calls the handler directly and
  // only writes the job_queue outcome on the thrown error), so every delivered_at stamp already written this
  // run is committed and SURVIVES the throw. On the retry: an email-only recipient with a DELIVERED token is
  // reuse-skipped above (no re-mint, no re-send, key never rebuilt); a CRM user is re-sent but under the
  // per-recipient, cycle-stable idempotency key, so Resend dedups the true duplicate. Nobody is emailed twice.
  if (unresolvedAssignedRoles.length > 0) {
    logger.warn(
      "[CorrectiveActionEmail] An assigned super/PM role is unresolvable (inactive identity or missing/invalid email) - throwing to retry (not stamping)",
      { scorecardId, dealId, unresolvedAssignedRoles }
    );
    throw new Error(
      `Assigned super/PM role(s) unresolvable on deal ${dealId} (${unresolvedAssignedRoles.join(", ")}) - retrying until identity/email is fixed`,
    );
  }
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
