import sharp from "sharp";
import zlib from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { renderFieldPhotoReportPdf, type ReportRenderSection } from "../../../src/modules/field/pdf-layout.js";

// Count actual page objects in a PDF buffer (/Type /Page, NOT /Pages).
function countPdfPages(buffer: Buffer): number {
  return (buffer.toString("latin1").match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
}

// --- Locating drawn text in the content stream ---------------------------------------------------
// Text is found by its POSITION AND FONT SIZE, never by its characters. PDFKit SUBSETS the embedded font,
// so the literal glyphs do not appear in the content stream at all — a `streams.indexOf("SomeName")` lookup
// silently returns -1 and the test degrades into asserting nothing. Verified against pdfkit directly.

const PAGE_HEIGHT = 792;
const PAGE_MARGIN = 32;
/** PAGE_MARGIN + COLUMN_WIDTH (264) + COLUMN_GAP (20) — the right-hand cell's left edge. */
const RIGHT_COLUMN_X = 316;
/**
 * The tile's bottom edge in PDF coordinates: PHOTO_ROWS_TOP (72) + PHOTO_TILE_HEIGHT (560) = layout y 632,
 * flipped, because pdfkit's `Tm` y counts UP from the page bottom while the layout counts down from the top.
 * A caption drawn BELOW the tile therefore has a SMALLER Tm y than this.
 */
const TILE_BOTTOM_PDF_Y = PAGE_HEIGHT - (72 + 560);
/** The description runs at 8pt and each metadata line at META_FONT_SIZE (7.5). Nothing else in a cell does. */
const CELL_FONT_SIZES = [8, 7.5];

function inflateStreams(buffer: Buffer): string {
  return [...buffer.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)endstream/g)]
    .map((m) => {
      try {
        return zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
      } catch {
        return "";
      }
    })
    .join("\n");
}

/**
 * Every text run pdfkit emitted, as its position AND the font size it was drawn at.
 *
 * Both halves are load-bearing. Position alone does not identify anything: the page header, the compact
 * section title and the page footer are ALL drawn at PAGE_MARGIN — the identical x as the left cell's
 * caption column — on every content page. Measured sizes for a single-photo page, not assumed: header 11,
 * section title 10, footer 10, index badge 11, the centred "Image unavailable" placeholder 8 (but at
 * x=124.5, not a column edge), and the cell's own caption/metadata at 8 / 7.5.
 *
 * PDFKit emits each run as `Tm` (position) FOLLOWED by `Tf` (font/size) — position before size, not after;
 * verified directly against pdfkit's raw output. The naive assumption that Tf precedes its Tm silently pairs
 * every position with the PRECEDING run's size instead of its own.
 */
function textRuns(buffer: Buffer): { x: number; y: number; size: number }[] {
  const tokens = [
    ...inflateStreams(buffer).matchAll(
      /([\d.\-]+) [\d.\-]+ [\d.\-]+ [\d.\-]+ ([\d.\-]+) ([\d.\-]+) Tm|\/(\S+) ([\d.\-]+) Tf/g,
    ),
  ];
  const runs: { x: number; y: number; size: number }[] = [];
  let pending: { x: number; y: number } | null = null;
  for (const token of tokens) {
    if (token[2] !== undefined) {
      // Tm: remember the position; it is completed once the following Tf supplies the font size.
      pending = { x: Number(token[2]), y: Number(token[3]) };
      continue;
    }
    if (token[5] !== undefined && pending) {
      runs.push({ ...pending, size: Number(token[5]) });
      pending = null;
    }
  }
  return runs;
}

/** The runs that are a photo cell's own caption/metadata: at a column's left edge AND at a cell font size. */
function cellTextRuns(buffer: Buffer): { x: number; y: number; size: number }[] {
  return textRuns(buffer).filter(
    (run) =>
      (Math.abs(run.x - PAGE_MARGIN) < 1 || Math.abs(run.x - RIGHT_COLUMN_X) < 1) &&
      CELL_FONT_SIZES.some((size) => Math.abs(run.size - size) < 0.01),
  );
}

const cover = {
  reportTitle: "University place doors",
  creatorName: "Brett Bell",
  companyName: "TRock Construction",
  reportDateLabel: "June 24, 2026",
  projectName: "Denton Student Housing Exterior",
  photoCount: 4,
};

function photo(i: number): ReportRenderSection["photos"][number] {
  return {
    id: `p${i}`,
    displayName: `Photo ${i}`,
    description: `Door ${i}`,
    takenAt: null,
    createdAt: "2026-06-24T15:00:00.000Z",
    uploaderName: "Brett Bell",
    projectName: "Denton Student Housing Exterior",
    tags: [],
    r2Key: null,
    externalUrl: null, // no buffer → draws the "Image unavailable" placeholder (no network)
    externalThumbnailUrl: null,
    reportIndex: i,
  };
}

describe("renderFieldPhotoReportPdf page count", () => {
  it("a single section of 4 photos is COVER + two photo pages at 2-up — no trailing blank pages", async () => {
    const buffer = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Doors", photos: [photo(1), photo(2), photo(3), photo(4)] }],
    });
    // Two photos a page, so 4 photos = 2 photo pages + cover. The guard that matters is that there are NO
    // trailing blank pages (an earlier layout produced ~12 here when footer text spilled onto auto-created
    // pages), not the per-page density on its own.
    expect(countPdfPages(buffer)).toBe(3);
  });

  it("names the photograph in the log when its bytes will not decode", async () => {
    // The decode throws inside openImageForLayout, which returns null — so a handler wrapped around the
    // later doc.image call never sees it, and a report quietly missing evidence looked exactly like one
    // whose photograph merely failed to render, with nothing recording which.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const corrupt = {
        ...photo(1),
        displayName: "IMG_4021.jpg",
        // Loads to real bytes (the data: path), then fails to decode — a truncated or mislabelled upload.
        externalUrl: `data:image/jpeg;base64,${Buffer.from("not actually a jpeg").toString("base64")}`,
      };
      const buffer = await renderFieldPhotoReportPdf({ cover, sections: [{ title: "Doors", photos: [corrupt] }] });
      // Still renders — a bad photograph must never take the whole report down.
      expect(countPdfPages(buffer)).toBe(2);

      const logged = warn.mock.calls.find((call) => String(call[0]).includes("could not decode"));
      expect(logged).toBeDefined();
      expect(logged![1]).toMatchObject({ photoId: "p1", displayName: "IMG_4021.jpg" });
    } finally {
      warn.mockRestore();
    }
  });

  it("packs TWO photographs onto a page, two cells across", async () => {
    // Boundary proof of the chunk size: 2 photos is exactly one page, 3 spills to a second. Page-count
    // assertions elsewhere in this file cannot see the chunk size on their own — a 4-photo fixture gives
    // the same answer for several plausible densities — so the pair below is what pins it to 2.
    const two = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Doors", photos: [photo(1), photo(2)] }],
    });
    expect(countPdfPages(two)).toBe(2);

    const three = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Doors", photos: [photo(1), photo(2), photo(3)] }],
    });
    expect(countPdfPages(three)).toBe(3);
  });

  it("lays the two cells of a row out side by side, both inside the page margins", async () => {
    // Guards the column arithmetic itself. A cell drawn at the wrong x is invisible to a page count, and the
    // failure mode that matters — the right-hand column running off the page — still produces a valid PDF.
    // The tile is a filled roundedRect, so its left edge is the first coordinate of the `re`-equivalent path
    // PDFKit emits; asserting on the two DISTINCT x origins is what proves the row is two-up and not
    // one-up-drawn-twice.
    const buffer = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Doors", photos: [photo(1), photo(2)] }],
    });
    const streams = inflateStreams(buffer);
    // A rounded rect's path opens at (left + radius), not at left, so these coordinates are offset by the
    // 8pt corner radius — the arithmetic below carries it rather than pretending it isn't there.
    const RADIUS = 8;
    const tileLefts = [...streams.matchAll(/([\d.]+) 72 m/g)].map((m) => Number(m[1]) - RADIUS);
    const distinct = [...new Set(tileLefts)].sort((a, b) => a - b);
    expect(distinct.length).toBe(2);
    // Left column starts at the page margin; the right column is a full column + gutter across.
    expect(distinct[0]).toBeCloseTo(32, 1);
    expect(distinct[1]).toBeCloseTo(32 + 264 + 20, 1);
    // ...and the right-hand cell's tile still ends inside the right margin.
    // 316 + 256 = 572, inside the 580pt right margin with 8pt to spare.
    expect(distinct[1] + 256).toBeLessThanOrEqual(612 - 32);
  });

  it("draws the caption BELOW its tile, not beside it", async () => {
    // The caption used to sit in the leftover column width to the right of the tile. At a 256pt tile in a
    // 264pt column that space is gone (264 - 256 - 10 = -2pt), so the block moves underneath.
    //
    // Asserting on the drawn text's ORIGIN is what distinguishes "moved below" from "still beside, just
    // clipped off the page" — a page count cannot see that difference and neither can a byte length.
    //
    // The x origin ALONE is not enough for the positive half, which is the mistake this test previously
    // made: it asserted only that *something* was drawn at x=32, and the page header, the compact section
    // title and the footer are all drawn at PAGE_MARGIN too. The caption could vanish entirely and it still
    // passed. Identifying the caption needs its FONT SIZE as well (see `cellTextRuns`), and its position
    // needs to be checked on the axis the change actually moved it along — down.
    const buffer = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Doors", photos: [photo(1)] }],
    });

    // A single photo occupies the LEFT cell, so a caption drawn beside a 256pt tile would land at
    // 32 + 256 + 10 = 298. Nothing at all may be drawn there — this half needs no font-size filter, and it
    // is what catches a straight revert to the old side-by-side layout.
    const allRuns = textRuns(buffer);
    expect(allRuns.length).toBeGreaterThan(0); // guard: a regex that matched nothing must fail, not pass
    expect(allRuns.filter((run) => Math.abs(run.x - 298) < 1)).toEqual([]);

    // ...and the caption block is really drawn, at the tile's own left edge, BELOW the tile: one description
    // line at 8pt plus this fixture's two metadata lines at 7.5pt.
    const cellRuns = cellTextRuns(buffer);
    expect(cellRuns.length).toBeGreaterThanOrEqual(3);
    expect(cellRuns.every((run) => Math.abs(run.x - PAGE_MARGIN) < 1)).toBe(true);
    // Below the tile, in flipped PDF space, means a SMALLER y than the tile's bottom edge. Every cell run
    // must clear it — a caption still drawn level with the tile fails here even if it is at the right x.
    // (The 8pt "Image unavailable" placeholder is centred in the tile at x=124.5, so it is not in this set;
    // should it ever be left-aligned it would land inside the tile and correctly fail this assertion.)
    expect(Math.max(...cellRuns.map((run) => run.y))).toBeLessThan(TILE_BOTTOM_PDF_Y);
  });

  it("keeps the caption band clear of the page footer", async () => {
    // PHOTO_TILE_HEIGHT is a hand-tuned literal (560) rather than a derivation, so it no longer moves with
    // PHOTO_ROW_PITCH. If the row geometry is ever retuned without revisiting it, the caption band would
    // silently overrun the footer — a defect no page-count assertion can see. This pins the invariant.
    //
    // PDF y-coordinates are flipped relative to the layout's top-down space: pdfkit emits `... x y Tm`
    // where y counts UP from the page bottom, so a caption/metadata run sitting safely above the footer in
    // layout terms renders with a LARGER Tm y than the footer's.
    const buffer = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Doors", photos: [photo(1), photo(2)] }],
    });

    // `cellTextRuns` filters on BOTH x and font size, which is what isolates cell content here: the page
    // footer's own left-aligned label is drawn at PAGE_MARGIN (`drawFooter`) — the identical x as this
    // layout's left caption column, on every content page — so an x-only filter cannot tell the two apart.
    // The footer always runs at 10pt; a cell's caption/metadata at 8pt or META_FONT_SIZE (7.5pt).
    const cellTextYs = cellTextRuns(buffer).map((run) => run.y);
    expect(cellTextYs.length).toBeGreaterThan(0);

    // 52 = comfortably above the footer's own rendered position (~34) and well below the lowest real cell
    // text observed in this fixture (~117). Nothing from a cell may reach it.
    expect(Math.min(...cellTextYs)).toBeGreaterThan(52);
  });

  it("keeps the caption band clear of the footer at its WORST case, not just the typical one", async () => {
    // The sibling test above runs the ordinary path: two metadata lines and a short description. This one
    // renders the maximum a cell can hold — THREE metadata lines (the third prints only when a photo's own
    // project differs from the report's) plus an over-long description, i.e. the composite that gets
    // closest to the footer.
    //
    // WHAT THIS DOES AND DOES NOT PIN, measured rather than assumed. Two independent guards keep the band
    // in bounds, and EITHER ONE ALONE is sufficient:
    //   1. clampText(..., 200) — 200 chars of unbreakable text measures 53.7pt at 8pt/256pt wide
    //   2. descriptionAvailable = band(98) - metaBlock(30) - 4 = 64pt, which ellipsises anything longer
    // 53.7 < 64, so guard 2 is never actually reached at today's clamp; it is a backstop for if the clamp
    // is ever raised. Verified by sabotage: removing either guard on its own leaves this test PASSING, and
    // it only fails when BOTH are removed together. So this is a composite regression guard on "max content
    // stays off the footer", NOT a tight discriminator for either guard individually — recorded plainly so
    // nobody later reads a green run here as proof that one of them still works.
    const worstCase = {
      ...photo(1),
      // Differs from cover.projectName, so metaLines gets its third entry.
      projectName: "A Different Project Entirely",
      // Longer than the 200-char clamp, so the description is capped at its maximum height, not its
      // natural one.
      description: "N".repeat(400),
    };
    const buffer = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Doors", photos: [worstCase] }],
    });

    const cellTextYs = cellTextRuns(buffer).map((run) => run.y);
    // Three metadata lines must actually be present, or this fixture is not exercising the worst case and
    // the assertion below would pass for the wrong reason.
    expect(cellTextYs.length).toBeGreaterThanOrEqual(4); // >=1 description line + 3 metadata lines
    expect(Math.min(...cellTextYs)).toBeGreaterThan(52);
  });

  it("preserves a single-section custom title compactly without adding a divider page", async () => {
    const buffer = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "South Stairwell Doors", photos: [photo(1), photo(2)] }],
    });
    // Still cover + one photo page (no divider) even though the section carries a distinct title.
    expect(countPdfPages(buffer)).toBe(2);
  });

  it("does not spill onto blank pages when the footer project name is very long", async () => {
    // Project names can run ~140 chars; the footer draws it bottom-aligned where any wrap would spill.
    const longName = "Denton Student Housing Exterior Envelope and Door Hardware Punchlist Walkthrough Report Building C";
    const buffer = await renderFieldPhotoReportPdf({
      cover: { ...cover, projectName: longName },
      sections: [{ title: "Doors", photos: [photo(1), photo(2), photo(3), photo(4)] }],
    });
    // No-wrap + ellipsis footer text keeps it at cover + two photo pages (2 photos/page) — no spill pages.
    expect(countPdfPages(buffer)).toBe(3);
  });

  it("keeps a divider page per section when there are multiple sections", async () => {
    const buffer = await renderFieldPhotoReportPdf({
      cover: { ...cover, photoCount: 2 },
      sections: [
        { title: "Exterior", photos: [photo(1)] },
        { title: "Interior", photos: [photo(2)] },
      ],
    });
    // cover + (divider + photo page) x 2 = 5 — and still no blank footer-spill pages.
    expect(countPdfPages(buffer)).toBe(5);
  });

  it("caps long per-photo project names + long descriptions to the row — no spill or blank pages", async () => {
    // The deal schema allows ~500-char project names; before the per-line ellipsis cap, a long projectName
    // wrapped the metadata far enough (especially in the third row, where metaTop clamps near the bottom)
    // to overlap the footer or auto-create a page.
    const longName = "Denton Student Housing Exterior Envelope and Door Hardware Punchlist Walkthrough Report Building C Phase 2 Northwest Quadrant Units 300 through 360";
    const longDesc = "Exterior wall, north elevation efflorescence noted along the lower three courses near the downspout; recommend cleaning and sealing before the next freeze cycle to prevent spalling on the brick veneer along the entire run and the adjacent return wall by the stair.";
    const photos = [1, 2, 3, 4].map((i) => ({
      ...photo(i),
      description: longDesc,
      projectName: longName,
      uploaderName: "Bartholomew Higginbotham-Wellington III",
    }));
    const buffer = await renderFieldPhotoReportPdf({
      cover: { ...cover, projectName: longName },
      sections: [{ title: "Untagged", photos }],
    });
    // 4 photos at 2/page = cover + 2 photo pages; single-line ellipsised metadata + a height-capped
    // description keep the LAST row's caption inside its tile, so no footer-overlap blank page appears.
    expect(countPdfPages(buffer)).toBe(3);
  });

  it("caps a very long report title on the cover — no overflow page", async () => {
    const longTitle = "Denton Student Housing Exterior Envelope and Door Hardware Punchlist Walkthrough Report Building C Phase 2 Northwest Quadrant Units 300-360 Photo Report";
    const buffer = await renderFieldPhotoReportPdf({
      cover: { ...cover, reportTitle: longTitle, photoCount: 2 },
      sections: [{ title: "Doors", photos: [photo(1), photo(2)] }],
    });
    // The 30pt cover title is height-capped + ellipsised so it can't wrap past the page bottom and spawn a
    // blank cover-overflow page: cover + one photo page = 2.
    expect(countPdfPages(buffer)).toBe(2);
  });
});
