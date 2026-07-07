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

  it("SKIPS the global bcc for an idempotency-keyed send — payload stays byte-stable across retries", async () => {
    vi.stubEnv("SYSTEM_EMAIL_BCC", "monitor@example.com");

    await sendSystemEmailWithMetadata("alice@example.com", "Subject", "<p>Body</p>", { idempotencyKey: "k-1" });

    const payload = sendMock.mock.calls[0][0];
    expect(payload.to).toEqual(["alice@example.com"]);
    // No env bcc added → the Resend payload is identical whether SYSTEM_EMAIL_BCC is set or not, so a keyed retry
    // across a SYSTEM_EMAIL_BCC rollout can still dedupe on the stable key instead of being rejected.
    expect(payload.bcc).toBeUndefined();
  });

  it("keeps an explicit caller bcc on a keyed send (only the ENV bcc is skipped)", async () => {
    vi.stubEnv("SYSTEM_EMAIL_BCC", "monitor@example.com");

    await sendSystemEmailWithMetadata("alice@example.com", "Subject", "<p>Body</p>", {
      idempotencyKey: "k-1",
      bcc: "audit@example.com",
    });

    const payload = sendMock.mock.calls[0][0];
    expect(payload.bcc).toEqual(["audit@example.com"]); // caller bcc preserved; env bcc NOT appended
  });

  it("is ignored under EMAIL_OVERRIDE_RECIPIENT (redirect wins)", async () => {
    vi.stubEnv("EMAIL_OVERRIDE_RECIPIENT", "dev@example.com");
    vi.stubEnv("SYSTEM_EMAIL_BCC", "monitor@example.com");

    await sendSystemEmailWithMetadata("alice@example.com", "Subject", "<p>Body</p>");

    const payload = sendMock.mock.calls[0][0];
    expect(payload.to).toEqual(["dev@example.com"]);
    expect(payload.bcc).toBeUndefined();
  });

  it("passes the idempotencyKey through to Resend unchanged", async () => {
    await sendSystemEmailWithMetadata("alice@example.com", "Subject", "<p>Body</p>", { idempotencyKey: "k-9" });

    expect(sendMock.mock.calls[0][1]).toEqual({ idempotencyKey: "k-9" });
  });
});
