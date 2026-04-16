import { describe, expect, it } from "vitest";
import { TASK_RULES } from "../../../src/modules/tasks/rules/config.js";

function makeEmailContext(overrides: Record<string, unknown> = {}) {
  return {
    now: new Date("2026-04-04T15:00:00.000Z"),
    officeId: "office-1",
    entityId: "email:email-1",
    sourceEvent: "email.received",
    emailId: "email-1",
    contactId: "contact-1",
    taskAssigneeId: "user-1",
    contactName: "Brett Smith",
    emailSubject: "Project Alpha follow-up",
    dealId: "deal-1",
    activeDealCount: 1,
    activeDealNames: ["D-1001 Project Alpha"],
    ...overrides,
  } as any;
}

describe("inbound email task rules", () => {
  it("splits reply-needed and disambiguation into distinct rules", () => {
    const emailRules = TASK_RULES.filter((rule) => rule.sourceEvent === "email.received");

    expect(emailRules).toHaveLength(2);
    expect(emailRules.map((rule) => rule.id)).toEqual([
      "inbound_email_reply_needed",
      "inbound_email_deal_disambiguation",
    ]);
    expect(emailRules.map((rule) => rule.reasonCode)).toEqual([
      "reply_needed",
      "deal_disambiguation",
    ]);
  });

  it("builds a reply-needed draft for a clearly associated inbound email", async () => {
    const replyRule = TASK_RULES.find((rule) => rule.id === "inbound_email_reply_needed");
    expect(replyRule).toBeDefined();

    const draft = await replyRule!.buildTask(makeEmailContext());

    expect(draft).toMatchObject({
      title: "Reply to Brett Smith: Project Alpha follow-up",
      type: "inbound_email",
      assignedTo: "user-1",
      officeId: "office-1",
      originRule: "inbound_email_reply_needed",
      sourceRule: "inbound_email_reply_needed",
      sourceEvent: "email.received",
      dedupeKey: "email:email-1:reply_needed",
      reasonCode: "reply_needed",
      priority: "high",
      priorityScore: 80,
      status: "pending",
      dealId: "deal-1",
      contactId: "contact-1",
      emailId: "email-1",
    });
  });

  it("builds a reply-needed draft when a multi-deal contact is explicitly resolved to a deal", async () => {
    const replyRule = TASK_RULES.find((rule) => rule.id === "inbound_email_reply_needed");
    expect(replyRule).toBeDefined();

    const draft = await replyRule!.buildTask(
      makeEmailContext({
        dealId: "deal-2",
        activeDealCount: 2,
        activeDealNames: ["D-1001 Project Alpha", "D-1002 Project Beta"],
      })
    );

    expect(draft).toMatchObject({
      title: "Reply to Brett Smith: Project Alpha follow-up",
      type: "inbound_email",
      assignedTo: "user-1",
      officeId: "office-1",
      originRule: "inbound_email_reply_needed",
      sourceRule: "inbound_email_reply_needed",
      sourceEvent: "email.received",
      dedupeKey: "email:email-1:reply_needed",
      reasonCode: "reply_needed",
      priority: "high",
      priorityScore: 80,
      status: "pending",
      dealId: "deal-2",
      contactId: "contact-1",
      emailId: "email-1",
    });
  });

  it("builds a disambiguation draft when a contact has multiple active deals", async () => {
    const disambiguationRule = TASK_RULES.find((rule) => rule.id === "inbound_email_deal_disambiguation");
    expect(disambiguationRule).toBeDefined();

    const draft = await disambiguationRule!.buildTask(
      makeEmailContext({
        dealId: null,
        activeDealCount: 3,
        activeDealNames: ["D-1001 Project Alpha", "D-1002 Project Beta", "D-1003 Project Gamma"],
      })
    );

    expect(draft).toMatchObject({
      title: "Associate email to correct deal",
      type: "inbound_email",
      assignedTo: "user-1",
      officeId: "office-1",
      originRule: "inbound_email_deal_disambiguation",
      sourceRule: "inbound_email_deal_disambiguation",
      sourceEvent: "email.received",
      dedupeKey: "email:email-1:deal_disambiguation",
      reasonCode: "deal_disambiguation",
      priority: "normal",
      priorityScore: 50,
      status: "pending",
      contactId: "contact-1",
      emailId: "email-1",
    });
  });
});
