import { describe, expect, it } from "vitest";
import {
  getImmediatePhotoOpenUrl,
  getImmediatePhotoPreviewUrl,
  hasR2PhotoSource,
  shouldFetchSignedPhotoUrl,
} from "./photo-url-resolution";

describe("photo URL resolution", () => {
  it("prefers signed R2 URLs over external CompanyCam URLs when r2Key is present", () => {
    const photo = {
      r2Key: "office_dallas/deals/DFW/photos/companycam_123.jpg",
      externalUrl: "https://img.companycam.com/full.jpg",
      externalThumbnailUrl: "https://img.companycam.com/thumb.jpg",
    };

    expect(hasR2PhotoSource(photo)).toBe(true);
    expect(getImmediatePhotoPreviewUrl(photo)).toBeNull();
    expect(shouldFetchSignedPhotoUrl(photo)).toBe(true);
    expect(getImmediatePhotoPreviewUrl(photo, "https://r2.example.com/signed-thumb")).toBe("https://r2.example.com/signed-thumb");
    expect(getImmediatePhotoOpenUrl(photo, "https://r2.example.com/signed-full")).toBe("https://r2.example.com/signed-full");
  });

  it("uses external URLs only for files without an R2 key", () => {
    const photo = {
      r2Key: null,
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
      externalUrl: null,
      externalThumbnailUrl: null,
    };

    expect(getImmediatePhotoPreviewUrl(photo)).toBeNull();
    expect(shouldFetchSignedPhotoUrl(photo)).toBe(true);
  });
});
