import { describe, expect, it } from "vitest";
import { TASK_RULES } from "../../../src/modules/tasks/rules/config.js";

function makeContactContext(overrides: Record<string, unknown> = {}) {
  return {
    now: new Date("2026-04-04T15:00:00.000Z"),
    officeId: "office-1",
    entityId: "contact:contact-1",
    sourceEvent: "contact.created",
    contactId: "contact-1",
    contactName: "Brett Smith",
    taskAssigneeId: "user-1",
    ...overrides,
  } as any;
}

function makeActivityContext(overrides: Record<string, unknown> = {}) {
  return {
    now: new Date("2026-04-04T15:00:00.000Z"),
    officeId: "office-1",
    entityId: "activity:activity-1",
    sourceEvent: "activity.created",
    contactId: "contact-1",
    contactName: "Brett Smith",
    taskAssigneeId: "user-1",
    dealId: "deal-1",
    ...overrides,
  } as any;
}

describe("contact and activity task rules", () => {
  it("defines the contact.created onboarding sequence with stable dedupe keys", () => {
    const onboardingRules = TASK_RULES.filter((rule) => rule.sourceEvent === "contact.created");

    expect(onboardingRules.map((rule) => rule.id)).toEqual([
      "contact_onboarding_intro_email",
      "contact_onboarding_follow_up_call",
      "contact_onboarding_check_response",
    ]);
    expect(onboardingRules.map((rule) => rule.reasonCode)).toEqual([
      "contact_onboarding_intro_email",
      "contact_onboarding_follow_up_call",
      "contact_onboarding_check_response",
    ]);
    expect(onboardingRules[0]?.buildDedupeKey(makeContactContext())).toBe(
      "contact:contact-1:assignee:user-1:onboarding:intro_email"
    );
    expect(onboardingRules[1]?.buildDedupeKey(makeContactContext())).toBe(
      "contact:contact-1:assignee:user-1:onboarding:follow_up_call"
    );
    expect(onboardingRules[2]?.buildDedupeKey(makeContactContext())).toBe(
      "contact:contact-1:assignee:user-1:onboarding:check_response"
    );
  });

  it("builds the meeting follow-up task from activity.created", async () => {
    const followUpRule = TASK_RULES.find((rule) => rule.id === "activity_meeting_follow_up");
    expect(followUpRule).toBeDefined();

    const draft = await followUpRule!.buildTask(makeActivityContext());

    expect(draft).toMatchObject({
      title: "Send follow-up from meeting with Brett Smith",
      type: "follow_up",
      assignedTo: "user-1",
      officeId: "office-1",
      originRule: "activity_meeting_follow_up",
      sourceRule: "activity_meeting_follow_up",
      sourceEvent: "activity.created",
      dedupeKey: "contact:contact-1:assignee:user-1:meeting_follow_up",
      reasonCode: "activity_meeting_follow_up",
      priority: "high",
      status: "pending",
      dealId: "deal-1",
      contactId: "contact-1",
    });
  });
});
