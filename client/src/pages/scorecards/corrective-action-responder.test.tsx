// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CorrectiveActionItem } from "@/hooks/use-corrective-actions";

const mocks = vi.hoisted(() => ({
  useCorrectiveActions: vi.fn(),
  submitCorrectiveActionResponse: vi.fn(),
  uploadCorrectiveActionPhoto: vi.fn(),
}));

vi.mock("@/hooks/use-corrective-actions", () => ({
  useCorrectiveActions: mocks.useCorrectiveActions,
  submitCorrectiveActionResponse: mocks.submitCorrectiveActionResponse,
  uploadCorrectiveActionPhoto: mocks.uploadCorrectiveActionPhoto,
}));

import CorrectiveActionResponderPage from "./corrective-action-responder";

let container: HTMLDivElement;
let root: Root;

function renderAt(url: string) {
  return act(async () => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/scorecards/:id/corrective-action" element={<CorrectiveActionResponderPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
}

const openItem: CorrectiveActionItem = {
  id: "item-1",
  itemType: "action_item",
  itemRef: "0",
  itemLabel: "Re-inspect slab 2",
  status: "open",
  responseComment: null,
  respondedByUserId: null,
  responderName: null,
  responderEmail: null,
  respondedAt: null,
  photos: [],
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  Object.values(mocks).forEach((m) => m.mockReset());
  // jsdom lacks URL.createObjectURL, which the upload preview uses.
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:preview";
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CorrectiveActionResponderPage", () => {
  it("passes the ?token from the query to useCorrectiveActions and renders open items", async () => {
    mocks.useCorrectiveActions.mockReturnValue({ items: [openItem], loading: false, error: null, refetch: vi.fn() });

    await renderAt("/scorecards/sc-1/corrective-action?token=tok-xyz");

    expect(mocks.useCorrectiveActions).toHaveBeenCalledWith("sc-1", "tok-xyz");
    const text = container.textContent ?? "";
    expect(text).toContain("Re-inspect slab 2");
    expect(text).toContain("0 of 1 resolved");
    expect(text).toContain("Submit response");
  });

  it("shows the expired-link state when the token is missing", async () => {
    mocks.useCorrectiveActions.mockReturnValue({ items: [], loading: false, error: null, refetch: vi.fn() });
    await renderAt("/scorecards/sc-1/corrective-action");
    expect(container.textContent).toContain("has expired");
  });

  it("shows the expired-link state on a 401/403 error from the hook", async () => {
    mocks.useCorrectiveActions.mockReturnValue({
      items: [],
      loading: false,
      error: "This corrective-action link is invalid or has expired.",
      refetch: vi.fn(),
    });
    await renderAt("/scorecards/sc-1/corrective-action?token=bad");
    expect(container.textContent).toContain("has expired");
    expect(container.textContent).toContain("invalid or has expired");
  });

  it("shows the completion state when every item is resolved", async () => {
    mocks.useCorrectiveActions.mockReturnValue({
      items: [{ ...openItem, status: "resolved", responseComment: "done", responderName: "Ext PM" }],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    await renderAt("/scorecards/sc-1/corrective-action?token=tok");
    const text = container.textContent ?? "";
    expect(text).toContain("All corrective actions complete");
    // A resolved item renders read-only (no submit button, shows the response).
    expect(text).not.toContain("Submit response");
    expect(text).toContain("done");
  });

  it("submits a per-item response with the token and refetches", async () => {
    const refetch = vi.fn();
    mocks.useCorrectiveActions.mockReturnValue({ items: [openItem], loading: false, error: null, refetch });
    mocks.submitCorrectiveActionResponse.mockResolvedValue([]);

    await renderAt("/scorecards/sc-1/corrective-action?token=tok-xyz");

    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Slab re-inspected");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    const submitBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Submit response"),
    )!;
    await act(async () => {
      submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.submitCorrectiveActionResponse).toHaveBeenCalledWith(
      "sc-1",
      "item-1",
      { comment: "Slab re-inspected", photoFileIds: [] },
      "tok-xyz",
    );
    expect(refetch).toHaveBeenCalled();
  });
});
