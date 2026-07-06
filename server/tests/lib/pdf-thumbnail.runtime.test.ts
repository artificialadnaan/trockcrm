import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  isPdfThumbnailable,
  hasPdftoppm,
  rasterizePdfFirstPage,
  generateAndStorePdfThumbnail,
} from "../../src/lib/pdf-thumbnail.js";
import { generateThumbnailBuffer } from "../../src/lib/image-thumbnail.js";

/**
 * Proof for the PDF thumbnail pipeline. The pure guards and the null best-effort paths run everywhere;
 * the real raster→JPEG composition + the security caps run only where `pdftoppm` is installed
 * (poppler-utils), matching the runtime image and (now) the pre-merge CI job. When it's absent the raster
 * tests are VISIBLY SKIPPED via it.skipIf (never a bare `return`, which would report a false PASS). R2 is
 * not configured under test, so generateAndStorePdfThumbnail returns null (best-effort).
 */

// Detect pdftoppm SYNCHRONOUSLY at collection time so it.skipIf can gate the raster tests (an async
// beforeAll probe resolves too late for skipIf). The runtime image + CI gate install poppler-utils.
function pdftoppmAvailable(): boolean {
  try {
    return !spawnSync("pdftoppm", ["-v"]).error;
  } catch {
    return false;
  }
}
const HAS_PDFTOPPM = pdftoppmAvailable();

// A syntactically valid single-page PDF built in-memory (no external fixture, no dependency). poppler
// repairs minor issues, but we compute the content-stream Length + the xref offsets correctly to keep it
// clean so a STRICT poppler build accepts it (see FIXTURE_RENDERS below — if a build rejects it, that is a
// fixture-artifact problem, distinguishable from a product break). The MediaBox is a parameter so we can
// prove the output-pixel cap holds even when the PDF declares a huge page.
function makeMinimalPdf(mediaBox = "0 0 120 120"): Buffer {
  const content = "BT /F1 24 Tf 20 50 Td (PDF) Tj ET\n";
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    `<</Type/Page/Parent 2 0 R/MediaBox[${mediaBox}]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>`,
    `<</Length ${Buffer.byteLength(content, "latin1")}>>\nstream\n${content}endstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

// FIXTURE SELF-CHECK: synchronously confirm THIS poppler build renders makeMinimalPdf() (via the CLI, no
// scale flag). If poppler is present but rejects the hand-assembled PDF, the raster assertions below would
// red the gate on a FIXTURE-ARTIFACT problem, not a product defect — so we surface that distinctly and
// skip the fixture-dependent assertions with a loud reason instead of a confusing hard failure. When
// poppler is absent this is simply false (raster tests skip as before).
function fixtureRenders(): boolean {
  if (!HAS_PDFTOPPM) return false;
  const r = spawnSync("pdftoppm", ["-png", "-singlefile", "-f", "1", "-l", "1"], { input: makeMinimalPdf() });
  const ok = r.status === 0 && r.stdout != null && r.stdout.length > 0;
  if (!ok) {
    // eslint-disable-next-line no-console
    console.warn(
      "[pdf-thumbnail.test] poppler is installed but rejected the in-memory fixture — treating as a " +
      "FIXTURE-ARTIFACT issue (adjust makeMinimalPdf or ship a committed .pdf), NOT a product break. " +
      `pdftoppm status=${r.status} stderr=${r.stderr?.toString().slice(0, 200)}`,
    );
  }
  return ok;
}
const FIXTURE_RENDERS = fixtureRenders();

describe("isPdfThumbnailable", () => {
  it("accepts application/pdf (with params), rejects images/docs/svg/empty", () => {
    expect(isPdfThumbnailable("application/pdf")).toBe(true);
    expect(isPdfThumbnailable("application/pdf; charset=binary")).toBe(true);
    expect(isPdfThumbnailable(" APPLICATION/PDF ")).toBe(true);
    for (const m of ["image/png", "image/svg+xml", "text/plain", "application/zip", "", null, undefined]) {
      expect(isPdfThumbnailable(m)).toBe(false);
    }
  });
});

describe("hasPdftoppm", () => {
  it("resolves a boolean without throwing", async () => {
    expect(typeof (await hasPdftoppm())).toBe("boolean");
  });
});

describe("rasterizePdfFirstPage → generateThumbnailBuffer", () => {
  it.skipIf(!FIXTURE_RENDERS)("rasterizes page 1 to PNG, then sharp converts it to a small JPEG", async () => {
    const png = await rasterizePdfFirstPage(makeMinimalPdf(), { scaleTo: 400 });
    const pngMeta = await sharp(png).metadata();
    expect(pngMeta.format).toBe("png");
    expect(pngMeta.width ?? 0).toBeGreaterThan(0);
    // -scale-to 400 caps the LONGER edge at 400px.
    expect(pngMeta.width ?? 9999).toBeLessThanOrEqual(400);
    expect(pngMeta.height ?? 9999).toBeLessThanOrEqual(400);

    const jpeg = await generateThumbnailBuffer(png);
    const jpegMeta = await sharp(jpeg).metadata();
    expect(jpegMeta.format).toBe("jpeg");
    expect(jpegMeta.width ?? 0).toBeLessThanOrEqual(600);
  });

  it.skipIf(!FIXTURE_RENDERS)("caps output pixels via -scale-to even when the PDF declares a huge MediaBox", async () => {
    // 14400x14400pt at a DPI would be ~30000px (≈2.7GB bitmap) → OOM. -scale-to must bound it regardless.
    const png = await rasterizePdfFirstPage(makeMinimalPdf("0 0 14400 14400"), { scaleTo: 500 });
    const meta = await sharp(png).metadata();
    expect(meta.width ?? 9999).toBeLessThanOrEqual(520);
    expect(meta.height ?? 9999).toBeLessThanOrEqual(520);
  });

  it.skipIf(!HAS_PDFTOPPM)("rejects on non-PDF input (non-zero exit) rather than hanging", async () => {
    await expect(rasterizePdfFirstPage(Buffer.from("not a pdf"))).rejects.toThrow();
  });
});

describe("generateAndStorePdfThumbnail (best-effort)", () => {
  it("returns null for a non-PDF mime without touching pdftoppm", async () => {
    expect(await generateAndStorePdfThumbnail("office_x/deals/D/docs/a.png", "image/png")).toBeNull();
  });

  it("returns null when R2 is not configured (no crash on the upload path)", async () => {
    // R2 env is absent under test → isR2Configured() is false → best-effort miss, never throws.
    expect(await generateAndStorePdfThumbnail("office_x/deals/D/docs/a.pdf", "application/pdf")).toBeNull();
  });
});
