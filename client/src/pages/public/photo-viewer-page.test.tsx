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

const basePhoto = {
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
};

const baseDeal = {
  id: "deal-1",
  name: "Portfolio Roof",
  dealNumber: "TR-1",
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

  it("loads a public token and renders a read-only photo grid", async () => {
    apiMock.mockResolvedValue({ deal: baseDeal, photos: [basePhoto] });

    const node = renderPage();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/public/photo-viewer/raw-token"));
    await vi.waitFor(() => expect(node.textContent).toContain("Portfolio Roof"));
    expect(node.textContent).toContain("North slope");
    expect(node.textContent).not.toContain("Delete");
    expect(node.textContent).not.toContain("Edit");
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

  it("does not render non-image shared records as images", async () => {
    apiMock.mockResolvedValue({
      deal: baseDeal,
      photos: [{
        ...basePhoto,
        id: "photo-pdf",
        displayName: "Bid package",
        mimeType: "application/pdf",
        fileExtension: ".pdf",
        imageUrl: null,
      }],
    });

    const node = renderPage();

    await vi.waitFor(() => expect(node.textContent).toContain("Bid package"));
    expect(node.querySelector('img[alt="Bid package"]')).toBeNull();
    Array.from(node.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Bid package"))?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("No image preview available"));
  });

  it("groups public photos by date", async () => {
    apiMock.mockResolvedValue({
      deal: baseDeal,
      photos: [
        basePhoto,
        { ...basePhoto, id: "photo-2", displayName: "South slope", takenAt: "2026-05-01T20:00:00.000Z" },
        { ...basePhoto, id: "photo-3", displayName: "Lobby", takenAt: "2026-05-02T15:00:00.000Z" },
      ],
    });

    const node = renderPage();

    await vi.waitFor(() => expect(node.textContent).toContain("Friday, May 1, 2026"));
    expect(node.textContent).toContain("2 photos");
    expect(node.textContent).toContain("Saturday, May 2, 2026");
  });

  it("opens the photo viewer in read-only mode and downloads through the public endpoint", async () => {
    const openMock = vi.spyOn(window, "open").mockImplementation(() => null);
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes("/download")) return { url: "https://example.test/download.jpg" };
      return { deal: baseDeal, photos: [basePhoto] };
    });

    const node = renderPage();
    await vi.waitFor(() => expect(node.textContent).toContain("North slope"));
    Array.from(node.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("North slope"))?.click();

    await vi.waitFor(() => expect(document.body.textContent).toContain("Uploaded by"));
    expect(document.body.textContent).not.toContain("Delete");
    expect(document.body.textContent).not.toContain("Edit");
    Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Download"))?.click();

    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/public/photo-viewer/raw-token/photos/photo-1/download"));
    expect(openMock).toHaveBeenCalledWith("https://example.test/download.jpg", "_blank", "noopener,noreferrer");
  });
});
