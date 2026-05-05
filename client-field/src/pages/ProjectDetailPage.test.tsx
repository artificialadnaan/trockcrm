/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectDetailPage } from "./ProjectDetailPage";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({ api: apiMock }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  apiMock.mockReset();
});

function photo(id: string, category: string, uploader = "uploader-1") {
  return {
    id,
    category: "photo",
    photoCategory: category,
    subcategory: null,
    displayName: `${category} photo`,
    mimeType: "image/jpeg",
    fileSizeBytes: 1000,
    fileExtension: ".jpg",
    dealId: "deal-1",
    description: `${category} caption`,
    takenAt: "2026-05-05T12:00:00.000Z",
    createdAt: "2026-05-05T12:00:00.000Z",
    uploadedBy: uploader,
    uploaderName: uploader === "uploader-1" ? "Field User" : "Other User",
    uploaderAvatarUrl: null,
    latitude: "35.1234567",
    longitude: "-97.1234567",
    address: "123 Main",
    addressSource: "exif",
    geocodedAt: null,
    procoreSyncStatus: null,
    deletedAt: null,
    imageUrl: "https://example.com/photo.jpg",
  };
}

function renderPage() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <MemoryRouter initialEntries={["/projects/deal-1"]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
  return container;
}

describe("ProjectDetailPage", () => {
  it("renders project photos, filters by category, opens drawer, and shows read-only viewer metadata", async () => {
    apiMock
      .mockResolvedValueOnce({ projects: [
        { id: "deal-1", name: "Roof Repair", dealNumber: "TR-1", propertyName: "Roof Repair", propertyAddress: "123 Main", stage: "Contract", lastActivityAt: null, photoCount: 2, starred: false },
      ] })
      .mockResolvedValueOnce({ photos: [photo("photo-1", "damage"), photo("photo-2", "safety", "uploader-2")] });

    const node = renderPage();

    await vi.waitFor(() => expect(node.textContent).toContain("Roof Repair"));
    expect(node.textContent).toContain("damage caption");
    expect(node.textContent).toContain("safety caption");

    Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Damage")?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("damage caption"));
    expect(node.textContent).not.toContain("safety caption");

    node.querySelector<HTMLButtonElement>('[aria-label="Open filters"]')?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("Filters"));
    expect(node.textContent).toContain("Other User");

    node.querySelector<HTMLButtonElement>('[aria-label="Close filters"]')?.click();
    await vi.waitFor(() => expect(node.textContent).not.toContain("Filters"));

    Array.from(node.querySelectorAll("button")).find((button) => button.textContent?.includes("damage caption"))?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("Coordinates"));
    expect(node.textContent).toContain("From photo");
    expect(node.textContent).not.toContain("Delete");
    expect(node.textContent).not.toContain("Download");
  });

  it("cycles grouping with the grouping pill", async () => {
    apiMock
      .mockResolvedValueOnce({ projects: [
        { id: "deal-1", name: "Roof Repair", dealNumber: "TR-1", propertyName: "Roof Repair", propertyAddress: "123 Main", stage: "Contract", lastActivityAt: null, photoCount: 2, starred: false },
      ] })
      .mockResolvedValueOnce({ photos: [photo("photo-1", "damage")] });

    const node = renderPage();
    await vi.waitFor(() => expect(node.textContent).toContain("Roof Repair"));

    Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Date")?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("Damage"));
  });
});
