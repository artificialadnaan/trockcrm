import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// Presigned URLs are R2-backed; mock the client so the download path is deterministic + offline.
vi.mock("../../../src/lib/r2-client.js", () => ({
  generateDownloadUrl: vi.fn(async (key: string) => `https://signed.example/${key}`),
  isR2Configured: vi.fn(() => true),
}));

import {
  listDealScorecards,
  getDealScorecardDetail,
  getDealScorecardPdfDownload,
} from "../../../src/modules/deals/scorecards-service.js";
import { fieldScorecards, fieldScorecardItems, fieldScorecardPhotos } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const DEAL = "11111111-1111-1111-1111-111111111111";
const OTHER_DEAL = "22222222-2222-2222-2222-222222222222";
const SC_NEWER = "55555555-5555-5555-5555-000000000001"; // DEAL, has pdf
const SC_OLDER = "55555555-5555-5555-5555-000000000002"; // DEAL, NO pdf
const SC_OTHER = "55555555-5555-5555-5555-000000000003"; // OTHER_DEAL
const SC_LEADERSHIP = "55555555-5555-5555-5555-000000000004"; // DEAL, kind='leadership' → excluded (deal tab is project-only)
const FILE1 = "aaaaaaaa-0000-0000-0000-000000000001";
const USER = "33333333-3333-3333-3333-333333333333";

let pg: PGlite;
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE files (id uuid PRIMARY KEY, description text);
    SET search_path TO public;
  `);
  await pg.exec(tenantSchemaSql("public", [fieldScorecards, fieldScorecardItems, fieldScorecardPhotos]));
  await pg.exec(`INSERT INTO files (id, description) VALUES ('${FILE1}', 'Slab crack');`);
  tdb = drizzle(pg);

  await tdb.insert(fieldScorecards).values([
    {
      id: SC_NEWER, clientSubmissionId: "66666666-6666-6666-6666-000000000001", dealId: DEAL, weekOf: "2026-06-30", projectNumber: "DFW-10432",
      totalScore: 82, rating: "needs_improvement", criticalDeficiencies: ["failed_inspection"], actionItems: ["Re-pour slab"],
      submittedBy: USER, submittedByName: "Sam Super", pdfR2Key: "office_x/deals/DFW-10432/documents/scorecards/sc1.pdf",
      submittedAt: new Date("2026-06-30T18:00:00Z"),
    },
    {
      id: SC_OLDER, clientSubmissionId: "66666666-6666-6666-6666-000000000002", dealId: DEAL, weekOf: "2026-06-23", projectNumber: "DFW-10432",
      totalScore: 95, rating: "elite", submittedBy: USER, submittedByName: "Sam Super", pdfR2Key: null,
      submittedAt: new Date("2026-06-23T18:00:00Z"),
    },
    {
      id: SC_OTHER, clientSubmissionId: "66666666-6666-6666-6666-000000000003", dealId: OTHER_DEAL, weekOf: "2026-06-30",
      totalScore: 70, rating: "corrective_action", submittedBy: USER, submittedByName: "Pat", pdfR2Key: "k",
      submittedAt: new Date("2026-06-30T18:00:00Z"),
    },
    {
      // A leadership card on THIS deal, submitted newest — only its kind='leadership' keeps it off the deal
      // tab (which renders the project shape). Proves the kind filter, not the dealId/isActive scoping.
      id: SC_LEADERSHIP, clientSubmissionId: "66666666-6666-6666-6666-000000000004", dealId: DEAL, weekOf: "2026-07-01",
      totalScore: 90, rating: "elite", kind: "leadership", submittedBy: USER, submittedByName: "Lena Lead", pdfR2Key: "office_x/deals/DFW-10432/documents/scorecards/lead.pdf",
      submittedAt: new Date("2026-07-01T18:00:00Z"),
    },
  ]);
  await tdb.insert(fieldScorecardItems).values([
    { scorecardId: SC_NEWER, sectionKey: "schedule", points: 15, note: "Recovery in progress" },
    { scorecardId: SC_NEWER, sectionKey: "quality", points: 20, note: null },
  ]);
  await tdb.insert(fieldScorecardPhotos).values([
    { scorecardId: SC_NEWER, sectionKey: "schedule", fileId: FILE1 },
  ]);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("listDealScorecards", () => {
  it("returns only this deal's active scorecards, newest first, as summaries", async () => {
    const { scorecards } = await listDealScorecards(tdb, DEAL);
    expect(scorecards.map((s) => s.id)).toEqual([SC_NEWER, SC_OLDER]); // OTHER_DEAL excluded, newest first
    const newer = scorecards[0];
    expect(newer.rating).toBe("needs_improvement");
    expect(newer.ratingLabel).toBe("Needs Immediate Improvement");
    expect(newer.totalScore).toBe(82);
    expect(newer.criticalDeficiencyCount).toBe(1);
    expect(newer.weekOf).toBe("2026-06-30");
  });

  it("excludes leadership cards — the deal tab renders project scorecards only (kind filter)", async () => {
    const { scorecards } = await listDealScorecards(tdb, DEAL);
    // SC_LEADERSHIP is on DEAL and is the newest submission; only kind='leadership' keeps it out.
    expect(scorecards.map((s) => s.id)).not.toContain(SC_LEADERSHIP);
    expect(scorecards.map((s) => s.id)).toEqual([SC_NEWER, SC_OLDER]);
  });
});

describe("getDealScorecardDetail", () => {
  it("returns items (canonical order) + deficiencies + action items + photos with resolved urls", async () => {
    const detail = await getDealScorecardDetail(tdb, DEAL, SC_NEWER, {
      resolvePhotoUrl: async (fileId) => `url://${fileId}`,
    });
    expect(detail.items.map((i) => i.sectionKey)).toEqual(["schedule", "quality"]);
    expect(detail.items.find((i) => i.sectionKey === "schedule")?.note).toBe("Recovery in progress");
    expect(detail.criticalDeficiencies).toEqual(["failed_inspection"]);
    expect(detail.actionItems).toEqual(["Re-pour slab"]);
    expect(detail.photos).toHaveLength(1);
    expect(detail.photos[0].url).toBe(`url://${FILE1}`);
    expect(detail.photos[0].caption).toBe("Slab crack");
  });

  it("404s a scorecard fetched through the WRONG deal (id is scoped by dealId)", async () => {
    await expect(getDealScorecardDetail(tdb, OTHER_DEAL, SC_NEWER)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("404s a leadership card — the deal tab detail is project-only (kind filter)", async () => {
    await expect(getDealScorecardDetail(tdb, DEAL, SC_LEADERSHIP)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("getDealScorecardPdfDownload", () => {
  it("presigns the stored pdf key", async () => {
    const { url } = await getDealScorecardPdfDownload(tdb, DEAL, SC_NEWER);
    expect(url).toContain("sc1.pdf");
  });

  it("404s while the PDF is still generating (no key yet)", async () => {
    await expect(getDealScorecardPdfDownload(tdb, DEAL, SC_OLDER)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("404s a scorecard fetched through the wrong deal", async () => {
    await expect(getDealScorecardPdfDownload(tdb, OTHER_DEAL, SC_NEWER)).rejects.toMatchObject({ statusCode: 404 });
  });
});
