import PDFDocument from "pdfkit";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getObjectBuffer, isR2Configured } from "../../lib/r2-client.js";
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
// The page is a grid of identical CELLS, each one a photo tile with its caption and metadata beside it.
// PHOTO_COLUMNS x PHOTO_ROWS_PER_PAGE drives the chunking, the cell pitch and the tile size together, so
// changing either re-flows the whole sheet consistently.
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
/**
 * TWO photo cells per row, four rows down: eight photographs a page rather than four.
 *
 * The one-up grid this replaces spent roughly half the page width on a caption column holding three short
 * lines, so a 22-photo report ran to six pages of half-empty sheets — "long" was the first thing anyone said
 * about it. Pairing the cells reclaims that gutter and halves the page count.
 */
const PHOTO_COLUMNS = 2;
const PHOTO_ROWS_PER_PAGE = 4;
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
 */
const PHOTO_TILE_HEIGHT = PHOTO_ROW_PITCH - PHOTO_ROW_GAP;
/**
 * A very slightly PORTRAIT tile, and deliberately not the full column width.
 *
 * At eight cells a page no photograph can be large, so the question is only whether the space each one gets
 * is spent evenly. A wide tile flatters landscapes and ruins portraits: against the 19.5:9 frames the app
 * currently captures, a full-width tile filled 82% for a landscape and 26% for a portrait — the portrait
 * pages were the ones that read as broken. A near-square tile gives both orientations the same footprint,
 * and when the capture fix lands and photographs arrive as 4:3/3:4 it fills roughly three quarters either
 * way. The leftover column width is what the metadata gets.
 */
const PHOTO_TILE_WIDTH = 148;
const PHOTO_TILE_RADIUS = 8;
const PHOTO_TILE_FILL = "#F4F5F7";
const PHOTO_ROW_HEIGHT = PHOTO_TILE_HEIGHT;
// Metadata is drawn as single-line, ellipsised rows. Each is capped to ONE line so a long deal/project name
// (the deal schema allows up to 500 chars) can never wrap and push the block past the cell below it — the
// blank-page/overlap regression the report layout exists to avoid. Smaller than the one-up grid's 8.5pt
// because the cell column is now ~106pt rather than ~264pt.
const META_FONT_SIZE = 7.5;
const META_LINE_PITCH = 10;
// Caption + metadata sit to the RIGHT of the tile inside the same cell, BOTTOM-aligned to it, so the last
// line always lands on the tile's bottom edge no matter how tall the photograph rendered.
const CAPTION_GAP = 10;
const CAPTION_WIDTH = COLUMN_WIDTH - PHOTO_TILE_WIDTH - CAPTION_GAP;
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
 * The photo-grid date. "Jul 31, 4:52 PM" rather than "July 31, 2026, 4:52 PM".
 *
 * The cell's metadata column is ~106pt wide, and the long form overruns it and ellipsises mid-timestamp —
 * a truncated time is worse than a short one. The YEAR is dropped rather than the month or time: it is on
 * the cover, in every page header and in the footer, and a photo report spanning a year boundary would
 * still be unambiguous from those. A photograph that genuinely belongs to another project still names it on
 * its own line below.
 */
function formatPhotoDateCompact(value: string | null, fallback: string): string {
  const date = new Date(value ?? fallback);
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

async function fetchExternalImageBuffer(url: string): Promise<Buffer | null> {
  if (!url.startsWith("data:image/")) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
}

async function loadPhotoBuffer(photo: ReportRenderablePhoto): Promise<Buffer | null> {
  if (photo.r2Key && isR2Configured()) {
    try {
      const { buffer } = await getObjectBuffer(photo.r2Key);
      return buffer;
    } catch {
      return null;
    }
  }
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
): { image: OpenedImage; displayWidth: number; displayHeight: number } | null {
  try {
    const image = (doc as unknown as { openImage(src: Buffer): OpenedImage }).openImage(buffer);
    if (!image || !(image.width > 0) || !(image.height > 0)) return null;
    const rotated = (image.orientation ?? 1) > 4;
    return {
      image,
      displayWidth: rotated ? image.height : image.width,
      displayHeight: rotated ? image.width : image.height,
    };
  } catch {
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


async function drawPhotoEntry(
  doc: PDFKit.PDFDocument,
  fonts: ReportFontSet,
  photo: ReportRenderSection["photos"][number],
  left: number,
  top: number,
  coverProjectName: string,
) {
  const boxWidth = IMAGE_BOX_WIDTH;
  const boxHeight = IMAGE_BOX_HEIGHT;

  // The tile is drawn FIRST and always, whether or not the photo loads. It is what gives every cell an
  // identical footprint; the image is a guest inside it.
  doc.roundedRect(left, top, boxWidth, boxHeight, PHOTO_TILE_RADIUS).fillColor(PHOTO_TILE_FILL).fill();

  const imageBuffer = await loadPhotoBuffer(photo);
  const opened = imageBuffer ? openImageForLayout(doc, imageBuffer) : null;
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

  // --- Caption + metadata, to the right of the tile and BOTTOM-aligned to it ------------------------
  // Bottom-aligned rather than top-aligned, so the last line always lands on the tile's bottom edge.
  //
  // The "Project:"/"Date:"/"Creator:" labels are GONE. In a ~106pt cell column they would have eaten 40% of
  // the width to restate what the values obviously are, and the project name they introduced is already the
  // page header, the footer and the cover title. It is printed here ONLY when a photograph actually belongs
  // to some other project than the report's — the case where it is information rather than furniture.
  const captionLeft = left + PHOTO_TILE_WIDTH + CAPTION_GAP;
  const metaLines = [formatPhotoDateCompact(photo.takenAt, photo.createdAt), photo.uploaderName];
  if (photo.projectName.trim() && photo.projectName.trim() !== coverProjectName.trim()) {
    metaLines.push(photo.projectName);
  }
  const metaTop = top + boxHeight - metaLines.length * META_LINE_PITCH;
  metaLines.forEach((value, index) => {
    doc.fillColor(BRAND_MUTED).font(fonts.regular).fontSize(META_FONT_SIZE);
    // One line each, ellipsised, so a 500-char project name truncates instead of wrapping into the cell
    // below it.
    doc.text(value, captionLeft, metaTop + index * META_LINE_PITCH, {
      width: CAPTION_WIDTH,
      align: "left",
      lineBreak: false,
      height: META_LINE_PITCH,
      ellipsis: true,
    });
  });

  // The crew's caption sits DIRECTLY above the metadata, as one bottom-anchored group. Pinning it to the
  // top of the tile instead left ~100pt of dead air between the caption and the data describing that same
  // photograph. Only drawn when there is one: an absent caption leaves clean space rather than the words
  // "No description".
  const description = clampText(photo.descriptionOverride ?? photo.description ?? "", 200);
  if (description) {
    doc.fillColor(BRAND_BLACK).font(fonts.regular).fontSize(8);
    const available = metaTop - top - 6;
    const measured = doc.heightOfString(description, { width: CAPTION_WIDTH, lineGap: 1.5 });
    const descriptionHeight = Math.min(measured, available);
    doc.text(description, captionLeft, metaTop - 6 - descriptionHeight, {
      width: CAPTION_WIDTH,
      lineGap: 1.5,
      height: descriptionHeight,
      ellipsis: true,
    });
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

export async function renderFieldPhotoReportPdf(input: {
  cover: ReportCoverData;
  sections: ReportRenderSection[];
  /** Optional free-form executive summary; rendered on its own page(s) right after the cover. */
  executiveSummary?: string | null;
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
        );
      }
    }
  }

  const range = doc.bufferedPageRange();
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
