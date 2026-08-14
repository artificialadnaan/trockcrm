import { pool } from "../db.js";
import {
  sendSystemEmailWithMetadata,
  type SendSystemEmailAttachment,
  type SendSystemEmailResult,
} from "../lib/system-email.js";
import { getObjectBuffer } from "../lib/r2-client.js";
import { resolveFieldScorecardRecipients } from "@trock-crm/shared/lib/fieldScorecardEmails";
import { escapeHtml, normalizeText, isSafeTenantSchema } from "../lib/email-format.js";
// Reuse the branded-email primitives (frontend URL + hosted logo) so the scorecard email points at
// trockcrm.com and matches the RFP / project-number emails' look.
import { resolveFrontendUrl, TROCK_LOGO_EMAIL_URL } from "./project-number-email.js";

export const FIELD_SCORECARD_EMAIL_JOB = "field_scorecard_email";

// How the PDF is delivered — drives the email copy. "attached": bytes are on the email. "too_large": the
// PDF exists and is downloadable in the CRM but was too big to attach. "unavailable": no PDF yet (still
// generating / render failed) — the CRM will have it once ready.
export type ScorecardPdfDeliveryStatus = "attached" | "too_large" | "unavailable";

// Email providers (Resend) warn/limit around 28 MB, and base64 transfer-encoding inflates a binary
// attachment by ~33%. Keep the raw PDF under ~20 MB so the encoded attachment stays comfortably under that
// ceiling; a larger PDF is delivered as a CRM link instead. The server's per-report evidence cap normally
// keeps the PDF far smaller, so this is a backstop that must never dead-letter a durable submission.
const SCORECARD_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// Renderer v2 is the first artifact revision that embeds scorecard evidence. A pre-deploy retry job may
// still point at a legacy v1 PDF, and a late legacy server in a rolling deploy can overwrite pdf_r2_key
// without downgrading pdf_render_version. Never email either stale shape; the no-attachment CRM-link
// fallback is safer and the download route will regenerate the current artifact on demand.
const MIN_SCORECARD_PDF_RENDER_VERSION_WITH_EVIDENCE = 2;

function isCurrentScorecardPdfArtifactKey(r2Key: string, renderVersion: number): boolean {
  if (!Number.isInteger(renderVersion) || renderVersion < MIN_SCORECARD_PDF_RENDER_VERSION_WITH_EVIDENCE) {
    return false;
  }
  // The server publishes immutable `${scorecardId}.${sha256}.v${version}.pdf` objects. Requiring the
  // digest as well as the revision rejects both pre-v2 PDFs and the old same-key v2 publisher, whose
  // object could be overwritten by an interleaved stale render.
  return new RegExp(`\\.[a-f0-9]{64}\\.v${renderVersion}\\.pdf$`).test(r2Key);
}

export interface FieldScorecardEmailPayload {
  tenantSchema?: string;
  scorecardId?: string;
  dealId?: string;
  dealName?: string;
  projectNumber?: string | null;
  weekOf?: string;
  totalScore?: number;
  formVersion?: 1 | 2;
  // Distinguishes a Leadership Scorecard from a regular Field Scorecard so the email copy names the right card
  // type (the recipients — PM/Super — otherwise can't tell which they received, especially when the PDF isn't
  // attached). Absent/unknown ⇒ treated as a project field scorecard.
  kind?: "project" | "leadership";
  averageScore?: number | null;
  ratingLabel?: string;
  submittedByName?: string | null;
  pdfR2Key?: string | null;
  officeId?: string | null;
  // Per-deal team routing: the server resolves the deal's assigned superintendent / project manager to their
  // user emails at enqueue time and stamps them here. Merged (deduped) into the static env recipients below so
  // the people responsible for THIS deal are notified even when the env list is unset. null = unassigned/no email.
  superintendentEmail?: string | null;
  projectManagerEmail?: string | null;
}

interface HandlerDeps {
  query?: typeof pool.query;
  sendEmail?: (
    to: string | string[],
    subject: string,
    html: string,
    options: { text: string; idempotencyKey: string; attachments?: SendSystemEmailAttachment[] }
  ) => Promise<SendSystemEmailResult>;
  getPdf?: (r2Key: string) => Promise<Buffer | null>;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Email a submitted Field Scorecard (with its rendered PDF attached) to the configured recipients.
 * Enqueued by the server after it renders + stores the PDF on the created-only submit path.
 *
 * Recipients are the deduped union of FIELD_SCORECARD_EMAIL_RECIPIENTS (via the shared resolver) and this
 * deal's assigned superintendent / project-manager emails carried on the payload. If that union is empty
 * (env unset AND no super/PM), this throws so the job retries then dead-letters — the misconfiguration is
 * loud, not a silent no-op. A configured super/PM alone is enough to send even when the env list is empty.
 *
 * Idempotent per scorecard: `field_scorecards.email_sent_at` is checked before sending and stamped after,
 * and the Resend idempotencyKey dedups a re-delivery in the crash window (sent, not yet stamped).
 *
 * The PDF is best-effort: a missing/unfetchable object degrades to a notification WITHOUT the attachment
 * (logged) rather than blocking the send — the submission itself is already durable.
 */
export async function handleFieldScorecardEmail(
  payload: FieldScorecardEmailPayload,
  _officeId: string | null,
  deps: HandlerDeps = {}
): Promise<void> {
  const logger = deps.logger ?? console;
  const tenantSchema = payload.tenantSchema;
  const scorecardId = normalizeText(payload.scorecardId);
  if (!isSafeTenantSchema(tenantSchema) || !scorecardId) {
    logger.warn("[FieldScorecardEmail] Invalid job payload - skipping", { tenantSchema, scorecardId });
    return;
  }

  const env = deps.env ?? process.env;
  // Final recipient list = the static env recipients + this deal's assigned superintendent / project-manager
  // emails (from the payload), de-duplicated case-insensitively. A configured super/PM alone is now enough to
  // send even when the env list is empty; only a TRULY empty union is a loud misconfiguration.
  const recipients = dedupeEmails([
    ...resolveFieldScorecardRecipients(env),
    ...[payload.superintendentEmail, payload.projectManagerEmail]
      .map((raw) => normalizeText(raw))
      .filter((email): email is string => email != null && isBasicValidEmail(email)),
  ]);
  if (recipients.length === 0) {
    const error = new Error("FIELD_SCORECARD_EMAIL_RECIPIENTS is not configured");
    logger.error(
      "[FieldScorecardEmail] No scorecard-email recipients — FIELD_SCORECARD_EMAIL_RECIPIENTS is unset and the deal has no superintendent/project-manager email. Set the env var (comma-separated) or assign the deal team; the job retries a few times, then dead-letters.",
      { scorecardId }
    );
    throw error;
  }

  const query = deps.query ?? pool.query.bind(pool);

  // Idempotency: skip if this scorecard's email was already sent. tenantSchema is regex-validated above, so
  // interpolating it as the schema qualifier is safe (identifiers can't be $-parametrized).
  const existing = await query(
    `SELECT email_sent_at, pdf_r2_key, pdf_render_version FROM ${tenantSchema}.field_scorecards WHERE id = $1::uuid LIMIT 1`,
    [scorecardId]
  );
  if (existing.rows.length === 0) {
    logger.warn("[FieldScorecardEmail] Scorecard not found - skipping", { tenantSchema, scorecardId });
    return;
  }
  if (existing.rows[0].email_sent_at) {
    logger.log("[FieldScorecardEmail] Email already sent - skipping duplicate job", { scorecardId });
    return;
  }

  // The server delays this job so the artifact renderer normally wins the initial race. If it still cannot
  // read the PDF, preserve the notification fallback rather than dead-lettering a durable submission.
  const payloadPdfR2Key = normalizeText(payload.pdfR2Key);
  const storedPdfR2Key = normalizeText(existing.rows[0].pdf_r2_key);
  const rawRenderVersion = existing.rows[0].pdf_render_version;
  const parsedRenderVersion = typeof rawRenderVersion === "number"
    ? rawRenderVersion
    : typeof rawRenderVersion === "string" && rawRenderVersion.trim()
      ? Number(rawRenderVersion)
      : Number.NaN;
  const storedPdfRenderVersion = Number.isInteger(parsedRenderVersion) ? parsedRenderVersion : null;
  // The row is authoritative: file deletion/restoration invalidates the immutable PDF by clearing this
  // key, while an on-demand/version upgrade may legitimately replace the queued payload key with a newer
  // artifact. The key must also match the stamped renderer revision: this rejects both known photo-less
  // v1 artifacts and a legacy writer that finished late and overwrote only pdf_r2_key after v2 was stamped.
  // Never fetch a stale payload-only/key-mismatched artifact that may omit or expose outdated evidence.
  const storedArtifactIsCurrent =
    storedPdfR2Key != null &&
    storedPdfRenderVersion != null &&
    isCurrentScorecardPdfArtifactKey(storedPdfR2Key, storedPdfRenderVersion);
  const pdfR2Key = storedArtifactIsCurrent ? storedPdfR2Key : null;
  let attachments: SendSystemEmailAttachment[] | undefined;
  // Track PDF availability SEPARATELY from whether we attached it: an oversized PDF exists (it's
  // downloadable in the CRM) even though we don't attach it, and the email copy must say so rather than
  // "still generating".
  let pdfStatus: ScorecardPdfDeliveryStatus = "unavailable";
  if (pdfR2Key) {
    const getPdf = deps.getPdf ?? getObjectBuffer;
    let buffer: Buffer | null = null;
    try {
      buffer = await getPdf(pdfR2Key);
    } catch (err) {
      logger.warn("[FieldScorecardEmail] PDF fetch failed - sending without attachment", { scorecardId, pdfR2Key, err });
    }
    if (!buffer) {
      logger.warn("[FieldScorecardEmail] PDF not available in R2 - sending without attachment", { scorecardId, pdfR2Key });
    } else if (buffer.byteLength > SCORECARD_MAX_ATTACHMENT_BYTES) {
      // Oversized PDF: it EXISTS (downloadable in the CRM); deliver the notification with a CRM link rather
      // than attaching (or dead-lettering).
      pdfStatus = "too_large";
      logger.warn("[FieldScorecardEmail] PDF exceeds the safe attachment size - sending without attachment (available in the CRM)", {
        scorecardId,
        pdfR2Key,
        bytes: buffer.byteLength,
        limit: SCORECARD_MAX_ATTACHMENT_BYTES,
      });
    } else {
      attachments = [{ filename: scorecardPdfFilename(payload), content: buffer }];
      pdfStatus = "attached";
    }
  } else {
    logger.warn("[FieldScorecardEmail] No current PDF key - sending without attachment", {
      scorecardId,
      payloadPdfR2Key,
      storedPdfR2Key,
      storedPdfRenderVersion,
    });
  }

  const email = buildFieldScorecardEmail({
    dealId: normalizeText(payload.dealId),
    dealName: normalizeText(payload.dealName) ?? "Project",
    projectNumber: normalizeText(payload.projectNumber),
    weekOf: normalizeText(payload.weekOf),
    totalScore: typeof payload.totalScore === "number" ? payload.totalScore : null,
    formVersion: payload.formVersion === 2 ? 2 : 1,
    kind: payload.kind === "leadership" ? "leadership" : "project",
    averageScore: typeof payload.averageScore === "number" ? payload.averageScore : null,
    ratingLabel: normalizeText(payload.ratingLabel),
    submittedByName: normalizeText(payload.submittedByName),
    pdfStatus,
    officeId: normalizeText(payload.officeId),
    frontendUrl: resolveFrontendUrl(env),
  });

  try {
    const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;
    const result = await sendEmail(recipients, email.subject, email.html, {
      text: email.text,
      idempotencyKey: `field-scorecard-${tenantSchema}-${scorecardId}`,
      attachments,
    });
    if (!result.success) throw new Error("Email provider returned unsuccessful result");

    await query(
      `UPDATE ${tenantSchema}.field_scorecards SET email_sent_at = NOW() WHERE id = $1::uuid AND email_sent_at IS NULL`,
      [scorecardId]
    );
    logger.log("[FieldScorecardEmail] Sent scorecard email", {
      scorecardId,
      recipientCount: recipients.length,
      hadPdf: !!attachments,
      messageId: result.messageId,
    });
  } catch (error) {
    logger.error("[FieldScorecardEmail] Failed to send scorecard email", { scorecardId, error });
    throw error;
  }
}

// De-duplicate a recipient list case-insensitively, preserving the first spelling encountered. Mirrors the
// RFP-decline email's merge so the two features' de-dupe behaviour can't drift.
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

// Basic, deliberately-permissive sanity check on a payload-supplied super/PM address: a single "@" with a
// non-empty local part and a dotted domain, no whitespace. The env recipients are already parsed/trusted; this
// only guards the per-deal emails so a malformed/placeholder value can't become a bogus recipient.
function isBasicValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function scorecardPdfFilename(payload: FieldScorecardEmailPayload): string {
  const num = normalizeText(payload.projectNumber);
  const week = normalizeText(payload.weekOf);
  const base = ["scorecard", num ?? undefined, week ?? undefined].filter(Boolean).join("-") || "field-scorecard";
  return `${base.replace(/[^A-Za-z0-9_-]+/g, "-")}.pdf`;
}

export function buildFieldScorecardEmail(input: {
  dealId: string | null;
  dealName: string;
  projectNumber: string | null;
  weekOf: string | null;
  totalScore: number | null;
  formVersion?: 1 | 2;
  kind?: "project" | "leadership";
  averageScore?: number | null;
  ratingLabel: string | null;
  submittedByName: string | null;
  pdfStatus: ScorecardPdfDeliveryStatus;
  officeId?: string | null;
  frontendUrl: string;
}) {
  const officeParam = input.officeId ? `?officeId=${encodeURIComponent(input.officeId)}` : "";
  const baseUrl = input.frontendUrl.replace(/\/+$/, "");
  const dealUrl = input.dealId ? `${baseUrl}/deals/${encodeURIComponent(input.dealId)}${officeParam}` : baseUrl;
  const safeDealUrl = escapeHtml(dealUrl);

  // Name the card type so a Leadership Scorecard isn't mislabeled as a regular Field Scorecard in the subject,
  // header, and text — the recipients (PM/Super) rely on this when the PDF isn't attached.
  const cardLabel = input.kind === "leadership" ? "Leadership Scorecard" : "Field Scorecard";
  const scoreText = input.totalScore == null
    ? "—"
    : input.formVersion === 2
      ? (input.averageScore ?? input.totalScore / 10).toFixed(1) + "/10"
      : String(input.totalScore) + "/100";
  const subject = input.projectNumber
    ? `${cardLabel}: ${input.projectNumber} — ${scoreText}${input.ratingLabel ? ` (${input.ratingLabel})` : ""}`
    : `${cardLabel}: ${input.dealName} — ${scoreText}`;

  const rows = [
    ["Project", input.dealName],
    ["Project number", input.projectNumber ?? "—"],
    ["Week of", input.weekOf ?? "—"],
    ["Score", `${scoreText}${input.ratingLabel ? ` · ${input.ratingLabel}` : ""}`],
    ["Submitted by", input.submittedByName ?? "—"],
  ] as const;

  const htmlRows = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;vertical-align:top;width:150px;">${escapeHtml(label)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;font-weight:bold;vertical-align:top;">${escapeHtml(value)}</td>
        </tr>`
    )
    .join("");

  const pdfNote =
    input.pdfStatus === "attached"
      ? "The full scorecard is attached as a PDF."
      : input.pdfStatus === "too_large"
        ? "The full scorecard PDF is too large to attach — open the deal in the CRM to download it."
        : "The full scorecard PDF is still generating — open the deal in the CRM to view it.";

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${escapeHtml(cardLabel)}</title>
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
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">${escapeHtml(cardLabel)} Submitted</h1>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:6px 24px 16px 24px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;">${escapeHtml(pdfNote)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid #e2e8f0;">${htmlRows}
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 24px 24px 24px;">
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
    `${cardLabel} submitted\n\n` +
    rows.map(([label, value]) => `${label}: ${value}`).join("\n") +
    `\n\n${pdfNote}` +
    `\n\nView the deal in the CRM: ${dealUrl}`;

  return { subject, html, text, dealUrl };
}
