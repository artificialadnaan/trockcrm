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

  it("treats 409 invalid_idempotent_request (already delivered under a different payload) as success — no strand", async () => {
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { statusCode: 409, name: "invalid_idempotent_request", message: "This idempotency key was previously used with a different request." },
    });

    const result = await sendSystemEmailWithMetadata("alice@example.com", "Subject", "<p>Body</p>", { idempotencyKey: "k-1" });

    expect(result.success).toBe(true);
  });

  it("does NOT treat concurrent_idempotent_requests as delivered (original still in flight → falls through to fail)", async () => {
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { statusCode: 409, name: "concurrent_idempotent_requests", message: "Another request with this idempotency key is in progress." },
    });

    const result = await sendSystemEmailWithMetadata("alice@example.com", "Subject", "<p>Body</p>", { idempotencyKey: "k-1" });

    expect(result.success).toBe(false);
  });

  it("still FAILS on a non-conflict Resend error", async () => {
    sendMock.mockResolvedValueOnce({ data: null, error: { statusCode: 500, name: "internal_error", message: "boom" } });

    const result = await sendSystemEmailWithMetadata("alice@example.com", "Subject", "<p>Body</p>", { idempotencyKey: "k-1" });

    expect(result.success).toBe(false);
  });
});

describe("what a caller LEARNS from a failure", () => {
  // `outcome` answers "is a re-send safe". It does not answer "what do I do about this", and a caller that
  // persists a failure for a human to act on needs both — `rejected` covers a typo in a client's domain
  // (fix: correct the address), a rate limit (fix: wait) and an unset RESEND_API_KEY (fix: an env var)
  // alike. `reason` is what carries them apart.
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ data: { id: "m-1" } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
  });

  it("carries the provider's own name and message back, not just success:false", async () => {
    sendMock.mockResolvedValueOnce({
      data: null,
      error: {
        statusCode: 422,
        name: "validation_error",
        message: "Invalid `to` field. The following addresses are invalid: jay@exmaple.cmo",
      },
    });

    const result = await sendSystemEmailWithMetadata("jay@exmaple.cmo", "Subject", "<p>Body</p>");

    expect(result.outcome).toBe("rejected");
    expect(result.reason).toContain("validation_error");
    expect(result.reason).toContain("422");
    expect(result.reason).toContain("jay@exmaple.cmo");
  });

  it("carries the swallowed-fetch shape resend@6 returns for a transport failure", async () => {
    // Verified against node_modules/resend/dist/index.cjs: `fetchRequest` wraps the WHOLE fetch in
    // try/catch and returns exactly this on any throw, so a socket hang-up, a DNS failure and a gateway
    // timeout never reach a caller as an exception. `statusCode: null` is what makes it `unknown` — no
    // request outcome exists — rather than a definitive rejection.
    sendMock.mockResolvedValueOnce({
      data: null,
      error: {
        name: "application_error",
        statusCode: null,
        message: "Unable to fetch data. The request could not be resolved.",
      },
    });

    const result = await sendSystemEmailWithMetadata("alice@example.com", "Subject", "<p>Body</p>");

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("unknown");
    expect(result.reason).toContain("application_error");
    expect(result.reason).toContain("could not be resolved");
  });

  it("names the missing key when RESEND_API_KEY is unset in production", async () => {
    // The one production failure that never reaches Resend at all. Without a reason it is indistinguishable
    // from a malformed address, and the fixes have nothing in common.
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("NODE_ENV", "production");

    const result = await sendSystemEmailWithMetadata("alice@example.com", "Subject", "<p>Body</p>");

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toMatch(/RESEND_API_KEY/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("adds nothing to a successful send", async () => {
    const result = await sendSystemEmailWithMetadata("alice@example.com", "Subject", "<p>Body</p>");

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("delivered");
    expect(result.reason ?? null).toBeNull();
  });
});
