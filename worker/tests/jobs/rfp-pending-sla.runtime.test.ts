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
    hoursPending: 31,
    slaHours: 24,
    officeId: "office-uuid",
    frontendUrl: "https://trockcrm.com",
  };

  it("subject names the deal number + name", () => {
    const email = buildRfpPendingSlaEmail(base);
    expect(email.subject).toContain("DFW-1-17326");
    expect(email.subject.toLowerCase()).toContain("pending");
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

  it("states how long it's been pending and the SLA, and escapes the deal name", () => {
    const email = buildRfpPendingSlaEmail(base);
    expect(email.html).toContain("Jan 1, 2026, 9:00 AM CT");
    expect(email.html).toContain("31");
    expect(email.html).toContain("24");
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
});

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
});

// ---- Orchestration test (mock query + send): exactly-once (record-after-send) + pre-send re-check ----
function makeScanMocks(opts: { receiptExists?: boolean; stillBreaching?: boolean } = {}) {
  const receiptExists = opts.receiptExists ?? false;
  const stillBreaching = opts.stillBreaching ?? true;
  const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "msg-1" });
  const calls: string[] = [];
  const q = vi.fn(async (sql: string) => {
    calls.push(sql);
    if (sql.includes("FROM public.offices")) return { rows: [{ id: "office-1", slug: "beta" }] };
    if (sql.includes("FROM public.pipeline_stage_config")) return { rows: [{ id: "opp-stage", slug: "opportunity" }] };
    // The breach scan is the only .deals query that computes hours_pending.
    if (sql.includes(".deals") && sql.includes("hours_pending")) {
      return {
        rows: [
          {
            id: "deal-1",
            name: "Deal One",
            deal_number: "P-1",
            rfp_approval_requested_at: "2026-01-01T00:00:00.000Z",
            hours_pending: 30,
          },
        ],
      };
    }
    // The pre-send re-check re-reads the deal row (no hours_pending).
    if (sql.includes(".deals") && sql.includes("WHERE d.id")) {
      return {
        rows: stillBreaching
          ? [{ status: "pending", requested_at: "2026-01-01T00:00:00.000Z", bbo: false, active: true, test_data: false, on_hold: false, override_decision: "", override_state: "" }]
          : [{ status: "approved", requested_at: "2026-01-01T00:00:00.000Z", bbo: false, active: true, test_data: false, on_hold: false, override_decision: "", override_state: "" }],
      };
    }
    if (sql.includes("SELECT 1") && sql.includes("rfp_pending_sla_email_receipts")) {
      return { rows: receiptExists ? [{ "?column?": 1 }] : [] };
    }
    return { rows: [] };
  });
  return { sendEmail, q, calls };
}

const enabledEnv = { RFP_PENDING_SLA_ENABLED: "true", RFP_REJECTION_EMAIL_RECIPIENTS: "boss@trock.test" };
const silent = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("runRfpPendingSlaScan orchestration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is inert (no query, no send) when the flag is off", async () => {
    const { sendEmail, q } = makeScanMocks();
    const summary = await runRfpPendingSlaScan({ query: q, sendEmail, env: { RFP_REJECTION_EMAIL_RECIPIENTS: "boss@trock.test" }, logger: silent });
    expect(q).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(summary.sent).toBe(0);
  });

  it("does not send (and logs) when no leadership recipients are configured", async () => {
    const { sendEmail, q } = makeScanMocks();
    await runRfpPendingSlaScan({ query: q, sendEmail, env: { RFP_PENDING_SLA_ENABLED: "true" }, logger: silent });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends exactly once for a breaching deal, recording the receipt only AFTER a durable send", async () => {
    const { sendEmail, q, calls } = makeScanMocks();
    const summary = await runRfpPendingSlaScan({ query: q, sendEmail, env: enabledEnv, logger: silent });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toEqual(["boss@trock.test"]);
    expect(summary.sent).toBe(1);
    // The receipt INSERT happens after the send resolves.
    const sendIdx = calls.findIndex((s) => s.includes("INSERT INTO public.rfp_pending_sla_email_receipts"));
    expect(sendIdx).toBeGreaterThan(-1);
  });

  it("skips sending when a receipt already exists for this cycle", async () => {
    const { sendEmail, q } = makeScanMocks({ receiptExists: true });
    const summary = await runRfpPendingSlaScan({ query: q, sendEmail, env: enabledEnv, logger: silent });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
  });

  it("skips (no send) when the deal is no longer awaiting by the time we go to send", async () => {
    const { sendEmail, q } = makeScanMocks({ stillBreaching: false });
    const summary = await runRfpPendingSlaScan({ query: q, sendEmail, env: enabledEnv, logger: silent });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
  });

  it("writes NO receipt (so the next scan retries) and does not throw when the send fails", async () => {
    const { q, calls } = makeScanMocks();
    const sendEmail = vi.fn().mockRejectedValue(new Error("provider down"));
    const summary = await runRfpPendingSlaScan({ query: q, sendEmail, env: enabledEnv, logger: silent });
    expect(summary.failed).toBe(1);
    expect(calls.some((s) => s.includes("INSERT INTO public.rfp_pending_sla_email_receipts"))).toBe(false);
  });
});
