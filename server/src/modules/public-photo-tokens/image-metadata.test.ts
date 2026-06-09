import { describe, expect, it } from "vitest";
import { stripImageMetadata } from "./image-metadata.js";

// Build a tiny synthetic JPEG: SOI, APP1(Exif+fake GPS), APP0(JFIF), COM(secret), SOS+scan, EOI.
function seg(marker: number, payload: Buffer): Buffer {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2, 0);
  return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
}
function syntheticJpeg(): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app1 = seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from("GPSLatitude=32.7767", "latin1")]));
  const app0 = seg(0xe0, Buffer.from("JFIF\0\0\0\0\0\0", "latin1"));
  const com = seg(0xfe, Buffer.from("secret-comment", "latin1"));
  const sos = Buffer.concat([Buffer.from([0xff, 0xda]), Buffer.from([0x00, 0x03, 0x01]), Buffer.from([0x12, 0x34, 0x56])]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app1, app0, com, sos, eoi]);
}

describe("stripImageMetadata", () => {
  it("removes EXIF/XMP (APP1) and comment segments from a JPEG, keeping image data", () => {
    const input = syntheticJpeg();
    const out = stripImageMetadata(input, "image/jpeg");

    expect(out.toString("latin1")).not.toContain("Exif");
    expect(out.toString("latin1")).not.toContain("GPSLatitude");
    expect(out.toString("latin1")).not.toContain("secret-comment");
    // Image structure preserved: SOI start, JFIF kept, scan data + EOI at the end.
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
    expect(out.toString("latin1")).toContain("JFIF");
    expect(out.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    // Scan bytes survive.
    expect(out.includes(Buffer.from([0x12, 0x34, 0x56]))).toBe(true);
  });

  it("passes non-JPEG buffers through unchanged", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const out = stripImageMetadata(png, "image/png");
    expect(out).toEqual(png);
  });

  it("returns a JPEG with no metadata unchanged in structure (idempotent-ish, no crash on minimal input)", () => {
    const minimal = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const out = stripImageMetadata(minimal, "image/jpeg");
    expect(out).toEqual(minimal);
  });
});
