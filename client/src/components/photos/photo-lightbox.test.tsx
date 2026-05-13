/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhotoLightbox } from "./photo-lightbox";
import type { FeedPhoto } from "@/hooks/use-photo-feed";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

const basePhoto: FeedPhoto = {
  id: "photo-1",
  dealId: "deal-1",
  dealName: "Portfolio Roof",
  dealNumber: "DFW-1-00001",
  displayName: "Roof damage",
  mimeType: "image/jpeg",
  r2Key: "office_dallas/deals/DFW/photos/roof-damage.jpg",
  externalUrl: null,
  externalThumbnailUrl: null,
  subcategory: null,
  takenAt: "2026-05-04T17:43:00.000Z",
  createdAt: "2026-05-04T18:00:00.000Z",
  uploadedBy: "user-1",
  uploaderName: "Kaleb Martin",
  geoLat: null,
  geoLng: null,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  apiMock.mockReset();
  vi.restoreAllMocks();
});

function renderLightbox(photo: FeedPhoto, initialUrl: string | null = null) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <PhotoLightbox
      photo={photo}
      initialUrl={initialUrl}
      onClose={vi.fn()}
    />
  );
  return container;
}

describe("PhotoLightbox", () => {
  it("resolves a URL for non-image downloads without rendering it as an image preview", async () => {
    const pdfPhoto: FeedPhoto = {
      ...basePhoto,
      id: "photo-pdf",
      displayName: "Bid package",
      mimeType: "application/pdf",
      r2Key: "office_dallas/deals/DFW/photos/bid-package.pdf",
    };
    apiMock.mockResolvedValue({ url: "https://r2.test/bid-package.pdf", filename: "Bid package.pdf" });

    const node = renderLightbox(pdfPhoto);

    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/files/photo-pdf/download?preview=1"));
    await vi.waitFor(() => {
      const downloadButton = Array.from(node.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.includes("Download"));
      expect(downloadButton).toBeTruthy();
      expect(downloadButton?.disabled).toBe(false);
    });
    expect(node.textContent).toContain("No image preview available");
    expect(node.querySelector('img[alt="Bid package"]')).toBeNull();
  });

  it("renders image records and enables download from the resolved full-size URL", async () => {
    apiMock.mockResolvedValue({ url: "https://r2.test/roof-damage.jpg", filename: "Roof damage.jpg" });

    const node = renderLightbox(basePhoto);

    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/files/photo-1/download?preview=1"));
    await vi.waitFor(() => expect(node.querySelector('img[alt="Roof damage"]')).not.toBeNull());
    const downloadButton = Array.from(node.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Download"));
    expect(downloadButton?.disabled).toBe(false);
  });
});
