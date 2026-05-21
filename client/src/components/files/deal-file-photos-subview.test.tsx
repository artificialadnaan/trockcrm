/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import {
  DealFilePhotosSubview,
  sortDealPhotosForFiles,
  type PhotoFileSortKey,
} from "./deal-file-photos-subview";
import type { DealPhotoRecord } from "@/components/photos/deal-photo-components";

vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string, options?: { method?: string; json?: Record<string, unknown> }) => {
    if (path.includes("/download")) return { url: "https://example.test/photo.jpg", filename: "photo.jpg" };
    if (path.startsWith("/files/tags")) return { tags: ["roofing", "urgent", "safety"] };
    if (options?.method === "PATCH") return { file: { ...mockPhotos[0], ...options.json } };
    if (options?.method === "DELETE") return { success: true };
    return { photos: currentPhotos, pagination: { page: 1, limit: 200, total: currentPhotos.length, totalPages: 1 } };
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
    fileSizeBytes: 2048,
    fileExtension: ".jpg",
    r2Key: "one",
    externalUrl: "https://example.test/one.jpg",
    externalThumbnailUrl: "https://example.test/one-thumb.jpg",
    description: "Roof corner damage",
    tags: ["roofing", "urgent"],
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
    procoreSyncStatus: null,
    deletedAt: null,
    deletedByUserId: null,
  },
  {
    id: "photo-2",
    category: "photo",
    photoCategory: "safety",
    subcategory: null,
    displayName: "Safety setup",
    mimeType: "image/jpeg",
    fileSizeBytes: 4096,
    fileExtension: ".jpg",
    r2Key: "two",
    externalUrl: "https://example.test/two.jpg",
    externalThumbnailUrl: null,
    description: null,
    tags: ["safety"],
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
    deletedAt: null,
    deletedByUserId: null,
  },
];
let currentPhotos: DealPhotoRecord[] = mockPhotos;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  currentPhotos = mockPhotos;
  vi.clearAllMocks();
});

function renderSubview() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <MemoryRouter>
      <DealFilePhotosSubview dealId="deal-1" />
    </MemoryRouter>
  );
  return container;
}

describe("DealFilePhotosSubview", () => {
  it("sorts photos by uploaded, taken, uploader, file size, and category", () => {
    const cases: Array<[PhotoFileSortKey, string[]]> = [
      ["uploaded_at", ["photo-1", "photo-2"]],
      ["taken_at", ["photo-1", "photo-2"]],
      ["uploader", ["photo-1", "photo-2"]],
      ["file_size", ["photo-2", "photo-1"]],
      ["category", ["photo-2", "photo-1"]],
    ];

    for (const [sortKey, expectedIds] of cases) {
      expect(sortDealPhotosForFiles(mockPhotos, sortKey, "desc").map((photo) => photo.id)).toEqual(expectedIds);
    }
  });

  it("renders a dense photo file list and opens the shared viewer", async () => {
    const node = renderSubview();
    await vi.waitFor(() => expect(node.textContent).toContain("Roof corner damage"));

    expect(node.textContent).toContain("Damage");
    expect(node.textContent).toContain("Kaleb Martin");
    expect(node.textContent).toContain("100 Main St");
    expect(node.textContent).toContain("#roofing");

    node.querySelector<HTMLButtonElement>('[aria-label="Open photo Damage photo"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Uploaded by"));
    expect(document.body.textContent).toContain("From photo");
    expect(document.body.textContent).toContain("#urgent");
  });

  it("renders without crashing when a photo is missing tags", async () => {
    currentPhotos = [{ ...mockPhotos[0], tags: undefined } as unknown as DealPhotoRecord];

    const node = renderSubview();
    await vi.waitFor(() => expect(node.textContent).toContain("Roof corner damage"));

    expect(node.textContent).toContain("Damage");
    expect(node.textContent).not.toContain("#roofing");
  });

  it("filters by category from the shared filter bar", async () => {
    const node = renderSubview();
    await vi.waitFor(() => expect(node.textContent).toContain("Roof corner damage"));

    node.querySelector<HTMLButtonElement>('[aria-label="Category filter"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Safety"));
    Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Safety")?.click();

    await vi.waitFor(() => expect(node.textContent).toContain("Safety setup"));
    expect(node.textContent).not.toContain("Roof corner damage");
  });

  it("filters by tag from the shared filter bar", async () => {
    const node = renderSubview();
    await vi.waitFor(() => expect(node.textContent).toContain("Roof corner damage"));

    node.querySelector<HTMLButtonElement>('[aria-label="Tags filter"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("#safety"));
    Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "#safety")?.click();

    await vi.waitFor(() => expect(node.textContent).toContain("Safety setup"));
    expect(node.textContent).not.toContain("Roof corner damage");
  });

  it("shows the empty state", async () => {
    currentPhotos = [];
    const node = renderSubview();
    await vi.waitFor(() => expect(node.textContent).toContain("No photos uploaded to this deal yet."));

    expect(node.textContent).toContain("Upload photos");
  });

  it("uses the shared paginated loader for large deal photo sets", async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) => ({
      ...mockPhotos[0],
      id: `photo-${index + 1}`,
      displayName: `Photo ${index + 1}`,
      description: `Loaded page one photo ${index + 1}`,
      createdAt: `2026-05-04T${String(18 - Math.floor(index / 10)).padStart(2, "0")}:00:00.000Z`,
    }));
    const pageTwo = [
      {
        ...mockPhotos[0],
        id: "photo-101",
        displayName: "Late files subview photo",
        description: "Late files subview photo",
        createdAt: "2026-05-03T12:00:00.000Z",
      },
    ];
    vi.mocked(api).mockImplementation(async (path: string) => {
      const url = new URL(`https://example.test/api${path}`);
      const page = url.searchParams.get("page");
      const limit = url.searchParams.get("limit");
      if (path.includes("/download")) return { url: "https://example.test/photo.jpg", filename: "photo.jpg" };
      if (path.startsWith("/files/tags")) return { tags: ["roofing", "urgent", "safety"] };
      if (page === "2") return { photos: pageTwo, pagination: { page: 2, limit: Number(limit), total: 101, totalPages: 2 } };
      return { photos: pageOne, pagination: { page: 1, limit: Number(limit), total: 101, totalPages: 2 } };
    });

    const node = renderSubview();

    await vi.waitFor(() => expect(node.textContent).toContain("Showing 100 of 101 photos"));
    expect(vi.mocked(api)).toHaveBeenCalledWith(expect.stringContaining("limit=100"));
    expect(node.querySelectorAll<HTMLButtonElement>('[aria-label="Load more photos"]')).toHaveLength(1);
    expect(node.textContent).not.toContain("Late files subview photo");

    node.querySelector<HTMLButtonElement>('[aria-label="Load more photos"]')?.click();

    await vi.waitFor(() => expect(node.textContent).toContain("Late files subview photo"));
    expect(node.textContent).toContain("Showing 101 of 101 photos");
  });
});
