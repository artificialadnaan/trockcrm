import { describe, it, expect } from "vitest";
import { paginateTextByHeight, renderFieldPhotoReportPdf, type ReportCoverData } from "./pdf-layout.js";

// A deterministic stand-in for pdfkit's heightOfString: one height unit per character. Lets the tests
// force page breaks at a known budget without a real PDFDocument.
const byLength = (chunk: string) => chunk.length;

describe("paginateTextByHeight", () => {
  it("returns an empty array for blank or whitespace-only text", () => {
    expect(paginateTextByHeight("", 100, byLength)).toEqual([]);
    expect(paginateTextByHeight("   \n  \t ", 100, byLength)).toEqual([]);
  });

  it("returns a single page when the whole text fits the height budget", () => {
    expect(paginateTextByHeight("hello world", 100, byLength)).toEqual(["hello world"]);
  });

  it("splits into multiple pages without dropping or reordering words", () => {
    const text = "alpha beta gamma delta epsilon";
    const pages = paginateTextByHeight(text, 12, byLength);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(12);
    // Every word survives, in order.
    expect(pages.join(" ").split(/\s+/)).toEqual(text.split(" "));
  });

  it("keeps a single over-long word on its own page so pagination always makes progress", () => {
    const pages = paginateTextByHeight("supercalifragilistic tiny", 5, byLength);
    expect(pages[0]).toBe("supercalifragilistic");
    expect(pages).toContain("tiny");
  });

  it("preserves paragraph breaks within a page", () => {
    expect(paginateTextByHeight("one\ntwo", 100, byLength)).toEqual(["one\ntwo"]);
  });
});

const cover: ReportCoverData = {
  reportTitle: "Maple Street Tower Photo Report",
  creatorName: "Sam Super",
  companyName: "TRock Construction",
  reportDateLabel: "June 30, 2026",
  projectName: "Maple Street Tower",
  photoCount: 0,
};

describe("renderFieldPhotoReportPdf executive summary", () => {
  it("renders a valid, non-empty PDF with no summary", async () => {
    const buffer = await renderFieldPhotoReportPdf({ cover, sections: [] });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it("produces a larger document when an executive summary is present", async () => {
    const withoutSummary = await renderFieldPhotoReportPdf({ cover, sections: [] });
    const withSummary = await renderFieldPhotoReportPdf({
      cover,
      sections: [],
      // long enough to flow across more than one page
      executiveSummary: "The project reached substantial completion ahead of schedule. ".repeat(120),
    });
    expect(withSummary.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(withSummary.length).toBeGreaterThan(withoutSummary.length);
  });

  it("adds no summary page for blank text", async () => {
    const none = await renderFieldPhotoReportPdf({ cover, sections: [] });
    const blank = await renderFieldPhotoReportPdf({ cover, sections: [], executiveSummary: "   \n  " });
    expect(blank.length).toBe(none.length);
  });
});
