import PDFDocument from "pdfkit";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getObjectBuffer, isR2Configured, isR2ObjectNotFoundError, ObjectTooLargeError } from "../../lib/r2-client.js";
import { generateEvidenceJpeg } from "../../lib/image-thumbnail.js";
import { TROCK_LOGO_PNG_BASE64 } from "./pdf-logo.js";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const PAGE_MARGIN = 32;
const BRAND_RED = "#DC2626";
const BRAND_BLACK = "#111111";
const BRAND_LOGO_SURFACE = BRAND_BLACK;
const BRAND_MUTED = "#7589A3";
const BRAND_BORDER = "#EAECEF";
const LOGO_BUFFER = Buffer.from(TROCK_LOGO_PNG_BASE64, "base64");
const BRAND_FONT_REGULAR_NAME = "Geist-Regular";
const BRAND_FONT_BOLD_NAME = "Geist-Bold";
const BRAND_FONT_REGULAR_PATH = fileURLToPath(new URL("./assets/fonts/Geist-Regular.otf", import.meta.url));
const BRAND_FONT_BOLD_PATH = fileURLToPath(new URL("./assets/fonts/Geist-Bold.otf", import.meta.url));
const COVER_LOGO_PANEL_X = 183;
const COVER_LOGO_PANEL_Y = 322;
const COVER_LOGO_PANEL_WIDTH = 246;
const COVER_LOGO_PANEL_HEIGHT = 234;
const COVER_LOGO_PANEL_RADIUS = 18;
const COVER_LOGO_X = 201;
const COVER_LOGO_Y = 334;
const COVER_LOGO_FIT: [number, number] = [210, 210];

// --- Photo grid layout (contact sheet) -----------------------------------------------------------
// The page is a grid of identical CELLS, each one a photo tile with its caption and metadata below it.
// PHOTO_COLUMNS x PHOTO_ROWS_PER_PAGE drives the chunking, the cell pitch and the tile size together, so
// changing either re-flows the whole sheet consistently.
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
/**
 * TWO photo cells per row, ONE row down: two photographs a page.
 *
 * The 8-up grid this replaces fit eight cells a page, which made every photograph small — and the app's
 * captures are much narrower than a normal phone photo (measured 884x1920, ~0.46:1), so in a 148x156.5 tile
 * they contain-fit HEIGHT-bound to 72x156.5: a 72pt-wide strip nobody could read. Two cells a page is what
 * buys the width back. The cost is stated plainly: four times the pages for the same number of photographs.
 */
const PHOTO_COLUMNS = 2;
const PHOTO_ROWS_PER_PAGE = 1;
const PHOTOS_PER_PAGE = PHOTO_COLUMNS * PHOTO_ROWS_PER_PAGE;
const COLUMN_GAP = 20;
const COLUMN_WIDTH = (CONTENT_WIDTH - COLUMN_GAP * (PHOTO_COLUMNS - 1)) / PHOTO_COLUMNS;
const PHOTO_ROWS_TOP = 72;
const PHOTO_ROWS_BOTTOM = 740; // stay clear of the footer (drawn at PAGE_HEIGHT - 44)
const PHOTO_ROW_GAP = 14;
const PHOTO_ROW_PITCH = (PHOTO_ROWS_BOTTOM - PHOTO_ROWS_TOP + PHOTO_ROW_GAP) / PHOTO_ROWS_PER_PAGE;
/**
 * The photo sits in a FIXED grey tile and is letterboxed inside it, rather than being drawn at whatever
 * size its aspect happens to produce.
 *
 * This is the difference between a report that reads as designed and one that reads as broken. Fitting each
 * image to its own rectangle on page-white meant a portrait, a landscape and a panorama all started and
 * ended in different places — 0 to 196pt of ragged dead space per row — and the metadata, hung off the
 * rendered image, drifted with them. A constant tile gives every photograph the same footprint whatever its
 * shape, and letterboxing onto grey reads as deliberate framing where the identical letterbox on white just
 * reads as a mistake.
 *
 * FIXED at 560 rather than derived from PHOTO_ROW_PITCH, because the caption block sits BELOW the tile and
 * the tile has to leave room for it. The remainder (PHOTO_ROW_PITCH - PHOTO_TILE_HEIGHT = 682 - 560 =
 * 122pt) is that room, of which ~98pt is usable once CAPTION_GAP and PHOTO_ROW_GAP are taken.
 *
 * Being a literal rather than a derivation is the trade: it no longer moves with PHOTO_ROW_PITCH, so if
 * PHOTO_ROWS_TOP/BOTTOM/GAP are ever retuned this number must be revisited by hand or the caption band
 * silently overruns the footer.
 */
const PHOTO_TILE_HEIGHT = 560;
/**
 * Nearly the full column width, and a tall tile — sized for the narrow captures the app actually produces.
 *
 * A 0.46:1 photograph (the measured shape of the app's current captures) was HEIGHT-bound in the old
 * 148x156.5 tile: it rendered 72x156.5, and widening the tile alone would not have helped it while the tile
 * stayed short. At 256x560 the same photograph is WIDTH-bound and renders 256x556 — about 4pt of letterbox,
 * and ~12.6x the visible area (11.3k -> 142.3k pt^2). A 3:4 portrait goes 117x156.5 -> 256x341, a 4:3
 * landscape 148x111 -> 256x192; all three are larger, with more surrounding grey on the wider shapes,
 * because one fixed tile cannot be optimal for every aspect ratio and the narrow case is the unreadable one.
 */
const PHOTO_TILE_WIDTH = 256;
const PHOTO_TILE_RADIUS = 8;
const PHOTO_TILE_FILL = "#F4F5F7";
const PHOTO_ROW_HEIGHT = PHOTO_TILE_HEIGHT;
// Metadata is drawn as single-line, ellipsised rows. Each is capped to ONE line so a long deal/project name
// (the deal schema allows up to 500 chars) can never wrap and push the block past the cell below it — the
// blank-page/overlap regression the report layout exists to avoid. Kept at 7.5 rather than restored toward
// the one-up grid's 8.5pt even though the caption is about to run the tile's full 256pt: the cap that
// matters is the number of LINES the band can hold, and a larger face buys fewer of them.
const META_FONT_SIZE = 7.5;
const META_LINE_PITCH = 10;
// Caption + metadata sit BELOW the tile inside the same cell, running the tile's full width.
//
// They used to sit to its RIGHT, in whatever column width the tile did not use. At a 256pt tile inside a
// 264pt column that leftover is -2pt, so there is no "beside" left to sit in — and the move is what let the
// tile take the width in the first place. CAPTION_GAP is now a VERTICAL gap (tile bottom -> first text
// baseline) rather than a horizontal one.
const CAPTION_GAP = 10;
const CAPTION_WIDTH = PHOTO_TILE_WIDTH;
/**
 * Fail LOUDLY if the cell geometry is ever retuned into an impossible caption box.
 *
 * pdfkit does not throw on a negative or zero text width — `doc.text` and `heightOfString` silently render
 * nothing — so a bad constant here costs every caption and every metadata line in the report with no error
 * anywhere. That is exactly the failure this layout briefly had between two commits, and it is invisible to
 * a page-count test. Verified at module load because there is no later point where it would be cheaper.
 */
if (CAPTION_WIDTH <= 0) {
  throw new Error(
    `[field-photo-report] CAPTION_WIDTH must be positive, got ${CAPTION_WIDTH} — check PHOTO_TILE_WIDTH against COLUMN_WIDTH`,
  );
}
const IMAGE_BOX_WIDTH = PHOTO_TILE_WIDTH;
const IMAGE_BOX_HEIGHT = PHOTO_TILE_HEIGHT;

// --- Executive summary page(s) -------------------------------------------------------------------
// The optional executive summary renders on its own page(s) immediately after the cover, before any
// section dividers/photos. It flows across as many pages as the text needs (paginateTextByHeight).
const SUMMARY_HEADING = "Executive Summary";
const SUMMARY_HEADING_Y = 58;
const SUMMARY_ACCENT_Y = 86;
const SUMMARY_ACCENT_WIDTH = 54;
const SUMMARY_BODY_TOP = 100; // first page: below the heading + red accent rule
const SUMMARY_CONT_BODY_TOP = 58; // continuation pages: just under the header rule (no heading repeated)
const SUMMARY_BODY_BOTTOM = 720; // stay clear of the footer (drawn at PAGE_HEIGHT - 44 = 748)
const SUMMARY_BODY_FONT_SIZE = 11;
const SUMMARY_LINE_GAP = 4;

// --- Findings layout (AI condition assessment) ---------------------------------------------------
// A SECOND per-photo layout, opt-in via `photoLayout: "findings"`. The default grid above packs two photos
// per page over a caption band clamped to ~200 chars and ~98pt of height — built for short human captions
// and structurally unable to carry a multi-sentence, multi-bullet AI finding without ellipsising most of it.
// This layout inverts the proportions to match a written condition assessment: ONE photo per page, image
// across the full content width, a subject caption under it, then the findings as bullets. Bullets flow
// onto continuation pages (image not repeated) so a long finding is never truncated — the grid layout's
// `ellipsis: true` would silently drop exactly the evidence the report exists to communicate.
const FINDINGS_IMAGE_TOP = 62;
const FINDINGS_IMAGE_MAX_HEIGHT = 340;
const FINDINGS_CAPTION_GAP = 14; // image bottom → caption baseline box
const FINDINGS_CAPTION_FONT_SIZE = 10;
const FINDINGS_BULLETS_GAP = 16; // caption bottom → first bullet
const FINDINGS_BODY_BOTTOM = 736; // stay clear of the footer (drawn at PAGE_HEIGHT - 44 = 748)
const FINDINGS_CONT_BODY_TOP = 58; // continuation pages start just under the header rule
const FINDINGS_BULLET_FONT_SIZE = 10.5;
const FINDINGS_BULLET_LINE_GAP = 2.5;
const FINDINGS_BULLET_SPACING = 9; // vertical gap between consecutive bullets
const FINDINGS_BULLET_INDENT = 18; // text inset from the margin; the glyph sits in the gutter
const FINDINGS_BULLET_TEXT_WIDTH = CONTENT_WIDTH - FINDINGS_BULLET_INDENT;

type ReportFontSet = {
  regular: string;
  bold: string;
};

export type ReportRenderablePhoto = {
  id: string;
  displayName: string;
  description: string | null;
  takenAt: string | null;
  createdAt: string;
  uploaderName: string;
  projectName: string;
  tags: string[];
  r2Key: string | null;
  externalUrl: string | null;
  externalThumbnailUrl: string | null;
  /**
   * Stored MIME type, used to decide whether the original needs transcoding before PDFKit can embed it
   * (PDFKit accepts JPEG/PNG only). Optional so existing callers are unaffected; when absent the loader
   * falls back to the type R2 reports, and transcodes anything it cannot confirm is native.
   */
  mimeType?: string | null;
};

export type ReportRenderSection = {
  title: string;
  photos: Array<ReportRenderablePhoto & { descriptionOverride?: string | null; reportIndex: number }>;
};

export type ReportCoverData = {
  reportTitle: string;
  creatorName: string;
  companyName: string;
  reportDateLabel: string;
  projectName: string;
  photoCount: number;
};

type PageMeta =
  | { kind: "cover"; footerLabel: string; projectName: string }
  | { kind: "section"; footerLabel: string; projectName: string; reportTitle: string; dateLabel: string };

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function clampText(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/**
 * Bound a string's LENGTH while leaving its line structure intact.
 *
 * clampText above normalises whitespace, which is right for a single-line caption and wrong for anything
 * parseFindingText reads: that function splits a title from its bullets on newlines, so collapsing them
 * would silently turn a structured finding into one run-on paragraph.
 */
function clampLength(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/**
 * Ceiling on the text a single findings page will paginate.
 *
 * `files.description` is an unbounded `text` column and the generic metadata/import paths write it with no
 * cap. Unlike the grid renderer — which clamps its caption to a fixed box — drawFindingsPhotoPages
 * paginates the WHOLE value across as many continuation pages as it takes, so one pathological imported
 * caption (or several long ones in a 60-photo selection) can buffer thousands of pages and exhaust the
 * worker. Generous enough for a real multi-bullet finding, which runs to a few hundred characters.
 */
const MAX_FINDINGS_BODY_CHARS = 4_000;

/**
 * Break a single word that is taller than the page budget into character slices that each fit. PDFKit
 * DOES char-wrap a space-less token (a pasted URL / base64 blob), so its rendered height can exceed a
 * whole page — and an unbounded doc.text of such a chunk auto-creates continuation pages OUTSIDE the
 * explicit pageMeta accounting, desyncing every following footer. Binary-searches the largest prefix
 * that fits (always ≥ 1 char, so it can't loop). Returns the ordered slices; the caller emits all but
 * the last as complete pages and keeps the last for further packing.
 */
function splitOversizedToken(token: string, maxHeight: number, measure: (chunk: string) => number): string[] {
  const parts: string[] = [];
  let rest = token;
  while (measure(rest) > maxHeight && rest.length > 1) {
    let lo = 1;
    let hi = rest.length - 1;
    let best = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (measure(rest.slice(0, mid)) <= maxHeight) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    parts.push(rest.slice(0, best));
    rest = rest.slice(best);
  }
  parts.push(rest);
  return parts;
}

/**
 * Split free-form text into page-sized chunks. `measure(chunk)` returns the rendered height of that
 * chunk at the body column width; words are packed greedily until the next word would exceed
 * `maxHeight`, then a new page starts. A single word taller than the budget is split by character
 * across pages (splitOversizedToken) so NO emitted chunk ever exceeds the budget. Explicit newlines
 * (paragraph breaks) are preserved. Exported for unit testing (the height measurer is injected so it
 * needs no live PDFDocument).
 */
export function paginateTextByHeight(
  text: string,
  maxHeight: number,
  measure: (chunk: string) => number,
): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!normalized) return [];
  // Tokens are words; explicit newlines become standalone "\n" tokens so paragraph breaks survive.
  const tokens = normalized.split("\n").flatMap((line, index) => {
    const words = line.split(" ").filter((word) => word.length > 0);
    return index === 0 ? words : ["\n", ...words];
  });
  const render = (toks: string[]) => toks.join(" ").replace(/ ?\n ?/g, "\n").trim();
  const pages: string[] = [];
  let current: string[] = [];
  // Seed a fresh page with a single word, emitting full pages for and returning the residual of any word
  // too tall to fit alone. A "\n" token never seeds a page (it renders empty at a page start).
  const seedWord = (word: string): string[] => {
    if (word === "\n" || measure(word) <= maxHeight) return word === "\n" ? [] : [word];
    const parts = splitOversizedToken(word, maxHeight, measure);
    for (let i = 0; i < parts.length - 1; i += 1) pages.push(parts[i]);
    return [parts[parts.length - 1]];
  };
  for (const token of tokens) {
    if (current.length === 0) {
      current = seedWord(token);
      continue;
    }
    if (measure(render([...current, token])) > maxHeight) {
      pages.push(render(current));
      current = seedWord(token);
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) {
    const rendered = render(current);
    if (rendered) pages.push(rendered);
  }
  return pages;
}

function formatPhotoDate(value: string | null, fallback: string): string {
  const date = new Date(value ?? fallback);
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }) + date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).replace(/^/, ", ");
}

/**
 * The photo-grid date. "Jul 31, 2026, 4:52 PM" — abbreviated month, but the YEAR IS KEPT.
 *
 * Only the month name is shortened. Dropping the year looked safe on the grounds that it appears on the
 * cover, the page header and the footer — but that is the REPORT's year, not the photograph's. A report can
 * carry historical photos or straddle a year boundary, and "Jul 31, 4:52 PM" then reads identically for a
 * 2025 and a 2026 capture, which for an evidence document is a real loss.
 *
 * It fits: measured against Geist at META_FONT_SIZE, the long form is 74.7pt (82.4pt worst case) inside a
 * ~106pt column. The width worry that prompted the short form came from the one-up grid's 8.5pt text and
 * did not survive the move to 7.5pt.
 */
function formatPhotoDateCompact(value: string | null, fallback: string): string {
  const date = new Date(value ?? fallback);
  return `${date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}, ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

async function fetchExternalImageBuffer(url: string): Promise<Buffer | null> {
  if (!url.startsWith("data:image/")) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Ceiling on an original read into memory to embed in the PDF.
 *
 * Uploads accept up to 200MB, and this ran uncapped — so a single oversized original could be buffered in
 * full during rendering, and a report is a LOOP over photos. Matches the cap the AI vision pass already
 * applies; past it the photo renders as the existing "Image unavailable" placeholder rather than risking
 * the worker process (and every other job handler sharing it).
 */
const MAX_RENDER_SOURCE_BYTES = 40 * 1024 * 1024;

/**
 * PDFKit's image loader accepts JPEG and PNG only. Anything else — HEIC/HEIF straight off an iPhone, WebP,
 * TIFF, AVIF — makes openImage throw, and the page prints "Image unavailable" for a photograph that is
 * perfectly fine. Transcode those to JPEG first, using the same pipeline that already handles HEIC decode,
 * EXIF rotation and transparency flattening elsewhere.
 */
const PDFKIT_NATIVE_MIME = /^image\/(jpeg|jpg|png)$/i;
/** Generous enough to stay sharp at full page width, without re-encoding a 4000px original at full size. */
const RENDER_TRANSCODE_MAX_EDGE = 2000;
/**
 * Above this, even a NATIVE JPEG/PNG is downscaled before being handed to PDFKit.
 *
 * PDFKit retains every embedded image for the life of the document, so a 60-photo report of full-resolution
 * originals holds all of them at once and writes them all into the file. Bounding each one keeps both peak
 * memory and the finished PDF proportional to the page count rather than to camera resolution. Small images
 * skip the re-encode entirely, so the common case costs nothing.
 */
const RENDER_TRANSCODE_ABOVE_BYTES = 2 * 1024 * 1024;

/**
 * Ceiling on an original PDFKit may embed WITHOUT a successful transcode.
 *
 * sharp legitimately refuses some images it cannot bound — most often a native JPEG whose decoded raster is
 * over its pixel limit. Handing the raw original back on that path re-opens the exact bound the transcode
 * exists to enforce (PDFKit retains every embedded image for the life of the document), so a report full of
 * rejected originals is unbounded again. A moderately-large native still embeds — better a real photograph
 * than a placeholder — but past this it renders as "Image unavailable" instead.
 */
export const MAX_UNTRANSCODED_EMBED_BYTES = 8 * 1024 * 1024;

/**
 * What PDFKit gets when the bounded transcode fails.
 *
 * Only a native format could embed at all — anything else makes openImage throw and draws the placeholder —
 * so a non-native buffer is dropped here rather than carried through the renderer just to be rejected. A
 * native one passes through only while it stays inside the ceiling; past that the memory bound matters more
 * than the photograph.
 *
 * Exported for test on purpose: this decision IS the bound, and exercising it through a full render would
 * need a genuinely valid multi-megabyte JPEG that sharp also refuses — a fixture that would make the test
 * slow and, if it were merely random bytes, pass whether or not the bound existed.
 */
export function untranscodedFallback(buffer: Buffer, mime: string | null): Buffer | null {
  const native = mime ? PDFKIT_NATIVE_MIME.test(mime) : false;
  return native && buffer.byteLength <= MAX_UNTRANSCODED_EMBED_BYTES ? buffer : null;
}

async function loadPhotoBuffer(
  photo: ReportRenderablePhoto,
  /**
   * Bounds the object read AND the transcode below. Phase D of the AI report re-reads and re-decodes every
   * original, on a poller that is serial and single-in-flight — an unbounded stall here does not just
   * outlive one run's lease, it wedges every subsequent report with nothing able to free it.
   */
  signal: AbortSignal | undefined,
  /**
   * When true, a TRANSIENT storage failure is re-thrown instead of degrading to a placeholder. The AI
   * report uses this: silently emitting an "Image unavailable" panel — potentially beside findings derived
   * from that very photograph — and then marking the run succeeded is worse than failing and retrying.
   * The human path leaves it false to keep its long-standing degrade-gracefully behaviour.
   */
  strictStorage = false,
): Promise<Buffer | null> {
  if (photo.r2Key && isR2Configured()) {
    let buffer: Buffer;
    let contentType: string | undefined;
    try {
      ({ buffer, contentType } = await getObjectBuffer(photo.r2Key, {
        maxBytes: MAX_RENDER_SOURCE_BYTES,
        signal,
      }));
    } catch (error) {
      // Permanent, photo-specific failures still degrade to a placeholder in BOTH modes — the photo is
      // genuinely unusable and no retry changes that.
      const permanent = error instanceof ObjectTooLargeError || isR2ObjectNotFoundError(error);
      if (strictStorage && !permanent) throw error;
      return null;
    }

    const mime = photo.mimeType ?? contentType ?? null;
    const needsTranscode =
      !mime || !PDFKIT_NATIVE_MIME.test(mime) || buffer.byteLength > RENDER_TRANSCODE_ABOVE_BYTES;
    if (!needsTranscode) return buffer;
    try {
      // Raced against the caller's budget as well as caught. sharp cannot be cancelled once running, so
      // this bounds the WAIT rather than the work — but an unbounded wait here is what wedges the serial
      // AI-report poller, since Phase D re-decodes every original and nothing else can free it.
      const transcode = generateEvidenceJpeg(buffer, mime, { maxEdge: RENDER_TRANSCODE_MAX_EDGE, quality: 82 });
      if (!signal) return await transcode;
      return await Promise.race([
        transcode,
        new Promise<never>((_, reject) => {
          if (signal.aborted) return reject(new Error("render aborted"));
          signal.addEventListener("abort", () => reject(new Error("render aborted")), { once: true });
        }),
      ]);
    } catch (error) {
      // An abort is the caller giving up on the whole render — it must propagate, not silently degrade to
      // an un-transcoded original and carry on rendering a report nobody is waiting for any more.
      if (signal?.aborted) throw error;
      // sharp cannot read it — most often a native JPEG whose decoded raster is over its pixel limit.
      return untranscodedFallback(buffer, mime);
    }
  }
  // No R2 copy — an external-only import (CompanyCam and similar keep a plain CDN URL with no stored
  // original). Only INLINE data is readable here: reaching a CDN would mean the server issuing outbound
  // requests to addresses it does not choose, which is deliberately not part of this feature. Such a photo
  // draws the "Image unavailable" placeholder. Support for fetching them lives on
  // feat/trockcam-external-photos, where the destination allow-listing gets its own review.
  if (photo.externalUrl?.startsWith("data:image/")) return fetchExternalImageBuffer(photo.externalUrl);
  if (photo.externalThumbnailUrl?.startsWith("data:image/")) return fetchExternalImageBuffer(photo.externalThumbnailUrl);
  return null;
}

function drawFooter(
  doc: PDFKit.PDFDocument,
  fonts: ReportFontSet,
  label: string,
  currentPage: number,
  totalPages: number,
  projectName: string,
) {
  const footerY = PAGE_HEIGHT - 44;
  doc.save();
  doc.font(fonts.regular).fontSize(10).fillColor(BRAND_MUTED);
  // Footer text MUST stay on a single capped line: `lineBreak: false` + an explicit `height` + `ellipsis`
  // so a long label/project name (project names can run ~140 chars) can never wrap. Wrapping near the page
  // bottom is what let pdfkit spill into a fresh blank page — the exact bug this report fix is closing.
  const footerOpts = { lineBreak: false, height: 12, ellipsis: true } as const;
  doc.text(label, PAGE_MARGIN, footerY, { width: 140, align: "left", ...footerOpts });
  doc.text(`${currentPage} / ${totalPages}`, PAGE_MARGIN, footerY, { width: PAGE_WIDTH - PAGE_MARGIN * 2, align: "center", ...footerOpts });
  doc.text(projectName, PAGE_WIDTH - PAGE_MARGIN - 200, footerY, { width: 200, align: "right", ...footerOpts });
  doc.restore();
}

function drawSectionHeader(doc: PDFKit.PDFDocument, fonts: ReportFontSet, reportTitle: string, dateLabel: string) {
  doc.save();
  doc.font(fonts.regular).fontSize(11).fillColor(BRAND_MUTED);
  // Single line only (no-wrap + ellipsis) so a long report title can't push the header band down.
  doc.text(reportTitle, PAGE_MARGIN, 24, { width: PAGE_WIDTH / 2 - PAGE_MARGIN, lineBreak: false, height: 14, ellipsis: true });
  doc.font(fonts.regular).fontSize(10).fillColor(BRAND_MUTED);
  doc.text(dateLabel, PAGE_WIDTH / 2, 24, { width: PAGE_WIDTH / 2 - PAGE_MARGIN, align: "right", lineBreak: false, height: 13, ellipsis: true });
  doc.moveTo(PAGE_MARGIN, 44).lineTo(PAGE_WIDTH - PAGE_MARGIN, 44).strokeColor(BRAND_BORDER).lineWidth(1).stroke();
  doc.restore();
}

// Compact, single-line section title drawn in the slim band between the header rule (y=44) and the first
// photo row (y=66). Used on a single-section report's first photo page, where the full-page section
// divider is skipped — without this the user's custom section title would be dropped entirely.
function drawCompactSectionTitle(doc: PDFKit.PDFDocument, fonts: ReportFontSet, title: string) {
  doc.save();
  // LEFT-aligned, on the margin the tiles below start from. Centred, it floated between the header rule and
  // the first tile belonging to neither — and it is a section label, not a page heading.
  doc.fillColor(BRAND_MUTED).font(fonts.bold).fontSize(10);
  doc.text(title.toUpperCase(), PAGE_MARGIN, 52, {
    width: PAGE_WIDTH - PAGE_MARGIN * 2,
    align: "left",
    lineBreak: false,
    height: 13,
    characterSpacing: 0.6,
    ellipsis: true,
  });
  doc.restore();
}

function drawSectionTitlePage(
  doc: PDFKit.PDFDocument,
  fonts: ReportFontSet,
  reportTitle: string,
  dateLabel: string,
  sectionTitle: string,
) {
  drawSectionHeader(doc, fonts, reportTitle, dateLabel);
  doc.save();
  doc.fillColor(BRAND_BLACK).font(fonts.bold).fontSize(26);
  doc.text(sectionTitle, PAGE_MARGIN, PAGE_HEIGHT / 2 - 22, {
    width: PAGE_WIDTH - PAGE_MARGIN * 2,
    align: "center",
  });
  doc.restore();
}

// The optional executive summary: its own page(s) right after the cover, in Trock brand colors + Geist.
// The heading + red accent rule draw only on the first page; body text flows across pages as needed.
// One pageMeta entry is pushed per page (IN ORDER) so the footer pass — which indexes pageMeta by page —
// stays aligned; getting that wrong is the one way this feature would corrupt every page's footer.
function drawExecutiveSummaryPages(
  doc: PDFKit.PDFDocument,
  fonts: ReportFontSet,
  opts: { summary: string; reportTitle: string; dateLabel: string; projectName: string },
  pageMeta: PageMeta[],
) {
  // Measure with the body font/size set on the doc BEFORE any drawing mutates the current font, so the
  // injected height measurement matches how the body text actually renders below.
  doc.font(fonts.regular).fontSize(SUMMARY_BODY_FONT_SIZE);
  const measure = (chunk: string) =>
    doc.heightOfString(chunk, { width: CONTENT_WIDTH, lineGap: SUMMARY_LINE_GAP });
  // Budget on the (smaller) first-page text box so continuation pages, which start higher, never overflow.
  const pages = paginateTextByHeight(opts.summary, SUMMARY_BODY_BOTTOM - SUMMARY_BODY_TOP, measure);
  if (pages.length === 0) return;

  pages.forEach((pageText, index) => {
    doc.addPage();
    pageMeta.push({
      kind: "section",
      footerLabel: pages.length > 1 ? `Executive Summary ${index + 1}` : "Executive Summary",
      projectName: opts.projectName,
      reportTitle: opts.reportTitle,
      dateLabel: opts.dateLabel,
    });
    drawSectionHeader(doc, fonts, opts.reportTitle, opts.dateLabel);
    let bodyTop = SUMMARY_CONT_BODY_TOP;
    if (index === 0) {
      doc.save();
      doc.fillColor(BRAND_BLACK).font(fonts.bold).fontSize(20).text(SUMMARY_HEADING, PAGE_MARGIN, SUMMARY_HEADING_Y, {
        width: CONTENT_WIDTH,
        lineBreak: false,
        height: 26,
        ellipsis: true,
      });
      doc
        .moveTo(PAGE_MARGIN, SUMMARY_ACCENT_Y)
        .lineTo(PAGE_MARGIN + SUMMARY_ACCENT_WIDTH, SUMMARY_ACCENT_Y)
        .lineWidth(3)
        .strokeColor(BRAND_RED)
        .stroke();
      doc.restore();
      bodyTop = SUMMARY_BODY_TOP;
    }
    doc.fillColor(BRAND_BLACK).font(fonts.regular).fontSize(SUMMARY_BODY_FONT_SIZE);
    // Hard height cap so pdfkit can NEVER auto-create a continuation page outside the pageMeta accounting
    // (which would desync every following footer). paginateTextByHeight already keeps each chunk within
    // the budget, so this clamp only ever engages as a backstop and truncates nothing in practice.
    doc.text(pageText, PAGE_MARGIN, bodyTop, {
      width: CONTENT_WIDTH,
      height: SUMMARY_BODY_BOTTOM - bodyTop,
      lineGap: SUMMARY_LINE_GAP,
    });
  });
}

type OpenedImage = { width: number; height: number; orientation?: number };

// pdfkit's openImage isn't in @types/pdfkit. Decode once to get intrinsic dimensions (so we can tight-frame
// the exact rendered rectangle) and reuse the opened image for the actual draw (no second decode). Returns
// the EXIF-orientation-adjusted display size — pdfkit swaps w/h for orientations > 4 when it draws.
function openImageForLayout(
  doc: PDFKit.PDFDocument,
  buffer: Buffer,
  photo: Pick<ReportRenderablePhoto, "id" | "displayName">,
): { image: OpenedImage; displayWidth: number; displayHeight: number } | null {
  try {
    const image = (doc as unknown as { openImage(src: Buffer): OpenedImage }).openImage(buffer);
    if (!image || !(image.width > 0) || !(image.height > 0)) {
      // Decoded, but to nothing usable. Distinct from a throw and worth its own line: it is what a
      // zero-byte or truncated upload looks like from here.
      console.warn("[field-photo-report] a photo decoded to no usable dimensions; drawing the placeholder", {
        photoId: photo.id,
        displayName: photo.displayName,
      });
      return null;
    }
    const rotated = (image.orientation ?? 1) > 4;
    return {
      image,
      displayWidth: rotated ? image.height : image.width,
      displayHeight: rotated ? image.width : image.height,
    };
  } catch (error) {
    // THIS is where a corrupt file or a format pdfkit cannot read actually fails — before any draw is
    // attempted. Swallowing it silently made a report missing evidence look identical to one whose
    // photograph simply would not decode, with nothing naming which photograph was lost.
    console.warn("[field-photo-report] could not decode a photo; drawing the placeholder", {
      photoId: photo.id,
      displayName: photo.displayName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function drawIndexBadge(doc: PDFKit.PDFDocument, fonts: ReportFontSet, x: number, y: number, index: number) {
  doc.roundedRect(x + 6, y + 6, 26, 22, 5).fillColor("white").fill();
  doc.fillColor(BRAND_BLACK).font(fonts.bold).fontSize(11).text(String(index), x + 6, y + 11, {
    width: 26,
    align: "center",
  });
}

function drawImageUnavailable(doc: PDFKit.PDFDocument, fonts: ReportFontSet, x: number, y: number, w: number, h: number) {
  doc.roundedRect(x, y, w, h, 6).fillColor("#F3F4F6").fill();
  doc.fillColor(BRAND_MUTED).font(fonts.bold).fontSize(12).text("Image unavailable", x, y + h / 2 - 8, {
    width: w,
    align: "center",
  });
}

async function drawPhotoEntry(
  doc: PDFKit.PDFDocument,
  fonts: ReportFontSet,
  photo: ReportRenderSection["photos"][number],
  left: number,
  top: number,
  coverProjectName: string,
  signal: AbortSignal | undefined,
) {
  const boxWidth = IMAGE_BOX_WIDTH;
  const boxHeight = IMAGE_BOX_HEIGHT;

  // The tile is drawn FIRST and always, whether or not the photo loads. It is what gives every cell an
  // identical footprint; the image is a guest inside it.
  doc.roundedRect(left, top, boxWidth, boxHeight, PHOTO_TILE_RADIUS).fillColor(PHOTO_TILE_FILL).fill();

  const imageBuffer = await loadPhotoBuffer(photo, signal);
  // Only a FAILED LOAD is worth a line. A row with no key and no external URL had nothing to fetch in the
  // first place — that is the placeholder working as intended, not a fault — whereas a key that would not
  // resolve means R2 refused it or the object is gone, and nothing else raises so the placeholder would
  // otherwise be the only trace.
  if (!imageBuffer && (photo.r2Key || photo.externalUrl || photo.externalThumbnailUrl)) {
    console.warn("[field-photo-report] could not load a photo's bytes; drawing the placeholder", {
      photoId: photo.id,
      displayName: photo.displayName,
      r2Key: photo.r2Key,
    });
  }
  const opened = imageBuffer ? openImageForLayout(doc, imageBuffer, photo) : null;
  let drew = false;
  if (opened) {
    // Contain, then centre. NOT cover: this is an evidence document, and filling the tile would silently
    // crop the edges off the thing being photographed. The letterbox shows as tile grey, which reads as
    // deliberate framing — the same letterbox on page-white is what made the old layout look broken.
    const scale = Math.min(boxWidth / opened.displayWidth, boxHeight / opened.displayHeight);
    const drawWidth = opened.displayWidth * scale;
    const drawHeight = opened.displayHeight * scale;
    const drawLeft = left + (boxWidth - drawWidth) / 2;
    const drawTop = top + (boxHeight - drawHeight) / 2;
    // CLIPPED to the tile, not merely drawn on top of it. roundedRect().fill() paints a background and
    // establishes no clipping path, so a photograph whose aspect is close to the tile's — 16:9 lands at
    // 268.4x151 inside a 270x151 tile, which is most jobsite panoramas — covers the rounded corner cutouts
    // with its own square ones and reads as spilling out of the frame.
    //
    // save/clip OUTSIDE the try and restore in `finally`, so the pairing cannot come apart: a throw from
    // doc.image would otherwise leave the clip on the graphics stack and silently crop everything drawn
    // after it, on this page and every page that follows.
    doc.save();
    doc.roundedRect(left, top, boxWidth, boxHeight, PHOTO_TILE_RADIUS).clip();
    try {
      doc.image(opened.image as unknown as Buffer, drawLeft, drawTop, { width: drawWidth, height: drawHeight });
      drew = true;
    } catch (error) {
      // Log which photograph failed. Silently swapping in the placeholder makes a report that is missing
      // evidence look identical to one whose photograph simply would not decode.
      console.warn("[field-photo-report] could not embed a photo; drawing the placeholder", {
        photoId: photo.id,
        displayName: photo.displayName,
        error: error instanceof Error ? error.message : String(error),
      });
      drew = false;
    } finally {
      doc.restore();
    }
  }
  if (!drew) {
    doc.fillColor(BRAND_MUTED).font(fonts.bold).fontSize(8).text("Image unavailable", left, top + boxHeight / 2 - 5, {
      width: boxWidth,
      align: "center",
    });
  }
  // Badge on the TILE corner, not the image corner, so it sits in the same place in every cell.
  drawIndexBadge(doc, fonts, left, top, photo.reportIndex);

  // --- Caption + metadata, BELOW the tile ----------------------------------------------------------
  // Top-anchored to the tile's bottom edge and flowing downward: description first, then metadata. The old
  // layout bottom-anchored this group to the tile's bottom-right, which only made sense while it lived in a
  // narrow side column. Below the tile there is a fixed band, so ordinary top-down reading order is both
  // simpler and what a reader expects under a photograph.
  //
  // The "Project:"/"Date:"/"Creator:" labels stay GONE — the values are self-evident, and the project name
  // is already the page header, the footer and the cover title. It is printed here ONLY when a photograph
  // belongs to some other project than the report's, the case where it is information rather than furniture.
  const captionLeft = left;
  const captionTop = top + boxHeight + CAPTION_GAP;

  const metaLines = [formatPhotoDateCompact(photo.takenAt, photo.createdAt), photo.uploaderName];
  if (photo.projectName.trim() && photo.projectName.trim() !== coverProjectName.trim()) {
    metaLines.push(photo.projectName);
  }

  // The description gets whatever vertical room is left after the metadata rows are reserved, so a long
  // caption can never push the metadata out of the cell and into the page furniture below it.
  const metaBlockHeight = metaLines.length * META_LINE_PITCH;
  const captionBandHeight = PHOTO_ROW_PITCH - boxHeight - CAPTION_GAP - PHOTO_ROW_GAP;
  const descriptionAvailable = Math.max(0, captionBandHeight - metaBlockHeight - 4);

  let cursor = captionTop;
  const description = clampText(photo.descriptionOverride ?? photo.description ?? "", 200);
  if (description && descriptionAvailable > 0) {
    doc.fillColor(BRAND_BLACK).font(fonts.regular).fontSize(8);
    const measured = doc.heightOfString(description, { width: CAPTION_WIDTH, lineGap: 1.5 });
    const descriptionHeight = Math.min(measured, descriptionAvailable);
    doc.text(description, captionLeft, cursor, {
      width: CAPTION_WIDTH,
      lineGap: 1.5,
      height: descriptionHeight,
      ellipsis: true,
    });
    cursor += descriptionHeight + 4;
  }

  metaLines.forEach((value, index) => {
    doc.fillColor(BRAND_MUTED).font(fonts.regular).fontSize(META_FONT_SIZE);
    // One line each, ellipsised, so a 500-char project name truncates instead of wrapping into the page
    // furniture below the cell.
    doc.text(value, captionLeft, cursor + index * META_LINE_PITCH, {
      width: CAPTION_WIDTH,
      align: "left",
      lineBreak: false,
      height: META_LINE_PITCH,
      ellipsis: true,
    });
  });
}

export type ParsedFinding = {
  /** Short subject/location label rendered under the photo, or null when the text is plain prose. */
  title: string | null;
  /** Findings bodies — bulleted when `bulleted`, otherwise plain paragraphs. */
  bodies: string[];
  bulleted: boolean;
};

/**
 * Split a per-photo finding into its subject label and its finding bodies.
 *
 * The AI report serializes each finding into the EXISTING `photoOverrides[].description` string (so
 * generateFieldPhotoReport's input contract is untouched) in the shape:
 *
 *     Northeast stair tower — third-floor landing
 *     - Rust bleed below the cap flashing indicates water tracking down the post.
 *     - Deck boards show gapping that reduces bearing under the unit pads.
 *
 * A human-written caption has no bullet markers, so it stays a plain paragraph with NO invented title —
 * inferring a title from prose would silently promote the first sentence into a heading. Continuation
 * lines (a wrapped bullet in the source text) are folded back into the bullet they belong to rather than
 * becoming stray bullets of their own. Exported for unit testing.
 */
export function parseFindingText(raw: string): ParsedFinding {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim());
  const isMarker = (line: string) => /^[-•*]\s+/.test(line);
  const stripMarker = (line: string) => line.replace(/^[-•*]\s+/, "");
  const bulleted = lines.some(isMarker);

  if (!bulleted) {
    const bodies = lines.filter(Boolean);
    return { title: null, bodies, bulleted: false };
  }

  let title: string | null = null;
  const bodies: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (isMarker(line)) {
      bodies.push(stripMarker(line));
      continue;
    }
    // A non-marker line BEFORE any bullet is the subject label; after one, it is a wrapped continuation.
    // Anything else — prose sitting between the label and the first bullet — becomes its own body rather
    // than being dropped, which silently deleted crew caption text from the PDF.
    if (bodies.length === 0 && title === null) title = line;
    else if (bodies.length > 0) bodies[bodies.length - 1] += ` ${line}`;
    else bodies.push(line);
  }
  return { title, bodies, bulleted: true };
}

/**
 * Render ONE photo as its own page (or pages) in the findings layout: full-width image, subject caption,
 * then the findings as bullets. Bullets that don't fit continue on a fresh page WITHOUT repeating the
 * image; a single bullet taller than a whole page is split by paginateTextByHeight, so no finding text is
 * ever ellipsised away. One pageMeta entry is pushed per addPage, IN ORDER, so the footer pass — which
 * indexes pageMeta by page — stays aligned.
 */
async function drawFindingsPhotoPages(
  doc: PDFKit.PDFDocument,
  fonts: ReportFontSet,
  photo: ReportRenderSection["photos"][number],
  header: { reportTitle: string; dateLabel: string; projectName: string; footerLabel: string },
  pageMeta: PageMeta[],
  signal: AbortSignal | undefined,
) {
  const startPage = () => {
    doc.addPage();
    pageMeta.push({
      kind: "section",
      footerLabel: header.footerLabel,
      projectName: header.projectName,
      reportTitle: header.reportTitle,
      dateLabel: header.dateLabel,
    });
    drawSectionHeader(doc, fonts, header.reportTitle, header.dateLabel);
  };

  startPage();

  // --- Photo, fit to the full content width and centred -------------------------------------------
  // strictStorage: this is the AI report. A placeholder panel sitting beside findings written about that
  // very photograph, in a document then marked succeeded, is a worse outcome than failing the run.
  const imageBuffer = await loadPhotoBuffer(photo, signal, true);
  // Pass the photo through so a decode failure names itself in the log. It matters MORE on this layout than
  // on the grid: a placeholder here sits directly under findings written about that photograph.
  const opened = imageBuffer ? openImageForLayout(doc, imageBuffer, photo) : null;
  let imageBottom = FINDINGS_IMAGE_TOP + FINDINGS_IMAGE_MAX_HEIGHT;
  let drawn = false;
  if (opened) {
    const scale = Math.min(CONTENT_WIDTH / opened.displayWidth, FINDINGS_IMAGE_MAX_HEIGHT / opened.displayHeight);
    const drawWidth = opened.displayWidth * scale;
    const drawHeight = opened.displayHeight * scale;
    const left = PAGE_MARGIN + (CONTENT_WIDTH - drawWidth) / 2;
    try {
      doc.image(opened.image as unknown as Buffer, left, FINDINGS_IMAGE_TOP, { width: drawWidth, height: drawHeight });
      doc.roundedRect(left, FINDINGS_IMAGE_TOP, drawWidth, drawHeight, 6).lineWidth(1).strokeColor(BRAND_BORDER).stroke();
      drawIndexBadge(doc, fonts, left, FINDINGS_IMAGE_TOP, photo.reportIndex);
      imageBottom = FINDINGS_IMAGE_TOP + drawHeight;
      drawn = true;
    } catch {
      drawn = false;
    }
  }
  if (!drawn) {
    drawImageUnavailable(doc, fonts, PAGE_MARGIN, FINDINGS_IMAGE_TOP, CONTENT_WIDTH, FINDINGS_IMAGE_MAX_HEIGHT);
    drawIndexBadge(doc, fonts, PAGE_MARGIN, FINDINGS_IMAGE_TOP, photo.reportIndex);
  }

  // Bounded before parsing. The override is model output and already shaped, but the fallback is the crew's
  // own caption straight off files.description — and this is the one renderer that paginates a raw
  // description rather than clamping it into a fixed box.
  const parsed = parseFindingText(
    clampLength(photo.descriptionOverride ?? photo.description ?? "", MAX_FINDINGS_BODY_CHARS),
  );

  // --- Subject caption ----------------------------------------------------------------------------
  // Only drawn when there IS a subject label. A photo the assessment passed over carries either the crew's
  // own caption (which renders as body text below) or nothing at all — inventing a "Photo 7" heading for it
  // would be exactly the manufactured caption this report is designed not to produce. The index badge on
  // the image already carries the number.
  let cursor = imageBottom + FINDINGS_CAPTION_GAP;
  const caption = parsed.title ? clampText(parsed.title, 160) : "";
  if (caption) {
    doc.fillColor(BRAND_BLACK).font(fonts.bold).fontSize(FINDINGS_CAPTION_FONT_SIZE);
    const captionMaxHeight = 28;
    const captionHeight = Math.min(
      doc.heightOfString(caption, { width: CONTENT_WIDTH, lineGap: 1 }),
      captionMaxHeight,
    );
    doc.text(caption, PAGE_MARGIN, cursor, {
      width: CONTENT_WIDTH,
      lineGap: 1,
      height: captionMaxHeight,
      ellipsis: true,
    });
    cursor += captionHeight + FINDINGS_BULLETS_GAP;
  }

  // --- Findings -----------------------------------------------------------------------------------
  // Measure with the body font set INSIDE the measurer: drawSectionHeader (on every continuation page)
  // mutates the current font, so a measurer that trusted ambient state would size against the header font.
  // Width MUST match the draw call below (bulleted bodies are inset by the glyph gutter); measuring at a
  // different width silently mis-sizes the fit check that keeps text off the footer.
  const bodyWidth = parsed.bulleted ? FINDINGS_BULLET_TEXT_WIDTH : CONTENT_WIDTH;
  const bodyLeft = PAGE_MARGIN + (parsed.bulleted ? FINDINGS_BULLET_INDENT : 0);
  const measure = (chunk: string) => {
    doc.font(fonts.regular).fontSize(FINDINGS_BULLET_FONT_SIZE);
    return doc.heightOfString(chunk, { width: bodyWidth, lineGap: FINDINGS_BULLET_LINE_GAP });
  };
  const freshPageHeight = FINDINGS_BODY_BOTTOM - FINDINGS_CONT_BODY_TOP;

  for (const body of parsed.bodies) {
    if (!body.trim()) continue;
    for (const [pieceIndex, piece] of paginateTextByHeight(body, freshPageHeight, measure).entries()) {
      const pieceHeight = measure(piece);
      if (cursor + pieceHeight > FINDINGS_BODY_BOTTOM) {
        startPage();
        cursor = FINDINGS_CONT_BODY_TOP;
      }
      if (parsed.bulleted && pieceIndex === 0) {
        doc.fillColor(BRAND_RED).font(fonts.bold).fontSize(FINDINGS_BULLET_FONT_SIZE);
        doc.text("•", PAGE_MARGIN + 4, cursor, { width: 10, lineBreak: false, height: 14 });
      }
      doc.fillColor(BRAND_BLACK).font(fonts.regular).fontSize(FINDINGS_BULLET_FONT_SIZE);
      // Hard height cap so pdfkit can NEVER auto-create a page outside the pageMeta accounting (which
      // would desync every following footer). The fit check above already guarantees it, so this is a
      // backstop that truncates nothing in practice.
      doc.text(piece, bodyLeft, cursor, {
        width: bodyWidth,
        lineGap: FINDINGS_BULLET_LINE_GAP,
        height: FINDINGS_BODY_BOTTOM - cursor,
      });
      cursor += pieceHeight + FINDINGS_BULLET_SPACING;
    }
  }
}

function fallbackReportFonts(): ReportFontSet {
  return {
    regular: "Helvetica",
    bold: "Helvetica-Bold",
  };
}

function resolveBrandFontPaths(): { regular: string; bold: string } | null {
  if (!existsSync(BRAND_FONT_REGULAR_PATH) || !existsSync(BRAND_FONT_BOLD_PATH)) {
    console.warn("[field-report-pdf] embedded Geist OTF assets are unavailable; using Helvetica fallback.");
    return null;
  }

  return {
    regular: BRAND_FONT_REGULAR_PATH,
    bold: BRAND_FONT_BOLD_PATH,
  };
}

function registerReportFonts(doc: PDFKit.PDFDocument): ReportFontSet {
  const fontPaths = resolveBrandFontPaths();
  if (!fontPaths) return fallbackReportFonts();

  try {
    doc.registerFont(BRAND_FONT_REGULAR_NAME, fontPaths.regular);
    doc.registerFont(BRAND_FONT_BOLD_NAME, fontPaths.bold);
    return {
      regular: BRAND_FONT_REGULAR_NAME,
      bold: BRAND_FONT_BOLD_NAME,
    };
  } catch (error) {
    console.warn("[field-report-pdf] failed to register embedded Geist OTF fonts with pdfkit; using Helvetica fallback.", error);
    return fallbackReportFonts();
  }
}

/**
 * How per-photo entries are laid out.
 * - `grid` (default): three photos per page with a compact side caption — the human photo-report look.
 * - `findings`: one photo per page with a subject caption and bulleted findings below — the AI condition
 *   assessment look. Callers that omit this keep byte-identical output to before the option existed.
 */
export type ReportPhotoLayout = "grid" | "findings";

export async function renderFieldPhotoReportPdf(input: {
  cover: ReportCoverData;
  sections: ReportRenderSection[];
  /** Optional free-form executive summary; rendered on its own page(s) right after the cover. */
  executiveSummary?: string | null;
  photoLayout?: ReportPhotoLayout;
  /**
   * Bounds every object read and transcode this render performs. The AI report's Phase D passes the run's
   * remaining budget; the human path omits it and is unbounded exactly as before.
   */
  signal?: AbortSignal;
}): Promise<Buffer> {
  const doc = new PDFDocument({
    autoFirstPage: true,
    bufferPages: true,
    size: [PAGE_WIDTH, PAGE_HEIGHT],
    // Zero page margins: this report positions EVERYTHING absolutely (PAGE_MARGIN is used as a layout
    // constant, not the doc margin). With a non-zero bottom margin, pdfkit's auto-page-break fired every
    // time the footer drew text near the page bottom — spawning a blank page per footer fragment (the
    // "blank pages at the end"). Pages are now created ONLY by explicit addPage() calls.
    margin: 0,
  });

  const chunks: Buffer[] = [];
  const pageMeta: PageMeta[] = [];
  const reportFonts = registerReportFonts(doc);
  doc.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));

  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill("white");
  doc.fillColor(BRAND_BLACK).font(reportFonts.bold).fontSize(18).text(input.cover.creatorName, PAGE_MARGIN, 222, {
    width: PAGE_WIDTH - PAGE_MARGIN * 2,
    align: "center",
  });
  doc.fillColor(BRAND_RED).font(reportFonts.bold).fontSize(16).text(input.cover.companyName, PAGE_MARGIN, 256, {
    width: PAGE_WIDTH - PAGE_MARGIN * 2,
    align: "center",
  });
  doc.font(reportFonts.bold).fontSize(15).fillColor(BRAND_BLACK).text(`${input.cover.reportDateLabel} | ${input.cover.photoCount} Photos`, PAGE_MARGIN, 288, {
    width: PAGE_WIDTH - PAGE_MARGIN * 2,
    align: "center",
  });
  doc.roundedRect(
    COVER_LOGO_PANEL_X,
    COVER_LOGO_PANEL_Y,
    COVER_LOGO_PANEL_WIDTH,
    COVER_LOGO_PANEL_HEIGHT,
    COVER_LOGO_PANEL_RADIUS
  ).fillColor(BRAND_LOGO_SURFACE).fill();
  try {
    doc.image(LOGO_BUFFER, COVER_LOGO_X, COVER_LOGO_Y, { fit: COVER_LOGO_FIT, align: "center", valign: "center" });
  } catch (error) {
    console.error("[field-report-pdf] failed to embed T Rock logo", error);
    doc.fillColor(BRAND_RED).font(reportFonts.bold).fontSize(30).text("T ROCK", PAGE_MARGIN, 380, {
      width: PAGE_WIDTH - PAGE_MARGIN * 2,
      align: "center",
    });
  }
  // Height-cap + ellipsis the cover title: the default title is `${project.name} Photo Report`, and a long
  // deal name (capped at 140 chars upstream, still ~8 lines at 30pt) would otherwise wrap past the page
  // bottom and spawn a blank cover-overflow page. Bounded to the band between the logo panel and footer.
  doc.fillColor(BRAND_BLACK).font(reportFonts.bold).fontSize(30).text(input.cover.reportTitle, PAGE_MARGIN, 588, {
    width: PAGE_WIDTH - PAGE_MARGIN * 2,
    align: "center",
    height: PAGE_HEIGHT - 588 - 52,
    ellipsis: true,
  });
  pageMeta.push({
    kind: "cover",
    footerLabel: "Cover Page",
    projectName: `${input.cover.projectName} - ${input.cover.reportTitle}`,
  });

  // Executive summary page(s) sit BETWEEN the cover and the section/photo pages. paginateTextByHeight
  // returns no pages for blank/whitespace-only input, so an empty summary adds nothing.
  if (input.executiveSummary) {
    drawExecutiveSummaryPages(
      doc,
      reportFonts,
      {
        summary: input.executiveSummary,
        reportTitle: input.cover.reportTitle,
        dateLabel: input.cover.reportDateLabel,
        projectName: input.cover.projectName,
      },
      pageMeta,
    );
  }

  // A full-page section divider only earns its place when there's MORE THAN ONE section to separate; a
  // single-section report goes straight from the cover to the photos (no near-blank divider page).
  const useSectionDividers = input.sections.length > 1;
  const photoLayout: ReportPhotoLayout = input.photoLayout ?? "grid";
  let sectionIndex = 0;
  for (const section of input.sections) {
    sectionIndex += 1;
    const pages = chunk(section.photos, PHOTOS_PER_PAGE);
    if (useSectionDividers) {
      doc.addPage();
      pageMeta.push({
        kind: "section",
        footerLabel: `Section ${sectionIndex}`,
        projectName: input.cover.projectName,
        reportTitle: input.cover.reportTitle,
        dateLabel: input.cover.reportDateLabel,
      });
      drawSectionTitlePage(doc, reportFonts, input.cover.reportTitle, input.cover.reportDateLabel, section.title);
    }

    // The findings layout gives every photo its own page, so it drives its own page/pageMeta loop rather
    // than the grid's PHOTOS_PER_PAGE chunking. It also skips the compact section title: that band
    // (y=50..63) would collide with the full-width image at y=62, and the executive summary already
    // introduces the findings.
    if (photoLayout === "findings") {
      for (const photo of section.photos) {
        await drawFindingsPhotoPages(
          doc,
          reportFonts,
          photo,
          {
            reportTitle: input.cover.reportTitle,
            dateLabel: input.cover.reportDateLabel,
            projectName: input.cover.projectName,
            footerLabel: `Section ${sectionIndex}`,
          },
          pageMeta,
          input.signal,
        );
      }
      continue;
    }

    // R1: a single-section report skips the full-page divider, so the user's custom section title would be
    // lost. Surface it once, compactly, on this section's first photo page (when it adds info beyond the
    // report title it would otherwise duplicate).
    const compactTitle = section.title?.trim();
    const showCompactTitle =
      !useSectionDividers && !!compactTitle && compactTitle !== input.cover.reportTitle.trim();

    for (const [pageIndex, photos] of pages.entries()) {
      doc.addPage();
      pageMeta.push({
        kind: "section",
        footerLabel: `Section ${sectionIndex}`,
        projectName: input.cover.projectName,
        reportTitle: input.cover.reportTitle,
        dateLabel: input.cover.reportDateLabel,
      });
      drawSectionHeader(doc, reportFonts, input.cover.reportTitle, input.cover.reportDateLabel);
      if (showCompactTitle && pageIndex === 0) {
        drawCompactSectionTitle(doc, reportFonts, compactTitle!);
      }
      // Cells fill left-to-right, then top-to-bottom, so the printed index order reads the way people scan.
      for (const [cellIndex, photo] of photos.entries()) {
        const column = cellIndex % PHOTO_COLUMNS;
        const row = Math.floor(cellIndex / PHOTO_COLUMNS);
        await drawPhotoEntry(
          doc,
          reportFonts,
          photo,
          PAGE_MARGIN + column * (COLUMN_WIDTH + COLUMN_GAP),
          PHOTO_ROWS_TOP + row * PHOTO_ROW_PITCH,
          input.cover.projectName,
          input.signal,
        );
      }
    }
  }

  const range = doc.bufferedPageRange();
  // Page accounting invariant. Footers are drawn by indexing pageMeta BY PAGE, and a page with no entry is
  // silently skipped — so a layout that calls addPage() without pushing its meta produces a document whose
  // footers are missing or, worse, shifted onto the wrong pages from that point on. That is invisible to a
  // page-count assertion, so it is checked here instead of hoped for. Logged rather than thrown: a footer
  // problem must not cost the user their report, but it must never pass a test run unnoticed.
  if (pageMeta.length !== range.count) {
    console.error("[field-report-pdf] page accounting desync — footers will be wrong", {
      pageMetaEntries: pageMeta.length,
      pages: range.count,
    });
  }
  for (let pageIndex = 0; pageIndex < range.count; pageIndex += 1) {
    doc.switchToPage(pageIndex);
    const meta = pageMeta[pageIndex];
    if (!meta) continue;
    drawFooter(doc, reportFonts, meta.footerLabel, pageIndex + 1, range.count, meta.projectName);
  }

  doc.end();

  return await new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}
