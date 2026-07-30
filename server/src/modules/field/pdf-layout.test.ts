import { describe, it, expect, vi } from "vitest";
import {
  paginateTextByHeight,
  parseFindingText,
  renderFieldPhotoReportPdf,
  type ReportCoverData,
  type ReportRenderSection,
} from "./pdf-layout.js";

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
    // Pre-existing test, given an explicit budget for the same reason as the findings blob case below: it
    // char-slices a 5k blob through pdfkit and was already close to vitest's 5s default when this file is
    // run under the ROOT config. The findings suites added to this file share the workers, which is enough
    // contention to tip it over. server/vitest.config.ts (the gate) allows 15s, so this only ever surfaced
    // on a root-config invocation.
  }, 30_000);
});

// Count physical page objects in a pdfkit buffer. `/Type /Page` (word-boundary after "Page") matches
// only leaf page objects, never the single `/Type /Pages` tree node.
function countPdfPages(buffer: Buffer): number {
  return (buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
}

describe("parseFindingText", () => {
  it("splits a subject label from its bullets", () => {
    const parsed = parseFindingText("Stand A — 3-unit platform\n- Rust bleed below the cap flashing.\n- Deck boards show gapping.");
    expect(parsed.title).toBe("Stand A — 3-unit platform");
    expect(parsed.bulleted).toBe(true);
    expect(parsed.bodies).toEqual(["Rust bleed below the cap flashing.", "Deck boards show gapping."]);
  });

  it("accepts •, * and - as bullet markers", () => {
    expect(parseFindingText("T\n• one\n* two\n- three").bodies).toEqual(["one", "two", "three"]);
  });

  it("folds a wrapped continuation line back into the bullet it belongs to", () => {
    const parsed = parseFindingText("T\n- The rail spans a long distance\nwith no mid-span support.");
    expect(parsed.bodies).toEqual(["The rail spans a long distance with no mid-span support."]);
  });

  it("treats human prose with no markers as an untitled paragraph", () => {
    // Inferring a title here would silently promote the caption's first line into a heading.
    const parsed = parseFindingText("Cracked flashing at the northeast corner.");
    expect(parsed.title).toBeNull();
    expect(parsed.bulleted).toBe(false);
    expect(parsed.bodies).toEqual(["Cracked flashing at the northeast corner."]);
  });

  it("returns nothing renderable for blank text", () => {
    expect(parseFindingText("   \n  ").bodies).toEqual([]);
  });

  it("keeps prose sitting between the label and the first bullet", () => {
    // A crew caption can be several lines before any bullet. Dropping them silently deleted the field's
    // own words from the report.
    const parsed = parseFindingText("Roof access hatch\nNorth side, LOCKED — key with the super\n- Gutter above it is clogged.");
    expect(parsed.title).toBe("Roof access hatch");
    expect(parsed.bodies).toEqual(["North side, LOCKED — key with the super", "Gutter above it is clogged."]);
  });
});

function findingsPhoto(index: number, description: string): ReportRenderSection["photos"][number] {
  return {
    id: `photo-${index}`,
    displayName: `IMG_000${index}`,
    description,
    takenAt: null,
    createdAt: "2026-07-30T12:00:00.000Z",
    uploaderName: "Sam Super",
    projectName: "Maple Street Tower",
    tags: [],
    // No r2Key and no data: URL — loadPhotoBuffer returns null and the layout draws its
    // "Image unavailable" placeholder, so these stay pure layout tests with no R2 dependency.
    r2Key: null,
    externalUrl: null,
    externalThumbnailUrl: null,
    reportIndex: index,
  };
}

function findingsSection(count: number, description: string): ReportRenderSection {
  return {
    title: "Photo Findings",
    photos: Array.from({ length: count }, (_, i) => findingsPhoto(i + 1, description)),
  };
}

const SHORT_FINDING = "North elevation — third floor\n- Rust bleed below the cap flashing.\n- Deck boards show visible gapping.";

/**
 * Every page must have a pageMeta entry, or the footer pass skips it (or shifts footers onto the wrong
 * pages from that point on). Counting pages cannot see that, so assert on the renderer's own invariant
 * check instead — this is what makes the "no rogue pages" tests below mean something.
 */
async function renderExpectingNoDesync(input: Parameters<typeof renderFieldPhotoReportPdf>[0]): Promise<Buffer> {
  const errors: unknown[][] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
  try {
    const buffer = await renderFieldPhotoReportPdf(input);
    const desync = errors.filter((args) => String(args[0]).includes("page accounting desync"));
    expect(desync).toEqual([]);
    return buffer;
  } finally {
    spy.mockRestore();
  }
}

describe("renderFieldPhotoReportPdf findings layout", () => {
  it("gives every page a footer entry, including continuation pages", async () => {
    // The failure this guards is silent: a continuation page created without pushing its meta leaves every
    // later page's footer showing the wrong section and page number.
    const long = [
      "South stair tower",
      ...Array.from({ length: 14 }, (_, i) => `- Finding ${i + 1}: exposed rebar with active section loss and rust staining tracking down the face of the concrete along the pour joint.`),
    ].join("\n");
    await renderExpectingNoDesync({
      cover,
      sections: [{ title: "Photo Findings", photos: [findingsPhoto(1, long), findingsPhoto(2, SHORT_FINDING)] }],
      executiveSummary: "Reviewed.\n\nKey Concerns at a Glance:\n- One.",
      photoLayout: "findings",
    });
  }, 30_000);

  it("gives every page a footer entry in the grid layout too", async () => {
    await renderExpectingNoDesync({
      cover,
      sections: [findingsSection(7, SHORT_FINDING), findingsSection(2, SHORT_FINDING)],
      executiveSummary: "Reviewed.",
    });
  }, 30_000);

  it("gives each photo its own page, unlike the 3-per-page grid", async () => {
    const sections = [findingsSection(6, SHORT_FINDING)];
    const findings = await renderFieldPhotoReportPdf({ cover, sections, photoLayout: "findings" });
    const grid = await renderFieldPhotoReportPdf({ cover, sections, photoLayout: "grid" });

    // cover + one page per photo
    expect(countPdfPages(findings)).toBe(7);
    // cover + ceil(6/3) grid pages
    expect(countPdfPages(grid)).toBe(3);
  });

  it("defaults to the grid layout so existing callers are unaffected", async () => {
    const sections = [findingsSection(6, SHORT_FINDING)];
    const omitted = await renderFieldPhotoReportPdf({ cover, sections });
    const explicit = await renderFieldPhotoReportPdf({ cover, sections, photoLayout: "grid" });
    expect(countPdfPages(omitted)).toBe(countPdfPages(explicit));
  });

  it("keeps a long multi-bullet finding whole instead of ellipsising it", async () => {
    // The exact case the grid layout cannot represent: far more than its ~320-char, one-line caption clamp.
    const long = [
      "South stair tower — spalling at the slab edge",
      ...Array.from(
        { length: 12 },
        (_, i) =>
          `- Finding ${i + 1}: the exposed rebar at this location shows active section loss with rust staining tracking down the face of the concrete, and the surrounding slab edge is delaminating along roughly four feet of the pour joint.`,
      ),
    ].join("\n");
    const buffer = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Photo Findings", photos: [findingsPhoto(1, long)] }],
      photoLayout: "findings",
    });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // Overflowed onto a continuation page rather than truncating, but stayed bounded.
    const pages = countPdfPages(buffer);
    expect(pages).toBeGreaterThan(2);
    expect(pages).toBeLessThan(6);
  }, 30_000);

  it("does not spawn footer-less pages for a space-less blob finding", async () => {
    // A pathological single "word" taller than a page must be split by paginateTextByHeight rather than
    // letting pdfkit auto-paginate outside the pageMeta accounting (which desyncs every following footer).
    const buffer = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Photo Findings", photos: [findingsPhoto(1, `Blob\n- ${"A1b2C3d4".repeat(900)}`)] }],
      photoLayout: "findings",
    });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const pages = countPdfPages(buffer);
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(pages).toBeLessThan(20);
    // Explicit budget: char-slicing a 7k-char blob through pdfkit runs ~4s, which is uncomfortably close to
    // vitest's 5s default when this file is invoked from the ROOT config rather than server/vitest.config.ts
    // (15s). Pinned here so the test can't flake depending on which config picked it up.
  }, 30_000);

  it("prints a passed-over photo with no invented caption", async () => {
    // The AI writes about only the photos worth citing. A photo it passed over still prints — but must not
    // acquire a manufactured "Photo 3" heading or a "no issues found" line just to fill the space.
    const withoutText = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Photo Findings", photos: [findingsPhoto(1, "")] }],
      photoLayout: "findings",
    });
    expect(withoutText.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // Still one page for the photo itself — it is in the report, just silent.
    expect(countPdfPages(withoutText)).toBe(2);

    // And it is genuinely smaller than the same page carrying findings text.
    const withText = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Photo Findings", photos: [findingsPhoto(1, SHORT_FINDING)] }],
      photoLayout: "findings",
    });
    expect(withoutText.length).toBeLessThan(withText.length);
  });

  it("keeps a crew caption verbatim on a photo the assessment passed over", async () => {
    // parseFindingText treats marker-less prose as an untitled paragraph, so the field's own wording
    // renders as-is rather than being promoted into a heading.
    const parsed = parseFindingText("Cracked flashing at the northeast corner — already scheduled.");
    expect(parsed.title).toBeNull();
    expect(parsed.bodies).toEqual(["Cracked flashing at the northeast corner — already scheduled."]);

    const buffer = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Photo Findings", photos: [findingsPhoto(1, "Cracked flashing at the northeast corner.")] }],
      photoLayout: "findings",
    });
    expect(countPdfPages(buffer)).toBe(2);
  });

  it("renders the executive summary before the per-photo findings pages", async () => {
    const buffer = await renderFieldPhotoReportPdf({
      cover,
      sections: [findingsSection(2, SHORT_FINDING)],
      executiveSummary: "Eight aerial photographs were reviewed.\n\nKey Concerns at a Glance:\n- Point loads on unbraced framing.",
      photoLayout: "findings",
    });
    // cover + 1 summary page + 2 photo pages
    expect(countPdfPages(buffer)).toBe(4);
  });
});
