import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  buildRfpPendingSlaEmail,
  findPendingRfpSlaBreaches,
  isRfpPendingSlaEnabled,
  runRfpPendingSlaScan,
} from "../../src/jobs/rfp-pending-sla.js";

describe("isRfpPendingSlaEnabled", () => {
  it("is true only for an explicit 'true' (trimmed, case-insensitive)", () => {
    expect(isRfpPendingSlaEnabled({ RFP_PENDING_SLA_ENABLED: "true" })).toBe(true);
    expect(isRfpPendingSlaEnabled({ RFP_PENDING_SLA_ENABLED: "  TRUE " })).toBe(true);
  });
  it("is false when unset or not 'true' (default OFF — merges inert)", () => {
    expect(isRfpPendingSlaEnabled({})).toBe(false);
    expect(isRfpPendingSlaEnabled({ RFP_PENDING_SLA_ENABLED: "false" })).toBe(false);
    expect(isRfpPendingSlaEnabled({ RFP_PENDING_SLA_ENABLED: "1" })).toBe(false);
    expect(isRfpPendingSlaEnabled({ RFP_PENDING_SLA_ENABLED: "" })).toBe(false);
  });
});

describe("buildRfpPendingSlaEmail", () => {
  const base = {
    dealId: "deal-1",
    dealName: "Sunrise <Terraces>",
    dealNumber: "DFW-1-17326",
    pendingSinceLabel: "Jan 1, 2026, 9:00 AM CT",
    slaHours: 24,
    officeId: "office-uuid",
    frontendUrl: "https://trockcrm.com",
  };

  it("subject names the deal number + name, with a STABLE '>24h' (no live hours) for idempotent retries", () => {
    const email = buildRfpPendingSlaEmail(base);
    expect(email.subject).toContain("DFW-1-17326");
    expect(email.subject.toLowerCase()).toContain("pending");
    expect(email.subject).toContain(">24h");
  });

  it("links to the deal with its officeId so a cross-office reviewer doesn't 404", () => {
    const email = buildRfpPendingSlaEmail(base);
    expect(email.html).toContain("https://trockcrm.com/deals/deal-1?officeId=office-uuid");
    expect(email.text).toContain("https://trockcrm.com/deals/deal-1?officeId=office-uuid");
  });

  it("links to the Pending RFP queue", () => {
    const email = buildRfpPendingSlaEmail(base);
    expect(email.html).toContain("/deals/pending-rfp?officeId=office-uuid");
  });

  it("shows the stable pending-since instant + SLA (not a drifting live count) and escapes the deal name", () => {
    const email = buildRfpPendingSlaEmail(base);
    expect(email.html).toContain("Jan 1, 2026, 9:00 AM CT"); // stable per cycle
    expect(email.html).toContain("More than 24 hours");
    expect(email.html).toContain("Sunrise &lt;Terraces&gt;"); // escaped, not raw <Terraces>
    expect(email.html).not.toContain("Sunrise <Terraces>");
  });
});

// ---- Real-SQL (PGlite) filter test for the breach finder ----
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const OPP = U("a1");
const WON = U("a2");
const DD = U("a3"); // legacy stage that canonicalizes to Opportunity
let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let query: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA office_test;
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, slug varchar(100) NOT NULL);
    CREATE TABLE office_test.deals (
      id uuid PRIMARY KEY,
      name text,
      stage_id uuid NOT NULL,
      project_number text,
      deal_number text,
      is_bid_board_owned boolean NOT NULL DEFAULT false,
      rfp_approval_status text,
      rfp_approval_requested_at timestamptz,
      is_active boolean NOT NULL DEFAULT true,
      is_test_data boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false,
      rfp_override_decision text,
      rfp_override_state text
    );
    INSERT INTO public.pipeline_stage_config (id, slug) VALUES ('${OPP}', 'opportunity'), ('${WON}', 'won'), ('${DD}', 'dd');
    INSERT INTO office_test.deals
      (id, name, stage_id, project_number, deal_number, is_bid_board_owned, rfp_approval_status, rfp_approval_requested_at, is_active, is_test_data, on_hold, rfp_override_decision, rfp_override_state)
    VALUES
      -- BREACH: opportunity, not BBO, pending, 25h ago
      ('${U("d1")}', 'Breach A', '${OPP}', 'P-1', 'HS-1', false, 'pending', NOW() - INTERVAL '25 hours', true, false, false, NULL, NULL),
      -- BREACH: pending_outbox, 40h ago
      ('${U("d2")}', 'Breach B', '${OPP}', 'P-2', 'HS-2', false, 'pending_outbox', NOW() - INTERVAL '40 hours', true, false, false, NULL, NULL),
      -- BREACH via legacy dd stage (canonicalizes to opportunity), 35h ago
      ('${U("dd")}', 'Breach DD', '${DD}', 'P-DD', 'HS-DD', false, 'pending', NOW() - INTERVAL '35 hours', true, false, false, NULL, NULL),
      -- not breaching: only 5h pending
      ('${U("d3")}', 'Recent', '${OPP}', 'P-3', 'HS-3', false, 'pending', NOW() - INTERVAL '5 hours', true, false, false, NULL, NULL),
      -- not breaching: declined (attention, not awaiting)
      ('${U("d4")}', 'Declined', '${OPP}', 'P-4', 'HS-4', false, 'declined', NOW() - INTERVAL '30 hours', true, false, false, NULL, NULL),
      -- not breaching: bid-board-owned
      ('${U("d5")}', 'BBO', '${OPP}', 'P-5', 'HS-5', true, 'pending', NOW() - INTERVAL '30 hours', true, false, false, NULL, NULL),
      -- not breaching: on hold
      ('${U("d6")}', 'OnHold', '${OPP}', 'P-6', 'HS-6', false, 'pending', NOW() - INTERVAL '30 hours', true, false, true, NULL, NULL),
      -- not breaching: test data
      ('${U("d7")}', 'Test', '${OPP}', 'P-7', 'HS-7', false, 'pending', NOW() - INTERVAL '30 hours', true, true, false, NULL, NULL),
      -- not breaching: inactive
      ('${U("d8")}', 'Inactive', '${OPP}', 'P-8', 'HS-8', false, 'pending', NOW() - INTERVAL '30 hours', false, false, false, NULL, NULL),
      -- not breaching: won stage (past opportunity)
      ('${U("d9")}', 'Won', '${WON}', 'P-9', 'HS-9', false, 'pending', NOW() - INTERVAL '30 hours', true, false, false, NULL, NULL),
      -- not breaching: re-confirmed denial (resolved terminal; hidden from the queue)
      ('${U("da")}', 'ReconfirmedDenial', '${OPP}', 'P-A', 'HS-A', false, 'pending', NOW() - INTERVAL '30 hours', true, false, false, 'denial_reconfirmed', NULL),
      -- not breaching: override approval in flight (becoming a Bid Board project)
      ('${U("db")}', 'OverrideApproving', '${OPP}', 'P-B', 'HS-B', false, 'pending', NOW() - INTERVAL '30 hours', true, false, false, NULL, 'approving');
  `);
  query = (sql: string, params?: unknown[]) => pg.query(sql, params as never[]);
  // 30s (up from the 10s default): under the full `test:runtime` gate several PGlite suites set up
  // concurrently (maxWorkers 4), and the shared cold-start can push this hook past 10s.
}, 30_000);

afterAll(async () => {
  await pg?.close?.();
});

describe("findPendingRfpSlaBreaches (real SQL)", () => {
  it("returns only awaiting, >24h, Opportunity-canonical (incl. legacy dd), non-BBO, active, non-test, non-hold, non-override-resolved deals, oldest first", async () => {
    const breaches = await findPendingRfpSlaBreaches(query, "office_test", 24);
    // 40h (d2) > 35h (dd, legacy stage) > 25h (d1); everything else excluded.
    expect(breaches.map((b) => b.dealId)).toEqual([U("d2"), U("dd"), U("d1")]);
    expect(breaches[0]).toMatchObject({ dealName: "Breach B", dealNumber: "P-2" });
    expect(breaches[0].hoursPending).toBeGreaterThanOrEqual(24);
    expect(typeof breaches[0].requestedAt).toBe("string");
  });

  it("excludes re-confirmed denials and in-flight override approvals (mirrors the Pending RFP queue)", async () => {
    const breaches = await findPendingRfpSlaBreaches(query, "office_test", 24);
    expect(breaches.map((b) => b.dealId)).not.toContain(U("da")); // denial_reconfirmed
    expect(breaches.map((b) => b.dealId)).not.toContain(U("db")); // override approving
  });

  it("prefers project_number, falling back to deal_number", async () => {
    const breaches = await findPendingRfpSlaBreaches(query, "office_test", 24);
    expect(breaches.every((b) => b.dealNumber?.startsWith("P-"))).toBe(true);
  });

  it("uses caller-supplied oppStageIds when provided (hoisted once per scan), and fast-paths an empty set", async () => {
    // Passing the full Opportunity-canonical set (as runRfpPendingSlaScan does) matches resolving internally.
    const withIds = await findPendingRfpSlaBreaches(query, "office_test", 24, [OPP, DD]);
    expect(withIds.map((b) => b.dealId)).toEqual([U("d2"), U("dd"), U("d1")]);
    // The finder trusts the SUPPLIED ids: narrowing to just [OPP] drops the legacy dd-staged breach, proving
    // the passed set (not an internal re-resolution) drives the stage filter.
    const oppOnly = await findPendingRfpSlaBreaches(query, "office_test", 24, [OPP]);
    expect(oppOnly.map((b) => b.dealId)).toEqual([U("d2"), U("d1")]);
    // Empty set short-circuits before touching .deals.
    expect(await findPendingRfpSlaBreaches(query, "office_test", 24, [])).toEqual([]);
  });
});

// ---- Orchestration test (mock query + send): single-flight + claim-then-send exactly-once + re-check ----
// The receipts table is modeled as a real in-memory store keyed by cycle so the claim-before-send lifecycle
// (INSERT claim -> render from stored snapshot -> stamp sent_at on success) is exercised end-to-end, incl.
// the rename-stability guarantee.
function makeScanMocks(
  opts: { stillBreaching?: boolean; stageSlug?: string; alreadySent?: boolean } = {},
) {
  const stillBreaching = opts.stillBreaching ?? true;
  const stageSlug = opts.stageSlug ?? "opportunity";
  // Mutable so a test can rename the deal BETWEEN scans and assert the payload stays pinned to the snapshot.
  const deal = { id: "deal-1", name: "Deal One", deal_number: "P-1", requestedAt: "2026-01-01T00:00:00.000Z" };
  // key = tenant_schema | deal_id | rfp_approval_requested_at (the first 3 bound params of every receipts query)
  const receipts = new Map<
    string,
    { deal_name: string; deal_number: string | null; recipient_emails: string | null; sent_at: string | null }
  >();
  const key = (p: unknown[]) => `${p[0]}|${p[1]}|${p[2]}`;
  if (opts.alreadySent) {
    receipts.set(`office_beta|${deal.id}|${deal.requestedAt}`, {
      deal_name: "Deal One",
      deal_number: "P-1",
      recipient_emails: "boss@trock.test",
      sent_at: "2026-01-02T00:00:00.000Z",
    });
  }
  const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "msg-1" });
  const calls: string[] = [];
  const q = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push(sql);
    if (sql.includes("FROM public.offices")) return { rows: [{ id: "office-1", slug: "beta" }] };
    if (sql.includes("FROM public.pipeline_stage_config")) return { rows: [{ id: "opp-stage", slug: "opportunity" }] };
    // The breach scan is the only .deals query that computes hours_pending.
    if (sql.includes(".deals") && sql.includes("hours_pending")) {
      return {
        rows: [
          {
            id: deal.id,
            name: deal.name,
            deal_number: deal.deal_number,
            rfp_approval_requested_at: deal.requestedAt,
            hours_pending: 30,
          },
        ],
      };
    }
    // The pre-send re-check re-reads the deal row (no hours_pending) incl. the current stage slug.
    if (sql.includes(".deals") && sql.includes("WHERE d.id")) {
      return {
        rows: [{
          status: stillBreaching ? "pending" : "approved",
          requested_at: deal.requestedAt,
          stage_slug: stageSlug,
          bbo: false, active: true, test_data: false, on_hold: false,
          override_decision: "", override_state: "",
        }],
      };
    }
    if (sql.includes("rfp_pending_sla_email_receipts")) {
      const k = key(params ?? []);
      if (sql.includes("INSERT")) {
        // (tenant, deal, requested_at, deal_name, deal_number, recipient_emails) — ON CONFLICT DO NOTHING
        // preserves first-seen (the full snapshot: display fields AND the recipient list).
        if (!receipts.has(k)) {
          receipts.set(k, {
            deal_name: params?.[3] as string,
            deal_number: (params?.[4] as string) ?? null,
            recipient_emails: (params?.[5] as string) ?? null,
            sent_at: null,
          });
        }
        return { rows: [] };
      }
      if (sql.includes("UPDATE")) {
        // SET sent_at = NOW() ... WHERE (pk) AND sent_at IS NULL — first completer wins.
        const row = receipts.get(k);
        if (row && row.sent_at == null) row.sent_at = new Date().toISOString();
        return { rows: [] };
      }
      // SELECT (claim read-back / already-sent check)
      const row = receipts.get(k);
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  });
  return { sendEmail, q, calls, receipts, deal };
}

// Always-acquires lock stub (no-op release) so tests exercise the scan body deterministically.
const noLock = async () => async () => {};
const enabledEnv = { RFP_PENDING_SLA_ENABLED: "true", RFP_REJECTION_EMAIL_RECIPIENTS: "boss@trock.test" };
const silent = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("runRfpPendingSlaScan orchestration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is inert (no query, no send) when the flag is off", async () => {
    const { sendEmail, q } = makeScanMocks();
    const summary = await runRfpPendingSlaScan({ query: q, sendEmail, acquireLock: noLock, env: { RFP_REJECTION_EMAIL_RECIPIENTS: "boss@trock.test" }, logger: silent });
    expect(q).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(summary.sent).toBe(0);
  });

  it("does not send (and logs) when no leadership recipients are configured", async () => {
    const { sendEmail, q } = makeScanMocks();
    await runRfpPendingSlaScan({ query: q, sendEmail, acquireLock: noLock, env: { RFP_PENDING_SLA_ENABLED: "true" }, logger: silent });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips the whole tick (no query, no send) when another scan already holds the lock", async () => {
    const { sendEmail, q } = makeScanMocks();
    const summary = await runRfpPendingSlaScan({ query: q, sendEmail, acquireLock: async () => null, env: enabledEnv, logger: silent });
    expect(q).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(summary.sent).toBe(0);
  });

  it("claims BEFORE sending, then stamps sent_at AFTER a durable send (exactly-once)", async () => {
    const { sendEmail, q, calls, receipts } = makeScanMocks();
    const summary = await runRfpPendingSlaScan({ query: q, sendEmail, acquireLock: noLock, env: enabledEnv, logger: silent });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toEqual(["boss@trock.test"]);
    expect(summary.sent).toBe(1);
    // The claim INSERT precedes the send; the sent_at UPDATE follows it.
    const insertIdx = calls.findIndex((s) => s.includes("INSERT INTO public.rfp_pending_sla_email_receipts"));
    const updateIdx = calls.findIndex((s) => s.includes("UPDATE public.rfp_pending_sla_email_receipts"));
    expect(insertIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(insertIdx);
    // The claim row now records completion.
    expect(receipts.get("office_beta|deal-1|2026-01-01T00:00:00.000Z")?.sent_at).not.toBeNull();
  });

  it("skips sending when the claim for this cycle is already sent (sent_at not null)", async () => {
    const { sendEmail, q } = makeScanMocks({ alreadySent: true });
    const summary = await runRfpPendingSlaScan({ query: q, sendEmail, acquireLock: noLock, env: enabledEnv, logger: silent });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
  });

  it("skips (no send) when the deal is no longer awaiting by the time we go to send", async () => {
    const { sendEmail, q } = makeScanMocks({ stillBreaching: false });
    const summary = await runRfpPendingSlaScan({ query: q, sendEmail, acquireLock: noLock, env: enabledEnv, logger: silent });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
  });

  it("skips (no send) when the deal has moved out of Opportunity before the send", async () => {
    const { sendEmail, q } = makeScanMocks({ stageSlug: "won" });
    const summary = await runRfpPendingSlaScan({ query: q, sendEmail, acquireLock: noLock, env: enabledEnv, logger: silent });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
  });

  it("leaves the claim with sent_at NULL (retryable, never deleted) and does not throw when the send fails", async () => {
    const { q, calls, receipts } = makeScanMocks();
    const sendEmail = vi.fn().mockRejectedValue(new Error("provider down"));
    const summary = await runRfpPendingSlaScan({ query: q, sendEmail, acquireLock: noLock, env: enabledEnv, logger: silent });
    expect(summary.failed).toBe(1);
    // The claim WAS written (so the snapshot is pinned), but it is NOT marked sent and NOT deleted.
    expect(calls.some((s) => s.includes("INSERT INTO public.rfp_pending_sla_email_receipts"))).toBe(true);
    expect(calls.some((s) => s.includes("UPDATE public.rfp_pending_sla_email_receipts"))).toBe(false);
    expect(receipts.get("office_beta|deal-1|2026-01-01T00:00:00.000Z")?.sent_at).toBeNull();
  });

  it("retries render from the STORED snapshot, so a rename between attempts keeps the Resend payload stable", async () => {
    const mocks = makeScanMocks();
    // First attempt: the send fails, so the claim persists with the FIRST-SEEN snapshot and sent_at NULL.
    const failing = vi.fn().mockRejectedValue(new Error("provider down"));
    await runRfpPendingSlaScan({ query: mocks.q, sendEmail: failing, acquireLock: noLock, env: enabledEnv, logger: silent });
    expect(failing).toHaveBeenCalledTimes(1);

    // The deal is renamed + renumbered between scans.
    mocks.deal.name = "Renamed Deal";
    mocks.deal.deal_number = "P-999";

    // Second attempt succeeds: it must render from the STORED snapshot, not the fresh (renamed) fields.
    const sending = vi.fn().mockResolvedValue({ success: true, messageId: "msg-2" });
    const summary = await runRfpPendingSlaScan({ query: mocks.q, sendEmail: sending, acquireLock: noLock, env: enabledEnv, logger: silent });
    expect(summary.sent).toBe(1);
    const [, subject, html, options] = sending.mock.calls[0];
    expect(subject).toContain("P-1"); // original number, pinned
    expect(subject).toContain("Deal One"); // original name, pinned
    expect(subject).not.toContain("P-999");
    expect(html).toContain("Deal One");
    expect(html).not.toContain("Renamed Deal");
    // Same idempotencyKey across both attempts (keyed on requested_at, which never changed).
    expect(options.idempotencyKey).toBe(failing.mock.calls[0][3].idempotencyKey);
  });

  it("retries send to the STORED recipient snapshot, so a recipient-list change between attempts keeps `to` stable", async () => {
    const mocks = makeScanMocks();
    // First attempt: send fails, so the claim persists the FIRST-SEEN recipient set with sent_at NULL.
    const failing = vi.fn().mockRejectedValue(new Error("provider down"));
    await runRfpPendingSlaScan({ query: mocks.q, sendEmail: failing, acquireLock: noLock, env: enabledEnv, logger: silent });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(failing.mock.calls[0][0]).toEqual(["boss@trock.test"]);

    // RFP_REJECTION_EMAIL_RECIPIENTS is edited between scans (reordered + a new address).
    const changedEnv = { RFP_PENDING_SLA_ENABLED: "true", RFP_REJECTION_EMAIL_RECIPIENTS: "newboss@trock.test, boss@trock.test" };

    // Second attempt succeeds: it must send to the STORED recipient snapshot, not the fresh env list, so the
    // Resend payload (`to`) is byte-identical to the first attempt and the idempotencyKey is honored.
    const sending = vi.fn().mockResolvedValue({ success: true, messageId: "msg-2" });
    const summary = await runRfpPendingSlaScan({ query: mocks.q, sendEmail: sending, acquireLock: noLock, env: changedEnv, logger: silent });
    expect(summary.sent).toBe(1);
    expect(sending.mock.calls[0][0]).toEqual(["boss@trock.test"]); // pinned to the snapshot, not newboss
    expect(sending.mock.calls[0][3].idempotencyKey).toBe(failing.mock.calls[0][3].idempotencyKey);
  });
});
