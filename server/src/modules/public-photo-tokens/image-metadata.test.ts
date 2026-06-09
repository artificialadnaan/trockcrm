import { describe, expect, it } from "vitest";
import { findJpegHeaderEnd, isStrippableJpeg, stripJpegMetadata } from "./image-metadata.js";

function seg(marker: number, payload: Buffer): Buffer {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2, 0);
  return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
}
const SOI = Buffer.from([0xff, 0xd8]);
const SOS_AND_SCAN = Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01, 0x12, 0x34, 0x56]);
const EOI = Buffer.from([0xff, 0xd9]);

describe("stripJpegMetadata", () => {
  it("removes EXIF/XMP (APP1) and comment segments, keeping image data", () => {
    const input = Buffer.concat([
      SOI,
      seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from("GPSLatitude=32.7767", "latin1")])),
      seg(0xe0, Buffer.from("JFIF\0\0\0\0\0\0", "latin1")),
      seg(0xfe, Buffer.from("secret-comment", "latin1")),
      SOS_AND_SCAN,
      EOI,
    ]);
    const out = stripJpegMetadata(input);
    expect(out.toString("latin1")).not.toContain("Exif");
    expect(out.toString("latin1")).not.toContain("GPSLatitude");
    expect(out.toString("latin1")).not.toContain("secret-comment");
    expect(out.toString("latin1")).toContain("JFIF");
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
    expect(out.subarray(-2)).toEqual(EOI);
    expect(out.includes(Buffer.from([0x12, 0x34, 0x56]))).toBe(true);
  });

  it("strips EXIF even when legal 0xff fill bytes precede the APP marker", () => {
    const input = Buffer.concat([
      SOI,
      Buffer.from([0xff, 0xff, 0xff]), // fill bytes before the next marker
      seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from("GPSLongitude=-96.79", "latin1")])),
      SOS_AND_SCAN,
      EOI,
    ]);
    const out = stripJpegMetadata(input);
    expect(out.toString("latin1")).not.toContain("Exif");
    expect(out.toString("latin1")).not.toContain("GPSLongitude");
    expect(out.includes(Buffer.from([0x12, 0x34, 0x56]))).toBe(true);
  });

  it("does not treat a 0xffda byte INSIDE an APP1 EXIF thumbnail as the SOS marker", () => {
    // APP1 payload contains a fake embedded-JPEG SOS (0xff 0xda) — must be skipped by length, not scanned.
    const app1Payload = Buffer.concat([Buffer.from("Exif\0\0GPS", "latin1"), Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from("thumb", "latin1")]);
    const input = Buffer.concat([SOI, seg(0xe1, app1Payload), seg(0xe0, Buffer.from("JFIF\0", "latin1")), SOS_AND_SCAN, EOI]);
    const out = stripJpegMetadata(input);
    expect(out.toString("latin1")).not.toContain("Exif");
    expect(out.toString("latin1")).not.toContain("thumb");
    expect(out.toString("latin1")).toContain("JFIF");
  });

  it("passes non-JPEG buffers through unchanged", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    expect(stripJpegMetadata(png)).toEqual(png);
  });
});

describe("findJpegHeaderEnd", () => {
  it("returns the SOS offset, walking past APP segments (incl. thumbnail 0xffda)", () => {
    const app1 = seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from("x", "latin1")]));
    const header = Buffer.concat([SOI, app1]);
    const full = Buffer.concat([header, SOS_AND_SCAN, EOI]);
    const r = findJpegHeaderEnd(full);
    expect(r).toEqual({ sos: header.length });
  });

  it("reports incomplete when a segment is split across the buffer boundary", () => {
    const app1 = seg(0xe1, Buffer.from("Exif\0\0partial", "latin1"));
    const truncated = Buffer.concat([SOI, app1.subarray(0, app1.length - 4)]); // cut mid-segment
    expect(findJpegHeaderEnd(truncated)).toBe("incomplete");
  });

  it("reports invalid for non-JPEG input", () => {
    expect(findJpegHeaderEnd(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe("invalid");
  });
});

describe("isStrippableJpeg", () => {
  it("accepts JPEG by mime or extension, rejects everything else", () => {
    expect(isStrippableJpeg("image/jpeg", null)).toBe(true);
    expect(isStrippableJpeg(null, ".jpg")).toBe(true);
    expect(isStrippableJpeg(null, ".JPEG")).toBe(true);
    expect(isStrippableJpeg("image/heic", ".heic")).toBe(false);
    expect(isStrippableJpeg("image/png", ".png")).toBe(false);
    expect(isStrippableJpeg(null, null)).toBe(false);
  });
});
