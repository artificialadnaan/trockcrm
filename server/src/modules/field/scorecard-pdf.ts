import PDFDocument from "pdfkit";
import {
  FIELD_SCORECARD_SECTIONS,
  FIELD_SCORECARD_CRITICAL_DEFICIENCIES,
  scorecardRatingLabel,
  type ScorecardRating,
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
  rating: ScorecardRating;
  items: { sectionKey: string; points: number; note: string | null }[];
  criticalDeficiencyKeys: string[];
  actionItems: string[];
}

export interface ScorecardPdfSection {
  title: string;
  points: number;
  maxPoints: number;
  note: string | null;
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
  rating: ScorecardRating;
  ratingLabel: string;
  sections: ScorecardPdfSection[];
  deficiencies: string[];
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
  const sections: ScorecardPdfSection[] = FIELD_SCORECARD_SECTIONS.map((def) => {
    const item = itemByKey.get(def.key);
    return {
      title: def.title,
      points: item?.points ?? 0,
      maxPoints: def.maxPoints,
      note: item?.note?.trim() ? item.note.trim() : null,
    };
  });
  const labelByKey = new Map(FIELD_SCORECARD_CRITICAL_DEFICIENCIES.map((d) => [d.key, d.label]));
  const deficiencies = input.criticalDeficiencyKeys
    .map((k) => labelByKey.get(k))
    .filter((l): l is string => typeof l === "string");
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
    rating: input.rating,
    ratingLabel: scorecardRatingLabel(input.rating),
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
  doc.font("Helvetica-Bold").fontSize(24).fillColor(BRAND_BLACK).text(`${data.totalScore} / 100`, PAGE.margin + 16, bannerY + 14, { width: 220 });
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
    doc.font("Helvetica").fontSize(10).fillColor(BRAND_BLACK);
    for (const d of data.deficiencies) doc.text(`•  ${d}`, PAGE.margin, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.5);
  }

  // ── Action items ──
  if (data.actionItems.length > 0) {
    heading(doc, "Action Items");
    doc.font("Helvetica").fontSize(10).fillColor(BRAND_BLACK);
    data.actionItems.forEach((a, i) => doc.text(`${i + 1}.  ${a}`, PAGE.margin, doc.y, { width: CONTENT_WIDTH }));
  }

  doc.end();
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
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
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
