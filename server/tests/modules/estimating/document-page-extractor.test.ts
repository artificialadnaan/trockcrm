import { describe, expect, it } from "vitest";
import { normalizeEstimateDocumentPages } from "../../../src/modules/estimating/document-page-extractor.js";

describe("normalizeEstimateDocumentPages", () => {
  it("returns one page for an image upload", async () => {
    const pages = await normalizeEstimateDocumentPages({
      filename: "sheet-a.png",
      mimeType: "image/png",
      storageKey: "files/sheet-a.png",
    });

    expect(pages).toHaveLength(1);
    expect(pages[0]?.sourceKind).toBe("image");
  });

  it("rejects unsupported mime types", async () => {
    await expect(
      normalizeEstimateDocumentPages({
        filename: "notes.txt",
        mimeType: "text/plain",
        storageKey: "files/notes.txt",
      })
    ).rejects.toThrow("Unsupported estimate document type: text/plain");
  });
});
