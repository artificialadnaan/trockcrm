// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { RfpVotePanel } from "./rfp-vote-panel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseDeal = {
  id: "deal-1",
  rfpApprovalStatus: "pending",
  rfpVotes: [
    { voterUserId: "u-sid", voterName: "Sidney Gibson", voterEmail: "sidney@trockgc.com", decision: "approve", reason: null, votedAt: "2026-07-02T19:14:00Z" },
    { voterUserId: "u-jam", voterName: "James Helms", voterEmail: "james@trockgc.com", decision: "reject", reason: "Margins too thin for this scope", votedAt: "2026-07-02T19:20:00Z" },
  ],
  rfpVoteState: { approvals: 1, rejections: 1, outcome: "pending", decidedAt: null },
} as never;

let container: HTMLDivElement;
let root: Root | null = null;

async function render(node: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<MemoryRouter>{node}</MemoryRouter>);
  });
}

beforeEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
});

describe("RfpVotePanel", () => {
  it("renders each cast vote (choice + reason + time), the tally, and 'needs 2 of 3'", async () => {
    await render(<RfpVotePanel deal={baseDeal} user={{ id: "u-x", email: "someone@trockgc.com", isRfpVoter: false, officeId: null } as never} officeId={null} />);
    expect(container.textContent).toContain("Sidney Gibson");
    expect(container.textContent).toContain("Approved");
    expect(container.textContent).toContain("James Helms");
    expect(container.textContent).toContain("Margins too thin for this scope");
    expect(container.textContent).toContain("1 approve");
    expect(container.textContent).toContain("1 reject");
    expect(container.textContent).toContain("needs 2 of 3");
  });

  it("renders NOTHING for a non-vote deal (null rfpVoteState) so the panel stays inert", async () => {
    const nonVoteDeal = {
      id: "deal-1",
      rfpApprovalStatus: "pending",
      rfpVotes: [],
      rfpVoteState: null,
    } as never;
    await render(<RfpVotePanel deal={nonVoteDeal} user={{ id: "u-tim", email: "tim@trockgc.com", isRfpVoter: true, officeId: null } as never} officeId="office-1" />);
    expect(container.textContent).toBe("");
    expect(container.textContent).not.toContain("RFP Approval Vote");
    expect(container.querySelector('a[href*="/rfp-vote/deal-1"]')).toBeNull();
  });

  it("shows a 'Cast your vote' link only for an eligible voter who has not voted", async () => {
    // Eligible + not yet voted -> link present.
    await render(<RfpVotePanel deal={baseDeal} user={{ id: "u-tim", email: "tim@trockgc.com", isRfpVoter: true, officeId: null } as never} officeId="office-1" />);
    const link = container.querySelector('a[href*="/rfp-vote/deal-1"]');
    expect(link).not.toBeNull();
    expect((link as HTMLAnchorElement).getAttribute("href")).toContain("officeId=office-1");
  });

  it("hides 'Cast your vote' when the eligible voter has already voted", async () => {
    await render(<RfpVotePanel deal={baseDeal} user={{ id: "u-sid", email: "sidney@trockgc.com", isRfpVoter: true, officeId: null } as never} officeId={null} />);
    expect(container.querySelector('a[href*="/rfp-vote/deal-1"]')).toBeNull();
  });

  it("[finding] shows the link for a signed-in user whose isRfpVoter is now false (snapshot-authorized voter after env drift)", async () => {
    // An originally-invited voter dropped from RFP_VOTER_EMAILS: isRfpVoter=false, but the server still authorizes
    // the cast against the round snapshot, so the deal panel must NOT hide the link on the mutable flag.
    await render(<RfpVotePanel deal={baseDeal} user={{ id: "u-invited", email: "invited@trockgc.com", isRfpVoter: false, officeId: null } as never} officeId="office-1" />);
    expect(container.querySelector('a[href*="/rfp-vote/deal-1"]')).not.toBeNull();
  });

  it("after a decision shows the decided header, drops awaiting slots, and hides the cast link", async () => {
    const decidedDeal = {
      id: "deal-1",
      rfpApprovalStatus: "pending",
      rfpVotes: [
        { voterUserId: "u-sid", voterName: "Sidney Gibson", voterEmail: "sidney@trockgc.com", decision: "approve", reason: null, votedAt: "2026-07-02T19:14:00Z" },
        { voterUserId: "u-jam", voterName: "James Helms", voterEmail: "james@trockgc.com", decision: "approve", reason: null, votedAt: "2026-07-02T19:20:00Z" },
      ],
      rfpVoteState: { approvals: 2, rejections: 0, outcome: "approved", decidedAt: "2026-07-02T19:20:00Z" },
    } as never;
    // An eligible voter who hasn't voted still gets NO cast link once the round is decided.
    await render(<RfpVotePanel deal={decidedDeal} user={{ id: "u-tim", email: "tim@trockgc.com", isRfpVoter: true, officeId: null } as never} officeId={null} />);
    expect(container.textContent).toContain("Approved (2 of 3)");
    expect(container.textContent).not.toContain("needs 2 of 3");
    expect(container.textContent).not.toContain("Awaiting vote");
    expect(container.querySelector('a[href*="/rfp-vote/deal-1"]')).toBeNull();
  });

  it("[Z2] renders the REJECTED decision header + tally, and hides the cast link / awaiting slots", async () => {
    const rejectedDeal = {
      id: "deal-1",
      rfpApprovalStatus: "declined",
      rfpVotes: [
        { voterUserId: "u-sid", voterName: "Sidney Gibson", voterEmail: "sidney@trockgc.com", decision: "reject", reason: "Margins too thin", votedAt: "2026-07-02T19:14:00Z" },
        { voterUserId: "u-jam", voterName: "James Helms", voterEmail: "james@trockgc.com", decision: "reject", reason: "Scope unclear", votedAt: "2026-07-02T19:20:00Z" },
      ],
      rfpVoteState: { approvals: 0, rejections: 2, outcome: "rejected", decidedAt: "2026-07-02T19:20:00Z" },
    } as never;
    await render(<RfpVotePanel deal={rejectedDeal} user={{ id: "u-tim", email: "tim@trockgc.com", isRfpVoter: true, officeId: null } as never} officeId={null} />);
    expect(container.textContent).toContain("Rejected (2 of 3)");
    expect(container.textContent).toContain("Rejected by vote (2 of 3)");
    expect(container.textContent).not.toContain("needs 2 of 3");
    expect(container.textContent).not.toContain("Awaiting vote");
    expect(container.querySelector('a[href*="/rfp-vote/deal-1"]')).toBeNull();
  });
});
