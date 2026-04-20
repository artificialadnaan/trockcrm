import { describe, expect, it } from "vitest";
import {
  SUPPORTED_ESTIMATE_DOCUMENT_MIME_TYPES,
  SUPPORTED_ESTIMATE_DOCUMENT_MIME_PREFIXES,
  isSupportedEstimateDocumentMimeType,
  normalizeEstimateDocumentPages,
} from "../../../src/modules/estimating/document-page-extractor.js";

describe("normalizeEstimateDocumentPages", () => {
  it("returns one page for an image upload and prefers the explicit source object key", async () => {
    const pages = await normalizeEstimateDocumentPages({
      filename: "sheet-a.png",
      mimeType: "image/png",
      storageKey: "files/unused.png",
      sourceObjectKey: "files/sheet-a.png",
    });

    expect(pages).toHaveLength(1);
    expect(pages[0]?.sourceKind).toBe("image");
    expect(pages[0]?.pageImageKey).toBe("files/sheet-a.png");
  });

  it("returns one deterministic placeholder page for pdf uploads", async () => {
    const pages = await normalizeEstimateDocumentPages({
      filename: "plans.pdf",
      mimeType: "application/pdf",
      storageKey: null,
      sourceObjectKey: "files/plans.pdf",
    });

    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual({
      pageNumber: 1,
      sourceKind: "pdf_page",
      pageImageKey: "files/plans.pdf",
      width: null,
      height: null,
    });
  });

  it("exports the supported mime contract and rejects unsupported mime types", async () => {
    expect(SUPPORTED_ESTIMATE_DOCUMENT_MIME_TYPES).toEqual(["application/pdf"]);
    expect(SUPPORTED_ESTIMATE_DOCUMENT_MIME_PREFIXES).toEqual(["image/"]);
    expect(isSupportedEstimateDocumentMimeType("application/pdf")).toBe(true);
    expect(isSupportedEstimateDocumentMimeType("image/png")).toBe(true);
    expect(isSupportedEstimateDocumentMimeType("text/plain")).toBe(false);

    await expect(
      normalizeEstimateDocumentPages({
        filename: "notes.txt",
        mimeType: "text/plain",
        storageKey: "files/notes.txt",
        sourceObjectKey: "files/notes.txt",
      })
    ).rejects.toThrow("Unsupported estimate document type: text/plain");
  });
});
