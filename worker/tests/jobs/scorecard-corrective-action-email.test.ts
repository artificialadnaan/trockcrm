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
  } = {},
) {
  const inserts: { sql: string; params: any[] }[] = [];
  const tokenDeletes: { sql: string; params: any[] }[] = [];
  const tokenDelivers: { sql: string; params: any[] }[] = [];
  // existingTokenEmails model DELIVERED tokens: the reuse-skip query requires delivered_at IS NOT NULL, so
  // only a delivered token returns a row (an undelivered remnant returns nothing → the recipient is re-sent).
  const existing = new Set((opts.existingTokenEmails ?? []).map((e) => e.toLowerCase()));
  const query = vi.fn(async (text: string, params: any[] = []) => {
    // Per-recipient DELIVERED-token existence check: SELECT 1 FROM ...tokens WHERE recipient_email = $2 ...
    // ... AND delivered_at IS NOT NULL.
    if (/SELECT 1 FROM \S*scorecard_corrective_action_tokens/i.test(text)) {
      const email = String(params[1] ?? "").toLowerCase();
      return { rows: existing.has(email) ? [{ "?column?": 1 }] : [] };
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
    if (/UPDATE .*field_scorecards/i.test(text)) {
      return { rows: [] };
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
            total_score: 60,
            rating: "corrective_action",
            form_version: 1,
            kind: "project",
            week_of: "2026-06-30",
          },
        ],
      };
    }
    if (/FROM \S*deal_team_members/i.test(text)) {
      // Default can_field_login when a test's inline recipient omits it: a CRM user (user_id set) is assumed
      // to hold an enabled field login (→ deep link) unless the test explicitly says otherwise; an email-only
      // member (user_id null) can never field-login. The SQL computes this from the user_local_auth join.
      const rows = (opts.recipients ?? RECIPIENTS).map((r: any) => ({
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
  return { query, inserts, tokenDeletes, tokenDelivers };
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

  it("RE-SENDS an email-only recipient whose token EXISTS but was never DELIVERED (finding 5: crash-safe)", async () => {
    // A crash between INSERT and send left an UNDELIVERED token row. The reuse-skip requires delivered_at IS
    // NOT NULL, so it does NOT skip: the recipient is re-minted + re-sent (not stranded on a link they never
    // got). Modeled by existingTokenEmails being EMPTY — the delivered-token check returns no row.
    const { query, inserts, tokenDelivers } = makeQuery({
      recipients: [{ role: "project_manager", name: "Dana Cole", email: "dana.cole@example.com", user_id: null }],
      assignedRoles: [{ role: "project_manager" }],
      existingTokenEmails: [], // an undelivered remnant is invisible to the delivered-token reuse check
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    // Re-sent: a fresh token minted + delivered, the recipient emailed.
    expect(inserts).toHaveLength(1);
    expect(tokenDelivers).toHaveLength(1);
    expect(sendEmail.mock.calls.map((c) => c[0])).toEqual(["dana.cole@example.com"]);
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
});
