import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

vi.stubEnv("RESEND_API_KEY", "test-resend-key");

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: sendMock },
  })),
}));

const { sendSystemEmailWithMetadata } = await import("../../src/lib/system-email.js");

describe("worker SYSTEM_EMAIL_BCC", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ data: { id: "m-1" } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
  });

  it("delivers to the real recipient AND bccs SYSTEM_EMAIL_BCC for a NON-keyed send", async () => {
    vi.stubEnv("SYSTEM_EMAIL_BCC", "monitor@example.com");

    await sendSystemEmailWithMetadata("alice@example.com", "Subject", "<p>Body</p>");

    const payload = sendMock.mock.calls[0][0];
    expect(payload.to).toEqual(["alice@example.com"]);
    expect(payload.bcc).toEqual(["monitor@example.com"]);
  });

  it("bccs SYSTEM_EMAIL_BCC for idempotency-KEYED sends too (full coverage) and passes the key through", async () => {
    vi.stubEnv("SYSTEM_EMAIL_BCC", "monitor@example.com");

    await sendSystemEmailWithMetadata("alice@example.com", "Subject", "<p>Body</p>", { idempotencyKey: "k-1" });

    const payload = sendMock.mock.calls[0][0];
    expect(payload.bcc).toEqual(["monitor@example.com"]);
    expect(sendMock.mock.calls[0][1]).toEqual({ idempotencyKey: "k-1" });
  });

  it("appends the global bcc after a caller bcc and de-dupes case-insensitively within the list", async () => {
    vi.stubEnv("SYSTEM_EMAIL_BCC", "monitor@example.com, Monitor@example.com, audit@example.com");

    await sendSystemEmailWithMetadata("alice@example.com", "Subject", "<p>Body</p>", { bcc: "existing@example.com" });

    const payload = sendMock.mock.calls[0][0];
    // The duplicate "Monitor@example.com" is dropped; caller bcc kept, global bccs appended.
    expect(payload.bcc).toEqual(["existing@example.com", "monitor@example.com", "audit@example.com"]);
  });

  it("does NOT bcc an address already on the to/cc (de-duped, case-insensitive)", async () => {
    vi.stubEnv("SYSTEM_EMAIL_BCC", "Alice@Example.com, monitor@example.com");

    await sendSystemEmailWithMetadata("alice@example.com", "Subject", "<p>Body</p>");

    const payload = sendMock.mock.calls[0][0];
    expect(payload.bcc).toEqual(["monitor@example.com"]); // alice dropped — already the recipient
  });

  it("is ignored under EMAIL_OVERRIDE_RECIPIENT (redirect wins)", async () => {
    vi.stubEnv("EMAIL_OVERRIDE_RECIPIENT", "dev@example.com");
    vi.stubEnv("SYSTEM_EMAIL_BCC", "monitor@example.com");

    await sendSystemEmailWithMetadata("alice@example.com", "Subject", "<p>Body</p>");

    const payload = sendMock.mock.calls[0][0];
    expect(payload.to).toEqual(["dev@example.com"]);
    expect(payload.bcc).toBeUndefined();
  });

  it("treats a Resend same-key/different-payload conflict as an already-delivered success (no strand)", async () => {
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { statusCode: 422, name: "invalid_idempotency_key", message: "Idempotency key already used with a different payload" },
    });

    const result = await sendSystemEmailWithMetadata("alice@example.com", "Subject", "<p>Body</p>", { idempotencyKey: "k-1" });

    expect(result.success).toBe(true);
  });

  it("still FAILS on a non-conflict Resend error", async () => {
    sendMock.mockResolvedValueOnce({ data: null, error: { statusCode: 500, name: "internal_error", message: "boom" } });

    const result = await sendSystemEmailWithMetadata("alice@example.com", "Subject", "<p>Body</p>", { idempotencyKey: "k-1" });

    expect(result.success).toBe(false);
  });
});
