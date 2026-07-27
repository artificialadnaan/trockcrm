/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicPhotoViewerPage } from "./photo-viewer-page";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({ api: apiMock }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

// The locked public payload exposes only { id, imageUrl, fullImageUrl } per photo and
// { name, propertyAddress } per deal — no uploader, category, caption, timestamps, file metadata, or
// internal ids. imageUrl is the grid thumbnail; fullImageUrl is the lightbox original.
const basePhoto = {
  id: "photo-1",
  imageUrl: "https://example.test/photo.jpg?variant=thumb",
  fullImageUrl: "https://example.test/photo.jpg",
};

const baseDeal = {
  name: "Portfolio Roof",
  propertyAddress: "123 Main St",
};

// jsdom has no layout, so the viewer stays in its unwindowed fallback grid and every loaded photo is
// rendered — which is what makes these exposure assertions meaningful (nothing is hidden by windowing).
function pagedResponse(photos: unknown[], total = photos.length) {
  return { deal: baseDeal, photos, pagination: { page: 1, limit: 60, total, totalPages: 1 } };
}

afterEach(() => {
  vi.restoreAllMocks();
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  apiMock.mockReset();
});

/** Client-side navigation between two `/p/:token` routes — the only way the component is reused. */
function TokenSwitcher({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="switch-token" onClick={() => navigate(to)}>
      switch
    </button>
  );
}

/** A promise whose settlement the test controls, so two token requests can be interleaved. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderPage() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <MemoryRouter initialEntries={["/p/raw-token"]}>
      <Routes>
        <Route path="/p/:token" element={<PublicPhotoViewerPage />} />
      </Routes>
    </MemoryRouter>
  );
  return container;
}

describe("PublicPhotoViewerPage", () => {
  it("shows a loading state while the public token request is pending", async () => {
    apiMock.mockImplementation(() => new Promise(() => {}));

    const node = renderPage();

    await vi.waitFor(() => expect(node.textContent).toContain("Loading photos"));
  });

  it("renders a read-only, leak-free grid (image + property name/address only)", async () => {
    apiMock.mockResolvedValue(pagedResponse([basePhoto]));

    const node = renderPage();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/public/photo-viewer/raw-token?page=1"));
    await vi.waitFor(() => expect(node.textContent).toContain("Portfolio Roof"));
    expect(node.textContent).toContain("123 Main St");
    expect(node.querySelector('img[alt^="Shared photo"]')).not.toBeNull();
    // No edit affordances and no leaked metadata anywhere in the rendered page.
    for (const leaked of ["Delete", "Edit", "Uploaded by", "Field User", "damage", "North slope", "TR-1"]) {
      expect(node.textContent).not.toContain(leaked);
    }
  });

  it("renders the invalid, expired, or revoked link state without redirecting to CRM auth", async () => {
    apiMock.mockRejectedValue(new Error("not found"));

    const node = renderPage();
    await vi.waitFor(() => expect(node.textContent).toContain("This link is no longer valid"));
  });

  it("renders an empty shared-photo state", async () => {
    apiMock.mockResolvedValue(pagedResponse([]));

    const node = renderPage();

    await vi.waitFor(() => expect(node.textContent).toContain("No photos have been shared yet"));
  });

  it("renders every shared photo in a flat grid without date grouping", async () => {
    apiMock.mockResolvedValue(
      pagedResponse([
        basePhoto,
        { id: "photo-2", imageUrl: "https://example.test/photo-2.jpg", fullImageUrl: "https://example.test/f2.jpg" },
        { id: "photo-3", imageUrl: "https://example.test/photo-3.jpg", fullImageUrl: "https://example.test/f3.jpg" },
      ]),
    );

    const node = renderPage();
    await vi.waitFor(() => expect(node.querySelectorAll('img[alt^="Shared photo"]').length).toBe(3));
    // Timestamps are not exposed, so there are no per-day headers or counts.
    expect(node.textContent).not.toMatch(/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/);
  });

  it("does not render non-image shared records as images", async () => {
    apiMock.mockResolvedValue(pagedResponse([{ id: "photo-pdf", imageUrl: null, fullImageUrl: null }]));

    const node = renderPage();
    await vi.waitFor(() => expect(node.querySelectorAll("button").length).toBeGreaterThan(0));
    expect(node.querySelector("img")).toBeNull();
    node.querySelector("button")?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("No image preview available"));
  });

  it("opens the lightbox in read-only mode and downloads through the public endpoint", async () => {
    const openMock = vi.spyOn(window, "open").mockImplementation(() => null);
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes("/download")) return { url: "https://example.test/download.jpg" };
      return pagedResponse([basePhoto]);
    });

    const node = renderPage();
    await vi.waitFor(() => expect(node.querySelector('img[alt^="Shared photo"]')).not.toBeNull());
    node.querySelector("button")?.click();

    await vi.waitFor(() =>
      expect(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).some((button) =>
          button.textContent?.includes("Download")
        )
      ).toBe(true)
    );
    expect(document.body.textContent).not.toContain("Uploaded by");
    Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Download"))
      ?.click();

    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/public/photo-viewer/raw-token/photos/photo-1/download"));
    expect(openMock).toHaveBeenCalledWith("https://example.test/download.jpg", "_blank", "noopener,noreferrer");
  });

  // `/p/:token` is declared WITHOUT a key, so React Router reuses this component across a token change
  // and an in-flight request for the previous link can resolve after the new one has already painted.
  // Committing it would put the previous share's deal name and photos under the current link. Revert
  // the `requestTokenRef` guard in loadPage and this test fails: "Second Share" is replaced by
  // "First Share" and the first token's photo appears in the grid.
  it("drops a response from a superseded token instead of committing it under the current link", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    apiMock.mockImplementation((path: string) => {
      if (path.includes("token-a")) return first.promise;
      if (path.includes("token-b")) return second.promise;
      throw new Error(`unexpected request: ${path}`);
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={["/p/token-a"]}>
        <TokenSwitcher to="/p/token-b" />
        <Routes>
          <Route path="/p/:token" element={<PublicPhotoViewerPage />} />
        </Routes>
      </MemoryRouter>
    );
    const node = container;

    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/public/photo-viewer/token-a?page=1"));

    // Navigate to the second share while the first request is still pending.
    node.querySelector<HTMLButtonElement>('[data-testid="switch-token"]')?.click();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/public/photo-viewer/token-b?page=1"));

    second.resolve({
      deal: { name: "Second Share", propertyAddress: null },
      photos: [{ id: "photo-b", imageUrl: "https://example.test/b.jpg", fullImageUrl: "https://example.test/b-full.jpg" }],
      pagination: { page: 1, limit: 60, total: 1, totalPages: 1 },
    });
    await vi.waitFor(() => expect(node.textContent).toContain("Second Share"));

    // The loser lands late.
    first.resolve({
      deal: { name: "First Share", propertyAddress: "999 Old Rd" },
      photos: [{ id: "photo-a", imageUrl: "https://example.test/a.jpg", fullImageUrl: "https://example.test/a-full.jpg" }],
      pagination: { page: 1, limit: 60, total: 900, totalPages: 15 },
    });
    await first.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(node.textContent).toContain("Second Share");
    expect(node.textContent).not.toContain("First Share");
    expect(node.textContent).not.toContain("999 Old Rd");
    expect(node.querySelector('img[src="https://example.test/a.jpg"]')).toBeNull();
    // And the stale total must not leak into the current link's header or its paging cursor.
    expect(node.textContent).not.toContain("900 photos");
  });

  // `photos.length < total` and "the server has more pages" are not the same statement, and once they
  // disagree the gap never closes: OFFSET paging over a live deal means a photo uploaded mid-scroll
  // repeats (and is deduped away) while a deleted one is skipped outright, so the gallery ends short of
  // `total`. Revert the `endReached` guard and the client keeps asking for pages that do not exist.
  it("stops paging when the server reports its last page, even if the loaded count is short of total", async () => {
    // Two photos delivered, header total of five, and ONE page — the post-deletion shape.
    apiMock.mockResolvedValue({
      deal: baseDeal,
      photos: [basePhoto, { id: "photo-2", imageUrl: "https://example.test/2.jpg", fullImageUrl: null }],
      pagination: { page: 1, limit: 60, total: 5, totalPages: 1 },
    });

    const node = renderPage();
    await vi.waitFor(() => expect(node.querySelectorAll('img[alt^="Shared photo"]').length).toBe(2));

    // No paging affordance: there is no page 2 to fetch, so offering one would be a button that
    // silently does nothing.
    expect(node.textContent).not.toContain("Load more photos");
    expect(node.textContent).not.toContain("Loading more photos");
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  // The virtualized branch, which jsdom otherwise never reaches (no ResizeObserver, no layout). Stubbing
  // both is what makes the scroll-driven prefetch — and therefore the runaway-request loop — reachable
  // in a test at all.
  it("does not loop requesting pages past the end when windowed", async () => {
    const observed: Array<() => void> = [];
    class StubResizeObserver {
      constructor(private callback: () => void) {}
      observe() {
        observed.push(this.callback);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 1024 });

    try {
      let calls = 0;
      apiMock.mockImplementation(async () => {
        calls += 1;
        // Circuit breaker: without the fix this loop is unbounded and would hang the runner. Failing
        // the 6th request lets the buggy build terminate and still be measured.
        if (calls > 5) throw new Error("runaway paging");
        return {
          deal: baseDeal,
          photos: calls === 1 ? [basePhoto] : [],
          pagination: { page: calls, limit: 60, total: 4, totalPages: 1 },
        };
      });

      const node = renderPage();
      await vi.waitFor(() => expect(node.querySelectorAll('img[alt^="Shared photo"]').length).toBe(1));
      // The virtualized layout is the one under test — prove we are in it, not the fallback grid.
      await vi.waitFor(() => expect(node.querySelector("div.relative.w-full")).not.toBeNull());

      // Let every prefetch the effect would schedule actually run.
      for (let tick = 0; tick < 10; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(calls).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, "clientWidth", widthDescriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    }
  });
});
