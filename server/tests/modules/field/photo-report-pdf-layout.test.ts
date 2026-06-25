import { describe, expect, it } from "vitest";
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
  it("a single section of 4 photos is COVER + two photo pages — no divider, no trailing blank pages", async () => {
    const buffer = await renderFieldPhotoReportPdf({
      cover,
      sections: [{ title: "Doors", photos: [photo(1), photo(2), photo(3), photo(4)] }],
    });
    // Image-forward layout packs 3 photos per page (bigger images), so 4 photos = 2 photo pages + cover.
    // Previously this produced ~12 pages (footer text spilled onto auto-created blank pages); the guard is
    // that there are NO trailing blank pages, not the exact per-page count.
    expect(countPdfPages(buffer)).toBe(3);
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
    // No-wrap + ellipsis footer text keeps it at cover + two photo pages (3 photos/page) — no spill pages.
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
    // 4 photos at 3/page = cover + 2 photo pages; single-line ellipsised metadata + height-capped
    // descriptions keep the third-row caption inside its row, so no footer-overlap blank page appears.
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
