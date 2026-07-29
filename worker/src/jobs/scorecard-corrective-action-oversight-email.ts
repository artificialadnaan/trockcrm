import { pool } from "../db.js";
import {
  sendSystemEmailWithMetadata,
  type SendSystemEmailAttachment,
} from "../lib/system-email.js";
import { getObjectBuffer } from "../lib/r2-client.js";
import { escapeHtml, normalizeText, isSafeTenantSchema } from "../lib/email-format.js";
import { resolveFrontendUrl, TROCK_LOGO_EMAIL_URL } from "./project-number-email.js";
import { resolveFieldScorecardRecipients } from "@trock-crm/shared/lib/fieldScorecardEmails";
import { resolveCorrectiveActionApprovers } from "@trock-crm/shared/lib/correctiveActionApprovers";
import { orderCorrectiveActions } from "@trock-crm/shared/lib/correctiveActionOrder";
import {
  BROWSABLE_PROJECT_SQL,
  LOST_EXCLUDED_SLUGS,
  WON_BROWSABLE_SLUGS,
  basicValidEmail,
  recipientResolutionSql,
} from "./scorecard-corrective-action-email.js";

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
 * Renderer revision that embeds the corrective-action THREAD. v3 carried a two-state open/resolved record;
 * v4 carries the full back-and-forth, which is what an approval-era notice is announcing.
 *
 * Attaching an older artifact would show the card WITHOUT the thread — an "Approved" email whose PDF does
 * not show the approval, which is the same defect this whole line of work exists to fix. A pre-v4 artifact
 * is dropped in favour of the CRM link rather than sent as if it were the record.
 */
const MIN_PDF_RENDER_VERSION_WITH_CORRECTIVE_ACTIONS = 4;

// Mirrors field-scorecard-email: Resend warns around 28 MB and base64 inflates a binary attachment by ~33%,
// so keep the raw PDF under ~20 MB. A larger PDF is delivered as a CRM link instead.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

// The business timezone every reader of this email is in. Must match the server's canonical BUSINESS_TIMEZONE
// (server/src/lib/period.ts) so a response time reads identically in the email and in the attached PDF; the
// worker cannot import from the server package, and it already hardcodes this same zone for its cron schedules.
const OVERSIGHT_EMAIL_TIMEZONE = "America/Chicago";

/**
 * How each ITEM state reads in the notice, matching the PDF and the CRM so the three cannot disagree.
 *
 * This used to test `status === "resolved"`, a value migration 0202 RENAMED to `submitted`. Nothing errored:
 * the comparison simply never matched, so every item rendered as "Open" with no responder, no comment and no
 * photo count — stripping the approval notice of exactly the information the approver needs to decide.
 */
const ITEM_STATE_LABEL: Record<string, { label: string; color: string; answered: boolean }> = {
  open: { label: "Open", color: "#CC0000", answered: false },
  // Distinct from `open`: it was answered and sent back, and the responder needs to see that difference.
  rejected: { label: "Sent back", color: "#CC0000", answered: true },
  submitted: { label: "Awaiting approval", color: "#D97706", answered: true },
  approved: { label: "Approved", color: "#16a34a", answered: true },
};

function itemState(status: string): { label: string; color: string; answered: boolean } {
  return ITEM_STATE_LABEL[status] ?? ITEM_STATE_LABEL.open;
}

// Bound each response comment quoted in the email body. The response API accepts up to 5,000 characters per
// item and a card can carry 50 action items plus deficiencies, so quoting every comment in full can produce
// hundreds of kilobytes of body — before HTML escaping expands it further. Mail clients clip long bodies,
// and what gets clipped is the end: the CTA. The PDF renderer already bounds the same text; this is the
// email's equivalent, with the full text one click away in the CRM.
const MAX_EMAIL_COMMENT_CHARS = 280;
const MAX_EMAIL_LABEL_CHARS = 160;

/**
 * The item LABEL is bounded for exactly the same reason as the comment: submission and edit parsing cap the
 * NUMBER of action items (50), never each item's length, so a handful of long dictated labels produce an
 * arbitrarily large body on their own. Bounding only the comments fixed half the problem.
 *
 * Shorter than the comment allowance because a label is a heading — enough to identify the item, with the
 * full text one click away in the CRM.
 */
function emailLabelExcerpt(label: string | null | undefined): string {
  const text = normalizeText(label) ?? "(untitled item)";
  if (text.length <= MAX_EMAIL_LABEL_CHARS) return text;
  return `${text.slice(0, MAX_EMAIL_LABEL_CHARS).trimEnd()}…`;
}

/** Quote a comment for an email body, bounded, with an explicit marker that it was shortened. */
function emailCommentExcerpt(comment: string | null | undefined): string | null {
  const text = normalizeText(comment);
  if (!text) return null;
  if (text.length <= MAX_EMAIL_COMMENT_CHARS) return text;
  return `${text.slice(0, MAX_EMAIL_COMMENT_CHARS).trimEnd()}… (full comment in the CRM)`;
}

/**
 * True only for the immutable `${scorecardId}.${sha256}.v${version}.pdf` shape the artifact publisher emits.
 * Mirrors the identical guard in field-scorecard-email.ts — the two scorecard email jobs must agree on what
 * counts as a current artifact.
 */
function isCurrentScorecardPdfArtifactKey(r2Key: string, renderVersion: number): boolean {
  if (!Number.isInteger(renderVersion) || renderVersion < MIN_PDF_RENDER_VERSION_WITH_CORRECTIVE_ACTIONS) {
    return false;
  }
  return new RegExp(`\\.[a-f0-9]{64}\\.v${renderVersion}\\.pdf$`).test(r2Key);
}

export type CorrectiveActionOversightPhase = "opened" | "closed" | "awaiting_approval";

const VALID_PHASES: readonly CorrectiveActionOversightPhase[] = ["opened", "closed", "awaiting_approval"];

export interface ScorecardCorrectiveActionOversightEmailPayload {
  tenantSchema?: string;
  scorecardId?: string;
  dealId?: string;
  officeId?: string | null;
  phase?: CorrectiveActionOversightPhase;
  /**
   * The cycle nonce active at enqueue. Two uses, deliberately asymmetric: it is the Resend idempotency-key
   * dimension (so a genuine reopen sends again while a queue retry does not), and it scopes the delivery
   * STAMP to the cycle this job describes. It is never consulted by the already-notified SKIP check — see
   * the dedup note in the handler for why those two need different rules.
   */
  cycleNonce?: string;
  /**
   * The INDEPENDENT oversight supersession marker current at enqueue (migration 0201). Checked BEFORE
   * sending: unlike cycleNonce, this rotates only where a genuinely new corrective-action cycle begins, so a
   * mismatch unambiguously means "a reopen superseded me" rather than "the responder job repaired itself".
   */
  oversightCycle?: string;
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
  if (phase === "opened") return "corrective_action_oversight_opened_at";
  // Its OWN column: reusing either oversight stamp would make an approval request suppress the opened or the
  // completion notice for the same cycle.
  if (phase === "awaiting_approval") return "corrective_action_approval_requested_at";
  return "corrective_action_oversight_closed_at";
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
  /** The CURRENT action-item list — what the corrective-action rows must be ordered against. */
  action_items: string[] | null;
  /** The stored deficiency keys, in the order the card body renders them. */
  critical_deficiencies: string[] | null;
  pdf_r2_key: string | null;
  pdf_render_version: number | null;
  /** The scorecard updated_at the stored PDF was rendered from (migration 0200); null pre-migration. */
  pdf_content_generation: Date | string | null;
  updated_at: Date | string | null;
  corrective_action_cycle_nonce: string | null;
  corrective_action_oversight_cycle: string | null;
  corrective_action_oversight_opened_at: Date | null;
  corrective_action_oversight_closed_at: Date | null;
  corrective_action_approval_requested_at: Date | null;
}

interface ItemRow {
  item_type: string;
  item_ref: string;
  item_label: string;
  status: string;
  responder_name: string | null;
  responder_email: string | null;
  responded_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  response_comment: string | null;
  photo_count: number | string;
}

/**
 * The oversight email's per-item read, exported so its SQL can be EXERCISED rather than string-matched.
 *
 * The worker's tests mock `query` by matching on substrings, which cannot tell a correct query from one that
 * merely contains the right words — and this one carries the arithmetic the approver reads. Sharing the exact
 * string with a runtime test that runs it on Postgres is what makes the counts verifiable; a test that
 * re-typed the query would only prove the copy in the test file is right.
 */
export function correctiveActionItemsSql(tenantSchema: string): string {
  return `SELECT ca.item_type, ca.item_ref, ca.item_label, ca.status, ca.responder_name,
            -- A session responder with no first/last name stores a null responder_name but a non-null
            -- email. Without this the notice reports WHEN a fix landed but not WHO filed it.
            ca.responder_email, ca.responded_at,
            ca.response_comment,
            -- WHO signed this off, and when. The item row's responder columns describe the SUBMISSION; using
            -- them for an approved item makes the audit notice read "Approved — <responder> · <their
            -- submission time>", i.e. as though the responder approved their own work. The verdict lives on
            -- the thread. Ordered by seq, not created_at: events written in one transaction share a
            -- timestamp and the uuid PK is random.
            -- name OR email, same rule the responder attribution uses: an approver with no display name
            -- must still be identifiable, or the audit notice says an approval happened and not by whom.
            (SELECT COALESCE(e.actor_name, e.actor_email)
               FROM ${tenantSchema}.scorecard_corrective_action_events e
              WHERE e.corrective_action_id = ca.id AND e.event_type = 'approved'
              ORDER BY e.seq DESC LIMIT 1) AS approved_by,
            (SELECT e.created_at FROM ${tenantSchema}.scorecard_corrective_action_events e
              WHERE e.corrective_action_id = ca.id AND e.event_type = 'approved'
              ORDER BY e.seq DESC LIMIT 1) AS approved_at,
            -- Count only photos that are ACTUALLY renderable. Both other surfaces for this data apply the
            -- same filter (the PDF loader and the CRM item read), so counting soft-deleted rows here would
            -- have the email say "3 photos" while the attached PDF and the CRM both show 2.
            --
            -- ...and only the photos filed with the ATTEMPT this row describes. response_comment, responder
            -- and responded_at all come from the latest submission, so an item-wide count put the newest
            -- comment beside every photo the item ever collected: three from a rejected attempt plus one
            -- rework photo read as "4 photos" attached to a one-photo response. The approver is deciding
            -- whether the evidence supports the fix, so an inflated count argues for approval.
            (SELECT COUNT(*)
               FROM ${tenantSchema}.field_scorecard_photos p
               JOIN ${tenantSchema}.files f ON f.id = p.file_id
              WHERE p.corrective_action_id = ca.id
                AND f.is_active = TRUE
                AND f.deleted_at IS NULL
                -- No thread (a pre-0202 card, or photos predating the event backfill) means the item-wide
                -- set IS this attempt's set; with a thread, only what was filed WITH this attempt counts.
                AND (latest_submission.id IS NULL
                     OR p.corrective_action_event_id = latest_submission.id)) AS photo_count
       FROM ${tenantSchema}.scorecard_corrective_actions ca
       LEFT JOIN LATERAL (
              SELECT e.id
                FROM ${tenantSchema}.scorecard_corrective_action_events e
               WHERE e.corrective_action_id = ca.id AND e.event_type = 'submitted'
               ORDER BY e.seq DESC
               LIMIT 1
            ) latest_submission ON TRUE
      WHERE ca.scorecard_id = $1::uuid`;
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
  if (!isSafeTenantSchema(tenantSchema) || !scorecardId || !phase || !VALID_PHASES.includes(phase)) {
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
  // Gate on the ACTIVE + BROWSABLE record, exactly as the responder job does. This job runs ~120s after
  // enqueue, and in that window the scorecard can be soft-deleted or its deal archived / moved to Lost —
  // none of which changes the corrective-action lifecycle status, so a status-only guard would still send an
  // oversight notice whose CRM link 404s. A miss is triaged by handleIneligibleScorecard, which distinguishes
  // a deleted card (complete) from a merely-hidden project (retry) — the two are NOT interchangeable, because
  // nothing re-enqueues this job when a deal is restored.
  //
  // BROWSABLE_PROJECT_SQL authors its placeholders as $1/$2; here they occupy $2/$3 after $1 = scorecardId.
  // Renumber in a SINGLE atomic pass — a chained replace would CASCADE $1→$2→$3 and collapse both slug
  // arrays onto $3. (The responder job documents this trap at length; same fragment, same hazard.)
  const scorecardResult = await query(
    `SELECT sc.deal_id, sc.project_number, sc.week_of, sc.total_score, sc.average_score, sc.rating,
            sc.form_version, sc.status, sc.action_items, sc.critical_deficiencies,
            sc.pdf_r2_key, sc.pdf_render_version,
            sc.pdf_content_generation, sc.updated_at,
            sc.corrective_action_oversight_opened_at, sc.corrective_action_oversight_closed_at,
            sc.corrective_action_approval_requested_at,
            sc.corrective_action_cycle_nonce, sc.corrective_action_oversight_cycle,
            d.name AS deal_name
       FROM ${tenantSchema}.field_scorecards sc
       JOIN ${tenantSchema}.deals d ON d.id = sc.deal_id
       LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE sc.id = $1::uuid
        AND sc.is_active = true
        AND ${BROWSABLE_PROJECT_SQL.replace(/\$(\d+)/g, (_m, n) => "$" + (Number(n) + 1))}
      LIMIT 1`,
    [scorecardId, WON_BROWSABLE_SLUGS, LOST_EXCLUDED_SLUGS],
  );
  const scorecard = scorecardResult.rows[0] as ScorecardRow | undefined;
  if (!scorecard) {
    await handleIneligibleScorecard(query, tenantSchema, scorecardId, phase, logger, "before preparing");
    return;
  }

  const alreadySent =
    phase === "opened"
      ? scorecard.corrective_action_oversight_opened_at
      : phase === "awaiting_approval"
        ? scorecard.corrective_action_approval_requested_at
        : scorecard.corrective_action_oversight_closed_at;
  if (alreadySent) {
    logger.log("[CorrectiveActionOversightEmail] Already notified for this cycle - skipping", {
      scorecardId,
      phase,
    });
    return;
  }

  // SEND-TIME STATE GUARD, mirroring the responder job. Both jobs run ~120s after enqueue, and the card can
  // move within that window:
  //   - an edit lifting it above band walks it to `submitted` and deletes every item, so an unguarded
  //     `opened` job would announce a corrective action that no longer exists;
  //   - a single-item corrective action answered in-app closes the card, so an unguarded `opened` job would
  //     announce it as open while listing every item Resolved, immediately followed by the completed notice.
  // Return WITHOUT sending and WITHOUT stamping: the stamp stays available for a genuinely matching state,
  // and a real reopen clears it anyway.
  // PRE-SEND SUPERSESSION CHECK. Retiring queued jobs at the reopen covers the common case, but a job the
  // worker had already CLAIMED is past that point — and the delivery stamp guard blocks only the stamp, never
  // the send, so without this a claimed cycle-A job still delivers a duplicate notice for cycle B.
  //
  // This gates on the dedicated oversight marker, NOT the shared cycle nonce. The nonce is also rotated by the
  // responder worker's self-repair, which does not start a new cycle and enqueues no oversight job — gating on
  // it would strand the notice entirely. Only compare when both sides are present, so pre-0201 rows and any
  // in-flight job minted before this deploy keep the prior behaviour.
  const payloadOversightCycle = normalizeText(payload.oversightCycle);
  const storedOversightCycle = normalizeText(scorecard.corrective_action_oversight_cycle);

  // The APPROVAL REQUEST supersedes on the REVIEW cycle, not the oversight marker.
  //
  // A rejection rotates corrective_action_cycle_nonce and deliberately leaves the oversight marker alone
  // (the corrective action never re-opened from oversight's point of view). So an awaiting-approval job that
  // sent but crashed before stamping would, on retry after a reject-and-resubmit, pass every marker-scoped
  // check, reuse the already-delivered provider key, read Resend's idempotent response as success, and stamp
  // the NEW round — whose own job then skips. The approver never hears about the rework.
  if (phase === "awaiting_approval") {
    const payloadReviewCycle = normalizeText(payload.cycleNonce);
    const storedReviewCycle = normalizeText(scorecard.corrective_action_cycle_nonce);
    if (payloadReviewCycle && storedReviewCycle && payloadReviewCycle !== storedReviewCycle) {
      logger.log(
        "[CorrectiveActionOversightEmail] Approval request superseded by a newer review round - skipping",
        { scorecardId, payloadReviewCycle, storedReviewCycle },
      );
      return;
    }
  }

  if (payloadOversightCycle && storedOversightCycle && payloadOversightCycle !== storedOversightCycle) {
    logger.log(
      "[CorrectiveActionOversightEmail] Superseded by a newer corrective-action cycle - skipping (no send, no stamp)",
      { scorecardId, phase, payloadOversightCycle, storedOversightCycle },
    );
    return;
  }

  const expectedStatus =
    phase === "opened"
      ? "corrective_action_open"
      : phase === "awaiting_approval"
        ? "corrective_action_submitted"
        : "corrective_action_closed";
  if (scorecard.status !== expectedStatus) {
    logger.log(
      "[CorrectiveActionOversightEmail] Scorecard is no longer in the state this notice describes - skipping (no send, no stamp)",
      { scorecardId, phase, expectedStatus, actualStatus: scorecard.status },
    );
    return;
  }

  // Oversight recipients MINUS the cycle's responders: a superintendent who is also on the env list should
  // get "please fix this", not additionally "someone needs to fix this" for the same card.
  // WHO to tell depends on the question. opened/closed INFORM the watchers
  // (FIELD_SCORECARD_EMAIL_RECIPIENTS); awaiting_approval ASKS the people who can act
  // (QC_APPROVER_EMAILS) — the same config the API authorizes the verb against, so the set notified and the
  // set able to act are one definition and cannot drift into asking someone who will only get a 403.
  const configured =
    phase === "awaiting_approval"
      ? resolveCorrectiveActionApprovers(env)
      : resolveFieldScorecardRecipients(env);
  const responderResult = await query(recipientResolutionSql(tenantSchema), [
    scorecard.deal_id,
    scorecardId,
  ]);
  const responderRows = responderResult.rows as Array<{
    email: string | null;
    name: string | null;
    role: string | null;
  }>;
  const responderEmails = new Set(
    responderRows
      .map((row) => normalizeText(row.email)?.toLowerCase())
      .filter((email): email is string => !!email),
  );
  // The opened notice names WHO was asked to respond — that context is the point of the notice, and
  // recipientResolutionSql already returns role and name. Names only: never their tokens or links.
  //
  // Only responders with a DELIVERABLE email are named. The resolution query still returns a row whose email
  // is missing or malformed, but the responder handler skips exactly those — so naming them here would tell
  // oversight that someone "has been asked" when no email ever reached them. False assurance on a QC gate is
  // worse than saying less. Same validation the responder handler applies.
  const responders = responderRows
    .filter((row) => {
      const email = normalizeText(row.email);
      return !!email && basicValidEmail(email);
    })
    .map((row) => ({
      name: normalizeText(row.name) ?? normalizeText(row.email),
      role: normalizeText(row.role),
    }))
    .filter((r): r is { name: string; role: string | null } => !!r.name);
  // Subtract the responders ONLY for the opened notice. The rationale for excluding them — "they already
  // get the 'please fix this' email, so don't also tell them someone needs to fix it" — is specific to that
  // phase. There is NO responder-facing completion job, so applying the same subtraction to `closed` means a
  // watcher who happens to be a current super/PM silently never receives the completion notice, and they may
  // not even be the person who submitted the final response.
  const recipients = dedupe(
    phase === "opened"
      ? configured.filter((email) => !responderEmails.has(email.trim().toLowerCase()))
      : configured,
  );
  if (recipients.length === 0) {
    logger.warn(
      "[CorrectiveActionOversightEmail] No oversight recipients after excluding responders - skipping (not an error: the responders were notified by their own job)",
      { scorecardId, phase, configuredCount: configured.length },
    );
    return;
  }

  const itemsResult = await query(correctiveActionItemsSql(tenantSchema), [scorecardId]);
  // Ordered against the CURRENT action-item list, NOT item_ref. Reconciliation preserves an action item's
  // original ref across edits, so ref order is the OLD order after a reorder — and this email sits beside the
  // PDF it attaches and the deal thread it links to. All three rank through orderCorrectiveActions.
  const items = orderCorrectiveActions(
    (itemsResult.rows as ItemRow[]).map((row) => ({
      ...row,
      itemType: row.item_type,
      itemRef: row.item_ref,
      itemLabel: row.item_label,
    })),
    scorecard.action_items ?? [],
    scorecard.critical_deficiencies ?? [],
  );

  // The completed notice carries the refreshed PDF — which is only meaningful from v3, the revision that
  // first embedded the corrective-action record. Best-effort: a missing or oversized object degrades to a
  // no-attachment send rather than blocking the notification.
  let attachments: SendSystemEmailAttachment[] | undefined;
  // BOTH review-facing notices carry the artifact. The approver is being asked to judge documented work, so
  // sending them a link and no record forces them into the CRM to see the very thing the email is about —
  // and the enqueue path already delays specifically so the refreshed PDF exists by the time this runs.
  // The currency and version checks inside loadPdfAttachment still apply: a stale or pre-v4 artifact is
  // dropped in favour of the link rather than sent as if it were the record.
  if (phase === "closed" || phase === "awaiting_approval") {
    attachments = await loadPdfAttachment(scorecard, scorecardId, tenantSchema, query, deps, logger);
  }

  const email = buildOversightEmail({
    phase,
    dealName: scorecard.deal_name ?? "Project",
    projectNumber: normalizeText(scorecard.project_number) ?? null,
    weekOf: formatWeekOf(scorecard.week_of),
    scoreText: formatScore(scorecard),
    items,
    responders,
    // Carry the OWNING office: the client derives its x-office-id routing header from this query param, so
    // without it a watcher whose active office differs from the scorecard's follows the CTA into the wrong
    // tenant and gets a 404. Matches how the other cross-office worker emails build their links.
    link: buildScorecardLink(env, scorecard.deal_id, payload.officeId),
  });

  // The raw payload nonce (null when absent) drives the stamp guard; the "none" fallback is only ever the
  // Resend key's dimension, never a value compared against a uuid column.
  const cycleNonceValue = normalizeText(payload.cycleNonce) ?? null;
  const cycleDimension = cycleNonceValue ?? "none";
  // FINAL PRE-DELIVERY REVALIDATION. The check after the snapshot is a TOCTOU guard: the recipient and item
  // queries — and, for a completed notice, the R2 attachment fetch — leave a substantial window before the
  // send. A reopen landing in that window would otherwise still be delivered against, duplicating cycle B's
  // notice. Re-reading one column immediately before the send narrows the window to microseconds.
  //
  // This deliberately stays SEND-then-stamp rather than becoming a claim-then-send. Claiming first would
  // close the window completely but make a crash between claim and send lose the notification permanently
  // (the retry sees a stamped row and skips). For a notification, a rare duplicate is a better failure than
  // a silent miss, and the Resend idempotency key already dedups the crash-after-send retry.
  // Repeats the ACTIVE + BROWSABLE predicate as well as the marker/status/stamp. Eligibility can change
  // during preparation — the scorecard soft-deleted, or its deal archived or moved to Lost — without moving
  // the lifecycle status or the cycle marker at all, so a check that omitted it would still deliver a notice
  // whose CRM link 404s. A miss here is indistinguishable from the row being gone: no send, no stamp.
  const revalidated = await query(
    `SELECT sc.corrective_action_oversight_cycle, sc.status, sc.updated_at, sc.${column} AS phase_stamp
       FROM ${tenantSchema}.field_scorecards sc
       JOIN ${tenantSchema}.deals d ON d.id = sc.deal_id
       LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE sc.id = $1::uuid
        AND sc.is_active = true
        AND ${BROWSABLE_PROJECT_SQL.replace(/\$(\d+)/g, (_m, n) => "$" + (Number(n) + 1))}
      LIMIT 1`,
    [scorecardId, WON_BROWSABLE_SLUGS, LOST_EXCLUDED_SLUGS],
  );
  const current = revalidated.rows[0] as
    | {
        corrective_action_oversight_cycle: string | null;
        status: string | null;
        updated_at: Date | string | null;
        phase_stamp: Date | null;
      }
    | undefined;
  if (!current) {
    await handleIneligibleScorecard(query, tenantSchema, scorecardId, phase, logger, "before delivery");
    return;
  }
  if (current.phase_stamp) {
    logger.log("[CorrectiveActionOversightEmail] Another run notified this cycle first - skipping", {
      scorecardId,
      phase,
    });
    return;
  }
  const currentOversightCycle = normalizeText(current.corrective_action_oversight_cycle);
  if (payloadOversightCycle && currentOversightCycle && payloadOversightCycle !== currentOversightCycle) {
    logger.log(
      "[CorrectiveActionOversightEmail] Superseded while preparing the notice - skipping (no send, no stamp)",
      { scorecardId, phase, payloadOversightCycle, currentOversightCycle },
    );
    return;
  }
  // The marker alone does not cover ORDINARY transitions: the last item being answered moves the card
  // open -> submitted, and an edit can move it back, neither of which rotates the marker. Re-check the phase
  // status too, or an obsolete "Corrective Action Opened" can still go out for a card that just closed.
  if (current.status !== expectedStatus) {
    logger.log(
      "[CorrectiveActionOversightEmail] Card changed phase while preparing the notice - skipping (no send, no stamp)",
      { scorecardId, phase, expectedStatus, actualStatus: current.status },
    );
    return;
  }
  // The BODY is built from an item snapshot taken before the recipient/item queries and the R2 read. An edit
  // can remove a settled item in that window without moving the status or the marker, leaving the email
  // describing a responder, comment and photo count for something that no longer exists. The attachment guard
  // catches the PDF but cannot repair the prose, so compare the generation the snapshot was taken at.
  //
  // THROW rather than return. There is no "next cycle's job" to fall back on: the drift that reaches this
  // branch is usually an item being answered while other items remain open, which advances updated_at without
  // moving the status or rotating the marker — and therefore enqueues nothing. Completing here would leave the
  // only opened-notice job stamped null with no successor, losing the notification permanently. A retry
  // re-reads the card from scratch and rebuilds the body against the settled state, which is what this branch
  // actually wants; a card edited continuously past max_attempts dead-letters visibly.
  if (
    scorecard.updated_at != null &&
    current.updated_at != null &&
    new Date(scorecard.updated_at).getTime() !== new Date(current.updated_at).getTime()
  ) {
    logger.warn(
      "[CorrectiveActionOversightEmail] Scorecard changed while preparing the notice - throwing to retry against the settled state",
      { scorecardId, phase },
    );
    throw new Error(
      `[CorrectiveActionOversightEmail] Snapshot for ${scorecardId} (${phase}) went stale while preparing - retrying`,
    );
  }

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

  // The STAMP is cycle-aware even though the SKIP guard above deliberately is not. They answer different
  // questions and need different rules:
  //
  //   - "has oversight been told about this cycle?" (the skip) must NOT consult the nonce, because the
  //     responder worker's self-repair path rotates it without starting a new business cycle — gating there
  //     would strand a legitimately pending notice.
  //   - "does my send still describe the CURRENT cycle?" (this stamp) MUST consult it. Otherwise: cycle A's
  //     send is in flight, a reopen clears the stamp and mints nonce B, then A's worker stamps the row —
  //     and cycle B's queued job sees a non-null stamp and skips. Oversight is never told about the reopen,
  //     permanently, because nothing clears the stamp again until the NEXT reopen.
  //
  // Same clause shape the responder job uses (migration 0197): a NULL stored nonce (legacy row) or a job
  // carrying no payload nonce omits the comparison, preserving pre-guard behaviour.
  // A job that carries NO payload nonce came from a card whose stored nonce was null (pre-0197). It must
  // still assert the cycle has not moved: without a clause, a reopen that mints a nonce and clears the
  // stamps would be stamped by this stale job on id alone, and the new cycle's job would then skip.
  // Scope the stamp to the OVERSIGHT marker — the same signal the send decision used.
  //
  // It previously used the shared cycle nonce, which contradicted the send: when the responder worker's
  // self-repair rotates that nonce, this handler intentionally still sends (the oversight marker is
  // unchanged), but the stamp then matched no row. The job completed with the phase stamp permanently null
  // and nothing re-enqueued, so the durable dedup guard was defeated and a later requeue — once provider
  // idempotency expired — would resend the notice. The oversight marker distinguishes a real reopen while
  // staying stable across self-repair, so it is the correct scope for both decisions.
  const markerClause = payloadOversightCycle
    ? " AND (corrective_action_oversight_cycle IS NULL OR corrective_action_oversight_cycle = $2::uuid)"
    : " AND corrective_action_oversight_cycle IS NULL";
  const params: unknown[] = payloadOversightCycle ? [scorecardId, payloadOversightCycle] : [scorecardId];

  // ...and for the APPROVAL REQUEST, the review cycle too — the same scope its send decision used.
  //
  // The marker clause alone cannot carry this phase. A rejection rotates corrective_action_cycle_nonce and
  // deliberately leaves the oversight marker unchanged, so the marker comparison still passes for a cycle-A
  // worker that entered the provider call before the reject-and-resubmit. It would then stamp cycle B's
  // corrective_action_approval_requested_at, and cycle B's own job — seeing a non-null stamp — skips. The
  // approver is never told about the rework, permanently: nothing clears that stamp again.
  //
  // I scoped the SEND to the review cycle last round and left the STAMP on the marker, which is the same
  // defect one statement further down: a supersession check that does not also scope the write it guards is
  // only narrowing the window, not closing it.
  let reviewClause = "";
  if (phase === "awaiting_approval") {
    const payloadReviewCycle = normalizeText(payload.cycleNonce);
    if (payloadReviewCycle) {
      params.push(payloadReviewCycle);
      reviewClause = ` AND (corrective_action_cycle_nonce IS NULL OR corrective_action_cycle_nonce = $${params.length}::uuid)`;
    } else {
      // No payload nonce means the card had none when this job was minted (pre-0197). It must still assert
      // the round has not moved, exactly as the marker clause does for the same case.
      reviewClause = " AND corrective_action_cycle_nonce IS NULL";
    }
  }

  const stamped = await query(
    `UPDATE ${tenantSchema}.field_scorecards
        SET ${column} = NOW()
      WHERE id = $1::uuid
        AND ${column} IS NULL${markerClause}${reviewClause}`,
    params,
  );
  if (!stamped.rowCount) {
    // Superseded mid-send. The email went out describing the older cycle, which is accurate for what it
    // said; the CURRENT cycle's own job still has a null stamp and will notify.
    logger.warn(
      "[CorrectiveActionOversightEmail] Sent but not stamped - the cycle moved on mid-send; the current cycle's job will notify",
      { scorecardId, phase, payloadCycleNonce: cycleNonceValue },
    );
  }
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
  tenantSchema: string,
  query: typeof pool.query,
  deps: HandlerDeps,
  logger: Pick<Console, "log" | "warn" | "error">,
): Promise<SendSystemEmailAttachment[] | undefined> {
  const pdfR2Key = normalizeText(scorecard.pdf_r2_key);
  const renderVersion = Number(scorecard.pdf_render_version ?? 0);
  if (
    !pdfR2Key ||
    renderVersion < MIN_PDF_RENDER_VERSION_WITH_CORRECTIVE_ACTIONS ||
    // The stamped VERSION alone is not proof the stored OBJECT matches it. Validate the content-addressed
    // key shape too, exactly as the sibling field-scorecard email does: the publisher emits immutable
    // `${scorecardId}.${sha256}.v${version}.pdf`, so a key that does not carry the digest and the matching
    // revision is not a v3 artifact regardless of what the version column says. Cheap defence against any
    // path that updates one of the two without the other.
    !isCurrentScorecardPdfArtifactKey(pdfR2Key, renderVersion)
  ) {
    logger.warn(
      "[CorrectiveActionOversightEmail] No corrective-action-bearing PDF - sending without attachment (available in the CRM)",
      { scorecardId, pdfR2Key, renderVersion },
    );
    return undefined;
  }
  // The right RENDERER is not enough — the stored bytes must also be the CURRENT content. The post-commit
  // refresh that regenerates the PDF after a response is best-effort (an R2 blip or a restart makes it a
  // no-op), so a v3 artifact rendered BEFORE the response still shows every item Open. Attaching that to an
  // email headed "Corrective Action Completed" would be the very defect this feature fixes, one level down.
  // Same comparison the server's staleness check makes (migration 0200), at millisecond precision because
  // node-postgres yields millisecond Dates while Postgres retains microseconds.
  if (!isStoredPdfCurrent(scorecard)) {
    logger.warn(
      "[CorrectiveActionOversightEmail] Stored PDF predates the corrective-action response - sending without attachment (the CRM link regenerates on download)",
      {
        scorecardId,
        renderedGeneration: scorecard.pdf_content_generation,
        currentGeneration: scorecard.updated_at,
      },
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
    // POST-FETCH REVALIDATION. Every check above described the row BEFORE the R2 read, which is the
    // slowest step here. An edit landing during it — even one that leaves the lifecycle CLOSED, like a note
    // or signature change — advances updated_at while the old key stays in place until the best-effort
    // rerender succeeds. Marker, status and phase stamp would all still match, so only re-reading the
    // generation catches it. Drop the attachment rather than send a "Completed" notice with stale bytes.
    const fresh = await query(
      `SELECT pdf_r2_key, pdf_content_generation, updated_at
         FROM ${tenantSchema}.field_scorecards WHERE id = $1::uuid LIMIT 1`,
      [scorecardId],
    );
    const freshRow = fresh.rows[0] as
      | { pdf_r2_key: string | null; pdf_content_generation: Date | string | null; updated_at: Date | string | null }
      | undefined;
    // The KEY must still be the published one: a replacement artifact finalized during the fetch leaves the
    // generations matching for the NEW object while the buffer in hand came from the OLD key.
    if (!freshRow || freshRow.pdf_r2_key !== pdfR2Key || !isStoredPdfCurrent(freshRow as ScorecardRow)) {
      logger.warn(
        "[CorrectiveActionOversightEmail] Scorecard changed while the PDF was being fetched - sending without attachment (the CRM link regenerates)",
        { scorecardId },
      );
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

/**
 * Whether the stored PDF was rendered from the scorecard's CURRENT content. A null rendered generation is a
 * pre-migration artifact and therefore not provably current; a null current generation means we cannot tell,
 * and an un-provable attachment is not worth the risk of contradicting the email's own headline.
 */
function isStoredPdfCurrent(scorecard: ScorecardRow): boolean {
  const rendered = toEpochMillis(scorecard.pdf_content_generation);
  const current = toEpochMillis(scorecard.updated_at);
  if (rendered == null || current == null) return false;
  return rendered === current;
}

function toEpochMillis(value: Date | string | null): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Deep link to the deal's Scorecards tab, office-qualified so cross-office watchers land in the right tenant. */
function buildScorecardLink(
  env: NodeJS.ProcessEnv,
  dealId: string | null,
  officeId: string | null | undefined,
): string {
  const base = `${resolveFrontendUrl(env)}/deals/${dealId ?? ""}?tab=scorecards`;
  const office = normalizeText(officeId);
  return office ? `${base}&officeId=${encodeURIComponent(office)}` : base;
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

/**
 * The browsable gate failed. Decide whether that is PERMANENT (complete the job) or RESTORABLE (retry).
 *
 * These two look identical at the gate but are opposites for the queue. Returning in both cases completes the
 * job with the phase stamp still null — and nothing re-enqueues it, because the ONLY enqueue sites are the
 * corrective-action open/close transitions. Restoring a deal from archive, or moving it out of a Lost stage,
 * fires neither. So a card that was merely hidden for the ~120s until this job ran would lose its oversight
 * notice permanently and silently, which is exactly the failure this whole change exists to prevent.
 *
 * So: probe the scorecard row itself, without the deal-visibility join.
 *   - Row alive => only the DEAL's visibility failed, and that is reversible. THROW, so the queue retries with
 *     backoff. If the deal never comes back the job eventually dead-letters — a visible record that oversight
 *     was never told, which is the honest outcome.
 *   - Row gone (hard- or soft-deleted) => there is nothing to notify about and nothing to restore the job for.
 *     Complete quietly, matching the responder job's 404.
 */
async function handleIneligibleScorecard(
  query: typeof pool.query,
  tenantSchema: string,
  scorecardId: string,
  phase: CorrectiveActionOversightPhase,
  logger: Pick<Console, "log" | "warn" | "error">,
  stage: string,
): Promise<void> {
  const alive = await query(
    `SELECT 1 FROM ${tenantSchema}.field_scorecards WHERE id = $1::uuid AND is_active = true LIMIT 1`,
    [scorecardId],
  );
  if (alive.rows.length > 0) {
    logger.warn(
      `[CorrectiveActionOversightEmail] Scorecard is alive but its project is not browsable ${stage} - throwing to retry (a restore cannot re-enqueue this job)`,
      { scorecardId, phase },
    );
    throw new Error(
      `[CorrectiveActionOversightEmail] Project not browsable for ${scorecardId} (${phase}) ${stage} - retrying`,
    );
  }
  logger.warn(
    `[CorrectiveActionOversightEmail] Scorecard no longer exists ${stage} - skipping (no send, no stamp)`,
    { scorecardId, phase },
  );
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

/**
 * responded_at is a TIMESTAMP. Truncating it to a calendar date made every action answered on the same day
 * look simultaneous in what is supposed to be the audit trail of the back-and-forth, and ISO-slicing it also
 * silently reported UTC — so an evening CT response was dated to the following day. Render date + time in the
 * business timezone, matching the PDF record this email links to.
 */
function formatRespondedAt(value: Date | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-US", {
    timeZone: OVERSIGHT_EMAIL_TIMEZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
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
  /** Who was asked to respond (opened notice only). Names and roles — never tokens or responder links. */
  responders?: Array<{ name: string; role: string | null }>;
  link: string;
}) {
  const opened = input.phase === "opened";
  const awaiting = input.phase === "awaiting_approval";
  const title = opened
    ? "Corrective Action Opened"
    : awaiting
      ? "Awaiting Your Approval"
      // Says APPROVED, not "completed". Under the approval gate the card only reaches this state on the
      // approver's acceptance, and "documented" is a weaker claim than "accepted" — the distinction is the
      // entire point of the gate.
      : "Corrective Action Approved";
  const project = input.projectNumber ? `${input.projectNumber} — ${input.dealName}` : input.dealName;
  const subject = opened
    ? `Corrective action opened: ${project} (${input.scoreText})`
    : awaiting
      ? `Corrective action awaiting your approval: ${project}`
      : `Corrective action approved: ${project}`;

  const roleLabel = (role: string | null) =>
    role === "superintendent" ? "Superintendent" : role === "project_manager" ? "Project manager" : null;
  const responderList = (input.responders ?? [])
    .map((r) => {
      const label = roleLabel(r.role);
      return label ? `${r.name} (${label})` : r.name;
    })
    .join(", ");
  // Describes ASSIGNMENT, not delivery — deliberately. This job and the responder job carry the same delay
  // and the queue runs a claimed batch concurrently, so this notice can go out FIRST; the responder send can
  // also fail and eventually dead-letter. Nothing here reads corrective_action_email_sent_at or any
  // per-recipient delivery record, so "has been asked" would be an assurance this handler cannot support.
  // "is assigned to" is true the moment the cycle opens, whatever the responder job goes on to do.
  //
  // The empty case still says the harder thing plainly: with no deliverable address the responder worker
  // sends nothing at all, and that gap is the actionable part of the notice.
  const askedText = responderList
    ? `${responderList} ${(input.responders ?? []).length === 1 ? "is" : "are"} assigned to document a fix for each flagged item.`
    : "No assigned superintendent or project manager could be reached by email for this project, so nobody has been asked to document a fix yet — assign a responder with a valid email on the deal's Team tab.";

  const where = `${input.projectNumber ? ` (${input.projectNumber})` : ""}${input.weekOf ? `, week of ${input.weekOf}` : ""}`;
  const whereHtml = `${input.projectNumber ? ` (${escapeHtml(input.projectNumber)})` : ""}${input.weekOf ? `, week of ${escapeHtml(input.weekOf)}` : ""}`;

  const intro = opened
    ? `A field scorecard for <strong>${escapeHtml(input.dealName)}</strong>${whereHtml} came in below standard (${escapeHtml(input.scoreText)}) and a corrective action has been opened. ${escapeHtml(askedText)}`
    : awaiting
      ? `The corrective action for <strong>${escapeHtml(input.dealName)}</strong>${whereHtml} has been documented and is <strong>waiting for your review</strong>. Approve each item, or send one back with a comment saying what still has to be fixed.`
      : `The corrective action for <strong>${escapeHtml(input.dealName)}</strong>${whereHtml} has been <strong>approved</strong>. Every flagged item was documented and accepted. The updated scorecard is attached where available.`;

  const textIntro = opened
    ? `A field scorecard for ${input.dealName}${where} came in below standard (${input.scoreText}) and a corrective action has been opened. ${askedText}`
    : awaiting
      ? `The corrective action for ${input.dealName}${where} has been documented and is waiting for your review. Approve each item, or send one back with a comment saying what still has to be fixed.`
      : `The corrective action for ${input.dealName}${where} has been approved. Every flagged item was documented and accepted.`;

  const htmlItems = input.items.length
    ? `<ul style="margin:12px 0 0 0;padding-left:20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#111111;">${input.items
        .map((item) => {
          const state = itemState(item.status);
          // An APPROVED item is attributed to whoever approved it; anything else to whoever submitted it.
          const approved = item.status === "approved";
          const who = approved
            ? normalizeText(item.approved_by)
            : normalizeText(item.responder_name) ?? normalizeText(item.responder_email);
          const when = formatRespondedAt(approved ? item.approved_at : item.responded_at);
          const comment = emailCommentExcerpt(item.response_comment);
          const photos = Number(item.photo_count ?? 0);
          const detail = state.answered
            ? `<span style="color:${state.color};font-weight:bold;">${state.label}</span>${who || when ? ` — ${escapeHtml([who, when].filter(Boolean).join(" · "))}` : ""}${comment ? `<br /><span style="color:#475569;">${escapeHtml(comment)}</span>` : ""}${photos > 0 ? `<br /><span style="color:#94a3b8;font-size:12px;">${photos} photo${photos === 1 ? "" : "s"}</span>` : ""}`
            : `<span style="color:${state.color};font-weight:bold;">${state.label}</span>`;
          return `<li style="margin-bottom:10px;">${escapeHtml(emailLabelExcerpt(item.item_label))}<br />${detail}</li>`;
        })
        .join("")}</ul>`
    : `<p style="margin:12px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#64748b;">See the CRM for the flagged items.</p>`;

  const textItems = input.items.length
    ? input.items
        .map((item) => {
          const state = itemState(item.status);
          if (!state.answered) return `• ${emailLabelExcerpt(item.item_label)} — ${state.label}`;
          const approved = item.status === "approved";
          const who = approved
            ? normalizeText(item.approved_by)
            : normalizeText(item.responder_name) ?? normalizeText(item.responder_email);
          const when = formatRespondedAt(approved ? item.approved_at : item.responded_at);
          const comment = emailCommentExcerpt(item.response_comment);
          const photos = Number(item.photo_count ?? 0);
          return (
            `• ${emailLabelExcerpt(item.item_label)} — ${state.label}` +
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
