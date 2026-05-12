import { describe, expect, it } from "vitest";
import { requestUploadUrl, shouldLogFileDownloadEvent, shouldServeExternalFileUrl } from "./service.js";

describe("file upload service limits", () => {
  it("rejects files larger than 200 MB at presign time with 413", async () => {
    await expect(
      requestUploadUrl({} as any, "dfw", "user-1", {
        originalFilename: "drone-scan.zip",
        mimeType: "application/zip",
        fileSizeBytes: 201 * 1024 * 1024,
        category: "other",
      })
    ).rejects.toMatchObject({
      statusCode: 413,
      message: "File exceeds 200 MB limit.",
    });
  });
});

describe("file download source priority", () => {
  it("serves R2-backed imported photos from R2 even when an external URL is retained", () => {
    expect(
      shouldServeExternalFileUrl({
        r2Key: "office_dallas/deals/DFW/photos/companycam_123.jpg",
        externalUrl: "https://img.companycam.com/photo.jpg",
      })
    ).toBe(false);
  });

  it("serves external URLs only when no R2 key exists", () => {
    expect(
      shouldServeExternalFileUrl({
        r2Key: null,
        externalUrl: "https://example.test/photo.jpg",
      })
    ).toBe(true);
  });

  it("does not log preview URL generation as a photo download", () => {
    expect(shouldLogFileDownloadEvent({ preview: "1" })).toBe(false);
    expect(shouldLogFileDownloadEvent({ preview: "true" })).toBe(false);
    expect(shouldLogFileDownloadEvent({})).toBe(true);
  });
});
