/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DealProposalCard, resolveProposalDraftingEnabled } from "./deal-proposal-card";

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: mocks.apiMock,
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccessMock,
    error: mocks.toastErrorMock,
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const deal = {
  id: "deal-1",
  proposalStatus: "not_started",
  proposalDraftStartedAt: null,
  proposalSentAt: null,
  proposalAcceptedAt: null,
  proposalRevisionCount: 0,
} as any;

describe("DealProposalCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.apiMock.mockReset();
    mocks.toastSuccessMock.mockReset();
    mocks.toastErrorMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps Start Drafting inert with the feature flag off", async () => {
    await act(async () => {
      root.render(
        <DealProposalCard
          deal={deal}
          onUpdate={vi.fn()}
          proposalDraftingEnabled={false}
        />
      );
    });

    const button = Array.from(container.querySelectorAll("button")).find(
      (node) => node.textContent === "Start Drafting"
    );
    expect(button?.getAttribute("title")).toBe("Coming soon");

    await act(async () => {
      button?.click();
    });

    expect(mocks.apiMock).not.toHaveBeenCalled();
  });

  it("starts a proposal draft and opens proposal mode when the flag is on", async () => {
    const onUpdate = vi.fn();
    const onOpenProposalEditor = vi.fn();
    mocks.apiMock.mockResolvedValue({ deal: { ...deal, proposalStatus: "drafting" } });

    await act(async () => {
      root.render(
        <DealProposalCard
          deal={deal}
          onUpdate={onUpdate}
          onOpenProposalEditor={onOpenProposalEditor}
          proposalDraftingEnabled
        />
      );
    });

    const button = Array.from(container.querySelectorAll("button")).find(
      (node) => node.textContent === "Start Drafting"
    );

    await act(async () => {
      button?.click();
    });

    expect(mocks.apiMock).toHaveBeenCalledWith("/deals/deal-1/proposal-draft", {
      method: "POST",
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onOpenProposalEditor).toHaveBeenCalledTimes(1);
  });

  it("defaults the proposal drafting flag to false", () => {
    expect(resolveProposalDraftingEnabled({})).toBe(false);
    expect(resolveProposalDraftingEnabled({ PROPOSAL_DRAFTING_ENABLED: "true" })).toBe(true);
  });
});
