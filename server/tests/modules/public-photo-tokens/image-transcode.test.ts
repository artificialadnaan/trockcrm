import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  isTranscodableToJpeg,
  transcodeToStrippedJpeg,
} from "../../../src/modules/public-photo-tokens/image-transcode.js";

describe("isTranscodableToJpeg", () => {
  it("accepts known raster mimes and strips MIME parameters + case", () => {
    expect(isTranscodableToJpeg("image/png", null)).toBe(true);
    expect(isTranscodableToJpeg("image/webp", null)).toBe(true);
    expect(isTranscodableToJpeg("image/png; charset=UTF-8", null)).toBe(true); // parameterized (CompanyCam)
    expect(isTranscodableToJpeg("IMAGE/PNG", null)).toBe(true); // case-insensitive
  });

  it("rejects HEIC/HEIF (no libheif) and JPEG (served by the faster stream path)", () => {
    expect(isTranscodableToJpeg("image/heic", ".heic")).toBe(false);
    expect(isTranscodableToJpeg("image/heif", null)).toBe(false);
    expect(isTranscodableToJpeg("image/jpeg", ".jpg")).toBe(false);
  });

  it("falls back to extension when mime is absent", () => {
    expect(isTranscodableToJpeg(null, ".png")).toBe(true);
    expect(isTranscodableToJpeg(null, "tiff")).toBe(true);
    expect(isTranscodableToJpeg(null, ".heic")).toBe(false);
    expect(isTranscodableToJpeg(null, null)).toBe(false);
  });
});

describe("transcodeToStrippedJpeg", () => {
  it("re-encodes a fully-transparent PNG to an opaque JPEG flattened onto white (no black box)", async () => {
    const transparentPng = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();

    const out = await transcodeToStrippedJpeg(transparentPng);

    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8); // JPEG SOI
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.hasAlpha).toBe(false); // JPEG carries no alpha
    // Flattened to WHITE (not sharp's default black): the decoded pixel is near-white.
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240); // R ~255
  });

  it("throws on undecodable bytes (caller maps to 422; never serves raw)", async () => {
    await expect(transcodeToStrippedJpeg(Buffer.from("not-an-image"))).rejects.toThrow();
  });
});
