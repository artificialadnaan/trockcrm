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

function makeDailyTaskContext(overrides: Record<string, unknown> = {}) {
  return {
    now: new Date("2026-04-04T15:00:00.000Z"),
    officeId: "office-1",
    entityId: "deal:deal-1",
    sourceEvent: "cron.daily_task_generation.close_date_follow_up",
    dealId: "deal-1",
    dealName: "Alpha Roof",
    dealNumber: "D-1001",
    dealOwnerId: "user-1",
    taskAssigneeId: "user-1",
    dueAt: new Date("2026-04-11T00:00:00.000Z"),
    contactId: "contact-1",
    contactName: "Brett Smith",
    lastContactedAt: new Date("2026-03-20T00:00:00.000Z"),
    touchpointCadenceDays: 10,
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

  it("defines the daily task generation rules with stable dedupe keys", () => {
    const dailyRules = TASK_RULES.filter((rule) =>
      rule.sourceEvent.startsWith("cron.daily_task_generation")
    );

    expect(dailyRules.map((rule) => rule.id)).toEqual([
      "daily_close_date_follow_up",
      "daily_first_outreach_touchpoint",
      "daily_cadence_overdue_follow_up",
    ]);
    expect(dailyRules.map((rule) => rule.reasonCode)).toEqual([
      "daily_close_date_follow_up",
      "daily_first_outreach_touchpoint",
      "daily_cadence_overdue_follow_up",
    ]);

    expect(dailyRules[0]?.buildDedupeKey(makeDailyTaskContext())).toBe("deal:deal-1:daily_close_date_follow_up");
    expect(
      dailyRules[1]?.buildDedupeKey(
        makeDailyTaskContext({
          sourceEvent: "cron.daily_task_generation.first_outreach_touchpoint",
          entityId: "contact:contact-1",
        })
      )
    ).toBe("contact:contact-1:daily_first_outreach_touchpoint");
    expect(
      dailyRules[2]?.buildDedupeKey(
        makeDailyTaskContext({
          sourceEvent: "cron.daily_task_generation.cadence_overdue_follow_up",
          entityId: "contact:contact-1",
        })
      )
    ).toBe("deal:deal-1:daily_cadence_overdue_follow_up");
  });

  it("builds the close-date follow-up draft from the daily task scan", async () => {
    const closeDateRule = TASK_RULES.find((rule) => rule.id === "daily_close_date_follow_up");
    expect(closeDateRule).toBeDefined();

    const draft = await closeDateRule!.buildTask(makeDailyTaskContext());

    expect(draft).toMatchObject({
      title: "Follow up: D-1001 closes 2026-04-11",
      description: "Alpha Roof has an expected close date of 2026-04-11. Ensure all pre-close tasks are complete.",
      type: "follow_up",
      assignedTo: "user-1",
      officeId: "office-1",
      originRule: "daily_close_date_follow_up",
      sourceRule: "daily_close_date_follow_up",
      sourceEvent: "cron.daily_task_generation.close_date_follow_up",
      dedupeKey: "deal:deal-1:daily_close_date_follow_up",
      reasonCode: "daily_close_date_follow_up",
      priority: "high",
      status: "pending",
      dealId: "deal-1",
    });
  });

  it("builds the first-outreach touchpoint draft from the daily task scan", async () => {
    const touchpointRule = TASK_RULES.find((rule) => rule.id === "daily_first_outreach_touchpoint");
    expect(touchpointRule).toBeDefined();

    const draft = await touchpointRule!.buildTask(
      makeDailyTaskContext({
        sourceEvent: "cron.daily_task_generation.first_outreach_touchpoint",
        entityId: "contact:contact-1",
      })
    );

    expect(draft).toMatchObject({
      title: "First outreach needed: Brett Smith",
      type: "touchpoint",
      assignedTo: "user-1",
      officeId: "office-1",
      originRule: "daily_first_outreach_touchpoint",
      sourceRule: "daily_first_outreach_touchpoint",
      sourceEvent: "cron.daily_task_generation.first_outreach_touchpoint",
      dedupeKey: "contact:contact-1:daily_first_outreach_touchpoint",
      reasonCode: "daily_first_outreach_touchpoint",
      priority: "normal",
      status: "pending",
      contactId: "contact-1",
    });
  });

  it("builds the cadence-overdue follow-up draft from the daily task scan", async () => {
    const cadenceRule = TASK_RULES.find((rule) => rule.id === "daily_cadence_overdue_follow_up");
    expect(cadenceRule).toBeDefined();

    const draft = await cadenceRule!.buildTask(
      makeDailyTaskContext({
        sourceEvent: "cron.daily_task_generation.cadence_overdue_follow_up",
        entityId: "contact:contact-1",
      })
    );

    expect(draft).toMatchObject({
      title: "Contact Follow-Up: Brett Smith",
      description:
        "Touchpoint cadence overdue for Brett Smith on deal D-1001. Last contact: 2026-03-20",
      type: "follow_up",
      assignedTo: "user-1",
      officeId: "office-1",
      originRule: "daily_cadence_overdue_follow_up",
      sourceRule: "daily_cadence_overdue_follow_up",
      sourceEvent: "cron.daily_task_generation.cadence_overdue_follow_up",
      dedupeKey: "deal:deal-1:daily_cadence_overdue_follow_up",
      reasonCode: "daily_cadence_overdue_follow_up",
      priority: "normal",
      status: "pending",
      dealId: "deal-1",
      contactId: "contact-1",
    });
  });
});
