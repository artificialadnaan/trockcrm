import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import PDFDocument from "pdfkit";
import {
  WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS,
  WEEKLY_REPORT_SECTION_MAX_CHARS,
} from "@trock-crm/shared/types";
import { registerReportFonts } from "../field/pdf-layout.js";
import {
  PHOTO_CAPTION_MAX_HEIGHT,
  WEEKLY_REPORT_PHOTOS_PER_PAGE,
  WEEKLY_REPORT_SUPERSEDED_NOTICE,
  boundWeeklyReportPhotoCaption,
  boundWeeklyReportSectionText,
  formatWeeklyReportDate,
  photoCaptionBandHeight,
  renderWeeklyReportPdf,
  splitTextAtHeight,
  weeklyReportPhotoPageCount,
  weeklyReportRenderTimeoutMs,
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
    superseded: false,
    creationDate: CREATION_DATE,
    ...overrides,
  };
}

/**
 * How many text runs the document draws, read out of its own content streams.
 *
 * NOT the strings themselves: the Geist fonts are embedded as subsets, so every glyph is a subset index
 * and the readable text simply is not in the file. Counting the `TJ` operators is the honest structural
 * question — "did the renderer put something more on the page?" — and it is what a stamp that is missing
 * entirely fails. Streams are Flate-compressed, so searching the raw bytes finds nothing and an assertion
 * written that way would pass for the wrong reason.
 */
function pdfTextRuns(pdf: Buffer): number {
  const raw = pdf.toString("latin1");
  let runs = 0;
  const streams = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (let match = streams.exec(raw); match; match = streams.exec(raw)) {
    let body: string;
    try {
      body = inflateSync(Buffer.from(match[1], "latin1")).toString("latin1");
    } catch {
      continue; // not a Flate content stream (an embedded image, a font file)
    }
    runs += body.match(/\]\s*TJ/g)?.length ?? 0;
  }
  return runs;
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

  it("keeps flowing a section past the old 6,000-character cap instead of truncating it", async () => {
    // The defect this closes: the renderer stopped at 6,000 characters and printed "… (continued in the
    // CRM)". The client's page has no cap and prints all 20,000, so the two surfaces a client compares side
    // by side disagreed — and the marker pointed a CLIENT at a system they have no account for.
    //
    // Asserted as a DIFFERENCE between two lengths rather than an absolute page count. Under the old cap
    // both of these truncated to the same 6,000 characters and rendered to the same number of pages, so
    // this comparison is exactly what the bug defeats.
    const section = (chars: number) => {
      let text = "";
      for (let i = 0; text.length < chars; i += 1) text += `- Bullet ${i} describing work carried out on site\n`;
      return text.slice(0, chars);
    };
    const atOldCap = pdfPageCount(await renderWeeklyReportPdf(data({ workCompleted: section(6_000) })));
    const wellPast = pdfPageCount(await renderWeeklyReportPdf(data({ workCompleted: section(18_000) })));
    expect(wellPast).toBeGreaterThan(atOldCap);
  });

  it("bounds both surfaces at exactly the limit the API enforces", () => {
    // Shared with the public web page, which calls this same helper. A cap on one surface only is how the
    // two came to disagree in the first place.
    const atLimit = "x".repeat(WEEKLY_REPORT_SECTION_MAX_CHARS);
    expect(boundWeeklyReportSectionText(atLimit)).toBe(atLimit);

    const overLimit = "y".repeat(WEEKLY_REPORT_SECTION_MAX_CHARS + 1);
    const bounded = boundWeeklyReportSectionText(overLimit);
    // Whatever the backstop says, it must not send a client to a system they have no account for.
    expect(bounded).not.toContain("CRM");
    expect(bounded).toContain("y".repeat(100));
  });

  it("stamps a superseded report inside the DOCUMENT, not only on the page it came from", async () => {
    // A PDF is the half of this report that gets forwarded, printed and filed. A client reading a detached
    // copy has nothing but the document itself to tell them a corrected version was issued after it.
    const stamped = await renderWeeklyReportPdf(data({ superseded: true }));
    const plain = await renderWeeklyReportPdf(data());
    expect(pdfTextRuns(stamped)).toBeGreaterThan(pdfTextRuns(plain));
    // …and it is the whole sentence, not an ellipsised fragment: the notice wraps over several lines of
    // the right panel, so the extra runs are more than the one a single clipped line would add.
    expect(pdfTextRuns(stamped) - pdfTextRuns(plain)).toBeGreaterThan(1);
    expect(WEEKLY_REPORT_SUPERSEDED_NOTICE).toContain("newer version");
  });

  it("keeps the superseded stamp off the page count", async () => {
    // Drawn into the free strip at the foot of the right panel. A stamp that pushed the layout would turn
    // the one-page summary this format exists to be into two.
    expect(pdfPageCount(await renderWeeklyReportPdf(data({ superseded: true })))).toBe(1);
  });

  it("survives a property name long enough to wrap out of its box", async () => {
    const pdf = await renderWeeklyReportPdf(data({ propertyName: "X".repeat(500) }));
    // Single-line + ellipsis everywhere it is printed, so it can never push the black header box down the
    // page or spawn an overflow sheet of its own.
    expect(pdfPageCount(pdf)).toBe(1);
  });
});

describe("photo captions", () => {
  /** A real document with the shipped Geist registered — the only way to measure what will be drawn. */
  function measuringDoc() {
    const doc = new PDFDocument({ size: [792, 612], margin: 0 });
    doc.on("data", () => {});
    return { doc, fonts: registerReportFonts(doc) };
  }

  it("bounds both surfaces at exactly the limit the API enforces", () => {
    // The section helper's twin, and the gap this closes: the API accepted 500 characters while the PDF
    // drew the caption into a fixed two-line box with `ellipsis: true`, so a long caption printed in full
    // on the client's web page and truncated in the PDF attached to the same email.
    const atLimit = "x".repeat(WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS);
    expect(boundWeeklyReportPhotoCaption(atLimit)).toBe(atLimit);

    const overLimit = "y".repeat(WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS + 40);
    const bounded = boundWeeklyReportPhotoCaption(overLimit)!;
    expect(bounded.length).toBeLessThanOrEqual(WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS + 1);
    expect(bounded.endsWith("…")).toBe(true);

    // "No caption" stays distinguishable from "an empty caption": the page omits the <figcaption> entirely.
    expect(boundWeeklyReportPhotoCaption("   ")).toBeNull();
    expect(boundWeeklyReportPhotoCaption(null)).toBeNull();
  });

  it("gives every bounded caption room to print IN FULL, worst case included", () => {
    // THE property that makes the two surfaces agree, measured against the shipped font rather than
    // assumed. The band is min(measured, PHOTO_CAPTION_MAX_HEIGHT); if the measurement could exceed the
    // ceiling the clamp would bind, `ellipsis: true` would fire, and the PDF would once again say less
    // than the page. "W" is the widest glyph Geist has at this size, so this is the true upper bound —
    // it fails if the character limit is raised or the band is shrunk without the other moving.
    const { doc, fonts } = measuringDoc();
    const worstCase = boundWeeklyReportPhotoCaption("W".repeat(WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS))!;
    expect(photoCaptionBandHeight(doc, fonts, worstCase)).toBeLessThan(PHOTO_CAPTION_MAX_HEIGHT);
    doc.end();
  });

  it("takes only the room the caption needs, so a short one leaves the photograph the cell", () => {
    // The band used to be a flat 24pt whatever the caption said. Adapting it is what buys the space a
    // long caption needs without charging every other photo for it.
    const { doc, fonts } = measuringDoc();
    const none = photoCaptionBandHeight(doc, fonts, null);
    const short = photoCaptionBandHeight(doc, fonts, "Balcony mock-up complete");
    const long = photoCaptionBandHeight(doc, fonts, "W".repeat(WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS));
    expect(none).toBe(0);
    expect(short).toBeLessThan(24);
    expect(long).toBeGreaterThan(short);
    doc.end();
  });

  it("prints more of a long caption than the old two-line box could hold", async () => {
    // Read off the CONTENT STREAMS rather than the page count: a caption never changes how many pages a
    // photo sheet is, so a page-count assertion here would pass with the truncation still in place.
    const long = "Balcony mock-up complete on the north elevation, waterproofing membrane inspected and signed off by the third-party consultant ahead of tile.";
    const withLongCaption = await renderWeeklyReportPdf(
      data({ photos: [{ ...photos(1)[0]!, caption: long }] }),
    );
    const withShortCaption = await renderWeeklyReportPdf(
      data({ photos: [{ ...photos(1)[0]!, caption: "Balcony" }] }),
    );
    // Each drawn line is its own text run, so a caption printed over several lines shows up as several.
    expect(pdfTextRuns(withLongCaption)).toBeGreaterThan(pdfTextRuns(withShortCaption) + 1);
  });
});

describe("the render budget", () => {
  it("scales with the photo count instead of giving sixty photos what one gets", () => {
    // A render is all-or-nothing: the deadline firing on photo 50 throws away the 49 already fetched and
    // transcoded and stores nothing, so a flat budget does not degrade a big report, it makes it
    // permanently undownloadable. Measured at ~370ms of transcode per 12MP original before any network.
    expect(weeklyReportRenderTimeoutMs(60)).toBeGreaterThan(weeklyReportRenderTimeoutMs(1));
    expect(weeklyReportRenderTimeoutMs(60)).toBeGreaterThan(60_000);
    // …and is still bounded, because the socket on the other end is anonymous.
    expect(weeklyReportRenderTimeoutMs(10_000)).toBe(weeklyReportRenderTimeoutMs(60_000));
    // Degenerate inputs cannot produce a zero or negative deadline, which would abort instantly.
    expect(weeklyReportRenderTimeoutMs(0)).toBeGreaterThan(0);
    expect(weeklyReportRenderTimeoutMs(-5)).toBeGreaterThan(0);
    expect(weeklyReportRenderTimeoutMs(Number.NaN)).toBeGreaterThan(0);
  });
});
