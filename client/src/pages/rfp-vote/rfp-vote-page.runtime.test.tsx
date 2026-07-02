// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiMock: vi.fn(), useAuthMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: mocks.apiMock }));
vi.mock("@/lib/auth", () => ({ useAuth: mocks.useAuthMock }));

import { RfpVotePage } from "./rfp-vote-page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const detail = {
  deal: {
    id: "deal-1",
    name: "Terraces Re-Roof",
    projectNumber: "DFW-1-100",
    rfpApprovalStatus: "pending",
    rfpVotes: [],
    rfpVoteState: { approvals: 0, rejections: 0, outcome: "pending", decidedAt: null },
  },
};

let container: HTMLDivElement;
let root: Root | null = null;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={["/rfp-vote/deal-1"]}>
        <Routes>
          <Route path="/rfp-vote/:dealId" element={<RfpVotePage />} />
        </Routes>
      </MemoryRouter>
    );
  });
  // let the detail fetch settle
  await act(async () => { await Promise.resolve(); });
}

function click(el: Element | null) { return act(async () => { (el as HTMLElement).click(); }); }

beforeEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  mocks.apiMock.mockReset();
  mocks.useAuthMock.mockReturnValue({ user: { id: "u-tim", email: "tim@trockgc.com", isRfpVoter: true, officeId: null } });
});

describe("RfpVotePage", () => {
  it("reveals a required reason field when Reject is chosen and POSTs decision+reason", async () => {
    mocks.apiMock.mockResolvedValueOnce(detail); // GET /deals/deal-1/detail
    await render();

    // Choose Reject -> reason textarea appears.
    const rejectRadio = container.querySelector('input[value="reject"]');
    expect(rejectRadio).not.toBeNull();
    await click(rejectRadio);
    const reason = container.querySelector("textarea");
    expect(reason).not.toBeNull();

    // Submitting with an empty reason is blocked (button disabled), then enabled once a reason is typed.
    const submit = Array.from(container.querySelectorAll("button")).find((b) => /submit vote/i.test(b.textContent ?? ""))!;
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      const ta = reason as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(ta, "Margins too thin");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    mocks.apiMock.mockResolvedValueOnce({ outcome: "pending", votes: [] }); // POST /deals/deal-1/rfp-vote
    await click(submit);

    const postCall = mocks.apiMock.mock.calls.find((c) => String(c[0]).includes("/rfp-vote"));
    expect(postCall).toBeTruthy();
    expect(postCall![1]).toMatchObject({ method: "POST", json: { decision: "reject", reason: "Margins too thin" } });
  });

  it("shows a 'not open for voting' card (no crash) when the loaded deal's rfpVoteState is null", async () => {
    mocks.apiMock.mockResolvedValueOnce({
      deal: { id: "deal-1", name: "Service RFP", projectNumber: "DFW-4-200", rfpApprovalStatus: "pending", rfpVotes: [], rfpVoteState: null },
    });
    await render();
    expect(container.textContent).toMatch(/not open for voting/i);
    // The vote form must NOT render off a null state.
    expect(container.querySelector('input[value="approve"]')).toBeNull();
    expect(Array.from(container.querySelectorAll("button")).some((b) => /submit vote/i.test(b.textContent ?? ""))).toBe(false);
    // Only the "Open the full deal" escape hatch remains.
    expect(container.querySelector('a[href*="/deals/deal-1"]')).not.toBeNull();
  });

  it("blocks a non-voter with an access-restricted message", async () => {
    mocks.useAuthMock.mockReturnValue({ user: { id: "u-x", email: "x@trockgc.com", isRfpVoter: false, officeId: null } });
    await render();
    expect(container.textContent).toMatch(/only the designated rfp voters/i);
    expect(mocks.apiMock).not.toHaveBeenCalled();
  });
});
