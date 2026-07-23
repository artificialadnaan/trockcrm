import { describe, expect, it, vi } from "vitest";
import {
  buildWonMetricReductionEmail,
  DEFAULT_WON_METRIC_DECREASE_RECIPIENTS,
  enableWonMetricReductionAlertDelivery,
  handleWonMetricReductionAlert,
  resolveWonMetricDecreaseRecipients,
  resolveWonMetricImpact,
} from "../../src/jobs/won-metric-reduction-alert.js";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const DEAL_ID = "22222222-2222-4222-8222-222222222222";
const OFFICE_ID = "33333333-3333-4333-8333-333333333333";
const TAKASHI_ID = "44444444-4444-4444-8444-444444444444";
const ADNAAN_ID = "55555555-5555-4555-8555-555555555555";
const TAKASHI = "takashi@trockgc.com";
const ADNAAN = "adnaan@trockgc.com";
const REP_FROM = "f5ade4ca-ee41-5188-b6d6-d58a2630e89c";
const REP_TO = "e537cc4a-fc5e-46d4-901a-99a9bf5e2ec6";
const REASSIGN_NAMES: Record<string, string> = { [REP_FROM]: "Chris Higingbotham", [REP_TO]: "Caleb Stone" };

const BASE_EVENT = {
  event_id: EVENT_ID,
  tenant_schema: "office_dallas",
  deal_id: DEAL_ID,
  event_kind: "deal_audit_reduction",
  action_label: "Won closed date changed from 2026-06-18 to 2025-12-31",
  reason_code: "won_closed_date_outside_ytd",
  changed_fields: { won_closed_date: { from: "2026-06-18", to: "2025-12-31" } },
  impacts: {
    "director.won_ytd": {
      scope: "director",
      scopeId: "office_dallas",
      metric: "won_ytd",
      countBefore: 275,
      countAfter: 253,
      countDelta: -22,
      before: 18_002_178.07,
      after: 17_726_882.86,
      delta: -275_295.21,
      unit: "usd",
    },
  },
  audit_reference: { tenantSchema: "office_dallas", transactionId: "12345", action: "Deal update", auditLogIds: ["8959232"] },
  old_snapshot: {},
  new_snapshot: {},
  deal_name: "Tides Park Lane",
  deal_number: "DFW-9-15926-ae",
  report_metric_key: "director.won_ytd",
  definition_version: "won-v1",
  definition_hash: "abc123",
  release_reference: "PR #916 / db65781c",
  created_at: "2026-07-14T15:00:00.000Z",
};

type Receipt = { sent_at: string | null; resend_message_id: string | null; claimed_at: string };

function makeQuery(options: { event?: Record<string, unknown>; sentRecipients?: string[]; activeLeaseRecipients?: string[] } = {}) {
  const receipts = new Map<string, Receipt>();
  const notificationIds = new Set<string>();
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let leaseNumber = 0;
  for (const recipient of options.sentRecipients ?? []) {
    receipts.set(recipient, { sent_at: "2026-07-14T16:00:00.000Z", resend_message_id: "old-message", claimed_at: "sent-lease" });
  }
  for (const recipient of options.activeLeaseRecipients ?? []) {
    receipts.set(recipient, { sent_at: null, resend_message_id: null, claimed_at: "active-lease" });
  }
  const event = options.event ?? BASE_EVENT;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("JOIN office_dallas.audit_log")) {
      return {
        rows: [
          {
            id: "8959232",
            action: "update",
            actor_name: "Kristy Wilson",
            actor_role: "admin",
            actor_system_process: null,
            changed_by: "66666666-6666-4666-8666-666666666666",
            created_at: "2026-07-14T15:00:00.000Z",
            changes: { won_closed_date: { old: "2026-06-18", new: "2025-12-31" } },
            field_changes_jsonb: { won_closed_date: { from: "2026-06-18", to: "2025-12-31" } },
          },
        ],
      };
    }
    if (sql.includes("FROM public.won_metric_reduction_events")) return { rows: [event] };
    if (sql.includes("FROM public.offices")) return { rows: [{ id: OFFICE_ID }] };
    if (sql.includes("INSERT INTO public.won_metric_reduction_delivery_receipts")) {
      const recipient = String(params[1]);
      const receipt = receipts.get(recipient);
      if (!receipt) {
        const claimed = { sent_at: null, resend_message_id: null, claimed_at: `lease-${++leaseNumber}` };
        receipts.set(recipient, claimed);
        return { rows: [claimed] };
      }
      // A sent receipt or a fresh competitor lease makes the conditional conflict update return no row.
      if (receipt.sent_at != null || receipt.claimed_at === "active-lease") return { rows: [] };
      receipt.claimed_at = `lease-${++leaseNumber}`;
      return { rows: [receipt] };
    }
    if (sql.includes("FROM public.won_metric_reduction_delivery_receipts")) {
      const receipt = receipts.get(String(params[1]));
      return { rows: receipt ? [{ ...receipt, retry_after_seconds: 300 }] : [] };
    }
    if (sql.includes("UPDATE public.won_metric_reduction_delivery_receipts")) {
      const recipient = String(params[1]);
      const receipt = receipts.get(recipient);
      if (sql.includes("SET sent_at") && receipt && receipt.sent_at == null && params[3] === receipt.claimed_at) {
        receipt.sent_at = "2026-07-14T16:05:00.000Z";
        receipt.resend_message_id = (params[2] as string | null) ?? null;
        return { rows: [{ event_id: EVENT_ID }] };
      }
      if (sql.includes("SET claimed_at") && receipt && receipt.sent_at == null && params[2] === receipt.claimed_at) {
        receipt.claimed_at = "released";
      }
      return { rows: [] };
    }
    if (sql.includes("FROM public.users")) {
      if (sql.includes("display_name")) {
        // Batched rep-name resolution by id (WHERE id = ANY($1)).
        const ids = (params[0] as string[]) ?? [];
        const rows = ids
          .map((id) => ({ id: String(id).toLowerCase(), display_name: (REASSIGN_NAMES as Record<string, string>)[String(id).toLowerCase()] }))
          .filter((row) => row.display_name);
        return { rows };
      }
      const email = String(params[0]).toLowerCase();
      if (email === TAKASHI) return { rows: [{ id: TAKASHI_ID }] };
      if (email === ADNAAN) return { rows: [{ id: ADNAAN_ID }] };
      return { rows: [] };
    }
    if (sql.includes("FROM office_dallas.deals") && sql.includes("property_state")) {
      return { rows: [{ property_address: "50 Mount Zion Rd", property_city: "Atlanta", property_state: "GA" }] };
    }
    if (sql.includes("INSERT INTO office_dallas.notifications")) {
      notificationIds.add(String(params[0]));
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { query: query as any, receipts, notificationIds, calls };
}

const ENV = {
  NODE_ENV: "test",
  FRONTEND_URL: "https://trockcrm.com",
  WON_METRIC_DECREASE_EMAIL_RECIPIENTS: ` ${TAKASHI}, invalid, ${ADNAAN}, ${TAKASHI.toUpperCase()} `,
} as NodeJS.ProcessEnv;
const silent = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("resolveWonMetricDecreaseRecipients", () => {
  it("trims, validates, lowercases, and de-dupes the configured recipient list", () => {
    expect(resolveWonMetricDecreaseRecipients(ENV)).toEqual([TAKASHI, ADNAAN]);
  });

  it("uses the corporate fallback outside production when no deployment override is supplied", () => {
    expect(resolveWonMetricDecreaseRecipients({} as NodeJS.ProcessEnv)).toEqual([...DEFAULT_WON_METRIC_DECREASE_RECIPIENTS]);
  });

  it("requires an explicit recipient configuration in production", () => {
    expect(resolveWonMetricDecreaseRecipients({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("resolveWonMetricImpact", () => {
  it("targets the canonical scope.metric impacts record and treats either value or count reductions as negative", () => {
    const impact = resolveWonMetricImpact(BASE_EVENT.impacts, "director.won_ytd");
    expect(impact).toMatchObject({ before: 18_002_178.07, after: 17_726_882.86, delta: -275_295.21, countDelta: -22, isNegative: true });

    const countOnly = resolveWonMetricImpact(
      { "director.won_ytd_count": { metric: "won_ytd_count", countBefore: 8, countAfter: 7, countDelta: -1, unit: "count" } },
      "director.won_ytd_count",
    );
    expect(countOnly.isNegative).toBe(true);
  });

  it("prefers the canonical office Won YTD impact over an equally-ranked estimator impact", () => {
    const impact = resolveWonMetricImpact(
      {
        "office.estimator_pipeline.won_ytd": {
          scope: "office",
          metric: "estimator_pipeline.won_ytd",
          countBefore: 2,
          countAfter: 1,
          countDelta: -1,
          before: 300000,
          after: 0,
          delta: -300000,
          unit: "usd",
        },
        "office.won_ytd": {
          scope: "office",
          metric: "won_ytd",
          countBefore: 3,
          countAfter: 2,
          countDelta: -1,
          before: 400000,
          after: 100000,
          delta: -300000,
          unit: "usd",
        },
      },
      "won_ytd",
    );

    expect(impact).toMatchObject({ metricKey: "office.won_ytd", before: 400000, after: 100000 });
  });
});

const REASSIGN_EVENT = {
  dealId: DEAL_ID,
  dealName: "Terraces at Highbury Court",
  dealNumber: "DFW-4-16326-af",
  reportMetricKey: "assigned_rep.won_ytd",
  definitionVersion: null,
  releaseReference: null,
  actionLabel: "Won deal reassigned",
  reasonCode: "won_reassigned",
  changedFields: { assigned_rep_id: { from: REP_FROM, to: REP_TO } },
  auditReference: { actorName: "Chris Higingbotham", auditLogIds: ["10893467"] },
  newSnapshot: { awardedAmount: 12322.86, bidEstimate: 12322.86, ddEstimate: 12155.0, assignedRepId: REP_TO },
  oldSnapshot: { awardedAmount: 12322.86, assignedRepId: REP_FROM },
};

const REASSIGN_IMPACT = {
  metricKey: "assigned_rep.won_ytd",
  before: 12322.86,
  after: 0,
  delta: -12322.86,
  countBefore: 1,
  countAfter: 0,
  countDelta: -1,
  unit: "usd",
  isNegative: true,
};

describe("buildWonMetricReductionEmail — enrichment", () => {
  it("resolves rep UUIDs to names, adds a why-summary and Job/Amount/Location rows", () => {
    const email = buildWonMetricReductionEmail({
      event: REASSIGN_EVENT,
      impact: REASSIGN_IMPACT,
      officeId: OFFICE_ID,
      frontendUrl: "https://trockcrm.com",
      userNames: REASSIGN_NAMES,
      dealLocation: { address: "50 Mount Zion Rd", city: "Atlanta", state: "GA" },
    });

    // Names, never raw UUIDs.
    expect(email.html).toContain("Chris Higingbotham");
    expect(email.html).toContain("Caleb Stone");
    expect(email.html).not.toContain(REP_FROM);
    expect(email.html).not.toContain(REP_TO);
    // Why-summary sentence.
    expect(email.html).toContain("reassigned");
    expect(email.text).toContain("Chris Higingbotham → Caleb Stone");
    // New rows.
    expect(email.html).toContain("Terraces at Highbury Court");
    expect(email.html).toContain("$12,322.86"); // Amount row (full currency)
    expect(email.html).toContain("Atlanta, GA"); // Location row
    // Existing behavior preserved.
    expect(email.html).toContain("Open Terraces at Highbury Court");
  });

  it("falls back to the raw id when a rep uuid is unknown and never throws on missing enrichment", () => {
    const email = buildWonMetricReductionEmail({
      event: REASSIGN_EVENT,
      impact: REASSIGN_IMPACT,
      frontendUrl: "https://trockcrm.com",
      // no userNames, no dealLocation
    });
    expect(email.html).toContain(REP_FROM); // unresolved id shown, not a crash
    expect(email.html).toContain("$12,322.86"); // amount still derived from snapshot
  });
});

describe("enableWonMetricReductionAlertDelivery", () => {
  it("opens the database gate and reports the number of backfilled events", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ queued_count: "2" }] });

    await expect(enableWonMetricReductionAlertDelivery({ query, logger: silent })).resolves.toBe(2);
    expect(query).toHaveBeenCalledWith("SELECT public.enable_won_metric_reduction_alert_delivery() AS queued_count");
  });

  it("tolerates a worker deployed before the delivery-gate migration", async () => {
    const query = vi.fn().mockRejectedValue(Object.assign(new Error("function does not exist"), { code: "42883" }));

    await expect(enableWonMetricReductionAlertDelivery({ query, logger: silent })).resolves.toBe(0);
  });
});

describe("handleWonMetricReductionAlert", () => {
  it("resolves rep UUIDs to names and adds the why-summary for a reassignment event", async () => {
    const reassignEvent = {
      ...BASE_EVENT,
      action_label: "Won deal reassigned",
      reason_code: "won_reassigned",
      changed_fields: { assigned_rep_id: { from: REP_FROM, to: REP_TO } },
      impacts: {
        "assigned_rep.won_ytd": {
          scope: "assigned_rep",
          scopeId: REP_FROM,
          metric: "won_ytd",
          countBefore: 1,
          countAfter: 0,
          countDelta: -1,
          before: 12322.86,
          after: 0,
          delta: -12322.86,
          unit: "usd",
        },
      },
      new_snapshot: { awardedAmount: 12322.86, assignedRepId: REP_TO },
      old_snapshot: { awardedAmount: 12322.86, assignedRepId: REP_FROM },
      deal_name: "Terraces at Highbury Court",
      deal_number: "DFW-4-16326-af",
      report_metric_key: "assigned_rep.won_ytd",
    };
    const { query } = makeQuery({ event: reassignEvent });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "resend-1" });

    await handleWonMetricReductionAlert({ eventId: EVENT_ID }, null, { query, sendEmail, env: ENV, logger: silent });

    const html = sendEmail.mock.calls[0][2] as string;
    expect(html).toContain("Chris Higingbotham");
    expect(html).toContain("Caleb Stone");
    expect(html).not.toContain(REP_FROM);
    expect(html).not.toContain(REP_TO);
    expect(html).toContain("Atlanta, GA");
    expect(html).toContain("reassigned");
  });

  it("claims each recipient before sending, stamps receipts after delivery, and creates deterministic in-app cards", async () => {
    const { query, receipts, notificationIds, calls } = makeQuery();
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "resend-1" });

    await handleWonMetricReductionAlert({ eventId: EVENT_ID }, null, { query, sendEmail, env: ENV, logger: silent });

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls.map((call) => call[0])).toEqual([TAKASHI, ADNAAN]);
    const [, subject, html, options] = sendEmail.mock.calls[0];
    expect(subject).toContain("Won YTD");
    expect(subject).toContain("−$275,295.21");
    expect(html).toContain("$18,002,178.07");
    expect(html).toContain("$17,726,882.86");
    expect(html).toContain("Won closed date changed");
    expect(html).toContain("2026-06-18");
    expect(html).toContain("2025-12-31");
    expect(html).toContain("Audit #8959232");
    expect(html).toContain("Kristy Wilson");
    expect(html).toContain("(update)");
    expect(html).toContain(`https://trockcrm.com/deals/${DEAL_ID}?officeId=${OFFICE_ID}`);
    expect(html).toContain("PR #916 / db65781c");
    expect(options.idempotencyKey).toContain(EVENT_ID);
    expect(sendEmail.mock.calls[0][3].idempotencyKey).not.toBe(sendEmail.mock.calls[1][3].idempotencyKey);

    expect(receipts.get(TAKASHI)?.sent_at).not.toBeNull();
    expect(receipts.get(ADNAAN)?.sent_at).not.toBeNull();
    expect(notificationIds.size).toBe(2);
    const firstClaim = calls.findIndex((call) => call.sql.includes("INSERT INTO public.won_metric_reduction_delivery_receipts"));
    const firstReceiptUpdate = calls.findIndex((call) => call.sql.includes("UPDATE public.won_metric_reduction_delivery_receipts"));
    expect(firstClaim).toBeGreaterThan(-1);
    expect(firstReceiptUpdate).toBeGreaterThan(firstClaim);
    const claimSql = calls[firstClaim]?.sql ?? "";
    expect(claimSql).toContain("ON CONFLICT (event_id, recipient_email) DO UPDATE");
    expect(claimSql).toContain("receipt.sent_at IS NULL");
    expect(claimSql).toContain("receipt.claimed_at <=");
    expect(calls.some((call) => call.sql.includes("'won_metric_decrease'"))).toBe(true);
  });

  it("does not re-email recipients whose receipt is already sent", async () => {
    const { query } = makeQuery({ sentRecipients: [TAKASHI, ADNAAN] });
    const sendEmail = vi.fn();

    await handleWonMetricReductionAlert({ eventId: EVENT_ID }, null, { query, sendEmail, env: ENV, logger: silent });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("defers until a fresh unsent lease expires instead of completing without delivery", async () => {
    const { query, calls } = makeQuery({ activeLeaseRecipients: [TAKASHI] });
    const sendEmail = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await handleWonMetricReductionAlert(
      { eventId: EVENT_ID },
      null,
      { query, sendEmail, env: { ...ENV, WON_METRIC_DECREASE_EMAIL_RECIPIENTS: TAKASHI }, logger },
    );

    expect(result).toEqual({
      status: "pending",
      error: "Won metric reduction delivery is waiting for an active recipient lease",
      runAfterSeconds: 300,
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(calls.some((call) => call.sql.includes("INSERT INTO office_dallas.notifications"))).toBe(false);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("active delivery lease"), expect.objectContaining({ recipientEmail: TAKASHI }));
    const receiptLookup = calls.find((call) => call.sql.includes("FROM public.won_metric_reduction_delivery_receipts"));
    // Regression: the GREATEST(...) call must be closed before ::int, otherwise PostgreSQL fails with
    // "syntax error at or near AS" and the alert email is never sent (prod job 27265).
    expect(receiptLookup?.sql).toContain("))::int AS retry_after_seconds");
  });

  it("delivers to other recipients before deferring an event with one active lease", async () => {
    const { query, receipts } = makeQuery({ activeLeaseRecipients: [TAKASHI] });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "resend-adnaan" });

    const result = await handleWonMetricReductionAlert(
      { eventId: EVENT_ID },
      null,
      { query, sendEmail, env: ENV, logger: silent },
    );

    expect(result).toMatchObject({ status: "pending", runAfterSeconds: 300 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(ADNAAN, expect.any(String), expect.any(String), expect.any(Object));
    expect(receipts.get(ADNAAN)?.sent_at).not.toBeNull();
  });

  it("skips an event whose impacts contain no negative value or count delta", async () => {
    const event = {
      ...BASE_EVENT,
      impacts: {
        "director.won_ytd": {
          ...BASE_EVENT.impacts["director.won_ytd"],
          after: BASE_EVENT.impacts["director.won_ytd"].before,
          delta: 0,
          countAfter: BASE_EVENT.impacts["director.won_ytd"].countBefore,
          countDelta: 0,
        },
      },
    };
    const { query, calls } = makeQuery({ event });
    const sendEmail = vi.fn();

    await handleWonMetricReductionAlert({ eventId: EVENT_ID }, null, { query, sendEmail, env: ENV, logger: silent });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(calls.some((call) => call.sql.includes("won_metric_reduction_delivery_receipts"))).toBe(false);
  });

  it("logs and completes safely when a queued job arrives before the event-table migration", async () => {
    const query = vi.fn().mockRejectedValue(Object.assign(new Error("relation does not exist"), { code: "42P01" }));
    const sendEmail = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(handleWonMetricReductionAlert({ eventId: EVENT_ID }, null, { query: query as any, sendEmail, env: ENV, logger })).resolves.toBeUndefined();

    expect(sendEmail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("not available yet"), expect.objectContaining({ eventId: EVENT_ID }));
  });

  it("releases an unsent lease when the provider fails so the queue retry can reclaim it", async () => {
    const { query, receipts, calls } = makeQuery();
    const sendEmail = vi.fn().mockResolvedValue({ success: false, messageId: null });

    await expect(
      handleWonMetricReductionAlert(
        { eventId: EVENT_ID },
        null,
        { query, sendEmail, env: { ...ENV, WON_METRIC_DECREASE_EMAIL_RECIPIENTS: TAKASHI }, logger: silent },
      ),
    ).rejects.toThrow(/unsuccessful/i);

    expect(receipts.get(TAKASHI)?.sent_at).toBeNull();
    expect(receipts.get(TAKASHI)?.claimed_at).toBe("released");
    expect(calls.some((call) => call.sql.includes("SET claimed_at = NOW() - make_interval"))).toBe(true);
  });

  it("reclaims a released lease and delivers once on the queue retry", async () => {
    const { query, receipts } = makeQuery();
    const failing = vi.fn().mockResolvedValue({ success: false, messageId: null });
    await expect(
      handleWonMetricReductionAlert(
        { eventId: EVENT_ID },
        null,
        { query, sendEmail: failing, env: { ...ENV, WON_METRIC_DECREASE_EMAIL_RECIPIENTS: TAKASHI }, logger: silent },
      ),
    ).rejects.toThrow(/unsuccessful/i);

    const retry = vi.fn().mockResolvedValue({ success: true, messageId: "resend-retry" });
    await handleWonMetricReductionAlert(
      { eventId: EVENT_ID },
      null,
      { query, sendEmail: retry, env: { ...ENV, WON_METRIC_DECREASE_EMAIL_RECIPIENTS: TAKASHI }, logger: silent },
    );

    expect(retry).toHaveBeenCalledTimes(1);
    expect(receipts.get(TAKASHI)?.sent_at).not.toBeNull();
  });
});

describe("buildWonMetricReductionEmail", () => {
  it("leads with the reduced project count when Won value increased", () => {
    const impact = resolveWonMetricImpact(
      {
        "office.won_ytd": {
          scope: "office",
          metric: "won_ytd",
          countBefore: 10,
          countAfter: 9,
          countDelta: -1,
          before: 100,
          after: 200,
          delta: 100,
          unit: "usd",
        },
      },
      "won_ytd",
    );
    const email = buildWonMetricReductionEmail({
      event: {
        dealId: DEAL_ID,
        dealName: "Tides Park Lane",
        dealNumber: "DFW-9-15926-ae",
        reportMetricKey: "won_ytd",
        definitionVersion: null,
        releaseReference: null,
        actionLabel: "Won count changed",
        reasonCode: "won_contribution_reduced",
        changedFields: null,
        auditReference: null,
      },
      impact,
      officeId: OFFICE_ID,
      frontendUrl: "https://trockcrm.com",
    });

    expect(email.subject).toBe("Won metric reduced: Won YTD −1");
    expect(email.subject).not.toContain("+$100");
    expect(email.text).toContain("Won YTD: $100.00 → $200.00 (+$100.00); projects: 10 → 9 (−1)");
  });

  it("uses the metric report for an archived deal instead of an inactive detail URL", async () => {
    const event = {
      ...BASE_EVENT,
      action_label: "Deal deactivated",
      reason_code: "archived_or_deactivated",
      report_metric_key: null,
      impacts: {
        "office.won_ytd": {
          scope: "office",
          metric: "won_ytd",
          countBefore: 276,
          countAfter: 275,
          countDelta: -1,
          before: 18_000_000,
          after: 17_900_000,
          delta: -100_000,
          unit: "usd",
        },
      },
    };
    const { query, calls } = makeQuery({ event });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "resend-archive" });

    await handleWonMetricReductionAlert(
      { eventId: EVENT_ID },
      null,
      { query, sendEmail, env: { ...ENV, WON_METRIC_DECREASE_EMAIL_RECIPIENTS: TAKASHI }, logger: silent },
    );

    const [, , html, options] = sendEmail.mock.calls[0]!;
    const expectedReportUrl = "https://trockcrm.com/deals?filter=won&period=ytd&scope=all&officeId=" + OFFICE_ID;
    expect(options.text).toContain(expectedReportUrl);
    expect(html).toContain(expectedReportUrl.replace(/&/g, "&amp;"));
    expect(html).toContain("Open Deals Dashboard");
    expect(html).not.toContain("/deals/" + DEAL_ID + "?");
    const notificationInsert = calls.find((call) => call.sql.includes("INSERT INTO office_dallas.notifications"));
    expect(notificationInsert?.params[4]).toBe("/deals?filter=won&period=ytd&scope=all");
  });

  it("routes an archived assigned-rep Won impact to the all-reps Deals Dashboard", () => {
    const impact = resolveWonMetricImpact(
      {
        "assigned_rep.44444444-4444-4444-8444-444444444444.won_ytd": {
          scope: "assigned_rep",
          scopeId: "44444444-4444-4444-8444-444444444444",
          metric: "won_ytd",
          countBefore: 2,
          countAfter: 1,
          countDelta: -1,
          before: 200000,
          after: 100000,
          delta: -100000,
          unit: "usd",
        },
      },
      null,
    );
    const email = buildWonMetricReductionEmail({
      event: {
        ...BASE_EVENT,
        dealId: null,
        reportMetricKey: null,
        reasonCode: "deal_deleted",
      },
      impact,
      officeId: OFFICE_ID,
      frontendUrl: "https://trockcrm.com",
    });

    expect(email.reportUrl).toBe(`https://trockcrm.com/deals?filter=won&period=ytd&scope=all&officeId=${OFFICE_ID}`);
  });

  it("uses a report link and release citation when an event is definition-only and has no deal", () => {
    const impact = resolveWonMetricImpact(
      {
        "office.estimator_pipeline.won_ytd": {
          scope: "office",
          metric: "estimator_pipeline.won_ytd",
          countBefore: 3,
          countAfter: 2,
          countDelta: -1,
          before: 300000,
          after: 25000,
          delta: -275000,
          unit: "usd",
        },
      },
      "estimator_pipeline.won_ytd",
    );
    const email = buildWonMetricReductionEmail({
      event: {
        ...BASE_EVENT,
        dealId: null,
        dealName: null,
        dealNumber: null,
        reportMetricKey: "estimator_pipeline.won_ytd",
        definitionVersion: "won-v2",
        releaseReference: "https://github.com/artificialadnaan/trockcrm/pull/916",
        actionLabel: "Estimator Won YTD began excluding change orders",
        reasonCode: "report_definition_changed",
        changedFields: null,
        auditReference: { kind: "release", previousDefinitionHash: "before", definitionHash: "after" },
      },
      impact,
      officeId: OFFICE_ID,
      frontendUrl: "https://trockcrm.com",
    });
    expect(email.dealUrl).toBeNull();
    expect(email.reportUrl).toContain("/reports/operations/estimator-pipeline?officeId=");
    expect(email.html).toContain("Report Definition Changed");
    expect(email.html).toContain("github.com/artificialadnaan/trockcrm/pull/916");
    expect(email.text).not.toContain("Audit citation:");
    expect(email.html).not.toContain("Audit citation");
  });

  it("routes every canonical Deals Won period to the matching report in email and in-app", async () => {
    const periods = [
      ["won_all_time", "https://trockcrm.com/deals?filter=won&scope=all&officeId=" + OFFICE_ID, "/deals?filter=won&scope=all"],
      ["won_wtd", "https://trockcrm.com/deals?filter=won&period=week&scope=all&officeId=" + OFFICE_ID, "/deals?filter=won&period=week&scope=all"],
      ["won_mtd", "https://trockcrm.com/deals?filter=won&period=mtd&scope=all&officeId=" + OFFICE_ID, "/deals?filter=won&period=mtd&scope=all"],
      ["won_qtd", "https://trockcrm.com/deals?filter=won&period=qtd&scope=all&officeId=" + OFFICE_ID, "/deals?filter=won&period=qtd&scope=all"],
      ["won_ytd", "https://trockcrm.com/deals?filter=won&period=ytd&scope=all&officeId=" + OFFICE_ID, "/deals?filter=won&period=ytd&scope=all"],
    ] as const;

    for (const [metric, expectedReportUrl, expectedNotificationLink] of periods) {
      const event = {
        ...BASE_EVENT,
        deal_id: null,
        deal_name: null,
        deal_number: null,
        reason_code: "deal_deleted",
        report_metric_key: `office.${metric}`,
        impacts: {
          [`office.${metric}`]: {
            scope: "office",
            metric,
            countBefore: 1,
            countAfter: 0,
            countDelta: -1,
            before: 300000,
            after: 0,
            delta: -300000,
            unit: "usd",
          },
        },
      };
      const { query, calls } = makeQuery({ event });
      const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: `resend-${metric}` });

      await handleWonMetricReductionAlert(
        { eventId: EVENT_ID },
        null,
        { query, sendEmail, env: { ...ENV, WON_METRIC_DECREASE_EMAIL_RECIPIENTS: TAKASHI }, logger: silent },
      );

      expect(sendEmail.mock.calls[0]?.[3].text).toContain(expectedReportUrl);
      const notificationInsert = calls.find((call) => call.sql.includes("INSERT INTO office_dallas.notifications"));
      expect(notificationInsert?.params[4]).toBe(expectedNotificationLink);
    }
  });

  it("links a definition-only main Deals Dashboard metric back to its Won YTD view", () => {
    const impact = resolveWonMetricImpact(
      {
        "office.deals_dashboard.won_ytd": {
          scope: "office",
          metric: "deals_dashboard.won_ytd",
          countBefore: 278,
          countAfter: 275,
          countDelta: -3,
          before: 18_200_000,
          after: 18_000_000,
          delta: -200_000,
          unit: "usd",
        },
      },
      "deals_dashboard.won_ytd",
    );
    const email = buildWonMetricReductionEmail({
      event: {
        ...BASE_EVENT,
        dealId: null,
        dealName: null,
        dealNumber: null,
        reportMetricKey: "deals_dashboard.won_ytd",
        definitionVersion: "deals-dashboard-won-ytd-v1",
        releaseReference: "PR #917",
        changedFields: null,
        auditReference: null,
      },
      impact,
      officeId: OFFICE_ID,
      frontendUrl: "https://trockcrm.com",
    });

    expect(email.reportUrl).toBe(
      `https://trockcrm.com/deals?filter=won&period=ytd&scope=all&officeId=${OFFICE_ID}`,
    );
    expect(email.html).toContain("Open Deals Dashboard");
  });
});
