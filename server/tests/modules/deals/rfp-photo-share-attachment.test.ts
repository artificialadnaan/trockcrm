import { describe, expect, it, vi } from "vitest";
import { buildRfpAttachments } from "../../../src/modules/deals/rfp-payload.js";

/**
 * TRK-2607-H3X6. Photos are what make a deal file-heavy, and one presigned R2 URL per photo is
 * ~800 bytes — a few hundred photos alone blew SyncHub's 100kb parser limit and produced the 413.
 *
 * A deal's photos collapse to ONE public share link (`/p/<token>`) instead. That link also streams
 * through our own server rather than handing out presigned R2 URLs, so unlike the per-file
 * attachments it is not bound by the 7-day SigV4 maximum — an RFP that sits in review for longer
 * no longer decays into dead links.
 */

function photo(index: number) {
  return {
    displayName: `Site Photo ${index}`,
    fileExtension: ".jpg",
    mimeType: "image/jpeg",
    r2Key: `office_trock/deals/25-1234/photos/photo-${index}.jpg`,
    category: "photo",
  };
}

function document(index: number) {
  return {
    displayName: `Drawing ${index}`,
    fileExtension: ".pdf",
    mimeType: "application/pdf",
    r2Key: `office_trock/deals/25-1234/documents/drawing-${index}.pdf`,
    category: "estimate",
  };
}

const resolveUrl = async ({ r2Key }: { r2Key: string; filename: string }) =>
  `https://r2.example.com/${r2Key}?X-Amz-Signature=abc`;

describe("RFP attachments collapse a deal's photos into one share link", () => {
  it("replaces every photo with a single share-link attachment, keeping documents individual", async () => {
    const files = [...Array.from({ length: 250 }, (_, i) => photo(i)), document(1), document(2)];
    const mintPhotoShareUrl = vi.fn(async () => "https://crm.example.com/p/tok-123");

    const attachments = await buildRfpAttachments(files, { resolveUrl, mintPhotoShareUrl });

    expect(mintPhotoShareUrl).toHaveBeenCalledTimes(1);
    // 1 photo link + 2 documents — NOT 252 entries.
    expect(attachments).toHaveLength(3);

    const photoEntry = attachments[0];
    expect(photoEntry.url).toBe("https://crm.example.com/p/tok-123");
    expect(photoEntry.name).toContain("250");
    // Leading, so the body-size cap (which drops from the tail) can never discard it.
    expect(attachments.slice(1).every((a) => a.url.includes("r2.example.com"))).toBe(true);
  });

  it("mints no share link for a deal with no photos", async () => {
    const mintPhotoShareUrl = vi.fn(async () => "https://crm.example.com/p/tok-123");

    const attachments = await buildRfpAttachments([document(1)], { resolveUrl, mintPhotoShareUrl });

    expect(mintPhotoShareUrl).not.toHaveBeenCalled();
    expect(attachments).toHaveLength(1);
  });

  it("falls back to per-photo attachments when no share link can be minted", async () => {
    // publicViewerBaseUrl is env-driven; if it is unset we must degrade to the old behaviour
    // rather than ship a link that resolves nowhere.
    const files = [photo(1), photo(2), document(1)];
    const mintPhotoShareUrl = vi.fn(async () => null);

    const attachments = await buildRfpAttachments(files, { resolveUrl, mintPhotoShareUrl });

    expect(attachments).toHaveLength(3);
    expect(attachments.every((a) => a.url.includes("r2.example.com"))).toBe(true);
  });
});
