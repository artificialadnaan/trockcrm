// Dependency-free JPEG metadata stripping for the PUBLIC photo viewer. The public surface only ever
// serves JPEG (the one format we can provably strip); non-JPEG R2 originals (HEIC/PNG/WebP/GIF) are
// not served publicly, so embedded GPS/EXIF can't leak. JPEG EXIF/XMP/GPS lives in APPn + COM
// segments at the front of the file; we drop those losslessly by walking the segment table (never
// byte-scanning, which would false-match a 0xffda inside an EXIF thumbnail).

const STRIPPABLE_SEGMENT = (marker: number) =>
  // APP1..APP15 (Exif, XMP, ICC, …) and COM. APP0 (0xe0 / JFIF) is preserved so the image renders.
  (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

export function isStrippableJpeg(mimeType?: string | null, fileExtension?: string | null): boolean {
  const mime = mimeType?.trim().toLowerCase();
  if (mime) return mime === "image/jpeg" || mime === "image/jpg";
  const ext = fileExtension?.trim().toLowerCase().replace(/^\.?/, "");
  return ext === "jpg" || ext === "jpeg";
}

type Marker = { markerStart: number; marker: number; bodyEnd: number; standalone: boolean; terminal: boolean };

// Reads the marker beginning at offset i (which must point at a 0xff). Tolerates legal 0xff fill
// bytes before the marker code. Returns "incomplete" when more bytes are needed to know the segment.
function readMarker(buf: Buffer, i: number): Marker | "incomplete" | "invalid" {
  if (buf[i] !== 0xff) return "invalid";
  let k = i;
  while (k < buf.length && buf[k] === 0xff) k++; // skip fill bytes
  if (k >= buf.length) return "incomplete";
  const marker = buf[k];
  const markerStart = k - 1; // the single 0xff paired with the marker code
  if (marker === 0x00) return "invalid"; // 0xff00 is byte-stuffing, not a header marker
  if (marker === 0xda || marker === 0xd9) {
    return { markerStart, marker, bodyEnd: k + 1, standalone: true, terminal: true }; // SOS / EOI
  }
  if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
    return { markerStart, marker, bodyEnd: k + 1, standalone: true, terminal: false }; // RSTn / TEM
  }
  if (k + 3 > buf.length) return "incomplete";
  const segLen = buf.readUInt16BE(k + 1);
  if (segLen < 2) return "invalid";
  const segEnd = k + 1 + segLen;
  if (segEnd > buf.length) return "incomplete";
  return { markerStart, marker, bodyEnd: segEnd, standalone: false, terminal: false };
}

/**
 * Walks JPEG segments and returns the offset of the Start-Of-Scan marker (the boundary where header
 * metadata ends and entropy-coded image data begins). "incomplete" => buffer doesn't yet contain the
 * full header (read more); "invalid" => not a parseable JPEG. Used to bound how much a streaming
 * proxy must buffer before it can emit a stripped header and stream the body.
 */
export function findJpegHeaderEnd(buf: Buffer): { sos: number } | "incomplete" | "invalid" {
  if (buf.length < 2) return "incomplete";
  if (!isJpeg(buf)) return "invalid";
  let i = 2;
  while (i < buf.length) {
    const m = readMarker(buf, i);
    if (m === "incomplete") return "incomplete";
    if (m === "invalid") return "invalid";
    if (m.terminal) return { sos: m.markerStart }; // SOS (or a degenerate pre-SOS EOI)
    i = m.bodyEnd;
  }
  return "incomplete";
}

/**
 * Strips EXIF/XMP/comment segments from a JPEG buffer (a full JPEG, or just the header region up to
 * SOS). Returns non-JPEG buffers unchanged.
 */
export function stripJpegMetadata(buffer: Buffer): Buffer {
  if (!Buffer.isBuffer(buffer) || !isJpeg(buffer)) return buffer;
  const out: Buffer[] = [buffer.subarray(0, 2)]; // SOI
  let i = 2;
  while (i < buffer.length) {
    const m = readMarker(buffer, i);
    if (m === "incomplete" || m === "invalid") {
      out.push(buffer.subarray(i)); // keep the remainder verbatim rather than risk corrupting it
      break;
    }
    if (m.terminal) {
      out.push(buffer.subarray(m.markerStart)); // SOS/EOI onward is image data — copy verbatim
      break;
    }
    if (m.standalone) {
      out.push(buffer.subarray(m.markerStart, m.bodyEnd));
      i = m.bodyEnd;
      continue;
    }
    if (!STRIPPABLE_SEGMENT(m.marker)) out.push(buffer.subarray(m.markerStart, m.bodyEnd));
    i = m.bodyEnd;
  }
  return Buffer.concat(out);
}
