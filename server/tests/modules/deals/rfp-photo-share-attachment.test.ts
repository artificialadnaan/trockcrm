import { describe, expect, it, vi } from "vitest";
import { buildRfpAttachments } from "../../../src/modules/deals/rfp-payload.js";

/**
 * TRK-2607-H3X6. Photos are what make a deal file-heavy, and one presigned R2 URL per photo is
 * ~800 bytes — a few hundred photos alone blew SyncHub's 100kb parser limit and produced the 413.
 *
 * A deal's photos collapse to ONE public share link (`/p/<token>`) instead. That link also streams
 * through our own server rather than handing out presigned R2 URLs, so unlike the per-file
 * attachments it is not bound by the 7-day SigV4 maximum.
 *
 * Collapsing is only correct for photos the public viewer can ACTUALLY show, so it is bounded twice:
 *   - the viewer renders one page of at most `viewerPhotoLimit` photos (no pagination exists), and
 *   - it refuses to serve HEIC/HEIF and oversized non-JPEG rasters (never served raw).
 * Anything outside those bounds keeps its individual presigned attachment, or the reviewer would see
 * a label promising photos they cannot reach.
 */

function photo(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `photo-${index}`,
    displayName: `Site Photo ${index}`,
    fileExtension: ".jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 2_000_000,
    r2Key: `office_trock/deals/25-1234/photos/photo-${index}.jpg`,
    category: "photo",
    ...overrides,
  };
}

function document(index: number) {
  return {
    id: `doc-${index}`,
    displayName: `Drawing ${index}`,
    fileExtension: ".pdf",
    mimeType: "application/pdf",
    fileSizeBytes: 500_000,
    r2Key: `office_trock/deals/25-1234/documents/drawing-${index}.pdf`,
    category: "estimate",
  };
}

const resolveUrl = async ({ r2Key }: { r2Key: string; filename: string }) =>
  `https://r2.example.com/${r2Key}?X-Amz-Signature=abc`;

/** Mirrors the public viewer: JPEG always, other rasters only under the transcode cap, never HEIC. */
const canViewerServe = (file: { mimeType: string; fileExtension: string | null; fileSizeBytes: number }) => {
  const heic = /heic|heif/i.test(file.mimeType) || /\.hei[cf]$/i.test(file.fileExtension ?? "");
  if (heic) return false;
  if (/jpe?g/i.test(file.mimeType)) return true;
  return file.fileSizeBytes <= 25_000_000;
};

function deps(overrides: Record<string, unknown> = {}) {
  return {
    resolveUrl,
    mintPhotoShareUrl: vi.fn(async () => "https://crm.example.com/p/tok-123"),
    canViewerServe,
    viewerPhotoLimit: 500,
    ...overrides,
  };
}

describe("RFP attachments collapse a deal's photos into one share link", () => {
  it("replaces every photo with a single share-link attachment, keeping documents individual", async () => {
    const files = [...Array.from({ length: 250 }, (_, i) => photo(i)), document(1), document(2)];
    const d = deps();

    const attachments = await buildRfpAttachments(files, d as any);

    expect(d.mintPhotoShareUrl).toHaveBeenCalledTimes(1);
    expect(attachments).toHaveLength(3); // 1 photo link + 2 documents, NOT 252
    expect(attachments[0].url).toBe("https://crm.example.com/p/tok-123");
    expect(attachments[0].name).toContain("250");
    expect(attachments.slice(1).every((a) => a.url.includes("r2.example.com"))).toBe(true);
  });

  it("scopes the minted token to exactly the photos the link will show", async () => {
    const files = Array.from({ length: 3 }, (_, i) => photo(i));
    const d = deps();

    await buildRfpAttachments(files, d as any);

    expect(d.mintPhotoShareUrl).toHaveBeenCalledWith(["photo-0", "photo-1", "photo-2"]);
  });

  it("keeps photos beyond the viewer's single-page limit as individual attachments", async () => {
    // The viewer fetches page 1 only, with no pagination — photo 501 onward would be unreachable
    // through the link even though the label counted it.
    const files = Array.from({ length: 640 }, (_, i) => photo(i));
    const d = deps();

    const attachments = await buildRfpAttachments(files, d as any);

    // 1 link (covering 500) + 140 individually-attached overflow photos.
    expect(attachments).toHaveLength(141);
    expect(attachments[0].name).toContain("500");
    expect(d.mintPhotoShareUrl).toHaveBeenCalledWith(files.slice(0, 500).map((f) => f.id));
    expect(attachments.slice(1).every((a) => a.url.includes("r2.example.com"))).toBe(true);
  });

  it("keeps photos the viewer refuses to serve as individual attachments", async () => {
    // HEIC/HEIF is never served raw by the asset endpoint, and the download route 404s it. Collapsing
    // it would leave the reviewer a placeholder and no file at all.
    const files = [
      photo(1),
      photo(2, { mimeType: "image/heic", fileExtension: ".heic", id: "photo-heic" }),
      photo(3, { mimeType: "image/png", fileExtension: ".png", fileSizeBytes: 90_000_000, id: "photo-huge" }),
    ];
    const d = deps();

    const attachments = await buildRfpAttachments(files, d as any);

    expect(d.mintPhotoShareUrl).toHaveBeenCalledWith(["photo-1"]);
    expect(attachments[0].name).toContain("1");
    const individual = attachments.slice(1);
    expect(individual).toHaveLength(2);
    expect(individual.every((a) => a.url.includes("r2.example.com"))).toBe(true);
  });

  it("mints no share link when the viewer can serve none of the photos", async () => {
    const files = [photo(1, { mimeType: "image/heic", fileExtension: ".heic" })];
    const d = deps();

    const attachments = await buildRfpAttachments(files, d as any);

    expect(d.mintPhotoShareUrl).not.toHaveBeenCalled();
    expect(attachments).toHaveLength(1);
    expect(attachments[0].url).toContain("r2.example.com");
  });

  it("mints no share link for a deal with no photos", async () => {
    const d = deps();

    const attachments = await buildRfpAttachments([document(1)], d as any);

    expect(d.mintPhotoShareUrl).not.toHaveBeenCalled();
    expect(attachments).toHaveLength(1);
  });

  it("falls back to per-photo attachments when no share link can be minted", async () => {
    const files = [photo(1), photo(2), document(1)];
    const d = deps({ mintPhotoShareUrl: vi.fn(async () => null) });

    const attachments = await buildRfpAttachments(files, d as any);

    expect(attachments).toHaveLength(3);
    expect(attachments.every((a) => a.url.includes("r2.example.com"))).toBe(true);
  });
});
