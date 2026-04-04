import { beforeEach, describe, expect, it, vi } from "vitest";

const sendSystemEmailMock = vi.fn();

vi.stubEnv("SYSTEM_NOTIFICATION_EMAIL_OVERRIDE_ADDRESS", "qa.override@example.com");

vi.mock("../../../src/lib/resend-client.js", () => ({
  sendSystemEmail: sendSystemEmailMock,
}));

const {
  classifyNotificationEmail,
  isEligibleForSystemEmailOverride,
  resolveNotificationEmailRecipient,
  sendNotificationEmail,
  systemNotificationEmailOverrideAddress,
} = await import("../../../src/modules/notifications/email-delivery.js");

describe("system email routing", () => {
  beforeEach(() => {
    sendSystemEmailMock.mockReset();
  });

  it("routes critical notification emails to the shared override inbox", async () => {
    sendSystemEmailMock.mockResolvedValue(true);

    const result = await sendNotificationEmail(
      {
        type: "stale_deal",
        title: "Stale deal alert",
        body: "Follow up now",
        link: "/deals/1",
      },
      "rep@example.com"
    );

    expect(result).toBe(true);
    expect(systemNotificationEmailOverrideAddress).toBe("qa.override@example.com");
    expect(classifyNotificationEmail("stale_deal")).toBe("critical_system_notification");
    expect(isEligibleForSystemEmailOverride("critical_system_notification")).toBe(true);
    expect(resolveNotificationEmailRecipient(
      "rep@example.com",
      "critical_system_notification"
    )).toBe("qa.override@example.com");
    expect(sendSystemEmailMock).toHaveBeenCalledWith(
      "qa.override@example.com",
      "Stale deal alert",
      expect.stringContaining("Stale deal alert")
    );
  });

  it("refuses to route non-critical notification emails", async () => {
    const result = await sendNotificationEmail(
      {
        type: "system",
        title: "Generic update",
      },
      "rep@example.com"
    );

    expect(result).toBe(false);
    expect(classifyNotificationEmail("system")).toBe("non_system_notification");
    expect(isEligibleForSystemEmailOverride("non_system_notification")).toBe(false);
    expect(sendSystemEmailMock).not.toHaveBeenCalled();
  });
});
