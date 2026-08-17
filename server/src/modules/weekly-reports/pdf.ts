import PDFDocument from "pdfkit";
import { TROCK_LOGO_PNG_BASE64 } from "../field/pdf-logo.js";
import {
  loadPhotoBuffer,
  openImageForLayout,
  paginateTextByHeight,
  registerReportFonts,
  type ReportFontSet,
} from "../field/pdf-layout.js";

// The client-facing weekly progress report, reproducing the spreadsheet artifact PMs produced by hand:
// page 1 is the one-page summary, page 2+ the photo sheets.
//
// LANDSCAPE, and that is not a style choice. Page 1 is a two-column body over a three-box footer row, and
// page 2 is a three-across photo grid; both come from the reference document and neither fits a portrait
// column without shrinking the photographs to thumbnails. Every coordinate below is absolute (doc margin 0)
// for the same reason pdf-layout.ts is: a non-zero bottom margin makes pdfkit auto-break the moment a draw
// lands near the page foot, which is how the field report grew blank pages.
//
// Fonts and photo loading come from field/pdf-layout.ts rather than being re-derived here. The Geist OTF
// paths resolve relative to THAT file, so a local copy would quietly degrade to Helvetica; loadPhotoBuffer
// carries the R2 size cap, the HEIC/WebP transcode and the "don't fetch arbitrary URLs" rule that this
// surface needs just as much.

const PAGE_WIDTH = 792;
const PAGE_HEIGHT = 612;
const MARGIN = 36;
const CONTENT_LEFT = MARGIN;
const CONTENT_RIGHT = PAGE_WIDTH - MARGIN;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;

const BRAND_RED = "#C1272D";
const BRAND_BLACK = "#111111";
const BRAND_BORDER = "#B7BCC4";
const BRAND_INNER_BORDER = "#9AA3B0";
const BRAND_MUTED = "#7589A3";
const LOGO_BUFFER = Buffer.from(TROCK_LOGO_PNG_BASE64, "base64");

// --- Header band ---------------------------------------------------------------------------------
const HEADER_TOP = 30;
const HEADER_HEIGHT = 54;
const PROPERTY_BOX_WIDTH = 192;
const PROPERTY_BOX_LEFT = CONTENT_RIGHT - PROPERTY_BOX_WIDTH;
const BAND_LEFT = CONTENT_LEFT;
const BAND_WIDTH = PROPERTY_BOX_LEFT - 12 - BAND_LEFT;
const LOGO_PLATE_WIDTH = 62;
const WEEK_OF_WIDTH = 108;

// --- Page 1 body ---------------------------------------------------------------------------------
const BODY_TOP = 96;
const BODY_BOTTOM = 424;
const PANEL_PAD = 14;
const LEFT_PANEL_LEFT = CONTENT_LEFT;
const LEFT_PANEL_WIDTH = PROPERTY_BOX_LEFT - 12 - CONTENT_LEFT;
const RIGHT_PANEL_LEFT = PROPERTY_BOX_LEFT;
const RIGHT_PANEL_WIDTH = PROPERTY_BOX_WIDTH;

const WORK_BOX_TOP = 132;
const WORK_BOX_HEIGHT = 126;
const LOOKAHEAD_BOX_TOP = 294;
const LOOKAHEAD_BOX_HEIGHT = 116;

// --- Page 1 footer row ---------------------------------------------------------------------------
const FOOTER_ROW_TOP = 436;
const FOOTER_ROW_BOTTOM = 566;
const ISSUES_PANEL_WIDTH = 228;
const ISSUES_BOX_TOP = 470;
const ISSUES_BOX_HEIGHT = 84;
const SCHEDULE_PANEL_LEFT = CONTENT_LEFT + ISSUES_PANEL_WIDTH + 12;
const SCHEDULE_ROW_PITCH = 20;
const DURATION_COLUMN_LEFT = 550;
const DURATION_BAR_LEFT = 616;
const DURATION_BAR_MAX_WIDTH = CONTENT_RIGHT - 12 - DURATION_BAR_LEFT;
const DURATION_BAR_HEIGHT = 20;
const DURATION_ARROW_HEAD = 14;
/** Short enough to read as "almost none left", long enough that the number inside is still legible. */
const DURATION_BAR_MIN_WIDTH = 46;

const PAGE_NUMBER_Y = 578;

// --- Photo sheet ---------------------------------------------------------------------------------
// Three across, two down. Both numbers come from the reference document; PHOTOS_PER_PAGE is derived from
// them rather than written twice, so re-flowing the grid cannot desynchronise the chunking.
const PHOTO_COLUMNS = 3;
const PHOTO_ROWS_PER_PAGE = 2;
export const WEEKLY_REPORT_PHOTOS_PER_PAGE = PHOTO_COLUMNS * PHOTO_ROWS_PER_PAGE;
const PHOTO_GRID_TOP = 96;
const PHOTO_GRID_BOTTOM = 566;
const PHOTO_COLUMN_GAP = 14;
const PHOTO_ROW_GAP = 14;
const PHOTO_CELL_WIDTH = (CONTENT_WIDTH - PHOTO_COLUMN_GAP * (PHOTO_COLUMNS - 1)) / PHOTO_COLUMNS;
const PHOTO_CELL_HEIGHT =
  (PHOTO_GRID_BOTTOM - PHOTO_GRID_TOP - PHOTO_ROW_GAP * (PHOTO_ROWS_PER_PAGE - 1)) / PHOTO_ROWS_PER_PAGE;
const PHOTO_CELL_PAD = 6;
/** Two lines at CAPTION_FONT_SIZE plus the gap above them. A caption longer than that ellipsises. */
const PHOTO_CAPTION_HEIGHT = 24;
const PHOTO_CAPTION_FONT_SIZE = 8;

const BODY_FONT_SIZE = 8.5;
const BODY_LINE_GAP = 1.5;

/**
 * Ceiling on ONE section's text before the renderer stops paginating it.
 *
 * The service already caps a section at 20,000 characters, which is roughly 30 continuation pages of
 * 8.5pt text — far past the point where a client-facing weekly update is still a weekly update, and a
 * lot of buffered pages for the worker that renders it. Past this the tail is dropped with a visible
 * marker rather than silently, so the reader knows there is more and can ask for it.
 */
const MAX_SECTION_RENDER_CHARS = 6_000;
const TRUNCATION_NOTICE = "… (continued in the CRM)";

export interface WeeklyReportPdfPhoto {
  fileId: string;
  caption: string | null;
  r2Key: string | null;
  externalUrl: string | null;
  externalThumbnailUrl: string | null;
  mimeType: string | null;
}

/** One labelled person on the report — the value may legitimately be blank (RM and CM usually are). */
export interface WeeklyReportPdfContact {
  label: string;
  name: string | null;
}

export interface WeeklyReportPdfData {
  propertyName: string;
  /** Already formatted for print, e.g. "8/13/26". */
  weekOfLabel: string;
  clientName: string | null;
  clientTeam: WeeklyReportPdfContact[];
  trockTeam: WeeklyReportPdfContact[];
  workCompleted: string | null;
  nextWeekLookAhead: string | null;
  issuesConcerns: string | null;
  schedule: {
    contractDate: string;
    projectStartDate: string;
    projectCompletionDate: string;
    completionPercent: string;
    weatherDelayDays: string;
  };
  duration: { projectedWeeks: number | null; remainingWeeks: number | null };
  photos: WeeklyReportPdfPhoto[];
  /** Printed as a revision banner when > 1. A client who kept the first link must see which one this is. */
  version: number;
  /**
   * The PDF's `/CreationDate`, pinned to the report's content generation rather than to the wall clock.
   *
   * Required rather than optional, so a caller has to decide. pdfkit stamps `new Date()` by default, which
   * puts "whenever somebody happened to click download" inside a document that is supposed to be an
   * immutable record of one week — and makes the artifact's bytes depend on when it was produced rather
   * than on what it says.
   *
   * NOTE: this does NOT make the render byte-reproducible, and the object key is derived from the bytes.
   * pdfkit finalises PNG images (the logo carries an alpha channel, hence an SMask) through an ASYNCHRONOUS
   * zlib inflate, so the order in which those objects are allocated varies with process load — two renders
   * of identical content come out the same length, with the same content, and with different object
   * numbering. A regeneration can therefore still land on a new key and leave the previous object behind.
   * The scorecard artifact has the same property; removing it means shipping the logo without alpha.
   */
  creationDate: Date;
}

// --- Value formatting ----------------------------------------------------------------------------

/**
 * "8/13/26" — the reference report's date format.
 *
 * Parsed at UTC NOON, the convention used everywhere else in this feature (shared/types/weekly-report.ts
 * explains it): `new Date("2026-08-13")` is UTC midnight read back in local time, which prints 8/12/26 for
 * every reader west of Greenwich — on a document whose entire subject is which week it covers.
 */
export function formatWeeklyReportDate(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null;
  const parsed = new Date(`${String(isoDate).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getUTCMonth() + 1}/${parsed.getUTCDate()}/${String(parsed.getUTCFullYear()).slice(-2)}`;
}

/**
 * A schedule cell: the date when there is one, otherwise the note the PM typed in its place.
 *
 * The reference prints "TBD Permit" where a date belongs, which is why the schema carries a nullable date
 * AND a note. Preferring the date keeps the printed value consistent with the arithmetic the rest of the
 * report does; falling back to the note is what makes the blank cell say something.
 */
export function weeklyReportScheduleValue(
  isoDate: string | null | undefined,
  note: string | null | undefined,
): string {
  return formatWeeklyReportDate(isoDate) ?? (note?.trim() || "—");
}

function displayOrDash(value: string | null | undefined): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || "—";
}

// --- Text flow -----------------------------------------------------------------------------------

/** Must match paginateTextByHeight's own normalisation, or `head` stops being a prefix of the result. */
function normalizeForFlow(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
}

/**
 * Split free-form section text into the part that fits a fixed box and the part that does not.
 *
 * Page 1 has boxes of a fixed size — that IS the report's format, and growing them would stop it being the
 * one-pager the client recognises. But a section that overflows must not be silently ellipsised away
 * either: it is the superintendent's account of the week, and the client is the person it is written for.
 * So the overflow flows onto a continuation page instead.
 *
 * The split is derived from paginateTextByHeight rather than reimplemented: it packs from the SAME
 * normalised token stream, so its first chunk is always a prefix of the normalised text and the remainder
 * is recovered by slicing — line structure and bullet markers intact. The join fallback exists only in
 * case that ever stops holding; losing paragraph breaks is bad, losing the text is worse.
 */
export function splitTextAtHeight(
  text: string,
  maxHeight: number,
  measure: (chunk: string) => number,
): { head: string; rest: string } {
  const pages = paginateTextByHeight(text, maxHeight, measure);
  if (pages.length <= 1) return { head: pages[0] ?? "", rest: "" };
  const normalized = normalizeForFlow(text);
  const head = pages[0]!;
  if (!normalized.startsWith(head)) return { head, rest: pages.slice(1).join("\n") };
  return { head, rest: normalized.slice(head.length).replace(/^[ \n]/, "") };
}

/**
 * A height measurer bound to one box's text width.
 *
 * The font is set INSIDE the returned function, not once by the caller. Between two measurements the
 * renderer draws headings and labels, each of which mutates the document's current font — a measurer that
 * trusted ambient state would size the last section against whatever was drawn just before it.
 */
function bodyMeasurer(doc: PDFKit.PDFDocument, fonts: ReportFontSet, width: number) {
  return (chunk: string) => {
    doc.font(fonts.regular).fontSize(BODY_FONT_SIZE);
    return doc.heightOfString(chunk, { width, lineGap: BODY_LINE_GAP });
  };
}

function boundSectionText(value: string | null | undefined): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length <= MAX_SECTION_RENDER_CHARS) return text;
  return `${text.slice(0, MAX_SECTION_RENDER_CHARS).trimEnd()}\n${TRUNCATION_NOTICE}`;
}

// --- Primitives ----------------------------------------------------------------------------------

function drawPanel(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number) {
  doc.save();
  doc.roundedRect(x, y, w, h, 3).lineWidth(1).strokeColor(BRAND_BORDER).stroke();
  doc.restore();
}

/**
 * A section heading: bold, with the rule under it that the reference draws. pdfkit has no underline that
 * stops at the text, so the rule is measured off the string and drawn explicitly.
 */
function drawUnderlinedHeading(
  doc: PDFKit.PDFDocument,
  fonts: ReportFontSet,
  text: string,
  x: number,
  y: number,
  size: number,
  maxWidth: number,
) {
  doc.save();
  doc.font(fonts.bold).fontSize(size).fillColor(BRAND_BLACK);
  const width = Math.min(doc.widthOfString(text), maxWidth);
  doc.text(text, x, y, { width: maxWidth, lineBreak: false, height: size + 4, ellipsis: true });
  doc
    .moveTo(x, y + size + 3)
    .lineTo(x + width, y + size + 3)
    .lineWidth(0.8)
    .strokeColor(BRAND_BLACK)
    .stroke();
  doc.restore();
}

/**
 * A bordered text box with the section's prose inside it, height-capped.
 *
 * The `height` option is a hard backstop, not the flow control: splitTextAtHeight has already sized the
 * chunk. Without it pdfkit would auto-create a continuation page outside this renderer's page accounting,
 * which is how the field report grew blank pages with mis-numbered footers.
 */
function drawTextBox(
  doc: PDFKit.PDFDocument,
  fonts: ReportFontSet,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  doc.save();
  doc.rect(x, y, w, h).lineWidth(0.8).strokeColor(BRAND_INNER_BORDER).stroke();
  if (text) {
    doc.font(fonts.regular).fontSize(BODY_FONT_SIZE).fillColor(BRAND_BLACK);
    doc.text(text, x + 6, y + 6, { width: w - 12, height: h - 12, lineGap: BODY_LINE_GAP });
  }
  doc.restore();
}

/** The Projected / Remaining bars: a rectangle with a chevron point, the count printed inside it. */
function drawDurationArrow(
  doc: PDFKit.PDFDocument,
  fonts: ReportFontSet,
  x: number,
  y: number,
  width: number,
  color: string,
  value: number | null,
) {
  const w = Math.max(DURATION_BAR_MIN_WIDTH, width);
  const h = DURATION_BAR_HEIGHT;
  doc.save();
  doc
    .moveTo(x, y)
    .lineTo(x + w - DURATION_ARROW_HEAD, y)
    .lineTo(x + w, y + h / 2)
    .lineTo(x + w - DURATION_ARROW_HEAD, y + h)
    .lineTo(x, y + h)
    .closePath()
    .fillColor(color)
    .fill();
  doc.font(fonts.regular).fontSize(10).fillColor("#FFFFFF");
  doc.text(value == null ? "—" : String(value), x + 8, y + 5, {
    width: w - DURATION_ARROW_HEAD - 10,
    lineBreak: false,
    height: 12,
    ellipsis: true,
  });
  doc.restore();
}

/**
 * The header every page carries: red band with the logo and the title, "Week of" and the date on its right
 * end, then the black Property Name box. `title` differs between the summary page and the photo sheets,
 * which is the only thing that changes between them.
 */
function drawHeaderBand(
  doc: PDFKit.PDFDocument,
  fonts: ReportFontSet,
  title: string,
  data: WeeklyReportPdfData,
) {
  doc.save();
  doc.rect(BAND_LEFT, HEADER_TOP, BAND_WIDTH, HEADER_HEIGHT).fillColor(BRAND_RED).fill();

  // The mark is drawn on its own white plate, as the reference does — the logo's grey/black strokes
  // disappear into the red otherwise.
  doc.rect(BAND_LEFT, HEADER_TOP, LOGO_PLATE_WIDTH, HEADER_HEIGHT).fillColor("#FFFFFF").fill();
  try {
    doc.image(LOGO_BUFFER, BAND_LEFT + 7, HEADER_TOP + 7, {
      fit: [LOGO_PLATE_WIDTH - 14, HEADER_HEIGHT - 14],
      align: "center",
      valign: "center",
    });
  } catch (error) {
    // A missing/corrupt logo must not cost the client their report — print the wordmark instead.
    console.error("[weekly-report-pdf] failed to embed the T-Rock logo", error);
    doc.fillColor(BRAND_RED).font(fonts.bold).fontSize(12).text("T ROCK", BAND_LEFT + 4, HEADER_TOP + 20, {
      width: LOGO_PLATE_WIDTH - 8,
      align: "center",
      lineBreak: false,
      height: 14,
      ellipsis: true,
    });
  }

  const titleLeft = BAND_LEFT + LOGO_PLATE_WIDTH + 10;
  const titleWidth = BAND_WIDTH - LOGO_PLATE_WIDTH - 10 - WEEK_OF_WIDTH;
  doc.font(fonts.bold).fontSize(19).fillColor("#FFFFFF");
  doc.text(title, titleLeft, HEADER_TOP + 17, {
    width: titleWidth,
    align: "center",
    lineBreak: false,
    height: 24,
    ellipsis: true,
  });

  const weekOfLeft = BAND_LEFT + BAND_WIDTH - WEEK_OF_WIDTH;
  doc.font(fonts.bold).fontSize(12).fillColor("#FFFFFF");
  doc.text("Week of", weekOfLeft, HEADER_TOP + 10, { width: WEEK_OF_WIDTH - 10, align: "center", lineBreak: false, height: 15 });
  doc.font(fonts.regular).fontSize(10).fillColor("#FFFFFF");
  doc.text(data.weekOfLabel, weekOfLeft, HEADER_TOP + 30, {
    width: WEEK_OF_WIDTH - 10,
    align: "center",
    lineBreak: false,
    height: 13,
    ellipsis: true,
  });

  doc.rect(PROPERTY_BOX_LEFT, HEADER_TOP, PROPERTY_BOX_WIDTH, HEADER_HEIGHT).fillColor(BRAND_BLACK).fill();
  doc.font(fonts.bold).fontSize(11).fillColor("#FFFFFF");
  doc.text("Property Name", PROPERTY_BOX_LEFT, HEADER_TOP + 8, {
    width: PROPERTY_BOX_WIDTH,
    align: "center",
    lineBreak: false,
    height: 14,
    ellipsis: true,
  });
  doc.font(fonts.regular).fontSize(11).fillColor("#FFFFFF");
  // Single line, ellipsised: a property display name is free text and a wrap here would push the value out
  // of the black box and onto the white page below it.
  doc.text(displayOrDash(data.propertyName), PROPERTY_BOX_LEFT + 8, HEADER_TOP + 30, {
    width: PROPERTY_BOX_WIDTH - 16,
    lineBreak: false,
    height: 14,
    ellipsis: true,
  });
  doc.restore();
}

function drawPageNumber(doc: PDFKit.PDFDocument, fonts: ReportFontSet, page: number, total: number) {
  doc.save();
  doc.font(fonts.regular).fontSize(9).fillColor(BRAND_MUTED);
  doc.text(`${page} / ${total}`, CONTENT_RIGHT - 80, PAGE_NUMBER_Y, {
    width: 80,
    align: "right",
    lineBreak: false,
    height: 12,
  });
  doc.restore();
}

function drawContactRows(
  doc: PDFKit.PDFDocument,
  fonts: ReportFontSet,
  contacts: WeeklyReportPdfContact[],
  x: number,
  top: number,
  width: number,
  pitch: number,
) {
  const labelWidth = 40;
  contacts.forEach((contact, index) => {
    const y = top + index * pitch;
    doc.font(fonts.bold).fontSize(8).fillColor(BRAND_BLACK);
    doc.text(`${contact.label}:`, x, y + 1, { width: labelWidth, lineBreak: false, height: 11, ellipsis: true });
    doc.font(fonts.regular).fontSize(9.5).fillColor(BRAND_BLACK);
    // Blank rather than a dash: RM and CM are routinely unfilled on a real project, and printing "—" four
    // times reads as missing data instead of as roles this client simply does not staff.
    doc.text(contact.name?.trim() ?? "", x + labelWidth + 4, y, {
      width: width - labelWidth - 4,
      lineBreak: false,
      height: 12,
      ellipsis: true,
    });
  });
}

// --- Page 1 --------------------------------------------------------------------------------------

function drawSummaryPage(doc: PDFKit.PDFDocument, fonts: ReportFontSet, data: WeeklyReportPdfData) {
  drawHeaderBand(doc, fonts, "Weekly Progress Summary", data);

  const textLeft = LEFT_PANEL_LEFT + PANEL_PAD;
  const textWidth = LEFT_PANEL_WIDTH - PANEL_PAD * 2;
  const issuesBoxWidth = ISSUES_PANEL_WIDTH - PANEL_PAD * 2 + 4;

  const work = splitTextAtHeight(
    boundSectionText(data.workCompleted),
    WORK_BOX_HEIGHT - 12,
    bodyMeasurer(doc, fonts, textWidth - 12),
  );
  const lookAhead = splitTextAtHeight(
    boundSectionText(data.nextWeekLookAhead),
    LOOKAHEAD_BOX_HEIGHT - 12,
    bodyMeasurer(doc, fonts, textWidth - 12),
  );
  // Measured against the ISSUES box's own width, which is less than half the width of the two boxes above
  // it. A shared measurer sized on the wide column reported a paragraph as fitting, drew it into the narrow
  // box, and the client silently lost the tail of the concerns section — the exact failure the overflow
  // pages exist to prevent, reintroduced by measuring the wrong rectangle.
  const issues = splitTextAtHeight(
    boundSectionText(data.issuesConcerns),
    ISSUES_BOX_HEIGHT - 12,
    bodyMeasurer(doc, fonts, issuesBoxWidth - 12),
  );

  drawPanel(doc, LEFT_PANEL_LEFT, BODY_TOP, LEFT_PANEL_WIDTH, BODY_BOTTOM - BODY_TOP);
  drawUnderlinedHeading(doc, fonts, "Work Completed / In-Progress", textLeft, BODY_TOP + 14, 13, textWidth);
  drawTextBox(doc, fonts, work.head, textLeft, WORK_BOX_TOP, textWidth, WORK_BOX_HEIGHT);
  drawUnderlinedHeading(doc, fonts, "Next Week Look Ahead:", textLeft, 272, 13, textWidth);
  drawTextBox(doc, fonts, lookAhead.head, textLeft, LOOKAHEAD_BOX_TOP, textWidth, LOOKAHEAD_BOX_HEIGHT);

  // --- Right column: client, client team, T-Rock team --------------------------------------------
  drawPanel(doc, RIGHT_PANEL_LEFT, BODY_TOP, RIGHT_PANEL_WIDTH, BODY_BOTTOM - BODY_TOP);
  const rightLeft = RIGHT_PANEL_LEFT + PANEL_PAD;
  const rightWidth = RIGHT_PANEL_WIDTH - PANEL_PAD * 2;
  drawUnderlinedHeading(doc, fonts, "Client:", rightLeft, BODY_TOP + 14, 12, rightWidth);
  doc.font(fonts.regular).fontSize(10).fillColor(BRAND_BLACK);
  doc.text(displayOrDash(data.clientName), rightLeft + 10, BODY_TOP + 36, {
    width: rightWidth - 10,
    height: 26,
    ellipsis: true,
  });

  drawUnderlinedHeading(doc, fonts, "Client Team:", rightLeft, BODY_TOP + 70, 12, rightWidth);
  drawContactRows(doc, fonts, data.clientTeam, rightLeft, BODY_TOP + 94, rightWidth, 18);

  drawUnderlinedHeading(doc, fonts, "T-Rock Project Team:", rightLeft, BODY_TOP + 176, 12, rightWidth);
  drawContactRows(doc, fonts, data.trockTeam, rightLeft, BODY_TOP + 200, rightWidth, 18);

  if (data.version > 1) {
    doc.save();
    doc.font(fonts.bold).fontSize(8.5).fillColor(BRAND_RED);
    doc.text(`Revision ${data.version}`, rightLeft, BODY_BOTTOM - 22, {
      width: rightWidth,
      lineBreak: false,
      height: 12,
      ellipsis: true,
    });
    doc.restore();
  }

  // --- Footer row: issues, schedule, duration ----------------------------------------------------
  drawPanel(doc, CONTENT_LEFT, FOOTER_ROW_TOP, ISSUES_PANEL_WIDTH, FOOTER_ROW_BOTTOM - FOOTER_ROW_TOP);
  drawUnderlinedHeading(
    doc,
    fonts,
    "Issues/Concerns:",
    CONTENT_LEFT + PANEL_PAD,
    FOOTER_ROW_TOP + 12,
    12,
    ISSUES_PANEL_WIDTH - PANEL_PAD * 2,
  );
  drawTextBox(doc, fonts, issues.head, CONTENT_LEFT + PANEL_PAD - 2, ISSUES_BOX_TOP, issuesBoxWidth, ISSUES_BOX_HEIGHT);

  drawPanel(
    doc,
    SCHEDULE_PANEL_LEFT,
    FOOTER_ROW_TOP,
    CONTENT_RIGHT - SCHEDULE_PANEL_LEFT,
    FOOTER_ROW_BOTTOM - FOOTER_ROW_TOP,
  );
  const scheduleLeft = SCHEDULE_PANEL_LEFT + PANEL_PAD;
  drawUnderlinedHeading(doc, fonts, "Project Schedule", scheduleLeft, FOOTER_ROW_TOP + 12, 12, 200);
  const scheduleRows: Array<[string, string]> = [
    ["Contract Date", data.schedule.contractDate],
    ["Project Start Date", data.schedule.projectStartDate],
    ["Project Completion Date", data.schedule.projectCompletionDate],
    ["Current Project Completion %", data.schedule.completionPercent],
    ["Total Project Weather Delays", data.schedule.weatherDelayDays],
  ];
  scheduleRows.forEach(([label, value], index) => {
    const y = FOOTER_ROW_TOP + 38 + index * SCHEDULE_ROW_PITCH;
    doc.font(fonts.regular).fontSize(9.5).fillColor(BRAND_BLACK);
    doc.text(label, scheduleLeft, y, { width: 168, lineBreak: false, height: 12, ellipsis: true });
    doc.font(fonts.bold).fontSize(9.5).fillColor(BRAND_BLACK);
    doc.text(value, scheduleLeft + 172, y, { width: 92, lineBreak: false, height: 12, ellipsis: true });
  });

  drawUnderlinedHeading(
    doc,
    fonts,
    "Project Duration (weeks)",
    DURATION_COLUMN_LEFT,
    FOOTER_ROW_TOP + 12,
    12,
    CONTENT_RIGHT - 12 - DURATION_COLUMN_LEFT,
  );
  const projected = data.duration.projectedWeeks;
  const remaining = data.duration.remainingWeeks;
  doc.font(fonts.regular).fontSize(10).fillColor(BRAND_BLACK);
  doc.text("Projected", DURATION_COLUMN_LEFT, FOOTER_ROW_TOP + 44, { width: 62, lineBreak: false, height: 12 });
  drawDurationArrow(doc, fonts, DURATION_BAR_LEFT, FOOTER_ROW_TOP + 40, DURATION_BAR_MAX_WIDTH, BRAND_BLACK, projected);
  doc.font(fonts.regular).fontSize(10).fillColor(BRAND_BLACK);
  doc.text("Remaining", DURATION_COLUMN_LEFT, FOOTER_ROW_TOP + 74, { width: 62, lineBreak: false, height: 12 });
  // Scaled against the projected duration, so the two bars are readable side by side as a fraction of the
  // job. With no projected duration to scale against, the remaining bar is drawn at full width rather than
  // at the minimum — a minimum-width bar would read as "nearly finished" when the truth is "unknown".
  const remainingWidth =
    projected && projected > 0 && remaining != null
      ? (Math.min(remaining, projected) / projected) * DURATION_BAR_MAX_WIDTH
      : DURATION_BAR_MAX_WIDTH;
  drawDurationArrow(doc, fonts, DURATION_BAR_LEFT, FOOTER_ROW_TOP + 70, remainingWidth, BRAND_RED, remaining);

  return {
    workCompleted: work.rest,
    nextWeekLookAhead: lookAhead.rest,
    issuesConcerns: issues.rest,
  };
}

// --- Continuation page(s) ------------------------------------------------------------------------

const CONTINUATION_TOP = 96;
const CONTINUATION_BOTTOM = 560;
/** Heading height plus the gap under its rule, reserved above every continued section's text. */
const HEADING_BLOCK = 26;
const SECTION_GAP = 18;

/**
 * Whatever did not fit page 1's fixed boxes, under its own heading.
 *
 * Returns the number of pages drawn so the caller's page accounting stays exact — every addPage() here is
 * counted by the same loop that numbers the footers.
 */
function drawOverflowPages(
  doc: PDFKit.PDFDocument,
  fonts: ReportFontSet,
  data: WeeklyReportPdfData,
  overflow: { workCompleted: string; nextWeekLookAhead: string; issuesConcerns: string },
): number {
  const sections: Array<[string, string]> = [
    ["Work Completed / In-Progress (continued)", overflow.workCompleted],
    ["Next Week Look Ahead (continued)", overflow.nextWeekLookAhead],
    ["Issues/Concerns (continued)", overflow.issuesConcerns],
  ];
  const pending = sections.filter(([, text]) => text.trim().length > 0);
  if (pending.length === 0) return 0;

  const measure = bodyMeasurer(doc, fonts, CONTENT_WIDTH - 24);

  let pages = 0;
  let cursor = CONTINUATION_BOTTOM; // > the bottom, so the first section always opens a page
  const startPage = () => {
    doc.addPage();
    pages += 1;
    drawHeaderBand(doc, fonts, "Weekly Progress Summary", data);
    cursor = CONTINUATION_TOP;
  };

  for (const [heading, text] of pending) {
    // Chunked against the height a section gets on a FRESH page, so no chunk can be too tall to place.
    for (const chunk of paginateTextByHeight(text, CONTINUATION_BOTTOM - CONTINUATION_TOP - HEADING_BLOCK, measure)) {
      const needed = HEADING_BLOCK + measure(chunk);
      // Sections are PACKED down the page rather than each taking one of their own. Three short overflows
      // would otherwise produce three near-empty sheets, and a client counting "1 / 6" on a weekly update
      // reasonably concludes something has gone wrong with it.
      if (cursor + needed > CONTINUATION_BOTTOM) startPage();
      drawUnderlinedHeading(doc, fonts, heading, CONTENT_LEFT + 12, cursor, 12, CONTENT_WIDTH - 24);
      doc.font(fonts.regular).fontSize(BODY_FONT_SIZE).fillColor(BRAND_BLACK);
      // The height cap is a backstop: paginateTextByHeight already sized the chunk, and without it pdfkit
      // could auto-create a page outside this function's own page count.
      doc.text(chunk, CONTENT_LEFT + 12, cursor + HEADING_BLOCK, {
        width: CONTENT_WIDTH - 24,
        height: CONTINUATION_BOTTOM - cursor - HEADING_BLOCK,
        lineGap: BODY_LINE_GAP,
      });
      cursor += needed + SECTION_GAP;
    }
  }
  return pages;
}

// --- Photo sheets --------------------------------------------------------------------------------

async function drawPhotoCell(
  doc: PDFKit.PDFDocument,
  fonts: ReportFontSet,
  photo: WeeklyReportPdfPhoto,
  x: number,
  y: number,
) {
  doc.save();
  doc.rect(x, y, PHOTO_CELL_WIDTH, PHOTO_CELL_HEIGHT).lineWidth(0.8).strokeColor(BRAND_BORDER).stroke();
  doc.restore();

  const imageWidth = PHOTO_CELL_WIDTH - PHOTO_CELL_PAD * 2;
  const imageHeight = PHOTO_CELL_HEIGHT - PHOTO_CAPTION_HEIGHT - PHOTO_CELL_PAD * 2;

  const buffer = await loadPhotoBuffer(
    {
      id: photo.fileId,
      displayName: photo.fileId,
      description: photo.caption,
      takenAt: null,
      createdAt: new Date().toISOString(),
      uploaderName: "",
      projectName: "",
      tags: [],
      r2Key: photo.r2Key,
      externalUrl: photo.externalUrl,
      externalThumbnailUrl: photo.externalThumbnailUrl,
      mimeType: photo.mimeType,
    },
    undefined,
  );
  const opened = buffer ? openImageForLayout(doc, buffer, { id: photo.fileId, displayName: photo.fileId }) : null;

  let drew = false;
  if (opened) {
    // Contain, not cover. A progress photo cropped to fill the cell can lose the very thing it was taken
    // to show, and the client has no way to tell that happened.
    const scale = Math.min(imageWidth / opened.displayWidth, imageHeight / opened.displayHeight);
    const drawWidth = opened.displayWidth * scale;
    const drawHeight = opened.displayHeight * scale;
    const drawLeft = x + PHOTO_CELL_PAD + (imageWidth - drawWidth) / 2;
    const drawTop = y + PHOTO_CELL_PAD + (imageHeight - drawHeight) / 2;
    // save/clip outside the try, restore in `finally`: a throw from doc.image would otherwise leave the
    // clipping path on the graphics stack and crop everything drawn after it, on every following page.
    doc.save();
    doc.rect(x + PHOTO_CELL_PAD, y + PHOTO_CELL_PAD, imageWidth, imageHeight).clip();
    try {
      doc.image(opened.image as unknown as Buffer, drawLeft, drawTop, { width: drawWidth, height: drawHeight });
      drew = true;
    } catch (error) {
      console.warn("[weekly-report-pdf] could not embed a photo; drawing the placeholder", {
        fileId: photo.fileId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      doc.restore();
    }
  }
  if (!drew) {
    doc.save();
    doc.fillColor(BRAND_MUTED).font(fonts.bold).fontSize(9);
    doc.text("Image unavailable", x + PHOTO_CELL_PAD, y + PHOTO_CELL_PAD + imageHeight / 2 - 6, {
      width: imageWidth,
      align: "center",
      lineBreak: false,
      height: 12,
    });
    doc.restore();
  }

  const caption = photo.caption?.trim();
  if (caption) {
    doc.save();
    doc.font(fonts.regular).fontSize(PHOTO_CAPTION_FONT_SIZE).fillColor(BRAND_BLACK);
    doc.text(caption, x + PHOTO_CELL_PAD, y + PHOTO_CELL_HEIGHT - PHOTO_CAPTION_HEIGHT - 2, {
      width: imageWidth,
      align: "center",
      height: PHOTO_CAPTION_HEIGHT,
      lineGap: 1,
      ellipsis: true,
    });
    doc.restore();
  }
}

function chunkPhotos(photos: WeeklyReportPdfPhoto[]): WeeklyReportPdfPhoto[][] {
  const pages: WeeklyReportPdfPhoto[][] = [];
  for (let index = 0; index < photos.length; index += WEEKLY_REPORT_PHOTOS_PER_PAGE) {
    pages.push(photos.slice(index, index + WEEKLY_REPORT_PHOTOS_PER_PAGE));
  }
  return pages;
}

/**
 * How many pages a given report renders to, without rendering it.
 *
 * Exported because it is the one piece of the page count that is decided by DATA rather than by layout —
 * the overflow pages are not, so this is a floor, not a promise.
 */
export function weeklyReportPhotoPageCount(photoCount: number): number {
  return Math.ceil(photoCount / WEEKLY_REPORT_PHOTOS_PER_PAGE);
}

// --- Entry point ---------------------------------------------------------------------------------

export async function renderWeeklyReportPdf(data: WeeklyReportPdfData): Promise<Buffer> {
  const doc = new PDFDocument({
    autoFirstPage: true,
    bufferPages: true,
    size: [PAGE_WIDTH, PAGE_HEIGHT],
    // Zero margins: every coordinate here is absolute, and a non-zero bottom margin makes pdfkit
    // auto-page-break on a draw near the page foot — the blank-page bug pdf-layout.ts documents.
    margin: 0,
    // See WeeklyReportPdfData.creationDate: this is what makes the render byte-reproducible, and therefore
    // what makes the content-addressed key address content rather than the clock.
    info: { CreationDate: data.creationDate },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  const fonts = registerReportFonts(doc);

  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill("#FFFFFF");
  const overflow = drawSummaryPage(doc, fonts, data);
  drawOverflowPages(doc, fonts, data, overflow);

  for (const pagePhotos of chunkPhotos(data.photos)) {
    doc.addPage();
    drawHeaderBand(doc, fonts, "Weekly Progress Photos", data);
    for (const [cellIndex, photo] of pagePhotos.entries()) {
      const column = cellIndex % PHOTO_COLUMNS;
      const row = Math.floor(cellIndex / PHOTO_COLUMNS);
      await drawPhotoCell(
        doc,
        fonts,
        photo,
        CONTENT_LEFT + column * (PHOTO_CELL_WIDTH + PHOTO_COLUMN_GAP),
        PHOTO_GRID_TOP + row * (PHOTO_CELL_HEIGHT + PHOTO_ROW_GAP),
      );
    }
  }

  // Numbered in a second pass so "1 / 4" is right on page 1 — the total is not known until every photo
  // sheet and overflow page has been drawn.
  const range = doc.bufferedPageRange();
  for (let pageIndex = 0; pageIndex < range.count; pageIndex += 1) {
    doc.switchToPage(pageIndex);
    drawPageNumber(doc, fonts, pageIndex + 1, range.count);
  }

  doc.end();
  return await new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}
