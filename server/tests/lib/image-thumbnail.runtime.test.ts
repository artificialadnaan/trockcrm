import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  deriveThumbnailKey,
  isThumbnailableImage,
  generateThumbnailBuffer,
} from "../../src/lib/image-thumbnail.js";

/**
 * Unit proof for the server-side photo thumbnail helper. No R2/network: deriveThumbnailKey and
 * isThumbnailableImage are pure, and generateThumbnailBuffer runs sharp on an in-memory image.
 */

describe("deriveThumbnailKey", () => {
  it("puts the thumbnail in a sibling thumbs/ folder and forces .jpg", () => {
    expect(deriveThumbnailKey("office_dallas/deals/D-1/photos/foo.heic")).toBe(
      "office_dallas/deals/D-1/photos/thumbs/foo.jpg",
    );
    // Original keeps its extension out of the stem; jpeg wins regardless of source format.
    expect(deriveThumbnailKey("office_dallas/deals/D-1/photos/IMG_2026.PNG")).toBe(
      "office_dallas/deals/D-1/photos/thumbs/IMG_2026.jpg",
    );
  });

  it("handles a key with no directory and no extension", () => {
    expect(deriveThumbnailKey("loosefile")).toBe("thumbs/loosefile.jpg");
  });

  it("is deterministic (a backfill can recompute the same key)", () => {
    const k = "office_x/deals/D/photos/a.b.c.jpg"; // multiple dots -> only the last is the extension
    expect(deriveThumbnailKey(k)).toBe("office_x/deals/D/photos/thumbs/a.b.c.jpg");
    expect(deriveThumbnailKey(k)).toBe(deriveThumbnailKey(k));
  });
});

describe("isThumbnailableImage", () => {
  it("accepts raster image mimes, rejects docs/svg/empty", () => {
    for (const m of ["image/jpeg", "image/png", "image/webp", "image/heic", "IMAGE/JPG"]) {
      expect(isThumbnailableImage(m)).toBe(true);
    }
    for (const m of ["application/pdf", "image/svg+xml", "text/plain", "", null, undefined]) {
      expect(isThumbnailableImage(m)).toBe(false);
    }
  });

  it("ignores Content-Type parameters (e.g. charset) before matching", () => {
    expect(isThumbnailableImage("image/jpeg; charset=utf-8")).toBe(true);
    expect(isThumbnailableImage(" image/png ;foo=bar")).toBe(true);
    expect(isThumbnailableImage("application/pdf; charset=binary")).toBe(false);
  });
});

describe("generateThumbnailBuffer", () => {
  it("downscales the longest edge to <=600 and emits JPEG, preserving aspect ratio", async () => {
    const source = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: { r: 120, g: 80, b: 40 } },
    })
      .png()
      .toBuffer();

    const thumb = await generateThumbnailBuffer(source);
    const meta = await sharp(thumb).metadata();

    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(600); // longest edge clamped
    expect(meta.height).toBe(450); // 4:3 ratio preserved
    expect(thumb.byteLength).toBeLessThan(source.byteLength); // smaller payload for the grid
  });

  it("does NOT enlarge an image already smaller than the cap", async () => {
    const small = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();

    const meta = await sharp(await generateThumbnailBuffer(small)).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(150);
  });
});
