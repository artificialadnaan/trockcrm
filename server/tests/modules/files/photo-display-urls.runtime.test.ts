import { describe, it, expect } from "vitest";
import { resolvePhotoDisplayUrls } from "../../../src/modules/files/service.js";

/**
 * Proof that the grid gets the small thumbnail while the lightbox keeps the full original. No R2 env is
 * configured under test, so buildFileDownloadUrlFromRecord falls back to generateMockDownloadUrl, which
 * embeds the R2 key in the URL (`?key=<encoded>`) — letting us assert WHICH object each URL points at.
 */

function keyOf(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/[?&]key=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

describe("resolvePhotoDisplayUrls", () => {
  it("serves the thumbnail key to the grid and the original to the lightbox when a thumbnail exists", async () => {
    const { thumbnailUrl, fullUrl } = await resolvePhotoDisplayUrls({
      r2Key: "office_dallas/deals/D-1/photos/foo.jpg",
      thumbnailR2Key: "office_dallas/deals/D-1/photos/thumbs/foo.jpg",
      displayName: "foo",
      fileExtension: ".jpg",
    });
    expect(keyOf(fullUrl)).toBe("office_dallas/deals/D-1/photos/foo.jpg");
    expect(keyOf(thumbnailUrl)).toBe("office_dallas/deals/D-1/photos/thumbs/foo.jpg");
    expect(thumbnailUrl).not.toBe(fullUrl);
  });

  it("falls back to the original for the grid when there is no thumbnail (pre-thumbnail rows)", async () => {
    const { thumbnailUrl, fullUrl } = await resolvePhotoDisplayUrls({
      r2Key: "office_dallas/deals/D-1/photos/bar.jpg",
      thumbnailR2Key: null,
      displayName: "bar",
      fileExtension: ".jpg",
    });
    expect(keyOf(fullUrl)).toBe("office_dallas/deals/D-1/photos/bar.jpg");
    expect(thumbnailUrl).toBe(fullUrl); // unchanged legacy behavior
  });

  it("leaves external-only (no r2Key) photos using their own thumbnail/full URLs", async () => {
    const { thumbnailUrl, fullUrl } = await resolvePhotoDisplayUrls({
      r2Key: null,
      externalUrl: "https://cdn.example/orig.jpg",
      externalThumbnailUrl: "https://cdn.example/thumb.jpg",
    });
    expect(fullUrl).toBe("https://cdn.example/orig.jpg");
    expect(thumbnailUrl).toBe("https://cdn.example/thumb.jpg");
  });
});
