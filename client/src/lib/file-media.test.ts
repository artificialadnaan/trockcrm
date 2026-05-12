import { describe, expect, it } from "vitest";
import { getFileMediaKind } from "./file-media";

describe("getFileMediaKind", () => {
  it("uses MIME type when available", () => {
    expect(getFileMediaKind({ mimeType: "image/jpeg" })).toBe("image");
    expect(getFileMediaKind({ mimeType: "application/pdf" })).toBe("pdf");
    expect(getFileMediaKind({ mimeType: "video/mp4" })).toBe("video");
  });

  it("falls back to extension from file metadata and signed URLs", () => {
    expect(getFileMediaKind({ displayName: "site-plan.PDF" })).toBe("pdf");
    expect(getFileMediaKind({ r2Key: "office/deals/DFW/photos/photo.webp" })).toBe("image");
    expect(getFileMediaKind({ externalUrl: "https://r2.example.com/file.docx?sig=123" })).toBe("document");
  });
});
