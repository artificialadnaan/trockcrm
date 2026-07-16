import { describe, expect, it } from "vitest";
import {
  buildPropertyImageR2Key,
  buildPropertyImageUrls,
  isAcceptablePropertyImageMime,
  isHeicImageMime,
  redactPropertyImageKeys,
  resolveEffectivePropertyImageMime,
  resolvePropertyImageExtension,
} from "../../../src/modules/properties/property-image-service.js";

describe("isAcceptablePropertyImageMime", () => {
  it("accepts browser-renderable rasters + HEIC/HEIF (with parameters)", () => {
    expect(isAcceptablePropertyImageMime("image/jpeg")).toBe(true);
    expect(isAcceptablePropertyImageMime("image/png")).toBe(true);
    expect(isAcceptablePropertyImageMime("image/webp")).toBe(true);
    expect(isAcceptablePropertyImageMime("image/gif")).toBe(true);
    expect(isAcceptablePropertyImageMime("image/heic")).toBe(true);
    expect(isAcceptablePropertyImageMime("image/heif")).toBe(true);
    expect(isAcceptablePropertyImageMime("IMAGE/JPEG; charset=binary")).toBe(true);
  });

  it("rejects SVG, non-browser-renderable rasters (TIFF), and non-images", () => {
    expect(isAcceptablePropertyImageMime("image/svg+xml")).toBe(false);
    expect(isAcceptablePropertyImageMime("image/tiff")).toBe(false);
    expect(isAcceptablePropertyImageMime("image/bmp")).toBe(false);
    expect(isAcceptablePropertyImageMime("application/pdf")).toBe(false);
    expect(isAcceptablePropertyImageMime("text/html")).toBe(false);
    expect(isAcceptablePropertyImageMime(null)).toBe(false);
    expect(isAcceptablePropertyImageMime(undefined)).toBe(false);
  });
});

describe("resolveEffectivePropertyImageMime", () => {
  it("uses an accepted Content-Type as-is", () => {
    expect(resolveEffectivePropertyImageMime("image/png", "whatever.bin")).toBe("image/png");
    expect(resolveEffectivePropertyImageMime("image/jpeg; charset=binary", null)).toBe("image/jpeg");
  });

  it("falls back to the filename extension when the browser sends a generic/unknown type", () => {
    // Browsers commonly send application/octet-stream for HEIC/camera images.
    expect(resolveEffectivePropertyImageMime("application/octet-stream", "IMG_1234.HEIC")).toBe("image/heic");
    expect(resolveEffectivePropertyImageMime("application/octet-stream", "photo.jpg")).toBe("image/jpeg");
    expect(resolveEffectivePropertyImageMime("", "photo.png")).toBe("image/png");
    expect(resolveEffectivePropertyImageMime(undefined, "photo.webp")).toBe("image/webp");
  });

  it("returns null when neither the type nor the extension identifies an accepted image", () => {
    expect(resolveEffectivePropertyImageMime("application/octet-stream", "notes.txt")).toBeNull();
    expect(resolveEffectivePropertyImageMime("application/pdf", "doc.pdf")).toBeNull();
    expect(resolveEffectivePropertyImageMime("application/octet-stream", "noextension")).toBeNull();
    expect(resolveEffectivePropertyImageMime("image/svg+xml", "x.svg")).toBeNull();
    expect(resolveEffectivePropertyImageMime("image/tiff", "x.tiff")).toBeNull();
  });
});

describe("isHeicImageMime", () => {
  it("detects HEIC/HEIF (which must be transcoded before storage)", () => {
    expect(isHeicImageMime("image/heic")).toBe(true);
    expect(isHeicImageMime("image/heif")).toBe(true);
    expect(isHeicImageMime("IMAGE/HEIC; charset=binary")).toBe(true);
    expect(isHeicImageMime("image/jpeg")).toBe(false);
    expect(isHeicImageMime("image/png")).toBe(false);
    expect(isHeicImageMime(null)).toBe(false);
  });
});

describe("redactPropertyImageKeys", () => {
  it("strips the raw R2 keys while preserving every other field", () => {
    const row = {
      id: "p1",
      name: "Milo",
      imageR2Key: "properties/p1/cover-1.jpg",
      imageThumbnailR2Key: "properties/p1/cover-1_thumb.jpg",
    };
    const redacted = redactPropertyImageKeys(row);
    expect(redacted).toEqual({ id: "p1", name: "Milo" });
    expect("imageR2Key" in redacted).toBe(false);
    expect("imageThumbnailR2Key" in redacted).toBe(false);
  });
});

describe("resolvePropertyImageExtension", () => {
  it("prefers the mime type", () => {
    expect(resolvePropertyImageExtension("whatever.bin", "image/png")).toBe("png");
    expect(resolvePropertyImageExtension(null, "image/jpeg")).toBe("jpg");
    expect(resolvePropertyImageExtension(null, "image/webp")).toBe("webp");
  });

  it("falls back to a sanitized filename extension, then jpg", () => {
    expect(resolvePropertyImageExtension("photo.PNG", "application/octet-stream")).toBe("png");
    expect(resolvePropertyImageExtension("no-extension", "application/octet-stream")).toBe("jpg");
    expect(resolvePropertyImageExtension(null, null)).toBe("jpg");
    // Over-long / junk extensions are ignored in favor of the default.
    expect(resolvePropertyImageExtension("weird.superlongext", "application/octet-stream")).toBe("jpg");
  });
});

describe("buildPropertyImageR2Key", () => {
  it("namespaces the key by property id with a unique suffix and clean extension", () => {
    expect(buildPropertyImageR2Key("prop-1", "jpg", 1720000000000)).toBe("properties/prop-1/cover-1720000000000.jpg");
    // Suffix uniqueness makes each replacement a new object.
    expect(buildPropertyImageR2Key("prop-1", "jpg", 1)).not.toBe(buildPropertyImageR2Key("prop-1", "jpg", 2));
    // Extension is sanitized.
    expect(buildPropertyImageR2Key("prop-1", "PNG.", 7)).toBe("properties/prop-1/cover-7.png");
    expect(buildPropertyImageR2Key("prop-1", "", 7)).toBe("properties/prop-1/cover-7.jpg");
  });
});

describe("buildPropertyImageUrls", () => {
  const presign = async (key: string) => `signed:${key}`;

  it("presigns both keys", async () => {
    const urls = await buildPropertyImageUrls(
      { imageR2Key: "properties/p/cover-1.jpg", imageThumbnailR2Key: "properties/p/cover-1_thumb.jpg" },
      presign,
    );
    expect(urls).toEqual({
      imageUrl: "signed:properties/p/cover-1.jpg",
      imageThumbnailUrl: "signed:properties/p/cover-1_thumb.jpg",
    });
  });

  it("falls back the thumbnail URL to the full-size image when no thumbnail key exists", async () => {
    const urls = await buildPropertyImageUrls(
      { imageR2Key: "properties/p/cover-1.jpg", imageThumbnailR2Key: null },
      presign,
    );
    expect(urls.imageUrl).toBe("signed:properties/p/cover-1.jpg");
    expect(urls.imageThumbnailUrl).toBe("signed:properties/p/cover-1.jpg");
  });

  it("returns null URLs when there is no image", async () => {
    const urls = await buildPropertyImageUrls({ imageR2Key: null, imageThumbnailR2Key: null }, presign);
    expect(urls).toEqual({ imageUrl: null, imageThumbnailUrl: null });
  });

  it("returns null URLs when presign yields null (storage unconfigured)", async () => {
    const urls = await buildPropertyImageUrls(
      { imageR2Key: "properties/p/cover-1.jpg", imageThumbnailR2Key: "properties/p/cover-1_thumb.jpg" },
      async () => null,
    );
    expect(urls).toEqual({ imageUrl: null, imageThumbnailUrl: null });
  });
});
