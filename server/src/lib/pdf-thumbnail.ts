import { spawn } from "node:child_process";
import { getObjectBuffer, putObject, isR2Configured } from "./r2-client.js";
import { deriveThumbnailKey, generateThumbnailBuffer } from "./image-thumbnail.js";

/**
 * PDF first-page thumbnails. Mirrors image-thumbnail.ts semantics: BEST-EFFORT and time-bounded — any
 * miss (pdftoppm missing, decode failure, R2 hiccup, not configured) returns null and the upload still
 * succeeds; the Files tab falls back to a type badge. `sharp` cannot decode PDFs, so we rasterize page 1
 * to PNG with `pdftoppm` (poppler-utils, installed in the runtime image) and hand that PNG to the shared
 * sharp resize used for image thumbnails, so the stored object is an identical small JPEG.
 *
 * SECURITY: this is the codebase's first request-path spawn of an external binary on attacker-controllable
 * input (any authenticated rep can upload a PDF; mobile confirmUpload routes here too). Two hardened edges:
 *  1) The output is capped with `-scale-to` so a tiny PDF declaring a huge MediaBox (e.g. 14400x14400pt)
 *     cannot rasterize to a multi-GB bitmap and OOM the container. MAX_SOURCE_BYTES only bounds INPUT.
 *  2) A hung pdftoppm is SIGKILLed on timeout, so a PDF crafted to make it hang cannot leak a live child
 *     process per upload.
 *
 * INVOCATION NOTE: we read the PDF from stdin (no PDF-file argument) and write the PNG to stdout
 * (`-singlefile`, no output prefix). This works on the poppler builds we ship (alpine runtime) and test
 * (macOS + ubuntu CI) — proven by the raster test RUNNING on both (Task 11 hard gate). If a future target
 * poppler build requires an explicit `-` for stdin, add it to the args here; do NOT add it speculatively,
 * as some builds treat a bare `-` as a literal filename.
 */

// Don't pull originals larger than this into memory just to thumbnail them. A miss is non-fatal.
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
// Cap the raster's LONGER edge (pixels), independent of the PDF's declared MediaBox — the OOM guard.
// ~1000px is enough for a crisp list preview and stays tiny after the sharp JPEG resize.
const PDF_RASTER_SCALE_TO = 1000;
// Hard kill for a hung pdftoppm child. Distinct from (and shorter than) the outer thumbnail timeout so the
// child dies with certainty rather than merely being abandoned by an outer race.
const PDF_RASTER_TIMEOUT_MS = 4000;
// Outer ceiling covering R2 fetch + raster + sharp resize + put. confirmUpload awaits this on the request
// path, so a slow render never stalls an upload — past this we give up and the row gets a type badge.
const PDF_THUMBNAIL_TIMEOUT_MS = 5000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    work.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** True only for PDFs (strips Content-Type params). Images go through image-thumbnail.ts; SVG/docs are badge-only. */
export function isPdfThumbnailable(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  return mimeType.split(";")[0].trim().toLowerCase() === "application/pdf";
}

/** One-shot probe: is `pdftoppm` on PATH? Used by the startup probe and tests to decide the real path. */
export function hasPdftoppm(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn("pdftoppm", ["-v"]);
      child.on("error", () => resolve(false));
      // pdftoppm -v exits non-zero on some builds but still proves presence; any spawn-without-error is enough.
      child.on("close", () => resolve(true));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Startup probe. The PDF path is best-effort (a miss silently becomes a type badge), which would mask a
 * broken package/musl binary end-to-end. Log LOUDLY once at boot so a missing binary is visible in prod
 * logs. Never throws — logging only.
 */
export async function warnIfPdftoppmMissing(): Promise<void> {
  try {
    if (await hasPdftoppm()) {
      console.log("[pdf-thumbnail] pdftoppm available — PDF first-page thumbnails enabled.");
    } else {
      console.warn(
        "[pdf-thumbnail] pdftoppm NOT found on PATH — every PDF will silently fall back to a type badge. " +
        "Install poppler-utils in the runtime image (Dockerfile).",
      );
    }
  } catch {
    /* probe is advisory only */
  }
}

/**
 * Rasterize page 1 of a PDF buffer to a PNG buffer via pdftoppm, reading the PDF from stdin and writing
 * the PNG to stdout (no temp files). `-singlefile` + no output prefix → single image on stdout. `-scale-to`
 * caps the output's longer edge in pixels regardless of the declared MediaBox (OOM guard). A hung child is
 * SIGKILLed at `timeoutMs`. Rejects on spawn error, non-zero exit, empty output, or timeout.
 */
export function rasterizePdfFirstPage(
  pdf: Buffer,
  opts: { scaleTo?: number; timeoutMs?: number } = {},
): Promise<Buffer> {
  const scaleTo = opts.scaleTo ?? PDF_RASTER_SCALE_TO;
  const timeoutMs = opts.timeoutMs ?? PDF_RASTER_TIMEOUT_MS;
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("pdftoppm", ["-png", "-singlefile", "-f", "1", "-l", "1", "-scale-to", String(scaleTo)]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // Kill a hung pdftoppm so a crafted PDF can't leak a live child process per upload.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(() => reject(new Error(`pdftoppm timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => settle(() => reject(e)));
    child.on("close", (code) => {
      const png = Buffer.concat(out);
      if (code === 0 && png.byteLength > 0) settle(() => resolve(png));
      else settle(() => reject(new Error(`pdftoppm exited ${code}: ${Buffer.concat(err).toString().slice(0, 200)}`)));
    });
    child.stdin.on("error", () => { /* EPIPE if pdftoppm bailed early — surfaced by the close/timeout handler */ });
    child.stdin.end(pdf);
  });
}

/**
 * Generate a first-page thumbnail for an already-stored PDF and persist it to R2, returning its key (or
 * null on any miss — never throws). Reuses deriveThumbnailKey (deterministic → backfillable) and the
 * shared sharp JPEG resize, so the stored object matches image thumbnails exactly.
 */
export async function generateAndStorePdfThumbnail(
  r2Key: string,
  mimeType: string | null | undefined,
  sourceBuffer?: Buffer,
): Promise<string | null> {
  if (!isPdfThumbnailable(mimeType)) return null;
  if (!isR2Configured()) return null;
  try {
    return await withTimeout(
      (async () => {
        let source = sourceBuffer;
        if (!source) {
          const got = await getObjectBuffer(r2Key, { maxBytes: MAX_SOURCE_BYTES });
          source = got.buffer;
        } else if (source.byteLength > MAX_SOURCE_BYTES) {
          throw new Error(`source buffer ${source.byteLength} exceeds ${MAX_SOURCE_BYTES} bytes`);
        }
        const png = await rasterizePdfFirstPage(source);
        const thumb = await generateThumbnailBuffer(png);
        const thumbnailKey = deriveThumbnailKey(r2Key);
        await putObject(thumbnailKey, thumb, "image/jpeg");
        return thumbnailKey;
      })(),
      PDF_THUMBNAIL_TIMEOUT_MS,
    );
  } catch (err) {
    console.error(`[pdf-thumbnail] skipped for ${r2Key}:`, err);
    return null;
  }
}
