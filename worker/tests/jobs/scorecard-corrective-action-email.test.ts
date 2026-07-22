import { describe, expect, it, vi } from "vitest";
import {
  handleScorecardCorrectiveActionEmail,
  type ScorecardCorrectiveActionEmailPayload,
} from "../../src/jobs/scorecard-corrective-action-email.js";

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

// A recipient set: one CRM user (superintendent) + one email-only member (project_manager).
const RECIPIENTS = [
  { role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1" },
  { role: "project_manager", name: "Dana Cole", email: "dana.cole@example.com", user_id: null },
];
const FLAGGED = [
  { item_type: "action_item", item_ref: "0", item_label: "Re-inspect slab 2" },
  { item_type: "critical_deficiency", item_ref: "missed_hold_point", item_label: "Missed hold point" },
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
      return { rows: opts.recipients ?? RECIPIENTS };
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

    // Idempotency key is per (scorecard, recipient).
    expect(pmCall[3].idempotencyKey).toContain(SCORECARD);
    expect(pmCall[3].idempotencyKey).toContain("dana.cole@example.com");
  });

  it("is idempotent: skips entirely when the scorecard was already notified", async () => {
    const { query, inserts } = makeQuery({ sentAt: "2026-07-01T00:00:00Z" });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("skips a recipient with no email, sends to the rest, and does NOT stamp (re-runnable)", async () => {
    const { query } = makeQuery({
      recipients: [
        { role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1" },
        { role: "project_manager", name: "No Email", email: "   ", user_id: null },
      ],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe("sam.super@trock.com");

    // A super/PM was skipped for a missing email, so the scorecard-level stamp is NOT written — a later
    // requeue (after the PM's email is fixed) can still notify them (per-recipient delivery, finding 8).
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

  it("does NOT stamp when a role is ASSIGNED but currently UNRESOLVABLE (finding 4: partial-role incompleteness)", async () => {
    // The PM role IS assigned (an active deal_team_members row) but its identity is unresolvable this run — e.g.
    // an inactive user/contact, so it never appears in the resolved-recipient set (which drops inactive
    // identities). The super was delivered, but the assigned PM was NOT — delivery is INCOMPLETE, so the stamp
    // must be withheld so a later requeue (once the PM's identity/email is fixed) still notifies them.
    const { query } = makeQuery({
      recipients: [{ role: "superintendent", name: "Sam Super", email: "sam.super@trock.com", user_id: "u-1" }],
      assignedRoles: [{ role: "superintendent" }, { role: "project_manager" }],
    });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe("sam.super@trock.com");
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
