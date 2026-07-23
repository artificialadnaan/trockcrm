import crypto from "crypto";
import { describe, expect, it, vi } from "vitest";
import {
  handleScorecardCorrectiveActionEmail,
  type ScorecardCorrectiveActionEmailPayload,
} from "../../src/jobs/scorecard-corrective-action-email.js";

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
    // Finding 3: model an UNDELIVERED-but-live token row (crash between INSERT and the delivered_at stamp): a
    // map of lower-cased recipient email → the token_hash of that surviving row. The reuse query now selects
    // token_hash + delivered_at for ANY live (unconsumed/unexpired) token, so an undelivered survivor is found
    // and RE-USED (its hash becomes the idempotency key — no new token minted). Delivered survivors are still
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
  } = {},
) {
  const inserts: { sql: string; params: any[] }[] = [];
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
  const query = vi.fn(async (text: string, params: any[] = []) => {
    // Per-recipient LIVE-token reuse lookup (finding 3): SELECT token_hash, delivered_at FROM ...tokens WHERE
    // recipient_email = $2 AND consumed_at IS NULL AND expires_at > NOW() (NO delivered_at filter). A DELIVERED
    // survivor (existingTokenEmails) short-circuits/skips; an UNDELIVERED survivor (undeliveredTokens) is
    // re-used — its hash becomes the idempotency key, no new token minted. No row → mint fresh.
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
      jobEnqueues.push({ sql: text, params });
      return { rows: [], rowCount: 1 };
    }
    // The guarded final stamp: UPDATE field_scorecards SET corrective_action_email_sent_at = NOW() ... with a
    // NOT EXISTS guard against a new open item (Part B). When the race is modeled, the guard rejects the stamp
    // (0 rows); otherwise it stamps (1 row). Match this BEFORE the field_scorecards SELECT branches.
    if (/UPDATE .*field_scorecards/i.test(text)) {
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
      return { rows: opts.flagged ?? FLAGGED };
    }
    if (/FROM \S*deals/i.test(text)) {
      return { rows: [{ name: "Maple Street Tower", deal_number: "DFW-10432", project_number: "DFW-10432" }] };
    }
    return { rows: [] };
  });
  return { query, inserts, tokenDeletes, tokenDelivers, jobEnqueues };
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

    // Idempotency key is scoped to the corrective-action CYCLE. For the email-only PM it carries the freshly-
    // minted token hash (so a reopen — which mints a fresh token — produces a DIFFERENT key, avoiding a Resend
    // false-dedup that would strand them; see the two-cycle test below).
    expect(pmCall[3].idempotencyKey).toContain(SCORECARD);
    expect(pmCall[3].idempotencyKey).toBe(`corrective-action-office_dallas-${SCORECARD}-token-${inserts[0].params[1]}`);

    // The CRM user (no token) key is (scorecard, recipient) PLUS the per-cycle fingerprint (finding 4): their
    // deep link is cycle-stable but the flagged-item email body changes each cycle, so the key must differ
    // across cycles to avoid a Resend same-key/different-payload false-dedup. The fingerprint is a hash over
    // the current open corrective-action-item ids (FLAGGED's ids).
    const fp = cycleFingerprint(FLAGGED.map((f) => f.id));
    expect(superCall[3].idempotencyKey).toBe(
      `corrective-action-office_dallas-${SCORECARD}-sam.super@trock.com-cycle-${fp}`,
    );
  });

  it("uses a DIFFERENT idempotency key for the same email-only recipient across two corrective-action cycles (finding 1)", async () => {
    // A reopen (open→resolve→close, then edit-reopen) deletes the prior cycle's tokens and mints a FRESH one.
    // If the Resend idempotency key were cycle-stable (scorecard+email), Resend would see the same key with a
    // different payload → invalid_idempotent_request → sendSystemEmailWithMetadata treats it as delivered → the
    // worker stamps while the responder holds only the now-deleted old link (stranded). Scoping the key to the
    // minted token hash makes it differ every cycle. Model each cycle as its own handler run (fresh stamp NULL,
    // no surviving token) and assert the two email-only keys differ.
    const emailOnlyPm = [{ role: "project_manager", name: "Dana Cole", email: "dana.cole@example.com", user_id: null }];

    const cycle1 = makeQuery({ recipients: emailOnlyPm, assignedRoles: [{ role: "project_manager" }], existingTokenEmails: [] });
    const send1 = vi.fn().mockResolvedValue({ success: true, messageId: "m1" });
    await handleScorecardCorrectiveActionEmail(payload, null, { query: cycle1.query as any, sendEmail: send1, env, logger: makeLogger() });

    const cycle2 = makeQuery({ recipients: emailOnlyPm, assignedRoles: [{ role: "project_manager" }], existingTokenEmails: [] });
    const send2 = vi.fn().mockResolvedValue({ success: true, messageId: "m2" });
    await handleScorecardCorrectiveActionEmail(payload, null, { query: cycle2.query as any, sendEmail: send2, env, logger: makeLogger() });

    const key1 = send1.mock.calls[0][3].idempotencyKey as string;
    const key2 = send2.mock.calls[0][3].idempotencyKey as string;
    // Both are cycle-scoped to their own minted token hash — and those hashes are random-unique per cycle.
    expect(key1).toBe(`corrective-action-office_dallas-${SCORECARD}-token-${cycle1.inserts[0].params[1]}`);
    expect(key2).toBe(`corrective-action-office_dallas-${SCORECARD}-token-${cycle2.inserts[0].params[1]}`);
    expect(key1).not.toBe(key2);
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
    // The fallback recipient's key is the token-scoped (per-cycle) key, exactly like an email-only member.
    expect(noCall[3].idempotencyKey).toBe(`corrective-action-office_dallas-${SCORECARD}-token-${inserts[0].params[1]}`);
    // The field-login user's key is the CRM (no-token) per-cycle-fingerprint key.
    expect(canCall[3].idempotencyKey).toBe(
      `corrective-action-office_dallas-${SCORECARD}-can.login@trock.com-cycle-${cycleFingerprint(FLAGGED.map((f) => f.id))}`,
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
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE .*field_scorecards/i.test(text as string));
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
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE .*field_scorecards/i.test(text as string));
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
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE .*field_scorecards/i.test(text as string));
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
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE .*field_scorecards/i.test(text as string));
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

  // ---- Finding 3: preserve token sends across the delivery-stamp crash window (reuse the surviving token) ----

  it("REUSES a surviving UNDELIVERED token's hash as the idempotency key on retry — no new token minted (finding 3)", async () => {
    // The crash window: the provider ACCEPTED the email but the worker crashed before stamping delivered_at, so a
    // live token survives with delivered_at NULL. The OLD behavior minted a FRESH token → new hash → new
    // idempotency key → the provider could not dedup → the recipient got a SECOND email with a DIFFERENT link.
    // The fix reuses the surviving token's existing hash as the idempotency key (stable across the crash window),
    // so the provider dedups the true duplicate, and does NOT mint a new token.
    const SURVIVING_HASH = "surviving-undelivered-hash-abc123";
    const { query, inserts, tokenDelivers } = makeQuery({
      recipients: [{ role: "project_manager", name: "Dana Cole", email: "dana.cole@example.com", user_id: null }],
      assignedRoles: [{ role: "project_manager" }],
      undeliveredTokens: { "dana.cole@example.com": SURVIVING_HASH },
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    // The recipient was (re-)sent to — Resend dedups on the stable key, so this is safe.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe("dana.cole@example.com");
    // The idempotency key carries the SURVIVING token's hash — the same key the first attempt used — so the
    // provider dedups the true duplicate (no second email with a different link).
    expect(sendEmail.mock.calls[0][3].idempotencyKey).toBe(
      `corrective-action-office_dallas-${SCORECARD}-token-${SURVIVING_HASH}`,
    );
    // NO new token minted — the surviving row is reused.
    expect(inserts).toHaveLength(0);
    // The surviving token is stamped delivered (by its own hash) so the next retry short-circuits.
    expect(tokenDelivers).toHaveLength(1);
    expect(tokenDelivers[0].params[0]).toBe(SURVIVING_HASH);
  });

  it("SKIPS (no re-send) when a surviving token is already DELIVERED (finding 3)", async () => {
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

    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE .*field_scorecards/i.test(text as string));
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
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE .*field_scorecards/i.test(text as string));
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
      const stampCalls = query.mock.calls.filter(([text]) => /UPDATE .*field_scorecards/i.test(text as string));
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
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE .*field_scorecards/i.test(text as string));
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
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE .*field_scorecards/i.test(text as string));
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
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE .*field_scorecards/i.test(text as string));
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
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE .*field_scorecards/i.test(text as string));
    expect(stampCalls).toHaveLength(1);
    // The strengthened stamp requires the card still be open at stamp time (an empty open set must NOT stamp).
    expect(stampCalls[0][0]).toMatch(/corrective_action_open/i);
    expect(tokenDeletes).toHaveLength(0);
    expect(jobEnqueues).toHaveLength(0);
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
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE .*field_scorecards/i.test(text as string));
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
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE .*field_scorecards/i.test(text as string));
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

    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE .*field_scorecards/i.test(text as string));
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
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE .*field_scorecards/i.test(text as string));
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
    const stampCalls = query.mock.calls.filter(([text]) => /UPDATE .*field_scorecards/i.test(text as string));
    expect(stampCalls).toHaveLength(1);
    expect(tokenDeletes).toHaveLength(0);
    expect(jobEnqueues).toHaveLength(0);
  });
});
