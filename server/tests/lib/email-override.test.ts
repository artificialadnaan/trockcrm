import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("EMAIL_OVERRIDE_RECIPIENT", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ data: { id: "email-1" } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
  });

  it("routes all mail to override address when set", async () => {
    vi.stubEnv("EMAIL_OVERRIDE_RECIPIENT", "dev@example.com");

    await sendSystemEmail(
      ["alice@example.com", "bob@example.com"],
      "Hello there",
      "<p>Body</p>"
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0];
    expect(payload.to).toEqual(["dev@example.com"]);
  });

  it("prefixes subject with original recipients", async () => {
    vi.stubEnv("EMAIL_OVERRIDE_RECIPIENT", "dev@example.com");

    await sendSystemEmail(
      ["alice@example.com", "bob@example.com"],
      "Original Subject",
      "<p>Body</p>"
    );

    const payload = sendMock.mock.calls[0][0];
    expect(payload.subject).toBe(
      "[→ alice@example.com, bob@example.com] Original Subject"
    );
  });

  it("injects dev banner into body", async () => {
    vi.stubEnv("EMAIL_OVERRIDE_RECIPIENT", "dev@example.com");

    await sendSystemEmail("alice@example.com", "Subject", "<p>Body</p>");

    const payload = sendMock.mock.calls[0][0];
    expect(payload.html).toContain("DEV MODE");
    expect(payload.html).toContain("alice@example.com");
    expect(payload.html).toContain("EMAIL_OVERRIDE_RECIPIENT");
    expect(payload.html).toContain("<p>Body</p>");
  });

  it("strips cc and bcc when override active", async () => {
    vi.stubEnv("EMAIL_OVERRIDE_RECIPIENT", "dev@example.com");

    await sendSystemEmail(
      "alice@example.com",
      "Subject",
      "<p>Body</p>",
      { cc: "carol@example.com", bcc: ["dan@example.com"] }
    );

    const payload = sendMock.mock.calls[0][0];
    expect(payload.to).toEqual(["dev@example.com"]);
    expect(payload.cc).toBeUndefined();
    expect(payload.bcc).toBeUndefined();
    expect(payload.subject).toContain("alice@example.com");
    expect(payload.subject).toContain("carol@example.com");
    expect(payload.subject).toContain("dan@example.com");
  });

  it("sends to actual recipient when override is unset", async () => {
    vi.stubEnv("EMAIL_OVERRIDE_RECIPIENT", "");

    await sendSystemEmail("alice@example.com", "Subject", "<p>Body</p>");

    const payload = sendMock.mock.calls[0][0];
    expect(payload.to).toEqual(["alice@example.com"]);
    expect(payload.subject).toBe("Subject");
    expect(payload.html).toBe("<p>Body</p>");
  });

  it("treats whitespace-only override as unset", async () => {
    vi.stubEnv("EMAIL_OVERRIDE_RECIPIENT", "   ");

    await sendSystemEmail("alice@example.com", "Subject", "<p>Body</p>");

    const payload = sendMock.mock.calls[0][0];
    expect(payload.to).toEqual(["alice@example.com"]);
    expect(payload.subject).toBe("Subject");
  });
});
