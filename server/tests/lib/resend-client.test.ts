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

const { sendSystemEmail } = await import("../../src/lib/resend-client.js");

describe("resend client", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("sends system email to the caller-provided recipient list", async () => {
    sendMock.mockResolvedValue({ data: { id: "email-1" } });

    const result = await sendSystemEmail(
      ["rep@example.com", "other@example.com"],
      "Subject",
      "<p>Body</p>"
    );

    expect(result).toBe(true);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["rep@example.com", "other@example.com"],
        subject: "Subject",
        html: "<p>Body</p>",
      })
    );
  });
});
