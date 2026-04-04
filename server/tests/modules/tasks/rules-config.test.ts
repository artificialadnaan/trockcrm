import { describe, expect, it } from "vitest";
import { TASK_RULES } from "../../../src/modules/tasks/rules/config.js";

function makeBidContext(overrides: Record<string, unknown> = {}) {
  return {
    now: new Date("2026-04-04T15:00:00.000Z"),
    officeId: "office-1",
    entityId: "deal:deal-1",
    sourceEvent: "cron.bid_deadline",
    dealId: "deal-1",
    dealName: "Alpha Roof",
    dealOwnerId: "user-1",
    dueAt: new Date("2026-04-18T00:00:00.000Z"),
    daysUntil: 14,
    ...overrides,
  } as any;
}

function makeColdLeadContext(overrides: Record<string, unknown> = {}) {
  return {
    now: new Date("2026-04-04T15:00:00.000Z"),
    officeId: "office-1",
    entityId: "contact:contact-1",
    sourceEvent: "cron.cold_lead_warming",
    contactId: "contact-1",
    contactName: "Brett Smith",
    dealId: "deal-1",
    dealOwnerId: "user-1",
    noTouchDays: 60,
    ...overrides,
  } as any;
}

describe("task rule config", () => {
  it("defines one bid-deadline rule per countdown threshold", () => {
    const bidRules = TASK_RULES.filter((rule) => rule.sourceEvent === "cron.bid_deadline");

    expect(bidRules.map((rule) => rule.id)).toEqual([
      "bid_deadline_14_day",
      "bid_deadline_7_day",
      "bid_deadline_1_day",
    ]);
    expect(bidRules.map((rule) => rule.reasonCode)).toEqual([
      "bid_deadline_14_day",
      "bid_deadline_7_day",
      "bid_deadline_1_day",
    ]);

    expect(bidRules[0]?.buildDedupeKey(makeBidContext())).toBe("deal:deal-1:bid_deadline:14");
    expect(bidRules[1]?.buildDedupeKey(makeBidContext({ daysUntil: 7, dueAt: new Date("2026-04-11T00:00:00.000Z") }))).toBe(
      "deal:deal-1:bid_deadline:7"
    );
    expect(bidRules[2]?.buildDedupeKey(makeBidContext({ daysUntil: 1, dueAt: new Date("2026-04-05T00:00:00.000Z") }))).toBe(
      "deal:deal-1:bid_deadline:1"
    );
  });

  it("defines the cold-lead warming rule with a stable dedupe key", () => {
    const coldLeadRule = TASK_RULES.find((rule) => rule.id === "cold_lead_warming");
    expect(coldLeadRule).toBeDefined();
    expect(coldLeadRule?.sourceEvent).toBe("cron.cold_lead_warming");
    expect(coldLeadRule?.buildDedupeKey(makeColdLeadContext())).toBe("contact:contact-1:cold_lead_warming");
  });
});
