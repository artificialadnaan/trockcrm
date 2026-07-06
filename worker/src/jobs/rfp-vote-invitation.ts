import { pool } from "../db.js";
import { sendSystemEmailWithMetadata, type SendSystemEmailResult } from "../lib/system-email.js";
import { resolveFrontendUrl, TROCK_LOGO_EMAIL_URL } from "./project-number-email.js";
import { resolveRfpVoterEmails } from "@trock-crm/shared/lib/rfpVoterEmails";
import { escapeHtml, normalizeText } from "../lib/email-format.js";

export const RFP_VOTE_INVITATION_JOB = "rfp_vote_invitation";

/** SyncHub-style project context snapshotted into the invitation payload at round-open (best-effort). */
export interface RfpVoteInvitationDealSummary {
  projectTypeLabel?: string | null;
  projectNumber?: string | null; // FORMATTED (canonical) — never the raw HubSpot id
  amount?: number | null;
  companyName?: string | null;
  location?: string | null;
  estimator?: string | null;
  ownerName?: string | null;
  description?: string | null;
  dueDate?: string | null; // ISO
}

interface RfpVoteInvitationPayload {
  dealId?: string;
  dealNumber?: string | null;
  dealName?: string | null;
  officeId?: string | null;
  roundEventId?: string | null;
  // Server-resolved authoritative voter set (finding H5); present on jobs enqueued after that change.
  recipients?: unknown;
  // SyncHub-style project context (present on jobs enqueued after the rich-email change); absent on legacy jobs,
  // in which case the email degrades to the minimal deal-name + project-number layout.
  dealSummary?: RfpVoteInvitationDealSummary;
}

interface HandlerDeps {
  sendEmail?: (
    to: string | string[],
    subject: string,
    html: string,
    options: { text: string; idempotencyKey: string }
  ) => Promise<SendSystemEmailResult>;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Email the three designated RFP voters (RFP_VOTER_EMAILS = Sidney/Tim/James) a focused /rfp-vote/:dealId
 * link when a non-service RFP vote round opens. Enqueued by openRfpVoteRound -> enqueueRfpVoteInvitation.
 * Fails loudly (throw -> retry -> dead-letter) if RFP_VOTER_EMAILS is unset, mirroring rfp-rejection-email.
 */
export async function handleRfpVoteInvitation(
  payload: RfpVoteInvitationPayload,
  _officeId: string | null,
  deps: HandlerDeps = {},
): Promise<void> {
  const logger = deps.logger ?? console;
  const env = deps.env ?? process.env;
  const dealId = normalizeText(payload.dealId);
  if (!dealId) {
    logger.warn("[RfpVoteInvitation] Invalid job payload (missing dealId) - skipping");
    return;
  }

  // Prefer the SERVER-resolved recipient set snapshotted into the payload (finding H5): the server gated the
  // round on its own RFP_VOTER_EMAILS (the exact authorized trio), so emailing that list is authoritative even
  // if THIS worker's env is stale/incomplete. Fall back to the worker's env only for legacy jobs (no snapshot).
  const payloadRecipients = Array.isArray(payload.recipients)
    ? (payload.recipients as unknown[]).filter((r): r is string => typeof r === "string" && r.trim().length > 0).map((r) => r.trim())
    : [];
  const recipients = payloadRecipients.length > 0 ? payloadRecipients : resolveRfpVoterEmails(env);
  if (recipients.length === 0) {
    const error = new Error("RFP_VOTER_EMAILS is not configured");
    logger.error(
      "[RfpVoteInvitation] RFP_VOTER_EMAILS is not set - cannot send vote invitations. Set it (comma-separated) on the worker service; the job retries then dead-letters.",
      { dealId },
    );
    throw error;
  }

  const officeId = normalizeText(payload.officeId);
  const roundEventId = normalizeText(payload.roundEventId);
  const email = buildRfpVoteInvitationEmail({
    dealId,
    dealName: normalizeText(payload.dealName) ?? "Deal",
    dealNumber: normalizeText(payload.dealNumber),
    officeId,
    frontendUrl: resolveFrontendUrl(env),
    dealSummary: payload.dealSummary,
  });

  const recipientCount = recipients.length;
  const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;
  try {
    const sendResult = await sendEmail(recipients, email.subject, email.html, {
      text: email.text,
      idempotencyKey: `rfp-vote-invite-${dealId}-${roundEventId ?? "noroundid"}`,
    });
    if (!sendResult.success) {
      throw new Error("Email provider returned unsuccessful result");
    }
    logger.log("[RfpVoteInvitation] Sent vote invitations", {
      dealId,
      recipientCount,
      messageId: sendResult.messageId,
    });
  } catch (error) {
    logger.error("[RfpVoteInvitation] Failed to send vote invitations", { dealId, recipientCount, error });
    throw error;
  }
}

function fmtInvitationAmount(amount: number | null | undefined): string {
  return typeof amount === "number" && Number.isFinite(amount) ? `$${amount.toLocaleString("en-US")}` : "—";
}

function fmtInvitationDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" })
    : "—";
}

export function buildRfpVoteInvitationEmail(input: {
  dealId: string;
  dealName: string;
  dealNumber: string | null;
  officeId?: string | null;
  frontendUrl: string;
  dealSummary?: RfpVoteInvitationDealSummary;
}) {
  const officeParam = input.officeId ? `?officeId=${encodeURIComponent(input.officeId)}` : "";
  const baseUrl = input.frontendUrl.replace(/\/+$/, "");
  const voteUrl = `${baseUrl}/rfp-vote/${encodeURIComponent(input.dealId)}${officeParam}`;
  const safeVoteUrl = escapeHtml(voteUrl);

  // Prefer the FORMATTED project number (canonical) from the summary over the raw payload dealNumber (which is the
  // HubSpot id for HubSpot-imported deals).
  const displayNumber = input.dealSummary?.projectNumber ?? input.dealNumber;
  const subject = displayNumber
    ? `RFP vote needed: ${displayNumber} (${input.dealName})`
    : `RFP vote needed: ${input.dealName}`;
  const text = `An RFP needs your vote (approve or reject). Two of three votes decide; a reject needs a written reason. Open ${voteUrl} to cast your vote.`;

  const s = input.dealSummary;
  // Rich SyncHub-style context when the summary is present; else the legacy minimal 2-row layout (older jobs).
  const rows: Array<readonly [string, string]> = s
    ? [
        ["Deal name", input.dealName],
        ["Project type", s.projectTypeLabel || "—"],
        ["Project number", displayNumber ?? "Pending"],
        ["Amount", fmtInvitationAmount(s.amount)],
        ["Company", s.companyName || "—"],
        ["Location", s.location || "—"],
        ["Estimator", s.estimator || "—"],
        ["Deal owner", s.ownerName || "—"],
        ["Bid due", fmtInvitationDate(s.dueDate)],
        ["Description", s.description || "—"],
      ]
    : [
        ["Deal name", input.dealName],
        ["Project number", displayNumber ?? "Pending"],
      ];
  const htmlRows = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;vertical-align:top;width:150px;">${escapeHtml(label)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;vertical-align:top;">${escapeHtml(value)}</td>
        </tr>`,
    )
    .join("");

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>RFP Vote Needed</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;">
          <tr><td style="background-color:#CC0000;height:4px;line-height:4px;font-size:4px;mso-line-height-rule:exactly;">&nbsp;</td></tr>
          <tr><td align="center" style="padding:28px 24px 8px 24px;"><img src="${TROCK_LOGO_EMAIL_URL}" alt="T Rock Construction" width="220" height="246" style="display:block;width:220px;height:246px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" /></td></tr>
          <tr><td align="center" style="padding:4px 24px 0 24px;"><h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">RFP Vote Needed</h1></td></tr>
          <tr><td align="center" style="padding:6px 24px 16px 24px;"><p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;">You are one of three RFP voters. Approve or reject this RFP — two of three votes decide. A reject requires a written reason.</p></td></tr>
          <tr><td style="padding:0 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid #e2e8f0;">${htmlRows}</table></td></tr>
          <tr><td align="center" style="padding:24px 24px 8px 24px;">
            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeVoteUrl}" style="height:44px;v-text-anchor:middle;width:240px;" arcsize="9%" stroke="f" fillcolor="#CC0000"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">Cast your vote</center></v:roundrect>
            <![endif]-->
            <!--[if !mso]><!-- -->
            <a href="${safeVoteUrl}" style="display:inline-block;background-color:#CC0000;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:44px;text-align:center;text-decoration:none;width:240px;border-radius:4px;">Cast your vote</a>
            <!--<![endif]-->
          </td></tr>
          <tr><td align="center" style="padding:0 24px 24px 24px;"><p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;">Votes are final once cast. Live progress is shown on the deal.</p></td></tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html, text, dealNumber: displayNumber };
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
type PoolLike = Queryable & { connect?: () => Promise<Queryable & { release: () => void }> };

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function resolveOfficeSchema(db: Queryable, officeId: string | null): Promise<string> {
  if (!officeId) throw new Error("rfp_vote_invitation dead-letter sweep is missing officeId");
  // requireActive:false — a dead job for a since-deactivated office still needs its deal surfaced.
  const result = await db.query(`SELECT slug FROM public.offices WHERE id = $1`, [officeId]);
  const slug = result.rows[0]?.slug;
  if (typeof slug !== "string" || !/^[a-z][a-z0-9_]*$/.test(slug)) {
    throw new Error(`Unable to resolve office schema for officeId=${officeId}`);
  }
  return `office_${slug}`;
}

/**
 * Dead-letter backstop for rfp_vote_invitation (finding F7). openRfpVoteRound reserves the deal ('pending') then
 * enqueues this email job; if it exhausts maxAttempts (worker lacks RFP_VOTER_EMAILS, provider down, ...) the
 * round is open but nobody was invited — and 'pending' is NOT a cancellable attention state, so the deal strands
 * with no recovery. This sweep surfaces the failure as the VISIBLE, cancellable send_failed state (the same
 * Pending-RFP attention status pendingRfpSubStateForStatus renders + cancel-rfp allows Returning to Opportunity),
 * so the rep can recover the deal and re-trigger. Guarded (finding H6) so it only touches a still-open,
 * request-less round for THIS job's round event (finding Y10) that has NOT YET reached the 2-of-3 decision
 * threshold (<2 approvals AND <2 rejections) — a single cast vote does NOT prove the invitations reached the
 * other voters, so a one-vote, undecided round is still surfaced; only an already-decided round is left alone.
 * Claim is single-transaction (mirrors runRfpBidBoardCreateDeadLetterSweep): the per-row 'claimed' marker is
 * written in the SAME txn as the deal update, so a throw leaves the row unclaimed + retryable.
 */
export async function runRfpVoteInvitationDeadLetterSweep(
  deps: { db?: PoolLike; limit?: number } = {}
): Promise<number> {
  const db = deps.db ?? pool;
  const limit = deps.limit ?? 25;
  const client: Queryable & { release?: () => void } = db.connect ? await db.connect() : db;
  let handled = 0;
  try {
    const result = await client.query(
      `SELECT id, payload, office_id, last_error
         FROM public.job_queue
        WHERE status = 'dead'
          AND job_type = 'rfp_vote_invitation'
          AND (payload->>'dealHandled' IS NULL OR payload->>'dealHandled' IN ('false', 'claimed'))
        ORDER BY id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit]
    );

    for (const job of result.rows) {
      try {
        await client.query("BEGIN");
        const locked = await client.query(
          `SELECT id FROM public.job_queue
            WHERE id = $1 AND status = 'dead'
              AND (payload->>'dealHandled' IS NULL OR payload->>'dealHandled' IN ('false', 'claimed'))
            FOR UPDATE SKIP LOCKED`,
          [job.id]
        );
        if (locked.rows.length === 0) { await client.query("ROLLBACK"); continue; }
        await client.query(
          "UPDATE public.job_queue SET payload = jsonb_set(payload, '{dealHandled}', '\"claimed\"'::jsonb, true) WHERE id = $1",
          [job.id]
        );

        const payload = job.payload as { dealId?: string; roundEventId?: string | null };
        if (!payload?.dealId) {
          await client.query(
            "UPDATE public.job_queue SET payload = jsonb_set(payload, '{dealHandled}', 'true'::jsonb, true) WHERE id = $1",
            [job.id]
          );
          await client.query("COMMIT");
          continue;
        }

        const schemaName = await resolveOfficeSchema(client, job.office_id);
        const lastError = String(job.last_error ?? "RFP vote invitations could not be sent").slice(0, 2000);
        await client.query(
          `UPDATE ${quoteIdent(schemaName)}.deals
              SET rfp_approval_status = 'send_failed',
                  rfp_last_attempt_error = $1,
                  updated_at = NOW()
            WHERE id = $2
              -- still an open, request-less (voting) round the invitation was for
              AND rfp_approval_status = 'pending'
              AND rfp_approval_request_id IS NULL
              -- Surface the failure until the round is actually DECIDED (finding H6). A single cast vote does NOT
              -- mean the invitations were delivered — the OTHER voters may never have been notified, so a one-vote
              -- round would otherwise sit pending forever, uncancellable. Only a round that already reached the
              -- 2-of-3 threshold (>=2 approvals OR >=2 rejections) is left alone; anything short of that is
              -- surfaced as send_failed so the rep can recover. (Threshold mirrors DEFAULT_VOTE_THRESHOLD=2.)
              AND (
                SELECT COUNT(*) FILTER (WHERE v.decision = 'approve') < 2
                   AND COUNT(*) FILTER (WHERE v.decision = 'reject') < 2
                  FROM ${quoteIdent(schemaName)}.rfp_votes v
                 WHERE v.deal_id = $2
                   AND v.round_event_id = (
                     SELECT d2.rfp_approval_request_event_id FROM ${quoteIdent(schemaName)}.deals d2 WHERE d2.id = $2
                   )
              )
              -- finding Y10: only surface the failure for the round THIS job was for. If the deal was returned to
              -- Opportunity and a FRESH round opened, an old dead invitation must not mark the new (successfully
              -- invited) round send_failed. Match the job's roundEventId to the deal's current event id.
              AND rfp_approval_request_event_id = $3::uuid
              AND rfp_last_attempt_error IS DISTINCT FROM $1`,
          [lastError, payload.dealId, payload.roundEventId ?? null]
        );
        await client.query(
          "UPDATE public.job_queue SET payload = jsonb_set(payload, '{dealHandled}', 'true'::jsonb, true) WHERE id = $1",
          [job.id]
        );
        await client.query("COMMIT");
        handled += 1;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`[Worker:rfp_vote_invitation] Failed to handle dead invitation job ${job.id}`, err);
      }
    }
    return handled;
  } finally {
    if ("release" in client && typeof client.release === "function") client.release();
  }
}
