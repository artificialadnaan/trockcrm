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

  it("splits a single word taller than the budget across pages so NO chunk exceeds it", () => {
    const pages = paginateTextByHeight("supercalifragilistic tiny", 5, byLength);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(5);
    // the 20-char word is broken by character (4 x 5) across pages, then the short word follows
    expect(pages.slice(0, 4).join("")).toBe("supercalifragilistic");
    expect(pages).toContain("tiny");
  });

  it("breaks an over-tall space-less blob into budget-sized character slices without losing content", () => {
    const blob = "x".repeat(500);
    const pages = paginateTextByHeight(blob, 100, byLength);
    expect(pages.length).toBe(5);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(100);
    expect(pages.join("")).toBe(blob);
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

  it("renders a space-less blob summary without spawning rogue (footer-less) pages", async () => {
    const buffer = await renderFieldPhotoReportPdf({
      cover,
      sections: [],
      // ~5000 chars, no spaces — the pathological case that would char-wrap far past one page.
      executiveSummary: "A1b2C3d4E5f6G7h8".repeat(312),
    });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // paginateTextByHeight splits the blob and doc.text is height-capped, so the page count is small and
    // finite (cover + a few summary pages) — not an auto-paginated explosion outside the footer accounting.
    const pages = countPdfPages(buffer);
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(pages).toBeLessThan(12);
  });
});

// Count physical page objects in a pdfkit buffer. `/Type /Page` (word-boundary after "Page") matches
// only leaf page objects, never the single `/Type /Pages` tree node.
function countPdfPages(buffer: Buffer): number {
  return (buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
}
