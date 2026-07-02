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
});
