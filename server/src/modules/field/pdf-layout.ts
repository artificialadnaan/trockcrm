import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { getObjectBuffer, isR2Configured } from "../../lib/r2-client.js";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const PAGE_MARGIN = 32;
const BRAND_RED = "#DC2626";
const BRAND_BLACK = "#111111";
const BRAND_MUTED = "#7589A3";
const BRAND_BORDER = "#EAECEF";
const BRAND_PANEL = "#F7F7F8";
const LOGO_PATH_CANDIDATES = [
  path.resolve(process.cwd(), "client/public/logo.png"),
  path.resolve(process.cwd(), "client-field/public/logo.png"),
  fileURLToPath(new URL("../../../../client/public/logo.png", import.meta.url)),
  fileURLToPath(new URL("../../../../client-field/public/logo.png", import.meta.url)),
];

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

async function loadLogoBuffer(): Promise<Buffer | null> {
  for (const logoPath of LOGO_PATH_CANDIDATES) {
    try {
      return await fs.readFile(logoPath);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
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

function drawFooter(doc: PDFKit.PDFDocument, label: string, currentPage: number, totalPages: number, projectName: string) {
  const footerY = PAGE_HEIGHT - 44;
  doc.save();
  doc.font("Helvetica").fontSize(10).fillColor(BRAND_MUTED);
  doc.text(label, PAGE_MARGIN, footerY, { width: 140, align: "left", lineBreak: false });
  doc.text(`${currentPage} / ${totalPages}`, PAGE_MARGIN, footerY, { width: PAGE_WIDTH - PAGE_MARGIN * 2, align: "center", lineBreak: false });
  doc.text(projectName, PAGE_WIDTH - PAGE_MARGIN - 200, footerY, { width: 200, align: "right", lineBreak: false });
  doc.restore();
}

function drawSectionHeader(doc: PDFKit.PDFDocument, reportTitle: string, dateLabel: string) {
  doc.save();
  doc.font("Helvetica").fontSize(11).fillColor(BRAND_MUTED);
  doc.text(reportTitle, PAGE_MARGIN, 24, { width: PAGE_WIDTH / 2 - PAGE_MARGIN });
  doc.font("Helvetica").fontSize(10).fillColor(BRAND_MUTED);
  doc.text(dateLabel, PAGE_WIDTH / 2, 24, { width: PAGE_WIDTH / 2 - PAGE_MARGIN, align: "right" });
  doc.moveTo(PAGE_MARGIN, 44).lineTo(PAGE_WIDTH - PAGE_MARGIN, 44).strokeColor(BRAND_BORDER).lineWidth(1).stroke();
  doc.restore();
}

function drawSectionTitlePage(doc: PDFKit.PDFDocument, reportTitle: string, dateLabel: string, sectionTitle: string) {
  drawSectionHeader(doc, reportTitle, dateLabel);
  doc.save();
  doc.fillColor(BRAND_BLACK).font("Helvetica-Bold").fontSize(26);
  doc.text(sectionTitle, PAGE_MARGIN, PAGE_HEIGHT / 2 - 22, {
    width: PAGE_WIDTH - PAGE_MARGIN * 2,
    align: "center",
  });
  doc.restore();
}

async function drawPhotoEntry(
  doc: PDFKit.PDFDocument,
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
  doc.fillColor(BRAND_BLACK).font("Helvetica-Bold").fontSize(11).text(String(photo.reportIndex), imageLeft + 8, imageTop + 16, {
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
      doc.fillColor(BRAND_MUTED).font("Helvetica-Bold").fontSize(12).text("Image unavailable", imageLeft + 116, imageTop + 68, { width: imageWidth - 64, align: "center" });
    }
  } else {
    doc.roundedRect(imageLeft + 84, imageTop, imageWidth, imageHeight, 8).fillColor("#F3F4F6").fill();
    doc.fillColor(BRAND_MUTED).font("Helvetica-Bold").fontSize(12).text("Image unavailable", imageLeft + 116, imageTop + 68, { width: imageWidth - 64, align: "center" });
  }

  const description = clampText(photo.descriptionOverride ?? photo.description ?? "No description", 320);
  doc.fillColor(BRAND_BLACK).font("Helvetica").fontSize(15).text(description, textLeft, top + 4, {
    width: textWidth,
    lineGap: 2,
  });
  doc.fillColor(BRAND_MUTED).font("Helvetica").fontSize(10).text(
    `Project: ${photo.projectName}\nDate: ${formatPhotoDate(photo.takenAt, photo.createdAt)}\nCreator: ${photo.uploaderName}`,
    textLeft,
    top + 92,
    { width: textWidth, align: "left", lineGap: 2 }
  );
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
  doc.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));

  const logoBuffer = await loadLogoBuffer();

  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill("white");
  doc.fillColor(BRAND_BLACK).font("Helvetica-Bold").fontSize(18).text(input.cover.creatorName, PAGE_MARGIN, 222, {
    width: PAGE_WIDTH - PAGE_MARGIN * 2,
    align: "center",
  });
  doc.fillColor(BRAND_RED).font("Helvetica-Bold").fontSize(16).text(input.cover.companyName, PAGE_MARGIN, 256, {
    width: PAGE_WIDTH - PAGE_MARGIN * 2,
    align: "center",
  });
  doc.font("Helvetica-Bold").fontSize(15).fillColor(BRAND_BLACK).text(`${input.cover.reportDateLabel} | ${input.cover.photoCount} Photos`, PAGE_MARGIN, 288, {
    width: PAGE_WIDTH - PAGE_MARGIN * 2,
    align: "center",
  });
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, PAGE_WIDTH / 2 - 186, 330, { fit: [372, 210], align: "center", valign: "center" });
    } catch {
      doc.fillColor(BRAND_RED).font("Helvetica-Bold").fontSize(30).text("T ROCK", PAGE_MARGIN, 380, {
        width: PAGE_WIDTH - PAGE_MARGIN * 2,
        align: "center",
      });
    }
  } else {
    doc.fillColor(BRAND_RED).font("Helvetica-Bold").fontSize(30).text("T ROCK", PAGE_MARGIN, 380, {
      width: PAGE_WIDTH - PAGE_MARGIN * 2,
      align: "center",
    });
  }
  doc.fillColor(BRAND_BLACK).font("Helvetica-Bold").fontSize(30).text(input.cover.reportTitle, PAGE_MARGIN, 540, {
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
    drawSectionTitlePage(doc, input.cover.reportTitle, input.cover.reportDateLabel, section.title);

    for (const photos of pages) {
      doc.addPage();
      pageMeta.push({
        kind: "section",
        footerLabel: `Section ${sectionIndex}`,
        projectName: input.cover.projectName,
        reportTitle: input.cover.reportTitle,
        dateLabel: input.cover.reportDateLabel,
      });
      drawSectionHeader(doc, input.cover.reportTitle, input.cover.reportDateLabel);
      const startTop = 66;
      for (const [rowIndex, photo] of photos.entries()) {
        await drawPhotoEntry(doc, photo, startTop + rowIndex * 178);
      }
    }
  }

  const range = doc.bufferedPageRange();
  for (let pageIndex = 0; pageIndex < range.count; pageIndex += 1) {
    doc.switchToPage(pageIndex);
    const meta = pageMeta[pageIndex];
    if (!meta) continue;
    drawFooter(doc, meta.footerLabel, pageIndex + 1, range.count, meta.projectName);
  }

  doc.end();

  return await new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}
