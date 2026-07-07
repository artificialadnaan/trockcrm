import { describe, expect, it } from "vitest";
import { deriveUploadDisplayName, getMimeIconType, isAllowedExtension, isAllowedMimeType, validateFileForUpload } from "./file-utils";

describe("file upload utility validation", () => {
  it("accepts downloaded email files for lead and deal file uploads", () => {
    expect(isAllowedMimeType("message/rfc822")).toBe(true);
    expect(isAllowedMimeType("application/vnd.ms-outlook")).toBe(true);
    expect(isAllowedExtension("customer-scope.eml")).toBe(true);
    expect(isAllowedExtension("outlook-message.msg")).toBe(true);

    expect(validateFileForUpload(new File(["From: test@example.com\n\nBody"], "customer-scope.eml", { type: "message/rfc822" }))).toBeNull();
    expect(validateFileForUpload(new File(["msg"], "outlook-message.msg", { type: "application/vnd.ms-outlook" }))).toBeNull();
    expect(getMimeIconType("message/rfc822")).toBe("email");
    expect(getMimeIconType("application/vnd.ms-outlook")).toBe("email");
  });
});

// deriveUploadDisplayName mirrors the SERVER seed sentinel (deriveSeedDisplayName) and drives the upload
// zone's "Will be saved as:" preview. Documents AND real web/desktop photos keep their ext-stripped real
// name (exactly what the server persists); only a SYNTHETIC photo name (field-photo-<ts>/companycam_)
// falls back to the approximate deal-number scheme.
describe("deriveUploadDisplayName (upload preview mirror)", () => {
  it("a document keeps its ext-stripped real filename", () => {
    expect(deriveUploadDisplayName("Foundation Warranty.pdf", "other", "TR-2026-0142")).toBe("Foundation Warranty");
  });

  it("a real web/desktop photo keeps its ext-stripped real filename (NOT the deal scheme)", () => {
    const name = deriveUploadDisplayName("Kitchen Damage.jpg", "photo", "TR-2026-0142");
    expect(name).toBe("Kitchen Damage");
    expect(name).not.toContain("TR-2026-0142");
  });

  it("a synthetic field-photo name falls back to the approximate deal-number scheme", () => {
    const name = deriveUploadDisplayName("field-photo-1699999999.jpg", "photo", "TR-2026-0142");
    expect(name).not.toBe("field-photo-1699999999");
    expect(name).toContain("TR-2026-0142");
  });

  it("a companycam_ synthetic name also falls back to the deal-number scheme", () => {
    const name = deriveUploadDisplayName("companycam_abc123.jpg", "photo", "TR-2026-0142");
    expect(name).toContain("TR-2026-0142");
  });
});
