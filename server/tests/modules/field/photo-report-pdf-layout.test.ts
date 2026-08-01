import sharp from "sharp";
import zlib from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { renderFieldPhotoReportPdf, type ReportRenderSection } from "../../../src/modules/field/pdf-layout.js";

// Count actual page objects in a PDF buffer (/Type /Page, NOT /Pages).
function countPdfPages(buffer: Buffer): number {
  return (buffer.toString("latin1").match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
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
  it("a single section of 4 photos is COVER + one photo page — no divider, no trailing blank pages", async () => {
    const buffer = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Doors", photos: [photo(1), photo(2), photo(3), photo(4)] }],
    });
    // Four fixed-size tiles fit one page, so 4 photos = 1 photo page + cover. Previously this produced ~12
    // pages (footer text spilled onto auto-created blank pages); the guard is that there are NO trailing
    // blank pages, not the exact per-page count.
    expect(countPdfPages(buffer)).toBe(2);
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

  it("packs EIGHT photographs onto a page, two cells across", async () => {
    // The page-count assertions elsewhere in this file cannot see the two-up change: at 4 photos, 4-per-page
    // and 8-per-page both give cover + 1. These two counts are the ones that differ — 8 photos was two photo
    // pages under the old grid and is one under this one, and 9 is the boundary that proves the chunk size
    // is 8 rather than "everything on one page".
    const eight = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Doors", photos: Array.from({ length: 8 }, (_, i) => photo(i + 1)) }],
    });
    expect(countPdfPages(eight)).toBe(2);

    const nine = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Doors", photos: Array.from({ length: 9 }, (_, i) => photo(i + 1)) }],
    });
    expect(countPdfPages(nine)).toBe(3);
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
    const streams = [...buffer.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)endstream/g)]
      .map((m) => {
        try {
          return zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
        } catch {
          return "";
        }
      })
      .join("\n");
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
    expect(distinct[1] + 148).toBeLessThanOrEqual(612 - 32);
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
    // No-wrap + ellipsis footer text keeps it at cover + one photo page (4 photos/page) — no spill pages.
    expect(countPdfPages(buffer)).toBe(2);
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
    // 4 photos at 4/page = cover + 1 photo page; single-line ellipsised metadata + a height-capped
    // description keep the LAST row's caption inside its tile, so no footer-overlap blank page appears.
    expect(countPdfPages(buffer)).toBe(2);
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
