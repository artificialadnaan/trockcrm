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

// --- Photo grid layout (image-forward) -----------------------------------------------------------
// Photo reports are image-first: each row is ONE large, tightly framed photo with a compact caption
// beside it. PHOTOS_PER_PAGE drives both the chunking and the per-row height — fewer per page means
// taller rows and bigger images. The image is fit to its exact rendered rectangle (decoded via
// openImage) and framed tightly, so off-aspect photos sit on clean page-white instead of an oversized
// gray panel — that dead gray gutter was the bulk of the "small image + lots of white space" problem.
const PHOTOS_PER_PAGE = 3;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const PHOTO_ROWS_TOP = 66;
const PHOTO_ROWS_BOTTOM = 740; // stay clear of the footer (drawn at PAGE_HEIGHT - 44)
const PHOTO_ROW_GAP = 16;
const PHOTO_ROW_PITCH = (PHOTO_ROWS_BOTTOM - PHOTO_ROWS_TOP) / PHOTOS_PER_PAGE;
const PHOTO_ROW_HEIGHT = PHOTO_ROW_PITCH - PHOTO_ROW_GAP;
const CAPTION_WIDTH = 174;
const CAPTION_GAP = 22;
const IMAGE_BOX_WIDTH = CONTENT_WIDTH - CAPTION_WIDTH - CAPTION_GAP;
const CAPTION_LEFT = PAGE_MARGIN + IMAGE_BOX_WIDTH + CAPTION_GAP;
// Metadata is drawn as three single-line, ellipsised rows (Project/Date/Creator). Each line is capped to
// one line so a long deal/project name (the deal schema allows up to 500 chars) can never wrap and push the
// block past the footer / page bottom — the exact blank-page/overlap regression the report layout avoids.
const META_FONT_SIZE = 8.5;
const META_LINE_PITCH = 11;
const META_BLOCK_HEIGHT = META_LINE_PITCH * 3;

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
 * Split free-form text into page-sized chunks. `measure(chunk)` returns the rendered height of that
 * chunk at the body column width; words are packed greedily until the next word would exceed
 * `maxHeight`, then a new page starts. A single word taller than the budget still gets its own page so
 * pagination always makes forward progress. Explicit newlines (paragraph breaks) are preserved.
 * Exported for unit testing (the height measurer is injected so it needs no live PDFDocument).
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
  for (const token of tokens) {
    if (current.length === 0) {
      current.push(token);
      continue;
    }
    if (measure(render([...current, token])) > maxHeight) {
      pages.push(render(current));
      current = token === "\n" ? [] : [token];
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
  doc.fillColor(BRAND_BLACK).font(fonts.bold).fontSize(11);
  doc.text(title, PAGE_MARGIN, 50, {
    width: PAGE_WIDTH - PAGE_MARGIN * 2,
    align: "center",
    lineBreak: false,
    height: 13,
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
    doc.text(pageText, PAGE_MARGIN, bodyTop, { width: CONTENT_WIDTH, lineGap: SUMMARY_LINE_GAP });
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
  top: number,
) {
  const imageLeft = PAGE_MARGIN;
  const boxWidth = IMAGE_BOX_WIDTH;
  const boxHeight = PHOTO_ROW_HEIGHT;

  const imageBuffer = await loadPhotoBuffer(photo);
  const opened = imageBuffer ? openImageForLayout(doc, imageBuffer) : null;
  if (opened) {
    // Scale to fit the box while preserving aspect, then draw + frame the EXACT rendered rectangle so a
    // portrait or panoramic photo is bounded by a tight border on page-white — no oversized gray panel.
    const scale = Math.min(boxWidth / opened.displayWidth, boxHeight / opened.displayHeight);
    const drawWidth = opened.displayWidth * scale;
    const drawHeight = opened.displayHeight * scale;
    try {
      doc.image(opened.image as unknown as Buffer, imageLeft, top, { width: drawWidth, height: drawHeight });
      doc.roundedRect(imageLeft, top, drawWidth, drawHeight, 6).lineWidth(1).strokeColor(BRAND_BORDER).stroke();
      drawIndexBadge(doc, fonts, imageLeft, top, photo.reportIndex);
    } catch {
      drawImageUnavailable(doc, fonts, imageLeft, top, boxWidth, boxHeight);
      drawIndexBadge(doc, fonts, imageLeft, top, photo.reportIndex);
    }
  } else {
    drawImageUnavailable(doc, fonts, imageLeft, top, boxWidth, boxHeight);
    drawIndexBadge(doc, fonts, imageLeft, top, photo.reportIndex);
  }

  // Compact, image-forward caption: smaller fonts, metadata flows directly under the (measured)
  // description instead of a fixed offset, and the whole block is clamped to the row so it never spills.
  // The description is height-capped + ellipsised so even a pathological caption (or a denser
  // PHOTOS_PER_PAGE) can't push text past the page bottom and spawn the blank pages this report avoids.
  const description = clampText(photo.descriptionOverride ?? photo.description ?? "No description", 320);
  const descriptionMaxHeight = boxHeight - 40;
  doc.fillColor(BRAND_BLACK).font(fonts.bold).fontSize(12);
  doc.text(description, CAPTION_LEFT, top, { width: CAPTION_WIDTH, lineGap: 1.5, height: descriptionMaxHeight, ellipsis: true });
  const descriptionHeight = Math.min(
    doc.heightOfString(description, { width: CAPTION_WIDTH, lineGap: 1.5 }),
    descriptionMaxHeight,
  );
  const metaTop = Math.min(top + descriptionHeight + 10, top + boxHeight - META_BLOCK_HEIGHT);
  // One line each, no-wrap + ellipsis + capped height: a long project/creator name truncates instead of
  // wrapping, so the block stays exactly 3 lines tall and can't spill the page or collide with the footer.
  // Every field is still rendered (Project, Date, Creator) — only an over-long single value is shortened,
  // and the full project name still appears on the cover and in the footer.
  const metaLines = [
    `Project: ${photo.projectName}`,
    `Date: ${formatPhotoDate(photo.takenAt, photo.createdAt)}`,
    `Creator: ${photo.uploaderName}`,
  ];
  doc.fillColor(BRAND_MUTED).font(fonts.regular).fontSize(META_FONT_SIZE);
  metaLines.forEach((line, index) => {
    doc.text(line, CAPTION_LEFT, metaTop + index * META_LINE_PITCH, {
      width: CAPTION_WIDTH,
      align: "left",
      lineBreak: false,
      height: META_LINE_PITCH,
      ellipsis: true,
    });
  });
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
      for (const [rowIndex, photo] of photos.entries()) {
        await drawPhotoEntry(doc, reportFonts, photo, PHOTO_ROWS_TOP + rowIndex * PHOTO_ROW_PITCH);
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
