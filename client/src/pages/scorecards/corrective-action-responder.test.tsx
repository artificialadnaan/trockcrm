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
  discardCorrectiveActionPhoto: vi.fn(),
}));

vi.mock("@/hooks/use-corrective-actions", () => ({
  useCorrectiveActions: mocks.useCorrectiveActions,
  submitCorrectiveActionResponse: mocks.submitCorrectiveActionResponse,
  uploadCorrectiveActionPhoto: mocks.uploadCorrectiveActionPhoto,
  discardCorrectiveActionPhoto: mocks.discardCorrectiveActionPhoto,
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
  // Default the fire-and-forget discard to a resolved promise so `.catch()` in removePhoto/unmount is valid.
  mocks.discardCorrectiveActionPhoto.mockResolvedValue(undefined);
  // jsdom lacks URL.createObjectURL/revokeObjectURL, which the upload preview uses. Give each blob a unique
  // url so the revoke assertions can count distinct previews.
  let blobSeq = 0;
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => `blob:preview-${++blobSeq}`;
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CorrectiveActionResponderPage", () => {
  it("passes the ?token from the query to useCorrectiveActions and renders open items", async () => {
    mocks.useCorrectiveActions.mockReturnValue({ items: [openItem], loading: false, error: null, errorStatus: null, refetch: vi.fn() });

    await renderAt("/scorecards/sc-1/corrective-action?token=tok-xyz");

    expect(mocks.useCorrectiveActions).toHaveBeenCalledWith("sc-1", "tok-xyz");
    const text = container.textContent ?? "";
    expect(text).toContain("Re-inspect slab 2");
    expect(text).toContain("0 of 1 resolved");
    expect(text).toContain("Submit response");
  });

  it("shows the expired-link state when the token is missing", async () => {
    mocks.useCorrectiveActions.mockReturnValue({ items: [], loading: false, error: null, errorStatus: null, refetch: vi.fn() });
    await renderAt("/scorecards/sc-1/corrective-action");
    expect(container.textContent).toContain("has expired");
  });

  it("shows the expired-link state ONLY on a 401/403 error from the hook", async () => {
    mocks.useCorrectiveActions.mockReturnValue({
      items: [],
      loading: false,
      error: "This corrective-action link is invalid or has expired.",
      errorStatus: 403,
      refetch: vi.fn(),
    });
    await renderAt("/scorecards/sc-1/corrective-action?token=bad");
    expect(container.textContent).toContain("has expired");
    expect(container.textContent).toContain("invalid or has expired");
  });

  it("shows a retryable load-error state (NOT expired) on a non-401/403 failure", async () => {
    const refetch = vi.fn();
    mocks.useCorrectiveActions.mockReturnValue({
      items: [],
      loading: false,
      error: "Something went wrong.",
      errorStatus: 500,
      refetch,
    });
    await renderAt("/scorecards/sc-1/corrective-action?token=tok");
    const text = container.textContent ?? "";
    expect(text).not.toContain("has expired");
    expect(text).toContain("couldn’t load the corrective actions");
    const retry = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Try again"))!;
    expect(retry).toBeTruthy();
    await act(async () => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(refetch).toHaveBeenCalled();
  });

  it("shows a retryable load-error state when errorStatus is null (network failure)", async () => {
    mocks.useCorrectiveActions.mockReturnValue({
      items: [],
      loading: false,
      error: "Failed to fetch",
      errorStatus: null,
      refetch: vi.fn(),
    });
    await renderAt("/scorecards/sc-1/corrective-action?token=tok");
    const text = container.textContent ?? "";
    expect(text).not.toContain("has expired");
    expect(text).toContain("couldn’t load the corrective actions");
  });

  it("shows the completion state when every item is resolved", async () => {
    mocks.useCorrectiveActions.mockReturnValue({
      items: [{ ...openItem, status: "resolved", responseComment: "done", responderName: "Ext PM" }],
      loading: false,
      error: null,
      errorStatus: null,
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
    mocks.useCorrectiveActions.mockReturnValue({ items: [openItem], loading: false, error: null, errorStatus: null, refetch });
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

  it("revokes the pending preview URLs on a successful submit (item stays mounted under the same key)", async () => {
    const refetch = vi.fn();
    mocks.useCorrectiveActions.mockReturnValue({ items: [openItem], loading: false, error: null, errorStatus: null, refetch });
    mocks.uploadCorrectiveActionPhoto.mockResolvedValue("file-1");
    mocks.submitCorrectiveActionResponse.mockResolvedValue([]);

    await renderAt("/scorecards/sc-1/corrective-action?token=tok");

    // Attach a photo → allocates one preview blob URL.
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "p.jpg", { type: "image/jpeg" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.uploadCorrectiveActionPhoto).toHaveBeenCalled();

    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Done");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    const revoke = URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>;
    revoke.mockClear();

    const submitBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Submit response"),
    )!;
    await act(async () => {
      submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The blob URL allocated for the preview is revoked on success (not left pinned) — the item card did NOT
    // unmount (same React key), so this must happen explicitly in submit, not via the unmount cleanup.
    expect(revoke).toHaveBeenCalledWith("blob:preview-1");
  });

  it("caps the combined photo selection at the server limit (50) before uploading", async () => {
    mocks.useCorrectiveActions.mockReturnValue({ items: [openItem], loading: false, error: null, errorStatus: null, refetch: vi.fn() });
    mocks.uploadCorrectiveActionPhoto.mockImplementation(async () => `file-${Math.random()}`);

    await renderAt("/scorecards/sc-1/corrective-action?token=tok");

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    // Pick 51 files in one go — one over the cap.
    const files = Array.from({ length: 51 }, (_, i) => new File([new Uint8Array([i])], `p${i}.jpg`, { type: "image/jpeg" }));
    Object.defineProperty(fileInput, "files", { value: files, configurable: true });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      // Let all the sequential uploads settle.
      for (let i = 0; i < 60; i++) await Promise.resolve();
    });

    // Only 50 uploaded (the 51st truncated) and the input is now disabled at the cap.
    expect(mocks.uploadCorrectiveActionPhoto).toHaveBeenCalledTimes(50);
    expect(container.textContent).toContain("at most 50");
    const capInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(capInput.disabled).toBe(true);
  });

  it("discards the uploaded file server-side when a photo is removed before submit", async () => {
    mocks.useCorrectiveActions.mockReturnValue({ items: [openItem], loading: false, error: null, errorStatus: null, refetch: vi.fn() });
    mocks.uploadCorrectiveActionPhoto.mockResolvedValue("file-99");

    await renderAt("/scorecards/sc-1/corrective-action?token=tok-xyz");

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1])], "p.jpg", { type: "image/jpeg" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const removeBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Remove photo",
    )!;
    await act(async () => {
      removeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(mocks.discardCorrectiveActionPhoto).toHaveBeenCalledWith("sc-1", "file-99", "tok-xyz");
  });

  it("does NOT discard a photo that was already submitted in a response", async () => {
    mocks.useCorrectiveActions.mockReturnValue({ items: [openItem], loading: false, error: null, errorStatus: null, refetch: vi.fn() });
    mocks.uploadCorrectiveActionPhoto.mockResolvedValue("file-77");
    mocks.submitCorrectiveActionResponse.mockResolvedValue([]);

    await renderAt("/scorecards/sc-1/corrective-action?token=tok");

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1])], "p.jpg", { type: "image/jpeg" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Done");
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

    // The photo is now legitimate response evidence — it must NOT be discarded, even after unmount.
    await act(() => root.unmount());
    expect(mocks.discardCorrectiveActionPhoto).not.toHaveBeenCalled();
  });

  it("discards uploaded-but-un-submitted photos on unmount (page nav / abandon)", async () => {
    mocks.useCorrectiveActions.mockReturnValue({ items: [openItem], loading: false, error: null, errorStatus: null, refetch: vi.fn() });
    mocks.uploadCorrectiveActionPhoto.mockResolvedValue("file-abandoned");

    await renderAt("/scorecards/sc-1/corrective-action?token=tok-nav");

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1])], "p.jpg", { type: "image/jpeg" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Navigate away (unmount) without submitting → the orphaned upload is reclaimed.
    await act(() => root.unmount());
    expect(mocks.discardCorrectiveActionPhoto).toHaveBeenCalledWith("sc-1", "file-abandoned", "tok-nav");
  });
});
