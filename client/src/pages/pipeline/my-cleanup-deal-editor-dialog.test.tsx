// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { MyCleanupDealEditorDialog } from "./my-cleanup-deal-editor-dialog";

const mocks = vi.hoisted(() => ({
  useDealDetailMock: vi.fn(),
  dealFormMock: vi.fn(),
  onSavedMock: vi.fn(),
  onOpenChangeMock: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({
  useDealDetail: mocks.useDealDetailMock,
}));

vi.mock("@/components/deals/deal-form", () => ({
  DealForm: (props: { deal: { id: string; name: string }; onSuccess: () => void }) => {
    mocks.dealFormMock(props);
    return <button onClick={props.onSuccess}>Save {props.deal.name}</button>;
  },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function renderDialog(container: HTMLElement, props: { dealId: string | null; open: boolean }) {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MyCleanupDealEditorDialog
        dealId={props.dealId}
        open={props.open}
        onOpenChange={mocks.onOpenChangeMock}
        onSaved={mocks.onSavedMock}
      />
    );
  });
  return root;
}

describe("MyCleanupDealEditorDialog", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.innerHTML = "";
    document.body.appendChild(container);
    root = null;
    mocks.useDealDetailMock.mockReset();
    mocks.dealFormMock.mockReset();
    mocks.onSavedMock.mockReset();
    mocks.onOpenChangeMock.mockReset();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
  });

  it("renders the existing deal form when the selected deal is loaded and closes on save", () => {
    mocks.useDealDetailMock.mockReturnValue({
      deal: { id: "deal-1", name: "Watermere Roof Replacement" },
      loading: false,
      error: null,
    });

    root = renderDialog(container, { dealId: "deal-1", open: true });

    expect(container.textContent).toContain("Edit Deal: Watermere Roof Replacement");

    const saveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Save Watermere Roof Replacement")
    );
    expect(saveButton).not.toBeNull();

    act(() => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.onOpenChangeMock).toHaveBeenCalledWith(false);
    expect(mocks.onSavedMock).toHaveBeenCalledTimes(1);
  });

  it("renders loading and error states for deal fetches", () => {
    mocks.useDealDetailMock.mockReturnValue({
      deal: null,
      loading: true,
      error: null,
    });

    root = renderDialog(container, { dealId: "deal-1", open: true });

    expect(container.textContent).toContain("Loading deal...");

    act(() => {
      root?.unmount();
    });

    mocks.useDealDetailMock.mockReturnValue({
      deal: null,
      loading: false,
      error: "Failed to load deal",
    });

    root = renderDialog(container, { dealId: "deal-2", open: true });

    expect(container.textContent).toContain("Failed to load deal");
  });
});
