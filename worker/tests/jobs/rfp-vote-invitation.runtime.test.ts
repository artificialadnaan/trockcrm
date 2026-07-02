import { describe, expect, it, vi } from "vitest";
import { handleRfpVoteInvitation, buildRfpVoteInvitationEmail } from "../../src/jobs/rfp-vote-invitation.js";

const ENV = {
  RFP_VOTER_EMAILS: "sidney@x.com,tim@x.com,james@x.com",
  NODE_ENV: "test",
  APP_BASE_URL: "https://trockcrm.com",
} as any;

describe("handleRfpVoteInvitation", () => {
  it("emails the three configured voters with a /rfp-vote/:dealId link", async () => {
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));
    await handleRfpVoteInvitation(
      { dealId: "deal-1", dealNumber: "TR-1001", dealName: "jasonn ranches", officeId: "office-9" },
      "office-9",
      { sendEmail, env: ENV, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [recipients, subject, html] = sendEmail.mock.calls[0];
    expect(recipients).toEqual(["sidney@x.com", "tim@x.com", "james@x.com"]);
    expect(subject).toContain("TR-1001");
    expect(html).toContain("/rfp-vote/deal-1");
    expect(html).toContain("officeId=office-9");
  });

  it("throws (fails loudly) when RFP_VOTER_EMAILS is unset in prod", async () => {
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));
    await expect(
      handleRfpVoteInvitation(
        { dealId: "deal-1" },
        "office-9",
        { sendEmail, env: { NODE_ENV: "production" } as any, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } },
      ),
    ).rejects.toThrow(/RFP_VOTER_EMAILS/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("buildRfpVoteInvitationEmail links with the office param and the caption '2 of 3'", () => {
    const email = buildRfpVoteInvitationEmail({ dealId: "deal-1", dealName: "d", dealNumber: null, officeId: "office-9", frontendUrl: "https://trockcrm.com/" });
    expect(email.html).toContain("https://trockcrm.com/rfp-vote/deal-1?officeId=office-9");
    expect(email.text).toContain("Two of three");
  });
});
