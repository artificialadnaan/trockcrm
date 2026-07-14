import { createHash } from "node:crypto";
import { pool } from "../db.js";
import { sendSystemEmailWithMetadata, type SendSystemEmailResult } from "../lib/system-email.js";
import { escapeHtml, isSafeTenantSchema, normalizeText } from "../lib/email-format.js";
import type { JobHandlerResult } from "../queue.js";
import { resolveFrontendUrl } from "./project-number-email.js";

/** Job type emitted by the durable Won-metric reduction outbox. */
export const WON_METRIC_REDUCTION_ALERT_JOB = "won_metric_reduction_alert";
/** A stuck worker's claim becomes reclaimable after five minutes; normal send failures release it immediately. */
export const WON_METRIC_REDUCTION_DELIVERY_LEASE_SECONDS = 5 * 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Non-production can use this safe corporate fallback. Production must explicitly configure recipients so
// the required leadership audience is reviewed in deployment configuration instead of silently using a
// personal mailbox or an incomplete hard-coded list.
export const DEFAULT_WON_METRIC_DECREASE_RECIPIENTS = ["tyamashita@trockgc.com", "adnaan@trockgc.com"] as const;

type PgQuery = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
type SendEmail = (
  to: string | string[],
  subject: string,
  html: string,
  options: { text: string; idempotencyKey: string },
) => Promise<SendSystemEmailResult>;

export interface WonMetricReductionAlertPayload {
  eventId: string;
}

interface HandlerDeps {
  query?: PgQuery;
  sendEmail?: SendEmail;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

interface WonMetricReductionEvent {
  id: string;
  tenantSchema: string;
  dealId: string | null;
  eventKind: string | null;
  actionLabel: string | null;
  reasonCode: string | null;
  changedFields: unknown;
  impacts: unknown;
  auditReference: unknown;
  oldSnapshot: unknown;
  newSnapshot: unknown;
  dealName: string | null;
  dealNumber: string | null;
  reportMetricKey: string | null;
  definitionVersion: string | null;
  definitionHash: string | null;
  releaseReference: string | null;
  createdAt: string | null;
}

export interface WonMetricImpact {
  metricKey: string | null;
  before: number | null;
  after: number | null;
  delta: number | null;
  countBefore: number | null;
  countAfter: number | null;
  countDelta: number | null;
  unit: string | null;
  isNegative: boolean;
}

type DeferredJobResult = Extract<JobHandlerResult, { status: "pending" }>;

type WonMetricDeliveryGateDeps = {
  query?: PgQuery;
  logger?: Pick<Console, "log" | "warn" | "error">;
};

type EnrichedAuditCitationRow = {
  id: string;
  action: string | null;
  actorName: string | null;
  actorRole: string | null;
  actorSystemProcess: string | null;
  changedBy: string | null;
  createdAt: string | null;
};

/**
 * Deliver a durable Won-metric-reduction event to the configured leadership recipients.
 *
 * The event row is immutable, which keeps every retry's subject/body stable. Each recipient gets a nullable
 * receipt claim before sending; a failed send deliberately leaves `sent_at` NULL, so the queue retry can send
 * again using the identical Resend idempotency key. A successful send stamps the receipt afterwards.
 */
export async function handleWonMetricReductionAlert(
  payload: WonMetricReductionAlertPayload,
  _officeId: string | null,
  deps: HandlerDeps = {},
): Promise<JobHandlerResult> {
  const logger = deps.logger ?? console;
  const eventId = normalizeUuid(payload?.eventId);
  if (!eventId) {
    logger.warn("[WonMetricReductionAlert] Invalid job payload - skipping", { eventId: payload?.eventId });
    return;
  }

  const query = deps.query ?? (pool.query.bind(pool) as PgQuery);
  let eventResult: { rows: any[] };
  try {
    eventResult = await query(
      `SELECT e.id::text AS event_id,
            e.tenant_schema,
            e.deal_id::text AS deal_id,
            e.event_kind,
            e.action_label,
            e.reason_code,
            e.changed_fields,
            e.impacts,
            e.audit_reference,
            e.old_snapshot,
            e.new_snapshot,
            e.deal_name,
            e.deal_number,
            e.report_metric_key,
            e.definition_version,
            e.definition_hash,
            e.release_reference,
            e.created_at
       FROM public.won_metric_reduction_events e
      WHERE e.id = $1::uuid
      LIMIT 1`,
      [eventId],
    );
  } catch (error) {
    if (isMissingRelationError(error)) {
      logger.warn("[WonMetricReductionAlert] Reduction-event table is not available yet; skipping pre-migration job", {
        eventId,
        error,
      });
      return;
    }
    throw error;
  }
  const event = normalizeEvent(eventResult.rows[0], eventId);
  if (!event) {
    logger.warn("[WonMetricReductionAlert] Event no longer exists - skipping", { eventId });
    return;
  }
  if (!isSafeTenantSchema(event.tenantSchema)) {
    logger.warn("[WonMetricReductionAlert] Event has an unsafe tenant schema - skipping", {
      eventId,
      tenantSchema: event.tenantSchema,
    });
    return;
  }

  const impact = resolveWonMetricImpact(event.impacts, event.reportMetricKey);
  if (!impact.isNegative) {
    // A durable event can be stale/superseded or contain only a non-negative metric. Never notify on that.
    logger.log("[WonMetricReductionAlert] Event has no negative Won impact - skipping", {
      eventId,
      reportMetricKey: event.reportMetricKey,
    });
    return;
  }

  // The deal trigger runs while the write transaction is still open, while richer app-level audit rows
  // are commonly inserted later in that SAME transaction. PostgreSQL's `now()` is transaction-stable, so
  // after commit we can safely recover those rows by joining their stored timestamp to the event's stored
  // timestamp (rather than guessing from the most-recent audit row). Keep the trigger-captured IDs too,
  // because older write paths may only have the database audit trigger.
  const eventForDelivery = await enrichEventAuditCitation(query, event, logger);

  const env = deps.env ?? process.env;
  const recipients = resolveWonMetricDecreaseRecipients(env);
  if (recipients.length === 0) {
    const error = new Error("WON_METRIC_DECREASE_EMAIL_RECIPIENTS is not configured with a valid email address");
    logger.error("[WonMetricReductionAlert] Cannot deliver Won-metric reduction alert", { eventId, error });
    throw error;
  }

  // Office lookup enriches the deep link only. A missing/stale office must never block primary email delivery.
  const officeId = await resolveOfficeId(query, event.tenantSchema).catch((error) => {
    logger.warn("[WonMetricReductionAlert] Could not resolve tenant office for link; continuing without officeId", {
      eventId,
      tenantSchema: event.tenantSchema,
      error,
    });
    return null;
  });
  const email = buildWonMetricReductionEmail({
    event: eventForDelivery,
    impact,
    officeId,
    frontendUrl: resolveFrontendUrl(env),
  });
  const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;
  let deferredOutcome: DeferredJobResult | null = null;

  for (const recipientEmail of recipients) {
    // Atomically acquire the recipient's delivery lease. The conflict branch may only take over an UNSENT,
    // stale lease; a live claimant receives no row and is the sole worker allowed to call the email provider.
    // This closes the normal at-least-once queue race before the side effect, rather than relying solely on
    // Resend idempotency after two workers have both started sends.
    let claimResult: { rows: any[] };
    try {
      claimResult = await query(
        `INSERT INTO public.won_metric_reduction_delivery_receipts AS receipt
            (event_id, recipient_email, claimed_at)
         VALUES ($1::uuid, $2, NOW())
         ON CONFLICT (event_id, recipient_email) DO UPDATE
           SET claimed_at = NOW()
         WHERE receipt.sent_at IS NULL
           AND receipt.claimed_at <= NOW() - make_interval(secs => $3::int)
         RETURNING receipt.claimed_at, receipt.sent_at, receipt.resend_message_id`,
        [event.id, recipientEmail, WON_METRIC_REDUCTION_DELIVERY_LEASE_SECONDS],
      );
    } catch (error) {
      if (isMissingRelationError(error)) {
        logger.warn("[WonMetricReductionAlert] Delivery-receipt table is not available yet; skipping pre-migration job", {
          eventId: event.id,
          recipientEmail,
          error,
        });
        return;
      }
      throw error;
    }

    const lease = claimResult.rows[0];
    if (!lease) {
      let receiptResult: { rows: any[] };
      try {
        receiptResult = await query(
          `SELECT sent_at,
                  resend_message_id,
                  claimed_at,
                  GREATEST(
                    1,
                    CEIL(EXTRACT(EPOCH FROM (claimed_at + make_interval(secs => $3::int) - NOW()))
                  )::int AS retry_after_seconds
             FROM public.won_metric_reduction_delivery_receipts
            WHERE event_id = $1::uuid
              AND recipient_email = $2
            LIMIT 1`,
          [event.id, recipientEmail, WON_METRIC_REDUCTION_DELIVERY_LEASE_SECONDS],
        );
      } catch (error) {
        if (isMissingRelationError(error)) {
          logger.warn("[WonMetricReductionAlert] Delivery-receipt table disappeared during rollout; skipping email", {
            eventId: event.id,
            recipientEmail,
            error,
          });
          return;
        }
        throw error;
      }
      const receipt = receiptResult.rows[0];
      if (receipt?.sent_at != null) {
        logger.log("[WonMetricReductionAlert] Recipient already delivered - skipping duplicate", {
          eventId: event.id,
          recipientEmail,
          messageId: receipt.resend_message_id ?? null,
        });
      } else {
        logger.log("[WonMetricReductionAlert] Another worker holds the active delivery lease - skipping duplicate send", {
          eventId: event.id,
          recipientEmail,
          claimedAt: receipt?.claimed_at ?? null,
        });
        // Do not complete the queue job while an UNSENT lease exists. A prior provider failure can leave
        // that lease live when its best-effort release also fails; returning a controlled defer lets this
        // job reclaim it as soon as PostgreSQL says the lease is stale.
        const candidate = deferActiveDeliveryLease(
          receipt ? deliveryLeaseRetryAfterSeconds(receipt.retry_after_seconds) : 1,
        );
        if (deferredOutcome == null || candidate.runAfterSeconds < deferredOutcome.runAfterSeconds) {
          deferredOutcome = candidate;
        }
      }
      continue;
    }

    const leaseClaimedAt = lease.claimed_at;
    if (leaseClaimedAt == null) {
      throw new Error("Won metric reduction receipt claim did not return claimed_at");
    }

    // In-app delivery is intentionally best-effort: an older tenant may not have notifications, or the enum
    // migration may be rolling out. It is deterministic on event+recipient+user, so both queue retries and a
    // resent email cannot create duplicate in-app cards.
    await ensureInAppNotification({
      query,
      logger,
      tenantSchema: event.tenantSchema,
      recipientEmail,
      event: eventForDelivery,
      reportMetricKey: impact.metricKey ?? eventForDelivery.reportMetricKey,
      email,
    });

    try {
      const result = await sendEmail(recipientEmail, email.subject, email.html, {
        text: email.text,
        idempotencyKey: resendIdempotencyKey(event.id, recipientEmail),
      });
      if (!result.success) throw new Error("Email provider returned unsuccessful result");

      const stampResult = await query(
        `UPDATE public.won_metric_reduction_delivery_receipts
            SET sent_at = NOW(),
                resend_message_id = $3
          WHERE event_id = $1::uuid
            AND recipient_email = $2
            AND sent_at IS NULL
            AND claimed_at = $4::timestamptz
         RETURNING event_id`,
        [event.id, recipientEmail, result.messageId, leaseClaimedAt],
      );
      if (stampResult.rows.length === 0) {
        throw new Error("Won metric reduction delivery lease was lost before receipt could be stamped");
      }
      logger.log("[WonMetricReductionAlert] Sent Won-metric reduction alert", {
        eventId: event.id,
        recipientEmail,
        messageId: result.messageId,
      });
    } catch (error) {
      // Explicitly expire only OUR lease. The queue retry can immediately claim it; if another worker already
      // reclaimed it, the claimed_at guard makes this a safe no-op and cannot release the other worker's lease.
      try {
        await releaseDeliveryLease(query, event.id, recipientEmail, leaseClaimedAt);
      } catch (releaseError) {
        logger.error("[WonMetricReductionAlert] Failed to release delivery lease after a send failure", {
          eventId: event.id,
          recipientEmail,
          releaseError,
        });
      }
      // Re-throw so the queue's normal backoff/retry path runs.
      logger.error("[WonMetricReductionAlert] Failed to send Won-metric reduction alert", {
        eventId: event.id,
        recipientEmail,
        error,
      });
      throw error;
    }
  }

  return deferredOutcome ?? undefined;
}

/**
 * Open the database delivery gate only from a handler-capable worker and backfill durable events created
 * while the migration was live but an older worker was still running. It is safe to call repeatedly.
 */
export async function enableWonMetricReductionAlertDelivery(deps: WonMetricDeliveryGateDeps = {}): Promise<number> {
  const query = deps.query ?? (pool.query.bind(pool) as PgQuery);
  const logger = deps.logger ?? console;
  try {
    const result = await query("SELECT public.enable_won_metric_reduction_alert_delivery() AS queued_count");
    const queuedCount = Number(result.rows[0]?.queued_count ?? 0);
    if (queuedCount > 0) {
      logger.log("[WonMetricReductionAlert] Enabled delivery and queued durable reduction events", { queuedCount });
    }
    return Number.isFinite(queuedCount) ? queuedCount : 0;
  } catch (error) {
    // A worker can be deployed ahead of migration 0184. Treat only PostgreSQL's explicit missing-function
    // error as a temporary compatibility case; retrying this idempotent call later opens the gate.
    if (isUndefinedFunctionError(error)) return 0;
    throw error;
  }
}

async function releaseDeliveryLease(
  query: PgQuery,
  eventId: string,
  recipientEmail: string,
  claimedAt: unknown,
): Promise<void> {
  await query(
    `UPDATE public.won_metric_reduction_delivery_receipts
        SET claimed_at = NOW() - make_interval(secs => $4::int)
      WHERE event_id = $1::uuid
        AND recipient_email = $2
        AND sent_at IS NULL
        AND claimed_at = $3::timestamptz`,
    // Set one second beyond the stale boundary so the queue's normal 3/9/27-second backoff can reclaim now.
    [eventId, recipientEmail, claimedAt, WON_METRIC_REDUCTION_DELIVERY_LEASE_SECONDS + 1],
  );
}

/** Comma-list parser for WON_METRIC_DECREASE_EMAIL_RECIPIENTS: trim, validate, normalize, and dedupe. */
export function resolveWonMetricDecreaseRecipients(env: NodeJS.ProcessEnv): string[] {
  const seen = new Set<string>();
  const recipients: string[] = [];
  const configured = String(env.WON_METRIC_DECREASE_EMAIL_RECIPIENTS ?? "").trim();
  const source = configured
    ? configured.split(",")
    : env.NODE_ENV === "production"
      ? []
      : DEFAULT_WON_METRIC_DECREASE_RECIPIENTS;
  for (const raw of source) {
    const email = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    recipients.push(email);
  }
  return recipients;
}

/**
 * Resolve the canonical `impacts` JSON shape:
 * `{ "scope.metric": { scope, scopeId, metric, countBefore, countAfter, countDelta, before, after, delta, unit } }`.
 * Older/manual event shapes are tolerated for operational recovery, but an event is alertable only when a
 * selected value delta or count delta is negative.
 */
export function resolveWonMetricImpact(impacts: unknown, reportMetricKey: string | null): WonMetricImpact {
  const parsed = parseJson(impacts);
  const candidates: Array<WonMetricImpact & { score: number }> = [];
  collectImpactCandidates(parsed, [], candidates);
  if (candidates.length === 0) {
    return emptyImpact(reportMetricKey);
  }

  const target = normalizeMetricKey(reportMetricKey);
  const score = (candidate: WonMetricImpact & { score: number }) => {
    const candidateKey = normalizeMetricKey(candidate.metricKey);
    if (target && candidateKey === target) return 100 + candidate.score;
    if (target && candidateKey.includes(target)) return 80 + candidate.score;
    return metricPriority(candidate.metricKey) + candidate.score;
  };
  const ranked = [...candidates].sort((a, b) => {
    const scoreDifference = score(b) - score(a);
    if (scoreDifference !== 0) return scoreDifference;
    // Mutation impacts include both the canonical dashboard and estimator Won-YTD figures. JSON object
    // ordering is not a contract, so make the executive-facing dashboard figure win a genuine tie.
    return canonicalWonYtdTieBreak(b.metricKey) - canonicalWonYtdTieBreak(a.metricKey);
  });
  // Prefer a negative target impact; when the target is absent, a negative event impact still deserves an alert.
  const targetCandidates = target
    ? ranked.filter((candidate) => {
        const key = normalizeMetricKey(candidate.metricKey);
        return key === target || key.includes(target);
      })
    : [];
  const selected =
    targetCandidates.find((candidate) => candidate.isNegative) ??
    targetCandidates[0] ??
    ranked.find((candidate) => candidate.isNegative) ??
    ranked[0];
  return {
    metricKey: selected.metricKey ?? reportMetricKey,
    before: selected.before,
    after: selected.after,
    delta: selected.delta,
    countBefore: selected.countBefore,
    countAfter: selected.countAfter,
    countDelta: selected.countDelta,
    unit: selected.unit,
    isNegative: selected.isNegative,
  };
}

type WonMetricReductionEmailEvent = Pick<
  WonMetricReductionEvent,
  | "dealId"
  | "dealName"
  | "dealNumber"
  | "reportMetricKey"
  | "definitionVersion"
  | "releaseReference"
  | "actionLabel"
  | "reasonCode"
  | "changedFields"
  | "auditReference"
> & { newSnapshot?: unknown };

export function buildWonMetricReductionEmail(input: {
  event: WonMetricReductionEmailEvent;
  impact: WonMetricImpact;
  officeId?: string | null;
  frontendUrl: string;
}) {
  const metricLabel = metricLabelFor(input.impact.metricKey ?? input.event.reportMetricKey);
  const figure = formatImpact(input.impact, metricLabel);
  const reason = input.event.reasonCode ? humanizeToken(input.event.reasonCode) : "Metric reduction detected";
  const action = input.event.actionLabel ?? "No action label was supplied";
  const changedFields = formatChangedFields(input.event.changedFields);
  const auditCitation = formatAuditCitation(input.event.auditReference);
  const definition = input.event.definitionVersion ? `Definition ${input.event.definitionVersion}` : null;
  const releaseReference = input.event.releaseReference;
  const dealName = input.event.dealName ?? "Deal";
  const dealNumber = input.event.dealNumber;
  const dealUrl = canLinkToDeal(input.event)
    ? buildDealUrl(input.frontendUrl, input.event.dealId!, input.officeId)
    : null;
  const reportMetricKey = input.impact.metricKey ?? input.event.reportMetricKey;
  const reportUrl = buildWonMetricReportUrl(input.frontendUrl, reportMetricKey, input.officeId);

  const subject = `Won metric reduced: ${metricLabel} ${formatImpactDelta(input.impact)}`;
  const textLines = [
    "Won metric reduction detected",
    figure,
    `Reason: ${reason}`,
    `Exact action: ${action}`,
    changedFields ? `Changed fields: ${changedFields}` : null,
    auditCitation ? `Audit citation: ${auditCitation}` : null,
    definition,
    releaseReference ? `Release reference: ${releaseReference}` : null,
    dealUrl ? `Deal: ${dealName}${dealNumber ? ` (${dealNumber})` : ""} — ${dealUrl}` : `Report: ${reportUrl}`,
  ].filter((line): line is string => Boolean(line));

  const rows: Array<[string, string]> = [
    ["Figure", figure] as [string, string],
    ["Reason", reason] as [string, string],
    ["Exact action", action] as [string, string],
    ...(changedFields ? ([['Changed fields', changedFields]] as Array<[string, string]>) : []),
    ...(auditCitation ? ([['Audit citation', auditCitation]] as Array<[string, string]>) : []),
    ...(definition ? ([['Definition', definition]] as Array<[string, string]>) : []),
    ...(releaseReference ? ([['Release', releaseReference]] as Array<[string, string]>) : []),
  ];
  const htmlRows = rows
    .map(
      ([label, value]) => `<tr>
  <td style="padding:7px 12px 7px 0;color:#64748b;font-family:Arial,Helvetica,sans-serif;font-size:13px;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
  <td style="padding:7px 0;color:#111827;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;">${escapeHtml(value)}</td>
</tr>`,
    )
    .join("\n");
  const primaryUrl = dealUrl ?? reportUrl;
  const primaryLabel = dealUrl ? `Open ${escapeHtml(dealName)}` : wonMetricReportLabel(reportMetricKey);
  const releaseHtml = releaseReference
    ? `<p style="margin:14px 0 0;color:#475569;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;">Release reference: ${renderReference(releaseReference)}</p>`
    : "";
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f8fafc;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #fecaca;border-top:4px solid #b91c1c;border-radius:4px;">
      <tr><td style="padding:28px 30px;">
        <h1 style="margin:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:28px;color:#991b1b;">Won metric reduced</h1>
        <p style="margin:0 0 20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#334155;">A Won figure decreased and needs review.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">${htmlRows}</table>
        <p style="margin:24px 0 0;"><a href="${escapeHtml(primaryUrl)}" style="display:inline-block;background:#b91c1c;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;line-height:20px;padding:10px 16px;text-decoration:none;border-radius:4px;">${primaryLabel}</a></p>
        ${releaseHtml}
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  return { subject, text: textLines.join("\n"), html, dealUrl, reportUrl };
}

async function ensureInAppNotification(input: {
  query: PgQuery;
  logger: Pick<Console, "log" | "warn" | "error">;
  tenantSchema: string;
  recipientEmail: string;
  event: WonMetricReductionEvent;
  reportMetricKey: string | null;
  email: ReturnType<typeof buildWonMetricReductionEmail>;
}): Promise<void> {
  const { query, logger, tenantSchema, recipientEmail, event, reportMetricKey, email } = input;
  try {
    const users = await query(
      `SELECT id::text AS id
         FROM public.users
        WHERE is_active = true
          AND LOWER(email) = $1`,
      [recipientEmail],
    );
    const title = truncate(email.subject.replace(/^Won metric reduced:\s*/i, "Won metric reduced: "), 500);
    const body = truncate(email.text.replace(/\n+/g, " · "), 3_500);
    // Keep the in-app card aligned with the email CTA. Archived/deleted deals intentionally 404 through
    // the normal detail route, so those alerts must lead to the report rather than a dead deal link.
    const link = email.dealUrl && event.dealId
      ? relativeDealLink(event.dealId)
      : relativeWonMetricReportLink(reportMetricKey);
    for (const user of users.rows) {
      const userId = normalizeUuid(user.id);
      if (!userId) continue;
      await query(
        `INSERT INTO ${tenantSchema}.notifications
            (id, user_id, type, title, body, link, is_read, created_at)
         VALUES ($1::uuid, $2::uuid, 'won_metric_decrease', $3, $4, $5, false, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [notificationId(event.id, recipientEmail, userId), userId, title, body, link],
      );
    }
  } catch (error) {
    // This is deliberately non-fatal. Email is the durable primary delivery and tenants can roll the enum/table
    // migration independently; a missing notification surface must not cause the event to dead-letter.
    logger.warn("[WonMetricReductionAlert] In-app notification unavailable; email delivery continues", {
      eventId: event.id,
      recipientEmail,
      tenantSchema,
      error,
    });
  }
}

async function resolveOfficeId(query: PgQuery, tenantSchema: string): Promise<string | null> {
  const result = await query(
    `SELECT id::text AS id
       FROM public.offices
      WHERE ('office_' || slug) = $1
        AND is_active = true
      LIMIT 1`,
    [tenantSchema],
  );
  return normalizeUuid(result.rows[0]?.id) ?? null;
}

function normalizeEvent(row: any, fallbackId: string): WonMetricReductionEvent | null {
  if (!row) return null;
  const id = normalizeUuid(row.event_id ?? row.id) ?? fallbackId;
  const tenantSchema = normalizeText(row.tenant_schema);
  if (!tenantSchema) return null;
  return {
    id,
    tenantSchema,
    dealId: normalizeUuid(row.deal_id),
    eventKind: normalizeText(row.event_kind),
    actionLabel: normalizeText(row.action_label),
    reasonCode: normalizeText(row.reason_code),
    changedFields: parseJson(row.changed_fields),
    impacts: parseJson(row.impacts),
    auditReference: parseJson(row.audit_reference),
    oldSnapshot: parseJson(row.old_snapshot),
    newSnapshot: parseJson(row.new_snapshot),
    dealName: normalizeText(row.deal_name),
    dealNumber: normalizeText(row.deal_number),
    reportMetricKey: normalizeText(row.report_metric_key),
    definitionVersion: normalizeText(row.definition_version),
    definitionHash: normalizeText(row.definition_hash),
    releaseReference: normalizeText(row.release_reference),
    createdAt: normalizeText(row.created_at == null ? null : String(row.created_at)),
  };
}

/**
 * Enrich the trigger's forensic reference after the originating transaction has committed.
 *
 * The trigger writes its event before some service-layer audit calls, so looking up only the audit row
 * visible at trigger time can omit the actor/action metadata the alert needs. This query is deliberately
 * strict: it only accepts audit rows for this exact deal which either (a) were already cited by the
 * trigger, or (b) share the event's database transaction timestamp. PostgreSQL evaluates `now()` once per
 * transaction, so the latter joins app-level audit inserts from the same committed action without a
 * racy/latest-row heuristic.
 */
async function enrichEventAuditCitation(
  query: PgQuery,
  event: WonMetricReductionEvent,
  logger: Pick<Console, "log" | "warn" | "error">,
): Promise<WonMetricReductionEvent> {
  if (!event.dealId || !isSafeTenantSchema(event.tenantSchema)) return event;

  try {
    const result = await query(
      `SELECT a.id::text AS id,
              a.action::text AS action,
              a.actor_name AS audit_actor_name,
              a.actor_role,
              a.actor_system_process,
              a.changed_by::text AS changed_by,
              COALESCE(NULLIF(a.actor_name, ''), NULLIF(a.actor_system_process, ''), u.display_name) AS actor_name,
              a.created_at::text AS created_at,
              a.changes,
              a.field_changes_jsonb
         FROM public.won_metric_reduction_events e
         JOIN ${event.tenantSchema}.audit_log a
           ON a.table_name = 'deals'
          AND a.record_id = e.deal_id
         LEFT JOIN public.users u ON u.id = a.changed_by
        WHERE e.id = $1::uuid
          AND (
            a.created_at = e.created_at
            OR a.id::text IN (
              SELECT jsonb_array_elements_text(COALESCE(e.audit_reference->'auditLogIds', '[]'::jsonb))
            )
          )
        ORDER BY
          CASE WHEN a.field_changes_jsonb IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN a.actor_name IS NOT NULL OR a.actor_system_process IS NOT NULL OR u.display_name IS NOT NULL THEN 0 ELSE 1 END,
          a.id DESC
        LIMIT 12`,
      [event.id],
    );
    if (result.rows.length === 0) return event;

    const existing = parseJson(event.auditReference);
    const auditReference = isRecord(existing) ? { ...existing } : {};
    const existingIds = Array.isArray(auditReference.auditLogIds)
      ? auditReference.auditLogIds.map((value) => String(value))
      : [];
    const auditRows = result.rows
      .map((row) => ({
        id: normalizeText(row.id == null ? null : String(row.id)),
        action: normalizeText(row.action),
        actorName: normalizeText(row.actor_name),
        actorRole: normalizeText(row.actor_role),
        actorSystemProcess: normalizeText(row.actor_system_process),
        changedBy: normalizeText(row.changed_by == null ? null : String(row.changed_by)),
        createdAt: normalizeText(row.created_at == null ? null : String(row.created_at)),
      }))
      .filter((row): row is EnrichedAuditCitationRow => row.id != null);
    if (auditRows.length === 0) return event;

    const selected = auditRows[0]!;
    auditReference.auditLogIds = [...new Set([...existingIds, ...auditRows.map((row) => row.id)])];
    // Preserve `action`, which is the trigger's human-readable exact-action label. These fields describe
    // the cited audit record itself and are displayed alongside it in the worker email.
    auditReference.auditAction = selected.action;
    auditReference.actorName = selected.actorName;
    auditReference.actorRole = selected.actorRole;
    auditReference.actorSystemProcess = selected.actorSystemProcess;
    auditReference.changedBy = selected.changedBy;
    auditReference.createdAt = selected.createdAt;

    return { ...event, auditReference };
  } catch (error) {
    // The event itself remains authoritative. Audit enrichment must never block the primary alert during
    // a partial tenant-schema rollout or an older audit-log shape.
    logger.warn("[WonMetricReductionAlert] Could not enrich audit citation; using trigger reference", {
      eventId: event.id,
      tenantSchema: event.tenantSchema,
      error,
    });
    return event;
  }
}

function collectImpactCandidates(
  value: unknown,
  path: string[],
  out: Array<WonMetricImpact & { score: number }>,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectImpactCandidates(entry, [...path, String(index)], out));
    return;
  }
  if (!isRecord(value)) return;

  const before = readNumber(value, ["before", "previous", "previousValue", "previous_value", "old", "oldValue", "old_value"]);
  const after = readNumber(value, ["after", "current", "currentValue", "current_value", "new", "newValue", "new_value"]);
  const explicitDelta = readNumber(value, ["delta", "valueDelta", "value_delta", "amountDelta", "amount_delta"]);
  const delta = explicitDelta ?? (before != null && after != null ? after - before : null);
  const countBefore = readNumber(value, ["countBefore", "count_before", "previousCount", "previous_count"]);
  const countAfter = readNumber(value, ["countAfter", "count_after", "currentCount", "current_count"]);
  const countDelta =
    readNumber(value, ["countDelta", "count_delta", "dealCountDelta", "deal_count_delta", "winsCountDelta", "wins_count_delta"]) ??
    (countBefore != null && countAfter != null ? countAfter - countBefore : null);
  const declaredMetric = normalizeText(value.metric) ?? normalizeText(value.metricKey) ?? normalizeText(value.metric_key);
  const declaredScope = normalizeText(value.scope);
  const declaredScopeId = normalizeText(value.scopeId) ?? normalizeText(value.scope_id);
  const metricKey =
    declaredScope && declaredMetric
      ? [declaredScope, declaredScopeId, declaredMetric].filter((part): part is string => part != null).join(".")
      : declaredMetric ?? path.at(-1) ?? null;
  const unit = normalizeText(value.unit);
  if (delta != null || countDelta != null) {
    out.push({
      metricKey,
      before,
      after,
      delta,
      countBefore,
      countAfter,
      countDelta,
      unit,
      isNegative: (delta ?? 0) < 0 || (countDelta ?? 0) < 0,
      score: path.length,
    });
  }

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "number" || (typeof child === "string" && numericValue(child) != null)) {
      // Recovery compatibility for a direct shape such as `{ "won_ytd": -300000 }`.
      if (!isKnownImpactField(key)) {
        const directDelta = numericValue(child);
        out.push({
          metricKey: key,
          before: null,
          after: null,
          delta: directDelta,
          countBefore: null,
          countAfter: null,
          countDelta: null,
          unit: null,
          isNegative: (directDelta ?? 0) < 0,
          score: path.length + 1,
        });
      }
      continue;
    }
    collectImpactCandidates(child, [...path, key], out);
  }
}

function emptyImpact(metricKey: string | null): WonMetricImpact {
  return {
    metricKey,
    before: null,
    after: null,
    delta: null,
    countBefore: null,
    countAfter: null,
    countDelta: null,
    unit: null,
    isNegative: false,
  };
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = numericValue(record[key]);
    if (value != null) return value;
  }
  return null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && /^[-+]?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isKnownImpactField(key: string): boolean {
  return [
    "scope",
    "scopeId",
    "scope_id",
    "metric",
    "metricKey",
    "metric_key",
    "unit",
    "before",
    "after",
    "delta",
    "countBefore",
    "countAfter",
    "countDelta",
    "count_before",
    "count_after",
    "count_delta",
    "previous",
    "current",
    "old",
    "new",
    "previousValue",
    "currentValue",
    "oldValue",
    "newValue",
    "previous_value",
    "current_value",
    "old_value",
    "new_value",
    "valueDelta",
    "value_delta",
    "amountDelta",
    "amount_delta",
  ].includes(key);
}

function formatImpact(impact: WonMetricImpact, metricLabel: string): string {
  const currency = isCurrencyImpact(impact);
  const value = (amount: number) => (currency ? formatCurrency(amount) : formatNumber(amount));
  const delta = impact.delta ?? impact.countDelta;
  const countSummary =
    impact.countBefore != null && impact.countAfter != null
      ? `projects: ${formatNumber(impact.countBefore)} → ${formatNumber(impact.countAfter)} (${formatSigned(
          impact.countDelta ?? impact.countAfter - impact.countBefore,
          false,
        )})`
      : null;
  if (impact.before != null && impact.after != null) {
    const valueSummary = `${metricLabel}: ${value(impact.before)} → ${value(impact.after)} (${formatSigned(
      delta ?? impact.after - impact.before,
      currency,
    )})`;
    return countSummary ? `${valueSummary}; ${countSummary}` : valueSummary;
  }
  if (impact.countBefore != null && impact.countAfter != null && impact.delta == null) {
    return `${metricLabel}: ${countSummary}`;
  }
  return `${metricLabel}: ${formatSigned(delta ?? 0, currency)}`;
}

function formatImpactDelta(impact: WonMetricImpact): string {
  // A metric is alert-worthy when EITHER dimension declines. If dollar value is flat or higher while
  // the number of Won projects falls, lead with the negative project count instead of a misleading +$ badge.
  const countIsTheReportedReduction = (impact.countDelta ?? 0) < 0 && (impact.delta == null || impact.delta >= 0);
  return formatSigned(
    countIsTheReportedReduction ? impact.countDelta ?? 0 : impact.delta ?? impact.countDelta ?? 0,
    countIsTheReportedReduction ? false : isCurrencyImpact(impact),
  );
}

function canLinkToDeal(event: WonMetricReductionEmailEvent): boolean {
  // The normal deal-detail route intentionally hides is_active=false rows. The trigger assigns these reason
  // codes for soft and hard deletion, so an active-only deal URL would be unusable for the recipient. Also
  // inspect the snapshot in case a compound update changes stage and activity in the same transaction.
  const snapshot = parseJson(event.newSnapshot);
  const deactivatedInSnapshot = isRecord(snapshot) && (snapshot.isActive === false || snapshot.isActive === "false");
  return (
    Boolean(event.dealId) &&
    event.reasonCode !== "archived_or_deactivated" &&
    event.reasonCode !== "deal_deleted" &&
    !deactivatedInSnapshot
  );
}

function isCurrencyImpact(impact: WonMetricImpact): boolean {
  const unit = impact.unit?.trim().toLowerCase();
  if (unit === "usd" || unit === "currency" || unit === "money") return true;
  if (unit === "count" || unit === "projects" || unit === "deals") return false;
  return !/(count|projects|deals|wins_count|wins-count)/i.test(impact.metricKey ?? "");
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatSigned(value: number, currency: boolean): string {
  const sign = value < 0 ? "−" : value > 0 ? "+" : "";
  const formatted = currency ? formatCurrency(Math.abs(value)) : formatNumber(Math.abs(value));
  return `${sign}${formatted}`;
}

function metricLabelFor(metricKey: string | null): string {
  const normalized = normalizeMetricKey(metricKey);
  if (normalized.includes("estimatorpipeline") && normalized.endsWith("wonytd")) return "Estimator Pipeline Won YTD";
  if (normalized === "wonytd" || normalized.endsWith("wonytd")) return "Won YTD";
  if (normalized === "wonmtd" || normalized.endsWith("wonmtd")) return "Won MTD";
  if (normalized === "wonvalue" || normalized === "closedvalue") return "Won value";
  if (normalized === "wincount" || normalized === "wonscount" || normalized === "wonytdcount") return "Won count";
  return metricKey ? humanizeToken(metricKey) : "Won metric";
}

function metricPriority(metricKey: string | null): number {
  const normalized = normalizeMetricKey(metricKey);
  // For a deal-mutation event that legitimately affects several windows, lead with the executive-facing
  // period most likely to be reviewed (YTD), then shorter current windows, then all-time.
  if (normalized.endsWith("wonytd")) return 40;
  if (normalized.endsWith("wonqtd")) return 30;
  if (normalized.endsWith("wonmtd")) return 20;
  if (normalized.endsWith("wonwtd")) return 10;
  return 0;
}

function canonicalWonYtdTieBreak(metricKey: string | null): number {
  const normalized = normalizeMetricKey(metricKey);
  if (normalized === "officewonytd") return 2;
  if (normalized === "officeestimatorpipelinewonytd") return 1;
  return 0;
}

function formatChangedFields(value: unknown): string | null {
  const parsed = parseJson(value);
  if (!isRecord(parsed)) return normalizeText(typeof parsed === "string" ? parsed : null);
  const parts: string[] = [];
  for (const [field, change] of Object.entries(parsed).slice(0, 5)) {
    if (isRecord(change)) {
      const before = readValue(change, ["before", "old", "oldValue", "old_value", "previous", "from"]);
      const after = readValue(change, ["after", "new", "newValue", "new_value", "current", "to"]);
      if (before !== undefined || after !== undefined) {
        parts.push(`${humanizeToken(field)}: ${before === undefined ? "—" : formatBrief(before)} → ${after === undefined ? "—" : formatBrief(after)}`);
        continue;
      }
    }
    parts.push(`${humanizeToken(field)}: ${formatBrief(change)}`);
  }
  return parts.length ? parts.join("; ") : null;
}

function formatAuditCitation(value: unknown): string | null {
  const parsed = parseJson(value);
  if (typeof parsed === "string") return normalizeText(parsed);
  if (!isRecord(parsed)) return null;
  const auditIds = Array.isArray(parsed.auditLogIds)
    ? parsed.auditLogIds.map((id) => normalizeText(String(id))).filter((id): id is string => id != null)
    : [];
  const id =
    normalizeText(parsed.audit_log_id) ??
    normalizeText(parsed.auditLogId) ??
    normalizeText(parsed.id) ??
    normalizeText(parsed.reference) ??
    (auditIds.length ? auditIds.join(", ") : null);
  const actor =
    normalizeText(parsed.actor_name) ??
    normalizeText(parsed.actorName) ??
    normalizeText(parsed.actorSystemProcess) ??
    normalizeText(parsed.actor);
  const timestamp = normalizeText(parsed.created_at) ?? normalizeText(parsed.createdAt) ?? normalizeText(parsed.timestamp);
  const action = normalizeText(parsed.action);
  const auditAction = normalizeText(parsed.auditAction);
  const transactionId = normalizeText(parsed.transactionId) ?? normalizeText(parsed.transaction_id);
  // Definition-change events store release metadata (hashes and `kind: release`) in this column, not a
  // CRM audit citation. Avoid manufacturing the misleading fallback "CRM audit record" for any metadata
  // object that contains none of the fields which can actually identify an audit action.
  if (!id && !action && !auditAction && !actor && !timestamp && !transactionId) return null;
  const prefix = id ? `Audit #${id}` : action ? `CRM action: ${action}` : "CRM audit record";
  const actionDetail = auditAction && auditAction !== action ? `(${auditAction})` : null;
  const pieces = [
    prefix,
    actionDetail,
    actor ? `by ${actor}` : null,
    timestamp ? `at ${timestamp}` : null,
    transactionId ? `(transaction ${transactionId})` : null,
  ].filter(Boolean);
  return pieces.join(" ") || null;
}

function readValue(record: Record<string, unknown>, keys: string[]): unknown | undefined {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function buildDealUrl(frontendUrl: string, dealId: string, officeId?: string | null): string {
  const officeParam = officeId ? `?officeId=${encodeURIComponent(officeId)}` : "";
  return `${frontendUrl.replace(/\/+$/, "")}/deals/${encodeURIComponent(dealId)}${officeParam}`;
}

function buildEstimatorReportUrl(frontendUrl: string, officeId?: string | null): string {
  const officeParam = officeId ? `?officeId=${encodeURIComponent(officeId)}` : "";
  return `${frontendUrl.replace(/\/+$/, "")}/reports/operations/estimator-pipeline${officeParam}`;
}

type DealsDashboardWonPeriod = "week" | "mtd" | "qtd" | "ytd" | null;

function dealsDashboardWonPeriod(metricKey: string | null | undefined): DealsDashboardWonPeriod | undefined {
  const normalized = normalizeMetricKey(metricKey);
  if (normalized.includes("estimatorpipeline")) return undefined;
  if (normalized.endsWith("wonalltime")) return null;
  if (normalized.endsWith("wonwtd")) return "week";
  if (normalized.endsWith("wonmtd")) return "mtd";
  if (normalized.endsWith("wonqtd")) return "qtd";
  if (normalized.endsWith("wonytd")) return "ytd";
  return undefined;
}

function isDealsDashboardWonMetric(metricKey: string | null | undefined): boolean {
  return dealsDashboardWonPeriod(metricKey) !== undefined;
}

function buildWonMetricReportUrl(
  frontendUrl: string,
  metricKey: string | null | undefined,
  officeId?: string | null,
): string {
  const period = dealsDashboardWonPeriod(metricKey);
  if (period === undefined) return buildEstimatorReportUrl(frontendUrl, officeId);
  const params = new URLSearchParams({ filter: "won" });
  if (period) params.set("period", period);
  params.set("scope", "all");
  if (officeId) params.set("officeId", officeId);
  return `${frontendUrl.replace(/\/+$/, "")}/deals?${params.toString()}`;
}

function wonMetricReportLabel(metricKey: string | null | undefined): string {
  return isDealsDashboardWonMetric(metricKey) ? "Open Deals Dashboard" : "Open estimator report";
}

function relativeWonMetricReportLink(metricKey: string | null | undefined): string {
  const period = dealsDashboardWonPeriod(metricKey);
  if (period === undefined) return "/reports/operations/estimator-pipeline";
  const params = new URLSearchParams({ filter: "won" });
  if (period) params.set("period", period);
  params.set("scope", "all");
  return `/deals?${params.toString()}`;
}

function deliveryLeaseRetryAfterSeconds(value: unknown): number {
  const seconds = numericValue(value);
  return seconds == null ? WON_METRIC_REDUCTION_DELIVERY_LEASE_SECONDS : Math.max(1, Math.ceil(seconds));
}

function deferActiveDeliveryLease(runAfterSeconds: number): DeferredJobResult {
  return {
    status: "pending",
    error: "Won metric reduction delivery is waiting for an active recipient lease",
    runAfterSeconds: Math.max(1, Math.ceil(runAfterSeconds)),
  };
}

function relativeDealLink(dealId: string): string {
  return `/deals/${encodeURIComponent(dealId)}`;
}

function resendIdempotencyKey(eventId: string, recipientEmail: string): string {
  return `${WON_METRIC_REDUCTION_ALERT_JOB}-${eventId}-${stableHash(recipientEmail).slice(0, 24)}`;
}

function notificationId(eventId: string, recipientEmail: string, userId: string): string {
  const hex = stableHash(`${eventId}:${recipientEmail}:${userId}`).slice(0, 32).split("");
  // RFC 4122-compatible deterministic v5-shaped UUID. The fixed ID makes the tenant notification insert
  // idempotent even if email delivery retries or a receipt was written just before a worker crash.
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : null;
}

function normalizeMetricKey(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function humanizeToken(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderReference(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\/[^\s]+$/i.test(trimmed)) {
    return `<a href="${escapeHtml(trimmed)}" style="color:#b91c1c;">${escapeHtml(trimmed)}</a>`;
  }
  return escapeHtml(trimmed);
}

function formatBrief(value: unknown): string {
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return truncate(value.trim(), 180);
  if (value == null) return "—";
  try {
    return truncate(JSON.stringify(value), 180);
  } catch {
    return "[unavailable]";
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !["{", "["].includes(trimmed[0] ?? "")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function isMissingRelationError(error: unknown): boolean {
  if (typeof error !== "object" || error == null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === "42P01" || candidate.code === "3F000") return true;
  return typeof candidate.message === "string" && /(?:relation|schema).*does not exist/i.test(candidate.message);
}

function isUndefinedFunctionError(error: unknown): boolean {
  if (typeof error !== "object" || error == null) return false;
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  return candidate.code === "42883" || candidate.cause?.code === "42883";
}
