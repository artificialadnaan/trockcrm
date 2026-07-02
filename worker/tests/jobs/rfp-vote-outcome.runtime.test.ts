import { describe, expect, it, vi } from "vitest";
import { handleRfpVoteOutcomeEmail } from "../../src/jobs/rfp-vote-outcome.js";

function makeQuery(rows: Record<string, unknown[]>) {
  return vi.fn(async (sql: string) => {
    if (/FROM public\.users/i.test(sql)) return { rows: rows.users ?? [] };
    if (/FROM public\.offices/i.test(sql)) return { rows: rows.offices ?? [] };
    return { rows: [] };
  });
}

describe("handleRfpVoteOutcomeEmail (GO)", () => {
  it("emails ONLY the requesting rep with the 2/3-approved copy", async () => {
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m-1" }));
    const query = makeQuery({
      users: [{ email: "rep@trockgc.com" }],
      offices: [{ id: "office-1" }],
    });

    await handleRfpVoteOutcomeEmail(
      {
        tenantSchema: "office_dallas",
        dealId: "00000000-0000-0000-0000-000000000d01",
        dealName: "Terraces Re-Roof",
        dealNumber: "DFW-1-100",
        requestedByUserId: "00000000-0000-0000-0000-000000000a09",
        outcome: "approved",
        approvals: 2,
        rejections: 0,
      },
      null,
      { query: query as never, sendEmail: sendEmail as never, env: { FRONTEND_URL: "https://trockcrm.com" } }
    );

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, html] = sendEmail.mock.calls[0];
    expect(to).toEqual(["rep@trockgc.com"]); // rep only — leadership is the NO-GO path, not this one
    expect(String(subject)).toMatch(/approved/i);
    expect(String(html)).toContain("2 of 3");
    expect(String(html)).toMatch(/creating the Bid Board/i);
  });

  it("no-ops (no throw, no send) when the requesting rep can't be resolved", async () => {
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m-2" }));
    const query = makeQuery({ users: [], offices: [{ id: "office-1" }] });
    await handleRfpVoteOutcomeEmail(
      { tenantSchema: "office_dallas", dealId: "00000000-0000-0000-0000-000000000d01", dealName: "X", dealNumber: null, requestedByUserId: null, approvals: 2, rejections: 0 },
      null,
      { query: query as never, sendEmail: sendEmail as never, env: {} }
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("NO-GO emails the requesting rep AND the Takashi/Adam reviewers with the /rfp-review link", async () => {
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m-3" }));
    const query = makeQuery({ users: [{ email: "rep@trockgc.com" }], offices: [{ id: "office-1" }] });
    await handleRfpVoteOutcomeEmail(
      { tenantSchema: "office_dallas", dealId: "00000000-0000-0000-0000-000000000d01", dealName: "Terraces Re-Roof", dealNumber: "DFW-1-100", requestedByUserId: "00000000-0000-0000-0000-000000000a09", outcome: "rejected", approvals: 1, rejections: 2 },
      null,
      { query: query as never, sendEmail: sendEmail as never, env: { FRONTEND_URL: "https://trockcrm.com", RFP_REJECTION_EMAIL_RECIPIENTS: "takashi@trockgc.com, adam@trockgc.com" } }
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, html] = sendEmail.mock.calls[0];
    expect(to).toEqual(expect.arrayContaining(["rep@trockgc.com", "takashi@trockgc.com", "adam@trockgc.com"]));
    expect(String(subject)).toMatch(/rejected|review/i);
    expect(String(html)).toContain("/rfp-review/00000000-0000-0000-0000-000000000d01");
  });
});
