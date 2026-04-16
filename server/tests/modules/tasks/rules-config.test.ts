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

function makeWonDealContext(overrides: Record<string, unknown> = {}) {
  return {
    now: new Date("2026-04-04T15:00:00.000Z"),
    officeId: "office-1",
    entityId: "deal:deal-1",
    sourceEvent: "deal.won.handoff",
    dealId: "deal-1",
    dealName: "Alpha Roof",
    dealNumber: "D-1001",
    dealOwnerId: "user-1",
    taskAssigneeId: "user-1",
    primaryContactName: "Brett Smith",
    companyName: "Acme Roofing",
    projectTypeId: "pt-2",
    projectTypeName: "Gutters",
    ...overrides,
  } as any;
}

function makeScopingActivatedContext(overrides: Record<string, unknown> = {}) {
  return {
    now: new Date("2026-04-08T15:00:00.000Z"),
    officeId: "office-1",
    entityId: "deal:deal-1",
    dealId: "deal-1",
    dealName: "Alpha Roof",
    dealNumber: "D-1001",
    dealOwnerId: "user-1",
    taskAssigneeId: "user-1",
    ...overrides,
  } as any;
}

function makeLostDealContext(overrides: Record<string, unknown> = {}) {
  return {
    now: new Date("2026-04-04T15:00:00.000Z"),
    officeId: "office-1",
    entityId: "deal:deal-2",
    sourceEvent: "deal.lost.competitor_intel",
    dealId: "deal-2",
    dealName: "Beta Roof",
    dealOwnerId: "user-2",
    taskAssigneeId: "user-2",
    contactName: "Brett Smith",
    triggerDealId: "deal-1",
    triggerDealName: "Lost Bid",
    triggerDealNumber: "D-1001",
    lostCompetitor: "Acme Exteriors",
    ...overrides,
  } as any;
}

function makeWeeklyDigestContext(overrides: Record<string, unknown> = {}) {
  return {
    now: new Date("2026-04-06T12:00:00.000Z"),
    officeId: "office-1",
    officeName: "Beta",
    entityId: "office:office-1",
    sourceEvent: "cron.weekly_digest",
    taskAssigneeId: "director-1",
    staleCount: 3,
    approachingCount: 2,
    newDealsCount: 4,
    pipelineValue: 250000,
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
      "stale_lead",
      "daily_close_date_follow_up",
      "daily_first_outreach_touchpoint",
      "daily_cadence_overdue_follow_up",
    ]);
    expect(dailyRules.map((rule) => rule.reasonCode)).toEqual([
      "stale_lead",
      "daily_close_date_follow_up",
      "daily_first_outreach_touchpoint",
      "daily_cadence_overdue_follow_up",
    ]);

    expect(
      dailyRules[0]?.buildDedupeKey(
        makeDailyTaskContext({
          entityId: "lead:lead-1",
          sourceEvent: "cron.daily_task_generation.stale_lead",
          leadId: "lead-1",
          leadName: "Acme HQ lobby remodel",
          stage: "Qualified",
          stageEnteredAt: new Date("2026-03-29T12:00:00.000Z"),
        })
      )
    ).toBe("lead:lead-1:stage_entered:2026-03-29T12:00:00.000Z");
    expect(dailyRules[1]?.buildDedupeKey(makeDailyTaskContext())).toBe("deal:deal-1:daily_close_date_follow_up");
    expect(
      dailyRules[2]?.buildDedupeKey(
        makeDailyTaskContext({
          sourceEvent: "cron.daily_task_generation.first_outreach_touchpoint",
          entityId: "contact:contact-1",
        })
      )
    ).toBe("contact:contact-1:daily_first_outreach_touchpoint");
    expect(
      dailyRules[3]?.buildDedupeKey(
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

  it("defines the won-deal handoff sequence with stable dedupe keys", () => {
    const handoffRules = TASK_RULES.filter((rule) => rule.sourceEvent === "deal.won.handoff");

    expect(handoffRules.map((rule) => rule.id)).toEqual([
      "deal_won_schedule_kickoff",
      "deal_won_send_welcome_packet",
      "deal_won_introduce_project_team",
      "deal_won_verify_procore_project",
    ]);
    expect(handoffRules[0]?.buildDedupeKey(makeWonDealContext())).toBe("deal:deal-1:won_handoff:schedule_kickoff");
    expect(handoffRules[1]?.buildDedupeKey(makeWonDealContext())).toBe("deal:deal-1:won_handoff:send_welcome_packet");
    expect(handoffRules[2]?.buildDedupeKey(makeWonDealContext())).toBe("deal:deal-1:won_handoff:introduce_project_team");
    expect(handoffRules[3]?.buildDedupeKey(makeWonDealContext())).toBe("deal:deal-1:won_handoff:verify_procore_project");
  });

  it("defines scoping activation rules for estimating and service handoff", () => {
    const scopingRules = TASK_RULES.filter((rule) =>
      rule.sourceEvent.startsWith("scoping_intake.activated.")
    );

    expect(scopingRules.map((rule) => rule.id)).toEqual([
      "scoping_estimating_review_handoff",
      "scoping_service_review_handoff",
    ]);

    expect(
      scopingRules[0]?.buildDedupeKey(
        makeScopingActivatedContext({
          sourceEvent: "scoping_intake.activated.estimating",
        })
      )
    ).toBe("deal:deal-1:scoping_handoff:estimating_review");
    expect(
      scopingRules[1]?.buildDedupeKey(
        makeScopingActivatedContext({
          sourceEvent: "scoping_intake.activated.service",
        })
      )
    ).toBe("deal:deal-1:scoping_handoff:service_review");
  });

  it("builds the scoping estimating handoff draft from the activation event", async () => {
    const estimatingRule = TASK_RULES.find((rule) => rule.id === "scoping_estimating_review_handoff");
    expect(estimatingRule).toBeDefined();

    const draft = await estimatingRule!.buildTask(
      makeScopingActivatedContext({
        sourceEvent: "scoping_intake.activated.estimating",
      })
    );

    expect(draft).toMatchObject({
      title: "Review scoping intake for Alpha Roof",
      description: "Scoping is complete. Start estimating handoff for Alpha Roof (D-1001).",
      sourceEvent: "scoping_intake.activated.estimating",
      dedupeKey: "deal:deal-1:scoping_handoff:estimating_review",
      dealId: "deal-1",
      assignedTo: "user-1",
      priority: "high",
      status: "pending",
    });
  });

  it("builds the won-deal cross-sell draft", async () => {
    const crossSellRule = TASK_RULES.find((rule) => rule.id === "deal_won_cross_sell_opportunity");
    expect(crossSellRule).toBeDefined();

    const draft = await crossSellRule!.buildTask(makeWonDealContext({ sourceEvent: "deal.won.cross_sell" }));

    expect(draft).toMatchObject({
      title: "Explore Gutters opportunities with Acme Roofing",
      type: "system",
      assignedTo: "user-1",
      officeId: "office-1",
      originRule: "deal_won_cross_sell_opportunity",
      sourceRule: "deal_won_cross_sell_opportunity",
      sourceEvent: "deal.won.cross_sell",
      dedupeKey: "deal:deal-1:cross_sell:pt-2",
      reasonCode: "deal_won_cross_sell_opportunity",
      priority: "normal",
      status: "pending",
      dealId: "deal-1",
    });
  });

  it("builds the competitor-intelligence draft from deal.lost", async () => {
    const competitorRule = TASK_RULES.find((rule) => rule.id === "deal_lost_competitor_intel");
    expect(competitorRule).toBeDefined();

    const draft = await competitorRule!.buildTask(makeLostDealContext());

    expect(draft).toMatchObject({
      title: "Heads up: Brett Smith chose Acme Exteriors on Lost Bid. Review strategy for Beta Roof",
      type: "system",
      assignedTo: "user-2",
      officeId: "office-1",
      originRule: "deal_lost_competitor_intel",
      sourceRule: "deal_lost_competitor_intel",
      sourceEvent: "deal.lost.competitor_intel",
      dedupeKey: "deal:deal-2:lost_competitor:deal-1:Acme Exteriors",
      reasonCode: "deal_lost_competitor_intel",
      priority: "urgent",
      status: "pending",
      dealId: "deal-2",
    });
  });

  it("builds the weekly digest draft for a director/admin assignee", async () => {
    const digestRule = TASK_RULES.find((rule) => rule.id === "weekly_pipeline_digest");
    expect(digestRule).toBeDefined();
    expect(digestRule?.buildDedupeKey(makeWeeklyDigestContext())).toBe(
      "office:office-1:assignee:director-1:weekly_digest:2026-04-06"
    );

    const draft = await digestRule!.buildTask(makeWeeklyDigestContext());

    expect(draft).toMatchObject({
      title: "Weekly Digest: 3 stale, 2 approaching deadline, 4 new — $250,000 pipeline",
      type: "system",
      assignedTo: "director-1",
      officeId: "office-1",
      originRule: "weekly_pipeline_digest",
      sourceRule: "weekly_pipeline_digest",
      sourceEvent: "cron.weekly_digest",
      dedupeKey: "office:office-1:assignee:director-1:weekly_digest:2026-04-06",
      reasonCode: "weekly_pipeline_digest",
      priority: "normal",
      status: "pending",
    });
    expect(draft?.description).toContain("Weekly Pipeline Digest for Beta");
  });
});
