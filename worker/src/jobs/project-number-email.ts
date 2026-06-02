import { pool } from "../db.js";
import { sendSystemEmailWithMetadata, type SendSystemEmailResult } from "../lib/system-email.js";

export const PROJECT_NUMBER_FIRST_SET_JOB = "project_number_first_set_email";
export const PROJECT_NUMBER_FIRST_SET_AUDIT_PROCESS = "project_number_first_set";
export const DEAL_OPPORTUNITY_FIRST_ENTRY_JOB = "deal_opportunity_first_entry_email";
export const DEAL_OPPORTUNITY_FIRST_ENTRY_AUDIT_PROCESS = "deal_opportunity_first_entry";
export const DEFAULT_NON_PROD_CHRISTY_PROJECT_NUMBER_EMAIL = "kscheidegger@trockgc.com";
export const DEFAULT_NON_PROD_PROJECT_NUMBER_EMAIL_CC = "adnaan.iqbal@gmail.com";

interface ProjectNumberFirstSetPayload {
  tenantSchema?: string;
  dealId?: string;
  projectNumber?: string;
  auditLogId?: number;
}

interface ProjectNumberEmailDeal {
  id: string;
  name: string;
  project_number: string | null;
  deal_number: string | null;
  awarded_amount: string | number | null;
  sales_rep_name: string | null;
}

interface ProjectNumberEmailOffice {
  id: string;
}

interface HandlerDeps {
  query?: typeof pool.query;
  sendEmail?: (
    to: string,
    subject: string,
    html: string,
    options: { text: string; idempotencyKey: string; cc?: string }
  ) => Promise<SendSystemEmailResult>;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export async function handleProjectNumberFirstSetEmail(
  payload: ProjectNumberFirstSetPayload,
  _officeId: string | null,
  deps: HandlerDeps = {}
) {
  const logger = deps.logger ?? console;
  const tenantSchema = payload.tenantSchema;
  const dealId = payload.dealId;
  const projectNumber = normalizeText(payload.projectNumber);
  const auditLogId = normalizeAuditLogId(payload.auditLogId);
  if (!isSafeTenantSchema(tenantSchema) || !dealId || !projectNumber || auditLogId == null) {
    logger.warn("[ProjectNumberEmail] Invalid job payload - skipping", { tenantSchema, dealId, projectNumber, auditLogId });
    return;
  }

  const recipient = resolveChristyProjectNumberRecipient(deps.env ?? process.env);
  if (!recipient) {
    const error = new Error("CHRISTY_PROJECT_NUMBER_EMAIL is not configured");
    // error (not warn): a required recipient is missing, so the notification cannot send. Logged
    // loudly and re-thrown so the failure is VISIBLE and the job retries (then dead-letters after the
    // job queue's max_attempts) instead of silently completing as a no-op.
    logger.error(
      "[ProjectNumberEmail] CHRISTY_PROJECT_NUMBER_EMAIL is not set - cannot send the project-number notification. Set it on the worker service; the job retries a few times, then dead-letters.",
      { dealId, projectNumber }
    );
    throw error;
  }
  const ccRecipient = resolveProjectNumberEmailCcRecipient(deps.env ?? process.env);
  if (!ccRecipient) {
    // error (not warn): the CC copy is being dropped. Christy's notification still sends (we do not
    // block the primary recipient on a missing CC), but the drop is surfaced loudly, not silent.
    logger.error(
      "[ProjectNumberEmail] PROJECT_NUMBER_EMAIL_CC is not set - sending to Christy WITHOUT the CC copy. Set it on the worker service to restore the CC.",
      { dealId, projectNumber }
    );
  }

  const query = deps.query ?? pool.query.bind(pool);
  const receiptResult = await query(
    `SELECT resend_message_id, sent_at
       FROM public.project_number_first_set_email_receipts
      WHERE tenant_schema = $1
        AND audit_log_id = $2
      LIMIT 1`,
    [tenantSchema, auditLogId]
  );
  if (receiptResult.rows.length > 0) {
    logger.log("[ProjectNumberEmail] Notification already sent - skipping duplicate job", {
      dealId,
      projectNumber,
      auditLogId,
      messageId: receiptResult.rows[0]?.resend_message_id ?? null,
    });
    return;
  }

  const result = await query(
    `SELECT d.id,
            d.name,
            d.project_number,
            d.deal_number,
            d.awarded_amount,
            COALESCE(
              NULLIF(u.display_name, ''),
              NULLIF(BTRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
              u.email,
              'Unassigned'
            ) AS sales_rep_name
       FROM ${quoteIdent(tenantSchema)}.deals d
       LEFT JOIN public.users u ON u.id = d.assigned_rep_id
      WHERE d.id = $1::uuid
      LIMIT 1`,
    [dealId]
  );
  const deal = result.rows[0] as ProjectNumberEmailDeal | undefined;
  if (!deal) {
    logger.warn("[ProjectNumberEmail] Deal not found - skipping", { tenantSchema, dealId, projectNumber });
    return;
  }
  // The deal's office id (resolved from its tenant schema) is threaded into the deal link so the
  // email loads the correct tenant even for a recipient whose default office differs.
  const officeResult = await query(
    `SELECT id
       FROM public.offices
      WHERE ('office_' || slug) = $1
        AND is_active = true
      LIMIT 1`,
    [tenantSchema]
  );
  const office = officeResult.rows[0] as ProjectNumberEmailOffice | undefined;

  const email = buildProjectNumberFirstSetEmail({
    dealId,
    dealName: deal.name,
    projectNumber,
    salesRepName: deal.sales_rep_name ?? "Unassigned",
    awardedAmount: deal.awarded_amount,
    officeId: office?.id ?? null,
    frontendUrl: resolveFrontendUrl(deps.env ?? process.env),
  });

  try {
    const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;
    const sendResult = await sendEmail(recipient, email.subject, email.html, {
      text: email.text,
      idempotencyKey: `project-number-first-set-${tenantSchema}-${auditLogId}`,
      ...(ccRecipient ? { cc: ccRecipient } : {}),
    });
    if (!sendResult.success) {
      throw new Error("Email provider returned unsuccessful result");
    }
    await query(
      `INSERT INTO public.project_number_first_set_email_receipts (
          audit_log_id,
          tenant_schema,
          deal_id,
          project_number,
          recipient_email,
          resend_message_id,
          sent_at,
          updated_at
        )
        VALUES ($1, $2, $3::uuid, $4, $5, $6, NOW(), NOW())
        ON CONFLICT (tenant_schema, audit_log_id) DO UPDATE
          SET recipient_email = EXCLUDED.recipient_email,
              resend_message_id = EXCLUDED.resend_message_id,
              sent_at = EXCLUDED.sent_at,
              updated_at = NOW()`,
      [auditLogId, tenantSchema, dealId, projectNumber, recipient, sendResult.messageId]
    );
    logger.log("[ProjectNumberEmail] Sent Christy notification", {
      dealId,
      projectNumber,
      messageId: sendResult.messageId,
      auditLogId,
    });
  } catch (error) {
    logger.error("[ProjectNumberEmail] Failed to send Christy notification", {
      dealId,
      projectNumber,
      error,
    });
    throw error;
  }
}

interface DealOpportunityFirstEntryPayload {
  tenantSchema?: string;
  dealId?: string;
  dealNumber?: string;
  auditLogId?: number;
}

interface DealOpportunityEmailDeal {
  id: string;
  name: string;
  deal_number: string | null;
  awarded_amount: string | number | null;
  sales_rep_name: string | null;
}

/**
 * Re-keyed Christy/Adnaan notification: fires on a deal's FIRST entry into the Opportunity stage and
 * carries deal_number (the operative business "project number"). Enqueued by migration 0147's
 * `deals_opportunity_first_entry_email_trg`. Mirrors handleProjectNumberFirstSetEmail but with its own
 * receipts ledger + idempotencyKey, and reads deal_number instead of project_number.
 *
 * Exactly-once: a deal that re-enters Opportunity is re-enqueued by the trigger with the SAME stable
 * audit_log_id (the marker is record_id-alone), so the receipts check below short-circuits the second
 * job — never a duplicate send. The recipient/CC resolution and env-hardening are shared with the
 * project_number handler (CHRISTY_PROJECT_NUMBER_EMAIL / PROJECT_NUMBER_EMAIL_CC).
 */
export async function handleDealOpportunityFirstEntryEmail(
  payload: DealOpportunityFirstEntryPayload,
  _officeId: string | null,
  deps: HandlerDeps = {}
) {
  const logger = deps.logger ?? console;
  const tenantSchema = payload.tenantSchema;
  const dealId = payload.dealId;
  const dealNumber = normalizeText(payload.dealNumber);
  const auditLogId = normalizeAuditLogId(payload.auditLogId);
  if (!isSafeTenantSchema(tenantSchema) || !dealId || !dealNumber || auditLogId == null) {
    logger.warn("[OpportunityEntryEmail] Invalid job payload - skipping", { tenantSchema, dealId, dealNumber, auditLogId });
    return;
  }

  const recipient = resolveChristyProjectNumberRecipient(deps.env ?? process.env);
  if (!recipient) {
    const error = new Error("CHRISTY_PROJECT_NUMBER_EMAIL is not configured");
    // error (not warn): a required recipient is missing, so the notification cannot send. Logged
    // loudly and re-thrown so the failure is VISIBLE and the job retries (then dead-letters after the
    // job queue's max_attempts) instead of silently completing as a no-op.
    logger.error(
      "[OpportunityEntryEmail] CHRISTY_PROJECT_NUMBER_EMAIL is not set - cannot send the project-number notification. Set it on the worker service; the job retries a few times, then dead-letters.",
      { dealId, dealNumber }
    );
    throw error;
  }
  const ccRecipient = resolveProjectNumberEmailCcRecipient(deps.env ?? process.env);
  if (!ccRecipient) {
    // error (not warn): the CC copy is being dropped. Christy's notification still sends (we do not
    // block the primary recipient on a missing CC), but the drop is surfaced loudly, not silent.
    logger.error(
      "[OpportunityEntryEmail] PROJECT_NUMBER_EMAIL_CC is not set - sending to Christy WITHOUT the CC copy. Set it on the worker service to restore the CC.",
      { dealId, dealNumber }
    );
  }

  const query = deps.query ?? pool.query.bind(pool);
  const receiptResult = await query(
    `SELECT resend_message_id, sent_at
       FROM public.deal_opportunity_first_entry_email_receipts
      WHERE tenant_schema = $1
        AND audit_log_id = $2
      LIMIT 1`,
    [tenantSchema, auditLogId]
  );
  if (receiptResult.rows.length > 0) {
    logger.log("[OpportunityEntryEmail] Notification already sent - skipping duplicate job", {
      dealId,
      dealNumber,
      auditLogId,
      messageId: receiptResult.rows[0]?.resend_message_id ?? null,
    });
    return;
  }

  const result = await query(
    `SELECT d.id,
            d.name,
            d.deal_number,
            d.awarded_amount,
            COALESCE(
              NULLIF(u.display_name, ''),
              NULLIF(BTRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
              u.email,
              'Unassigned'
            ) AS sales_rep_name
       FROM ${quoteIdent(tenantSchema)}.deals d
       LEFT JOIN public.users u ON u.id = d.assigned_rep_id
      WHERE d.id = $1::uuid
      LIMIT 1`,
    [dealId]
  );
  const deal = result.rows[0] as DealOpportunityEmailDeal | undefined;
  if (!deal) {
    logger.warn("[OpportunityEntryEmail] Deal not found - skipping", { tenantSchema, dealId, dealNumber });
    return;
  }
  const officeResult = await query(
    `SELECT id
       FROM public.offices
      WHERE ('office_' || slug) = $1
        AND is_active = true
      LIMIT 1`,
    [tenantSchema]
  );
  const office = officeResult.rows[0] as ProjectNumberEmailOffice | undefined;

  // The business "project number" IS the deal_number, so the existing email template is reused with
  // deal_number as the displayed number.
  const email = buildProjectNumberFirstSetEmail({
    dealId,
    dealName: deal.name,
    projectNumber: dealNumber,
    salesRepName: deal.sales_rep_name ?? "Unassigned",
    awardedAmount: deal.awarded_amount,
    officeId: office?.id ?? null,
    frontendUrl: resolveFrontendUrl(deps.env ?? process.env),
  });

  try {
    const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;
    const sendResult = await sendEmail(recipient, email.subject, email.html, {
      text: email.text,
      idempotencyKey: `deal-opportunity-first-entry-${tenantSchema}-${auditLogId}`,
      ...(ccRecipient ? { cc: ccRecipient } : {}),
    });
    if (!sendResult.success) {
      throw new Error("Email provider returned unsuccessful result");
    }
    await query(
      `INSERT INTO public.deal_opportunity_first_entry_email_receipts (
          audit_log_id,
          tenant_schema,
          deal_id,
          deal_number,
          recipient_email,
          resend_message_id,
          sent_at,
          updated_at
        )
        VALUES ($1, $2, $3::uuid, $4, $5, $6, NOW(), NOW())
        ON CONFLICT (tenant_schema, audit_log_id) DO UPDATE
          SET recipient_email = EXCLUDED.recipient_email,
              resend_message_id = EXCLUDED.resend_message_id,
              sent_at = EXCLUDED.sent_at,
              updated_at = NOW()`,
      [auditLogId, tenantSchema, dealId, dealNumber, recipient, sendResult.messageId]
    );
    logger.log("[OpportunityEntryEmail] Sent Christy notification", {
      dealId,
      dealNumber,
      messageId: sendResult.messageId,
      auditLogId,
    });
  } catch (error) {
    logger.error("[OpportunityEntryEmail] Failed to send Christy notification", {
      dealId,
      dealNumber,
      error,
    });
    throw error;
  }
}

/**
 * Whether a hardcoded non-prod default recipient is acceptable. This is an ALLOWLIST of explicitly
 * non-production environments — deliberately NOT `NODE_ENV !== "production"`. A misconfigured prod
 * worker (NODE_ENV unset, or a non-canonical value like "prod"/"staging") must fail loudly rather
 * than silently emailing a hardcoded dev address, so anything outside {development, test} is treated
 * as "the env var must be configured".
 */
const DEV_FALLBACK_NODE_ENVS = new Set(["development", "test"]);

export function isDevFallbackRecipientContext(env: NodeJS.ProcessEnv): boolean {
  return typeof env.NODE_ENV === "string" && DEV_FALLBACK_NODE_ENVS.has(env.NODE_ENV);
}

export function resolveChristyProjectNumberRecipient(env: NodeJS.ProcessEnv): string | null {
  const configured = normalizeText(env.CHRISTY_PROJECT_NUMBER_EMAIL);
  if (configured) return configured;
  return isDevFallbackRecipientContext(env) ? DEFAULT_NON_PROD_CHRISTY_PROJECT_NUMBER_EMAIL : null;
}

export function resolveProjectNumberEmailCcRecipient(env: NodeJS.ProcessEnv): string | null {
  const configured = normalizeText(env.PROJECT_NUMBER_EMAIL_CC);
  if (configured) return configured;
  return isDevFallbackRecipientContext(env) ? DEFAULT_NON_PROD_PROJECT_NUMBER_EMAIL_CC : null;
}

// Production CRM frontend. trockcrm.com is the public custom domain on the Frontend service
// (the railway-generated crm.trockconstruction.com is NOT the address operators use). FRONTEND_URL
// overrides this when set; the worker leaves it unset, so this default is what every link renders.
export const DEFAULT_FRONTEND_URL = "https://trockcrm.com";

// Hosted in client/public/ → served by the Frontend service at the domain root (e.g. serve dist -s,
// same as /logo.png and /favicon.png). White-background PNG so it renders predictably on Outlook chrome.
export const TROCK_LOGO_EMAIL_URL = "https://trockcrm.com/trock-logo-email.png";

export function resolveFrontendUrl(env: NodeJS.ProcessEnv): string {
  return normalizeText(env.FRONTEND_URL) ?? DEFAULT_FRONTEND_URL;
}

export function buildProjectNumberFirstSetEmail(input: {
  dealId: string;
  dealName: string;
  projectNumber: string;
  salesRepName: string;
  awardedAmount: string | number | null;
  officeId?: string | null;
  frontendUrl: string;
}) {
  // Deal URL: /deals/{id}?officeId={deal's office}. The officeId carries the deal's tenant so the link
  // loads the correct office even for a recipient whose default office differs (the detail page threads
  // it into the x-office-id header). Without it, /deals/{id} queries the recipient's default office and
  // would 404 a cross-office deal (Codex P1 on #611).
  const officeParam = input.officeId ? `?officeId=${encodeURIComponent(input.officeId)}` : "";
  const dealUrl = `${input.frontendUrl.replace(/\/+$/, "")}/deals/${encodeURIComponent(input.dealId)}${officeParam}`;
  const awardedAmount = formatCurrency(input.awardedAmount);
  const subject = `New project number assigned: ${input.projectNumber} (${input.dealName})`;

  // Data fields (the CRM-deal link is the prominent button below, not a raw-URL row).
  const rows = [
    ["Deal name", input.dealName, false],
    ["Project number", input.projectNumber, true],
    ["Sales rep", input.salesRepName, false],
    ["Awarded amount", awardedAmount, false],
  ] as const;

  const htmlRows = rows
    .map(([label, value, emphasize]) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;vertical-align:top;width:150px;">${escapeHtml(label)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:${emphasize ? "16px" : "14px"};line-height:20px;font-weight:${emphasize ? "bold" : "normal"};vertical-align:top;">${escapeHtml(value)}</td>
        </tr>`)
    .join("");

  const safeDealUrl = escapeHtml(dealUrl);

  // Outlook (Windows) renders via the Word engine: table-only layout, fully inline CSS, no flexbox/
  // grid, no SVG, no web fonts, no CSS background-images for critical content. The logo is a hosted
  // PNG <img> with HTML width/height attributes; the CTA is a VML "bulletproof button" for Outlook
  // with an <a> fallback for every other client.
  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>New Project Number Assigned</title>
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
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">New Project Number Assigned</h1>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:6px 24px 16px 24px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;">A project number was assigned to a deal in the CRM.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid #e2e8f0;">${htmlRows}
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 24px 28px 24px;">
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
    rows.map(([label, value]) => `${label}: ${value}`).join("\n") +
    `\n\nView deal in the CRM: ${dealUrl}`;
  return { subject, html, text, dealUrl };
}

export function formatCurrency(value: string | number | null): string {
  if (value == null || value === "") return "Not set";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "Not set";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(numeric);
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAuditLogId(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function isSafeTenantSchema(value: unknown): value is string {
  return typeof value === "string" && /^office_[a-z0-9_]+$/.test(value);
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
