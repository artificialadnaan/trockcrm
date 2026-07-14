import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";

const heicDecoder = vi.hoisted(() => ({
  output: null as Buffer | null,
  calls: 0,
  active: 0,
  maxActive: 0,
  releases: [] as Array<() => void>,
}));

vi.mock("heic-convert", () => ({
  default: vi.fn(async () => {
    heicDecoder.calls += 1;
    heicDecoder.active += 1;
    heicDecoder.maxActive = Math.max(heicDecoder.maxActive, heicDecoder.active);
    await new Promise<void>((resolve) => heicDecoder.releases.push(resolve));
    heicDecoder.active -= 1;
    if (!heicDecoder.output) throw new Error("HEIC decoder test output was not initialized");
    return heicDecoder.output;
  }),
}));

import {
  deriveThumbnailKey,
  generateEvidenceJpeg,
  isThumbnailableImage,
  generateThumbnailBuffer,
  readHeifDimensions,
  withHeicDecodePermit,
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

describe("readHeifDimensions", () => {
  function heifWithDimensions(width: number, height: number): Buffer {
    const box = Buffer.alloc(20);
    box.writeUInt32BE(20, 0);
    box.write("ispe", 4, "ascii");
    box.writeUInt32BE(width, 12);
    box.writeUInt32BE(height, 16);
    return box;
  }

  it("reads ordinary HEIF spatial dimensions before the compatibility decoder allocates a raster", () => {
    expect(readHeifDimensions(heifWithDimensions(4032, 3024))).toEqual({ width: 4032, height: 3024 });
  });

  it("rejects malformed or over-limit HEIF dimensions", () => {
    expect(readHeifDimensions(Buffer.from("not-a-heif"))).toBeNull();
    expect(readHeifDimensions(heifWithDimensions(10_000, 10_000))).toBeNull();
    expect(readHeifDimensions(Buffer.concat([
      heifWithDimensions(10_000, 10_000),
      heifWithDimensions(320, 240),
    ]))).toBeNull();
    expect(readHeifDimensions(Buffer.concat([
      heifWithDimensions(320, 240),
      heifWithDimensions(10_000, 10_000),
    ]))).toBeNull();
  });
});

describe("HEIC evidence decode concurrency", () => {
  function heifWithDimensions(width: number, height: number): Buffer {
    const box = Buffer.alloc(20);
    box.writeUInt32BE(20, 0);
    box.write("ispe", 4, "ascii");
    box.writeUInt32BE(width, 12);
    box.writeUInt32BE(height, 16);
    return box;
  }

  it("allows only one process-wide HEIC raster decode at a time", async () => {
    heicDecoder.output = await sharp({
      create: { width: 16, height: 12, channels: 3, background: { r: 40, g: 80, b: 120 } },
    }).jpeg().toBuffer();
    heicDecoder.calls = 0;
    heicDecoder.active = 0;
    heicDecoder.maxActive = 0;
    heicDecoder.releases = [];

    const source = heifWithDimensions(4032, 3024);
    const conversions = Array.from({ length: 3 }, () => generateEvidenceJpeg(source, "image/heic"));

    await vi.waitFor(() => expect(heicDecoder.calls).toBe(1));
    expect(heicDecoder.active).toBe(1);
    heicDecoder.releases.shift()?.();

    await vi.waitFor(() => expect(heicDecoder.calls).toBe(2));
    expect(heicDecoder.active).toBe(1);
    heicDecoder.releases.shift()?.();

    await vi.waitFor(() => expect(heicDecoder.calls).toBe(3));
    expect(heicDecoder.active).toBe(1);
    heicDecoder.releases.shift()?.();

    const outputs = await Promise.all(conversions);
    expect(heicDecoder.maxActive).toBe(1);
    for (const output of outputs) {
      expect((await sharp(output).metadata()).format).toBe("jpeg");
    }
  });

  it("releases the process-wide permit when gated work rejects", async () => {
    await expect(
      withHeicDecodePermit(async () => {
        throw new Error("decoder failed");
      }),
    ).rejects.toThrow("decoder failed");

    await expect(withHeicDecodePermit(async () => "next decode ran")).resolves.toBe("next decode ran");
  });
});
