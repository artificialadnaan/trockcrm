import { describe, expect, it } from "vitest";
import { requestUploadUrl } from "./service.js";

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
