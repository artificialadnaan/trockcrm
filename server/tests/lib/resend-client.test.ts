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
      "<p>Body</p>",
      { text: "Body" }
    );

    expect(result).toBe(true);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["rep@example.com", "other@example.com"],
        subject: "Subject",
        html: "<p>Body</p>",
        text: "Body",
      }),
      undefined // no idempotencyKey supplied → SDK's options arg is a no-op undefined
    );
  });

  it("skips empty recipient lists", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await sendSystemEmail([], "Subject", "<p>Body</p>");

    expect(result).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("[Email] No recipients after override — skipping");
    warnSpy.mockRestore();
  });

  it("returns false for resend API errors and thrown send failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sendMock.mockResolvedValueOnce({ error: { message: "bad request" } });

    await expect(sendSystemEmail("rep@example.com", "Subject", "<p>Body</p>")).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalledWith("[Email] Resend error:", { message: "bad request" });

    sendMock.mockRejectedValueOnce(new Error("network down"));
    await expect(sendSystemEmail("rep@example.com", "Subject", "<p>Body</p>")).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalledWith("[Email] Failed to send:", expect.any(Error));
    errorSpy.mockRestore();
  });

  it("threads idempotencyKey to resend.emails.send's second argument when provided", async () => {
    sendMock.mockResolvedValue({ data: { id: "email-idem" } });

    const result = await sendSystemEmail("rep@example.com", "Subject", "<p>Body</p>", {
      idempotencyKey: "dead-letter:dallas:abc123",
    });

    expect(result).toBe(true);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["rep@example.com"], subject: "Subject" }),
      { idempotencyKey: "dead-letter:dallas:abc123" }
    );
  });

  it("passes undefined as the second arg when no idempotencyKey is given (existing callers unaffected)", async () => {
    sendMock.mockResolvedValue({ data: { id: "email-noidem" } });

    await sendSystemEmail("rep@example.com", "Subject", "<p>Body</p>");

    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ subject: "Subject" }), undefined);
  });

  it("treats invalid_idempotent_request as delivered (already sent under the original payload)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    sendMock.mockResolvedValueOnce({ error: { name: "invalid_idempotent_request", message: "already used" } });

    const result = await sendSystemEmail("rep@example.com", "Subject", "<p>Body</p>", {
      idempotencyKey: "dead-letter:dallas:abc123",
    });

    expect(result).toBe(true); // dedup → treat as delivered
    warnSpy.mockRestore();
  });

  it("does NOT treat other errors as delivered even with an idempotencyKey", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sendMock.mockResolvedValueOnce({ error: { name: "concurrent_idempotent_requests", message: "in flight" } });

    const result = await sendSystemEmail("rep@example.com", "Subject", "<p>Body</p>", {
      idempotencyKey: "dead-letter:dallas:abc123",
    });

    expect(result).toBe(false); // original still in flight → not delivered
    errorSpy.mockRestore();
  });
});
