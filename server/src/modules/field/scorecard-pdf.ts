import PDFDocument from "pdfkit";
import {
  FIELD_SCORECARD_LEADERSHIP_SECTIONS,
  FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY,
  FIELD_SCORECARD_SECTIONS,
  FIELD_SCORECARD_V2_SECTIONS,
  FIELD_SCORECARD_CRITICAL_DEFICIENCIES,
  FIELD_SCORECARD_V2_CRITICAL_DEFICIENCIES,
  scorecardLeadershipRatingLabel,
  scorecardRatingLabel,
  scorecardV2RatingLabel,
  signatureDataUrlBase64Body,
  typedSignatureFallback as sharedTypedSignatureFallback,
  type ScorecardKind,
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
const EVIDENCE_SUBTITLE_HEIGHT = 44;
// Cap the evidence tiles embedded in the report. A scorecard can carry up to 100 photos; at ~100 KB per
// downscaled JPEG that would approach the email provider's ~28 MB attachment ceiling (and produce ~50
// evidence pages). Beyond the cap the renderer prints a note pointing to the full set in the CRM. The
// worker applies a hard byte-size backstop on top of this. Exported so the artifact job pre-caps photos
// BEFORE downloading their bytes (never fetching/transcoding tiles the renderer would only discard).
export const MAX_EVIDENCE_PHOTOS = 60;
// Cap the corrective-action RESPONSE photos embedded across the whole report. Separate from
// MAX_EVIDENCE_PHOTOS so a heavily-documented fix cannot crowd out the original evidence (or push the
// attachment past the provider ceiling). Overflow is reported as a count, never dropped silently.
export const MAX_CORRECTIVE_ACTION_PHOTOS = 24;
// Bound one response comment so a long dictation cannot run away; the full text lives in the CRM.
const CORRECTIVE_ACTION_COMMENT_MAX_HEIGHT = 72;
// Bound each critical-deficiency description on the summary page so one long (up to 4000-char) note can't
// blow the layout across pages; the same note also appears (bounded) as the evidence-group subtitle.
const DEFICIENCY_NOTE_MAX_HEIGHT = 54;
// Bound the leadership Project Summary free text on the first page (the full note lives in the CRM) so one
// long dictation can't push the layout across pages.
const SUMMARY_MAX_HEIGHT = 220;

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
  /** Discriminates the render path: 'project' (default) vs the leadership variant. */
  kind?: ScorecardKind;
  averageScore?: number | null;
  superintendentSignature?: string | null;
  pmSignature?: string | null;
  rating: ScorecardRating;
  items: { sectionKey: string; points: number; note: string | null }[];
  criticalDeficiencyKeys: string[];
  criticalDeficiencyNotes?: Record<string, string>;
  actionItems: string[];
  /** Leadership Project Summary free text (rendered bounded on the summary page). */
  summary?: string | null;
  photos?: ScorecardPdfPhoto[];
  /** Evidence photos already dropped upstream (capped before download) — added to the render-side cap's
   *  omitted count so the "available in the CRM" note reflects the true total. */
  omittedEvidenceCount?: number;
  /** The scorecard's corrective-action items (below-band cards only). Empty/absent renders no section. */
  correctiveActions?: ScorecardPdfCorrectiveAction[];
}

export interface ScorecardPdfPhoto {
  sectionKey: string;
  deficiencyKey: string | null;
  caption: string | null;
  image: Buffer | null;
}

/** One photo documenting a corrective-action response. Not section-keyed — it belongs to an ITEM. */
export interface ScorecardPdfCorrectiveActionPhoto {
  caption: string | null;
  image: Buffer | null;
}

/**
 * One corrective-action item on a below-band scorecard: the flagged action item / critical deficiency, and
 * (once answered) who fixed it, when, what they said and what they photographed.
 */
export interface ScorecardPdfCorrectiveAction {
  /** 'action_item' | 'critical_deficiency' */
  itemType: string;
  /** Action-item index as a string, or the critical-deficiency key. */
  itemRef: string;
  itemLabel: string;
  /** 'open' | 'resolved' */
  status: string;
  responderName: string | null;
  /** ISO timestamp, or null while open. */
  respondedAt: string | null;
  responseComment: string | null;
  photos: ScorecardPdfCorrectiveActionPhoto[];
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
  kind: ScorecardKind;
  averageScore: number | null;
  superintendentSignature: string | null;
  pmSignature: string | null;
  rating: ScorecardRating;
  ratingLabel: string;
  sections: ScorecardPdfSection[];
  deficiencies: ScorecardPdfDeficiency[];
  actionItems: string[];
  summary: string | null;
  /** Leadership Project Summary evidence photos (sectionKey `project_summary`). Empty for project cards. */
  summaryPhotos: ScorecardPdfPhoto[];
  omittedEvidenceCount: number;
  /** Corrective-action items in render order (numeric item_ref), response photos already capped. */
  correctiveActions: ScorecardPdfCorrectiveAction[];
  /** e.g. "1 of 2 resolved" / "All items resolved"; null when there are no corrective actions. */
  correctiveActionSummary: string | null;
  /** Response photos dropped by MAX_CORRECTIVE_ACTION_PHOTOS. */
  omittedCorrectiveActionPhotoCount: number;
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
  const kind: ScorecardKind = input.kind === "leadership" ? "leadership" : "project";
  // Leadership always uses the V2-style 1-10 average model under the hood.
  const formVersion: ScorecardFormVersion = kind === "leadership" ? 2 : input.formVersion === 2 ? 2 : 1;
  const definitions = kind === "leadership"
    ? FIELD_SCORECARD_LEADERSHIP_SECTIONS
    : formVersion === 2
    ? FIELD_SCORECARD_V2_SECTIONS
    : FIELD_SCORECARD_SECTIONS;
  const sections: ScorecardPdfSection[] = definitions.map((def) => {
    const item = itemByKey.get(def.key);
    return {
      title: def.title,
      points: item?.points ?? 0,
      maxPoints: "maxPoints" in def && typeof def.maxPoints === "number" ? def.maxPoints : 10,
      note: item?.note?.trim() ? item.note.trim() : null,
      // Both scorecard kinds can carry evidence for their scored categories.
      photos: photos.filter((photo) => photo.sectionKey === def.key),
    };
  });
  // Leadership cards have no critical deficiencies.
  const deficiencies = kind === "leadership"
    ? []
    : (() => {
        const labelByKey = new Map<string, string>(
          (formVersion === 2 ? FIELD_SCORECARD_V2_CRITICAL_DEFICIENCIES : FIELD_SCORECARD_CRITICAL_DEFICIENCIES).map((d) => [d.key, d.label]),
        );
        return input.criticalDeficiencyKeys
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
      })();
  const actionItems = kind === "leadership" ? [] : input.actionItems.map((s) => s.trim()).filter((s) => s.length > 0);

  // Numeric-aware ordering. item_ref is an action-item INDEX for action items — where "10" must follow "2",
  // not precede it (the lpad guard from the corrective-action work) — and an opaque key for critical
  // deficiencies (lexical). Action items sort ahead of deficiencies so this matches the deal-thread order.
  const orderedCorrectiveActions = [...(input.correctiveActions ?? [])].sort((left, right) => {
    if (left.itemType !== right.itemType) return left.itemType === "action_item" ? -1 : 1;
    const leftNum = Number(left.itemRef);
    const rightNum = Number(right.itemRef);
    if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) return leftNum - rightNum;
    return left.itemRef.localeCompare(right.itemRef);
  });

  // Apply the response-photo cap ACROSS the whole report, in the order items render, so the kept set is
  // deterministic rather than dependent on which item happened to be read first.
  let correctiveActionPhotoBudget = MAX_CORRECTIVE_ACTION_PHOTOS;
  let omittedCorrectiveActionPhotoCount = 0;
  const cappedCorrectiveActions = orderedCorrectiveActions.map((item) => {
    const kept = item.photos.slice(0, Math.max(0, correctiveActionPhotoBudget));
    omittedCorrectiveActionPhotoCount += item.photos.length - kept.length;
    correctiveActionPhotoBudget -= kept.length;
    return { ...item, photos: kept };
  });

  const resolvedCount = cappedCorrectiveActions.filter((item) => item.status === "resolved").length;
  const correctiveActionSummary =
    cappedCorrectiveActions.length === 0
      ? null
      : resolvedCount === cappedCorrectiveActions.length
        ? "All items resolved"
        : `${resolvedCount} of ${cappedCorrectiveActions.length} resolved`;

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
    kind,
    averageScore: input.averageScore ?? null,
    // Leadership cards carry no signatures.
    superintendentSignature: kind === "leadership" ? null : input.superintendentSignature ?? null,
    pmSignature: kind === "leadership" ? null : input.pmSignature ?? null,
    rating: input.rating,
    ratingLabel: kind === "leadership"
      ? scorecardLeadershipRatingLabel(input.rating)
      : formVersion === 2
      ? scorecardV2RatingLabel(input.rating)
      : scorecardRatingLabel(input.rating),
    sections,
    deficiencies,
    actionItems,
    summary: kind === "leadership" ? (input.summary?.trim() ? input.summary.trim() : null) : null,
    // Leadership Project Summary evidence (sectionKey `project_summary`); category evidence is above.
    summaryPhotos: kind === "leadership"
      ? photos.filter((photo) => photo.sectionKey === FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY)
      : [],
    omittedEvidenceCount: Math.max(0, input.omittedEvidenceCount ?? 0),
    correctiveActions: cappedCorrectiveActions,
    correctiveActionSummary,
    omittedCorrectiveActionPhotoCount,
  };
}

export interface EvidenceGroup {
  title: string;
  subtitle: string | null;
  photos: ScorecardPdfPhoto[];
}

/**
 * Bound the number of evidence tiles embedded in the PDF (and therefore attachment size + page count) to
 * `max`, preserving group order and filling groups in turn. Returns the trimmed groups plus the count of
 * photos left out — the renderer surfaces that as an "available in the CRM" note. Pure, so the cap policy
 * is unit-testable without rendering.
 */
export function capEvidenceGroups(
  groups: EvidenceGroup[],
  max: number,
): { groups: EvidenceGroup[]; omitted: number } {
  const capped: EvidenceGroup[] = [];
  let remaining = Math.max(0, max);
  let omitted = 0;
  for (const group of groups) {
    if (remaining <= 0) {
      omitted += group.photos.length;
      continue;
    }
    if (group.photos.length <= remaining) {
      capped.push(group);
      remaining -= group.photos.length;
    } else {
      capped.push({ ...group, photos: group.photos.slice(0, remaining) });
      omitted += group.photos.length - remaining;
      remaining = 0;
    }
  }
  return { groups: capped, omitted };
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
  const isLeadership = data.kind === "leadership";
  doc.fillColor(BRAND_RED).font("Helvetica-Bold").fontSize(11).text("T ROCK CONSTRUCTION", PAGE.margin + 52, top + 2);
  doc.fillColor(BRAND_BLACK).font("Helvetica-Bold").fontSize(20).text(isLeadership ? "Leadership Scorecard" : "Field Scorecard", PAGE.margin + 52, top + 16);
  const ruleY = top + 48;
  doc.moveTo(PAGE.margin, ruleY).lineTo(PAGE.width - PAGE.margin, ruleY).lineWidth(2).strokeColor(BRAND_RED).stroke();
  doc.y = ruleY + 14;

  // ── Header meta ──
  // Leadership leads with the Evaluator (the submitting user), then the pre-filled PM + Superintendent.
  const meta: [string, string][] = isLeadership
    ? [
        ["Project", data.dealName],
        ["Project number", data.projectNumber ?? "—"],
        ["Week of", data.weekOf],
        ["Evaluator", `${data.submittedByName ?? "—"} · ${formatDate(data.submittedAt)}`],
        ["Project manager", data.pmName ?? "—"],
        ["Superintendent", data.superintendentName ?? "—"],
      ]
    : [
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
  heading(doc, isLeadership ? "Category Scores" : "Section Scores");
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
        doc.font("Helvetica").fontSize(9).fillColor(BRAND_MUTED).text(deficiency.note, PAGE.margin + 12, doc.y + 1, {
          width: CONTENT_WIDTH - 12,
          height: DEFICIENCY_NOTE_MAX_HEIGHT,
          ellipsis: true,
        });
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

  // ── Project Summary (leadership only): the category average + a bounded free-text summary. ──
  if (isLeadership) {
    doc.moveDown(0.5);
    // Keep the heading with at least the first lines of its body — never orphan it at a page foot.
    if (doc.y + 96 > PAGE.height - PAGE.margin) doc.addPage();
    heading(doc, "Project Summary");
    const avgText = (data.averageScore ?? data.totalScore / 10).toFixed(1);
    doc.font("Helvetica").fontSize(10).fillColor(BRAND_MUTED).text("Category average", PAGE.margin, doc.y, { width: 130, continued: false });
    doc.font("Helvetica-Bold").fontSize(11).fillColor(BRAND_BLACK).text(`${avgText} / 10  ·  ${data.ratingLabel}`, PAGE.margin + 130, doc.y - 12, { width: CONTENT_WIDTH - 130 });
    doc.moveDown(0.6);
    doc.font("Helvetica").fontSize(10).fillColor(BRAND_BLACK).text(
      data.summary?.trim() || "No summary provided.",
      PAGE.margin,
      doc.y,
      // Bound the free text so one long dictation can't run away; the full note lives in the CRM.
      { width: CONTENT_WIDTH, height: SUMMARY_MAX_HEIGHT, ellipsis: true },
    );
  } else if (data.formVersion === 2) {
    doc.moveDown(0.8);
    // Keep the Signatures heading with at least its first signature — never orphan the heading at a page
    // foot (drawSignature also guards each block, so both stay on-page).
    if (doc.y + 78 > PAGE.height - PAGE.margin) doc.addPage();
    heading(doc, "Signatures");
    drawSignature(doc, "Superintendent", data.superintendentSignature);
    drawSignature(doc, "Project manager", data.pmSignature);
  }

  // ── Corrective actions ──
  // Placed after the signed card body and before the original-evidence pages, so each item renders
  // self-contained: its status, response and photos stay adjacent instead of being split across the report.
  // Applies to BOTH kinds — a leadership card can trip the corrective-action band too.
  if (data.correctiveActions.length > 0) {
    doc.addPage();
    heading(doc, "Corrective Actions");
    if (data.correctiveActionSummary) {
      doc.font("Helvetica").fontSize(10).fillColor(BRAND_MUTED).text(
        data.correctiveActionSummary,
        PAGE.margin,
        doc.y,
        { width: CONTENT_WIDTH },
      );
      doc.moveDown(0.6);
    }
    for (const item of data.correctiveActions) {
      drawCorrectiveAction(doc, item);
    }
    if (data.omittedCorrectiveActionPhotoCount > 0) {
      doc.moveDown(0.4);
      const count = data.omittedCorrectiveActionPhotoCount;
      doc.font("Helvetica-Oblique").fontSize(9).fillColor(BRAND_MUTED).text(
        `${count} additional response photo${count === 1 ? "" : "s"} available in the CRM.`,
        PAGE.margin,
        doc.y,
        { width: CONTENT_WIDTH },
      );
    }
  }

  const evidenceGroups: EvidenceGroup[] = isLeadership
    ? [
        ...data.sections
          .filter((section) => section.photos.length > 0)
          .map((section) => ({ title: section.title, subtitle: section.note, photos: section.photos })),
        ...(data.summaryPhotos.length > 0
          ? [{ title: "Project Summary", subtitle: data.summary?.trim() || null, photos: data.summaryPhotos }]
          : []),
      ]
    : [
        // Critical-deficiency evidence leads AND is prioritized by the cap, so the most important photos are
        // never starved by routine section evidence when a report exceeds MAX_EVIDENCE_PHOTOS.
        ...data.deficiencies
          .filter((deficiency) => deficiency.photos.length > 0)
          .map((deficiency) => ({
            title: `Critical Deficiency: ${deficiency.label}`,
            subtitle: deficiency.note,
            photos: deficiency.photos,
          })),
        ...data.sections
          .filter((section) => section.photos.length > 0)
          .map((section) => ({
            title: section.title,
            subtitle: section.note,
            photos: section.photos,
          })),
      ];
  const { groups: cappedEvidence, omitted: omittedEvidence } = capEvidenceGroups(evidenceGroups, MAX_EVIDENCE_PHOTOS);
  for (const group of cappedEvidence) drawEvidencePages(doc, data, group);
  // Photos dropped here (defensive render-side cap) PLUS any dropped upstream before download.
  const omittedTotal = omittedEvidence + data.omittedEvidenceCount;
  if (omittedTotal > 0) drawEvidenceOverflowNote(doc, data, omittedTotal);

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
      const subtitleY = doc.y;
      doc.font("Helvetica").fontSize(10).fillColor(BRAND_MUTED).text(group.subtitle, PAGE.margin, subtitleY, {
        width: CONTENT_WIDTH,
        height: EVIDENCE_SUBTITLE_HEIGHT,
        ellipsis: true,
      });
      doc.y = subtitleY + EVIDENCE_SUBTITLE_HEIGHT + 12;
    }
    const rowY = doc.y;
    for (const [slot, photo] of group.photos.slice(index, index + 2).entries()) {
      drawEvidencePhoto(doc, photo, PAGE.margin + slot * (EVIDENCE_IMAGE_WIDTH + 28), rowY);
    }
    drawEvidenceFooter(doc, data);
  }
}

// Shared branded top strip (logo + wordmark + red rule) for every evidence page. Returns the rule's Y so
// the caller can lay content out beneath it. Reused by the per-group header and the overflow note.
function drawEvidenceBrandBar(doc: PDFKit.PDFDocument): number {
  const top = PAGE.margin;
  try {
    doc.image(LOGO_BUFFER, PAGE.margin, top, { fit: [34, 34] });
  } catch {
    // A report remains usable when its decorative logo cannot be decoded.
  }
  doc.fillColor(BRAND_RED).font("Helvetica-Bold").fontSize(10).text("T ROCK CONSTRUCTION", PAGE.margin + 44, top + 1);
  doc.fillColor(BRAND_BLACK).font("Helvetica-Bold").fontSize(16).text("Field Scorecard Evidence", PAGE.margin + 44, top + 14);
  const ruleY = top + 42;
  doc.moveTo(PAGE.margin, ruleY).lineTo(PAGE.width - PAGE.margin, ruleY).lineWidth(2).strokeColor(BRAND_RED).stroke();
  return ruleY;
}

function drawEvidenceHeader(doc: PDFKit.PDFDocument, data: ScorecardPdfData, title: string, page: number): void {
  const ruleY = drawEvidenceBrandBar(doc);
  doc.font("Helvetica").fontSize(9).fillColor(BRAND_MUTED).text(`Page ${page}`, PAGE.width - PAGE.margin - 64, PAGE.margin + 15, { width: 64, align: "right" });
  doc.y = ruleY + 16;
  doc.fillColor(BRAND_BLACK).font("Helvetica-Bold").fontSize(14).text(title, PAGE.margin, doc.y, { width: CONTENT_WIDTH });
  doc.font("Helvetica").fontSize(9).fillColor(BRAND_MUTED).text(`${data.dealName}  |  Week of ${data.weekOf}`, PAGE.margin, doc.y + 3, { width: CONTENT_WIDTH });
  doc.moveDown(1);
}

// A branded page noting evidence trimmed by the MAX_EVIDENCE_PHOTOS cap, pointing to the full set in the
// CRM — so truncation is explicit, never a silent drop.
function drawEvidenceOverflowNote(doc: PDFKit.PDFDocument, data: ScorecardPdfData, count: number): void {
  doc.addPage();
  const ruleY = drawEvidenceBrandBar(doc);
  doc.y = ruleY + 20;
  const boxY = doc.y;
  const boxH = 74;
  doc.roundedRect(PAGE.margin, boxY, CONTENT_WIDTH, boxH, 8).fillColor("#F8FAFC").fill();
  doc.font("Helvetica-Bold").fontSize(12).fillColor(BRAND_BLACK).text(
    `${count} additional evidence photo${count === 1 ? "" : "s"} not shown`,
    PAGE.margin + 16,
    boxY + 16,
    { width: CONTENT_WIDTH - 32 },
  );
  doc.font("Helvetica").fontSize(10).fillColor(BRAND_MUTED).text(
    "This report includes a representative set of evidence. The complete set of photos for this scorecard is available in the CRM.",
    PAGE.margin + 16,
    boxY + 36,
    { width: CONTENT_WIDTH - 32 },
  );
  doc.y = boxY + boxH + 12;
  drawEvidenceFooter(doc, data);
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
  if (doc.y + 52 > PAGE.height - PAGE.margin) doc.addPage();
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
    // Legacy typed signatures (a plain name, not a data URL) render as text.
    doc.font("Helvetica").fontSize(10).fillColor(BRAND_MUTED).text(typedSignatureFallback(signature) ?? "—", PAGE.margin + 112, y + 18, { width: 180 });
  }
  doc.y = y + 52;
}

/**
 * A handwritten-signature data URL (png/jpeg) → decoded image bytes to draw; null for anything else.
 *
 * The CLASSIFICATION lives in shared/types/field-scorecard-signature so the web deal tab applies exactly
 * the same rule; only the Buffer decode is server-side.
 */
export function signatureDataUrlToBuffer(signature: string | null): Buffer | null {
  const body = signatureDataUrlBase64Body(signature);
  if (body == null) return null;
  try {
    return Buffer.from(body, "base64");
  } catch {
    return null;
  }
}

/**
 * The legacy typed-signature text to render when there's no drawable image: a plain typed name renders
 * verbatim, but a data URL (drawn as an image, or an unsupported/undecodable one) must NOT be dumped as
 * raw text — it falls back to "—" instead.
 *
 * Delegates to the shared predicate so this renderer and the web deal tab can never disagree about what
 * counts as a signature.
 */
export function typedSignatureFallback(signature: string | null): string | null {
  return sharedTypedSignatureFallback(signature);
}

/**
 * One corrective-action item: the flagged label, an Open/Resolved status, and — once answered — who fixed
 * it, when, what they said and what they photographed. An open item deliberately shows only the label and
 * status: there is nothing yet to document.
 */
function drawCorrectiveAction(doc: PDFKit.PDFDocument, item: ScorecardPdfCorrectiveAction): void {
  const resolved = item.status === "resolved";
  // Keep the label with at least its status line rather than orphaning it at a page foot.
  if (doc.y + 64 > PAGE.height - PAGE.margin) doc.addPage();

  doc.font("Helvetica-Bold").fontSize(11).fillColor(BRAND_BLACK).text(item.itemLabel, PAGE.margin, doc.y, {
    width: CONTENT_WIDTH,
  });
  doc.font("Helvetica-Bold").fontSize(9).fillColor(resolved ? "#16A34A" : BRAND_RED).text(
    resolved ? "RESOLVED" : "OPEN",
    PAGE.margin,
    doc.y + 2,
    { width: CONTENT_WIDTH },
  );

  if (resolved) {
    const who = item.responderName?.trim();
    const when = item.respondedAt ? formatDate(item.respondedAt) : null;
    const attribution = [who, when].filter(Boolean).join("  ·  ");
    if (attribution) {
      doc.font("Helvetica").fontSize(9).fillColor(BRAND_MUTED).text(attribution, PAGE.margin, doc.y + 2, {
        width: CONTENT_WIDTH,
      });
    }
    const comment = item.responseComment?.trim();
    if (comment) {
      doc.font("Helvetica").fontSize(10).fillColor(BRAND_BLACK).text(comment, PAGE.margin, doc.y + 4, {
        width: CONTENT_WIDTH,
        height: CORRECTIVE_ACTION_COMMENT_MAX_HEIGHT,
        ellipsis: true,
      });
    }
    drawCorrectiveActionPhotos(doc, item.photos);
  }

  doc.moveDown(0.8);
  hairline(doc);
}

/**
 * Response photos in a 2-up grid, reusing the evidence tile geometry and the same "Image unavailable"
 * placeholder so a permanently-bad object degrades identically to original evidence.
 */
function drawCorrectiveActionPhotos(
  doc: PDFKit.PDFDocument,
  photos: ScorecardPdfCorrectiveActionPhoto[],
): void {
  if (photos.length === 0) return;
  doc.moveDown(0.4);
  const captionHeight = 20;
  for (let index = 0; index < photos.length; index += 2) {
    const row = photos.slice(index, index + 2);
    if (doc.y + EVIDENCE_IMAGE_HEIGHT + captionHeight + 8 > PAGE.height - PAGE.margin) doc.addPage();
    const rowTop = doc.y;
    row.forEach((photo, column) => {
      const x = PAGE.margin + column * (EVIDENCE_IMAGE_WIDTH + 16);
      if (photo.image) {
        try {
          doc.image(photo.image, x, rowTop, {
            fit: [EVIDENCE_IMAGE_WIDTH, EVIDENCE_IMAGE_HEIGHT],
            align: "center",
            valign: "center",
          });
          doc.rect(x, rowTop, EVIDENCE_IMAGE_WIDTH, EVIDENCE_IMAGE_HEIGHT).lineWidth(1).strokeColor(BRAND_BORDER).stroke();
        } catch {
          drawImageUnavailable(doc, x, rowTop);
        }
      } else {
        drawImageUnavailable(doc, x, rowTop);
      }
      if (photo.caption?.trim()) {
        doc.font("Helvetica").fontSize(8).fillColor(BRAND_MUTED).text(
          photo.caption.trim(),
          x,
          rowTop + EVIDENCE_IMAGE_HEIGHT + 4,
          { width: EVIDENCE_IMAGE_WIDTH, height: captionHeight, ellipsis: true },
        );
      }
    });
    doc.y = rowTop + EVIDENCE_IMAGE_HEIGHT + captionHeight + 6;
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
