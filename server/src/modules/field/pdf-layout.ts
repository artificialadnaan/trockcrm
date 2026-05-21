import PDFDocument from "pdfkit";
import { createRequire } from "node:module";
import { getObjectBuffer, isR2Configured } from "../../lib/r2-client.js";
import { TROCK_LOGO_PNG_BASE64 } from "./pdf-logo.js";

const require = createRequire(import.meta.url);

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
const BRAND_FONT_NAME = "Geist Variable";
const BRAND_FONT_FILE = "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2";
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
  doc.text(label, PAGE_MARGIN, footerY, { width: 140, align: "left", lineBreak: false });
  doc.text(`${currentPage} / ${totalPages}`, PAGE_MARGIN, footerY, { width: PAGE_WIDTH - PAGE_MARGIN * 2, align: "center", lineBreak: false });
  doc.text(projectName, PAGE_WIDTH - PAGE_MARGIN - 200, footerY, { width: 200, align: "right", lineBreak: false });
  doc.restore();
}

function drawSectionHeader(doc: PDFKit.PDFDocument, fonts: ReportFontSet, reportTitle: string, dateLabel: string) {
  doc.save();
  doc.font(fonts.regular).fontSize(11).fillColor(BRAND_MUTED);
  doc.text(reportTitle, PAGE_MARGIN, 24, { width: PAGE_WIDTH / 2 - PAGE_MARGIN });
  doc.font(fonts.regular).fontSize(10).fillColor(BRAND_MUTED);
  doc.text(dateLabel, PAGE_WIDTH / 2, 24, { width: PAGE_WIDTH / 2 - PAGE_MARGIN, align: "right" });
  doc.moveTo(PAGE_MARGIN, 44).lineTo(PAGE_WIDTH - PAGE_MARGIN, 44).strokeColor(BRAND_BORDER).lineWidth(1).stroke();
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

function resolveBrandFontPath(): string | null {
  try {
    return require.resolve(BRAND_FONT_FILE);
  } catch (error) {
    console.warn("[field-report-pdf] Geist Variable font asset could not be resolved; using Helvetica fallback.", error);
    return null;
  }
}

function registerReportFonts(doc: PDFKit.PDFDocument): ReportFontSet {
  const fontPath = resolveBrandFontPath();
  if (!fontPath) return fallbackReportFonts();

  if (fontPath.endsWith(".woff2")) {
    return fallbackReportFonts();
  }

  try {
    doc.registerFont(BRAND_FONT_NAME, fontPath);
    return {
      regular: BRAND_FONT_NAME,
      bold: BRAND_FONT_NAME,
    };
  } catch (error) {
    console.warn("[field-report-pdf] failed to register Geist Variable font with pdfkit; using Helvetica fallback.", error);
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
    margin: PAGE_MARGIN,
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
    doc.fillColor(BRAND_RED).font("Helvetica-Bold").fontSize(30).text("T ROCK", PAGE_MARGIN, 380, {
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

  let sectionIndex = 0;
  for (const section of input.sections) {
    sectionIndex += 1;
    const pages = chunk(section.photos, 4);
    doc.addPage();
    pageMeta.push({
      kind: "section",
      footerLabel: `Section ${sectionIndex}`,
      projectName: input.cover.projectName,
      reportTitle: input.cover.reportTitle,
      dateLabel: input.cover.reportDateLabel,
    });
    drawSectionTitlePage(doc, reportFonts, input.cover.reportTitle, input.cover.reportDateLabel, section.title);

    for (const photos of pages) {
      doc.addPage();
      pageMeta.push({
        kind: "section",
        footerLabel: `Section ${sectionIndex}`,
        projectName: input.cover.projectName,
        reportTitle: input.cover.reportTitle,
        dateLabel: input.cover.reportDateLabel,
      });
      drawSectionHeader(doc, reportFonts, input.cover.reportTitle, input.cover.reportDateLabel);
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
