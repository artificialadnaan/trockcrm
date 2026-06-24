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
const BRAND_PANEL = "#F7F7F8";
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

async function drawPhotoEntry(
  doc: PDFKit.PDFDocument,
  fonts: ReportFontSet,
  photo: ReportRenderSection["photos"][number],
  top: number,
) {
  const left = PAGE_MARGIN;
  const width = PAGE_WIDTH - PAGE_MARGIN * 2;
  const rowHeight = 152;
  const imagePanelWidth = 288;
  const imageLeft = left;
  const imageTop = top;
  const imageWidth = 252;
  const imageHeight = 152;
  const textLeft = left + imagePanelWidth + 18;
  const textWidth = width - imagePanelWidth - 18;

  doc.roundedRect(imageLeft, imageTop, imagePanelWidth, rowHeight, 8).fillColor(BRAND_PANEL).fill();
  doc.roundedRect(imageLeft + 8, imageTop + 8, 32, 32, 6).fillColor("white").fill();
  doc.fillColor(BRAND_BLACK).font(fonts.bold).fontSize(11).text(String(photo.reportIndex), imageLeft + 8, imageTop + 16, {
    width: 32,
    align: "center",
  });

  const imageBuffer = await loadPhotoBuffer(photo);
  if (imageBuffer) {
    try {
      doc.image(imageBuffer, imageLeft + 84, imageTop, {
        fit: [imageWidth, imageHeight],
        align: "center",
        valign: "center",
      });
    } catch {
      doc.roundedRect(imageLeft + 84, imageTop, imageWidth, imageHeight, 8).fillColor("#F3F4F6").fill();
      doc.fillColor(BRAND_MUTED).font(fonts.bold).fontSize(12).text("Image unavailable", imageLeft + 116, imageTop + 68, { width: imageWidth - 64, align: "center" });
    }
  } else {
    doc.roundedRect(imageLeft + 84, imageTop, imageWidth, imageHeight, 8).fillColor("#F3F4F6").fill();
    doc.fillColor(BRAND_MUTED).font(fonts.bold).fontSize(12).text("Image unavailable", imageLeft + 116, imageTop + 68, { width: imageWidth - 64, align: "center" });
  }

  const description = clampText(photo.descriptionOverride ?? photo.description ?? "No description", 320);
  doc.fillColor(BRAND_BLACK).font(fonts.regular).fontSize(15).text(description, textLeft, top + 4, {
    width: textWidth,
    lineGap: 2,
  });
  doc.fillColor(BRAND_MUTED).font(fonts.regular).fontSize(10).text(
    `Project: ${photo.projectName}\nDate: ${formatPhotoDate(photo.takenAt, photo.createdAt)}\nCreator: ${photo.uploaderName}`,
    textLeft,
    top + 92,
    { width: textWidth, align: "left", lineGap: 2 }
  );
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
  doc.fillColor(BRAND_BLACK).font(reportFonts.bold).fontSize(30).text(input.cover.reportTitle, PAGE_MARGIN, 588, {
    width: PAGE_WIDTH - PAGE_MARGIN * 2,
    align: "center",
  });
  pageMeta.push({
    kind: "cover",
    footerLabel: "Cover Page",
    projectName: `${input.cover.projectName} - ${input.cover.reportTitle}`,
  });

  // A full-page section divider only earns its place when there's MORE THAN ONE section to separate; a
  // single-section report goes straight from the cover to the photos (no near-blank divider page).
  const useSectionDividers = input.sections.length > 1;
  let sectionIndex = 0;
  for (const section of input.sections) {
    sectionIndex += 1;
    const pages = chunk(section.photos, 4);
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
      const startTop = 66;
      for (const [rowIndex, photo] of photos.entries()) {
        await drawPhotoEntry(doc, reportFonts, photo, startTop + rowIndex * 178);
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
