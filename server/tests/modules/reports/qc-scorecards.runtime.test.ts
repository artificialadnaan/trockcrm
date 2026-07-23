import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { getQcScorecardsReport } from "../../../src/modules/reports/qc-scorecards-service.js";
import { fieldScorecards } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { LOST_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

const RC_DALLAS = "aaaaaaaa-0000-0000-0000-000000000001";
const RC_ATL = "aaaaaaaa-0000-0000-0000-000000000002";
const STAGE_ACTIVE = "cccccccc-0000-0000-0000-000000000001";
const STAGE_LOST = "cccccccc-0000-0000-0000-000000000002";
const DEAL_D = "bbbbbbbb-0000-0000-0000-000000000001"; // Dallas, active
const DEAL_A = "bbbbbbbb-0000-0000-0000-000000000002"; // Atlanta, active
const DEAL_LOST = "bbbbbbbb-0000-0000-0000-000000000003"; // Lost stage → excluded
const DEAL_ARCHIVED = "bbbbbbbb-0000-0000-0000-000000000004"; // is_active=false → excluded
const DEAL_BB_LOST = "bbbbbbbb-0000-0000-0000-000000000005"; // open CRM stage, Lost Bid Board mirror → excluded
const DEAL_TEST = "bbbbbbbb-0000-0000-0000-000000000006"; // is_test_data=true (active, live stage) → excluded
const USER = "33333333-3333-3333-3333-333333333333";
const SC1 = "55555555-5555-5555-5555-000000000001"; // Dallas, Jun 30, needs_improvement, 1 flag, pdf
const SC2 = "55555555-5555-5555-5555-000000000002"; // Dallas, Jun 23, elite, no flag, no pdf
const SC3 = "55555555-5555-5555-5555-000000000003"; // Atlanta, Jun 30, corrective_action, 2 flags, pdf
const SC_OLD = "55555555-5555-5555-5555-000000000004"; // Atlanta, May 1 (out of June window)
const SC_LOST = "55555555-5555-5555-5555-000000000005"; // on a Lost deal → excluded by the live-project gate
const SC_ARCHIVED = "55555555-5555-5555-5555-000000000006"; // on an archived (is_active=false) deal → excluded
const SC_BB_LOST = "55555555-5555-5555-5555-000000000007"; // on a deal whose Bid Board mirror is Lost → excluded
const SC_TEST = "55555555-5555-5555-5555-000000000008"; // on a test-data deal → excluded from reports
const SC_LEADERSHIP = "55555555-5555-5555-5555-000000000009"; // leadership card on a LIVE deal → included

let pg: PGlite;
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.region_config (id uuid PRIMARY KEY, name varchar(100) NOT NULL);
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, slug text, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE deals (id uuid PRIMARY KEY, name text, region_id uuid, project_number text, stage_id uuid, bid_board_stage_slug text, is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false);
    SET search_path TO public;
  `);
  await pg.exec(tenantSchemaSql("public", [fieldScorecards]));
  await pg.exec(`
    INSERT INTO public.region_config (id, name) VALUES ('${RC_DALLAS}','Dallas'), ('${RC_ATL}','Atlanta');
    INSERT INTO public.pipeline_stage_config (id, slug, is_terminal) VALUES
      ('${STAGE_ACTIVE}','construction',false), ('${STAGE_LOST}','${LOST_STAGE_SLUGS[0]}',true);
    INSERT INTO deals (id, name, region_id, project_number, stage_id, is_active) VALUES
      ('${DEAL_D}','Maple Street Tower','${RC_DALLAS}','DFW-10432','${STAGE_ACTIVE}', true),
      ('${DEAL_A}','Riverbend Logistics','${RC_ATL}','ATL-2207','${STAGE_ACTIVE}', true),
      ('${DEAL_LOST}','Cancelled Job','${RC_DALLAS}','DFW-9999','${STAGE_LOST}', true),
      ('${DEAL_ARCHIVED}','Archived Job','${RC_DALLAS}','DFW-8888','${STAGE_ACTIVE}', false);
    -- BB-owned deal: CRM stage_id is the OPEN 'construction' stage, but the Bid Board mirror is Lost.
    INSERT INTO deals (id, name, region_id, project_number, stage_id, bid_board_stage_slug, is_active) VALUES
      ('${DEAL_BB_LOST}','Stale BB Lost','${RC_DALLAS}','DFW-7777','${STAGE_ACTIVE}','${LOST_STAGE_SLUGS[0]}', true);
    -- Demo/test project: active + live stage, but flagged is_test_data → must not leak into reports.
    INSERT INTO deals (id, name, region_id, project_number, stage_id, is_active, is_test_data) VALUES
      ('${DEAL_TEST}','Demo Sandbox','${RC_DALLAS}','DFW-0000','${STAGE_ACTIVE}', true, true);
  `);
  tdb = drizzle(pg);

  await tdb.insert(fieldScorecards).values([
    { id: SC1, clientSubmissionId: "66666666-6666-6666-6666-000000000001", dealId: DEAL_D, weekOf: "2026-06-30", projectNumber: "DFW-10432", superintendentName: "Sam Reyes", totalScore: 82, rating: "needs_improvement", criticalDeficiencies: ["failed_inspection"], submittedBy: USER, submittedByName: "Sam Reyes", pdfR2Key: "k/sc1.pdf", submittedAt: new Date("2026-06-30T18:00:00Z") },
    { id: SC2, clientSubmissionId: "66666666-6666-6666-6666-000000000002", dealId: DEAL_D, weekOf: "2026-06-23", projectNumber: "DFW-10432", superintendentName: "Sam Reyes", totalScore: 95, rating: "elite", submittedBy: USER, submittedByName: "Sam Reyes", pdfR2Key: null, submittedAt: new Date("2026-06-23T18:00:00Z") },
    { id: SC3, clientSubmissionId: "66666666-6666-6666-6666-000000000003", dealId: DEAL_A, weekOf: "2026-06-30", projectNumber: "ATL-2207", superintendentName: "Dana Cole", totalScore: 71, rating: "corrective_action", criticalDeficiencies: ["a", "b"], submittedBy: USER, submittedByName: "Dana Cole", pdfR2Key: "k/sc3.pdf", submittedAt: new Date("2026-06-29T18:00:00Z") },
    { id: SC_OLD, clientSubmissionId: "66666666-6666-6666-6666-000000000004", dealId: DEAL_A, weekOf: "2026-05-01", projectNumber: "ATL-2207", superintendentName: "Dana Cole", totalScore: 60, rating: "corrective_action", submittedBy: USER, submittedByName: "Dana Cole", submittedAt: new Date("2026-05-01T18:00:00Z") },
    { id: SC_LOST, clientSubmissionId: "66666666-6666-6666-6666-000000000005", dealId: DEAL_LOST, weekOf: "2026-06-30", projectNumber: "DFW-9999", superintendentName: "Sam Reyes", totalScore: 50, rating: "corrective_action", submittedBy: USER, submittedByName: "Sam Reyes", submittedAt: new Date("2026-06-30T18:00:00Z") },
    { id: SC_ARCHIVED, clientSubmissionId: "66666666-6666-6666-6666-000000000006", dealId: DEAL_ARCHIVED, weekOf: "2026-06-30", projectNumber: "DFW-8888", superintendentName: "Sam Reyes", totalScore: 88, rating: "on_standard", submittedBy: USER, submittedByName: "Sam Reyes", submittedAt: new Date("2026-06-30T18:00:00Z") },
    { id: SC_BB_LOST, clientSubmissionId: "66666666-6666-6666-6666-000000000007", dealId: DEAL_BB_LOST, weekOf: "2026-06-30", projectNumber: "DFW-7777", superintendentName: "Sam Reyes", totalScore: 65, rating: "corrective_action", submittedBy: USER, submittedByName: "Sam Reyes", submittedAt: new Date("2026-06-30T18:00:00Z") },
    { id: SC_TEST, clientSubmissionId: "66666666-6666-6666-6666-000000000008", dealId: DEAL_TEST, weekOf: "2026-06-30", projectNumber: "DFW-0000", superintendentName: "Demo Tester", totalScore: 99, rating: "elite", submittedBy: USER, submittedByName: "Demo Tester", submittedAt: new Date("2026-06-30T18:00:00Z") },
    // Leadership and project cards intentionally share the QC report page. The explicit V2 average proves
    // the report contract carries the authoritative /10 score instead of relying on totalScore fallback.
    { id: SC_LEADERSHIP, clientSubmissionId: "66666666-6666-6666-6666-000000000009", dealId: DEAL_D, weekOf: "2026-06-30", projectNumber: "DFW-10432", superintendentName: "Leah Solo", totalScore: 90, formVersion: 2, averageScore: "9.0", rating: "elite", kind: "leadership", submittedBy: USER, submittedByName: "Lena Lead", submittedAt: new Date("2026-06-30T19:00:00Z") },
  ]);
});

afterAll(async () => {
  await pg?.close?.();
});

const JUNE = { from: "2026-06-01", to: "2026-06-30" };

describe("getQcScorecardsReport", () => {
  it("returns scorecards in the week window, newest submission first, with the deal + region joined", async () => {
    const { scorecards } = await getQcScorecardsReport(tdb, JUNE);
    expect(scorecards.map((s) => s.scorecardId)).toEqual([SC_LEADERSHIP, SC1, SC3, SC2]); // SC_OLD excluded (May)
    const sc1 = scorecards.find((s) => s.scorecardId === SC1)!;
    expect(sc1.projectName).toBe("Maple Street Tower");
    expect(sc1.regionName).toBe("Dallas");
    expect(sc1.deficiencyCount).toBe(1);
    expect(sc1.pdfAvailable).toBe(true);
    expect(scorecards.find((s) => s.scorecardId === SC2)!.pdfAvailable).toBe(false);
    expect(scorecards.find((s) => s.scorecardId === SC3)!.deficiencyCount).toBe(2);
    expect(scorecards.find((s) => s.scorecardId === SC_LEADERSHIP)).toMatchObject({
      kind: "leadership",
      formVersion: 2,
      averageScore: 9,
      deficiencyCount: 0,
    });
  });

  it("excludes scorecards on Lost / archived / Bid-Board-Lost / test-data deals (live-project + reports gate)", async () => {
    const res = await getQcScorecardsReport(tdb, JUNE);
    const ids = res.scorecards.map((s) => s.scorecardId);
    expect(ids).not.toContain(SC_LOST); // DEAL_LOST is on a terminal Lost stage
    expect(ids).not.toContain(SC_ARCHIVED); // DEAL_ARCHIVED has is_active = false
    // DEAL_BB_LOST keeps an OPEN CRM stage_id but its Bid Board mirror is Lost — the gate must still exclude it
    // (COALESCE(psc.slug, bid_board_stage_slug) would pick the open CRM slug and let this stale row through).
    expect(ids).not.toContain(SC_BB_LOST);
    // DEAL_TEST is active + live-staged but is_test_data — the reports guard keeps it out of rows AND options.
    expect(ids).not.toContain(SC_TEST);
    expect(res.superintendents).not.toContain("Demo Tester");
  });

  it("includes leadership cards and their filter options on the same QC report", async () => {
    const res = await getQcScorecardsReport(tdb, JUNE);
    const ids = res.scorecards.map((s) => s.scorecardId);
    expect(ids).toContain(SC_LEADERSHIP);
    expect(res.superintendents).toContain("Leah Solo");
  });

  it("filters project and leadership scorecards server-side before the row cap", async () => {
    const project = await getQcScorecardsReport(tdb, { ...JUNE, kind: "project" });
    expect(project.scorecards.map((s) => s.scorecardId)).toEqual([SC1, SC3, SC2]);
    expect(project.scorecards.every((s) => s.kind === "project")).toBe(true);

    const leadership = await getQcScorecardsReport(tdb, { ...JUNE, kind: "leadership" });
    expect(leadership.scorecards.map((s) => s.scorecardId)).toEqual([SC_LEADERSHIP]);
    // Options remain window-wide and independent of interactive filters, matching region/superintendent.
    expect(leadership.superintendents).toEqual(["Dana Cole", "Leah Solo", "Sam Reyes"]);
  });

  it("filters by region name (server-side, before the cap)", async () => {
    const { scorecards } = await getQcScorecardsReport(tdb, { ...JUNE, region: "Dallas" });
    expect(scorecards.map((s) => s.scorecardId).sort()).toEqual([SC1, SC2, SC_LEADERSHIP].sort());
  });

  it("returns window-wide region + superintendent options independent of the active filters", async () => {
    const res = await getQcScorecardsReport(tdb, { ...JUNE, region: "Dallas" });
    expect(res.regions).toEqual(["Atlanta", "Dallas"]); // both, even though filtered to Dallas
    expect(res.superintendents).toEqual(["Dana Cole", "Leah Solo", "Sam Reyes"]);
  });

  it("filters superintendent by EXACT name, not a substring contains", async () => {
    const exact = await getQcScorecardsReport(tdb, { ...JUNE, superintendent: "Sam Reyes" });
    expect(exact.scorecards.map((s) => s.scorecardId).sort()).toEqual([SC1, SC2].sort());
    // A substring of a real name must NOT match — the dropdown only ever supplies exact names, and the old
    // contains-ILIKE would have returned Sam Reyes' cards here.
    const partial = await getQcScorecardsReport(tdb, { ...JUNE, superintendent: "Sam" });
    expect(partial.scorecards).toEqual([]);
  });

  it("filters by rating", async () => {
    const { scorecards } = await getQcScorecardsReport(tdb, { ...JUNE, rating: "corrective_action" });
    expect(scorecards.map((s) => s.scorecardId)).toEqual([SC3]);
  });

  it("filters flagged-only (deficiency count > 0)", async () => {
    const { scorecards } = await getQcScorecardsReport(tdb, { ...JUNE, flaggedOnly: true });
    expect(scorecards.map((s) => s.scorecardId).sort()).toEqual([SC1, SC3].sort());
  });

  it("searches project name / number / superintendent", async () => {
    // A project-name match returns ALL that project's scorecards (both weeks on the Maple deal), newest-first.
    expect((await getQcScorecardsReport(tdb, { ...JUNE, search: "Maple" })).scorecards.map((s) => s.scorecardId)).toEqual([SC_LEADERSHIP, SC1, SC2]);
    expect((await getQcScorecardsReport(tdb, { ...JUNE, search: "ATL-2207" })).scorecards.map((s) => s.scorecardId)).toEqual([SC3]);
    expect((await getQcScorecardsReport(tdb, { ...JUNE, search: "Dana" })).scorecards.map((s) => s.scorecardId)).toEqual([SC3]);
    expect((await getQcScorecardsReport(tdb, { ...JUNE, search: "Leah" })).scorecards.map((s) => s.scorecardId)).toEqual([SC_LEADERSHIP]);
  });
});

describe("getQcScorecardsReport — corrective-action status", () => {
  // SC3 is the below-band Atlanta card. Mark it OPEN, and SC1 (in-window Dallas) CLOSED, to exercise the
  // status column + the open/closed filter. Reset after so the other suites see plain `submitted` rows.
  beforeAll(async () => {
    await tdb.execute(sql`UPDATE field_scorecards SET status = 'corrective_action_open' WHERE id = ${SC3}`);
    await tdb.execute(sql`UPDATE field_scorecards SET status = 'corrective_action_closed' WHERE id = ${SC1}`);
  });
  afterAll(async () => {
    await tdb.execute(sql`UPDATE field_scorecards SET status = 'submitted' WHERE id IN (${SC3}, ${SC1})`);
  });

  it("emits the scorecard status on each row (default 'submitted')", async () => {
    const { scorecards } = await getQcScorecardsReport(tdb, JUNE);
    expect(scorecards.find((s) => s.scorecardId === SC3)!.status).toBe("corrective_action_open");
    expect(scorecards.find((s) => s.scorecardId === SC1)!.status).toBe("corrective_action_closed");
    expect(scorecards.find((s) => s.scorecardId === SC2)!.status).toBe("submitted");
  });

  it("narrows to open corrective-action cards with correctiveActionStatus=open", async () => {
    const { scorecards } = await getQcScorecardsReport(tdb, { ...JUNE, correctiveActionStatus: "open" });
    expect(scorecards.map((s) => s.scorecardId)).toEqual([SC3]);
  });

  it("narrows to closed corrective-action cards with correctiveActionStatus=closed", async () => {
    const { scorecards } = await getQcScorecardsReport(tdb, { ...JUNE, correctiveActionStatus: "closed" });
    expect(scorecards.map((s) => s.scorecardId)).toEqual([SC1]);
  });
});
