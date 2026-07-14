import { describe, expect, it, vi } from "vitest";
import {
  buildWonMetricReductionEmail,
  DEFAULT_WON_METRIC_DECREASE_RECIPIENTS,
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
      return { rows: receipt ? [receipt] : [] };
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
      const email = String(params[0]).toLowerCase();
      if (email === TAKASHI) return { rows: [{ id: TAKASHI_ID }] };
      if (email === ADNAAN) return { rows: [{ id: ADNAAN_ID }] };
      return { rows: [] };
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
  WON_METRIC_DECREASE_EMAIL_RECIPIENTS: ` ${TAKASHI}, invalid, ${ADNAAN}, TAKASHI `,
} as NodeJS.ProcessEnv;
const silent = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("resolveWonMetricDecreaseRecipients", () => {
  it("trims, validates, lowercases, and de-dupes the configured recipient list", () => {
    expect(resolveWonMetricDecreaseRecipients(ENV)).toEqual([TAKASHI, ADNAAN]);
  });

  it("defaults to Takashi and Adnaan when no deployment override is supplied", () => {
    expect(resolveWonMetricDecreaseRecipients({} as NodeJS.ProcessEnv)).toEqual([...DEFAULT_WON_METRIC_DECREASE_RECIPIENTS]);
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
});

describe("handleWonMetricReductionAlert", () => {
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

  it("does not send concurrently when another worker owns a fresh unsent lease", async () => {
    const { query, calls } = makeQuery({ activeLeaseRecipients: [TAKASHI] });
    const sendEmail = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await handleWonMetricReductionAlert(
      { eventId: EVENT_ID },
      null,
      { query, sendEmail, env: { ...ENV, WON_METRIC_DECREASE_EMAIL_RECIPIENTS: TAKASHI }, logger },
    );

    expect(sendEmail).not.toHaveBeenCalled();
    expect(calls.some((call) => call.sql.includes("INSERT INTO office_dallas.notifications"))).toBe(false);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("active delivery lease"), expect.objectContaining({ recipientEmail: TAKASHI }));
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
      report_metric_key: "deals_dashboard.won_ytd",
      impacts: {
        "office.deals_dashboard.won_ytd": {
          scope: "office",
          metric: "deals_dashboard.won_ytd",
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
    const expectedReportUrl = "https://trockcrm.com/deals?filter=won&period=ytd&officeId=" + OFFICE_ID;
    expect(options.text).toContain(expectedReportUrl);
    expect(html).toContain(expectedReportUrl.replace(/&/g, "&amp;"));
    expect(html).toContain("Open Deals Dashboard");
    expect(html).not.toContain("/deals/" + DEAL_ID + "?");
    const notificationInsert = calls.find((call) => call.sql.includes("INSERT INTO office_dallas.notifications"));
    expect(notificationInsert?.params[4]).toBe("/deals?filter=won&period=ytd");
  });

  it("uses a report link and release citation when an event is definition-only and has no deal", () => {
    const impact = resolveWonMetricImpact(BASE_EVENT.impacts, "director.won_ytd");
    const email = buildWonMetricReductionEmail({
      event: {
        ...BASE_EVENT,
        dealId: null,
        dealName: null,
        dealNumber: null,
        reportMetricKey: "director.won_ytd",
        definitionVersion: "won-v2",
        releaseReference: "https://github.com/artificialadnaan/trockcrm/pull/916",
        actionLabel: "Estimator Won YTD began excluding change orders",
        reasonCode: "report_definition_changed",
        changedFields: null,
        auditReference: null,
      },
      impact,
      officeId: OFFICE_ID,
      frontendUrl: "https://trockcrm.com",
    });
    expect(email.dealUrl).toBeNull();
    expect(email.reportUrl).toContain("/reports/operations/estimator-pipeline?officeId=");
    expect(email.html).toContain("Report Definition Changed");
    expect(email.html).toContain("github.com/artificialadnaan/trockcrm/pull/916");
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
      `https://trockcrm.com/deals?filter=won&period=ytd&officeId=${OFFICE_ID}`,
    );
    expect(email.html).toContain("Open Deals Dashboard");
  });
});
