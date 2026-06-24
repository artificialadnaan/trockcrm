import { describe, expect, it } from "vitest";
import { resolvePhotoDisplayUrls } from "../../../src/modules/files/service.js";

/**
 * resolvePhotoDisplayUrls is what lets a 400-photo deal load without an N+1 of /files/:id/download calls
 * (which trip the rate limiter): the server resolves a thumbnail + full-res URL per photo IN the list.
 */
describe("resolvePhotoDisplayUrls", () => {
  it("uses the external thumbnail for the grid and the external original for the viewer (CompanyCam shape)", async () => {
    const urls = await resolvePhotoDisplayUrls({
      externalUrl: "https://cdn.example/original.jpg",
      externalThumbnailUrl: "https://cdn.example/thumb.jpg",
    });
    expect(urls).toEqual({
      thumbnailUrl: "https://cdn.example/thumb.jpg",
      fullUrl: "https://cdn.example/original.jpg",
    });
  });

  it("falls back to the original for the thumbnail when no external thumbnail exists", async () => {
    const urls = await resolvePhotoDisplayUrls({
      externalUrl: "https://cdn.example/original.jpg",
      externalThumbnailUrl: null,
    });
    expect(urls).toEqual({
      thumbnailUrl: "https://cdn.example/original.jpg",
      fullUrl: "https://cdn.example/original.jpg",
    });
  });

  it("serves the SAME signed URL for both when the photo is an R2 original (no resized variant)", async () => {
    const urls = await resolvePhotoDisplayUrls({
      r2Key: "office/deal/photo.jpg",
      displayName: "photo",
      fileExtension: ".jpg",
    });
    expect(urls.thumbnailUrl).toBeTruthy();
    expect(urls.fullUrl).toBe(urls.thumbnailUrl); // R2 keeps only the original
  });

  it("prefers the durable R2 copy over external URLs when BOTH exist (CompanyCam production import)", async () => {
    const urls = await resolvePhotoDisplayUrls({
      r2Key: "office/deal/photo.jpg",
      displayName: "photo",
      fileExtension: ".jpg",
      // The external URLs are metadata that can expire — must NOT be served over the R2 original.
      externalUrl: "https://cdn.companycam.test/original.jpg",
      externalThumbnailUrl: "https://cdn.companycam.test/thumb.jpg",
    });
    expect(urls.fullUrl).not.toContain("companycam");
    expect(urls.thumbnailUrl).toBe(urls.fullUrl); // both = the R2 presigned original
  });

  it("returns null/null when there's neither an external URL nor an r2 key", async () => {
    expect(await resolvePhotoDisplayUrls({})).toEqual({ thumbnailUrl: null, fullUrl: null });
  });
});
