import crypto from "crypto";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import {
  sendSystemEmailWithMetadata,
  type SendSystemEmailResult,
} from "../lib/system-email.js";
import { escapeHtml, normalizeText, isSafeTenantSchema } from "../lib/email-format.js";
import { resolveFrontendUrl, TROCK_LOGO_EMAIL_URL } from "./project-number-email.js";
import {
  FIELD_SCORECARD_RATINGS,
  scorecardRatingLabel,
  scorecardV2RatingLabel,
  type ScorecardRating,
  WON_DEAL_STAGE_SLUGS,
  LOST_DEAL_STAGE_SLUGS,
} from "@trock-crm/shared/types";

const SCORECARD_RATING_SET = new Set<string>(FIELD_SCORECARD_RATINGS);

// The active/browsable-project SQL predicate the responder API applies before it will serve a corrective-action
// flow (server/src/modules/field/corrective-action-routes.ts → assertActiveCorrectiveActionScorecard, which
// reuses projects-service.ts activeProjectWhere). The worker can't import server code, so the predicate is
// REPLICATED here from the SAME shared slug constants the server derives it from (WON_DEAL_STAGE_SLUGS /
// LOST_DEAL_STAGE_SLUGS via projects-service's FIELD_WON_BROWSABLE_SLUGS / FIELD_LOST_EXCLUDED_SLUGS). A deal is
// browsable when it is active AND (not terminal OR a Won-family stage) AND not a Lost/terminal stage. Callers
// must join `deals d` (alias d) + `LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id`. $1/$2 are
// the Won/Lost slug text[] arrays (passed as query params so the fragment carries no interpolated values).
// DRIFT RISK: if the server changes activeProjectWhere's shape (e.g. adds a clause), this copy must be updated in
// lockstep — it is only kept honest by shared slug constants + the finding-C tests, not by a compile-time link.
const BROWSABLE_PROJECT_SQL = `
    d.is_active = true
    AND (
      COALESCE(psc.is_terminal, false) = false
      OR COALESCE(psc.slug, d.bid_board_stage_slug, '') = ANY($1::text[])
    )
    AND COALESCE(psc.slug, d.bid_board_stage_slug, '') <> ALL($2::text[])`;
const WON_BROWSABLE_SLUGS = [...WON_DEAL_STAGE_SLUGS];
const LOST_EXCLUDED_SLUGS = [...LOST_DEAL_STAGE_SLUGS];

export const SCORECARD_CORRECTIVE_ACTION_EMAIL_JOB = "scorecard_corrective_action_email";

// Token lifetime for the email-only web responder link. Long enough that a super/PM has weeks to document the
// corrective action; the flow allows multiple submissions until close, so the token is NOT single-use.
const TOKEN_TTL_DAYS = 30;

// Short delay before the re-notification job runs when a new corrective-action item raced in after this worker
// read its flagged set (Part B). Mirrors the server reconcile's SCORECARD_EMAIL_RUN_AFTER_SECONDS (120s) so the
// re-enqueued cycle behaves like a normal enqueue and lets any further in-flight edits settle before it reads.
const CORRECTIVE_ACTION_REENQUEUE_DELAY_SECONDS = 120;

export interface ScorecardCorrectiveActionEmailPayload {
  tenantSchema?: string;
  scorecardId?: string;
  dealId?: string;
  officeId?: string | null;
  /** Stable per-cycle idempotency-cycle dimension for the CRM (no-token) Resend key. Minted ONCE per enqueue
   *  (each corrective-action cycle) by the server and IMMUTABLE across a job's retries — so it differs across
   *  cycles yet is stable across a genuine queue retry, even if a responder resolves an open item between the
   *  send attempt and a retry. Optional because jobs enqueued before this deploy don't carry it (the handler
   *  falls back to the live open-row fingerprint for those). */
  cycleNonce?: string;
}

interface HandlerDeps {
  query?: typeof pool.query;
  /** Acquire a dedicated pooled client for a multi-statement TRANSACTION (finding A: the fresh-cycle
   *  replacement must be atomic). Defaults to `pool.connect`. Tests that inject `query` do NOT need this — the
   *  transaction routes its statements through the injected `query` so they stay observable, and BEGIN/COMMIT/
   *  ROLLBACK go through it too. */
  getClient?: () => Promise<PoolClient>;
  sendEmail?: (
    to: string | string[],
    subject: string,
    html: string,
    options: { text: string; idempotencyKey: string }
  ) => Promise<SendSystemEmailResult>;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

type RecipientRole = "superintendent" | "project_manager";

interface ResolvedRecipient {
  role: RecipientRole;
  name: string;
  email: string;
  userId: string | null;
  /** True only when this CRM user can actually USE T-Rock Cam: an enabled, non-revoked field login that is NOT
   *  flagged must_change_password (a must-change user authenticates but is bounced by requireFieldContractor on
   *  every field request, so the deep-link screen can't load). A userId recipient who CANNOT gets the tokenized
   *  web fallback instead of the deep link (finding 2 / finding 6). */
  canFieldLogin: boolean;
}

interface FlaggedItem {
  itemType: string;
  itemLabel: string;
}

function basicValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * The super/PM recipient-resolution SQL, parameterized by the tenant schema (regex-validated by the caller —
 * identifiers can't be $-parametrized). Extracted so the pre-stamp RECIPIENT-set revalidation (finding 1)
 * re-runs the EXACT same selection the worker emailed off of, and the two can't drift. Same selection as the
 * server's resolveCorrectiveActionRecipients (deal_team_members active rows; user/contact must be active; or
 * an email-only member with both fks null). $1 = deal id.
 */
function recipientResolutionSql(tenantSchema: string): string {
  return `SELECT DISTINCT ON (dtm.role)
            dtm.role AS role,
            dtm.user_id AS user_id,
            COALESCE(
              CASE WHEN dtm.user_id IS NOT NULL AND u.is_active THEN u.display_name END,
              CASE WHEN dtm.contact_id IS NOT NULL AND c.is_active THEN TRIM(CONCAT(c.first_name, ' ', c.last_name)) END,
              dtm.member_name
            ) AS name,
            COALESCE(
              CASE WHEN dtm.user_id IS NOT NULL AND u.is_active THEN u.email END,
              CASE WHEN dtm.contact_id IS NOT NULL AND c.is_active THEN c.email END,
              dtm.member_email
            ) AS email,
            (dtm.user_id IS NOT NULL AND u.is_active AND ula.user_id IS NOT NULL
               AND ula.is_enabled = TRUE AND ula.revoked_at IS NULL
               AND ula.must_change_password = FALSE) AS can_field_login
       FROM ${tenantSchema}.deal_team_members dtm
       LEFT JOIN public.users u ON dtm.user_id = u.id
       LEFT JOIN public.user_local_auth ula ON dtm.user_id = ula.user_id
       LEFT JOIN ${tenantSchema}.contacts c ON dtm.contact_id = c.id
      WHERE dtm.deal_id = $1::uuid
        AND dtm.is_active = TRUE
        AND dtm.role IN ('superintendent', 'project_manager')
        AND (
          (dtm.user_id IS NOT NULL AND u.is_active)
          OR (dtm.contact_id IS NOT NULL AND c.is_active)
          OR (dtm.user_id IS NULL AND dtm.contact_id IS NULL)
        )
      ORDER BY dtm.role, dtm.created_at DESC`;
}

/**
 * Reduce a recipient-query result to a stable, order-independent SIGNATURE of the set the worker will notify
 * (or DID notify): the sorted `role:lower(email):fieldLoginFlag` triples of every row that resolves to a
 * deliverable recipient (a valid email). Used to detect a super/PM REASSIGNMENT — OR a field-login CAPABILITY
 * change — between the recipient read and the delivery stamp (finding 1 + finding D): if the signature the
 * worker emailed off of differs from a fresh re-resolution at stamp time, a recipient was added/removed/replaced
 * OR an existing recipient's field-login capability flipped — so the run must NOT stamp; it re-notifies a fresh
 * cycle instead.
 *
 * Finding D: canFieldLogin IS part of the signature. If a CRM recipient's field login is revoked
 * (user_local_auth.is_enabled → false, or must_change_password set) mid-send, the worker emailed them only a
 * trockcam:// deep link they can no longer open, with NO tokenized fallback. Including the capability makes that
 * revocation register as a recipient change → the stamp is withheld and a fresh cycle re-notifies, now routing
 * the revoked user to the web/token fallback (which the current-capability resolution produces). `name` is still
 * excluded — a pure display-name edit doesn't change WHO/HOW anyone is reached.
 */
function recipientSignature(rows: any[]): string {
  const pairs: string[] = [];
  for (const row of rows) {
    const email = normalizeText(row.email);
    const role = row.role;
    if (role !== "superintendent" && role !== "project_manager") continue;
    if (!email || !basicValidEmail(email)) continue;
    const canFieldLogin = row.can_field_login === true;
    pairs.push(`${role}:${email.toLowerCase()}:${canFieldLogin ? "1" : "0"}`);
  }
  return [...new Set(pairs)].sort().join(",");
}

/** sha256 hex of the raw token — matches the server's hashCorrectiveActionToken so verify roundtrips. */
function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Version-aware score display + human rating label for the corrective-action email — mirrors the regular
 * scorecard email (buildFieldScorecardEmail in field-scorecard-email.ts). V2/leadership cards persist
 * total_score as `average * 10` (a 6.5/10 average stored as 65) alongside the true average in average_score,
 * so they must render `X.X/10` (preferring the stored average, falling back to total_score/10) rather than
 * `65/100`. V1 cards store a 0–100 total → `n/100`. The `rating` argument is the raw enum from the row; it is
 * converted to the human label with the version-matching shared helper (V2/leadership → scorecardV2RatingLabel,
 * V1 → scorecardRatingLabel) instead of leaking the enum. An unrecognized rating passes through as-is. (finding 5)
 */
export function deriveScorecardScoreAndRating(input: {
  totalScore: number | null;
  averageScore: number | null;
  isTenPointForm: boolean;
  rating: string | null;
}): { scoreText: string; ratingLabel: string | null } {
  const scoreText =
    input.totalScore == null
      ? "—"
      : input.isTenPointForm
        ? `${(input.averageScore ?? input.totalScore / 10).toFixed(1)}/10`
        : `${input.totalScore}/100`;

  let ratingLabel = input.rating;
  if (input.rating && SCORECARD_RATING_SET.has(input.rating)) {
    const rating = input.rating as ScorecardRating;
    ratingLabel = input.isTenPointForm ? scorecardV2RatingLabel(rating) : scorecardRatingLabel(rating);
  }
  return { scoreText, ratingLabel };
}

/**
 * Below-band corrective-action notification. When a scorecard trips the corrective-action band, the server
 * seeds tracked items + enqueues this job in the SAME submit transaction (durable outbox). The handler
 * resolves the deal's superintendent + project_manager (hybrid: CRM users OR email-only members), and sends
 * ONE email per recipient:
 *   - a CRM user who can ACTUALLY use T-Rock Cam (an enabled, non-revoked, non-must-change-password
 *     user_local_auth row — mirrors loginFieldUser + the field-auth middleware gate) gets a TRock Cam deep
 *     link (trockcam://scorecards/corrective-action/<id>);
 *   - an email-only member — OR a CRM user who CANNOT use the field app (no enabled field login, or one flagged
 *     must_change_password, so the deep link would strand them at a login/gate they can't pass; findings 6 + 2)
 *     — gets a freshly-minted recipient-bound web token appended to the responder URL.
 *
 * Idempotent per scorecard via field_scorecards.corrective_action_email_sent_at (mirrors email_sent_at):
 * checked before sending, stamped once ONLY when every ASSIGNED super/PM role was delivered this run. An
 * assigned-but-unresolvable role — inactive identity or missing/invalid email — instead THROWS so the queue
 * retries (a normal return would COMPLETE the job and strand the un-notified role forever; finding 4). The
 * Resend idempotencyKey is scoped to the corrective-action CYCLE for BOTH recipient kinds via the SAME
 * per-(scorecard, recipient) key carrying the server-minted per-cycle `payload.cycleNonce` (a stable UUID,
 * immutable across a job's retries; legacy in-flight jobs without it fall back to a hash over the current open
 * corrective-action-item ids) so an updated flagged-item email is actually sent, not false-deduped by Resend as
 * a same-key/different-payload `invalid_idempotent_request` (finding 4); WITHIN a cycle the key is stable so a
 * re-delivery in the crash window (sent, not yet stamped) or a throw-triggered retry doesn't double-email a
 * recipient. The key is deliberately NOT scoped to the token hash: on a crash-window retry the worker mints a
 * FRESH usable token (so the emailed link always carries a real `?token=`, never tokenless), and a hash-scoped
 * key would drift across that retry (finding 1). Email-only tokens carry a delivered_at set only AFTER a
 * successful send, so a retry reuses (skips) a DELIVERED token but re-mints + re-sends for an undelivered one —
 * delivery is never inferred from mere token existence, and a re-sent link is always usable (finding 1).
 */
export async function handleScorecardCorrectiveActionEmail(
  payload: ScorecardCorrectiveActionEmailPayload,
  _officeId: string | null,
  deps: HandlerDeps = {}
): Promise<void> {
  const logger = deps.logger ?? console;
  const tenantSchema = payload.tenantSchema;
  const scorecardId = normalizeText(payload.scorecardId);
  const dealId = normalizeText(payload.dealId);
  if (!isSafeTenantSchema(tenantSchema) || !scorecardId || !dealId) {
    logger.warn("[CorrectiveActionEmail] Invalid job payload - skipping", { tenantSchema, scorecardId, dealId });
    return;
  }

  const env = deps.env ?? process.env;
  const query = deps.query ?? pool.query.bind(pool);
  // Finding A: a dedicated pooled client for the atomic fresh-cycle replacement. When a test injects `deps.query`
  // (no real pool), the transaction routes its statements — and BEGIN/COMMIT/ROLLBACK — through that SAME injected
  // query so they stay observable to the test's assertions; otherwise it acquires a real client from the pool.
  const usesInjectedQuery = deps.query != null;
  const getClient = deps.getClient ?? pool.connect.bind(pool);

  // Idempotency + scorecard snapshot. tenantSchema is regex-validated above (isSafeTenantSchema), so
  // interpolating it as the schema qualifier is safe — identifiers can't be $-parametrized.
  //
  // Finding C: gate on the SAME active/browsable predicate the responder API applies before it will serve the
  // corrective-action flow (assertActiveCorrectiveActionScorecard: `field_scorecards.is_active = true` AND
  // activeProjectWhere over the joined deal). This delayed (120s) worker previously checked only `status`, so if
  // the scorecard was soft-deleted, or its deal archived / moved to a Lost/terminal stage during the delay, it
  // would still SEND + STAMP — but the responder then 404s, so the email CTA is dead on arrival. Joining the deal
  // (+ psc) and requiring the record be active/browsable makes the worker return WITHOUT sending or stamping for a
  // hidden record (a soft-deleted scorecard is now a LEFT JOIN miss on is_active → not returned at all → the
  // "Scorecard not found" branch, which never stamps → a restore can still notify). $2/$3 = Won/Lost slug arrays.
  //
  // The BROWSABLE_PROJECT_SQL fragment authors its placeholders as $1 (Won) / $2 (Lost), but here they occupy
  // $2 / $3 (after $1 = scorecardId). Renumber in a SINGLE atomic pass — `.replace(/\$(\d+)/g, +1)` bumps $1→$2
  // and $2→$3 in ONE scan. A CHAINED `.replace($1→$2).replace($2→$3)` would CASCADE: the first replace produces
  // a fresh $2 that the second replace then rewrites to $3 alongside the original $2, collapsing BOTH the Won
  // ANY(...) and the Lost ALL(...) onto $3 — a terminal Won project's slug would be tested only against the Lost
  // array, never matched, so the row would be dropped and the notification silently skipped. Keep this a single pass.
  //
  // Finding B: also load corrective_action_cycle_nonce here so a SUPERSEDED job (its payload nonce ≠ the
  // scorecard's current active nonce) can be skipped BEFORE resolving recipients or calling the provider — the
  // final delivery stamp already checks the nonce, but by then cycle A has already SENT (a fresh cycle B reset
  // sent_at to null), duplicating the email under a different idempotency key.
  const scorecardRes = await query(
    `SELECT sc.status, sc.corrective_action_email_sent_at, sc.deal_id, sc.project_number, sc.total_score,
            sc.average_score, sc.rating, sc.form_version, sc.kind, sc.week_of, sc.corrective_action_cycle_nonce
       FROM ${tenantSchema}.field_scorecards sc
       JOIN ${tenantSchema}.deals d ON d.id = sc.deal_id
       LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE sc.id = $1::uuid
        AND sc.is_active = true
        AND ${BROWSABLE_PROJECT_SQL.replace(/\$(\d+)/g, (_m, n) => "$" + (Number(n) + 1))}
      LIMIT 1`,
    [scorecardId, WON_BROWSABLE_SLUGS, LOST_EXCLUDED_SLUGS]
  );
  const scorecard = scorecardRes.rows[0];
  if (!scorecard) {
    // Either genuinely nonexistent OR hidden (soft-deleted scorecard / archived-or-Lost deal) — indistinguishable
    // here, exactly like the responder's 404. Return WITHOUT sending and WITHOUT stamping so a restore/reactivation
    // (which the server reconcile re-notifies while sent_at is NULL) can still deliver the notification.
    logger.warn("[CorrectiveActionEmail] Scorecard not found or not browsable - skipping (no send, no stamp)", {
      tenantSchema,
      scorecardId,
    });
    return;
  }

  // Finding B: skip a SUPERSEDED job BEFORE resolving recipients / sending. If cycle B starts while this cycle-A
  // job is still pending, the server reset corrective_action_email_sent_at to NULL (so the sent-at check below
  // passes) and set a NEW active nonce on the scorecard. Without this early gate, cycle A would SEND (under its
  // own idempotency key) before its nonce is ever examined — only the final stamp compares it — so a field-login
  // CRM recipient receives DUPLICATE corrective-action emails (cycle B sends under a different key). Comparing the
  // payload nonce to the scorecard's CURRENT active nonce up front and returning on a mismatch means a stale-cycle
  // job never sends. Legacy fallback (fail-safe, never re-notify-loses): if EITHER the payload carries no nonce
  // (a pre-deploy in-flight job) OR the scorecard's stored nonce is NULL (a pre-column card), fall through to the
  // existing behavior — the final nonce-guarded stamp still protects the crash-window crossover.
  const payloadNonceEarly = normalizeText(payload.cycleNonce);
  const storedNonceEarly = normalizeText(scorecard.corrective_action_cycle_nonce);
  if (payloadNonceEarly && storedNonceEarly && payloadNonceEarly !== storedNonceEarly) {
    logger.log(
      "[CorrectiveActionEmail] Job cycleNonce superseded by a newer cycle - skipping (no send, no stamp)",
      { scorecardId, payloadNonce: payloadNonceEarly, storedNonce: storedNonceEarly }
    );
    return;
  }
  // The corrective action must still be OPEN to notify. This job runs after a delay, during which an edit may
  // lift the card above-band (status → 'submitted') or the team may resolve every item in-app (status →
  // 'corrective_action_closed'); reconciliation deleted the open items in the first case, so the responder link
  // would 404 anyway. If the card is no longer open there is nothing to notify — complete cleanly (no email,
  // no error), never stamping sent, so a later reopen (which re-enqueues) still notifies.
  if (scorecard.status !== "corrective_action_open") {
    logger.log("[CorrectiveActionEmail] Scorecard no longer corrective_action_open - skipping (nothing to notify)", {
      scorecardId,
      status: scorecard.status,
    });
    return;
  }
  if (scorecard.corrective_action_email_sent_at) {
    logger.log("[CorrectiveActionEmail] Already notified - skipping duplicate job", { scorecardId });
    return;
  }

  // Resolve the deal's superintendent + project_manager (hybrid). Same selection as the server's
  // resolveCorrectiveActionRecipients (deal_team_members active rows; user/contact must be active; or an
  // email-only member with both fks null), reimplemented in raw SQL because the worker can't import server.
  // canFieldLogin mirrors the server's field-login gate (loginFieldUser + the field-auth middleware): a CRM
  // user can actually USE T-Rock Cam only if they hold an ENABLED, NON-REVOKED user_local_auth row AND are
  // NOT flagged must_change_password. loginFieldUser INNER-JOINs user_local_auth and rejects `!is_enabled`,
  // and the field middleware (requireFieldContractor, server/src/middleware/field-auth.ts) additionally
  // rejects a set revoked_at AND a set must_change_password (401 "Field app access requires password
  // change"). So even though loginFieldUser LETS a must-change user authenticate, that user is BOUNCED on
  // their very next field API request — the corrective-action screen can never load for them — so the deep
  // link would strand them exactly like a disabled login. Classify such a user NOT-field-capable → they fall
  // to the tokenized web fallback (finding 2 / finding 6). must_change_password is boolean NOT NULL DEFAULT
  // true (schema/public/user-local-auth.ts); the LEFT JOIN yields NULL only when NO row exists, but that case
  // is already excluded by `ula.user_id IS NOT NULL` earlier in the AND-chain, so `= FALSE` is safe. A userId
  // recipient WITHOUT an enabled/non-revoked/non-must-change login gets the tokenized web fallback instead.
  // user_local_auth lives in public (schema/public/user-local-auth.ts).
  const recipientRes = await query(recipientResolutionSql(tenantSchema), [dealId]);
  // Signature of the set the worker is about to notify. Compared against a fresh re-resolution just before the
  // stamp to detect a super/PM reassignment mid-run (finding 1).
  const emailedRecipientSignature = recipientSignature(recipientRes.rows as any[]);
  const recipients: ResolvedRecipient[] = [];
  const resolvedRoles = new Set<RecipientRole>();
  for (const row of recipientRes.rows as any[]) {
    const email = normalizeText(row.email);
    const role = row.role as RecipientRole;
    if (role !== "superintendent" && role !== "project_manager") continue;
    if (!email || !basicValidEmail(email)) {
      logger.warn("[CorrectiveActionEmail] Recipient has no resolvable email - skipping", { scorecardId, role });
      continue;
    }
    recipients.push({
      role,
      name: normalizeText(row.name) ?? email,
      email,
      userId: normalizeText(row.user_id),
      canFieldLogin: row.can_field_login === true,
    });
    resolvedRoles.add(role);
  }

  if (recipients.length === 0) {
    // No super/PM with an email on this deal RIGHT NOW. This is usually transient — the team is often assigned
    // shortly after the scorecard is filed — so completing-as-success here would drop the notification forever
    // (nothing re-enqueues on a later assignment). Instead THROW a retryable error so the queue retries with
    // backoff up to max_attempts, giving the team time to be assigned; the final attempt dead-letters with this
    // message (a loud, inspectable give-up). Residual limitation: a team assigned AFTER max_attempts is
    // exhausted still won't be notified — a fuller enqueue-on-team-change trigger is a noted follow-up
    // (out of scope here). We do NOT stamp corrective_action_email_sent_at, so a manual requeue can still notify.
    logger.warn(
      "[CorrectiveActionEmail] No superintendent/project-manager with an email on the deal - will retry",
      { scorecardId, dealId }
    );
    throw new Error(
      `No superintendent/project-manager with an email on deal ${dealId} - retrying until the team is assigned`,
    );
  }

  // Which super/PM roles are ASSIGNED AT ALL on this deal — an active deal_team_members row for the role,
  // REGARDLESS of whether its identity currently resolves to a usable email. This is deliberately broader than
  // the resolved-recipient query above (which drops inactive users/contacts and blank emails), so we can tell:
  //   - a role ASSIGNED but currently UNRESOLVABLE (inactive identity, or missing/invalid email) → the delivery
  //     is INCOMPLETE this run: that responder was never notified, so we must NOT stamp (leave re-runnable);
  //   - a role NOT ASSIGNED AT ALL → nothing owed for it, so a deal with only one of the two roles can still be
  //     complete once that one role is delivered.
  // "Required" = every role that IS assigned. This is the minimal coherent rule: don't stamp until every
  // assigned super/PM role has been delivered; unassigned roles owe nothing. (finding 4)
  const assignedRes = await query(
    `SELECT DISTINCT dtm.role AS role
       FROM ${tenantSchema}.deal_team_members dtm
      WHERE dtm.deal_id = $1::uuid
        AND dtm.is_active = TRUE
        AND dtm.role IN ('superintendent', 'project_manager')`,
    [dealId]
  );
  const assignedRoles = new Set<RecipientRole>();
  for (const row of assignedRes.rows as any[]) {
    const role = row.role as RecipientRole;
    if (role === "superintendent" || role === "project_manager") assignedRoles.add(role);
  }
  // Roles that ARE assigned but did NOT resolve into a deliverable recipient this run.
  const unresolvedAssignedRoles = [...assignedRoles].filter((role) => !resolvedRoles.has(role));

  // Flagged items for the email body (the open corrective-action rows). We also select each row's id to
  // derive the per-cycle fingerprint below (reuses this one query — no extra round-trip).
  const flaggedRes = await query(
    `SELECT id, item_type, item_label FROM ${tenantSchema}.scorecard_corrective_actions
      WHERE scorecard_id = $1::uuid AND status = 'open'
      ORDER BY item_type, item_ref`,
    [scorecardId]
  );
  // NOTE: flaggedRows/flagged are RE-READ + rebuilt from the live open set immediately before send (P2) so the
  // emailed body + the stamp's emitted-id array never carry an item resolved after this initial load. Declared
  // `let` so that fresh read can replace them.
  let flaggedRows = flaggedRes.rows as any[];
  let flagged: FlaggedItem[] = flaggedRows.map((r) => ({
    itemType: String(r.item_type),
    itemLabel: String(r.item_label),
  }));

  // Empty-open-set race (finding 5). We read `scorecard.status` at the TOP of this run, THEN queried the open
  // corrective-action rows above. If the LAST open item is resolved AFTER that status read but BEFORE this
  // flagged query, `flaggedRows` is now empty. Continuing would send a misleading "Corrective action required"
  // email built on the empty-fallback item text ("see the CRM for the flagged items"), and the final
  // subset-guarded stamp would trivially succeed (an empty current-open set satisfies the NOT EXISTS) — marking
  // a concurrently-COMPLETED action as still required and stamping sent_at (which suppresses the server
  // reconcile from ever re-notifying). So when there are zero open rows, RE-READ the scorecard's live status:
  // if it is no longer `corrective_action_open` (the team resolved every item in-app → status flipped to
  // corrective_action_closed, or an edit lifted the card above-band → 'submitted'), there is nothing to notify
  // — RETURN WITHOUT sending and WITHOUT stamping, so a later reopen (which re-enqueues) still notifies. If the
  // card is somehow STILL corrective_action_open with no open rows (a transient in-between state), also bail
  // without sending/stamping — an email with the empty fallback item text must never go out.
  if (flaggedRows.length === 0) {
    const statusRecheck = await query(
      `SELECT status FROM ${tenantSchema}.field_scorecards WHERE id = $1::uuid LIMIT 1`,
      [scorecardId]
    );
    const currentStatus = statusRecheck.rows[0]?.status;
    logger.log(
      "[CorrectiveActionEmail] No open corrective-action items at send time - skipping (nothing to notify, not stamping)",
      { scorecardId, currentStatus }
    );
    return;
  }

  // Per-cycle dimension for the CRM (no-token) idempotency key. A CRM recipient's deep link is cycle-STABLE,
  // but the email PAYLOAD (which lists the flagged items) changes every cycle — so a cycle-stable key would
  // make Resend see the same key with a different payload → `invalid_idempotent_request`, which
  // sendSystemEmailWithMetadata treats as an already-delivered success → the worker stamps the new cycle
  // notified WITHOUT sending the updated email (the CRM assignee never learns of the new corrective action).
  // (finding 4)
  //
  // PREFERRED source: the server-minted `payload.cycleNonce` — a stable UUID minted ONCE per enqueue (each
  // corrective-action cycle) and IMMUTABLE across a job's retries. This is retry-STABLE by construction: even
  // if a responder resolves an open item between the send attempt and a retry (shrinking the live open set),
  // the nonce is unchanged → the CRM key is unchanged → Resend still dedups the true duplicate (no double
  // email). It also DIFFERS across cycles (the server mints a fresh nonce for a reopen / a card that gained
  // work), so the updated cycle's email is actually sent.
  //
  // FALLBACK (jobs enqueued BEFORE this deploy, still in-flight, carry no cycleNonce): a hash over the CURRENT
  // open corrective-action rows' ids. Every new cycle INSERTS at least one brand-new fresh-UUID row that is
  // `open` when this job runs, so the fingerprint DIFFERS across cycles; a genuine in-cycle retry reads the
  // same open-item set → the SAME fingerprint. Sorted so ordering can't perturb it. This fallback IS the
  // unstable-across-a-resolve case the nonce fixes, but it is the best available signal for legacy jobs and
  // is strictly better than a cycle-stable key.
  //
  // NOTE (P2): the fingerprint is deliberately computed AFTER the pre-send re-read (below) so it hashes the SAME
  // fresh open set the body/stamp use — never a stale set. The `nonce` (preferred key) is read here since it does
  // not depend on the open rows.
  const nonce = normalizeText(payload.cycleNonce);

  // Deal display fields for the email + link.
  const dealRes = await query(
    `SELECT name, deal_number, project_number FROM ${tenantSchema}.deals WHERE id = $1::uuid LIMIT 1`,
    [dealId]
  );
  const dealRow = dealRes.rows[0] ?? {};
  const dealName = normalizeText(dealRow.name) ?? "Project";
  const projectNumber = normalizeText(scorecard.project_number) ?? normalizeText(dealRow.project_number);

  const frontendUrl = resolveFrontendUrl(env).replace(/\/+$/, "");
  // Version-aware score + human rating label, mirroring the regular scorecard email (buildFieldScorecardEmail):
  // V2/leadership persist total_score as `average * 10` (so a 6.5/10 average is stored as 65) with the true
  // average beside it in average_score — render those as `X.X/10` (preferring average_score, falling back to
  // total_score/10). V1 stores a 0–100 total → render `n/100`. Leadership always persists form_version = 2
  // (scorecard-submission.ts), so keying off form_version === 2 covers both V2 project and leadership. The
  // `rating` column stores the raw enum (e.g. `corrective_action`); convert it to the human label using the
  // matching helper (V2/leadership → scorecardV2RatingLabel, V1 → scorecardRatingLabel) rather than surfacing
  // the enum. (finding 5)
  const isTenPointForm = Number(scorecard.form_version) === 2 || scorecard.kind === "leadership";
  const { scoreText, ratingLabel } = deriveScorecardScoreAndRating({
    totalScore: scorecard.total_score == null ? null : Number(scorecard.total_score),
    averageScore: scorecard.average_score == null ? null : Number(scorecard.average_score),
    isTenPointForm,
    rating: normalizeText(scorecard.rating),
  });

  const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;

  // NOTE: we deliberately do NOT blanket-delete this scorecard's outstanding tokens up front. On a retry
  // after a PARTIAL delivery (recipient A sent, B failed before the scorecard-level stamp), a blanket delete
  // would drop A's ALREADY-DELIVERED token — and A can't be re-sent (we can't reconstruct A's raw token to
  // rebuild the link), so A would be stranded on the deleted one. Instead, token rotation is per-recipient
  // inside the loop: a recipient who already holds an
  // unexpired/unconsumed AND DELIVERED token was emailed on a prior attempt, so we reuse it (skip re-mint +
  // re-send); a recipient whose send fails has their just-minted token deleted before we rethrow, so the retry
  // re-mints and re-sends them a fresh, working link. Only the OFFICE tenant schema is interpolated (regex-
  // validated).

  // Re-validate closure IMMEDIATELY before sending (finding 6). The empty-flaggedRows guard above only catches
  // closure that happened BEFORE the flagged-row query. But the LAST open item can be resolved AFTER that read
  // (flaggedRows was NON-empty) yet BEFORE we send + stamp. In that window the card's current open set is empty,
  // which trivially SATISFIES the stamp's `NOT EXISTS (... open AND NOT id=ANY($2))` subset guard — so an
  // unconditional continue here would send a stale "corrective action required" email for an already-closed card
  // AND stamp that closed card as notified (suppressing the server reconcile from ever re-notifying). So RE-SELECT
  // the LIVE status + whether ANY open corrective-action row remains, right before the send loop; if the card is
  // no longer `corrective_action_open` OR has zero open rows, RETURN without sending and without stamping (a later
  // reopen re-enqueues and still notifies). One extra read; cheap.
  const preSendRes = await query(
    `SELECT status,
            EXISTS (
              SELECT 1 FROM ${tenantSchema}.scorecard_corrective_actions
               WHERE scorecard_id = $1::uuid AND status = 'open'
            ) AS has_open
       FROM ${tenantSchema}.field_scorecards WHERE id = $1::uuid LIMIT 1`,
    [scorecardId]
  );
  const preSendRow = preSendRes.rows[0] as { status?: string; has_open?: boolean } | undefined;
  if (!preSendRow || preSendRow.status !== "corrective_action_open" || preSendRow.has_open !== true) {
    logger.log(
      "[CorrectiveActionEmail] Card closed/lifted between the flagged read and send - skipping (nothing to notify, not stamping)",
      { scorecardId, status: preSendRow?.status, hasOpen: preSendRow?.has_open }
    );
    return;
  }

  // P2 (stale flagged-item list): RE-READ the open corrective-action rows here and REBUILD the email body from
  // that FRESH set. The `flagged`/`flaggedRows` loaded near the top can go STALE: if — between that load and this
  // send — ONE of several flagged items is resolved/removed while ANOTHER stays open, the has_open recheck above
  // still passes (it only tests for the EXISTENCE of any open row) and the subset-guarded stamp still accepts the
  // reduced open set. Continuing off the initial `flagged` would email the STALE list (naming an item the
  // responder page no longer shows open) and stamp the cycle off that stale set. Building the body + the stamp's
  // emitted-id array from the CURRENT open rows makes recipients get an accurate list. If the fresh set is now
  // empty (every item resolved in a tighter race than the has_open recheck caught), bail via the same
  // nothing-to-notify guard — never send the empty-fallback item text, never stamp (a later reopen re-notifies).
  const freshFlaggedRes = await query(
    `SELECT id, item_type, item_label FROM ${tenantSchema}.scorecard_corrective_actions
      WHERE scorecard_id = $1::uuid AND status = 'open'
      ORDER BY item_type, item_ref`,
    [scorecardId]
  );
  flaggedRows = freshFlaggedRes.rows as any[];
  if (flaggedRows.length === 0) {
    logger.log(
      "[CorrectiveActionEmail] Open items resolved between the flagged read and send - skipping (nothing to notify, not stamping)",
      { scorecardId }
    );
    return;
  }
  flagged = flaggedRows.map((r) => ({
    itemType: String(r.item_type),
    itemLabel: String(r.item_label),
  }));

  // Per-cycle dimension for the CRM (no-token) idempotency key, computed from the FRESH open set (P2) so a legacy
  // (no-nonce) job's key hashes exactly the ids it is emailing. The preferred `nonce` (read above) is unaffected
  // by the open rows; the fingerprint fallback hashes the current open ids (sorted). The card is guaranteed to
  // have ≥1 open row here (we bailed above on an empty fresh set).
  const cycleFingerprint = crypto
    .createHash("sha256")
    .update(
      flaggedRows
        .map((r) => String(r.id))
        .sort()
        .join(","),
    )
    .digest("hex")
    .slice(0, 16);
  const cycleDimension = nonce ?? cycleFingerprint;

  // Send one email per recipient with the link appropriate to their ACTUAL field-login capability (finding 6).
  // A CRM user who can authenticate in T-Rock Cam (canFieldLogin) gets the in-app deep link; a CRM user who
  // CANNOT (no enabled/non-revoked field login) — as well as every email-only member (userId === null) — gets
  // the tokenized web link, because the deep link would otherwise strand them at a login they can't pass.
  for (const recipient of recipients) {
    let link: string;
    // The token_hash of a token FRESHLY MINTED this run (null for a deep-link CRM user, or a delivered-token
    // reuse-skip). Used only to target the post-send delivered_at stamp + the on-failure cleanup delete — NOT
    // the idempotency key (which is the stable per-cycle key for both recipient kinds; see below). A minted
    // hash is ALWAYS a token minted this run whose raw link is in `link`, so it is always safe to delete on a
    // send failure and to stamp delivered on success.
    let mintedTokenHash: string | null = null;
    if (recipient.userId && recipient.canFieldLogin) {
      // CRM user WITH an enabled field login → TRock Cam deep link (they respond in-app). The scheme + path
      // must match the app exactly: the Expo config `scheme` is `trockcam` (app.config.ts) and the expo-router
      // file route is app/(app)/scorecards/corrective-action/[id].tsx, so the deep link is
      // trockcam://scorecards/corrective-action/<id> (the `(app)` group is transparent in the URL).
      link = `trockcam://scorecards/corrective-action/${encodeURIComponent(scorecardId)}`;
    } else {
      // Email-only member OR a CRM user who canNOT field-login → they respond via a tokenized web link (the
      // recipient-bound token uses THIS recipient's email — a CRM user's public.users email is their own, and
      // the verify-time revalidation authorizes them because that email matches their own active super/PM
      // assignment on the deal).
      //
      // Look up ANY LIVE token (unconsumed, unexpired) for this (scorecard, recipient) — regardless of
      // delivered_at — and branch on its delivery state:
      //   - DELIVERED (delivered_at IS NOT NULL): they were emailed a working link on a prior attempt. We can't
      //     reconstruct the raw token to re-send, so reuse-SKIP (no re-mint, no re-send), leaving their
      //     delivered link intact. The delivered_at short-circuit is what makes a genuine duplicate a no-op.
      //   - UNDELIVERED (delivered_at IS NULL) OR NO live token: a crash can leave a surviving token whose raw
      //     value is unrecoverable (it's hashed at rest), OR there may be no token at all (first send, or a
      //     failed send whose cleanup landed). In BOTH cases MINT A FRESH usable token so the link ALWAYS
      //     carries a real `?token=` — a tokenless link is unusable for an email-only recipient (no way to
      //     authorize the responder), and the surviving hash can't rebuild a usable link. Idempotency does NOT
      //     rely on the token hash here: the key is the STABLE per-cycle key (email + cycleNonce/fingerprint,
      //     same scheme CRM recipients use), which is unchanged across a crash-retry regardless of which token
      //     instance backs the link — so the provider still dedups the true duplicate while the re-sent link is
      //     genuinely usable. delivered_at is stamped only AFTER a successful send, so a crash before the stamp
      //     leaves the survivor undelivered and the retry re-mints + re-sends a working link (never tokenless).
      const live = await query(
        `SELECT token_hash, delivered_at FROM ${tenantSchema}.scorecard_corrective_action_tokens
          WHERE scorecard_id = $1::uuid AND LOWER(recipient_email) = LOWER($2)
            AND consumed_at IS NULL AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1`,
        [scorecardId, recipient.email]
      );
      const liveRow = live.rows?.[0] as { token_hash?: string; delivered_at?: unknown } | undefined;
      if (liveRow && liveRow.delivered_at != null) {
        logger.log("[CorrectiveActionEmail] Recipient already has a DELIVERED token - reusing (no re-send)", {
          scorecardId,
          role: recipient.role,
        });
        continue;
      }
      // Undelivered survivor OR no live token → mint a FRESH usable token so the link always has a real `?token=`.
      const rawToken = crypto.randomBytes(32).toString("base64url");
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
      await query(
        `INSERT INTO ${tenantSchema}.scorecard_corrective_action_tokens
           (scorecard_id, token_hash, recipient_email, role, expires_at)
         VALUES ($1::uuid, $2, $3, $4, $5)`,
        [scorecardId, tokenHash, recipient.email, recipient.role, expiresAt.toISOString()]
      );
      mintedTokenHash = tokenHash;
      link = `${frontendUrl}/scorecards/${encodeURIComponent(scorecardId)}/corrective-action?token=${encodeURIComponent(rawToken)}`;
      if (liveRow) {
        logger.log("[CorrectiveActionEmail] Minting a fresh usable token on a crash-window retry (undelivered survivor)", {
          scorecardId,
          role: recipient.role,
        });
      }
    }

    const email = buildCorrectiveActionEmail({
      recipientName: recipient.name,
      dealName,
      projectNumber,
      scoreText,
      ratingLabel,
      flagged,
      link,
    });

    // The Resend idempotency key must be UNIQUE PER CORRECTIVE-ACTION CYCLE, not just per (scorecard,
    // recipient) — for BOTH recipient kinds, because a new cycle changes the email PAYLOAD (the flagged-item
    // list) even when the link is stable. A REOPEN re-enqueues a fresh job with a fresh cycleNonce and inserts
    // fresh open rows. If the key were cycle-stable, Resend would see the same key with a DIFFERENT payload and
    // return `invalid_idempotent_request` — which sendSystemEmailWithMetadata treats as an already-delivered
    // success — so the worker would stamp the new cycle notified WITHOUT sending the updated email.
    //
    // BOTH recipient kinds use the SAME per-(scorecard, recipient) key scoped to the per-cycle DIMENSION — the
    // server-minted `payload.cycleNonce` when present (retry-STABLE: immutable across a job's retries, so a
    // responder resolving an item between the send attempt and a retry can't shift the key → no Resend re-send
    // → no duplicate email), else the live open-row fingerprint fallback for legacy in-flight jobs. This is
    // deliberately NOT scoped to the token hash: on a crash-window retry the worker mints a FRESH token (new
    // hash) to keep the link usable (finding 1), so a hash-scoped key would CHANGE across the retry and let the
    // provider re-send a duplicate. The cycle key is stable across that crash-retry (same nonce/open-set)
    // regardless of which token instance backs the link, so the provider dedups the true duplicate while the
    // re-sent link is genuinely usable. It differs across cycles (a reopen mints a fresh nonce / inserts fresh
    // open rows) yet is stable within a cycle. A genuine duplicate of a DELIVERED token is short-circuited above
    // before we reach here.
    const idempotencyKey = `corrective-action-${tenantSchema}-${scorecardId}-${recipient.email.toLowerCase()}-cycle-${cycleDimension}`;

    let result: SendSystemEmailResult;
    try {
      result = await sendEmail(recipient.email, email.subject, email.html, {
        text: email.text,
        idempotencyKey,
      });
      if (!result.success) throw new Error("Email provider returned unsuccessful result");
    } catch (err) {
      // The send did not succeed. Delete the token MINTED this run (its raw link never reached anyone) so it is
      // not left dangling; the retry then re-mints + re-sends a fresh, working link. `mintedTokenHash` is only
      // ever set for a token minted this run (never a reused/delivered survivor), so this is always safe.
      // Delivered recipients' tokens are untouched (we never minted for them this run).
      if (mintedTokenHash) {
        await query(
          `DELETE FROM ${tenantSchema}.scorecard_corrective_action_tokens WHERE token_hash = $1`,
          [mintedTokenHash]
        ).catch(() => undefined);
      }
      throw err;
    }
    // The send succeeded → mark the just-minted token DELIVERED, so a later retry reuses it (skips re-send)
    // instead of re-minting. A crash BEFORE this stamp leaves delivered_at NULL, so the retry re-mints a fresh
    // usable token + re-sends — exactly the crash-safe behavior finding 1 requires.
    if (mintedTokenHash) {
      await query(
        `UPDATE ${tenantSchema}.scorecard_corrective_action_tokens SET delivered_at = NOW() WHERE token_hash = $1`,
        [mintedTokenHash]
      );
    }
    logger.log("[CorrectiveActionEmail] Sent corrective-action email", {
      scorecardId,
      role: recipient.role,
      isUser: recipient.userId != null,
      messageId: result.messageId,
    });
  }

  // An ASSIGNED super/PM role that did NOT resolve into a deliverable recipient this run (inactive identity, or
  // missing/invalid email) means the delivery is INCOMPLETE: that responder was never notified. A plain
  // `return` here would leave corrective_action_email_sent_at NULL but COMPLETE the job normally — and a
  // completed queue row never re-runs, so the un-notified role would be stranded forever (nothing re-enqueues
  // on a later identity/email fix). Instead THROW so the queue RETRIES with backoff (max_attempts = 6), giving
  // the role time to be fixed; the final attempt dead-letters (a loud, inspectable give-up that #945's dead-
  // letter sweep alerts on). We deliberately do NOT stamp, so a manual requeue after dead-lettering still
  // notifies.
  //
  // The throw is SAFE against double-notifying a recipient that DID send this run. The handler runs each query
  // via pool.query (NO wrapping transaction — see the worker queue: processJob calls the handler directly and
  // only writes the job_queue outcome on the thrown error), so every delivered_at stamp already written this
  // run is committed and SURVIVES the throw. On the retry: a token recipient (email-only, or a CRM user who
  // fell back to a token) with a DELIVERED token is reuse-skipped above (no re-mint, no re-send); an undelivered
  // survivor is re-minted a FRESH usable token and re-sent, and every recipient — token or field-login CRM deep
  // link — sends under the SAME per-(scorecard,recipient) key scoped to the RETRY-STABLE cycle dimension (the
  // immutable `payload.cycleNonce`, or the within-cycle-stable fingerprint fallback), so Resend dedups the true
  // duplicate even though the re-minted token differs. Nobody is emailed twice.
  if (unresolvedAssignedRoles.length > 0) {
    logger.warn(
      "[CorrectiveActionEmail] An assigned super/PM role is unresolvable (inactive identity or missing/invalid email) - throwing to retry (not stamping)",
      { scorecardId, dealId, unresolvedAssignedRoles }
    );
    throw new Error(
      `Assigned super/PM role(s) unresolvable on deal ${dealId} (${unresolvedAssignedRoles.join(", ")}) - retrying until identity/email is fixed`,
    );
  }
  // Re-notify a FRESH corrective-action cycle WITHOUT stamping: delete the scorecard's outstanding tokens (so
  // the next run re-mints — a surviving token would be reuse-skipped as "delivered this cycle") and enqueue a
  // fresh corrective-action-email job that mirrors the server reconcile's enqueue shape (same jobType, a fresh
  // cycleNonce, run_after a short delay, max_attempts 6). Shared by BOTH not-stamp guards below (a new open
  // corrective-action item raced in, OR the super/PM recipient set changed since our read — finding 1), so the
  // re-notify behavior can't drift between them.
  const reNotifyFreshCycle = async (reason: string): Promise<void> => {
    // Mint the fresh cycle's nonce ONCE and use it in BOTH the enqueued job payload AND the scorecard's
    // persisted corrective_action_cycle_nonce, so they stay equal — mirroring the server enqueue paths. The
    // re-notified job's own stamp requires `corrective_action_cycle_nonce = payload.cycleNonce`; without
    // stamping the new nonce here the scorecard would still carry the SUPERSEDED cycle's nonce and the fresh
    // job could never stamp (permanently un-stampable). The nonce UPDATE only touches the nonce column, so it is
    // safe on the still-un-stamped card (sent_at stays NULL, so the fresh job re-sends).
    const freshNonce = crypto.randomUUID();

    // Finding A: run the token-DELETE + nonce-UPDATE + replacement-job INSERT inside ONE TRANSACTION. Previously
    // these were three auto-committed statements: if the INSERT failed (or the worker exited) after the nonce
    // UPDATE, the scorecard pointed at a fresh cycle with NO job — the OLD job's retry carries the now-superseded
    // nonce (can't pass the stamp), its has_new_open recheck is false so it completes without re-scheduling, and
    // provider idempotency may dedup its resend → the notification is permanently suppressed. Wrapping them in a
    // transaction means a transient failure rolls back the nonce bump + token delete together, leaving the
    // scorecard exactly as the original job found it so that job's retry can still stamp/handle it.
    //
    // The three statements route through `txQuery`: in production a dedicated pooled client (so BEGIN…COMMIT wrap
    // real work); in tests the injected `deps.query` (so the captured deletes/nonce-updates/enqueues stay
    // observable). BEGIN/COMMIT/ROLLBACK go through the SAME channel either way.
    const client = usesInjectedQuery ? null : await getClient();
    const txQuery: typeof query = client
      ? (client.query.bind(client) as typeof query)
      : query;
    let began = false;
    try {
      await txQuery("BEGIN");
      began = true;
      await txQuery(
        `DELETE FROM ${tenantSchema}.scorecard_corrective_action_tokens WHERE scorecard_id = $1::uuid`,
        [scorecardId]
      );
      await txQuery(
        `UPDATE ${tenantSchema}.field_scorecards SET corrective_action_cycle_nonce = $2::uuid WHERE id = $1::uuid`,
        [scorecardId, freshNonce]
      );
      await txQuery(
        `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after, max_attempts)
         VALUES ($1, $2::jsonb, $3::uuid, 'pending', NOW() + ($4 || ' seconds')::interval, 6)`,
        [
          SCORECARD_CORRECTIVE_ACTION_EMAIL_JOB,
          JSON.stringify({
            tenantSchema,
            scorecardId,
            dealId,
            officeId: payload.officeId ?? null,
            cycleNonce: freshNonce,
          }),
          payload.officeId ?? null,
          String(CORRECTIVE_ACTION_REENQUEUE_DELAY_SECONDS),
        ]
      );
      await txQuery("COMMIT");
    } catch (txErr) {
      // Roll back so a mid-transaction failure (e.g. the enqueue INSERT throws) can't leave the scorecard on a
      // fresh cycle with no job. The original job then treats this run as failed (we rethrow) and RETRIES, at
      // which point the scorecard still carries the ORIGINAL cycle's nonce/tokens and the retry can stamp/handle
      // it. ROLLBACK is best-effort — if it itself fails, still rethrow the original error.
      if (began) await txQuery("ROLLBACK").catch(() => undefined);
      throw txErr;
    } finally {
      client?.release();
    }
    logger.warn(
      "[CorrectiveActionEmail] Re-enqueued a fresh notification cycle (not stamping this run)",
      { scorecardId, dealId, reason }
    );
  };

  // Guarded delivery stamp — RECIPIENT-set race (finding 1). We emailed the super/PM set resolved into
  // `emailedRecipientSignature` at the TOP of this run. Between that read and this stamp the deal team can be
  // reassigned (a super/PM added, removed, or swapped). If so, the worker emailed the FORMER assignee (whose
  // token/access is now revoked by the verify-time assignment checks) and the NEW assignee was never notified;
  // stamping here would set corrective_action_email_sent_at, so the server reconcile (which only enqueues when
  // sent_at is NULL) would never re-notify and retries would skip → the new assignee is stranded. So RE-RESOLVE
  // the current recipient set and compare its signature; if it CHANGED, do NOT stamp — re-notify a fresh cycle
  // (delete tokens + enqueue with a new cycleNonce), exactly like the open-item-mismatch path. Cheap: one extra
  // read of the same query. This runs BEFORE the open-item guard so a reassignment is handled even when the
  // open set is unchanged.
  const revalidateRes = await query(recipientResolutionSql(tenantSchema), [dealId]);
  const currentRecipientSignature = recipientSignature(revalidateRes.rows as any[]);
  if (currentRecipientSignature !== emailedRecipientSignature) {
    await reNotifyFreshCycle(
      `super/PM recipient set changed since the worker read it (emailed "${emailedRecipientSignature}", now "${currentRecipientSignature}")`,
    );
    return;
  }

  // Guarded delivery stamp — OPEN-ITEM race (P1 notification-loss). We emailed about the open corrective-action
  // rows we READ into `flaggedRows` earlier. Between that read and this stamp, an edit can add a NEW open
  // corrective-action row for this scorecard. The server-side reconcile, seeing corrective_action_email_sent_at
  // STILL NULL, DELIBERATELY does not enqueue a fresh job — it assumes this pending worker will pick up the new
  // item. But this worker captured the OLD item list, so an UNCONDITIONAL stamp would mark the card notified
  // while the newly-added corrective action was never emailed → it stays open and is NEVER notified.
  //
  // So stamp ONLY when the CURRENT open set is a SUBSET of the ids we emailed about (no NEW open row appeared
  // since our read): the NOT EXISTS rejects the stamp if any open row's id is NOT in the emailed-id array.
  //
  // The stamp ALSO requires the card still be OPEN with ≥1 open item at stamp time (finding 6): status =
  // 'corrective_action_open' AND EXISTS(any open row). Without this, an EMPTY current open set (every item
  // resolved between our read and here) would TRIVIALLY satisfy the subset NOT EXISTS above (no open row is
  // outside the emitted set), stamping an already-closed card as notified — the exact stale-notify + suppress-
  // reconcile bug. Requiring an open item at the stamp closes that hole even if the pre-send recheck's window
  // is beaten again.
  //
  // The stamp ALSO ties this job's payload.cycleNonce to the cycle currently AWAITING delivery (P1
  // notification-cycle guard). Crash scenario: this worker crashes AFTER the provider accepts cycle A but
  // BEFORE stamping; an edit/team-mutation then starts cycle B (deletes A's tokens, sets a NEW
  // corrective_action_cycle_nonce on the scorecard). A's retry sees the provider's same-key response as
  // delivered and, unguarded, would STAMP the still-open card → cycle B's job then skips (sent_at set) → the
  // recipient's only delivered link holds a DELETED cycle-A token → permanently stranded. So when this job
  // carries a cycleNonce (all post-deploy jobs do), the stamp additionally requires the scorecard's stored
  // nonce to STILL equal it — a stale-cycle job (A) whose nonce no longer matches (now B's) updates 0 rows
  // and does NOT stamp; cycle B's matching-nonce job stamps. Legacy fallback: a card whose stored nonce is
  // NULL (pre-0197, never re-stamped) still allows the stamp so nothing regresses; and a legacy in-flight
  // job with NO payload nonce omits the clause entirely (pre-guard behavior).
  const emailedIds = flaggedRows.map((r) => String(r.id));
  const nonceClause = nonce
    ? " AND (corrective_action_cycle_nonce IS NULL OR corrective_action_cycle_nonce = $3::uuid)"
    : "";
  const stampParams: unknown[] = nonce ? [scorecardId, emailedIds, nonce] : [scorecardId, emailedIds];
  const stampRes = await query(
    `UPDATE ${tenantSchema}.field_scorecards
        SET corrective_action_email_sent_at = NOW()
      WHERE id = $1::uuid
        AND corrective_action_email_sent_at IS NULL
        AND status = 'corrective_action_open'
        AND EXISTS (
          SELECT 1 FROM ${tenantSchema}.scorecard_corrective_actions
           WHERE scorecard_id = $1::uuid AND status = 'open'
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${tenantSchema}.scorecard_corrective_actions
           WHERE scorecard_id = $1::uuid AND status = 'open' AND NOT (id = ANY($2::uuid[]))
        )${nonceClause}`,
    stampParams as any[]
  );

  // rowCount === 0 has two causes, distinguished by re-reading the card + its open set:
  //   (a) it was ALREADY stamped (sent_at now non-null) with no new item → nothing to do (a benign in-cycle
  //       double-run); or
  //   (b) the guard REJECTED the stamp because a NEW open item appeared after our read while sent_at is still
  //       NULL → this worker emailed the OLD list, so the new corrective action must be (re)notified in a FRESH
  //       cycle. The new job reads the now-larger open set and notifies about the new item.
  if ((stampRes.rowCount ?? 0) === 0) {
    const recheck = await query(
      `SELECT corrective_action_email_sent_at,
              EXISTS (
                SELECT 1 FROM ${tenantSchema}.scorecard_corrective_actions
                 WHERE scorecard_id = $1::uuid AND status = 'open' AND NOT (id = ANY($2::uuid[]))
              ) AS has_new_open
         FROM ${tenantSchema}.field_scorecards WHERE id = $1::uuid LIMIT 1`,
      [scorecardId, emailedIds]
    );
    const recheckRow = recheck.rows[0] as any;
    if (recheckRow && !recheckRow.corrective_action_email_sent_at && recheckRow.has_new_open === true) {
      // Case (b): a new open item raced in and the card is still un-stamped. Re-notify the new cycle.
      await reNotifyFreshCycle("a new corrective-action item appeared after the worker read its flagged set");
    }
    // Case (a) — already stamped, no new item — falls through: nothing to do.
  }
}

export function buildCorrectiveActionEmail(input: {
  recipientName: string;
  dealName: string;
  projectNumber: string | null;
  scoreText: string;
  ratingLabel: string | null;
  flagged: FlaggedItem[];
  link: string;
}) {
  const subject = input.projectNumber
    ? `Corrective action required: ${input.projectNumber} — ${input.scoreText}`
    : `Corrective action required: ${input.dealName} — ${input.scoreText}`;

  const itemsList = input.flagged.length
    ? input.flagged.map((f) => `• ${f.itemLabel}`).join("\n")
    : "• (see the CRM for the flagged items)";

  const htmlItems = input.flagged.length
    ? `<ul style="margin:8px 0 0 0;padding-left:20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#111111;">${input.flagged
        .map((f) => `<li>${escapeHtml(f.itemLabel)}</li>`)
        .join("")}</ul>`
    : `<p style="margin:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#64748b;">See the CRM for the flagged items.</p>`;

  const safeLink = escapeHtml(input.link);

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Corrective action required</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;">
          <tr><td style="background-color:#CC0000;height:4px;line-height:4px;font-size:4px;">&nbsp;</td></tr>
          <tr>
            <td align="center" style="padding:28px 24px 8px 24px;">
              <img src="${TROCK_LOGO_EMAIL_URL}" alt="T Rock Construction" width="220" height="246" style="display:block;width:220px;height:246px;border:0;" />
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:4px 24px 0 24px;">
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">Corrective Action Required</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 28px 0 28px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#111111;">Hi ${escapeHtml(input.recipientName)},</p>
              <p style="margin:12px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#111111;">A field scorecard for <strong>${escapeHtml(input.dealName)}</strong>${input.projectNumber ? ` (${escapeHtml(input.projectNumber)})` : ""} came in below standard (${escapeHtml(input.scoreText)}${input.ratingLabel ? ` · ${escapeHtml(input.ratingLabel)}` : ""}). Please document the corrective action taken for each flagged item:</p>
              ${htmlItems}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px;">
              <a href="${safeLink}" style="display:inline-block;background-color:#CC0000;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:44px;text-align:center;text-decoration:none;width:280px;border-radius:4px;">Document Corrective Action</a>
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
    `Corrective action required\n\n` +
    `Hi ${input.recipientName},\n\n` +
    `A field scorecard for ${input.dealName}${input.projectNumber ? ` (${input.projectNumber})` : ""} came in below standard ` +
    `(${input.scoreText}${input.ratingLabel ? ` · ${input.ratingLabel}` : ""}). Please document the corrective action taken for each flagged item:\n\n` +
    `${itemsList}\n\n` +
    `Document the corrective action: ${input.link}`;

  return { subject, html, text };
}
