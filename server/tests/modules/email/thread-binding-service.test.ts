import { describe, expect, it } from "vitest";
import {
  activitySourceEntityEnum,
  emailThreadBindings,
  emails,
} from "../../../../shared/src/schema/index.js";

describe("email thread binding schema", () => {
  it("exports the thread binding table and emails.threadBindingId", () => {
    expect(emailThreadBindings).toBeDefined();
    expect(emails.threadBindingId).toBeDefined();
  });

  it("defines provisional seed support and provider conversation identity", () => {
    expect(emailThreadBindings.provisionalUntil).toBeDefined();
    expect(emailThreadBindings.providerConversationId).toBeDefined();
  });

  it("adds mailbox as a valid activity source entity", () => {
    expect(activitySourceEntityEnum.enumValues).toContain("mailbox");
  });
});
