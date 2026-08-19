import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Covers the two things about reset email that are security properties rather than copy:
 *
 *  1. `suppressGlobalBcc: true`. SYSTEM_EMAIL_BCC is live on the API and BCCs EVERY system email, so
 *     without this flag every reset link in the company is delivered to a third mailbox -- a standing
 *     account-takeover primitive. The service calls it MANDATORY in a comment; before this suite,
 *     deleting the flag shipped green.
 *  2. `requireConfiguredTransport: true`, so a missing transport fails loudly instead of reporting a
 *     successful "dev send" while the user waits for mail that is never coming.
 */

const emailMocks = vi.hoisted(() => ({ sendSystemEmail: vi.fn() }));

vi.mock("../../../src/lib/resend-client.js", () => ({
  sendSystemEmail: emailMocks.sendSystemEmail,
}));

const { deliverResetEmail, notifyPasswordChanged, RESET_TTL_MINUTES } = await import(
  "../../../src/modules/auth/password-reset-service.js"
);
const { buildPasswordChangedEmail, buildPasswordResetEmail } = await import(
  "../../../src/modules/auth/password-reset-emails.js"
);
const { hashResetToken } = await import("../../../src/modules/auth/reset-tokens.js");

function stubClient() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }), transaction: vi.fn() };
}

const ISSUED = {
  rawToken: "raw-token-value",
  user: { id: "user-1", email: "rep@trockgc.com", display_name: "Rep User" },
};

beforeEach(() => {
  vi.clearAllMocks();
  emailMocks.sendSystemEmail.mockResolvedValue(true);
  process.env.PASSWORD_RESET_BASE_URL = "https://trockcrm.com";
});

describe("deliverResetEmail", () => {
  it("suppresses the global BCC so the link cannot reach a monitoring mailbox", async () => {
    await deliverResetEmail(stubClient() as never, ISSUED);

    expect(emailMocks.sendSystemEmail).toHaveBeenCalledTimes(1);
    const options = emailMocks.sendSystemEmail.mock.calls[0]?.[3];
    expect(options?.suppressGlobalBcc).toBe(true);
    expect(options?.requireConfiguredTransport).toBe(true);
  });

  it("sends to the account holder and nobody else", async () => {
    await deliverResetEmail(stubClient() as never, ISSUED);
    const [to, , , options] = emailMocks.sendSystemEmail.mock.calls[0] ?? [];
    expect(to).toBe("rep@trockgc.com");
    expect(options?.cc).toBeUndefined();
    expect(options?.bcc).toBeUndefined();
  });

  it("invalidates the token when the transport reports failure", async () => {
    emailMocks.sendSystemEmail.mockResolvedValueOnce(false);
    const client = stubClient();

    await deliverResetEmail(client as never, ISSUED);

    // A live token nobody can reach still occupies the account's one-live-link slot.
    const [sql, params] = client.query.mock.calls.at(-1) ?? [];
    expect(String(sql)).toContain("invalidated_at = now()");
    expect(params).toEqual([hashResetToken(ISSUED.rawToken)]);
  });

  it("leaves the token alone when the send succeeds", async () => {
    const client = stubClient();
    await deliverResetEmail(client as never, ISSUED);
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe("notifyPasswordChanged", () => {
  it("also suppresses the global BCC", async () => {
    await notifyPasswordChanged("rep@trockgc.com", "Rep User");
    const options = emailMocks.sendSystemEmail.mock.calls[0]?.[3];
    expect(options?.suppressGlobalBcc).toBe(true);
    expect(options?.requireConfiguredTransport).toBe(true);
  });
});

describe("email bodies", () => {
  it("puts the token in the fragment, so the visible URL prefix carries no credential", () => {
    const content = buildPasswordResetEmail({
      displayName: "Rep User",
      resetUrl: "https://trockcrm.com/reset-password#token=secret-token",
      ttlMinutes: RESET_TTL_MINUTES,
    });
    expect(content.html).toContain("#token=secret-token");
    expect(content.text).toContain("#token=secret-token");
  });

  it("states the real TTL rather than a hard-coded number that can drift", () => {
    const content = buildPasswordResetEmail({
      displayName: "Rep User",
      resetUrl: "https://trockcrm.com/reset-password#token=t",
      ttlMinutes: RESET_TTL_MINUTES,
    });
    expect(content.text).toContain(`${RESET_TTL_MINUTES} minutes`);
    expect(RESET_TTL_MINUTES).toBe(60);
  });

  it("escapes a display name that contains markup", () => {
    const content = buildPasswordResetEmail({
      displayName: '<script>alert(1)</script>',
      resetUrl: "https://trockcrm.com/reset-password#token=t",
      ttlMinutes: 60,
    });
    expect(content.html).not.toContain("<script>");
    expect(content.html).toContain("&lt;script&gt;");
  });

  it("carries no token and no action link in the change notice", () => {
    const content = buildPasswordChangedEmail({ displayName: "Rep User" });
    // Nothing to phish and nothing to click: this message exists only to make an unauthorized reset
    // visible to its victim.
    expect(content.html).not.toContain("href");
    expect(content.html).not.toContain("token");
    expect(content.text).toContain("signed out everywhere");
  });
});
