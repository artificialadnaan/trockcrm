/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhotoViewerModal, type DealPhotoRecord } from "./deal-photo-components";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

const photo: DealPhotoRecord = {
  id: "photo-1",
  category: "photo",
  photoCategory: "damage",
  subcategory: null,
  displayName: "Roof damage",
  mimeType: "image/jpeg",
  fileSizeBytes: 2048,
  fileExtension: ".jpg",
  r2Key: "photo.jpg",
  externalUrl: "https://example.test/photo.jpg",
  externalThumbnailUrl: "https://example.test/photo-thumb.jpg",
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
};

const pdfPhoto: DealPhotoRecord = {
  ...photo,
  id: "photo-pdf",
  displayName: "Bid package",
  mimeType: "application/pdf",
  fileExtension: ".pdf",
  r2Key: "bid-package.pdf",
  externalUrl: null,
  externalThumbnailUrl: null,
  description: null,
  tags: [],
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  apiMock.mockReset();
});

function renderViewer() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <PhotoViewerModal
      photos={[photo]}
      selectedId="photo-1"
      onSelectedIdChange={vi.fn()}
      getPhotoImageUrl={() => "https://example.test/photo.jpg"}
      ensurePhotoImageUrl={vi.fn(async () => "https://example.test/photo.jpg")}
      patchPhoto={vi.fn()}
      savePhotoAddress={vi.fn()}
      deletePhoto={vi.fn()}
      downloadPhoto={vi.fn()}
    />
  );
}

function renderPdfViewer(ensurePhotoImageUrl = vi.fn(async () => "https://example.test/file.pdf")) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <PhotoViewerModal
      photos={[pdfPhoto]}
      selectedId="photo-pdf"
      onSelectedIdChange={vi.fn()}
      getPhotoImageUrl={() => ""}
      ensurePhotoImageUrl={ensurePhotoImageUrl}
      patchPhoto={vi.fn()}
      savePhotoAddress={vi.fn()}
      deletePhoto={vi.fn()}
      downloadPhoto={vi.fn()}
    />
  );
  return ensurePhotoImageUrl;
}

describe("PhotoViewerModal history", () => {
  it("does not render non-image photo records as images", async () => {
    const ensurePhotoImageUrl = renderPdfViewer();

    await vi.waitFor(() => expect(document.body.textContent).toContain("Bid package"));
    expect(ensurePhotoImageUrl).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("No image preview available");
    expect(document.body.querySelector('img[alt="Bid package"]')).toBeNull();
  });

  it("fetches audit history on expand and renders event descriptions with details", async () => {
    apiMock.mockResolvedValueOnce({
      events: [
        {
          id: "audit-2",
          eventType: "category_changed",
          userId: "user-2",
          userName: "Adnaan Iqbal",
          userAvatarUrl: null,
          createdAt: "2026-05-04T20:00:00.000Z",
          ipAddress: "127.0.0.1",
          userAgent: "vitest",
          metadata: { oldCategory: "Damage", newCategory: "Safety" },
        },
        {
          id: "audit-3",
          eventType: "procore_sync_retry_requested",
          userId: "user-3",
          userName: "Taylor Admin",
          userAvatarUrl: null,
          createdAt: "2026-05-04T21:00:00.000Z",
          ipAddress: "127.0.0.2",
          userAgent: "vitest-retry",
          metadata: { previousStatus: "failed", jobId: 77 },
        },
        {
          id: "audit-1",
          eventType: "uploaded",
          userId: "user-1",
          userName: "Kaleb Martin",
          userAvatarUrl: null,
          createdAt: "2026-05-04T18:00:00.000Z",
          ipAddress: null,
          userAgent: null,
          metadata: {},
        },
      ],
    });

    renderViewer();
    await vi.waitFor(() => expect(document.body.textContent).toContain("History"));
    document.body.querySelector<HTMLDetailsElement>('[data-testid="photo-history"]')?.setAttribute("open", "");
    document.body.querySelector<HTMLDetailsElement>('[data-testid="photo-history"]')?.dispatchEvent(new Event("toggle", { bubbles: true }));

    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/files/photo-1/audit-log"));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Adnaan Iqbal changed category from Damage to Safety"));
    expect(document.body.textContent).toContain("Taylor Admin requested manual Procore sync retry");
    expect(document.body.textContent).toContain("Kaleb Martin uploaded this photo");

    document.body.querySelector<HTMLButtonElement>('[aria-label="Toggle details for procore sync retry requested"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("previousStatus"));
    expect(document.body.textContent).toContain("jobId");

    document.body.querySelector<HTMLButtonElement>('[aria-label="Toggle details for category changed"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("oldCategory"));
    expect(document.body.textContent).toContain("127.0.0.1");
  });
});
