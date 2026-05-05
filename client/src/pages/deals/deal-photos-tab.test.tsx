/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPhotoFilterSearchParams,
  groupDealPhotos,
  DealPhotosTab,
  type DealPhotoRecord,
  type PhotoFilterState,
} from "./deal-photos-tab";

vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string, options?: { method?: string; json?: Record<string, unknown> }) => {
    if (path.includes("/download")) return { url: "https://example.test/photo.jpg", filename: "photo.jpg" };
    if (options?.method === "PATCH") {
      return { file: { ...mockPhotos[0], ...options.json, addressSource: options.json?.address ? "manual_override" : mockPhotos[0].addressSource } };
    }
    if (options?.method === "DELETE") return { success: true };
    return { photos: mockPhotos, pagination: { page: 1, limit: 100, total: mockPhotos.length, totalPages: 1 } };
  }),
}));

const mockPhotos: DealPhotoRecord[] = [
  {
    id: "photo-1",
    category: "photo",
    photoCategory: "damage",
    subcategory: null,
    displayName: "Damage photo",
    mimeType: "image/jpeg",
    r2Key: "one",
    externalUrl: "https://example.test/one.jpg",
    externalThumbnailUrl: "https://example.test/one-thumb.jpg",
    description: "Original caption",
    takenAt: "2026-05-04T17:43:00.000Z",
    createdAt: "2026-05-04T18:00:00.000Z",
    uploadedBy: "user-1",
    uploaderName: "Kaleb Martin",
    uploaderAvatarUrl: null,
    latitude: "35.1234567",
    longitude: "-97.6543210",
    address: "100 Main St",
    addressSource: "exif",
    geocodedAt: "2026-05-04T18:00:00.000Z",
    procoreSyncStatus: "pending",
    deletedAt: null,
    deletedByUserId: null,
  },
  {
    id: "photo-2",
    category: "photo",
    photoCategory: null,
    subcategory: null,
    displayName: "Uncategorized photo",
    mimeType: "image/jpeg",
    r2Key: "two",
    externalUrl: "https://example.test/two.jpg",
    externalThumbnailUrl: null,
    description: null,
    takenAt: null,
    createdAt: "2026-05-03T12:00:00.000Z",
    uploadedBy: "user-2",
    uploaderName: "Adnaan Iqbal",
    uploaderAvatarUrl: null,
    latitude: null,
    longitude: null,
    address: "Project fallback address",
    addressSource: "deal_fallback",
    geocodedAt: null,
    procoreSyncStatus: null,
    deletedAt: "2026-05-05T10:00:00.000Z",
    deletedByUserId: "admin-1",
  },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
});

function renderTab() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <MemoryRouter>
      <DealPhotosTab dealId="deal-1" />
    </MemoryRouter>
  );
  return container;
}

describe("DealPhotosTab helpers", () => {
  it("serializes active filters to shareable URL params", () => {
    const params = buildPhotoFilterSearchParams({
      categories: ["damage", "uncategorized"],
      uploaderIds: ["user-1"],
      from: "2026-01-01",
      to: "2026-05-04",
      group: "category",
      showDeleted: true,
    });

    expect(params.toString()).toBe("category=damage%2Cuncategorized&uploader=user-1&from=2026-01-01&to=2026-05-04&group=category&deleted=1");
  });

  it("groups photos by date, category, uploader, or none", () => {
    const baseFilters: PhotoFilterState = { categories: [], uploaderIds: [], from: "", to: "", group: "date", showDeleted: false };

    expect(groupDealPhotos(mockPhotos, baseFilters).map((group) => group.label)).toEqual([
      "Monday, May 4th, 2026",
    ]);
    expect(groupDealPhotos(mockPhotos, { ...baseFilters, group: "category", showDeleted: true }).map((group) => group.label)).toEqual([
      "Damage",
      "Uncategorized",
    ]);
    expect(groupDealPhotos(mockPhotos, { ...baseFilters, group: "uploader", showDeleted: true }).map((group) => group.label)).toEqual([
      "Adnaan Iqbal",
      "Kaleb Martin",
    ]);
    expect(groupDealPhotos(mockPhotos, { ...baseFilters, group: "none", showDeleted: true })).toHaveLength(1);
  });
});

describe("DealPhotosTab component", () => {
  it("renders populated grid metadata and viewer controls", async () => {
    const node = renderTab();
    await vi.waitFor(() => expect(node.textContent).toContain("Kaleb Martin"));

    expect(node.textContent).toContain("Photos");
    expect(node.textContent).toContain("Kaleb Mar");
    expect(node.textContent).toContain("Damage");
    node.querySelector<HTMLButtonElement>('[aria-label="Open photo Damage photo"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Uploaded by"));
    expect(document.body.textContent).toContain("From photo");
    expect(document.body.textContent).toContain("Procore");
  });

  it("shows deleted photos only when the toggle is enabled", async () => {
    const node = renderTab();
    await vi.waitFor(() => expect(node.textContent).toContain("Kaleb Martin"));
    expect(node.textContent).not.toContain("Uncategorized photo");

    node.querySelector<HTMLButtonElement>('[aria-label="Show deleted photos"]')?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("Adnaan Iqbal"));
    expect(node.textContent).toContain("Deleted");
  });
});
