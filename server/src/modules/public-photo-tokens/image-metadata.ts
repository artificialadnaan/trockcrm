// Dependency-free metadata stripping for images served on the PUBLIC photo viewer.
// The public surface must not leak per-photo GPS. JPEG (the common GPS carrier for phone/CompanyCam
// photos) stores EXIF/XMP/GPS in APPn + comment segments — we drop those, losslessly, without
// re-encoding the image. Non-JPEG formats are passed through (PNG/WebP rarely carry GPS; HEIC is a
// known residual — see note). Keeps APP0/JFIF so the image still renders.

const STRIPPABLE_SEGMENT = (marker: number) =>
  // APP1..APP15 (Exif, XMP, ICC, etc.) and COM comment markers. APP0 (0xE0 / JFIF) is preserved.
  (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

function stripJpegMetadata(buf: Buffer): Buffer {
  const out: Buffer[] = [buf.subarray(0, 2)]; // SOI
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) {
      // Not at a marker boundary — bail safely, keep the remainder verbatim.
      out.push(buf.subarray(i));
      return Buffer.concat(out);
    }
    const marker = buf[i + 1];
    // Start of Scan / End of Image: copy the rest verbatim (compressed data follows SOS).
    if (marker === 0xda || marker === 0xd9) {
      out.push(buf.subarray(i));
      return Buffer.concat(out);
    }
    // Standalone markers without a length payload (RSTn, TEM).
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > buf.length) {
      out.push(buf.subarray(i));
      return Buffer.concat(out);
    }
    const segLen = buf.readUInt16BE(i + 2);
    const segEnd = i + 2 + segLen;
    if (segLen < 2 || segEnd > buf.length) {
      // Malformed length — don't risk corrupting; keep the remainder verbatim.
      out.push(buf.subarray(i));
      return Buffer.concat(out);
    }
    if (!STRIPPABLE_SEGMENT(marker)) {
      out.push(buf.subarray(i, segEnd));
    }
    i = segEnd;
  }
  return Buffer.concat(out);
}

export function stripImageMetadata(buffer: Buffer, mimeType?: string | null): Buffer {
  if (!Buffer.isBuffer(buffer) || !isJpeg(buffer)) return buffer;
  if (mimeType && !mimeType.toLowerCase().startsWith("image/jpeg") && !mimeType.toLowerCase().startsWith("image/jpg")) {
    // mimeType disagrees with the JPEG magic bytes; trust the bytes but only strip if it looks JPEG.
    // (Magic-byte check above already gated this; mimeType is advisory.)
  }
  return stripJpegMetadata(buffer);
}
