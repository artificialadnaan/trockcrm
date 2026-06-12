/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicPhotoViewerPage } from "./photo-viewer-page";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({ api: apiMock }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

// The locked public payload exposes only { id, imageUrl } per photo and { name, propertyAddress }
// per deal — no uploader, category, caption, timestamps, file metadata, or internal ids.
const basePhoto = {
  id: "photo-1",
  imageUrl: "https://example.test/photo.jpg",
};

const baseDeal = {
  name: "Portfolio Roof",
  propertyAddress: "123 Main St",
};

afterEach(() => {
  vi.restoreAllMocks();
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  apiMock.mockReset();
});

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
    apiMock.mockResolvedValue({ deal: baseDeal, photos: [basePhoto] });

    const node = renderPage();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/public/photo-viewer/raw-token"));
    await vi.waitFor(() => expect(node.textContent).toContain("Portfolio Roof"));
    expect(node.textContent).toContain("123 Main St");
    expect(node.querySelector('img[alt="Shared photo"]')).not.toBeNull();
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
    apiMock.mockResolvedValue({ deal: baseDeal, photos: [] });

    const node = renderPage();

    await vi.waitFor(() => expect(node.textContent).toContain("No photos have been shared yet"));
  });

  it("renders every shared photo in a flat grid without date grouping", async () => {
    apiMock.mockResolvedValue({
      deal: baseDeal,
      photos: [
        basePhoto,
        { id: "photo-2", imageUrl: "https://example.test/photo-2.jpg" },
        { id: "photo-3", imageUrl: "https://example.test/photo-3.jpg" },
      ],
    });

    const node = renderPage();
    await vi.waitFor(() => expect(node.querySelectorAll('img[alt="Shared photo"]').length).toBe(3));
    // Timestamps are not exposed, so there are no per-day headers or counts.
    expect(node.textContent).not.toMatch(/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/);
  });

  it("does not render non-image shared records as images", async () => {
    apiMock.mockResolvedValue({ deal: baseDeal, photos: [{ id: "photo-pdf", imageUrl: null }] });

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
      return { deal: baseDeal, photos: [basePhoto] };
    });

    const node = renderPage();
    await vi.waitFor(() => expect(node.querySelector('img[alt="Shared photo"]')).not.toBeNull());
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
});
