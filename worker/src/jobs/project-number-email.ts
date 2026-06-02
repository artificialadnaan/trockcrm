import { pool } from "../db.js";
import { sendSystemEmailWithMetadata, type SendSystemEmailResult } from "../lib/system-email.js";

export const PROJECT_NUMBER_FIRST_SET_JOB = "project_number_first_set_email";
export const PROJECT_NUMBER_FIRST_SET_AUDIT_PROCESS = "project_number_first_set";
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

export function resolveFrontendUrl(env: NodeJS.ProcessEnv): string {
  return normalizeText(env.FRONTEND_URL) ?? "https://crm.trockconstruction.com";
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
  const officeParam = input.officeId ? `?officeId=${encodeURIComponent(input.officeId)}` : "";
  const dealUrl = `${input.frontendUrl.replace(/\/+$/, "")}/deals/${encodeURIComponent(input.dealId)}${officeParam}`;
  const awardedAmount = formatCurrency(input.awardedAmount);
  const subject = `New project number assigned: ${input.projectNumber} (${input.dealName})`;
  const rows = [
    ["Deal name", input.dealName],
    ["Project number", input.projectNumber],
    ["Sales rep", input.salesRepName],
    ["Awarded amount", awardedAmount],
    ["CRM deal", dealUrl],
  ] as const;

  const htmlRows = rows
    .map(([label, value]) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:14px;width:160px;">${escapeHtml(label)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:14px;">${
          label === "CRM deal"
            ? `<a href="${escapeHtml(value)}" style="color:#2563eb;text-decoration:underline;">${escapeHtml(value)}</a>`
            : escapeHtml(value)
        }</td>
      </tr>`)
    .join("");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:24px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <tr>
            <td style="background-color:#1e293b;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:bold;">T Rock CRM</td>
          </tr>
          <tr>
            <td style="padding:24px;">
              <h2 style="margin:0 0 12px;color:#1e293b;font-size:18px;">New project number assigned</h2>
              <p style="margin:0 0 16px;color:#475569;font-size:14px;line-height:1.6;">A project number was added to a deal.</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:1px solid #e2e8f0;">${htmlRows}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;">This is an automated notification from T Rock CRM. Do not reply to this email.</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = rows.map(([label, value]) => `${label}: ${value}`).join("\n");
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
