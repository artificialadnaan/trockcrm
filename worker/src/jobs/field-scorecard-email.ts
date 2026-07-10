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

export interface FieldScorecardEmailPayload {
  tenantSchema?: string;
  scorecardId?: string;
  dealId?: string;
  dealName?: string;
  projectNumber?: string | null;
  weekOf?: string;
  totalScore?: number;
  formVersion?: 1 | 2;
  averageScore?: number | null;
  ratingLabel?: string;
  submittedByName?: string | null;
  pdfR2Key?: string | null;
  officeId?: string | null;
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
 * Recipients come from FIELD_SCORECARD_EMAIL_RECIPIENTS (via the shared resolver). If unset in prod, this
 * throws so the job retries then dead-letters — the misconfiguration is loud, not a silent no-op.
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
  const recipients = resolveFieldScorecardRecipients(env);
  if (recipients.length === 0) {
    const error = new Error("FIELD_SCORECARD_EMAIL_RECIPIENTS is not configured");
    logger.error(
      "[FieldScorecardEmail] FIELD_SCORECARD_EMAIL_RECIPIENTS is not set - cannot send the scorecard email. Set it (comma-separated) on the worker service; the job retries a few times, then dead-letters.",
      { scorecardId }
    );
    throw error;
  }

  const query = deps.query ?? pool.query.bind(pool);

  // Idempotency: skip if this scorecard's email was already sent. tenantSchema is regex-validated above, so
  // interpolating it as the schema qualifier is safe (identifiers can't be $-parametrized).
  const existing = await query(
    `SELECT email_sent_at FROM ${tenantSchema}.field_scorecards WHERE id = $1::uuid LIMIT 1`,
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

  // The artifact renderer runs after submission. If the deterministic PDF key is not readable yet, fail
  // this attempt so the job queue retries instead of sending a permanently attachment-less email.
  const pdfR2Key = normalizeText(payload.pdfR2Key);
  let attachments: SendSystemEmailAttachment[] | undefined;
  if (pdfR2Key) {
    const getPdf = deps.getPdf ?? getObjectBuffer;
    let buffer: Buffer | null = null;
    try {
      buffer = await getPdf(pdfR2Key);
    } catch (err) {
      logger.warn("[FieldScorecardEmail] PDF fetch failed - retrying email job", { scorecardId, pdfR2Key, err });
      throw err;
    }
    if (buffer) {
      attachments = [{ filename: scorecardPdfFilename(payload), content: buffer }];
    } else {
      throw new Error(`Scorecard PDF is not available yet: ${pdfR2Key}`);
    }
  } else {
    logger.warn("[FieldScorecardEmail] No PDF key on the job - sending without attachment", { scorecardId });
  }

  const email = buildFieldScorecardEmail({
    dealId: normalizeText(payload.dealId),
    dealName: normalizeText(payload.dealName) ?? "Project",
    projectNumber: normalizeText(payload.projectNumber),
    weekOf: normalizeText(payload.weekOf),
    totalScore: typeof payload.totalScore === "number" ? payload.totalScore : null,
    formVersion: payload.formVersion === 2 ? 2 : 1,
    averageScore: typeof payload.averageScore === "number" ? payload.averageScore : null,
    ratingLabel: normalizeText(payload.ratingLabel),
    submittedByName: normalizeText(payload.submittedByName),
    hasPdf: !!attachments,
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
  averageScore?: number | null;
  ratingLabel: string | null;
  submittedByName: string | null;
  hasPdf: boolean;
  officeId?: string | null;
  frontendUrl: string;
}) {
  const officeParam = input.officeId ? `?officeId=${encodeURIComponent(input.officeId)}` : "";
  const baseUrl = input.frontendUrl.replace(/\/+$/, "");
  const dealUrl = input.dealId ? `${baseUrl}/deals/${encodeURIComponent(input.dealId)}${officeParam}` : baseUrl;
  const safeDealUrl = escapeHtml(dealUrl);

  const scoreText = input.totalScore == null
    ? "—"
    : input.formVersion === 2
      ? (input.averageScore ?? input.totalScore / 10).toFixed(1) + "/10"
      : String(input.totalScore) + "/100";
  const subject = input.projectNumber
    ? `Field Scorecard: ${input.projectNumber} — ${scoreText}${input.ratingLabel ? ` (${input.ratingLabel})` : ""}`
    : `Field Scorecard: ${input.dealName} — ${scoreText}`;

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

  const pdfNote = input.hasPdf
    ? "The full scorecard is attached as a PDF."
    : "The full scorecard PDF is still generating — open the deal in the CRM to view it.";

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>Field Scorecard</title>
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
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">Field Scorecard Submitted</h1>
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
    `Field Scorecard submitted\n\n` +
    rows.map(([label, value]) => `${label}: ${value}`).join("\n") +
    `\n\n${pdfNote}` +
    `\n\nView the deal in the CRM: ${dealUrl}`;

  return { subject, html, text, dealUrl };
}
