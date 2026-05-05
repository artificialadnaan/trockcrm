/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicPhotoViewerPage } from "./photo-viewer-page";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
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
  it("loads a public token and renders a read-only photo grid", async () => {
    apiMock.mockResolvedValue({
      deal: {
        id: "deal-1",
        name: "Portfolio Roof",
        dealNumber: "TR-1",
        propertyAddress: "123 Main St",
      },
      photos: [{
        id: "photo-1",
        displayName: "North slope",
        mimeType: "image/jpeg",
        fileExtension: ".jpg",
        description: "North slope damage",
        photoCategory: "damage",
        subcategory: null,
        takenAt: "2026-05-01T15:00:00.000Z",
        createdAt: "2026-05-01T15:05:00.000Z",
        uploaderName: "Field User",
        latitude: null,
        longitude: null,
        address: "123 Main St",
        addressSource: "live_gps",
        imageUrl: "https://example.test/photo.jpg",
      }],
    });

    const node = renderPage();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/public/photo-viewer/raw-token"));
    await vi.waitFor(() => expect(node.textContent).toContain("Portfolio Roof"));
    expect(node.textContent).toContain("North slope");
    expect(node.textContent).not.toContain("Delete");
    expect(node.textContent).not.toContain("Edit");
  });

  it("renders the invalid-link state without redirecting to CRM auth", async () => {
    apiMock.mockRejectedValue(new Error("not found"));

    const node = renderPage();
    await vi.waitFor(() => expect(node.textContent).toContain("This link is no longer valid"));
  });
});
