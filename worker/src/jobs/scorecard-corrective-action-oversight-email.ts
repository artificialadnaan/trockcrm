import { pool } from "../db.js";
import {
  sendSystemEmailWithMetadata,
  type SendSystemEmailAttachment,
} from "../lib/system-email.js";
import { getObjectBuffer } from "../lib/r2-client.js";
import { escapeHtml, normalizeText, isSafeTenantSchema } from "../lib/email-format.js";
import { resolveFrontendUrl, TROCK_LOGO_EMAIL_URL } from "./project-number-email.js";
import { resolveFieldScorecardRecipients } from "@trock-crm/shared/lib/fieldScorecardEmails";
import { recipientResolutionSql } from "./scorecard-corrective-action-email.js";

/**
 * OVERSIGHT notification for the corrective-action lifecycle.
 *
 * Distinct from `scorecard_corrective_action_email`, which notifies the RESPONDERS (the scorecard's picked
 * field responder, or the deal's assigned superintendent / project manager) and embeds a per-recipient token
 * that AUTHORIZES answering. This job tells the watchers configured in FIELD_SCORECARD_EMAIL_RECIPIENTS that
 * a corrective action opened and, later, that it completed.
 *
 * It MUST be a separate email, never a CC on the responder email: CC'ing an oversight watcher onto a
 * token-bearing message would hand them a live credential bound to someone else's identity. Nothing this job
 * sends contains a token or a responder link.
 *
 * Exactly two sends per corrective-action cycle — one `opened`, one `closed`.
 */
export const SCORECARD_CORRECTIVE_ACTION_OVERSIGHT_EMAIL_JOB =
  "scorecard_corrective_action_oversight_email";

/**
 * Renderer revision that first embedded the corrective-action record. Attaching an older artifact to a
 * "corrective action completed" email would show the card WITHOUT the corrective action on it — precisely
 * the defect this feature exists to fix — so a pre-v3 artifact is dropped in favour of the CRM link.
 */
const MIN_PDF_RENDER_VERSION_WITH_CORRECTIVE_ACTIONS = 3;

// Mirrors field-scorecard-email: Resend warns around 28 MB and base64 inflates a binary attachment by ~33%,
// so keep the raw PDF under ~20 MB. A larger PDF is delivered as a CRM link instead.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type CorrectiveActionOversightPhase = "opened" | "closed";

export interface ScorecardCorrectiveActionOversightEmailPayload {
  tenantSchema?: string;
  scorecardId?: string;
  dealId?: string;
  officeId?: string | null;
  phase?: CorrectiveActionOversightPhase;
  /**
   * The cycle nonce active at enqueue. Used ONLY as the Resend idempotency-key dimension, so a genuine
   * reopen sends again while a queue retry does not. Deliberately NEVER compared against the scorecard's
   * stored corrective_action_cycle_nonce — see the dedup note in the handler.
   */
  cycleNonce?: string;
}

interface HandlerDeps {
  query?: typeof pool.query;
  sendEmail?: typeof sendSystemEmailWithMetadata;
  getPdf?: typeof getObjectBuffer;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/** The phase's own stamp column. A literal switch — the phase never reaches SQL as interpolated text. */
function stampColumn(phase: CorrectiveActionOversightPhase): string {
  return phase === "opened"
    ? "corrective_action_oversight_opened_at"
    : "corrective_action_oversight_closed_at";
}

interface ScorecardRow {
  deal_id: string | null;
  deal_name: string | null;
  project_number: string | null;
  week_of: string | Date | null;
  total_score: number | null;
  average_score: string | number | null;
  rating: string | null;
  form_version: number | null;
  status: string | null;
  pdf_r2_key: string | null;
  pdf_render_version: number | null;
  corrective_action_oversight_opened_at: Date | null;
  corrective_action_oversight_closed_at: Date | null;
}

interface ItemRow {
  item_type: string;
  item_ref: string;
  item_label: string;
  status: string;
  responder_name: string | null;
  responded_at: Date | null;
  response_comment: string | null;
  photo_count: number | string;
}

/**
 * Notify the oversight watchers that a corrective action opened or completed.
 *
 * Idempotency is the PHASE'S OWN STAMP (corrective_action_oversight_opened_at / _closed_at), never the cycle
 * nonce. The responder job has a worker-side self-repair path that rotates
 * field_scorecards.corrective_action_cycle_nonce and re-enqueues itself when recipients could not be resolved
 * or new open work appeared. A pending oversight job minted under the older nonce would then find
 * payload != stored and return early, and the "opened" notice would never be sent at all. The stamp is what
 * actually encodes "oversight has not yet been told about this cycle"; a fresh cycle clears it server-side.
 *
 * An empty recipient set LOGS AND RETURNS rather than throwing. This differs from handleFieldScorecardEmail,
 * where an empty union means the scorecard reaches nobody — here the responders have already been notified by
 * their own job, so oversight is supplementary and a dead-letter would be pure noise.
 */
export async function handleScorecardCorrectiveActionOversightEmail(
  payload: ScorecardCorrectiveActionOversightEmailPayload,
  _officeId: string | null,
  deps: HandlerDeps = {},
): Promise<void> {
  const logger = deps.logger ?? console;
  const env = deps.env ?? process.env;
  const query = deps.query ?? pool.query.bind(pool);

  const tenantSchema = payload.tenantSchema;
  const scorecardId = normalizeText(payload.scorecardId);
  const phase = payload.phase;
  if (!isSafeTenantSchema(tenantSchema) || !scorecardId || (phase !== "opened" && phase !== "closed")) {
    logger.warn("[CorrectiveActionOversightEmail] Invalid job payload - skipping", {
      tenantSchema,
      scorecardId,
      phase,
    });
    return;
  }

  const column = stampColumn(phase);
  // tenantSchema is regex-validated above, so interpolating it as the schema qualifier is safe (identifiers
  // cannot be $-parametrized). `column` comes from the literal switch, never from the payload.
  const scorecardResult = await query(
    `SELECT sc.deal_id, sc.project_number, sc.week_of, sc.total_score, sc.average_score, sc.rating,
            sc.form_version, sc.status, sc.pdf_r2_key, sc.pdf_render_version,
            sc.corrective_action_oversight_opened_at, sc.corrective_action_oversight_closed_at,
            d.name AS deal_name
       FROM ${tenantSchema}.field_scorecards sc
       LEFT JOIN ${tenantSchema}.deals d ON d.id = sc.deal_id
      WHERE sc.id = $1::uuid
      LIMIT 1`,
    [scorecardId],
  );
  const scorecard = scorecardResult.rows[0] as ScorecardRow | undefined;
  if (!scorecard) {
    logger.warn("[CorrectiveActionOversightEmail] Scorecard not found - skipping", { scorecardId });
    return;
  }

  const alreadySent =
    phase === "opened"
      ? scorecard.corrective_action_oversight_opened_at
      : scorecard.corrective_action_oversight_closed_at;
  if (alreadySent) {
    logger.log("[CorrectiveActionOversightEmail] Already notified for this cycle - skipping", {
      scorecardId,
      phase,
    });
    return;
  }

  // Oversight recipients MINUS the cycle's responders: a superintendent who is also on the env list should
  // get "please fix this", not additionally "someone needs to fix this" for the same card.
  const configured = resolveFieldScorecardRecipients(env);
  const responderResult = await query(recipientResolutionSql(tenantSchema), [
    scorecard.deal_id,
    scorecardId,
  ]);
  const responderEmails = new Set(
    (responderResult.rows as Array<{ email: string | null }>)
      .map((row) => normalizeText(row.email)?.toLowerCase())
      .filter((email): email is string => !!email),
  );
  const recipients = dedupe(
    configured.filter((email) => !responderEmails.has(email.trim().toLowerCase())),
  );
  if (recipients.length === 0) {
    logger.warn(
      "[CorrectiveActionOversightEmail] No oversight recipients after excluding responders - skipping (not an error: the responders were notified by their own job)",
      { scorecardId, phase, configuredCount: configured.length },
    );
    return;
  }

  const itemsResult = await query(
    `SELECT ca.item_type, ca.item_ref, ca.item_label, ca.status, ca.responder_name, ca.responded_at,
            ca.response_comment,
            (SELECT COUNT(*) FROM ${tenantSchema}.field_scorecard_photos p
              WHERE p.corrective_action_id = ca.id) AS photo_count
       FROM ${tenantSchema}.scorecard_corrective_actions ca
      WHERE ca.scorecard_id = $1::uuid
      -- Numeric-aware ordering: item_ref is an action-item INDEX, where "10" must follow "2". Matches the
      -- deal thread and the PDF.
      ORDER BY CASE WHEN ca.item_type = 'action_item' THEN 0 ELSE 1 END,
               CASE WHEN ca.item_ref ~ '^[0-9]+$' THEN LPAD(ca.item_ref, 12, '0') ELSE ca.item_ref END`,
    [scorecardId],
  );
  const items = itemsResult.rows as ItemRow[];

  // The completed notice carries the refreshed PDF — which is only meaningful from v3, the revision that
  // first embedded the corrective-action record. Best-effort: a missing or oversized object degrades to a
  // no-attachment send rather than blocking the notification.
  let attachments: SendSystemEmailAttachment[] | undefined;
  if (phase === "closed") {
    attachments = await loadPdfAttachment(scorecard, scorecardId, deps, logger);
  }

  const email = buildOversightEmail({
    phase,
    dealName: scorecard.deal_name ?? "Project",
    projectNumber: normalizeText(scorecard.project_number) ?? null,
    weekOf: formatWeekOf(scorecard.week_of),
    scoreText: formatScore(scorecard),
    items,
    link: `${resolveFrontendUrl(env)}/deals/${scorecard.deal_id ?? ""}?tab=scorecards`,
  });

  const cycleDimension = normalizeText(payload.cycleNonce) ?? "none";
  const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;
  const result = await sendEmail(recipients, email.subject, email.html, {
    text: email.text,
    // Retry-stable (immutable across a job's retries) and cycle-distinct (a genuine reopen mints a fresh
    // nonce AND clears the stamp, so it sends again). Omitting the cycle dimension would false-dedup a
    // reopen, and Resend's invalid_idempotent_request then reads as delivered.
    idempotencyKey: `corrective-action-oversight-${tenantSchema}-${scorecardId}-${phase}-cycle-${cycleDimension}`,
    attachments,
  });
  if (!result.success) {
    // Throw so the queue retries then dead-letters. Returning normally would COMPLETE the job with the
    // stamp unset, and nothing would ever notify.
    throw new Error(
      `[CorrectiveActionOversightEmail] Email provider returned unsuccessful result for ${scorecardId} (${phase})`,
    );
  }

  await query(
    `UPDATE ${tenantSchema}.field_scorecards
        SET ${column} = NOW()
      WHERE id = $1::uuid
        AND ${column} IS NULL`,
    [scorecardId],
  );
  logger.log("[CorrectiveActionOversightEmail] Notified oversight", {
    scorecardId,
    phase,
    recipientCount: recipients.length,
    attached: Boolean(attachments?.length),
  });
}

async function loadPdfAttachment(
  scorecard: ScorecardRow,
  scorecardId: string,
  deps: HandlerDeps,
  logger: Pick<Console, "log" | "warn" | "error">,
): Promise<SendSystemEmailAttachment[] | undefined> {
  const pdfR2Key = normalizeText(scorecard.pdf_r2_key);
  const renderVersion = Number(scorecard.pdf_render_version ?? 0);
  if (!pdfR2Key || renderVersion < MIN_PDF_RENDER_VERSION_WITH_CORRECTIVE_ACTIONS) {
    logger.warn(
      "[CorrectiveActionOversightEmail] No corrective-action-bearing PDF - sending without attachment (available in the CRM)",
      { scorecardId, pdfR2Key, renderVersion },
    );
    return undefined;
  }
  const getPdf = deps.getPdf ?? getObjectBuffer;
  try {
    const buffer = await getPdf(pdfR2Key);
    if (!buffer || buffer.byteLength === 0) {
      logger.warn("[CorrectiveActionOversightEmail] PDF not available in R2 - sending without attachment", {
        scorecardId,
        pdfR2Key,
      });
      return undefined;
    }
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      logger.warn("[CorrectiveActionOversightEmail] PDF exceeds the safe attachment size - sending without attachment", {
        scorecardId,
        bytes: buffer.byteLength,
      });
      return undefined;
    }
    return [{ filename: `field-scorecard-${scorecardId}.pdf`, content: buffer }];
  } catch (err) {
    logger.warn("[CorrectiveActionOversightEmail] PDF fetch failed - sending without attachment", {
      scorecardId,
      pdfR2Key,
      err,
    });
    return undefined;
  }
}

function dedupe(emails: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const email = raw?.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

function formatWeekOf(weekOf: string | Date | null): string | null {
  if (!weekOf) return null;
  return weekOf instanceof Date ? weekOf.toISOString().slice(0, 10) : String(weekOf).slice(0, 10);
}

function formatScore(scorecard: ScorecardRow): string {
  const average = scorecard.average_score == null ? null : Number(scorecard.average_score);
  if (scorecard.form_version === 2 && average != null && Number.isFinite(average)) {
    return `${average.toFixed(1)} / 10`;
  }
  return `${scorecard.total_score ?? 0}`;
}

function formatRespondedAt(value: Date | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/**
 * The oversight email body. Carries NO token and NO responder link — only a CRM deep link to the deal's
 * Scorecards tab, which is session-authenticated.
 */
export function buildOversightEmail(input: {
  phase: CorrectiveActionOversightPhase;
  dealName: string;
  projectNumber: string | null;
  weekOf: string | null;
  scoreText: string;
  items: ItemRow[];
  link: string;
}) {
  const opened = input.phase === "opened";
  const title = opened ? "Corrective Action Opened" : "Corrective Action Completed";
  const project = input.projectNumber ? `${input.projectNumber} — ${input.dealName}` : input.dealName;
  const subject = opened
    ? `Corrective action opened: ${project} (${input.scoreText})`
    : `Corrective action completed: ${project}`;

  const intro = opened
    ? `A field scorecard for <strong>${escapeHtml(input.dealName)}</strong>${input.projectNumber ? ` (${escapeHtml(input.projectNumber)})` : ""}${input.weekOf ? `, week of ${escapeHtml(input.weekOf)}` : ""} came in below standard (${escapeHtml(input.scoreText)}) and a corrective action has been opened. The assigned superintendent and project manager have been asked to document a fix for each flagged item.`
    : `The corrective action for <strong>${escapeHtml(input.dealName)}</strong>${input.projectNumber ? ` (${escapeHtml(input.projectNumber)})` : ""}${input.weekOf ? `, week of ${escapeHtml(input.weekOf)}` : ""} is complete. Every flagged item has been documented. The updated scorecard is attached where available.`;

  const textIntro = opened
    ? `A field scorecard for ${input.dealName}${input.projectNumber ? ` (${input.projectNumber})` : ""}${input.weekOf ? `, week of ${input.weekOf}` : ""} came in below standard (${input.scoreText}) and a corrective action has been opened.`
    : `The corrective action for ${input.dealName}${input.projectNumber ? ` (${input.projectNumber})` : ""}${input.weekOf ? `, week of ${input.weekOf}` : ""} is complete.`;

  const htmlItems = input.items.length
    ? `<ul style="margin:12px 0 0 0;padding-left:20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#111111;">${input.items
        .map((item) => {
          const resolved = item.status === "resolved";
          const who = normalizeText(item.responder_name);
          const when = formatRespondedAt(item.responded_at);
          const comment = normalizeText(item.response_comment);
          const photos = Number(item.photo_count ?? 0);
          const detail = resolved
            ? `<span style="color:#16a34a;font-weight:bold;">Resolved</span>${who || when ? ` — ${escapeHtml([who, when].filter(Boolean).join(" · "))}` : ""}${comment ? `<br /><span style="color:#475569;">${escapeHtml(comment)}</span>` : ""}${photos > 0 ? `<br /><span style="color:#94a3b8;font-size:12px;">${photos} photo${photos === 1 ? "" : "s"}</span>` : ""}`
            : `<span style="color:#CC0000;font-weight:bold;">Open</span>`;
          return `<li style="margin-bottom:10px;">${escapeHtml(item.item_label)}<br />${detail}</li>`;
        })
        .join("")}</ul>`
    : `<p style="margin:12px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#64748b;">See the CRM for the flagged items.</p>`;

  const textItems = input.items.length
    ? input.items
        .map((item) => {
          const resolved = item.status === "resolved";
          if (!resolved) return `• ${item.item_label} — Open`;
          const who = normalizeText(item.responder_name);
          const when = formatRespondedAt(item.responded_at);
          const comment = normalizeText(item.response_comment);
          const photos = Number(item.photo_count ?? 0);
          return (
            `• ${item.item_label} — Resolved` +
            `${who || when ? ` (${[who, when].filter(Boolean).join(" · ")})` : ""}` +
            `${comment ? `\n    ${comment}` : ""}` +
            `${photos > 0 ? `\n    ${photos} photo${photos === 1 ? "" : "s"}` : ""}`
          );
        })
        .join("\n")
    : "• (see the CRM for the flagged items)";

  const safeLink = escapeHtml(input.link);

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;">
          <tr><td style="background-color:${opened ? "#CC0000" : "#16a34a"};height:4px;line-height:4px;font-size:4px;">&nbsp;</td></tr>
          <tr>
            <td align="center" style="padding:28px 24px 8px 24px;">
              <img src="${TROCK_LOGO_EMAIL_URL}" alt="T Rock Construction" width="220" height="246" style="display:block;width:220px;height:246px;border:0;" />
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:4px 24px 0 24px;">
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">${escapeHtml(title)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 28px 0 28px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#111111;">${intro}</p>
              ${htmlItems}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px;">
              <a href="${safeLink}" style="display:inline-block;background-color:#CC0000;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:44px;text-align:center;text-decoration:none;width:280px;border-radius:4px;">View in the CRM</a>
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
    `${title}\n\n` +
    `${textIntro}\n\n` +
    `${textItems}\n\n` +
    `View in the CRM: ${input.link}`;

  return { subject, html, text };
}
