import crypto from "crypto";
import { describe, expect, it, vi } from "vitest";
import { WON_DEAL_STAGE_SLUGS, LOST_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import {
  handleScorecardCorrectiveActionEmail,
  type ScorecardCorrectiveActionEmailPayload,
} from "../../src/jobs/scorecard-corrective-action-email.js";

// A real Won-family slug and a real Lost slug from the SAME shared constants the worker binds as $2/$3, so the
// cascade-regression tests exercise a genuine slug reaching the generated SQL (not a fabricated one).
const WON_TERMINAL_SLUG = WON_DEAL_STAGE_SLUGS[0];
const LOST_TERMINAL_SLUG = LOST_DEAL_STAGE_SLUGS[0];

// Mirror the worker's per-cycle fingerprint (sha256 over the sorted open corrective-action-item ids, first
// 16 hex chars) so the CRM/no-token idempotency-key assertions can be derived from the same ids the mock
// returns (finding 4).
function cycleFingerprint(ids: string[]): string {
  return crypto
    .createHash("sha256")
    .update([...ids].sort().join(","))
    .digest("hex")
    .slice(0, 16);
}

const SCORECARD = "11111111-1111-1111-1111-111111111111";
const DEAL = "22222222-2222-2222-2222-222222222222";

const payload: ScorecardCorrectiveActionEmailPayload = {
  tenantSchema: "office_dallas",
  scorecardId: SCORECARD,
  dealId: DEAL,
  officeId: "00000000-0000-0000-0000-0000000000f1",
};

const env = { NODE_ENV: "production", FRONTEND_URL: "https://trockcrm.com" } as unknown as NodeJS.ProcessEnv;

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// A recipient set: one CRM user (superintendent, WITH an enabled field login) + one email-only member
// (project_manager). can_field_login defaults to (user_id != null) unless the test overrides it — the SQL
// computes it from an enabled/non-revoked user_local_auth join; a CRM user with a field login gets the deep
// link, one without falls back to a token (finding 6).
const RECIPIENTS = [
  { role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true },
  { role: "project_manager", name: "Dana Cole", email: "dana.cole@example.com", user_id: null, can_field_login: false },
];
// Each open corrective-action row carries an id (used by the worker to derive the per-cycle fingerprint for
// the CRM/no-token idempotency key — finding 4).
const FLAGGED = [
  { id: "ca-1", item_type: "action_item", item_ref: "0", item_label: "Re-inspect slab 2" },
  { id: "ca-2", item_type: "critical_deficiency", item_ref: "missed_hold_point", item_label: "Missed hold point" },
];

// Build a query mock routing on the SQL text. `sentAt` seeds the idempotency column.
// `existingTokenEmails` makes the per-recipient "does this recipient already hold a valid token?" existence
// check return a row for those (lower-cased) emails — modelling a partial-delivery retry. `status` seeds the
// scorecard lifecycle status the snapshot reads (defaults to corrective_action_open — the only status that
// notifies; the worker skips any other).
function makeQuery(
  opts: {
    sentAt?: string | null;
    status?: string;
    recipients?: any[];
    assignedRoles?: any[];
    flagged?: any[];
    existingTokenEmails?: string[];
    // Finding 1: model an UNDELIVERED-but-live token row (crash between INSERT and the delivered_at stamp): a
    // map of lower-cased recipient email → the token_hash of that surviving row. The reuse query selects
    // token_hash + delivered_at for ANY live (unconsumed/unexpired) token; an undelivered survivor's raw value
    // can't be reconstructed, so the handler MINTS A FRESH usable token (real ?token= link) and keys off the
    // stable per-cycle key — it does NOT reuse the survivor's hash or send tokenless. Delivered survivors are
    // modeled by existingTokenEmails (they short-circuit / skip).
    undeliveredTokens?: Record<string, string>;
    // Finding 6: model the last-open-item-resolved-mid-run race. The snapshot read status = corrective_action_open
    // at the top and flaggedRows was NON-empty, but by send time the team resolved the LAST item in-app. The
    // handler re-selects the live status immediately before the send loop; when set, that pre-send recheck
    // returns this status (defaults to corrective_action_closed) and reports zero open rows → the handler must
    // RETURN without sending and without stamping.
    closedBeforeSend?: boolean;
    statusBeforeSend?: string;
    // Part B: model the notification-loss race — a NEW open corrective-action row appeared AFTER the worker read
    // its flagged set but BEFORE the final stamp. When true, the guarded stamp UPDATE affects 0 rows (its
    // NOT EXISTS subquery is falsy because a not-emitted open row exists) AND the re-check SELECT reports the
    // card is still un-stamped with a new open item present → the worker re-enqueues a fresh cycle.
    newOpenItemAppeared?: boolean;
    // Finding 1: model a super/PM REASSIGNMENT mid-run. The worker reads the recipient set at the top, then
    // RE-RESOLVES it just before the stamp. When set, the SECOND recipient-resolution query (the pre-stamp
    // revalidation) returns THIS set instead of `recipients` — a different signature → the worker must NOT
    // stamp and instead re-notify a fresh cycle. The FIRST read still returns `recipients` (who was emailed).
    revalidatedRecipients?: any[];
    // Finding 5: version-aware score + rating in the snapshot the scorecard SELECT returns. total_score is the
    // stored value (V2/leadership store average*10; V1 stores the 0–100 total); averageScore/formVersion/kind
    // drive the display. Defaults: a V1 project card scoring 60/100.
    totalScore?: number | null;
    averageScore?: number | null;
    formVersion?: number;
    kind?: string;
    rating?: string;
    // P1 notification-cycle guard: the scorecard's STORED corrective_action_cycle_nonce (the ACTIVE cycle).
    // The delivery-stamp UPDATE ANDs `(corrective_action_cycle_nonce IS NULL OR = $payloadNonce)`; when the
    // stored nonce is non-null AND differs from the job's payload.cycleNonce (a superseded/stale-cycle job),
    // the stamp matches 0 rows and does NOT stamp. When omitted (null), the stamp is unguarded on the nonce
    // (the legacy-card fallback). Set this to model cycle B superseding cycle A's crashed job.
    storedCycleNonce?: string | null;
    // Finding C: model a HIDDEN scorecard/project — a soft-deleted scorecard (is_active=false), or a deal that
    // was archived (deals.is_active=false) / moved to a Lost/terminal stage during the 120s delay. The worker's
    // opening snapshot SELECT now joins deals+psc and applies the responder's active/browsable predicate, so a
    // hidden record yields ZERO rows. When true, the snapshot SELECT (the one that also reads
    // corrective_action_cycle_nonce) returns no row → the handler must RETURN without sending or stamping.
    hiddenScorecard?: boolean;
    // P1 (round-14 cascade regression): instead of the boolean `hiddenScorecard` short-circuit, EVALUATE the
    // opening snapshot's actual generated browsable predicate against the params it is called with. The mock
    // parses the generated SQL to find which placeholder ($2/$3) sits inside `= ANY(...)` (the Won-family gate)
    // and which sits inside `<> ALL(...)` (the Lost/terminal exclusion), binds each to the corresponding params
    // array, and returns a row only when a TERMINAL deal in `evalDealStageSlug` is a member of the Won array
    // (browsable) and NOT a member of the Lost array. This makes the test exercise the exact placeholder BINDING:
    // with the cascading `.replace($1→$2).replace($2→$3)` bug, BOTH ANY() and ALL() collapse to $3 (Lost), so a
    // Won slug is compared only against the Lost array → a terminal Won deal returns no row (silently dropped).
    // The single-pass renumber binds Won→$2 / Lost→$3 correctly. `evalDealIsTerminal` defaults true (the
    // interesting case: a terminal deal is browsable ONLY via the Won branch).
    evalDealStageSlug?: string;
    evalDealIsTerminal?: boolean;
    // Finding B: the corrective_action_cycle_nonce the OPENING snapshot SELECT returns (the scorecard's CURRENT
    // active cycle). Compared to payload.cycleNonce BEFORE recipients are resolved / anything is sent; a mismatch
    // (a superseded cycle-A job) must return early with NO send and NO stamp. Distinct from `storedCycleNonce`
    // (which models the value the final STAMP sees). Defaults to null (legacy/pre-column card → early gate falls
    // through).
    snapshotCycleNonce?: string | null;
    // Finding A: make the fresh-cycle replacement's job_queue INSERT throw, modelling a transient failure mid-
    // transaction. With the atomic fix the whole transaction (token DELETE + nonce UPDATE + INSERT) rolls back,
    // so the scorecard is left unchanged (its original nonce/tokens intact) and the original job's retry can
    // still stamp/handle it.
    enqueueThrows?: boolean;
    // P2 (stale flagged-item list): model a PARTIAL resolution — ONE of several flagged items is resolved/removed
    // AFTER the worker's initial flagged read but BEFORE the send, while ANOTHER stays open. When set, the SECOND
    // read of the open corrective-action rows (the pre-send re-read the fix adds) returns THIS reduced set instead
    // of `flagged`, so the emailed body + the stamp's emitted-id array reflect only the still-open item(s). The
    // FIRST read still returns `flagged` (the stale, larger set the worker initially loaded).
    freshFlagged?: any[];
  } = {},
) {
  const inserts: { sql: string; params: any[] }[] = [];
  // Finding A: capture the transaction control statements the atomic fresh-cycle replacement issues, so tests can
  // assert BEGIN…COMMIT on the happy path and BEGIN…ROLLBACK (no COMMIT) when the enqueue throws.
  const txMarkers: string[] = [];
  // reNotifyFreshCycle issues a nonce-only `UPDATE field_scorecards SET corrective_action_cycle_nonce` before
  // the enqueue — captured separately from the delivery stamp so tests can assert the fresh cycle re-stamps
  // the scorecard's active nonce.
  const nonceUpdates: { sql: string; params: any[] }[] = [];
  const tokenDeletes: { sql: string; params: any[] }[] = [];
  const tokenDelivers: { sql: string; params: any[] }[] = [];
  // Re-enqueued corrective-action-email jobs (Part B): raw INSERT INTO public.job_queue rows.
  const jobEnqueues: { sql: string; params: any[] }[] = [];
  // existingTokenEmails model DELIVERED tokens: the reuse-skip query requires delivered_at IS NOT NULL, so
  // only a delivered token returns a row (an undelivered remnant returns nothing → the recipient is re-sent).
  const existing = new Set((opts.existingTokenEmails ?? []).map((e) => e.toLowerCase()));
  // Finding 3: lower-cased email → surviving UNDELIVERED token hash. Distinct from `existing` (delivered) so a
  // test can model the crash-window survivor the reuse path must re-use (not re-mint).
  const undelivered = new Map(
    Object.entries(opts.undeliveredTokens ?? {}).map(([e, h]) => [e.toLowerCase(), h]),
  );
  // Count calls to the recipient-resolution query (SELECT DISTINCT ON (dtm.role) ... FROM deal_team_members)
  // so the SECOND call — the pre-stamp revalidation (finding 1) — can return a reassigned set when the test
  // provides one. The `SELECT DISTINCT dtm.role` assigned-roles query is intercepted by its own branch first,
  // so it never reaches this fall-through.
  let recipientResolveCalls = 0;
  // P2: count reads of the open corrective-action rows so the SECOND read (the pre-send re-read the fix adds)
  // can return a reduced `freshFlagged` set — modelling one item resolved between the initial load and the send.
  let flaggedReadCalls = 0;
  const query = vi.fn(async (text: string, params: any[] = []) => {
    // Finding A: transaction control statements (BEGIN / COMMIT / ROLLBACK) issued by the atomic fresh-cycle
    // replacement. Captured so tests can assert the rollback path.
    const trimmed = text.trim().toUpperCase();
    if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
      txMarkers.push(trimmed);
      return { rows: [] };
    }
    // Per-recipient LIVE-token lookup (finding 1): SELECT token_hash, delivered_at FROM ...tokens WHERE
    // recipient_email = $2 AND consumed_at IS NULL AND expires_at > NOW() (NO delivered_at filter). A DELIVERED
    // survivor (existingTokenEmails) short-circuits/skips; an UNDELIVERED survivor (undeliveredTokens) OR no row
    // → mint a FRESH usable token (real ?token= link), keyed off the stable per-cycle key.
    if (/SELECT token_hash, delivered_at FROM \S*scorecard_corrective_action_tokens/i.test(text)) {
      const email = String(params[1] ?? "").toLowerCase();
      if (existing.has(email)) {
        return { rows: [{ token_hash: `delivered-hash-${email}`, delivered_at: "2026-07-01T00:00:00Z" }] };
      }
      if (undelivered.has(email)) {
        return { rows: [{ token_hash: undelivered.get(email), delivered_at: null }] };
      }
      return { rows: [] };
    }
    if (/DELETE FROM .*scorecard_corrective_action_tokens/i.test(text)) {
      tokenDeletes.push({ sql: text, params });
      return { rows: [] };
    }
    if (/INSERT INTO .*scorecard_corrective_action_tokens/i.test(text)) {
      inserts.push({ sql: text, params });
      return { rows: [] };
    }
    if (/UPDATE \S*scorecard_corrective_action_tokens SET delivered_at/i.test(text)) {
      tokenDelivers.push({ sql: text, params });
      return { rows: [] };
    }
    // Re-enqueue of a fresh corrective-action-email job (Part B): raw INSERT INTO public.job_queue.
    if (/INSERT INTO public\.job_queue/i.test(text)) {
      // Finding A: model a transient failure of the replacement-job INSERT so the surrounding transaction must
      // roll back the token DELETE + nonce UPDATE. Record the attempt (so the test can confirm the enqueue was
      // reached inside the transaction) then throw.
      jobEnqueues.push({ sql: text, params });
      if (opts.enqueueThrows) throw new Error("job_queue insert failed (transient)");
      return { rows: [], rowCount: 1 };
    }
    // reNotifyFreshCycle's nonce-only re-stamp: UPDATE field_scorecards SET corrective_action_cycle_nonce.
    // Captured separately (NOT a delivery stamp) so the cycle-guard tests can assert the fresh cycle persists
    // its new nonce. Match BEFORE the delivery-stamp branch.
    if (/UPDATE [\s\S]*field_scorecards\s+SET corrective_action_cycle_nonce/i.test(text)) {
      nonceUpdates.push({ sql: text, params });
      return { rows: [], rowCount: 1 };
    }
    // The guarded final delivery stamp: UPDATE field_scorecards SET corrective_action_email_sent_at = NOW()
    // ... with a NOT EXISTS guard against a new open item (Part B) AND (P1 cycle guard) an optional
    // `corrective_action_cycle_nonce IS NULL OR = $3` clause. The stamp matches 0 rows when EITHER a new open
    // item raced in (newOpenItemAppeared) OR the job's payload nonce ($3) no longer matches the scorecard's
    // stored non-null nonce (storedCycleNonce) — a superseded/stale-cycle job. Match BEFORE the SELECT
    // branches.
    if (/UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text)) {
      // Model the nonce guard: if the SQL carries the nonce clause ($3 present) and the stored nonce is
      // non-null and differs from the payload nonce, the stamp rejects (0 rows).
      const payloadNonce = params[2] as string | undefined;
      const stored = opts.storedCycleNonce;
      const nonceMismatch =
        payloadNonce != null && stored != null && stored !== payloadNonce;
      return { rows: [], rowCount: opts.newOpenItemAppeared || nonceMismatch ? 0 : 1 };
    }
    // Any OTHER field_scorecards UPDATE (defensive fallback) stamps 1 row.
    if (/UPDATE [\s\S]*field_scorecards/i.test(text)) {
      return { rows: [], rowCount: opts.newOpenItemAppeared ? 0 : 1 };
    }
    // Finding 6 pre-send recheck: immediately before the send loop the handler re-selects the scorecard's LIVE
    // status + a `has_open` EXISTS flag (any status = 'open' corrective-action row). Distinguished from every
    // other field_scorecards SELECT by the `has_open` column (and it is NOT `has_new_open`). When the test
    // models a mid-run closure, report the closed status + zero open rows so the handler bails without sending.
    if (/has_open/i.test(text) && !/has_new_open/i.test(text) && /FROM \S*field_scorecards/i.test(text)) {
      const closed = opts.closedBeforeSend === true;
      return {
        rows: [
          {
            status: closed ? (opts.statusBeforeSend ?? "corrective_action_closed") : "corrective_action_open",
            has_open: !closed,
          },
        ],
      };
    }
    // Part B re-check SELECT: reads corrective_action_email_sent_at + a `has_new_open` EXISTS flag to decide
    // whether a rowCount===0 stamp was a benign already-stamped double-run or the notification-loss race.
    // Distinguished from the initial snapshot SELECT by the has_new_open column. Reached only in the race.
    if (/has_new_open/i.test(text) && /FROM \S*field_scorecards/i.test(text)) {
      return {
        rows: [
          {
            corrective_action_email_sent_at: opts.newOpenItemAppeared ? null : (opts.sentAt ?? null),
            has_new_open: opts.newOpenItemAppeared === true,
          },
        ],
      };
    }
    // The assigned-super/PM-roles query (finding 4) — SELECT DISTINCT dtm.role ... deal_team_members without a
    // JOIN. Distinguished from the recipient-resolution query by the absence of user_id/email columns; return
    // the caller's assignedRoles (defaults to whatever recipients carry, i.e. every assigned role resolvable).
    if (/SELECT DISTINCT dtm\.role/i.test(text)) {
      const rows =
        opts.assignedRoles ??
        (opts.recipients ?? RECIPIENTS).map((r: any) => ({ role: r.role }));
      return { rows };
    }
    if (/FROM \S*field_scorecards/i.test(text)) {
      // Finding C: the opening snapshot SELECT joins deals + psc and applies the responder's active/browsable
      // predicate (is_active + non-terminal-or-Won + not-Lost). A HIDDEN scorecard/project yields ZERO rows, so
      // the handler bails without sending or stamping. Recognize the joined snapshot by its is_active gate.
      if (opts.hiddenScorecard && /sc\.is_active\s*=\s*true/i.test(text)) {
        return { rows: [] };
      }
      // P1 (round-14 cascade regression): when a test provides evalDealStageSlug, EVALUATE the generated
      // browsable predicate against the actual params, exercising the placeholder BINDING (not a boolean stub).
      // Parse which $-placeholder sits inside `= ANY(...)` (Won gate) and which inside `<> ALL(...)` (Lost
      // exclusion) directly from the generated SQL, then look those params up (params[n-1]). A terminal deal is
      // browsable ONLY if its slug is a member of the Won-bound array AND not a member of the Lost-bound array.
      if (opts.evalDealStageSlug !== undefined && /sc\.is_active\s*=\s*true/i.test(text)) {
        const anyMatch = text.match(/=\s*ANY\(\$(\d+)::text\[\]\)/i);
        const allMatch = text.match(/<>\s*ALL\(\$(\d+)::text\[\]\)/i);
        const wonPlaceholder = anyMatch ? Number(anyMatch[1]) : NaN;
        const lostPlaceholder = allMatch ? Number(allMatch[1]) : NaN;
        // Resolve each placeholder to the array actually bound in the params list ($n → params[n-1]).
        const wonArray = (params[wonPlaceholder - 1] as string[]) ?? [];
        const lostArray = (params[lostPlaceholder - 1] as string[]) ?? [];
        const slug = opts.evalDealStageSlug;
        const isTerminal = opts.evalDealIsTerminal ?? true;
        // Replicate the SQL: (NOT terminal OR slug ∈ wonArray) AND slug ∉ lostArray.
        const passesTerminalOrWon = !isTerminal || wonArray.includes(slug);
        const passesNotLost = !lostArray.includes(slug);
        if (!(passesTerminalOrWon && passesNotLost)) {
          return { rows: [] };
        }
      }
      return {
        rows: [
          {
            status: opts.status ?? "corrective_action_open",
            corrective_action_email_sent_at: opts.sentAt ?? null,
            deal_id: DEAL,
            project_number: "DFW-10432",
            total_score: opts.totalScore === undefined ? 60 : opts.totalScore,
            average_score: opts.averageScore ?? null,
            rating: opts.rating ?? "corrective_action",
            form_version: opts.formVersion ?? 1,
            kind: opts.kind ?? "project",
            week_of: "2026-06-30",
            // Finding B: the scorecard's CURRENT active cycle nonce the handler compares to payload.cycleNonce
            // before sending. Defaults null (legacy card → early gate falls through).
            corrective_action_cycle_nonce: opts.snapshotCycleNonce ?? null,
          },
        ],
      };
    }
    if (/FROM \S*deal_team_members/i.test(text)) {
      recipientResolveCalls += 1;
      // The SECOND recipient-resolution call is the pre-stamp revalidation (finding 1). If the test supplies a
      // reassigned set, return it there so its signature differs from the first (emailed) read.
      const base =
        recipientResolveCalls >= 2 && opts.revalidatedRecipients
          ? opts.revalidatedRecipients
          : (opts.recipients ?? RECIPIENTS);
      // Default can_field_login when a test's inline recipient omits it: a CRM user (user_id set) is assumed
      // to hold an enabled field login (→ deep link) unless the test explicitly says otherwise; an email-only
      // member (user_id null) can never field-login. The SQL computes this from the user_local_auth join
      // (enabled + non-revoked + NOT must_change_password).
      const rows = base.map((r: any) => ({
        ...r,
        can_field_login: r.can_field_login ?? r.user_id != null,
      }));
      return { rows };
    }
    if (/FROM \S*scorecard_corrective_actions/i.test(text)) {
      flaggedReadCalls += 1;
      // P2: the SECOND read of the open rows is the pre-send re-read. If the test models a partial resolution,
      // return the reduced `freshFlagged` set there so the emailed body reflects only the still-open item(s).
      if (flaggedReadCalls >= 2 && opts.freshFlagged) {
        return { rows: opts.freshFlagged };
      }
      return { rows: opts.flagged ?? FLAGGED };
    }
    if (/FROM \S*deals/i.test(text)) {
      return { rows: [{ name: "Maple Street Tower", deal_number: "DFW-10432", project_number: "DFW-10432" }] };
    }
    return { rows: [] };
  });
  return { query, inserts, tokenDeletes, tokenDelivers, jobEnqueues, nonceUpdates, txMarkers };
}

describe("scorecard corrective-action notification email", () => {
  it("sends one email per recipient, with a token link for email-only and a deep link for the CRM user", async () => {
    const { query, inserts } = makeQuery();
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(sendEmail).toHaveBeenCalledTimes(2);

    // Recipients addressed once each.
    const toAddresses = sendEmail.mock.calls.map((c) => c[0]);
    expect(toAddresses).toContain("sam.super@trock.com");
    expect(toAddresses).toContain("dana.cole@example.com");

    // The email-only PM got exactly one token minted.
    expect(inserts).toHaveLength(1);

    // CRM user email carries the app deep link; email-only carries the tokenized web URL.
    const superCall = sendEmail.mock.calls.find((c) => c[0] === "sam.super@trock.com")!;
    const pmCall = sendEmail.mock.calls.find((c) => c[0] === "dana.cole@example.com")!;
    const superText = superCall[3].text as string;
    const pmText = pmCall[3].text as string;
    expect(superText).toContain(`trockcam://scorecards/corrective-action/${SCORECARD}`);
    expect(pmText).toContain(`https://trockcrm.com/scorecards/${SCORECARD}/corrective-action?token=`);

    // Flagged items appear in the body.
    expect(superCall[2]).toContain("Re-inspect slab 2");
    expect(superCall[2]).toContain("Missed hold point");

    // Idempotency key is scoped to the corrective-action CYCLE via the SAME per-(scorecard, recipient) cycle
    // key for BOTH recipient kinds (finding 1): the email-only PM's key is (scorecard, email) PLUS the per-cycle
    // fingerprint — NOT the minted token hash. Scoping off the cycle (not the token) keeps the key stable across
    // a crash-window retry that mints a fresh usable token, while a reopen (fresh cycle → fresh open rows/nonce)
    // still produces a DIFFERENT key so the updated email is sent.
    const fp = cycleFingerprint(FLAGGED.map((f) => f.id));
    expect(pmCall[3].idempotencyKey).toContain(SCORECARD);
    expect(pmCall[3].idempotencyKey).toBe(
      `corrective-action-office_dallas-${SCORECARD}-dana.cole@example.com-cycle-${fp}`,
    );

    // The CRM user (no token) key is (scorecard, recipient) PLUS the per-cycle fingerprint (finding 4): their
    // deep link is cycle-stable but the flagged-item email body changes each cycle, so the key must differ
    // across cycles to avoid a Resend same-key/different-payload false-dedup. The fingerprint is a hash over
    // the current open corrective-action-item ids (FLAGGED's ids).
    expect(superCall[3].idempotencyKey).toBe(
      `corrective-action-office_dallas-${SCORECARD}-sam.super@trock.com-cycle-${fp}`,
    );
  });

  it("uses a DIFFERENT idempotency key for the same email-only recipient across two corrective-action cycles (finding 1)", async () => {
    // A reopen (open→resolve→close, then edit-reopen) re-enqueues a fresh job (fresh cycleNonce) and inserts
    // fresh-UUID open rows. The Resend idempotency key must differ across cycles (else Resend sees the same key
    // with a different payload → invalid_idempotent_request → sendSystemEmailWithMetadata treats it as delivered
    // → the worker stamps while the responder never got the updated link). The key is scoped to the per-cycle
    // DIMENSION (cycleNonce, falling back to the open-row fingerprint), which is what differs across cycles — NOT
    // the minted token hash (that would drift across a crash-window retry that re-mints, finding 1). Model two
    // cycles as distinct cycleNonces and assert the two email-only keys differ.
    const emailOnlyPm = [{ role: "project_manager", name: "Dana Cole", email: "dana.cole@example.com", user_id: null }];

    const cycle1 = makeQuery({ recipients: emailOnlyPm, assignedRoles: [{ role: "project_manager" }], existingTokenEmails: [] });
    const send1 = vi.fn().mockResolvedValue({ success: true, messageId: "m1" });
    await handleScorecardCorrectiveActionEmail({ ...payload, cycleNonce: "cycle-nonce-1" }, null, { query: cycle1.query as any, sendEmail: send1, env, logger: makeLogger() });

    const cycle2 = makeQuery({ recipients: emailOnlyPm, assignedRoles: [{ role: "project_manager" }], existingTokenEmails: [] });
    const send2 = vi.fn().mockResolvedValue({ success: true, messageId: "m2" });
    await handleScorecardCorrectiveActionEmail({ ...payload, cycleNonce: "cycle-nonce-2" }, null, { query: cycle2.query as any, sendEmail: send2, env, logger: makeLogger() });

    const key1 = send1.mock.calls[0][3].idempotencyKey as string;
    const key2 = send2.mock.calls[0][3].idempotencyKey as string;
    // Both are the per-(scorecard, recipient) cycle key scoped to their own cycleNonce — which differs per cycle.
    expect(key1).toBe(`corrective-action-office_dallas-${SCORECARD}-dana.cole@example.com-cycle-cycle-nonce-1`);
    expect(key2).toBe(`corrective-action-office_dallas-${SCORECARD}-dana.cole@example.com-cycle-cycle-nonce-2`);
    expect(key1).not.toBe(key2);
    // A fresh usable token is minted each cycle (the link always carries a real ?token=, never tokenless).
    expect(cycle1.inserts).toHaveLength(1);
    expect(cycle2.inserts).toHaveLength(1);
  });

  it("scopes the CRM (no-token) key per CYCLE: two cycles differ, a same-cycle retry matches (finding 4)", async () => {
    // A field-login CRM user gets a stable deep link but a per-cycle email PAYLOAD (the flagged-item list).
    // The idempotency key must therefore differ ACROSS cycles (so Resend doesn't false-dedup the updated
    // email) yet be STABLE within a cycle (so a genuine in-cycle retry still dedups the true duplicate). The
    // per-cycle dimension is a fingerprint over the CURRENT open corrective-action-item ids — a reopen / new
    // flag always inserts fresh-UUID open rows, so the fingerprint changes; an in-cycle retry reads the same
    // open-item set → the same fingerprint.
    const crmSuper = [
      { role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true },
    ];
    const assigned = [{ role: "superintendent" }];

    // Cycle 1 open items: ids [ca-1].
    const cycle1 = makeQuery({ recipients: crmSuper, assignedRoles: assigned, flagged: [{ id: "ca-1", item_type: "action_item", item_ref: "0", item_label: "Re-inspect slab 2" }] });
    const send1 = vi.fn().mockResolvedValue({ success: true, messageId: "m1" });
    await handleScorecardCorrectiveActionEmail(payload, null, { query: cycle1.query as any, sendEmail: send1, env, logger: makeLogger() });

    // A SAME-cycle retry: identical open-item set [ca-1] → identical key (Resend dedups the true duplicate).
    const cycle1Retry = makeQuery({ recipients: crmSuper, assignedRoles: assigned, flagged: [{ id: "ca-1", item_type: "action_item", item_ref: "0", item_label: "Re-inspect slab 2" }] });
    const send1Retry = vi.fn().mockResolvedValue({ success: true, messageId: "m1r" });
    await handleScorecardCorrectiveActionEmail(payload, null, { query: cycle1Retry.query as any, sendEmail: send1Retry, env, logger: makeLogger() });

    // Cycle 2 (a reopen / new flag): a FRESH open row id [ca-2] (reconcile inserts fresh-UUID rows each cycle).
    const cycle2 = makeQuery({ recipients: crmSuper, assignedRoles: assigned, flagged: [{ id: "ca-2", item_type: "action_item", item_ref: "1", item_label: "Re-inspect slab 5" }] });
    const send2 = vi.fn().mockResolvedValue({ success: true, messageId: "m2" });
    await handleScorecardCorrectiveActionEmail(payload, null, { query: cycle2.query as any, sendEmail: send2, env, logger: makeLogger() });

    const key1 = send1.mock.calls[0][3].idempotencyKey as string;
    const key1Retry = send1Retry.mock.calls[0][3].idempotencyKey as string;
    const key2 = send2.mock.calls[0][3].idempotencyKey as string;

    // No token minted for a field-login CRM user (deep link only).
    expect(cycle1.inserts).toHaveLength(0);
    // Same cycle → same key.
    expect(key1).toBe(`corrective-action-office_dallas-${SCORECARD}-sam.super@trock.com-cycle-${cycleFingerprint(["ca-1"])}`);
    expect(key1Retry).toBe(key1);
    // Different cycle (different open-item ids) → different key.
    expect(key2).toBe(`corrective-action-office_dallas-${SCORECARD}-sam.super@trock.com-cycle-${cycleFingerprint(["ca-2"])}`);
    expect(key2).not.toBe(key1);
  });

  it("falls a CRM user with NO enabled field login back to a tokenized web link (finding 6)", async () => {
    // A super/PM who is an ACTIVE CRM user (user_id set) but has no enabled field login (can_field_login
    // false) cannot authenticate in T-Rock Cam — loginFieldUser requires an enabled user_local_auth row — so a
    // bare deep link would strand them. They must instead get a minted recipient-bound token + web link (their
    // public.users email is the recipient email, which verify-time revalidation matches to their own active
    // assignment). A CRM user WITH an enabled field login still gets the deep link + no token.
    const { query, inserts } = makeQuery({
      recipients: [
        { role: "superintendent", name: "Can Login", email: "can.login@trock.com", user_id: "u-can", can_field_login: true },
        { role: "project_manager", name: "No Login", email: "no.login@trock.com", user_id: "u-no", can_field_login: false },
      ],
      assignedRoles: [{ role: "superintendent" }, { role: "project_manager" }],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(sendEmail).toHaveBeenCalledTimes(2);
    const canCall = sendEmail.mock.calls.find((c) => c[0] === "can.login@trock.com")!;
    const noCall = sendEmail.mock.calls.find((c) => c[0] === "no.login@trock.com")!;

    // The field-login user keeps the app deep link (no token minted for them).
    expect((canCall[3].text as string)).toContain(`trockcam://scorecards/corrective-action/${SCORECARD}`);
    // The non-field-login user falls back to the tokenized web link.
    expect((noCall[3].text as string)).toContain(
      `https://trockcrm.com/scorecards/${SCORECARD}/corrective-action?token=`,
    );
    expect((noCall[3].text as string)).not.toContain("trockcam://");

    // Exactly ONE token minted — for the non-field-login CRM user (their public.users email), none for the
    // field-login user.
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[2]).toBe("no.login@trock.com");
    // The fallback recipient's key is the per-(scorecard, recipient) cycle-fingerprint key, exactly like an
    // email-only member (finding 1: NOT the token hash).
    const fp = cycleFingerprint(FLAGGED.map((f) => f.id));
    expect(noCall[3].idempotencyKey).toBe(
      `corrective-action-office_dallas-${SCORECARD}-no.login@trock.com-cycle-${fp}`,
    );
    // The field-login user's key is the CRM (no-token) per-cycle-fingerprint key.
    expect(canCall[3].idempotencyKey).toBe(
      `corrective-action-office_dallas-${SCORECARD}-can.login@trock.com-cycle-${fp}`,
    );
  });

  it("is idempotent: skips entirely when the scorecard was already notified", async () => {
    const { query, inserts } = makeQuery({ sentAt: "2026-07-01T00:00:00Z" });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("sends to the resolvable recipient but THROWS when an assigned recipient has no email (finding 4)", async () => {
    // The PM role IS assigned but has a blank email, so it never resolves into a deliverable recipient. The
    // super is delivered, but the assigned PM was NOT — the handler THROWS so the queue retries (a plain return
    // would COMPLETE the row and strand the PM forever) and does NOT stamp.
    const { query } = makeQuery({
      recipients: [
        { role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1" },
        { role: "project_manager", name: "No Email", email: "   ", user_id: null },
      ],
      // Both roles are assigned; only the super resolves (the PM's email is blank).
      assignedRoles: [{ role: "superintendent" }, { role: "project_manager" }],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await expect(
      handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger }),
    ).rejects.toThrow(/unresolvable/i);

    // The resolvable super was still delivered before the throw.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe("sam.super@trock.com");
    // Not stamped — a later requeue (after the PM's email is fixed) can still notify them.
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(0);
  });

  it("STAMPS when only ONE role is assigned and it was delivered (finding 4: single-role deal is complete)", async () => {
    // A deal legitimately has only a superintendent assigned (no PM). Once the super is delivered there is
    // nothing owed for the unassigned PM role, so the scorecard-level stamp IS written.
    const { query } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1" }],
      assignedRoles: [{ role: "superintendent" }],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(1);
  });

  it("THROWS (does not complete-as-success) when a role is ASSIGNED but currently UNRESOLVABLE (finding 4)", async () => {
    // The PM role IS assigned (an active deal_team_members row) but its identity is unresolvable this run — e.g.
    // an inactive user/contact, so it never appears in the resolved-recipient set (which drops inactive
    // identities). The super was delivered, but the assigned PM was NOT — delivery is INCOMPLETE. A plain return
    // would COMPLETE the queue row (never re-runnable) and strand the un-notified PM forever, so the handler
    // THROWS → the queue retries with backoff up to max_attempts, then dead-letters. It must NOT stamp, and the
    // resolvable super must still have been delivered this run (the throw comes AFTER their send).
    const { query } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1" }],
      assignedRoles: [{ role: "superintendent" }, { role: "project_manager" }],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await expect(
      handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger }),
    ).rejects.toThrow(/unresolvable/i);

    // The resolvable super WAS delivered before the throw (delivered_at stamps run via pool.query with no
    // wrapping transaction, so they survive the throw).
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe("sam.super@trock.com");
    // Never stamped — a later requeue (once the PM's identity/email is fixed) still notifies the stranded PM.
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(0);
  });

  it("on the retry after an unresolvable-role throw, an already-DELIVERED email-only recipient is NOT re-sent (finding 4)", async () => {
    // Model the RETRY run: the super was delivered on the prior attempt (holds a DELIVERED token) and the PM is
    // still assigned-but-unresolvable. The handler must NOT re-send the delivered super (reuse-skip on their
    // DELIVERED token — no re-mint, no re-send, key never rebuilt) yet STILL throw because the PM is unresolved.
    const { query, inserts, tokenDeletes } = makeQuery({
      recipients: [{ role: "superintendent", name: "Ext Super", email: "ext.super@example.com", user_id: null }],
      assignedRoles: [{ role: "superintendent" }, { role: "project_manager" }],
      existingTokenEmails: ["ext.super@example.com"], // delivered on the prior attempt
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await expect(
      handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger }),
    ).rejects.toThrow(/unresolvable/i);

    // The delivered super is reused (not re-sent, not re-minted, not deleted); still no stamp.
    expect(sendEmail).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(tokenDeletes).toHaveLength(0);
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(0);
  });

  it("marks a freshly-minted email-only token DELIVERED only AFTER a successful send (finding 5)", async () => {
    const { query, inserts, tokenDelivers } = makeQuery({
      recipients: [{ role: "project_manager", name: "Dana Cole", email: "dana.cole@example.com", user_id: null }],
      assignedRoles: [{ role: "project_manager" }],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    // One token minted, then stamped delivered_at (by the SAME token_hash) after the send succeeded.
    expect(inserts).toHaveLength(1);
    expect(tokenDelivers).toHaveLength(1);
    expect(tokenDelivers[0].params[0]).toBe(inserts[0].params[1]); // delivered by the minted token_hash
  });

  it("does NOT mark delivered_at when the send FAILS — token stays undelivered so a retry re-sends (finding 5)", async () => {
    const { query, inserts, tokenDelivers, tokenDeletes } = makeQuery({
      recipients: [{ role: "project_manager", name: "Dana Cole", email: "dana.cole@example.com", user_id: null }],
      assignedRoles: [{ role: "project_manager" }],
    });
    const sendEmail = vi.fn().mockRejectedValue(new Error("provider down"));
    const logger = makeLogger();

    await expect(
      handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger }),
    ).rejects.toThrow(/provider down/);

    expect(inserts).toHaveLength(1);
    // The failed send deletes the token and NEVER stamps delivered_at.
    expect(tokenDeletes).toHaveLength(1);
    expect(tokenDelivers).toHaveLength(0);
  });

  it("MINTS a fresh token for an email-only recipient who holds NO live token (finding 5: crash-safe)", async () => {
    // No live token row exists for the recipient (neither delivered nor undelivered) — e.g. a first send, or a
    // failed send whose cleanup delete landed. The reuse lookup finds nothing → the recipient is minted + sent
    // a fresh, working link. (The DISTINCT finding-3 case — a surviving UNDELIVERED token — is covered below.)
    const { query, inserts, tokenDelivers } = makeQuery({
      recipients: [{ role: "project_manager", name: "Dana Cole", email: "dana.cole@example.com", user_id: null }],
      assignedRoles: [{ role: "project_manager" }],
      existingTokenEmails: [], // no delivered token
      // undeliveredTokens omitted → no live token at all
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    // Minted: a fresh token minted + delivered, the recipient emailed.
    expect(inserts).toHaveLength(1);
    expect(tokenDelivers).toHaveLength(1);
    expect(sendEmail.mock.calls.map((c) => c[0])).toEqual(["dana.cole@example.com"]);
  });

  // ---- Finding 1: keep the retry link USABLE across the delivery-stamp crash window ----

  it("mints a FRESH usable token (WITH a ?token= link) on a crash-window retry — never tokenless (finding 1)", async () => {
    // The crash window: the provider may have ACCEPTED the email but the worker crashed before stamping
    // delivered_at, so a live token survives with delivered_at NULL. The token's raw value is hashed at rest and
    // can't be reconstructed, so it CANNOT rebuild a usable link. The round-11 behavior reused the surviving
    // hash as the key AND sent a TOKENLESS link — an unusable link for the email-only recipient. The finding-1
    // fix instead MINTS A FRESH usable token so the link always carries a real `?token=`, and scopes the Resend
    // idempotency key to the STABLE per-cycle key (email + cycleNonce) — unchanged across the crash-retry
    // regardless of which token instance backs the link — so the provider still dedups the true duplicate.
    const SURVIVING_HASH = "surviving-undelivered-hash-abc123";
    const NONCE = "cycle-nonce-crash";
    const { query, inserts, tokenDelivers } = makeQuery({
      recipients: [{ role: "project_manager", name: "Dana Cole", email: "dana.cole@example.com", user_id: null }],
      assignedRoles: [{ role: "project_manager" }],
      undeliveredTokens: { "dana.cole@example.com": SURVIVING_HASH },
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail({ ...payload, cycleNonce: NONCE }, null, { query: query as any, sendEmail, env, logger });

    // The recipient was (re-)sent to — Resend dedups on the stable cycle key, so this is safe.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe("dana.cole@example.com");
    // The link ALWAYS carries a real ?token= (never a tokenless URL) — the whole point of finding 1.
    const text = sendEmail.mock.calls[0][3].text as string;
    expect(text).toMatch(new RegExp(`https://trockcrm\\.com/scorecards/${SCORECARD}/corrective-action\\?token=[A-Za-z0-9_-]+`));
    // The idempotency key is the STABLE per-cycle key (email + cycleNonce) — NOT the surviving token hash — so it
    // is unchanged across the crash-retry even though a fresh token is minted, and the provider dedups the dup.
    expect(sendEmail.mock.calls[0][3].idempotencyKey).toBe(
      `corrective-action-office_dallas-${SCORECARD}-dana.cole@example.com-cycle-${NONCE}`,
    );
    // A FRESH token IS minted (the survivor's raw value can't be reconstructed to rebuild a usable link).
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[2]).toBe("dana.cole@example.com");
    // The freshly-minted token (NOT the surviving hash) is stamped delivered after the successful send.
    expect(tokenDelivers).toHaveLength(1);
    expect(tokenDelivers[0].params[0]).toBe(inserts[0].params[1]);
    expect(tokenDelivers[0].params[0]).not.toBe(SURVIVING_HASH);
  });

  it("SKIPS (no re-send) when a surviving token is already DELIVERED (finding 1)", async () => {
    // Round-4 behavior preserved: a live token with delivered_at NOT NULL short-circuits — no re-send, no mint.
    const { query, inserts, tokenDelivers } = makeQuery({
      recipients: [{ role: "project_manager", name: "Dana Cole", email: "dana.cole@example.com", user_id: null }],
      assignedRoles: [{ role: "project_manager" }],
      existingTokenEmails: ["dana.cole@example.com"], // delivered survivor
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(tokenDelivers).toHaveLength(0);
  });

  it("stamps corrective_action_email_sent_at exactly once after sending", async () => {
    const { query } = makeQuery();
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(1);
    expect(stampCalls[0][0]).toMatch(/corrective_action_email_sent_at/i);
  });

  it("THROWS (does not complete-as-success) when there are no resolvable recipients, so the queue retries", async () => {
    // Finding 7: zero super/PM-with-email is usually transient (team assigned shortly after filing). A
    // success-return would drop the notification forever, so the handler THROWS a retryable error → the queue
    // retries with backoff up to max_attempts, then dead-letters. It must not send, mint, or stamp.
    const { query, inserts, tokenDeletes } = makeQuery({ recipients: [] });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await expect(
      handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger }),
    ).rejects.toThrow(/No superintendent\/project-manager with an email/i);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(tokenDeletes).toHaveLength(0);
    // No stamp on a no-recipient throw — a later assignment + requeue can still notify.
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(0);
  });

  it("skips entirely (no email, no error) when the card is no longer corrective_action_open", async () => {
    // Finding 5: the job runs after a delay. If an edit lifted the card above-band (status 'submitted') or the
    // team resolved it in-app first (status 'corrective_action_closed'), there is nothing to notify — complete
    // cleanly without sending or stamping. Verify BOTH non-open statuses.
    for (const status of ["submitted", "corrective_action_closed"]) {
      const { query, inserts, tokenDeletes } = makeQuery({ status });
      const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
      const logger = makeLogger();

      await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });
      expect(sendEmail, `status=${status}`).not.toHaveBeenCalled();
      expect(inserts, `status=${status}`).toHaveLength(0);
      expect(tokenDeletes, `status=${status}`).toHaveLength(0);
      // No recipient resolution even happens — the handler returns right after the snapshot read.
      const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
      expect(stampCalls, `status=${status}`).toHaveLength(0);
    }
  });

  it("does NOT send and does NOT stamp when the last open item is resolved before the flagged read (finding 5)", async () => {
    // Race: the snapshot read `status = corrective_action_open` at the top of the run, but by the time the
    // handler queries the open corrective-action rows the team resolved the LAST item in-app → the flagged set
    // is EMPTY. Continuing would send a misleading "Corrective action required" email built on the empty-fallback
    // item text, and the final subset-guarded stamp would trivially succeed (an empty current-open set satisfies
    // the NOT EXISTS) — marking a concurrently-COMPLETED action as still required and suppressing any re-notify.
    // The handler must instead RETURN without sending and without stamping.
    const { query, inserts, tokenDeletes, jobEnqueues } = makeQuery({
      status: "corrective_action_open", // passes the top-of-run open guard
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
      flagged: [], // the race: no open items remain at send time
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    // No email built on the empty-fallback item text.
    expect(sendEmail).not.toHaveBeenCalled();
    // No token minted, none deleted.
    expect(inserts).toHaveLength(0);
    expect(tokenDeletes).toHaveLength(0);
    // No stamp of corrective_action_email_sent_at (a concurrently-completed action must not be announced).
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(0);
    // No re-notify enqueue either.
    expect(jobEnqueues).toHaveLength(0);
    // The empty-open-set guard re-read the scorecard's live status before bailing.
    const statusRecheck = query.mock.calls.filter(
      ([text]) => /SELECT status FROM \S*field_scorecards/i.test(text as string),
    );
    expect(statusRecheck.length).toBeGreaterThanOrEqual(1);
  });

  // ---- Finding 6: re-validate closure IMMEDIATELY before sending + require an open card at the stamp ----

  it("does NOT send and does NOT stamp when the last open item is resolved AFTER the flagged read but before send (finding 6)", async () => {
    // The empty-flaggedRows guard (finding 5) only covers closure BEFORE the flagged-row query. Here flaggedRows
    // is read NON-empty, but the LAST open item is resolved AFTER that read and BEFORE the send loop. Without the
    // pre-send recheck the worker would send a stale "corrective action required" email for an already-closed card
    // AND the subset-guarded stamp (empty open set trivially satisfies the NOT EXISTS) would mark it notified. The
    // handler must re-select the LIVE status immediately before the send loop and, seeing it is no longer
    // corrective_action_open (zero open rows), RETURN without sending and without stamping.
    const { query, inserts, tokenDeletes, jobEnqueues } = makeQuery({
      status: "corrective_action_open", // top-of-run snapshot is still open
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
      flagged: FLAGGED, // NON-empty at the flagged read — the finding-5 empty guard does NOT fire
      closedBeforeSend: true, // but by send time the card closed (the pre-send recheck reports non-open/no-open)
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    // No stale corrective-action email went out.
    expect(sendEmail).not.toHaveBeenCalled();
    // Nothing minted, nothing deleted, no re-enqueue.
    expect(inserts).toHaveLength(0);
    expect(tokenDeletes).toHaveLength(0);
    expect(jobEnqueues).toHaveLength(0);
    // NOT stamped — a concurrently-closed card must not be marked notified (which would suppress a later reopen).
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(0);
    // The pre-send recheck (status + has_open) ran before the send loop.
    const preSendRecheck = query.mock.calls.filter(
      ([text]) => /has_open/i.test(text as string) && !/has_new_open/i.test(text as string),
    );
    expect(preSendRecheck.length).toBeGreaterThanOrEqual(1);
  });

  it("bails before sending when the pre-send recheck shows the card was lifted above-band (status submitted) (finding 6)", async () => {
    // A mid-run edit lifts the card above-band (status → submitted) after the flagged read. The pre-send recheck
    // reports a non-open status → the handler bails without sending or stamping, even though flaggedRows was
    // non-empty when read.
    const { query, inserts, jobEnqueues } = makeQuery({
      status: "corrective_action_open",
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
      flagged: FLAGGED,
      closedBeforeSend: true,
      statusBeforeSend: "submitted",
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(jobEnqueues).toHaveLength(0);
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(0);
  });

  it("still sends + stamps normally when the card is STILL open at the pre-send recheck (finding 6)", async () => {
    // The normal open case: the pre-send recheck confirms the card is still corrective_action_open with open rows,
    // so the send + stamp proceed. The stamp UPDATE additionally requires the card still has an open item /
    // status corrective_action_open (so an empty open set can no longer trivially satisfy the guard).
    const { query, tokenDeletes, jobEnqueues } = makeQuery({
      status: "corrective_action_open",
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
      // closedBeforeSend omitted → the pre-send recheck reports still-open with open rows.
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(1);
    // The strengthened stamp requires the card still be open at stamp time (an empty open set must NOT stamp).
    expect(stampCalls[0][0]).toMatch(/corrective_action_open/i);
    expect(tokenDeletes).toHaveLength(0);
    expect(jobEnqueues).toHaveLength(0);
  });

  // ---- P2: the emailed item list must reflect the CURRENT open set at send time (no stale list) ----

  it("emails only the still-open item when one flagged item is resolved after the initial read (P2)", async () => {
    // Partial-resolution race: the worker loads the open items [ca-1, ca-2] to build the body, but before it
    // sends, ca-1 is resolved/removed while ca-2 stays open. The round-14 pre-send recheck only tests for the
    // EXISTENCE of any open row (has_open) so it still passes, and the subset-guarded stamp accepts the reduced
    // open set — so unguarded the worker would email the STALE list (naming ca-1, which the responder page no
    // longer shows open) AND stamp the cycle. The fix re-reads the open rows immediately before building/sending
    // and builds the body from that FRESH set, so the delivered email lists only ca-2 — never the resolved ca-1.
    const { query } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
      flagged: [
        { id: "ca-1", item_type: "action_item", item_ref: "0", item_label: "Re-inspect slab 2" },
        { id: "ca-2", item_type: "critical_deficiency", item_ref: "missed_hold_point", item_label: "Missed hold point" },
      ],
      // ca-1 was resolved between the initial read and the send; only ca-2 remains open at send time.
      freshFlagged: [
        { id: "ca-2", item_type: "critical_deficiency", item_ref: "missed_hold_point", item_label: "Missed hold point" },
      ],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const html = sendEmail.mock.calls[0][2] as string;
    const text = sendEmail.mock.calls[0][3].text as string;
    // The delivered email reflects only the still-open item ...
    expect(text).toContain("Missed hold point");
    expect(html).toContain("Missed hold point");
    // ... and NEVER the resolved item (the stale list must not go out).
    expect(text).not.toContain("Re-inspect slab 2");
    expect(html).not.toContain("Re-inspect slab 2");
    // The stamp's emitted-id array carries only the still-open id (so the subset guard reflects what was emailed).
    const stampCalls = query.mock.calls.filter(([t]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(t as string));
    expect(stampCalls).toHaveLength(1);
    expect(stampCalls[0][1]?.[1]).toEqual(["ca-2"]);
  });

  it("bails without sending or stamping when the LAST open item is resolved at the pre-send re-read (P2)", async () => {
    // Edge of the same race: the initial flagged read saw [ca-1], but by the pre-send re-read every item was
    // resolved → the fresh open set is EMPTY. The worker must bail via the empty/hidden guard: no stale email
    // (which would name the resolved ca-1), no token mint, no stamp (a concurrently-completed action must not be
    // announced or suppress a later reopen).
    const { query, inserts, jobEnqueues } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
      flagged: [{ id: "ca-1", item_type: "action_item", item_ref: "0", item_label: "Re-inspect slab 2" }],
      freshFlagged: [], // every item resolved by the pre-send re-read
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(jobEnqueues).toHaveLength(0);
    const stampCalls = query.mock.calls.filter(([t]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(t as string));
    expect(stampCalls).toHaveLength(0);
  });

  it("emails the FULL list when the open set is unchanged between the initial read and send (P2 non-regression)", async () => {
    // The unchanged case: the pre-send re-read returns the same open set the initial read did, so the full list
    // is delivered exactly as before. (freshFlagged omitted → the second read returns the same `flagged`.)
    const { query } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
      flagged: FLAGGED,
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const text = sendEmail.mock.calls[0][3].text as string;
    expect(text).toContain("Re-inspect slab 2");
    expect(text).toContain("Missed hold point");
    const stampCalls = query.mock.calls.filter(([t]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(t as string));
    expect(stampCalls).toHaveLength(1);
    expect(stampCalls[0][1]?.[1]).toEqual(FLAGGED.map((f) => f.id));
  });

  it("re-sends on a REOPEN cycle (stamp cleared) even though a prior-cycle token would still exist", async () => {
    // Finding 6: a reopen clears corrective_action_email_sent_at AND (server-side reconcile) deletes the prior
    // cycle's tokens, so the worker no longer finds a stale token to reuse-skip on. Model the post-reopen state:
    // stamp is NULL (fresh cycle) and NO existing token → the email-only recipient IS re-minted + re-emailed.
    const { query, inserts, tokenDeletes } = makeQuery({
      sentAt: null,
      status: "corrective_action_open",
      recipients: [
        { role: "project_manager", name: "Dana Cole", email: "dana.cole@example.com", user_id: null },
      ],
      existingTokenEmails: [], // reconcile deleted the prior-cycle token
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    // The email-only PM is re-minted + re-emailed on the reopen (not stranded on the deleted prior-cycle link).
    expect(inserts).toHaveLength(1);
    expect(tokenDeletes).toHaveLength(0);
    const toAddresses = sendEmail.mock.calls.map((c) => c[0]);
    expect(toAddresses).toEqual(["dana.cole@example.com"]);
  });

  it("does NOT blanket-delete tokens on a fresh run (no orphan-cleanup delete)", async () => {
    // The old handler blanket-deleted all of the scorecard's unexpired tokens before minting. That stranded an
    // already-delivered recipient on a retry. There is now NO up-front delete — rotation is per-recipient.
    const { query, inserts, tokenDeletes } = makeQuery();
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(tokenDeletes).toHaveLength(0);
    // The email-only PM still gets exactly one fresh token minted.
    expect(inserts).toHaveLength(1);
  });

  it("retry after a partial delivery REUSES the delivered recipient's token (no re-mint, no re-send)", async () => {
    // Finding 7: recipient A (email-only PM) was delivered on a prior attempt (holds a valid token); B failed.
    // On retry, A's token must NOT be deleted or re-minted, and A must NOT be re-sent (the Resend idempotency
    // key would suppress it anyway, stranding A on a deleted link). Model A already holding a token.
    const { query, inserts, tokenDeletes } = makeQuery({
      recipients: [
        { role: "project_manager", name: "Dana Cole", email: "dana.cole@example.com", user_id: null },
        { role: "superintendent", name: "Ext Super", email: "ext.super@example.com", user_id: null },
      ],
      existingTokenEmails: ["dana.cole@example.com"], // A already delivered
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    // A (dana) is reused: not re-sent, not re-minted, not deleted. Only B (ext.super) is minted + sent.
    expect(tokenDeletes).toHaveLength(0);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[2]).toBe("ext.super@example.com");
    const toAddresses = sendEmail.mock.calls.map((c) => c[0]);
    expect(toAddresses).toEqual(["ext.super@example.com"]);
    expect(toAddresses).not.toContain("dana.cole@example.com");
  });

  it("deletes the just-minted token for a recipient whose send FAILS (so a retry re-mints a working link)", async () => {
    // Finding 7: if a fresh mint's send fails, the token (whose raw link never reached the recipient) is
    // deleted before the handler throws, so the retry re-mints + re-sends rather than stranding them.
    const { query, inserts, tokenDeletes } = makeQuery({
      recipients: [
        { role: "project_manager", name: "Dana Cole", email: "dana.cole@example.com", user_id: null },
      ],
    });
    const sendEmail = vi.fn().mockRejectedValue(new Error("provider down"));
    const logger = makeLogger();

    await expect(
      handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger }),
    ).rejects.toThrow(/provider down/);

    // The token was minted then deleted (its link never delivered), scoped by its own token_hash.
    expect(inserts).toHaveLength(1);
    expect(tokenDeletes).toHaveLength(1);
    expect(tokenDeletes[0].params[0]).toBe(inserts[0].params[1]); // deleted by the minted token_hash
    // No stamp on a failed batch.
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(0);
  });

  // ---- Part A: the CRM (no-token) key is driven by the persisted cycleNonce, not the live open-row hash ----

  it("keys the CRM (no-token) email off payload.cycleNonce when present (retry-stable across a resolve)", async () => {
    // The server now mints a stable per-cycle cycleNonce (immutable across a job's retries). When present, the
    // CRM key's cycle component is the NONCE — NOT a hash over the currently-open corrective-action rows. This
    // is the whole point of the fix: the key must NOT depend on the live open-item set (which shrinks if a
    // responder resolves an item between the send attempt and a retry), only on the nonce.
    const crmSuper = [
      { role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true },
    ];
    const assigned = [{ role: "superintendent" }];
    const NONCE = "cycle-nonce-aaaa";

    const { query, inserts } = makeQuery({ recipients: crmSuper, assignedRoles: assigned });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    await handleScorecardCorrectiveActionEmail(
      { ...payload, cycleNonce: NONCE },
      null,
      { query: query as any, sendEmail, env, logger: makeLogger() },
    );

    // No token for a field-login CRM user; the key carries the NONCE, not the live-row fingerprint.
    expect(inserts).toHaveLength(0);
    const key = sendEmail.mock.calls[0][3].idempotencyKey as string;
    expect(key).toBe(`corrective-action-office_dallas-${SCORECARD}-sam.super@trock.com-cycle-${NONCE}`);
    // And it is emphatically NOT the old live-row-hash key.
    expect(key).not.toBe(
      `corrective-action-office_dallas-${SCORECARD}-sam.super@trock.com-cycle-${cycleFingerprint(FLAGGED.map((f) => f.id))}`,
    );
  });

  it("produces the SAME CRM key across a retry even when the live open-item set changed (nonce, not rows)", async () => {
    // The retry-stability guarantee: attempt 1 has open items [ca-1, ca-2]; before the retry a responder
    // resolves ca-1, so attempt 2's live open set is just [ca-2]. With the OLD live-row hash the key would
    // change (Resend would re-send → duplicate email). Because the SAME job carries the SAME immutable
    // cycleNonce, the CRM key is IDENTICAL across both attempts → Resend dedups → no duplicate.
    const crmSuper = [
      { role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true },
    ];
    const assigned = [{ role: "superintendent" }];
    const NONCE = "cycle-nonce-retry";

    const attempt1 = makeQuery({
      recipients: crmSuper,
      assignedRoles: assigned,
      flagged: [
        { id: "ca-1", item_type: "action_item", item_ref: "0", item_label: "Re-inspect slab 2" },
        { id: "ca-2", item_type: "action_item", item_ref: "1", item_label: "Re-inspect slab 5" },
      ],
    });
    const send1 = vi.fn().mockResolvedValue({ success: true, messageId: "m1" });
    await handleScorecardCorrectiveActionEmail(
      { ...payload, cycleNonce: NONCE },
      null,
      { query: attempt1.query as any, sendEmail: send1, env, logger: makeLogger() },
    );

    // A genuine RETRY of the SAME job (same nonce) — but ca-1 was resolved in the meantime, so the live open
    // set is now just [ca-2].
    const attempt2 = makeQuery({
      recipients: crmSuper,
      assignedRoles: assigned,
      flagged: [{ id: "ca-2", item_type: "action_item", item_ref: "1", item_label: "Re-inspect slab 5" }],
    });
    const send2 = vi.fn().mockResolvedValue({ success: true, messageId: "m2" });
    await handleScorecardCorrectiveActionEmail(
      { ...payload, cycleNonce: NONCE },
      null,
      { query: attempt2.query as any, sendEmail: send2, env, logger: makeLogger() },
    );

    const key1 = send1.mock.calls[0][3].idempotencyKey as string;
    const key2 = send2.mock.calls[0][3].idempotencyKey as string;
    // Same nonce → same key, EVEN THOUGH the live open-item set differs between the two attempts.
    expect(key1).toBe(`corrective-action-office_dallas-${SCORECARD}-sam.super@trock.com-cycle-${NONCE}`);
    expect(key2).toBe(key1);
  });

  it("falls back to the live open-row fingerprint when payload.cycleNonce is absent (legacy in-flight job)", async () => {
    // Jobs enqueued BEFORE this deploy carry no cycleNonce. The handler must still key CRM emails so a same-key
    // /different-payload false-dedup can't happen — via the legacy live-row fingerprint. This is exactly the
    // default `payload` (no cycleNonce), so the existing finding-4 tests already exercise the fallback; this
    // test makes the fallback contract explicit.
    const crmSuper = [
      { role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true },
    ];
    const { query } = makeQuery({ recipients: crmSuper, assignedRoles: [{ role: "superintendent" }] });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger: makeLogger() });

    const key = sendEmail.mock.calls[0][3].idempotencyKey as string;
    expect(key).toBe(
      `corrective-action-office_dallas-${SCORECARD}-sam.super@trock.com-cycle-${cycleFingerprint(FLAGGED.map((f) => f.id))}`,
    );
  });

  // ---- Part B: the final stamp is guarded against a concurrent new corrective-action item ----

  it("does NOT stamp and RE-ENQUEUES a fresh cycle when a new open item appears after the flagged read", async () => {
    // The notification-loss race: the worker emailed about its captured flagged set, but a NEW open corrective-
    // action row raced in before the stamp. The guarded UPDATE affects 0 rows; the re-check shows the card is
    // still un-stamped WITH a new open item → the worker must NOT leave the card stamped-but-un-notified.
    // Instead it deletes the outstanding tokens and enqueues a fresh corrective-action-email job (new cycle).
    const { query, tokenDeletes, jobEnqueues } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
      newOpenItemAppeared: true,
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    // The original email was still sent (about the OLD items) ...
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // ... the guarded stamp affected 0 rows (sent_at NOT set) ...
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(1); // the guarded UPDATE ran (and matched 0 rows)
    // ... the scorecard's outstanding tokens were cleared (so the fresh cycle re-mints) ...
    expect(tokenDeletes).toHaveLength(1);
    expect(tokenDeletes[0].params[0]).toBe(SCORECARD); // scorecard-scoped delete
    // ... and a fresh corrective-action-email job was enqueued with a NEW cycleNonce + the right jobType/office.
    expect(jobEnqueues).toHaveLength(1);
    const enq = jobEnqueues[0];
    expect(enq.params[0]).toBe("scorecard_corrective_action_email");
    const enqPayload = JSON.parse(enq.params[1] as string);
    expect(enqPayload).toMatchObject({ tenantSchema: "office_dallas", scorecardId: SCORECARD, dealId: DEAL });
    expect(typeof enqPayload.cycleNonce).toBe("string");
    expect(enqPayload.cycleNonce).toHaveLength(36); // a fresh UUID
  });

  it("stamps normally and does NOT re-enqueue when the open set is unchanged since the flagged read", async () => {
    // The happy path: no new item raced in. The guarded UPDATE stamps (1 row), so there is no re-check, no token
    // delete, and no re-enqueue.
    const { query, tokenDeletes, jobEnqueues } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
      // newOpenItemAppeared omitted → the stamp UPDATE returns rowCount 1.
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(1);
    // The guarded stamp carries the emailed-id array as $2 so the NOT EXISTS guard can compare the live set.
    expect(stampCalls[0][1]?.[1]).toEqual(FLAGGED.map((f) => f.id));
    // No re-notification machinery fired on the happy path.
    expect(tokenDeletes).toHaveLength(0);
    expect(jobEnqueues).toHaveLength(0);
  });

  // ---- Finding 2: a must_change_password CRM user falls back to the tokenized web link ----

  it("routes a must_change_password CRM user to the web fallback, not the deep link (finding 2)", async () => {
    // requireFieldContractor (server/src/middleware/field-auth.ts) rejects a request when
    // user_local_auth.must_change_password is true (401 "Field app access requires password change") — even
    // though loginFieldUser LETS such a user authenticate. So a must-change CRM assignee can log in but the
    // corrective-action screen can never load → a bare deep link would strand them. The SQL's can_field_login
    // now ANDs `must_change_password = FALSE`, so this user is classified NOT-field-capable (modeled here as
    // can_field_login: false) → they get a minted token + web link, exactly like a no-field-login CRM user. A
    // CRM user who is enabled AND not must-change (can_field_login: true) still gets the deep link + no token.
    const { query, inserts } = makeQuery({
      recipients: [
        // Enabled, not must-change → deep link.
        { role: "superintendent", name: "Fresh Login", email: "fresh@trock.com", user_id: "u-fresh", can_field_login: true },
        // Must-change-password CRM user → not field-capable → token web fallback.
        { role: "project_manager", name: "Must Change", email: "must.change@trock.com", user_id: "u-must", can_field_login: false },
      ],
      assignedRoles: [{ role: "superintendent" }, { role: "project_manager" }],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(sendEmail).toHaveBeenCalledTimes(2);
    const freshCall = sendEmail.mock.calls.find((c) => c[0] === "fresh@trock.com")!;
    const mustCall = sendEmail.mock.calls.find((c) => c[0] === "must.change@trock.com")!;

    // The enabled/non-must-change user keeps the app deep link (no token minted).
    expect(freshCall[3].text as string).toContain(`trockcam://scorecards/corrective-action/${SCORECARD}`);
    // The must-change user is minted a token + given the web link (no deep link).
    expect(mustCall[3].text as string).toContain(
      `https://trockcrm.com/scorecards/${SCORECARD}/corrective-action?token=`,
    );
    expect(mustCall[3].text as string).not.toContain("trockcam://");

    // Exactly ONE token minted — for the must-change CRM user (their public.users email).
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[2]).toBe("must.change@trock.com");
  });

  it("the recipient-resolution SQL disqualifies must_change_password from can_field_login (finding 2)", async () => {
    // Guard against a silent removal of the must_change_password clause: the can_field_login expression must AND
    // `must_change_password = FALSE` on top of the enabled/non-revoked user_local_auth checks. Assert the SQL
    // text so a future edit can't drop it and re-strand must-change users on a deep link.
    const { query } = makeQuery();
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger: makeLogger() });

    const recipientSql = query.mock.calls
      .map(([text]) => text as string)
      .find((t) => /SELECT DISTINCT ON \(dtm\.role\)/i.test(t) && /can_field_login/i.test(t))!;
    expect(recipientSql).toBeTruthy();
    expect(recipientSql).toMatch(/must_change_password\s*=\s*FALSE/i);
    expect(recipientSql).toMatch(/is_enabled\s*=\s*TRUE/i);
    expect(recipientSql).toMatch(/revoked_at\s+IS\s+NULL/i);
  });

  // ---- Finding 5: version-aware score + human rating label in the corrective email ----

  it("renders a V2 scorecard score as X.X/10 with a human rating label, not the raw enum (finding 5)", async () => {
    // A V2 (or leadership) card persists total_score as average*10 (a 6.5/10 average stored as 65). The
    // corrective email must render 6.5/10 — NOT 65/100 — and show the human rating label ("Corrective Action
    // Required"), never the raw `corrective_action` enum. average_score is preferred; here it's null so the
    // handler falls back to total_score/10.
    const { query } = makeQuery({
      recipients: [{ role: "project_manager", name: "Dana Cole", email: "dana.cole@example.com", user_id: null }],
      assignedRoles: [{ role: "project_manager" }],
      totalScore: 65,
      averageScore: null,
      formVersion: 2,
      kind: "project",
      rating: "corrective_action",
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger: makeLogger() });

    const call = sendEmail.mock.calls[0];
    const text = call[3].text as string;
    const subject = call[1] as string;
    const html = call[2] as string;
    // Score is X.X/10, not n/100.
    expect(text).toContain("6.5/10");
    expect(subject).toContain("6.5/10");
    expect(text).not.toContain("65/100");
    // Human rating label, not the enum.
    expect(text).toContain("Corrective Action Required");
    expect(html).toContain("Corrective Action Required");
    expect(text).not.toContain("corrective_action");
  });

  it("prefers the stored average_score for a V2 card's X.X/10 score (finding 5)", async () => {
    // When average_score is present it is used directly (matching the regular scorecard email), so a stored
    // 7.2 renders 7.2/10 regardless of total_score rounding.
    const { query } = makeQuery({
      recipients: [{ role: "project_manager", name: "Dana Cole", email: "dana.cole@example.com", user_id: null }],
      assignedRoles: [{ role: "project_manager" }],
      totalScore: 72,
      averageScore: 7.2,
      formVersion: 2,
      kind: "leadership",
      rating: "corrective_action",
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger: makeLogger() });

    const text = sendEmail.mock.calls[0][3].text as string;
    expect(text).toContain("7.2/10");
    expect(text).not.toContain("72/100");
  });

  it("renders a V1 scorecard score as n/100 (finding 5)", async () => {
    // A V1 card stores the raw 0–100 total → render n/100 with the human rating label.
    const { query } = makeQuery({
      recipients: [{ role: "project_manager", name: "Dana Cole", email: "dana.cole@example.com", user_id: null }],
      assignedRoles: [{ role: "project_manager" }],
      totalScore: 72,
      averageScore: null,
      formVersion: 1,
      kind: "project",
      rating: "corrective_action",
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger: makeLogger() });

    const call = sendEmail.mock.calls[0];
    const text = call[3].text as string;
    expect(text).toContain("72/100");
    expect(text).not.toContain("7.2/10");
    expect(text).toContain("Corrective Action Required");
    expect(text).not.toContain("corrective_action");
  });

  // ---- Finding 1: revalidate the recipient set before stamping (reassignment race) ----

  it("does NOT stamp and RE-ENQUEUES a fresh cycle when the super/PM recipient set changed since the read (finding 1)", async () => {
    // A super reassignment lands AFTER the worker read/emailed the recipient set but BEFORE the stamp. The
    // pre-stamp re-resolution returns a DIFFERENT recipient signature → the worker emailed the FORMER assignee
    // (whose token/access is now revoked at verify time) and the NEW assignee was never notified. The worker
    // must NOT stamp; it deletes the outstanding tokens and enqueues a fresh cycle (new cycleNonce) so the new
    // assignee is notified.
    const { query, tokenDeletes, jobEnqueues } = makeQuery({
      recipients: [{ role: "superintendent", name: "Old Super", email: "old.super@example.com", user_id: null }],
      assignedRoles: [{ role: "superintendent" }],
      // The pre-stamp revalidation resolves a reassigned superintendent.
      revalidatedRecipients: [{ role: "superintendent", name: "New Super", email: "new.super@example.com", user_id: null }],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    // The original email was still sent to the FORMER assignee (about the set the worker read) ...
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe("old.super@example.com");
    // ... but the card was NOT stamped (the guarded stamp UPDATE never ran — the recipient guard short-circuits
    // to re-notify BEFORE the open-item stamp) ...
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(0);
    // ... the outstanding tokens were cleared (so the fresh cycle re-mints) ...
    expect(tokenDeletes).toHaveLength(1);
    expect(tokenDeletes[0].params[0]).toBe(SCORECARD);
    // ... and a fresh corrective-action-email job was enqueued with a new cycleNonce.
    expect(jobEnqueues).toHaveLength(1);
    const enqPayload = JSON.parse(jobEnqueues[0].params[1] as string);
    expect(enqPayload).toMatchObject({ tenantSchema: "office_dallas", scorecardId: SCORECARD, dealId: DEAL });
    expect(typeof enqPayload.cycleNonce).toBe("string");
    expect(enqPayload.cycleNonce).toHaveLength(36);
  });

  it("stamps normally when the recipient set is UNCHANGED since the read (finding 1)", async () => {
    // No reassignment: the pre-stamp re-resolution returns the same signature, so the worker proceeds to the
    // open-item-guarded stamp and stamps (no token delete, no re-enqueue). (revalidatedRecipients omitted →
    // the second recipient read returns the same set as the first.)
    const { query, tokenDeletes, jobEnqueues } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(1);
    expect(tokenDeletes).toHaveLength(0);
    expect(jobEnqueues).toHaveLength(0);
  });

  // ---- P1: guard the delivery stamp with the ACTIVE notification cycle nonce ----

  it("does NOT stamp when the job's cycleNonce no longer matches the scorecard's ACTIVE nonce (P1 cycle guard)", async () => {
    // Crash scenario: a token-email worker (cycle A) crashed AFTER the provider accepted but BEFORE stamping.
    // An edit/team-mutation then started cycle B — it deleted A's tokens and set a NEW
    // corrective_action_cycle_nonce (B) on the scorecard. A's retry runs here carrying payload.cycleNonce = A.
    // Its delivery stamp ANDs `corrective_action_cycle_nonce = A`, but the scorecard now stores B → 0 rows →
    // the still-open scorecard is NOT stamped. This is what prevents cycle B's job from being suppressed
    // (sent_at set) and the recipient being stranded on a DELETED cycle-A token.
    const { query } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
      storedCycleNonce: "cycle-B-active", // the scorecard's ACTIVE nonce is now B
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    // A's retry carries the STALE cycle-A nonce.
    await handleScorecardCorrectiveActionEmail(
      { ...payload, cycleNonce: "cycle-A-stale" },
      null,
      { query: query as any, sendEmail, env, logger },
    );

    // The guarded stamp UPDATE ran but matched 0 rows (nonce mismatch) — the sent_at stamp was NOT written,
    // so cycle B's matching-nonce job is free to send + stamp and the recipient is not stranded.
    const stampCalls = query.mock.calls.filter(([text]) =>
      /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string),
    );
    expect(stampCalls).toHaveLength(1); // the guarded UPDATE ran ...
    // ... and it carried the payload nonce as $3 so the DB can compare it to the stored active nonce.
    expect(stampCalls[0][0]).toMatch(/corrective_action_cycle_nonce\s+IS\s+NULL\s+OR\s+corrective_action_cycle_nonce\s*=\s*\$3/i);
    expect(stampCalls[0][1]?.[2]).toBe("cycle-A-stale");
  });

  it("STAMPS when the job's cycleNonce matches the scorecard's ACTIVE nonce (P1 cycle guard)", async () => {
    // The current cycle's job: its payload.cycleNonce equals the scorecard's stored active nonce, so the
    // nonce clause is satisfied and the stamp proceeds normally.
    const { query } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
      storedCycleNonce: "cycle-current",
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(
      { ...payload, cycleNonce: "cycle-current" },
      null,
      { query: query as any, sendEmail, env, logger },
    );

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const stampCalls = query.mock.calls.filter(([text]) =>
      /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string),
    );
    expect(stampCalls).toHaveLength(1);
    expect(stampCalls[0][1]?.[2]).toBe("cycle-current"); // the matching nonce passed as $3
  });

  it("STAMPS a legacy card whose stored nonce is NULL even when the job carries a nonce (P1 fallback)", async () => {
    // A pre-0197 scorecard has corrective_action_cycle_nonce NULL. The nonce clause is
    // `(corrective_action_cycle_nonce IS NULL OR = $3)`, so a NULL stored nonce still allows the stamp — the
    // guard never regresses a card that predates the column.
    const { query } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
      storedCycleNonce: null, // legacy card
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(
      { ...payload, cycleNonce: "some-cycle" },
      null,
      { query: query as any, sendEmail, env, logger },
    );

    const stampCalls = query.mock.calls.filter(([text]) =>
      /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string),
    );
    expect(stampCalls).toHaveLength(1);
  });

  it("omits the nonce clause entirely for a legacy in-flight job with NO payload cycleNonce (P1 fallback)", async () => {
    // Jobs enqueued before this deploy carry no cycleNonce. The stamp UPDATE must NOT include the nonce clause
    // (and pass no $3), so the pre-guard behavior is exactly preserved.
    const { query } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
      storedCycleNonce: "cycle-B-active", // even a set active nonce must not block a legacy no-nonce job
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    // `payload` (no cycleNonce).
    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    const stampCalls = query.mock.calls.filter(([text]) =>
      /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string),
    );
    expect(stampCalls).toHaveLength(1);
    // No nonce clause and no $3 param.
    expect(stampCalls[0][0]).not.toMatch(/corrective_action_cycle_nonce/i);
    expect(stampCalls[0][1]).toHaveLength(2);
  });

  it("a fresh worker re-notify persists the new cycle's nonce on the scorecard (so the fresh job can stamp)", async () => {
    // When the worker itself starts a fresh cycle (reNotifyFreshCycle — e.g. a recipient reassignment or a new
    // open item raced in), it mints a fresh nonce and must persist it as the scorecard's ACTIVE nonce AND put
    // the SAME nonce on the enqueued job — otherwise the scorecard would still carry the superseded nonce and
    // the fresh job could never stamp. Assert the nonce-only UPDATE ran with the same nonce the job carries.
    const { query, jobEnqueues, nonceUpdates } = makeQuery({
      recipients: [{ role: "superintendent", name: "Old Super", email: "old.super@example.com", user_id: null }],
      assignedRoles: [{ role: "superintendent" }],
      revalidatedRecipients: [{ role: "superintendent", name: "New Super", email: "new.super@example.com", user_id: null }],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    // The fresh cycle was enqueued and its nonce was persisted on the scorecard — and they match.
    expect(jobEnqueues).toHaveLength(1);
    expect(nonceUpdates).toHaveLength(1);
    expect(nonceUpdates[0].params[0]).toBe(SCORECARD); // scorecard-scoped nonce update
    const persistedNonce = nonceUpdates[0].params[1] as string;
    const enqueuedNonce = JSON.parse(jobEnqueues[0].params[1] as string).cycleNonce as string;
    expect(persistedNonce).toBe(enqueuedNonce);
    expect(persistedNonce).toHaveLength(36); // a fresh UUID
  });

  // ---- Finding A: the fresh-cycle replacement is ATOMIC (one transaction) ----

  it("runs the fresh-cycle replacement (token delete + nonce update + enqueue) inside ONE transaction (finding A)", async () => {
    // The reNotify path deletes the scorecard's tokens, bumps corrective_action_cycle_nonce, and inserts a
    // replacement job. Those three writes must be one atomic unit: BEGIN → the three writes → COMMIT.
    const { query, tokenDeletes, nonceUpdates, jobEnqueues, txMarkers } = makeQuery({
      recipients: [{ role: "superintendent", name: "Old Super", email: "old.super@example.com", user_id: null }],
      assignedRoles: [{ role: "superintendent" }],
      // A recipient reassignment triggers reNotifyFreshCycle at the pre-stamp guard.
      revalidatedRecipients: [{ role: "superintendent", name: "New Super", email: "new.super@example.com", user_id: null }],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    // The replacement fired as a committed transaction wrapping the three writes.
    expect(txMarkers).toEqual(["BEGIN", "COMMIT"]);
    expect(tokenDeletes).toHaveLength(1);
    expect(nonceUpdates).toHaveLength(1);
    expect(jobEnqueues).toHaveLength(1);
  });

  it("ROLLS BACK the nonce update + token delete when the replacement enqueue fails, and rethrows (finding A)", async () => {
    // If the replacement job INSERT throws (or the worker exits) after the nonce UPDATE, a non-transactional
    // implementation would leave the scorecard on a FRESH cycle with NO job — the original job's retry carries a
    // now-superseded nonce (can't stamp), its has_new_open recheck is false so it completes without re-scheduling,
    // and provider idempotency may dedup its resend → the notification is permanently suppressed. The atomic fix
    // rolls the whole transaction back so the scorecard is unchanged and the original job's retry can still
    // stamp/handle it. The handler rethrows so the queue retries.
    const { query, jobEnqueues, txMarkers } = makeQuery({
      recipients: [{ role: "superintendent", name: "Old Super", email: "old.super@example.com", user_id: null }],
      assignedRoles: [{ role: "superintendent" }],
      revalidatedRecipients: [{ role: "superintendent", name: "New Super", email: "new.super@example.com", user_id: null }],
      enqueueThrows: true, // the replacement INSERT throws mid-transaction
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await expect(
      handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger }),
    ).rejects.toThrow(/job_queue insert failed/i);

    // BEGIN was issued, the enqueue was attempted, then the transaction ROLLED BACK (no COMMIT) — so the nonce
    // bump + token delete never commit and the scorecard is left as the original job found it.
    expect(txMarkers).toContain("BEGIN");
    expect(txMarkers).toContain("ROLLBACK");
    expect(txMarkers).not.toContain("COMMIT");
    expect(jobEnqueues).toHaveLength(1); // the enqueue was attempted inside the transaction
    // The delivery stamp was never written (the reNotify path does not stamp).
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(0);
  });

  // ---- Finding B: skip a SUPERSEDED job BEFORE resolving recipients / sending ----

  it("returns WITHOUT sending when the payload cycleNonce is already superseded by a newer active cycle (finding B)", async () => {
    // Cycle B started while this cycle-A job was still pending: the server reset corrective_action_email_sent_at
    // to NULL (so the sent-at check passes) and set a NEW active nonce (B) on the scorecard. Without an early
    // nonce gate, cycle A would SEND under its own idempotency key before the final stamp ever examines the
    // nonce → the field-login CRM recipient gets DUPLICATE corrective-action emails (cycle B sends under a
    // different key). The handler must compare payload.cycleNonce to the scorecard's CURRENT active nonce up
    // front and RETURN on a mismatch: no recipient resolution, no send, no stamp.
    const { query, inserts, jobEnqueues } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
      snapshotCycleNonce: "cycle-B-active", // the scorecard's CURRENT active nonce is B
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    // This is the STALE cycle-A job.
    await handleScorecardCorrectiveActionEmail(
      { ...payload, cycleNonce: "cycle-A-stale" },
      null,
      { query: query as any, sendEmail, env, logger },
    );

    // No send, no token mint, no stamp, no re-enqueue — the job simply steps aside for cycle B's job.
    expect(sendEmail).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(jobEnqueues).toHaveLength(0);
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(0);
    // The early gate short-circuits BEFORE recipient resolution — the deal_team_members query never runs.
    const recipientCalls = query.mock.calls.filter(([text]) => /FROM \S*deal_team_members/i.test(text as string));
    expect(recipientCalls).toHaveLength(0);
  });

  it("still SENDS when the payload cycleNonce matches the scorecard's current active nonce (finding B)", async () => {
    // The current cycle's own job: its payload nonce equals the scorecard's active nonce, so the early gate is a
    // no-op and delivery proceeds normally.
    const { query } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
      snapshotCycleNonce: "cycle-current",
      storedCycleNonce: "cycle-current", // the final stamp's nonce guard is also satisfied
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(
      { ...payload, cycleNonce: "cycle-current" },
      null,
      { query: query as any, sendEmail, env, logger },
    );

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(1);
  });

  it("falls through the early nonce gate when the scorecard's active nonce is NULL (legacy card, finding B)", async () => {
    // A pre-column scorecard has a NULL active nonce. The early gate must NOT fire (it would wrongly suppress a
    // legitimate job) — it only skips when BOTH the payload nonce AND the stored nonce are present and differ.
    const { query } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
      snapshotCycleNonce: null, // legacy card, no active nonce persisted
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(
      { ...payload, cycleNonce: "some-cycle" },
      null,
      { query: query as any, sendEmail, env, logger },
    );

    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  // ---- Finding C: skip notifications for HIDDEN scorecards / projects ----

  it("does NOT send or stamp for a HIDDEN scorecard/project (soft-deleted / archived / Lost) (finding C)", async () => {
    // The 120s delay lets a scorecard be soft-deleted, or its deal archived / moved to a Lost/terminal stage,
    // before this worker runs. The responder API (round-13) 404s those, so an email CTA would be dead on arrival.
    // The opening snapshot now applies the SAME active/browsable predicate the responder uses (is_active +
    // non-terminal-or-Won + not-Lost); a hidden record returns zero rows → the handler must RETURN without
    // sending and WITHOUT stamping (leaving the cycle unstamped so a restore can still notify).
    const { query, inserts, jobEnqueues } = makeQuery({
      hiddenScorecard: true,
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(jobEnqueues).toHaveLength(0);
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(0);
    // No recipient resolution even happens — the handler returns right after the (empty) snapshot read.
    const recipientCalls = query.mock.calls.filter(([text]) => /FROM \S*deal_team_members/i.test(text as string));
    expect(recipientCalls).toHaveLength(0);
  });

  it("applies the active/browsable gate to the opening snapshot SELECT (finding C)", async () => {
    // Guard against a silent removal of the browsable predicate: the opening scorecard snapshot must JOIN the
    // deal (+ pipeline_stage_config) and require is_active + non-terminal-or-Won + not-Lost, mirroring the
    // responder's assertActiveCorrectiveActionScorecard. Assert the SQL text so a future edit can't drop it.
    const { query } = makeQuery();
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger: makeLogger() });

    const snapshotSql = query.mock.calls
      .map(([text]) => text as string)
      .find((t) => /FROM \S*field_scorecards\s+sc/i.test(t) && /corrective_action_cycle_nonce/i.test(t))!;
    expect(snapshotSql).toBeTruthy();
    expect(snapshotSql).toMatch(/JOIN \S*deals d/i);
    expect(snapshotSql).toMatch(/LEFT JOIN public\.pipeline_stage_config psc/i);
    expect(snapshotSql).toMatch(/sc\.is_active\s*=\s*true/i);
    expect(snapshotSql).toMatch(/d\.is_active\s*=\s*true/i);
    expect(snapshotSql).toMatch(/is_terminal/i);
  });

  // ---- P1 (round-14 cascade regression): the browsable predicate's placeholder binding ----

  it("treats a TERMINAL WON project as browsable and DOES send + stamp (P1 cascade regression)", async () => {
    // The responder API intentionally treats a Won-terminal project as browsable, so the worker must too. The
    // opening snapshot binds the Won-family slug array to the `= ANY(...)` placeholder and the Lost array to
    // `<> ALL(...)`. The mock EVALUATES the generated predicate against the ACTUAL params (parsing which $-
    // placeholder each array reaches), so this asserts the placeholder BINDING — not a boolean stub. Under the
    // cascading `.replace($1→$2).replace($2→$3)` bug BOTH ANY() and ALL() collapse to $3 (the Lost array), so a
    // Won slug is never compared against the Won array → the terminal deal returns no row → the handler silently
    // completes without sending or stamping. The single-pass renumber binds Won→$2 correctly, so a real Won slug
    // reaches the Won-position placeholder and the terminal deal is browsable → the email IS sent and stamped.
    const { query, tokenDelivers } = makeQuery({
      evalDealStageSlug: WON_TERMINAL_SLUG,
      evalDealIsTerminal: true,
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    // The Won-terminal project is browsable → the corrective-action email IS sent ...
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      "sam.super@trock.com",
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ text: expect.any(String) }),
    );
    // ... and the card IS stamped notified (the stamp UPDATE ran and matched a row) ...
    const stampCalls = query.mock.calls.filter(([text]) =>
      /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string),
    );
    expect(stampCalls).toHaveLength(1);
    // A deep-link CRM user mints no token, so no delivered-token stamp — but the send + stamp above prove the
    // Won-terminal row was returned (not silently dropped by the cascade).
    expect(tokenDelivers).toHaveLength(0);

    // Prove the actual generated SQL binds the WON array to the `= ANY(...)` placeholder (position $2), NOT $3:
    // the exact regression the cascade caused. Read the generated snapshot SQL + its params off the mock.
    const snapshotCall = query.mock.calls.find(
      ([text]) => /FROM \S*field_scorecards\s+sc/i.test(text as string) && /corrective_action_cycle_nonce/i.test(text as string),
    )!;
    const [snapshotSql, snapshotParams] = snapshotCall as [string, any[]];
    const anyPlaceholder = Number((snapshotSql.match(/=\s*ANY\(\$(\d+)::text\[\]\)/i) ?? [])[1]);
    const allPlaceholder = Number((snapshotSql.match(/<>\s*ALL\(\$(\d+)::text\[\]\)/i) ?? [])[1]);
    // Distinct placeholders (the cascade collapsed both to the same number).
    expect(anyPlaceholder).not.toEqual(allPlaceholder);
    // The Won-position placeholder ($2) resolves to an array CONTAINING the Won slug; the Lost-position ($3)
    // resolves to an array that does NOT — so the distinct Won slug genuinely reaches the Won placeholder.
    expect(snapshotParams[anyPlaceholder - 1]).toContain(WON_TERMINAL_SLUG);
    expect(snapshotParams[anyPlaceholder - 1]).not.toContain(LOST_TERMINAL_SLUG);
    expect(snapshotParams[allPlaceholder - 1]).toContain(LOST_TERMINAL_SLUG);
  });

  it("treats a TERMINAL LOST project as hidden and does NOT send or stamp (P1 cascade regression)", async () => {
    // The mirror case: a Lost/terminal deal is excluded by `<> ALL(lostArray)`, so the snapshot returns no row
    // and the handler bails (no send, no stamp). This confirms the Lost array reaches the `<> ALL(...)`
    // placeholder — evaluated against the real params — and is not swallowed by the fix.
    const { query, inserts, jobEnqueues } = makeQuery({
      evalDealStageSlug: LOST_TERMINAL_SLUG,
      evalDealIsTerminal: true,
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(jobEnqueues).toHaveLength(0);
    const stampCalls = query.mock.calls.filter(([text]) =>
      /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string),
    );
    expect(stampCalls).toHaveLength(0);
    // The handler returns right after the (empty) snapshot read — no recipient resolution.
    const recipientCalls = query.mock.calls.filter(([text]) => /FROM \S*deal_team_members/i.test(text as string));
    expect(recipientCalls).toHaveLength(0);
  });

  // ---- Finding D: a field-login capability change is a recipient change in the pre-stamp signature ----

  it("does NOT stamp and RE-NOTIFIES when a recipient's canFieldLogin flips between the read and the stamp (finding D)", async () => {
    // A CRM super was emailed a trockcam:// deep link (they had a field login at read time). Before the stamp,
    // their field login is revoked (user_local_auth.is_enabled → false, or must_change_password set). Because the
    // pre-stamp signature now INCLUDES canFieldLogin, the re-resolution's signature DIFFERS (same email/role, but
    // capability 1 → 0), so the worker treats it as a recipient change: it does NOT stamp and re-notifies a fresh
    // cycle (which, resolving the CURRENT capability, routes the now-revoked user to the web/token fallback).
    const { query, tokenDeletes, jobEnqueues } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
      // Same email + role, but field login now revoked at the pre-stamp re-resolution.
      revalidatedRecipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: false }],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    // The original email went out (deep link, off the read-time capability) ...
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // ... but the card was NOT stamped — the capability change registered as a recipient change ...
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(0);
    // ... and a fresh cycle was enqueued (tokens cleared) so the revoked user is re-notified via the fallback.
    expect(tokenDeletes).toHaveLength(1);
    expect(jobEnqueues).toHaveLength(1);
  });

  it("STILL stamps when the recipient set AND every field-login capability are unchanged (finding D)", async () => {
    // No reassignment and no capability change → the pre-stamp signature is identical → the worker stamps
    // normally. (revalidatedRecipients omitted → the second recipient read returns the same set, same
    // capability, as the first.)
    const { query, tokenDeletes, jobEnqueues } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1", can_field_login: true }],
      assignedRoles: [{ role: "superintendent" }],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE [\s\S]*field_scorecards\s+SET corrective_action_email_sent_at/i.test(text as string));
    expect(stampCalls).toHaveLength(1);
    expect(tokenDeletes).toHaveLength(0);
    expect(jobEnqueues).toHaveLength(0);
  });
});
