import { pool } from "../db.js";
import {
  sendSystemEmailWithMetadata,
  type SendSystemEmailAttachment,
  type SendSystemEmailResult,
} from "../lib/system-email.js";
import { getObjectBuffer } from "../lib/r2-client.js";
import { escapeHtml, normalizeText, isSafeTenantSchema } from "../lib/email-format.js";
import { WEEKLY_REPORT_DELIVERY_TAG } from "@trock-crm/shared/lib/weeklyReportDelivery";
import {
  normalizeWeeklyReportRecipients,
  weeklyReportEmailParagraphBlocks,
  weeklyReportEmailBodyText,
  weeklyReportSignatureLines,
  WEEKLY_REPORT_SEND_OUTCOME_REJECTED,
  WEEKLY_REPORT_SEND_OUTCOME_UNKNOWN,
  type WeeklyReportEmailParts,
  type WeeklyReportSenderContact,
} from "@trock-crm/shared/lib/weeklyReportEmail";
import { TROCK_LOGO_EMAIL_URL } from "../lib/branded-email.js";

// Deliver one weekly report to its client: render the PDF, attach it, send it, and record the outcome.
//
// WHAT MAKES THIS DIFFERENT FROM THE SCORECARD EMAIL IT IS MODELLED ON. That job is fire-and-forget: the
// scorecard is durable, the notification is a convenience, and a lost one is noticed by nobody because
// nobody outside the company was waiting for it. Here the recipient is a CLIENT who was told they would
// receive their weekly report, and a silent failure means they never do and nobody finds out. So every
// attempt is written back to the row — `send_attempts`, `send_error`, `send_last_attempt_at` — and the
// dashboard surfaces the result as a chip a PM has to act on.
//
// IDEMPOTENCY, twice over, because the worker restarts routinely and a second copy of a client-facing
// report is worse than a late one:
//   1. `send_delivered_at` is checked before anything is sent and stamped after. A redelivered job for an
//      already-delivered report is a no-op.
//   2. The provider idempotency key is keyed on `send_delivery_key`, which the API mints per SEND REQUEST.
//      That covers the window (1) cannot: provider accepted, process died before the stamp. A retry
//      replays the same key and the provider answers "already delivered" rather than sending again. Only
//      a CORRECTION — a new report row — gets a new key, and a correction is meant to reach the client.
//
// AND `send_delivered_at` STILL ONLY MEANS "ACCEPTED". Nothing this job can observe says the client's mail
// server took the message; that answer arrives later, on the provider's delivery webhook, which the API
// serves at /api/webhooks/resend and correlates through the delivery key this job TAGS the message with
// (see `deliveryTags` below). The verdict lands in `send_delivery_status` (0227) — a sibling column, not a
// redefinition of this one.

export const WEEKLY_REPORT_SEND_JOB = "weekly_report_send";

/**
 * Resend warns around 28 MB and base64 inflates a binary attachment by ~33%. A report over this goes out
 * WITHOUT the attachment rather than not at all — the link in the body is the primary artifact and the PDF
 * is a convenience, so a huge photo set must not cost the client their report.
 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface WeeklyReportSendPayload {
  reportId?: string;
  officeSlug?: string;
  tenantSchema?: string;
  /** Which send request this delivery belongs to. A job left over from an earlier one is dropped. */
  deliveryKey?: string;
}

/** The `send_request` jsonb, as written by server/src/modules/weekly-reports/send-service.ts. */
interface StoredSendRequest {
  recipients?: unknown;
  subject?: unknown;
  greetingName?: unknown;
  contextParagraph?: unknown;
  shareUrl?: unknown;
  sender?: { name?: unknown; email?: unknown; phone?: unknown } | null;
  attachPdf?: unknown;
  isCorrection?: unknown;
}

interface HandlerDeps {
  query?: typeof pool.query;
  sendEmail?: (
    to: string | string[],
    subject: string,
    html: string,
    options: { text: string; idempotencyKey: string; attachments?: SendSystemEmailAttachment[] },
  ) => Promise<SendSystemEmailResult>;
  getPdf?: (r2Key: string) => Promise<Buffer | null>;
  /** Resolves (rendering if needed) the report's current PDF key. Injected so the suite needs no pdfkit. */
  resolvePdfKey?: (officeSlug: string, reportId: string) => Promise<string | null>;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

const SERVER_PDF_MODULES = [
  "../../../server/dist/modules/weekly-reports/pdf-service.js",
  "../../../server/src/modules/weekly-reports/pdf-service.js",
] as const;
const SERVER_OFFICE_MODULES = [
  "../../../server/dist/modules/weekly-reports/office-connection.js",
  "../../../server/src/modules/weekly-reports/office-connection.js",
] as const;

async function importFirstAvailable<T>(paths: readonly string[]): Promise<T> {
  let lastError: unknown;
  for (const path of paths) {
    try {
      return (await import(path)) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to import server module");
}

/**
 * Render (or reuse) the report's PDF through the SERVER's publisher.
 *
 * The renderer lives in the server package because everything it needs does — pdfkit, sharp, the R2
 * client, the bundled fonts. The worker reaches it the same way procore-photos.ts reaches the R2 client.
 * Crucially this goes through `resolveArtifactKey`, so a report whose artifact is already current is not
 * re-rendered: the content-addressed key means the second delivery of the same content is a lookup.
 */
async function resolveWeeklyReportPdfKeyViaServer(
  officeSlug: string,
  reportId: string,
): Promise<string | null> {
  const pdfService = await importFirstAvailable<{
    loadWeeklyReportPdfSource: (client: any, reportId: string) => Promise<any>;
    resolveArtifactKey: (officeSlug: string, source: any) => Promise<string>;
  }>(SERVER_PDF_MODULES);
  const officeConnection = await importFirstAvailable<{
    withWeeklyReportOfficeClient: <T>(
      officeSlug: string,
      options: Record<string, unknown>,
      run: (client: any) => Promise<T>,
    ) => Promise<T>;
  }>(SERVER_OFFICE_MODULES);

  // Read inside a SHORT transaction and let it commit before rendering. The render downloads and
  // transcodes every photo and then uploads to R2; holding a pooled connection across that is the
  // documented cause of the API pool saturating.
  const source = await officeConnection.withWeeklyReportOfficeClient(officeSlug, {}, (client) =>
    pdfService.loadWeeklyReportPdfSource(client, reportId),
  );
  if (!source) return null;
  return pdfService.resolveArtifactKey(officeSlug, source);
}

function senderFrom(raw: StoredSendRequest["sender"]): WeeklyReportSenderContact {
  return {
    name: normalizeText(raw?.name),
    email: normalizeText(raw?.email),
    phone: normalizeText(raw?.phone),
  };
}

/** The filename the client's downloads folder gets. ASCII-folded; the report uuid is not their business. */
export function weeklyReportAttachmentFilename(input: {
  propertyName: string | null;
  weekOf: string | null;
}): string {
  const property = (input.propertyName ?? "")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const base = `${property || "Weekly Report"} - Weekly Report ${input.weekOf ?? ""}`.trim();
  return `${base.replace(/[^A-Za-z0-9 _.-]+/g, "-")}.pdf`;
}

/**
 * The email itself, built from the SAME paragraph list the API previewed to the PM.
 *
 * `weeklyReportEmailParagraphs` is shared, so the plain-text part, the HTML part and the preview in the
 * modal cannot say different things — this function only decides markup. Arial/Helvetica is deliberate:
 * webfonts do not load in Outlook or Gmail desktop.
 */
export function buildWeeklyReportClientEmail(parts: WeeklyReportEmailParts & { subject: string }) {
  const paragraphs = weeklyReportEmailParagraphBlocks(parts);
  const text = weeklyReportEmailBodyText(parts);
  const shareUrl = (parts.shareUrl ?? "").trim();
  const safeShareUrl = escapeHtml(shareUrl);

  const htmlParagraphs = paragraphs
    .map((paragraph) => {
      // The link paragraph is rendered as a button below, so it is not repeated as text. Selected by its
      // KIND, never by searching its text for the URL: that earlier test dropped the PM's entire message
      // whenever they happened to paste the link into it — and only from the HTML part, so the plain-text
      // alternative still carried it and the two halves of one email disagreed.
      if (paragraph.kind === "link") return "";
      return `
          <tr>
            <td style="padding:0 28px 14px 28px;font-family:Arial,Helvetica,sans-serif;font-size:14.5px;line-height:22px;color:#111111;">${escapeHtml(
              paragraph.text,
            ).replace(/\n/g, "<br />")}</td>
          </tr>`;
    })
    .join("");

  // THE FOOTER MUST NOT PROMISE A REPLY PATH THAT DOES NOT EXIST. It used to read "Reply to this email to
  // reach your project manager", and nothing routes a reply anywhere near the PM: no Reply-To is set (the
  // shared `sendSystemEmailWithMetadata` does not support one, and teaching a helper used by fifteen jobs
  // a new header is a wider change than this earns), so replies land on RESEND_FROM_ADDRESS, which nobody
  // watches. Carrying the PM's own address and phone in the signature instead is a fair trade; printing a
  // false instruction to a paying customer is not.
  const footerNote = weeklyReportSignatureLines(parts.sender).length > 1
    ? "Sent by T Rock Construction. This mailbox is not monitored — please use your project manager's contact details above."
    : "Sent by T Rock Construction. This mailbox is not monitored.";

  const linkBlock = shareUrl
    ? `
          <tr>
            <td align="center" style="padding:6px 24px 22px 24px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeShareUrl}" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="9%" stroke="f" fillcolor="#CC0000">
                <w:anchorlock/>
                <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">View Weekly Report</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-- -->
              <a href="${safeShareUrl}" style="display:inline-block;background-color:#CC0000;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:44px;text-align:center;text-decoration:none;width:260px;border-radius:4px;">View Weekly Report</a>
              <!--<![endif]-->
              <p style="margin:10px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;word-break:break-all;">${safeShareUrl}</p>
            </td>
          </tr>`
    : "";

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${escapeHtml(parts.subject)}</title>
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
            <td align="center" style="padding:24px 24px 12px 24px;background-color:#ffffff;">
              <img src="${TROCK_LOGO_EMAIL_URL}" alt="T Rock Construction" width="180" height="202" style="display:block;width:180px;height:202px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />
            </td>
          </tr>${htmlParagraphs}${linkBlock}
          <tr>
            <td style="padding:16px 24px;border-top:1px solid #e2e8f0;background-color:#fafafa;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;">${escapeHtml(
                footerNote,
              )}</p>
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject: parts.subject, html, text };
}

/**
 * Record the outcome of an attempt.
 *
 * A FAILED attempt is conditioned on the report still being active and undelivered: without that guard, a
 * stamp from a slow attempt could land on a report that a correction or a concurrent success had already
 * moved on, reporting a failure for a delivery that succeeded. A PROVIDER ACCEPTANCE is deliberately
 * different. Once the provider accepted the message, deleting our row cannot undo that external fact; if
 * removal commits while the worker awaits the provider, the acceptance still has to be recorded for the
 * audit trail and for a later replacement's correction wording.
 *
 * ON DELIVERY IT ALSO DROPS THE RAW CLIENT LINK. `send_request.shareUrl` is the only place the unhashed
 * 180-day token ever comes to rest: public.weekly_report_tokens stores a SHA-256 hash precisely so that a
 * database read — a support query, a backup, a pg_dump — cannot reconstruct a live link to a client's
 * report, and a jsonb column keeping the URL forever handed that property straight back for every report
 * the office has ever sent. It is needed only until the message goes out; a retry is refused once
 * delivery is stamped, so nothing downstream reads it again.
 */
async function recordAttempt(
  query: typeof pool.query,
  tenantSchema: string,
  reportId: string,
  outcome: { delivered: boolean; error: string | null },
): Promise<void> {
  await query(
    `UPDATE ${tenantSchema}.weekly_reports
        SET send_attempts = send_attempts + 1,
            send_last_attempt_at = NOW(),
            send_error = $2,
            send_delivered_at = CASE WHEN $3::boolean THEN NOW() ELSE send_delivered_at END,
            send_request = CASE
              WHEN $3::boolean AND send_request IS NOT NULL THEN send_request - 'shareUrl'
              ELSE send_request
            END
      WHERE id = $1::uuid
        AND status = 'sent'
        AND send_delivered_at IS NULL
        AND (is_active OR $3::boolean)`,
    [reportId, outcome.error, outcome.delivered],
  );
}

/** The variable a deployment sets to say, in so many words, that it may email real customers. */
export const WEEKLY_REPORT_CLIENT_EMAIL_ENABLED_ENV = "WEEKLY_REPORT_CLIENT_EMAIL_ENABLED";

/**
 * Refuse to email a real client from any deployment that was not EXPLICITLY authorised to.
 *
 * EVERY OTHER SYSTEM EMAIL IN THIS CODEBASE GOES TO COLLEAGUES. This is the first job whose recipient list
 * comes from a CUSTOMER contact table, so the blast radius of getting this wrong is a paying client's inbox.
 *
 * THIS USED TO KEY ON `NODE_ENV === "production"`, AND WAS THEREFORE INERT ON EVERY DEPLOYED IMAGE.
 * `Dockerfile.worker` hardcodes `ENV NODE_ENV=production` in its RUNTIME stage, so the value is baked into
 * the ARTIFACT rather than supplied by the deployment: it reads `production` for the production worker, for
 * a staging worker running the identical image against a restored production dump — which is exactly what
 * scripts/staging/ephemeral-staging.sh sets up — and for anyone running `node worker/dist/index.js` from a
 * built checkout. A constant carries no information about WHICH deployment is running, so the check passed
 * unconditionally wherever it mattered. All it ever stopped was the narrow `tsx`-on-a-laptop case, while the
 * docblock it replaced named "a staging OR laptop worker with a copied RESEND_API_KEY" as the threat and
 * rejected "remember to set the override" as a control — which is precisely what staging was left with.
 *
 * Nothing else in this repo tells the tiers apart either: there is no APP_ENV, and the RAILWAY_* variables
 * the codebase does read (server/src/modules/synchub/portfolio-projects-sync.ts) name a project and a
 * service, not an environment. So the guard is an explicit FAIL-CLOSED opt-in instead: a deployment that
 * may email clients says so. Unset, blank, misspelled or copied-from-a-template-and-left-empty all refuse,
 * which is the direction this should fail in — the cost of a false refusal is a delayed report with a
 * `send_error` naming the variable to set, and the cost of a false permit is a real client's inbox.
 *
 * WHAT THIS STILL DOES NOT DEFEND AGAINST: a wholesale clone of the production worker's variables into
 * another deployment brings the flag along with the API key. No single env var survives that, and this one
 * is not pretending to — it must be set per service, never cloned, the same discipline RESEND_API_KEY
 * already requires. What it does buy is that a deployment which does NOT deliberately set it cannot email a
 * client no matter how it was built or started.
 *
 * `EMAIL_OVERRIDE_RECIPIENT` still stands the guard aside, because it redirects every recipient to one
 * internal mailbox before the provider is called (see sendSystemEmailWithMetadata): there is no client left
 * to protect. Throwing rather than skipping keeps the refusal visible — it is recorded as `send_error` and
 * the dashboard raises the chip, rather than the send evaporating.
 */
/**
 * Thrown by the deployment guard, and TAGGED so the recorder can tell it apart.
 *
 * It is the one failure on this path that is provably a non-send: it fires BEFORE the provider is
 * called, so no message exists anywhere. Every other throw in that try block either carries its own
 * outcome prefix already or is genuinely ambiguous.
 */
class WeeklyReportSendRefusedBeforeSending extends Error {}

function assertMayEmailRealClients(recipients: string[]): void {
  if (process.env.EMAIL_OVERRIDE_RECIPIENT?.trim()) return;
  if (process.env[WEEKLY_REPORT_CLIENT_EMAIL_ENABLED_ENV]?.trim().toLowerCase() === "true") return;
  throw new WeeklyReportSendRefusedBeforeSending(
    `Refusing to email ${recipients.length} client address(es): this deployment is not authorised to ` +
      `email real clients (set ${WEEKLY_REPORT_CLIENT_EMAIL_ENABLED_ENV}=true on the production worker, ` +
      "or set EMAIL_OVERRIDE_RECIPIENT to redirect the mail to an internal mailbox)",
  );
}

/**
 * The one line a PM reads under the "Send failed" chip.
 *
 * `send_error` is the ONLY diagnostic this feature ships — client/src/pages/projects/weekly-reports-page.tsx
 * renders it as that chip's tooltip — and it used to be a single 43-character constant, because the handler
 * read `result.success` and threw `result.outcome` away. EVERY reachable production failure wrote the same
 * text: a validation error on a typo'd client domain, a rate limit, a payload over the provider's cap, a
 * 5xx, a socket hang-up, and RESEND_API_KEY unset. Three different fixes — correct the address, wait, set an
 * env var — behind one indistinguishable string, with no way for a director to tell which they had.
 *
 * IT LEADS WITH THE OUTCOME, and that prefix is load-bearing rather than decorative. `rejected` means the
 * provider refused the request and created nothing, so THIS ATTEMPT is provably undelivered; `unknown`
 * means we never learned, so it may have gone out.
 *
 * WHAT THAT PREFIX IS FOR, AND WHAT IT IS NOT. An earlier revision of this docblock proposed keying the
 * retry's duplicate-risk gate on it, and that was tried and reverted: a `rejected:` here describes only the
 * LATEST attempt. This column is overwritten per attempt and `retryWeeklyReportSend` clears it while
 * keeping `send_attempts`, so an earlier `unknown:` that may have delivered can sit behind a later
 * `rejected:` — and the worst case, the provider accepting while the delivery-stamp write dies, records
 * nothing here at all. The gate is AGE ALONE and stays that way.
 *
 * The prefix drives the WORDING instead (`weeklyReportRetryDuplicateRiskPrompt`): a PM is told this attempt
 * sent nothing, without being told the client received nothing.
 */
export function weeklyReportSendFailureMessage(result: SendSystemEmailResult): string {
  // Anything not positively `rejected` is treated as ambiguous — the same conservative default
  // classifySendFailure applies, and it also covers a stub or an older build that omits the field.
  //
  // The two words come from `shared` rather than being spelled here, because the retry dialog PARSES
  // this prefix back out (`weeklyReportSendErrorIsProvableRejection`) to decide what it tells the PM.
  // Written as literals at both ends, renaming one would silently reclassify every provable rejection as
  // ambiguous — which fails safe, and would therefore never be noticed.
  const outcome =
    result.outcome === WEEKLY_REPORT_SEND_OUTCOME_REJECTED
      ? WEEKLY_REPORT_SEND_OUTCOME_REJECTED
      : WEEKLY_REPORT_SEND_OUTCOME_UNKNOWN;
  const detail = normalizeText(result.reason);
  const summary =
    outcome === WEEKLY_REPORT_SEND_OUTCOME_REJECTED
      ? "the email provider refused the message and sent nothing"
      : "the email provider never confirmed the message, so it may or may not have gone out";
  return detail ? `${outcome}: ${summary} — ${detail}` : `${outcome}: ${summary}`;
}

/**
 * Re-read the facts that make this send legitimate, immediately before handing it to the provider.
 *
 * The checks at the top of the handler are a CHECK-THEN-ACT straddling the longest thing this job does:
 * resolving the PDF downloads and transcodes every photo in the report and uploads the result to R2 —
 * seconds of network and CPU during which nothing re-reads the row. A PM issuing a correction inside that
 * window stamps `superseded_by_id` on THIS report and queues v2 (send-service.ts), and this job then sends
 * anyway. The client receives BOTH, and neither message admits the other exists: v1 carries a frozen
 * `isCorrection: false`, and v2's own `isCorrection` was computed from `send_delivered_at IS NOT NULL` on
 * v1 — still NULL at the moment v2 was committed — so v2 says it is not a correction either. Two "here is
 * this week's report" emails, two links, one of which renders a superseded banner.
 *
 * `recordAttempt`'s WHERE cannot be pressed into service as the gate instead. It deliberately omits
 * `superseded_by_id` so that a delivery which DID reach the client is still stamped when a correction lands
 * mid-flight; adding it there would drop that stamp, leaving the row looking undelivered and raising a
 * stall chip for an email the client already has. The guard has to be its own read.
 *
 * This NARROWS the window from the whole render to the microseconds between this read and the provider
 * call. It does not close it: closing it needs supersession to be an atomic claim, which is the API's half.
 */
async function reasonToAbandonSend(
  query: typeof pool.query,
  tenantSchema: string,
  reportId: string,
  deliveryKey: string,
): Promise<string | null> {
  const current = await query(
    `SELECT status, send_delivered_at, send_delivery_key, superseded_by_id
       FROM ${tenantSchema}.weekly_reports
      WHERE id = $1::uuid AND is_active
      LIMIT 1`,
    [reportId],
  );
  const row = current.rows[0];
  if (!row) return "the report disappeared while its PDF was being prepared";
  if (row.superseded_by_id) return "a newer version was sent while this one's PDF was being prepared";
  if (row.send_delivered_at) return "another attempt delivered this report while its PDF was being prepared";
  if (row.status !== "sent") return `the report left \`sent\` (now \`${row.status}\`) before this send ran`;
  if (normalizeText(row.send_delivery_key) !== deliveryKey) {
    return "a newer send request replaced this one while its PDF was being prepared";
  }
  return null;
}

/**
 * Deliver a weekly report to its client.
 *
 * THROWS on a delivery failure, so the queue retries and then dead-letters — and the row carries
 * `send_error` either way, which is what the CRM chip reads. A handler that swallowed the error would
 * leave the queue believing the work succeeded while the client had nothing.
 */
export async function handleWeeklyReportSend(
  payload: WeeklyReportSendPayload,
  _officeId: string | null,
  deps: HandlerDeps = {},
): Promise<void> {
  const logger = deps.logger ?? console;
  const tenantSchema = payload.tenantSchema;
  const reportId = normalizeText(payload.reportId);
  const officeSlug = normalizeText(payload.officeSlug);
  const deliveryKey = normalizeText(payload.deliveryKey);
  if (!isSafeTenantSchema(tenantSchema) || !reportId || !officeSlug || !deliveryKey) {
    // A malformed payload is not retryable — nothing about waiting makes it well-formed. Logged and
    // dropped rather than thrown, so it does not burn three attempts before dead-lettering.
    logger.warn("[WeeklyReportSend] Invalid job payload - skipping", { tenantSchema, reportId, officeSlug });
    return;
  }
  // `officeSlug` and `tenantSchema` arrive as INDEPENDENT fields and address two different things: the row
  // is read out of `tenantSchema` while the PDF is rendered for `officeSlug`. Nothing but this line stops
  // them naming different offices, and the consequence of divergence is another office's report attached
  // to this client's email. The enqueue writes both from one value, so they can only ever disagree through
  // a bug or a hand-edited row — which is exactly when a shape-only payload check is not enough.
  if (tenantSchema !== `office_${officeSlug}`) {
    logger.warn("[WeeklyReportSend] Payload office does not match its tenant schema - skipping", {
      tenantSchema,
      officeSlug,
      reportId,
    });
    return;
  }

  const query = deps.query ?? pool.query.bind(pool);
  const existing = await query(
    `SELECT status, week_of, version, send_request, send_delivery_key, send_delivered_at, send_attempts,
            superseded_by_id,
            snapshot ->> 'propertyDisplayName' AS property_display_name
       FROM ${tenantSchema}.weekly_reports
      WHERE id = $1::uuid AND is_active
      LIMIT 1`,
    [reportId],
  );
  const row = existing.rows[0];
  if (!row) {
    logger.warn("[WeeklyReportSend] Report not found - skipping", { tenantSchema, reportId });
    return;
  }
  if (row.send_delivered_at) {
    logger.log("[WeeklyReportSend] Already delivered - skipping duplicate job", { reportId });
    return;
  }
  if (row.status !== "sent") {
    // Unreachable through the API — `sent` is terminal — but a job whose report is not in that state has
    // no send to perform, and inventing one would email a client a report no PM released.
    logger.warn("[WeeklyReportSend] Report is not in `sent` - skipping", { reportId, status: row.status });
    return;
  }
  if (row.superseded_by_id) {
    // A VERSION THE CLIENT HAS ALREADY BEEN TOLD IS REPLACED MUST NOT BE DELIVERED.
    //
    // `superseded_by_id` is stamped when a LATER version is actually sent, so this row's content is not
    // what the client is owed — and the message it would send carries `isCorrection: false`, so nothing
    // in it would explain why an older report arrived after the newer one. It also links to a page that
    // renders the "a newer version was issued" notice, which is a worse first impression than no email.
    //
    // Checked here as well as in the API's retry route because this job is enqueued from more than one
    // place and can outlive the state it was queued for: a delivery queued for v1 that is still sitting
    // in job_queue when the PM sends v2 arrives here perfectly well-formed — the delivery key still
    // matches, the status is still `sent`, nothing has been delivered. Only this predicate stops it.
    //
    // Skipped rather than thrown: no amount of retrying makes a superseded report the right thing to
    // send, so burning three attempts and a dead-letter would only be noise.
    logger.warn("[WeeklyReportSend] Report has been superseded by a newer version - skipping", {
      reportId,
      supersededById: row.superseded_by_id,
    });
    return;
  }
  if (normalizeText(row.send_delivery_key) !== deliveryKey) {
    // A leftover job from a superseded send request. Running it would deliver a message the row no longer
    // describes — the wrong recipients, or a link that has since been replaced.
    logger.warn("[WeeklyReportSend] Delivery key no longer matches the report - skipping stale job", {
      reportId,
      deliveryKey,
    });
    return;
  }

  const request = (row.send_request ?? null) as StoredSendRequest | null;
  if (!request || typeof request !== "object") {
    const error = new Error("Weekly report has no stored send request");
    await recordAttempt(query, tenantSchema, reportId, { delivered: false, error: error.message });
    logger.error("[WeeklyReportSend] No send_request on the report", { reportId });
    throw error;
  }

  // Re-validated here, not trusted. The row was written by the API, but a job can outlive a release and
  // an empty recipient list must fail loudly rather than be handed to the provider.
  const recipients = normalizeWeeklyReportRecipients(
    Array.isArray(request.recipients) ? request.recipients : [],
  );
  if (recipients.length === 0) {
    const error = new Error("Weekly report send request has no valid recipients");
    await recordAttempt(query, tenantSchema, reportId, { delivered: false, error: error.message });
    logger.error("[WeeklyReportSend] No recipients on the stored send request", { reportId });
    throw error;
  }

  const subject = normalizeText(request.subject) ?? "Weekly Progress Report";
  const sender = senderFrom(request.sender);
  const parts: WeeklyReportEmailParts & { subject: string } = {
    subject,
    greetingName: normalizeText(request.greetingName),
    contextParagraph: normalizeText(request.contextParagraph) ?? "",
    shareUrl: normalizeText(request.shareUrl),
    sender,
    isCorrection: request.isCorrection === true,
  };

  let attachments: SendSystemEmailAttachment[] | undefined;
  if (request.attachPdf !== false) {
    const resolvePdfKey = deps.resolvePdfKey ?? resolveWeeklyReportPdfKeyViaServer;
    const getPdf = deps.getPdf ?? getObjectBuffer;
    try {
      const r2Key = await resolvePdfKey(officeSlug, reportId);
      const buffer = r2Key ? await getPdf(r2Key) : null;
      if (!buffer) {
        // Degraded, not failed. The link in the body is the primary artifact and the CRM can always
        // regenerate the PDF; refusing to send would cost the client their report over an attachment.
        logger.warn("[WeeklyReportSend] PDF unavailable - sending without the attachment", { reportId, r2Key });
      } else if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
        logger.warn("[WeeklyReportSend] PDF exceeds the safe attachment size - sending without it", {
          reportId,
          bytes: buffer.byteLength,
          limit: MAX_ATTACHMENT_BYTES,
        });
      } else {
        attachments = [
          {
            // From the SNAPSHOT, which `sent` guarantees is present, rather than parsed back out of a
            // subject line the PM may have retyped entirely.
            filename: weeklyReportAttachmentFilename({
              propertyName: normalizeText(row.property_display_name),
              weekOf: normalizeText(
                row.week_of instanceof Date ? row.week_of.toISOString().slice(0, 10) : row.week_of,
              ),
            }),
            content: buffer,
          },
        ];
      }
    } catch (error) {
      logger.warn("[WeeklyReportSend] PDF render/fetch failed - sending without the attachment", {
        reportId,
        error,
      });
    }
  }

  const email = buildWeeklyReportClientEmail(parts);
  const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;

  // Keyed on the SEND REQUEST, not on the report. A retry of the same request replays this key and the
  // provider refuses to send twice — which is what makes retrying a job whose outcome is unknown safe. A
  // correction is a different report row with its own key and genuinely does go out. NOTE the key only
  // dedupes for 24 hours (see WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS); the API's retry route is
  // what enforces that boundary, because only it knows how old the request is.
  const idempotencyKey = `weekly-report-${tenantSchema}-${reportId}-${deliveryKey}`;

  // LAST LOOK BEFORE THE PROVIDER. Everything above ran before, or across, the PDF render; this re-reads
  // the row so a correction issued during that render cannot be followed by the version it replaced. See
  // reasonToAbandonSend. Skipped rather than thrown, matching the top-of-handler checks: retrying does not
  // make a superseded report the right thing to send, and a "Send failed" chip on a version that must never
  // go out would send a PM chasing a delivery nobody wants.
  const abandon = await reasonToAbandonSend(query, tenantSchema, reportId, deliveryKey);
  if (abandon) {
    logger.warn("[WeeklyReportSend] Abandoning the send after the PDF render - skipping", {
      reportId,
      reason: abandon,
    });
    return;
  }

  // THE SAME KEY, TAGGED ONTO THE MESSAGE, so the provider hands it back on every webhook about it.
  //
  // This is what makes a bounce attributable. `send_delivered_at` records only that the provider accepted
  // the message; whether the client's mail server then took it arrives minutes later on
  // /api/webhooks/resend, with no session and no office context — just this tag. The API resolves it
  // through public.weekly_report_send_deliveries and writes the verdict to the report.
  //
  // Deliberately the DELIVERY KEY and not the report id. A correction is a different report with its own
  // key, and a retry is the same request with the same one, so the tag identifies the MESSAGE rather than
  // the document — which is the only granularity at which "this one bounced" is a true statement.
  const deliveryTags = [{ name: WEEKLY_REPORT_DELIVERY_TAG, value: deliveryKey }];

  // THE SEND ITSELF. Only this call is inside the failure-recording catch. Everything after it has already
  // put the report in the client's inbox, and must never be written down as a send failure.
  let result: SendSystemEmailResult;
  try {
    assertMayEmailRealClients(recipients);
    result = await sendEmail(recipients, email.subject, email.html, {
      text: email.text,
      idempotencyKey,
      tags: deliveryTags,
      // No Reply-To override. `sendSystemEmailWithMetadata` does not support one, and teaching a helper
      // shared by fifteen jobs a new header to route this one email is a wider change than it earns —
      // the PM's own address and phone are in the signature, and the footer no longer claims otherwise.
      attachments,
    });
    // Carries WHAT WE LEARNED, not just that we lost. `sendSystemEmailWithMetadata` never throws for a
    // provider or network failure — resend@6 catches its own fetch and returns an ordinary error result —
    // so this branch, not the catch below, is the one every reachable production failure takes.
    if (!result.success) throw new Error(weeklyReportSendFailureMessage(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A DEPLOYMENT REFUSAL IS A PROVABLE NON-SEND, and it used to be recorded without one, which the
    // retry dialog reads as ambiguous — telling a PM the client may already have the report when the
    // provider was never called at all. On a worker missing WEEKLY_REPORT_CLIENT_EMAIL_ENABLED that is
    // EVERY send, so every retry would carry a warning that is not merely unnecessary but false.
    //
    // Only this error is re-prefixed. The `!result.success` throw above already carries its own outcome,
    // and blanket-wrapping the catch would bury a `rejected:` inside an `unknown:` and silently
    // reclassify every provider refusal. Anything else reaching here is genuinely unknown and keeps the
    // conservative default of no prefix.
    const stored =
      error instanceof WeeklyReportSendRefusedBeforeSending
        ? `${WEEKLY_REPORT_SEND_OUTCOME_REJECTED}: this deployment refused to send before the provider ` +
          `was called, so this attempt sent nothing — ${message}`
        : message;
    // Written BEFORE the rethrow, so the failure is visible on the dashboard whether the queue retries or
    // dead-letters. This is the whole difference from the fire-and-forget scorecard path.
    //
    // The bound is real now rather than theoretical: the message carries the provider's own words, and
    // Resend names EVERY address it refused, so a report addressed to a long distribution list produces a
    // validation error thousands of characters long. It goes into a tooltip. 500 keeps the actionable part
    // — the outcome and the error name lead the string — without an unbounded row behind a hover.
    await recordAttempt(query, tenantSchema, reportId, {
      delivered: false,
      error: stored.slice(0, 500),
    });
    logger.error("[WeeklyReportSend] Failed to deliver weekly report", { reportId, error });
    throw error;
  }

  // DELIVERED. The stamp used to live inside the try above, which meant a database that went away between
  // the provider accepting the message and the row being updated was recorded as "Resend timed out" — a
  // send failure, for a send that succeeded. The catch could not tell the two apart, so the board offered
  // a Retry for an email the client already had, and the failure chip was simply false.
  //
  // A throw here is the right answer: the queue retries, the replay carries the same idempotency key, the
  // provider answers "already delivered", and the stamp is attempted again. What it must NOT do is write
  // an error. If every attempt fails, the row is left `sent` with no delivery and no error — which the
  // dashboard now surfaces on its own after WEEKLY_REPORT_SEND_STALL_MINUTES rather than losing it.
  try {
    await recordAttempt(query, tenantSchema, reportId, { delivered: true, error: null });
  } catch (error) {
    logger.error("[WeeklyReportSend] DELIVERED but the delivery could not be recorded", {
      reportId,
      error,
    });
    throw new Error(
      `Weekly report was delivered but recording the delivery failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  logger.log("[WeeklyReportSend] Delivered weekly report", {
    reportId,
    recipientCount: recipients.length,
    hadPdf: Boolean(attachments),
    messageId: result.messageId,
  });
}
