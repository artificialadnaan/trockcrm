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
function makeQuery(opts: { sentAt?: string | null; recipients?: any[]; flagged?: any[] } = {}) {
  const inserts: { sql: string; params: any[] }[] = [];
  const tokenDeletes: { sql: string; params: any[] }[] = [];
  const query = vi.fn(async (text: string, params: any[] = []) => {
    if (/DELETE FROM .*scorecard_corrective_action_tokens/i.test(text)) {
      tokenDeletes.push({ sql: text, params });
      return { rows: [] };
    }
    if (/INSERT INTO .*scorecard_corrective_action_tokens/i.test(text)) {
      inserts.push({ sql: text, params });
      return { rows: [] };
    }
    if (/UPDATE .*field_scorecards/i.test(text)) {
      return { rows: [] };
    }
    if (/FROM \S*field_scorecards/i.test(text)) {
      return {
        rows: [
          {
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
  return { query, inserts, tokenDeletes };
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
    expect(superText).toContain(`trockcrm://scorecard/${SCORECARD}/corrective-action`);
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

  it("skips a recipient with no email but still sends to the rest", async () => {
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

  it("does not stamp or mint if there are no resolvable recipients (loud no-recipient case is a no-op skip)", async () => {
    const { query, inserts, tokenDeletes } = makeQuery({ recipients: [] });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    // No recipients → the handler returns before the send phase, so no orphan-cleanup delete either.
    expect(tokenDeletes).toHaveLength(0);
  });

  it("clears prior unexpired tokens before re-minting (no orphan accumulation across retries)", async () => {
    // On a retry (the prior attempt sent+minted but crashed before stamping), the handler re-enters the send
    // phase. It must DELETE the scorecard's prior unexpired, unconsumed tokens BEFORE minting the new one, so
    // orphan token rows don't accumulate. We can't reuse a prior token (only its hash is stored).
    const { query, inserts, tokenDeletes } = makeQuery();
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    const logger = makeLogger();

    await handleScorecardCorrectiveActionEmail(payload, null, { query: query as any, sendEmail, env, logger });

    // Exactly one cleanup delete, scoped to this scorecard, gating on unexpired + unconsumed.
    expect(tokenDeletes).toHaveLength(1);
    expect(tokenDeletes[0].params[0]).toBe(SCORECARD);
    expect(tokenDeletes[0].sql).toMatch(/consumed_at IS NULL/i);
    expect(tokenDeletes[0].sql).toMatch(/expires_at > NOW\(\)/i);
    // Then the fresh token is minted (the email-only PM).
    expect(inserts).toHaveLength(1);

    // Cleanup happens BEFORE the mint (call ordering in the mock).
    const deleteCallIdx = query.mock.calls.findIndex(([t]) =>
      /DELETE FROM .*scorecard_corrective_action_tokens/i.test(t as string),
    );
    const insertCallIdx = query.mock.calls.findIndex(([t]) =>
      /INSERT INTO .*scorecard_corrective_action_tokens/i.test(t as string),
    );
    expect(deleteCallIdx).toBeGreaterThanOrEqual(0);
    expect(insertCallIdx).toBeGreaterThan(deleteCallIdx);
  });
});
