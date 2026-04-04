import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

vi.stubEnv("RESEND_API_KEY", "test-resend-key");

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: {
      send: sendMock,
    },
  })),
}));

const {
  sendSystemEmail,
  resolveSystemEmailRecipient,
  SYSTEM_EMAIL_OVERRIDE_ADDRESS,
} = await import("../../../src/lib/resend-client.js");

describe("system email routing", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("routes all system email recipients to the override address", async () => {
    sendMock.mockResolvedValue({ data: { id: "email-1" } });

    const result = await sendSystemEmail(["rep@example.com", "other@example.com"], "Subject", "<p>Body</p>");

    expect(result).toBe(true);
    expect(resolveSystemEmailRecipient(["rep@example.com"])).toBe(SYSTEM_EMAIL_OVERRIDE_ADDRESS);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: [SYSTEM_EMAIL_OVERRIDE_ADDRESS],
        subject: "Subject",
        html: "<p>Body</p>",
      })
    );
  });
});
