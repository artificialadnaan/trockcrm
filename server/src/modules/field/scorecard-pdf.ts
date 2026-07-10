import PDFDocument from "pdfkit";
import {
  FIELD_SCORECARD_SECTIONS,
  FIELD_SCORECARD_V2_SECTIONS,
  FIELD_SCORECARD_CRITICAL_DEFICIENCIES,
  FIELD_SCORECARD_V2_CRITICAL_DEFICIENCIES,
  scorecardRatingLabel,
  scorecardV2RatingLabel,
  type ScorecardRating,
  type ScorecardFormVersion,
} from "@trock-crm/shared/types";
import { TROCK_LOGO_PNG_BASE64 } from "./pdf-logo.js";

// Self-contained scoring-form PDF: Helvetica (pdfkit built-in — zero font-asset bundling risk) + the brand
// logo + a flowing layout that page-breaks naturally. This is the INTERNAL weekly form, distinct from the
// client-facing photo report (which uses the branded Geist fonts + absolute grid in pdf-layout.ts).
const BRAND_RED = "#DC2626";
const BRAND_BLACK = "#111111";
const BRAND_MUTED = "#64748B";
const BRAND_BORDER = "#E2E8F0";
const LOGO_BUFFER = Buffer.from(TROCK_LOGO_PNG_BASE64, "base64");
const PAGE = { width: 612, height: 792, margin: 48 };
const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2;
const EVIDENCE_IMAGE_WIDTH = 238;
const EVIDENCE_IMAGE_HEIGHT = 188;
const EVIDENCE_ROW_HEIGHT = 290;

const RATING_COLOR: Record<ScorecardRating, string> = {
  elite: "#16A34A",
  on_standard: "#2563EB",
  needs_improvement: "#D97706",
  corrective_action: BRAND_RED,
};

export interface ScorecardPdfInput {
  dealName: string;
  projectNumber: string | null;
  weekOf: string;
  superintendentName: string | null;
  pmName: string | null;
  submittedByName: string | null;
  submittedAt: string; // ISO
  totalScore: number;
  formVersion?: ScorecardFormVersion;
  averageScore?: number | null;
  superintendentSignature?: string | null;
  pmSignature?: string | null;
  rating: ScorecardRating;
  items: { sectionKey: string; points: number; note: string | null }[];
  criticalDeficiencyKeys: string[];
  criticalDeficiencyNotes?: Record<string, string>;
  actionItems: string[];
  photos?: ScorecardPdfPhoto[];
}

export interface ScorecardPdfPhoto {
  sectionKey: string;
  deficiencyKey: string | null;
  caption: string | null;
  image: Buffer | null;
}

export interface ScorecardPdfSection {
  title: string;
  points: number;
  maxPoints: number;
  note: string | null;
  photos: ScorecardPdfPhoto[];
}

export interface ScorecardPdfDeficiency {
  key: string;
  label: string;
  note: string | null;
  photos: ScorecardPdfPhoto[];
}

export interface ScorecardPdfData {
  dealName: string;
  projectNumber: string | null;
  weekOf: string;
  superintendentName: string | null;
  pmName: string | null;
  submittedByName: string | null;
  submittedAt: string;
  totalScore: number;
  formVersion: ScorecardFormVersion;
  averageScore: number | null;
  superintendentSignature: string | null;
  pmSignature: string | null;
  rating: ScorecardRating;
  ratingLabel: string;
  sections: ScorecardPdfSection[];
  deficiencies: ScorecardPdfDeficiency[];
  actionItems: string[];
}

/**
 * Resolve a raw scorecard into a fully-labelled render model: sections in canonical form order (title +
 * maxPoints from the shared spec), critical-deficiency keys mapped to their human labels (unknown keys
 * dropped defensively), and the rating band label. Pure (no I/O) so it's unit-testable and the renderer
 * stays a dumb drawer.
 */
export function buildScorecardPdfData(input: ScorecardPdfInput): ScorecardPdfData {
  const itemByKey = new Map(input.items.map((it) => [it.sectionKey, it]));
  const photos = input.photos ?? [];
  const formVersion: ScorecardFormVersion = input.formVersion === 2 ? 2 : 1;
  const definitions = formVersion === 2 ? FIELD_SCORECARD_V2_SECTIONS : FIELD_SCORECARD_SECTIONS;
  const sections: ScorecardPdfSection[] = definitions.map((def) => {
    const item = itemByKey.get(def.key);
    return {
      title: def.title,
      points: item?.points ?? 0,
      maxPoints: "maxPoints" in def && typeof def.maxPoints === "number" ? def.maxPoints : 10,
      note: item?.note?.trim() ? item.note.trim() : null,
      photos: photos.filter((photo) => photo.sectionKey === def.key),
    };
  });
  const labelByKey = new Map<string, string>((formVersion === 2 ? FIELD_SCORECARD_V2_CRITICAL_DEFICIENCIES : FIELD_SCORECARD_CRITICAL_DEFICIENCIES).map((d) => [d.key, d.label]));
  const deficiencies = input.criticalDeficiencyKeys
    .map((key) => {
      const label = labelByKey.get(key);
      if (!label) return null;
      const note = input.criticalDeficiencyNotes?.[key]?.trim() || null;
      return {
        key,
        label,
        note,
        photos: photos.filter((photo) => photo.sectionKey === "critical_deficiency" && photo.deficiencyKey === key),
      };
    })
    .filter((deficiency): deficiency is ScorecardPdfDeficiency => deficiency !== null);
  const actionItems = input.actionItems.map((s) => s.trim()).filter((s) => s.length > 0);
  return {
    dealName: input.dealName,
    projectNumber: input.projectNumber,
    weekOf: input.weekOf,
    superintendentName: input.superintendentName,
    pmName: input.pmName,
    submittedByName: input.submittedByName,
    submittedAt: input.submittedAt,
    totalScore: input.totalScore,
    formVersion,
    averageScore: input.averageScore ?? null,
    superintendentSignature: input.superintendentSignature ?? null,
    pmSignature: input.pmSignature ?? null,
    rating: input.rating,
    ratingLabel: formVersion === 2 ? scorecardV2RatingLabel(input.rating) : scorecardRatingLabel(input.rating),
    sections,
    deficiencies,
    actionItems,
  };
}

/** Render the scoring-form PDF to a Buffer. No external I/O — deterministic over its input. */
export async function renderFieldScorecardPdf(data: ScorecardPdfData): Promise<Buffer> {
  const doc = new PDFDocument({ size: [PAGE.width, PAGE.height], margin: PAGE.margin, bufferPages: true, autoFirstPage: true });
  const chunks: Buffer[] = [];
  doc.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));

  // ── Header: logo + wordmark + title ──
  const top = PAGE.margin;
  try {
    doc.image(LOGO_BUFFER, PAGE.margin, top, { fit: [40, 40] });
  } catch {
    /* logo is decorative — a decode failure must not break the render */
  }
  doc.fillColor(BRAND_RED).font("Helvetica-Bold").fontSize(11).text("T ROCK CONSTRUCTION", PAGE.margin + 52, top + 2);
  doc.fillColor(BRAND_BLACK).font("Helvetica-Bold").fontSize(20).text("Field Scorecard", PAGE.margin + 52, top + 16);
  const ruleY = top + 48;
  doc.moveTo(PAGE.margin, ruleY).lineTo(PAGE.width - PAGE.margin, ruleY).lineWidth(2).strokeColor(BRAND_RED).stroke();
  doc.y = ruleY + 14;

  // ── Header meta ──
  const meta: [string, string][] = [
    ["Project", data.dealName],
    ["Project number", data.projectNumber ?? "—"],
    ["Week of", data.weekOf],
    ["Superintendent", data.superintendentName ?? "—"],
    ["Project manager", data.pmName ?? "—"],
    ["Submitted", `${data.submittedByName ?? "—"} · ${formatDate(data.submittedAt)}`],
  ];
  for (const [label, value] of meta) {
    const rowY = doc.y;
    doc.font("Helvetica").fontSize(10).fillColor(BRAND_MUTED).text(label, PAGE.margin, rowY, { width: 130 });
    doc.font("Helvetica-Bold").fontSize(10).fillColor(BRAND_BLACK).text(value, PAGE.margin + 130, rowY, { width: CONTENT_WIDTH - 130 });
    doc.moveDown(0.35);
  }
  doc.moveDown(0.5);

  // ── Score banner ──
  const bannerY = doc.y;
  const bannerH = 50;
  doc.roundedRect(PAGE.margin, bannerY, CONTENT_WIDTH, bannerH, 8).fillColor("#F8FAFC").fill();
  const scoreText = data.formVersion === 2
    ? (data.averageScore ?? data.totalScore / 10).toFixed(1) + " / 10"
    : String(data.totalScore) + " / 100";
  doc.font("Helvetica-Bold").fontSize(24).fillColor(BRAND_BLACK).text(scoreText, PAGE.margin + 16, bannerY + 14, { width: 220 });
  doc.font("Helvetica-Bold").fontSize(13).fillColor(RATING_COLOR[data.rating]).text(data.ratingLabel, PAGE.margin + 220, bannerY + 18, { width: CONTENT_WIDTH - 220 - 16, align: "right" });
  doc.y = bannerY + bannerH + 16;

  // ── Section scores ──
  heading(doc, "Section Scores");
  for (const s of data.sections) {
    const rowY = doc.y;
    doc.font("Helvetica").fontSize(11).fillColor(BRAND_BLACK).text(s.title, PAGE.margin, rowY, { width: CONTENT_WIDTH - 72 });
    doc.font("Helvetica-Bold").fontSize(11).fillColor(BRAND_BLACK).text(`${s.points} / ${s.maxPoints}`, PAGE.width - PAGE.margin - 72, rowY, { width: 72, align: "right" });
    if (s.note) {
      doc.font("Helvetica-Oblique").fontSize(9).fillColor(BRAND_MUTED).text(s.note, PAGE.margin + 12, doc.y + 1, { width: CONTENT_WIDTH - 12 });
    }
    doc.moveDown(0.4);
    hairline(doc);
  }
  doc.moveDown(0.5);

  // ── Critical deficiencies ──
  if (data.deficiencies.length > 0) {
    heading(doc, "Critical Deficiencies");
    for (const deficiency of data.deficiencies) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor(BRAND_BLACK).text(`•  ${deficiency.label}`, PAGE.margin, doc.y, { width: CONTENT_WIDTH });
      if (deficiency.note) {
        doc.font("Helvetica").fontSize(9).fillColor(BRAND_MUTED).text(deficiency.note, PAGE.margin + 12, doc.y + 1, { width: CONTENT_WIDTH - 12 });
      }
    }
    doc.moveDown(0.5);
  }

  // ── Action items ──
  if (data.actionItems.length > 0) {
    heading(doc, "Action Items");
    doc.font("Helvetica").fontSize(10).fillColor(BRAND_BLACK);
    data.actionItems.forEach((a, i) => doc.text(`${i + 1}.  ${a}`, PAGE.margin, doc.y, { width: CONTENT_WIDTH }));
  }

  if (data.formVersion === 2) {
    doc.moveDown(0.8);
    heading(doc, "Signatures");
    drawSignature(doc, "Superintendent", data.superintendentSignature);
    drawSignature(doc, "Project manager", data.pmSignature);
  }

  const evidenceGroups: { title: string; subtitle: string | null; photos: ScorecardPdfPhoto[] }[] = [
    ...data.sections
      .filter((section) => section.photos.length > 0)
      .map((section) => ({
        title: section.title,
        subtitle: section.note,
        photos: section.photos,
      })),
    ...data.deficiencies
      .filter((deficiency) => deficiency.photos.length > 0)
      .map((deficiency) => ({
        title: `Critical Deficiency: ${deficiency.label}`,
        subtitle: deficiency.note,
        photos: deficiency.photos,
      })),
  ];
  for (const group of evidenceGroups) drawEvidencePages(doc, data, group);

  doc.end();
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function drawEvidencePages(
  doc: PDFKit.PDFDocument,
  data: ScorecardPdfData,
  group: { title: string; subtitle: string | null; photos: ScorecardPdfPhoto[] },
): void {
  for (let index = 0; index < group.photos.length; index += 2) {
    doc.addPage();
    drawEvidenceHeader(doc, data, group.title, index / 2 + 1);
    if (index === 0 && group.subtitle) {
      doc.font("Helvetica").fontSize(10).fillColor(BRAND_MUTED).text(group.subtitle, PAGE.margin, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.7);
    }
    const rowY = doc.y;
    for (const [slot, photo] of group.photos.slice(index, index + 2).entries()) {
      drawEvidencePhoto(doc, photo, PAGE.margin + slot * (EVIDENCE_IMAGE_WIDTH + 28), rowY);
    }
    drawEvidenceFooter(doc, data);
  }
}

function drawEvidenceHeader(doc: PDFKit.PDFDocument, data: ScorecardPdfData, title: string, page: number): void {
  const top = PAGE.margin;
  try {
    doc.image(LOGO_BUFFER, PAGE.margin, top, { fit: [34, 34] });
  } catch {
    // A report remains usable when its decorative logo cannot be decoded.
  }
  doc.fillColor(BRAND_RED).font("Helvetica-Bold").fontSize(10).text("T ROCK CONSTRUCTION", PAGE.margin + 44, top + 1);
  doc.fillColor(BRAND_BLACK).font("Helvetica-Bold").fontSize(16).text("Field Scorecard Evidence", PAGE.margin + 44, top + 14);
  doc.font("Helvetica").fontSize(9).fillColor(BRAND_MUTED).text(`Page ${page}`, PAGE.width - PAGE.margin - 64, top + 15, { width: 64, align: "right" });
  const ruleY = top + 42;
  doc.moveTo(PAGE.margin, ruleY).lineTo(PAGE.width - PAGE.margin, ruleY).lineWidth(2).strokeColor(BRAND_RED).stroke();
  doc.y = ruleY + 16;
  doc.fillColor(BRAND_BLACK).font("Helvetica-Bold").fontSize(14).text(title, PAGE.margin, doc.y, { width: CONTENT_WIDTH });
  doc.font("Helvetica").fontSize(9).fillColor(BRAND_MUTED).text(`${data.dealName}  |  Week of ${data.weekOf}`, PAGE.margin, doc.y + 3, { width: CONTENT_WIDTH });
  doc.moveDown(1);
}

function drawEvidencePhoto(doc: PDFKit.PDFDocument, photo: ScorecardPdfPhoto, x: number, y: number): void {
  const imageY = y;
  if (photo.image) {
    try {
      doc.image(photo.image, x, imageY, { fit: [EVIDENCE_IMAGE_WIDTH, EVIDENCE_IMAGE_HEIGHT], align: "center", valign: "center" });
      doc.rect(x, imageY, EVIDENCE_IMAGE_WIDTH, EVIDENCE_IMAGE_HEIGHT).lineWidth(1).strokeColor(BRAND_BORDER).stroke();
    } catch {
      drawImageUnavailable(doc, x, imageY);
    }
  } else {
    drawImageUnavailable(doc, x, imageY);
  }
  const caption = photo.caption?.trim() || "No description provided.";
  doc.font("Helvetica").fontSize(10).fillColor(BRAND_BLACK).text(caption, x, imageY + EVIDENCE_IMAGE_HEIGHT + 10, {
    width: EVIDENCE_IMAGE_WIDTH,
    height: EVIDENCE_ROW_HEIGHT - EVIDENCE_IMAGE_HEIGHT - 10,
    ellipsis: true,
  });
}

function drawImageUnavailable(doc: PDFKit.PDFDocument, x: number, y: number): void {
  doc.rect(x, y, EVIDENCE_IMAGE_WIDTH, EVIDENCE_IMAGE_HEIGHT).fillColor("#F8FAFC").fill();
  doc.font("Helvetica-Bold").fontSize(10).fillColor(BRAND_MUTED).text("Image unavailable", x, y + EVIDENCE_IMAGE_HEIGHT / 2 - 6, {
    width: EVIDENCE_IMAGE_WIDTH,
    align: "center",
  });
  doc.rect(x, y, EVIDENCE_IMAGE_WIDTH, EVIDENCE_IMAGE_HEIGHT).lineWidth(1).strokeColor(BRAND_BORDER).stroke();
}

function drawEvidenceFooter(doc: PDFKit.PDFDocument, data: ScorecardPdfData): void {
  const y = PAGE.height - PAGE.margin - 18;
  doc.moveTo(PAGE.margin, y - 8).lineTo(PAGE.width - PAGE.margin, y - 8).lineWidth(0.5).strokeColor(BRAND_BORDER).stroke();
  doc.font("Helvetica").fontSize(8).fillColor(BRAND_MUTED).text("T Rock Construction Field Scorecard", PAGE.margin, y, { width: CONTENT_WIDTH / 2 });
  doc.text(data.dealName, PAGE.margin + CONTENT_WIDTH / 2, y, { width: CONTENT_WIDTH / 2, align: "right" });
}

function drawSignature(doc: PDFKit.PDFDocument, label: string, signature: string | null): void {
  const y = doc.y;
  doc.font("Helvetica").fontSize(10).fillColor(BRAND_BLACK).text(`${label}:`, PAGE.margin, y + 18, { width: 110 });
  const image = signatureDataUrlToBuffer(signature);
  if (image) {
    try {
      doc.image(image, PAGE.margin + 112, y, { fit: [180, 48], valign: "center" });
    } catch {
      doc.font("Helvetica").fontSize(10).fillColor(BRAND_MUTED).text("Signature unavailable", PAGE.margin + 112, y + 18, { width: 180 });
    }
  } else {
    doc.font("Helvetica").fontSize(10).fillColor(BRAND_MUTED).text("—", PAGE.margin + 112, y + 18, { width: 180 });
  }
  doc.y = y + 52;
}

function signatureDataUrlToBuffer(signature: string | null): Buffer | null {
  if (!signature) return null;
  const match = /^data:image\/(?:png|jpeg|jpg);base64,([A-Za-z0-9+/=\s]+)$/i.exec(signature);
  if (!match) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}

function heading(doc: PDFKit.PDFDocument, label: string): void {
  doc.font("Helvetica-Bold").fontSize(12).fillColor(BRAND_RED).text(label.toUpperCase(), PAGE.margin, doc.y);
  doc.moveDown(0.3);
}

function hairline(doc: PDFKit.PDFDocument): void {
  const y = doc.y;
  doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).lineWidth(0.5).strokeColor(BRAND_BORDER).stroke();
  doc.moveDown(0.3);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Format in UTC so the same submittedAt renders identically regardless of the server's local timezone.
  return d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}
