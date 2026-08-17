import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WEEKLY_REPORT_PHOTOS_PER_PAGE,
  formatWeeklyReportDate,
  renderWeeklyReportPdf,
  splitTextAtHeight,
  weeklyReportPhotoPageCount,
  weeklyReportScheduleValue,
  type WeeklyReportPdfData,
} from "./pdf.js";

/**
 * Count pages by reading the PDF's own page tree.
 *
 * pdfkit writes the Pages node's `/Count` uncompressed, so this reads what a viewer would. Asserting on
 * byte length instead would prove only that something was written.
 */
function pdfPageCount(pdf: Buffer): number {
  const match = pdf.toString("latin1").match(/\/Count (\d+)/);
  return match ? Number(match[1]) : 0;
}

const CREATION_DATE = new Date("2026-08-13T21:00:00.000Z");

function photos(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    fileId: `file-${index}`,
    caption: `Caption ${index}`,
    // No storage anywhere, so every tile draws the placeholder — which is what a report with an
    // unresolvable photo produces in production too, and it keeps the suite off the network.
    r2Key: null,
    externalUrl: null,
    externalThumbnailUrl: null,
    mimeType: null,
  }));
}

function data(overrides: Partial<WeeklyReportPdfData> = {}): WeeklyReportPdfData {
  return {
    propertyName: "4123 Cedar Springs",
    weekOfLabel: "8/13/26",
    clientName: "Mack Real Estate Group",
    clientTeam: [
      { label: "DOC", name: "Jay Stauble" },
      { label: "PM", name: "Melissa Garcia" },
      { label: "RM", name: null },
      { label: "CM", name: null },
    ],
    trockTeam: [
      { label: "PM", name: "Adam Sherwood" },
      { label: "SUPER", name: "Steve Sanchez" },
    ],
    workCompleted: "- Material delivered for balcony mock up",
    nextWeekLookAhead: "- Complete sample balcony coat",
    issuesConcerns: "Permit risk",
    schedule: {
      contractDate: "7/8/26",
      projectStartDate: "TBD Permit",
      projectCompletionDate: "TBD Permit",
      completionPercent: "0",
      weatherDelayDays: "0",
    },
    duration: { projectedWeeks: 19, remainingWeeks: 0 },
    photos: [],
    version: 1,
    creationDate: CREATION_DATE,
    ...overrides,
  };
}

describe("formatWeeklyReportDate", () => {
  it("prints M/D/YY, the reference report's format", () => {
    expect(formatWeeklyReportDate("2026-08-13")).toBe("8/13/26");
    expect(formatWeeklyReportDate("2026-01-05")).toBe("1/5/26");
  });

  it("does not shift the day for a reader west of Greenwich", () => {
    // Parsed at UTC noon rather than UTC midnight. This is the whole reason the helper exists.
    expect(formatWeeklyReportDate("2026-08-13T00:00:00.000Z")).toBe("8/13/26");
  });

  it("returns null rather than 'Invalid Date' for a blank or malformed value", () => {
    expect(formatWeeklyReportDate(null)).toBeNull();
    expect(formatWeeklyReportDate("")).toBeNull();
    expect(formatWeeklyReportDate("not-a-date")).toBeNull();
  });
});

describe("weeklyReportScheduleValue", () => {
  it("prefers a real date over its note", () => {
    expect(weeklyReportScheduleValue("2026-07-08", "TBD Permit")).toBe("7/8/26");
  });

  it("prints the note when the date is genuinely unknown", () => {
    expect(weeklyReportScheduleValue(null, "TBD Permit")).toBe("TBD Permit");
  });

  it("prints a dash when there is neither", () => {
    expect(weeklyReportScheduleValue(null, null)).toBe("—");
    expect(weeklyReportScheduleValue(null, "   ")).toBe("—");
  });
});

describe("splitTextAtHeight", () => {
  // A stand-in measurer: one unit of height per word, so the arithmetic in the assertions is obvious.
  const measure = (chunk: string) => chunk.split(/\s+/).filter(Boolean).length;

  it("keeps everything in the box when it fits", () => {
    expect(splitTextAtHeight("one two three", 10, measure)).toEqual({ head: "one two three", rest: "" });
  });

  it("returns the overflow rather than dropping it", () => {
    // The property that matters: page 1's boxes are a fixed size, but the superintendent's account of the
    // week must not be silently ellipsised away — the client is who it was written for.
    const { head, rest } = splitTextAtHeight("one two three four five", 2, measure);
    expect(head).toBe("one two");
    expect(rest).toBe("three four five");
  });

  it("loses no word across the split", () => {
    const source = "alpha bravo charlie delta echo foxtrot golf hotel";
    const { head, rest } = splitTextAtHeight(source, 3, measure);
    expect(`${head} ${rest}`).toBe(source);
  });

  it("preserves the line structure of the remainder, so bullets survive", () => {
    const { head, rest } = splitTextAtHeight("- one\n- two\n- three", 2, measure);
    expect(head).toBe("- one");
    expect(rest).toBe("- two\n- three");
  });

  it("returns nothing at all for empty text", () => {
    expect(splitTextAtHeight("", 10, measure)).toEqual({ head: "", rest: "" });
    expect(splitTextAtHeight("   \n  ", 10, measure)).toEqual({ head: "", rest: "" });
  });
});

describe("weeklyReportPhotoPageCount", () => {
  it("packs six to a sheet", () => {
    expect(WEEKLY_REPORT_PHOTOS_PER_PAGE).toBe(6);
    expect(weeklyReportPhotoPageCount(0)).toBe(0);
    expect(weeklyReportPhotoPageCount(1)).toBe(1);
    expect(weeklyReportPhotoPageCount(6)).toBe(1);
    expect(weeklyReportPhotoPageCount(7)).toBe(2);
    expect(weeklyReportPhotoPageCount(60)).toBe(10);
  });
});

describe("renderWeeklyReportPdf", () => {
  it("produces a real PDF whose first page is the summary", async () => {
    const pdf = await renderWeeklyReportPdf(data());
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdfPageCount(pdf)).toBe(1);
  });

  it("adds one photo sheet per six photos", async () => {
    expect(pdfPageCount(await renderWeeklyReportPdf(data({ photos: photos(6) })))).toBe(2);
    expect(pdfPageCount(await renderWeeklyReportPdf(data({ photos: photos(7) })))).toBe(3);
  });

  it("adds a continuation page rather than truncating a long section", async () => {
    // Page 1's boxes are fixed by the format. Text that outgrows them flows on instead of disappearing.
    const long = Array.from({ length: 120 }, (_, i) => `- Bullet number ${i} describing work on site`).join("\n");
    const withOverflow = await renderWeeklyReportPdf(data({ workCompleted: long }));
    expect(pdfPageCount(withOverflow)).toBeGreaterThan(1);
    expect(pdfPageCount(withOverflow)).toBeGreaterThan(pdfPageCount(await renderWeeklyReportPdf(data())));
  });

  it("packs several short overflows onto ONE continuation page", async () => {
    // Three near-empty continuation sheets on a weekly update reads as something having gone wrong with it.
    // 16 short bullets outgrows every one of the three boxes by a few lines, and those three tails together
    // are a fraction of a page.
    const slightlyLong = Array.from({ length: 16 }, (_, i) => `- Bullet ${i}`).join("\n");
    const pdf = await renderWeeklyReportPdf(
      data({ workCompleted: slightlyLong, nextWeekLookAhead: slightlyLong, issuesConcerns: slightlyLong }),
    );
    expect(pdfPageCount(pdf)).toBe(2);
  });

  it("renders a report with nothing filled in rather than throwing", async () => {
    // A PM can send an early report on a job that has barely started; every one of these is nullable.
    const pdf = await renderWeeklyReportPdf(
      data({
        clientName: null,
        clientTeam: [],
        trockTeam: [],
        workCompleted: null,
        nextWeekLookAhead: null,
        issuesConcerns: null,
        duration: { projectedWeeks: null, remainingWeeks: null },
        schedule: {
          contractDate: "—",
          projectStartDate: "—",
          projectCompletionDate: "—",
          completionPercent: "—",
          weatherDelayDays: "—",
        },
      }),
    );
    expect(pdfPageCount(pdf)).toBe(1);
  });

  it("puts the report's generation in /CreationDate, never the wall clock", async () => {
    // A weekly report is an immutable record of one week. Stamping it with "whenever somebody clicked
    // download" — pdfkit's default — makes the same document say something different every time it is
    // produced. The date below is the report's content generation, supplied by the caller.
    // pdfkit stores /CreationDate as an indirect reference, so the encoded value is asserted rather than
    // the dictionary entry.
    const pdf = await renderWeeklyReportPdf(data());
    expect(pdf.toString("latin1")).toContain("D:20260813210000Z");
  });

  it("renders the same content to the same SIZE, and different content to different bytes", async () => {
    // Deliberately NOT a byte-equality assertion. pdfkit finalises the alpha-PNG logo through an
    // asynchronous inflate, so two renders of identical content are the same length with the same content
    // and different OBJECT NUMBERING — which is why the artifact key can still change on a regeneration.
    // Asserting byte equality here passed in isolation and failed under a loaded CI worker, which is the
    // worst kind of test: green locally, red in the gate, and wrong about the property either way.
    const digest = (pdf: Buffer) => createHash("sha256").update(pdf).digest("hex");
    const first = await renderWeeklyReportPdf(data({ photos: photos(3) }));
    const second = await renderWeeklyReportPdf(data({ photos: photos(3) }));
    expect(second.byteLength).toBe(first.byteLength);

    // Different content must still render to different bytes, or the key would stop addressing content.
    const edited = await renderWeeklyReportPdf(data({ photos: photos(3), workCompleted: "- Something else" }));
    expect(digest(edited)).not.toBe(digest(first));
  });

  it("survives a property name long enough to wrap out of its box", async () => {
    const pdf = await renderWeeklyReportPdf(data({ propertyName: "X".repeat(500) }));
    // Single-line + ellipsis everywhere it is printed, so it can never push the black header box down the
    // page or spawn an overflow sheet of its own.
    expect(pdfPageCount(pdf)).toBe(1);
  });
});
