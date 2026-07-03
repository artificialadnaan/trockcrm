import { pool } from "../db.js";
import { sendSystemEmailWithMetadata, type SendSystemEmailResult } from "../lib/system-email.js";
// Reuse #611's frontend-URL + branded-template primitives (trockcrm.com base + hosted logo), same as the
// RFP-decline email, so this SLA email matches the look and links to the right host.
import { resolveFrontendUrl, TROCK_LOGO_EMAIL_URL } from "./project-number-email.js";
// Leadership recipients (Takashi + Adam Shaw) — the SAME source of truth the RFP-decline email and the
// server override-review gate use (RFP_REJECTION_EMAIL_RECIPIENTS), so the notified set never drifts.
import { resolveRfpReviewerEmails } from "@trock-crm/shared/lib/rfpReviewerEmails";
// Mirror the Pending RFP queue EXACTLY: awaiting-only statuses + every stage id that canonicalizes to
// Opportunity (incl. legacy `dd`). Keeps the SLA scan and the /deals/pending-rfp bucket in lockstep.
import { PENDING_RFP_AWAITING_STATUSES, toCanonicalDealStageSlug } from "@trock-crm/shared/types";
import { escapeHtml } from "../lib/email-format.js";

/** The Pending RFP SLA: an RFP awaiting approval longer than this many hours is a breach. */
export const RFP_PENDING_SLA_HOURS = 24;

const OFFICE_SLUG_REGEX = /^[a-z][a-z0-9_]*$/;
const TENANT_SCHEMA_REGEX = /^office_[a-z][a-z0-9_]*$/;

// A minimal query shape so the job is injectable in tests (pool.query, a PGlite query, or a mock all fit).
type PgQuery = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

type SendEmail = (
  to: string | string[],
  subject: string,
  html: string,
  options: { text: string; idempotencyKey: string },
) => Promise<SendSystemEmailResult>;

interface RunDeps {
  query?: PgQuery;
  sendEmail?: SendEmail;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn" | "error">;
  slaHours?: number;
  /** Single-flight guard: resolves to a release fn if this run acquired the lock, or null if another run
   * holds it (this run should then skip). Default = a Postgres session advisory lock over the pool. */
  acquireLock?: () => Promise<null | (() => Promise<void>)>;
}

export interface RfpPendingSlaBreach {
  dealId: string;
  dealName: string;
  dealNumber: string | null;
  /** ISO-8601 instant the RFP entered pending (deals.rfp_approval_requested_at) — the SLA clock + cycle key. */
  requestedAt: string;
  hoursPending: number;
}

export interface RfpPendingSlaScanSummary {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
}

/** Gate the scan behind an explicit flag (default OFF) so it merges inert and leadership opts in deliberately. */
export function isRfpPendingSlaEnabled(env: NodeJS.ProcessEnv): boolean {
  return String(env.RFP_PENDING_SLA_ENABLED ?? "").trim().toLowerCase() === "true";
}

/** Every stage id whose slug canonicalizes to Opportunity (incl. legacy aliases like `dd`) — exactly the set
 * the Pending RFP queue (pending-rfp-service.ts) and the trigger route treat as Opportunity. */
async function opportunityStageIds(query: PgQuery): Promise<string[]> {
  const result = await query(`SELECT id, slug FROM public.pipeline_stage_config`);
  return result.rows
    .filter(
      (s) =>
        s.slug != null &&
        (toCanonicalDealStageSlug(String(s.slug), "normal") === "opportunity" ||
          toCanonicalDealStageSlug(String(s.slug), "service") === "opportunity"),
    )
    .map((s) => String(s.id));
}

/**
 * Deals whose RFP has been awaiting approval (pending_outbox/pending) longer than `slaHours`, in one office
 * schema. Mirrors the Pending RFP bucket EXACTLY (pending-rfp-service.ts): every Opportunity-canonical stage
 * (incl. legacy `dd`), not bid-board-owned, awaiting status, excludes re-confirmed denials
 * (rfp_override_decision='denial_reconfirmed') and in-flight override approvals (rfp_override_state='approving')
 * so a row hidden from the queue never alerts. Adds the 24h clock off rfp_approval_requested_at (indexed) and
 * drops on-hold + test-data. Oldest first.
 */
export async function findPendingRfpSlaBreaches(
  query: PgQuery,
  schemaName: string,
  slaHours: number,
  oppStageIds?: string[],
): Promise<RfpPendingSlaBreach[]> {
  if (!TENANT_SCHEMA_REGEX.test(schemaName)) {
    throw new Error(`Unsafe tenant schema: ${schemaName}`);
  }
  // opportunityStageIds reads office-invariant public.pipeline_stage_config, so the caller resolves it ONCE
  // per scan and passes it in (avoids one full-table read per office). Direct callers (tests) may omit it and
  // we resolve internally. Either way the empty-set fast path stands.
  const stageIds = oppStageIds ?? (await opportunityStageIds(query));
  if (stageIds.length === 0) return [];
  const result = await query(
    `SELECT d.id,
            d.name,
            COALESCE(d.project_number, d.deal_number) AS deal_number,
            d.rfp_approval_requested_at,
            EXTRACT(EPOCH FROM (NOW() - d.rfp_approval_requested_at)) / 3600.0 AS hours_pending
       FROM ${schemaName}.deals d
      WHERE d.stage_id = ANY($1::uuid[])
        AND d.is_bid_board_owned = false
        AND d.rfp_approval_status = ANY($2::text[])
        AND d.rfp_approval_requested_at IS NOT NULL
        AND d.rfp_approval_requested_at < NOW() - ($3 || ' hours')::interval
        AND d.is_active = true
        AND COALESCE(d.is_test_data, false) = false
        AND COALESCE(d.on_hold, false) = false
        AND COALESCE(d.rfp_override_decision, '') <> 'denial_reconfirmed'
        AND COALESCE(d.rfp_override_state, '') <> 'approving'
      ORDER BY d.rfp_approval_requested_at ASC`,
    [stageIds, [...PENDING_RFP_AWAITING_STATUSES], String(slaHours)],
  );
  return result.rows.map((row) => ({
    dealId: String(row.id),
    dealName: typeof row.name === "string" && row.name.trim() ? row.name : "Deal",
    dealNumber: row.deal_number ?? null,
    requestedAt: new Date(row.rfp_approval_requested_at).toISOString(),
    hoursPending: Number(row.hours_pending),
  }));
}

/**
 * Scan every active office for RFPs breaching the 24h pending SLA and email leadership once per pending
 * cycle. Exactly-once + retry-safe:
 *  - a single-flight Postgres advisory lock serializes runs (a still-running or second-instance run skips),
 *    so two runs can't both submit the same alert;
 *  - the receipt row (keyed tenant_schema, deal_id, rfp_approval_requested_at) is written only AFTER a
 *    durable send, so a crash before the send leaves no receipt and the next scan retries;
 *  - the email payload is stable per cycle, so a crash-then-retry reuses the same Resend idempotencyKey.
 * A re-triggered RFP gets a fresh rfp_approval_requested_at -> a new cycle -> a new alert.
 */
export async function runRfpPendingSlaScan(deps: RunDeps = {}): Promise<RfpPendingSlaScanSummary> {
  const env = deps.env ?? process.env;
  const logger = deps.logger ?? console;
  const slaHours = deps.slaHours ?? RFP_PENDING_SLA_HOURS;
  const summary: RfpPendingSlaScanSummary = { scanned: 0, sent: 0, skipped: 0, failed: 0 };

  if (!isRfpPendingSlaEnabled(env)) {
    logger.log("[RfpPendingSla] Disabled (RFP_PENDING_SLA_ENABLED != 'true') - skipping scan");
    return summary;
  }
  const recipients = resolveRfpReviewerEmails(env);
  if (recipients.length === 0) {
    logger.error(
      "[RfpPendingSla] No leadership recipients configured (RFP_REJECTION_EMAIL_RECIPIENTS) - cannot send; skipping",
    );
    return summary;
  }

  const query = deps.query ?? (pool.query.bind(pool) as PgQuery);
  const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;
  const frontendUrl = resolveFrontendUrl(env);

  // Single-flight: if another scan holds the lock, skip this tick rather than double-submit alerts.
  const acquireLock = deps.acquireLock ?? acquireScanAdvisoryLock;
  const releaseLock = await acquireLock();
  if (!releaseLock) {
    logger.log("[RfpPendingSla] Another scan is already running - skipping this tick");
    return summary;
  }

  try {
    // Resolve the Opportunity-canonical stage ids ONCE (they live in office-invariant
    // public.pipeline_stage_config), then reuse them for every office instead of re-reading per office.
    const oppStageIds = await opportunityStageIds(query);
    if (oppStageIds.length === 0) {
      logger.warn("[RfpPendingSla] No Opportunity-canonical stage ids resolved - no breaches possible this scan");
    }
    const offices = await query(`SELECT id, slug FROM public.offices WHERE is_active = true`);
    for (const office of offices.rows) {
      if (!OFFICE_SLUG_REGEX.test(String(office.slug ?? ""))) {
        logger.error(`[RfpPendingSla] Invalid office slug "${office.slug}" - skipping`);
        continue;
      }
      const tenantSchema = `office_${office.slug}`;
      let breaches: RfpPendingSlaBreach[];
      try {
        breaches = await findPendingRfpSlaBreaches(query, tenantSchema, slaHours, oppStageIds);
      } catch (err) {
        logger.error("[RfpPendingSla] Breach scan failed for office - skipping", { tenantSchema, err });
        continue;
      }
      summary.scanned += breaches.length;
      for (const breach of breaches) {
        const outcome = await processBreach(query, sendEmail, logger, {
          tenantSchema,
          officeId: (office.id as string | null) ?? null,
          breach,
          recipients,
          frontendUrl,
          slaHours,
        });
        summary[outcome] += 1;
      }
    }
  } finally {
    await releaseLock().catch(() => undefined);
  }
  logger.log("[RfpPendingSla] Scan complete", summary);
  return summary;
}

// Postgres session advisory lock over a dedicated pooled client (a session lock must be acquired + released
// on the SAME connection, so it can't go through pool.query which hands out arbitrary connections). Global
// across worker instances, so a second instance's tick skips too. Returns null if the lock is already held.
async function acquireScanAdvisoryLock(): Promise<null | (() => Promise<void>)> {
  const LOCK_KEY = 0x52_46_50_53; // "RFPS" — stable, arbitrary
  const client = await pool.connect();
  try {
    const res = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [LOCK_KEY]);
    if (res.rows[0]?.locked !== true) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    throw err;
  }
  return async () => {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
      client.release();
    } catch (err) {
      // The unlock query failed — the session may still hold the advisory lock, so DESTROY the connection
      // (release(err)) rather than returning a possibly-still-locked session to the pool. Postgres frees a
      // session-level advisory lock when its backend disconnects, so dropping the client also drops the lock.
      client.release(err as Error);
      throw err;
    }
  };
}

async function processBreach(
  query: PgQuery,
  sendEmail: SendEmail,
  logger: Pick<Console, "log" | "warn" | "error">,
  args: {
    tenantSchema: string;
    officeId: string | null;
    breach: RfpPendingSlaBreach;
    recipients: string[];
    frontendUrl: string;
    slaHours: number;
  },
): Promise<"sent" | "skipped" | "failed"> {
  const { tenantSchema, officeId, breach, recipients, frontendUrl, slaHours } = args;

  // Already alerted for this pending cycle? The receipt is written only AFTER a durable send (below), so a
  // crash between "decided to send" and "sent" leaves NO receipt and the next scan retries — the alert is
  // never permanently suppressed.
  const existing = await query(
    `SELECT 1 FROM public.rfp_pending_sla_email_receipts
      WHERE tenant_schema = $1 AND deal_id = $2::uuid AND rfp_approval_requested_at = $3
      LIMIT 1`,
    [tenantSchema, breach.dealId, breach.requestedAt],
  );
  if (existing.rows.length > 0) return "skipped";

  // Re-check the deal is STILL a breach right before sending: a reviewer may approve/decline (or an override
  // may resolve) between the batch scan and this send, and those transitions are async. Skip a stale alert.
  if (!(await isStillBreaching(query, tenantSchema, breach))) return "skipped";

  try {
    const email = buildRfpPendingSlaEmail({
      dealId: breach.dealId,
      dealName: breach.dealName,
      dealNumber: breach.dealNumber,
      pendingSinceLabel: formatPendingSince(breach.requestedAt),
      slaHours,
      officeId,
      frontendUrl,
    });
    const result = await sendEmail(recipients, email.subject, email.html, {
      text: email.text,
      idempotencyKey: `rfp-pending-sla-${tenantSchema}-${breach.dealId}-${breach.requestedAt}`,
    });
    if (!result.success) throw new Error("Email provider returned unsuccessful result");
    // Record the receipt ONLY after the send is durable, so a failed send never suppresses a retry. ON
    // CONFLICT DO NOTHING guards the (single-worker) case of an overlapping run that already recorded it.
    await query(
      `INSERT INTO public.rfp_pending_sla_email_receipts
          (tenant_schema, deal_id, rfp_approval_requested_at, deal_number, recipient_emails, resend_message_id, sent_at, created_at, updated_at)
        VALUES ($1, $2::uuid, $3, $4, $5, $6, NOW(), NOW(), NOW())
        ON CONFLICT (tenant_schema, deal_id, rfp_approval_requested_at) DO NOTHING`,
      [tenantSchema, breach.dealId, breach.requestedAt, breach.dealNumber, recipients.join(", "), result.messageId],
    );
    logger.log("[RfpPendingSla] Sent SLA breach alert", {
      tenantSchema,
      dealId: breach.dealId,
      hoursPending: Math.floor(breach.hoursPending),
      messageId: result.messageId,
    });
    return "sent";
  } catch (err) {
    // No receipt was written, so the next hourly scan retries. One deal's failure must not abort the rest of
    // the scan, so we swallow + log here.
    logger.error("[RfpPendingSla] Failed to send SLA breach alert", {
      tenantSchema,
      dealId: breach.dealId,
      err,
    });
    return "failed";
  }
}

/** Re-read the deal and confirm it's STILL an awaiting, unresolved, alert-eligible pending RFP for the same
 * cycle — the same predicate as findPendingRfpSlaBreaches, minus the 24h clock (only grows). */
async function isStillBreaching(
  query: PgQuery,
  schemaName: string,
  breach: RfpPendingSlaBreach,
): Promise<boolean> {
  if (!TENANT_SCHEMA_REGEX.test(schemaName)) return false;
  const result = await query(
    `SELECT d.rfp_approval_status AS status,
            d.rfp_approval_requested_at AS requested_at,
            psc.slug AS stage_slug,
            COALESCE(d.is_bid_board_owned, false) AS bbo,
            COALESCE(d.is_active, false) AS active,
            COALESCE(d.is_test_data, false) AS test_data,
            COALESCE(d.on_hold, false) AS on_hold,
            COALESCE(d.rfp_override_decision, '') AS override_decision,
            COALESCE(d.rfp_override_state, '') AS override_state
       FROM ${schemaName}.deals d
       LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.id = $1::uuid
      LIMIT 1`,
    [breach.dealId],
  );
  const row = result.rows[0];
  if (!row) return false;
  // The stage must STILL canonicalize to Opportunity — a deal moved out of Opportunity via POST /stage does
  // not clear rfp_approval_status, so the status check alone would let a moved deal slip through.
  const slug = row.stage_slug == null ? null : String(row.stage_slug);
  const stageIsOpportunity =
    slug != null &&
    (toCanonicalDealStageSlug(slug, "normal") === "opportunity" ||
      toCanonicalDealStageSlug(slug, "service") === "opportunity");
  return (
    stageIsOpportunity &&
    (PENDING_RFP_AWAITING_STATUSES as readonly string[]).includes(String(row.status)) &&
    row.requested_at != null &&
    new Date(row.requested_at).toISOString() === breach.requestedAt &&
    row.bbo !== true &&
    row.active === true &&
    row.test_data !== true &&
    row.on_hold !== true &&
    row.override_decision !== "denial_reconfirmed" &&
    row.override_state !== "approving"
  );
}

function formatPendingSince(iso: string): string {
  const label = new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${label} CT`;
}

export function buildRfpPendingSlaEmail(input: {
  dealId: string;
  dealName: string;
  dealNumber: string | null;
  pendingSinceLabel: string;
  slaHours: number;
  officeId?: string | null;
  frontendUrl: string;
}) {
  // officeId carries the deal's tenant so a cross-office reviewer (leadership often is) doesn't 404; mirrors
  // the #611 project-number/decline link builder. Append ONLY officeId.
  const officeParam = input.officeId ? `?officeId=${encodeURIComponent(input.officeId)}` : "";
  const baseUrl = input.frontendUrl.replace(/\/+$/, "");
  const dealUrl = `${baseUrl}/deals/${encodeURIComponent(input.dealId)}${officeParam}`;
  const queueUrl = `${baseUrl}/deals/pending-rfp${officeParam}`;
  const safeDealUrl = escapeHtml(dealUrl);
  const safeQueueUrl = escapeHtml(queueUrl);

  // The payload is deliberately STABLE per pending cycle (no live "hours pending" count): the Resend
  // idempotencyKey is keyed on rfp_approval_requested_at, and Resend rejects a same-key/different-payload
  // retry. "more than {slaHours}h" + the fixed "Pending since" instant convey urgency without drifting each
  // hour, so a crash-then-retry re-sends cleanly instead of being rejected until the key TTL expires.
  const subject = input.dealNumber
    ? `RFP pending approval >${input.slaHours}h: ${input.dealNumber} (${input.dealName})`
    : `RFP pending approval >${input.slaHours}h: ${input.dealName}`;

  const rows = [
    ["Deal name", input.dealName],
    ["Project number", input.dealNumber ?? "Pending"],
    ["Pending since", input.pendingSinceLabel],
    ["Time pending", `More than ${input.slaHours} hours`],
  ] as const;

  const htmlRows = rows
    .map(([label, value]) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;vertical-align:top;width:150px;">${escapeHtml(label)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;vertical-align:top;">${escapeHtml(value)}</td>
        </tr>`)
    .join("");

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>RFP Pending Approval</title>
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
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">RFP Awaiting Approval</h1>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:6px 24px 16px 24px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;">This RFP has been waiting for approval for more than ${input.slaHours} hours. Open the deal to move it forward, or review the full Pending RFP queue.</p>
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
            <td align="center" style="padding:4px 24px 16px 24px;">
              <a href="${safeQueueUrl}" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#CC0000;text-decoration:underline;">Open the Pending RFP queue</a>
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
    `\n\nView the deal in the CRM: ${dealUrl}` +
    `\n\nOpen the Pending RFP queue: ${queueUrl}`;
  return { subject, html, text, dealUrl, queueUrl };
}
