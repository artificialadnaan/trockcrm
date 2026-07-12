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
const SC_LEADERSHIP = "55555555-5555-5555-5555-000000000004"; // DEAL, kind='leadership' → listed + downloadable + full kind-aware detail
const FILE1 = "aaaaaaaa-0000-0000-0000-000000000001";
const FILE2 = "aaaaaaaa-0000-0000-0000-000000000002"; // leadership Project Summary photo
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
  await pg.exec(`INSERT INTO files (id, description) VALUES ('${FILE1}', 'Slab crack'), ('${FILE2}', 'Crew briefing');`);
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
      // A leadership card on THIS deal, submitted newest — it IS listed + downloadable from the deal tab
      // (the completed-email fallback points recipients here), carrying kind='leadership' + averageScore so
      // the web branches to the full kind-aware leadership detail. formVersion=2 (1-10 average bands).
      id: SC_LEADERSHIP, clientSubmissionId: "66666666-6666-6666-6666-000000000004", dealId: DEAL, weekOf: "2026-07-01",
      totalScore: 90, formVersion: 2, kind: "leadership", averageScore: "9.0", rating: "elite", summary: "Strong week; crew morale high.",
      submittedBy: USER, submittedByName: "Lena Lead", pdfR2Key: "office_x/deals/DFW-10432/documents/scorecards/lead.pdf",
      submittedAt: new Date("2026-07-01T18:00:00Z"),
    },
  ]);
  await tdb.insert(fieldScorecardItems).values([
    { scorecardId: SC_NEWER, sectionKey: "schedule", points: 15, note: "Recovery in progress" },
    { scorecardId: SC_NEWER, sectionKey: "quality", points: 20, note: null },
    // Leadership categories (a subset — the detail returns only the present canonical keys, in order).
    { scorecardId: SC_LEADERSHIP, sectionKey: "quality_control", points: 10, note: "Zero rework" },
    { scorecardId: SC_LEADERSHIP, sectionKey: "safety", points: 8, note: null },
    { scorecardId: SC_LEADERSHIP, sectionKey: "schedule_adherence", points: 9, note: "On track" },
  ]);
  await tdb.insert(fieldScorecardPhotos).values([
    { scorecardId: SC_NEWER, sectionKey: "schedule", fileId: FILE1 },
    // Leadership photos attach to the Project Summary block.
    { scorecardId: SC_LEADERSHIP, sectionKey: "project_summary", fileId: FILE2 },
  ]);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("listDealScorecards", () => {
  it("returns this deal's active scorecards, newest first, as summaries (BOTH kinds)", async () => {
    const { scorecards } = await listDealScorecards(tdb, DEAL);
    // OTHER_DEAL excluded; leadership (newest) included; newest first.
    expect(scorecards.map((s) => s.id)).toEqual([SC_LEADERSHIP, SC_NEWER, SC_OLDER]);
    const project = scorecards.find((s) => s.id === SC_NEWER)!;
    expect(project.kind).toBe("project");
    expect(project.rating).toBe("needs_improvement");
    expect(project.ratingLabel).toBe("Needs Immediate Improvement");
    expect(project.totalScore).toBe(82);
    expect(project.criticalDeficiencyCount).toBe(1);
    expect(project.weekOf).toBe("2026-06-30");
    // PDF-availability signal: SC_NEWER has a stored pdf_r2_key → hasPdf true; SC_OLDER's key is null (still
    // generating) → hasPdf false. Gates the CRM Download action so it never 404s on a not-yet-rendered PDF.
    expect(project.hasPdf).toBe(true);
    expect(scorecards.find((s) => s.id === SC_OLDER)!.hasPdf).toBe(false);
  });

  it("lists leadership cards kind-aware — kind + averageScore so the web can branch to the PDF", async () => {
    const { scorecards } = await listDealScorecards(tdb, DEAL);
    const leadership = scorecards.find((s) => s.id === SC_LEADERSHIP);
    // SC_LEADERSHIP is on DEAL and is the newest submission — it IS surfaced (deal tab is now kind-aware).
    expect(leadership).toBeDefined();
    expect(leadership!.kind).toBe("leadership");
    expect(leadership!.formVersion).toBe(2);
    expect(leadership!.averageScore).toBe(9);
    // Leadership reuses the 1-10 bands' labels, not the /100 project labels.
    expect(leadership!.ratingLabel).toBe("Elite Execution");
    // Leadership card has a stored PDF key → hasPdf true (the CRM row shows the live download action).
    expect(leadership!.hasPdf).toBe(true);
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

  it("resolves a LEADERSHIP card kind-aware — category items (leadership keys), summary, project_summary photos", async () => {
    const detail = await getDealScorecardDetail(tdb, DEAL, SC_LEADERSHIP, {
      resolvePhotoUrl: async (fileId) => `url://${fileId}`,
    });
    expect(detail.kind).toBe("leadership");
    expect(detail.averageScore).toBe(9);
    expect(detail.ratingLabel).toBe("Elite Execution"); // leadership 1-10 bands
    // Items map through the LEADERSHIP section vocabulary (present keys, canonical order) — NOT project keys.
    expect(detail.items.map((i) => i.sectionKey)).toEqual(["quality_control", "safety", "schedule_adherence"]);
    expect(detail.items.find((i) => i.sectionKey === "quality_control")?.note).toBe("Zero rework");
    expect(detail.items.find((i) => i.sectionKey === "safety")?.points).toBe(8);
    // Project Summary free text + its evidence photo (resolved url), like project photos.
    expect(detail.summary).toBe("Strong week; crew morale high.");
    expect(detail.photos).toHaveLength(1);
    expect(detail.photos[0].sectionKey).toBe("project_summary");
    expect(detail.photos[0].url).toBe(`url://${FILE2}`);
    expect(detail.photos[0].caption).toBe("Crew briefing");
    // Leadership cards carry no deficiencies/signatures.
    expect(detail.criticalDeficiencies).toEqual([]);
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

  it("presigns a LEADERSHIP card's pdf — leadership's detail IS its PDF (downloadable from the deal)", async () => {
    const { url } = await getDealScorecardPdfDownload(tdb, DEAL, SC_LEADERSHIP);
    expect(url).toContain("lead.pdf");
  });
});
