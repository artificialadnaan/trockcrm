import { describe, expect, it } from "vitest";
import {
  getImmediatePhotoOpenUrl,
  getImmediatePhotoPreviewUrl,
  hasR2PhotoSource,
  isPhotoImagePreviewable,
  shouldFetchSignedPhotoUrl,
} from "./photo-url-resolution";

describe("photo URL resolution", () => {
  it("prefers signed R2 URLs over external CompanyCam URLs when r2Key is present", () => {
    const photo = {
      r2Key: "office_dallas/deals/DFW/photos/companycam_123.jpg",
      mimeType: "image/jpeg",
      externalUrl: "https://img.companycam.com/full.jpg",
      externalThumbnailUrl: "https://img.companycam.com/thumb.jpg",
    };

    expect(hasR2PhotoSource(photo)).toBe(true);
    expect(isPhotoImagePreviewable(photo)).toBe(true);
    expect(getImmediatePhotoPreviewUrl(photo)).toBeNull();
    expect(shouldFetchSignedPhotoUrl(photo)).toBe(true);
    expect(getImmediatePhotoPreviewUrl(photo, "https://r2.example.com/signed-thumb")).toBe("https://r2.example.com/signed-thumb");
    expect(getImmediatePhotoOpenUrl(photo, "https://r2.example.com/signed-full")).toBe("https://r2.example.com/signed-full");
  });

  it("uses external URLs only for files without an R2 key", () => {
    const photo = {
      r2Key: null,
      mimeType: "image/jpeg",
      externalUrl: "https://example.test/full.jpg",
      externalThumbnailUrl: "https://example.test/thumb.jpg",
    };

    expect(getImmediatePhotoPreviewUrl(photo)).toBe("https://example.test/thumb.jpg");
    expect(getImmediatePhotoOpenUrl(photo)).toBe("https://example.test/full.jpg");
    expect(shouldFetchSignedPhotoUrl(photo)).toBe(false);
  });

  it("fetches a signed URL when no R2 key or external URL is immediately available", () => {
    const photo = {
      r2Key: null,
      mimeType: "image/jpeg",
      externalUrl: null,
      externalThumbnailUrl: null,
    };

    expect(getImmediatePhotoPreviewUrl(photo)).toBeNull();
    expect(shouldFetchSignedPhotoUrl(photo)).toBe(true);
  });

  it("does not treat non-image R2 files categorized as photos as image previews", () => {
    const file = {
      r2Key: "office_dallas/deals/DFW/photos/file.pdf",
      mimeType: "application/pdf",
      fileExtension: ".pdf",
      externalUrl: null,
      externalThumbnailUrl: null,
    };

    expect(hasR2PhotoSource(file)).toBe(true);
    expect(isPhotoImagePreviewable(file)).toBe(false);
    expect(getImmediatePhotoPreviewUrl(file)).toBeNull();
    expect(getImmediatePhotoOpenUrl(file)).toBeNull();
    expect(shouldFetchSignedPhotoUrl(file)).toBe(false);
  });

  it("uses storage key extensions when MIME metadata is degraded", () => {
    const file = {
      r2Key: "office_dallas/deals/DFW/photos/file.pdf",
      mimeType: null,
      fileExtension: null,
      externalUrl: null,
      externalThumbnailUrl: null,
    };

    expect(isPhotoImagePreviewable(file)).toBe(false);
    expect(shouldFetchSignedPhotoUrl(file)).toBe(false);
  });

  it("prefers storage key extensions over renamed display names when metadata is degraded", () => {
    const renamedPhoto = {
      displayName: "plan.pdf",
      r2Key: "office_dallas/deals/DFW/photos/companycam_123.jpg",
      mimeType: null,
      fileExtension: null,
      externalUrl: null,
      externalThumbnailUrl: null,
    };

    expect(isPhotoImagePreviewable(renamedPhoto)).toBe(true);
    expect(shouldFetchSignedPhotoUrl(renamedPhoto)).toBe(true);
  });

  it("does not let image-looking display names override non-image storage keys", () => {
    const renamedPdf = {
      displayName: "image.png",
      r2Key: "office_dallas/deals/DFW/photos/actual.pdf",
      mimeType: null,
      fileExtension: null,
      externalUrl: null,
      externalThumbnailUrl: null,
    };

    expect(isPhotoImagePreviewable(renamedPdf)).toBe(false);
    expect(shouldFetchSignedPhotoUrl(renamedPdf)).toBe(false);
  });

  it("uses display name as the last-resort extension source", () => {
    const displayNameOnlyPhoto = {
      displayName: "thing.jpg",
      r2Key: null,
      mimeType: null,
      fileExtension: null,
      externalUrl: null,
      externalThumbnailUrl: null,
    };

    expect(isPhotoImagePreviewable(displayNameOnlyPhoto)).toBe(true);
  });

  it("keeps extensionless degraded records previewable as a compatibility fallback", () => {
    const unknownPhoto = {
      displayName: "thing",
      r2Key: null,
      mimeType: null,
      fileExtension: null,
      externalUrl: null,
      externalThumbnailUrl: null,
    };

    expect(isPhotoImagePreviewable(unknownPhoto)).toBe(true);
  });

  it("parses image extensions from URLs with query strings", () => {
    const photo = {
      r2Key: null,
      mimeType: null,
      fileExtension: null,
      externalUrl: "https://cdn.example.test/path/photo.jpg?token=abc",
      externalThumbnailUrl: null,
    };

    expect(isPhotoImagePreviewable(photo)).toBe(true);
    expect(getImmediatePhotoPreviewUrl(photo)).toBe("https://cdn.example.test/path/photo.jpg?token=abc");
  });

  it("does not infer file extensions from URL hostnames", () => {
    const photo = {
      r2Key: null,
      mimeType: null,
      fileExtension: null,
      externalUrl: "https://img.companycam.com/signed-token",
      externalThumbnailUrl: null,
    };

    expect(isPhotoImagePreviewable(photo)).toBe(true);
    expect(getImmediatePhotoPreviewUrl(photo)).toBe("https://img.companycam.com/signed-token");
  });
});
