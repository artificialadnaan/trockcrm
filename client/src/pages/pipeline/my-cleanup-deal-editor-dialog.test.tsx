// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { MyCleanupDealEditorDialog } from "./my-cleanup-deal-editor-dialog";

const mocks = vi.hoisted(() => ({
  useDealDetailMock: vi.fn(),
  updateDealMock: vi.fn(),
  dealFormMock: vi.fn(),
  forecastEditorMock: vi.fn(),
  nextStepEditorMock: vi.fn(),
  onSavedMock: vi.fn(),
  onOpenChangeMock: vi.fn(),
  refetchMock: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({
  useDealDetail: mocks.useDealDetailMock,
  updateDeal: mocks.updateDealMock,
}));

vi.mock("@/components/deals/deal-form", () => ({
  DealForm: (props: { deal: { id: string; name: string }; onSuccess: () => void }) => {
    mocks.dealFormMock(props);
    return <button onClick={props.onSuccess}>Save {props.deal.name}</button>;
  },
}));

vi.mock("@/components/shared/forecast-editor", () => ({
  ForecastEditor: (props: { onSave: (payload: Record<string, unknown>) => Promise<void> }) => {
    mocks.forecastEditorMock(props);
    return <button onClick={() => props.onSave({ forecastWindow: "30_days" })}>Save Forecast</button>;
  },
}));

vi.mock("@/components/shared/next-step-editor", () => ({
  NextStepEditor: (props: { onSave: (payload: Record<string, unknown>) => Promise<void> }) => {
    mocks.nextStepEditorMock(props);
    return <button onClick={() => props.onSave({ nextStep: "Call owner" })}>Save Next Step</button>;
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
    mocks.updateDealMock.mockReset();
    mocks.dealFormMock.mockReset();
    mocks.forecastEditorMock.mockReset();
    mocks.nextStepEditorMock.mockReset();
    mocks.onSavedMock.mockReset();
    mocks.onOpenChangeMock.mockReset();
    mocks.refetchMock.mockReset();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
  });

  it("renders the existing deal form when the selected deal is loaded and closes after save", async () => {
    mocks.useDealDetailMock.mockReturnValue({
      deal: { id: "deal-1", name: "Watermere Roof Replacement" },
      loading: false,
      error: null,
      refetch: mocks.refetchMock,
    });

    root = renderDialog(container, { dealId: "deal-1", open: true });

    expect(container.textContent).toContain("Edit Deal: Watermere Roof Replacement");
    expect(container.textContent).toContain("Save Forecast");
    expect(container.textContent).toContain("Save Next Step");

    const saveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Save Watermere Roof Replacement")
    );
    expect(saveButton).not.toBeNull();

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.refetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.onSavedMock).toHaveBeenCalledTimes(1);
    expect(mocks.onOpenChangeMock).toHaveBeenCalledWith(false);
  });

  it("saves cleanup-specific editors in place and refreshes the queue", async () => {
    mocks.useDealDetailMock.mockReturnValue({
      deal: { id: "deal-2", name: "Birchstone North Tower Reroof" },
      loading: false,
      error: null,
      refetch: mocks.refetchMock,
    });
    mocks.updateDealMock.mockResolvedValue({ deal: { id: "deal-2" } });

    root = renderDialog(container, { dealId: "deal-2", open: true });

    const nextStepSave = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Save Next Step")
    );
    expect(nextStepSave).not.toBeNull();

    await act(async () => {
      nextStepSave?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.updateDealMock).toHaveBeenCalledWith("deal-2", { nextStep: "Call owner" });
    expect(mocks.refetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.onSavedMock).toHaveBeenCalledTimes(1);
    expect(mocks.onOpenChangeMock).not.toHaveBeenCalled();
  });

  it("saves forecast fields in place and refreshes the queue", async () => {
    mocks.useDealDetailMock.mockReturnValue({
      deal: { id: "deal-3", name: "Boynton Beach Clubhouse" },
      loading: false,
      error: null,
      refetch: mocks.refetchMock,
    });
    mocks.updateDealMock.mockResolvedValue({ deal: { id: "deal-3" } });

    root = renderDialog(container, { dealId: "deal-3", open: true });

    const forecastSave = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Save Forecast")
    );
    expect(forecastSave).not.toBeNull();

    await act(async () => {
      forecastSave?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.updateDealMock).toHaveBeenCalledWith("deal-3", { forecastWindow: "30_days" });
    expect(mocks.refetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.onSavedMock).toHaveBeenCalledTimes(1);
    expect(mocks.onOpenChangeMock).not.toHaveBeenCalled();
  });

  it("renders loading and error states for deal fetches", () => {
    mocks.useDealDetailMock.mockReturnValue({
      deal: null,
      loading: true,
      error: null,
      refetch: mocks.refetchMock,
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
      refetch: mocks.refetchMock,
    });

    root = renderDialog(container, { dealId: "deal-2", open: true });

    expect(container.textContent).toContain("Failed to load deal");
  });
});
