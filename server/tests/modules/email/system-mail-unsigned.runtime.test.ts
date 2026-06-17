import { describe, expect, it, vi } from "vitest";

// Scope guard: signatures apply ONLY to user-composed mail (email.service.sendEmail). System/Resend
// mail (invites, notifications, RFP) goes through sendSystemEmail, which never touches the signature
// path — so a system email's html must reach Resend verbatim, with no signature wrapper.
const sendMock = vi.fn().mockResolvedValue({ data: { id: "sys-1" } });
vi.stubEnv("RESEND_API_KEY", "test-resend-key");
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}));

const { sendSystemEmail } = await import("../../../src/lib/resend-client.js");

describe("system (Resend) mail is never signed", () => {
  it("sends the html verbatim — no trock-email-signature appended", async () => {
    await sendSystemEmail("rep@example.com", "You're invited", "<p>Invite body</p>");
    const arg = sendMock.mock.calls.at(-1)?.[0];
    expect(arg.html).toBe("<p>Invite body</p>");
    expect(arg.html).not.toContain("trock-email-signature");
  });
});
