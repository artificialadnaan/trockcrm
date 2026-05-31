import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

/**
 * REAL-SQL runtime coverage (PGlite in-memory Postgres) for the TrockCam photo
 * picker leads bug. Mocks were the gap that let prior fixes ship "looking fixed",
 * so this boots an actual Postgres, seeds the prod-shaped problem (deals >> leads,
 * leads owned by OTHER reps, a lead whose property has a blank address), and runs
 * the REAL searchPhotoUploadTargets / searchFieldCaptureTargets /
 * assertAccessibleFieldCaptureTarget against it.
 *
 * Root cause (see .audit/trockcam-leads-not-returning.md):
 *   1. cross-type merged cap slice(0,limit) lets deals (~12:1) evict every lead;
 *   2. the field path rep-scopes search AND attach, hiding non-owned leads.
 */

vi.mock("../../../src/lib/r2-client.js", () => ({
  generateUploadUrl: vi.fn().mockResolvedValue("https://mock-upload-url.com"),
  generateDownloadUrl: vi.fn().mockResolvedValue("https://mock-download-url.com"),
  generateMockUploadUrl: vi.fn(() => "https://mock-upload-url.com"),
  generateMockDownloadUrl: vi.fn(() => "https://mock-download-url.com"),
  headObject: vi.fn().mockResolvedValue({ contentLength: 1024 }),
  isR2Configured: vi.fn(() => true),
}));

import { searchPhotoUploadTargets } from "../../../src/modules/files/service.js";
import {
  searchFieldCaptureTargets,
  assertAccessibleFieldCaptureTarget,
  assertScopedCaptureTargetAccess,
} from "../../../src/modules/field/projects-service.js";

const T = "office_test";
const STAGE = "00000000-0000-0000-0000-0000000000a1";
const CO = "00000000-0000-0000-0000-0000000000b1";
const PROP_ADDR = "00000000-0000-0000-0000-0000000000c1"; // property WITH address
const PROP_BLANK = "00000000-0000-0000-0000-0000000000c2"; // property with BLANK address
const CT = "00000000-0000-0000-0000-0000000000d1";
const REP_A = "00000000-0000-0000-0000-00000000000a"; // the searching rep
const REP_B = "00000000-0000-0000-0000-00000000000b"; // owns the leads (NOT rep A)
// leads (all owned by REP_B, i.e. NOT the searcher)
const L_ROOF1 = "00000000-0000-0000-0000-0000000010a1";
const L_ROOF2 = "00000000-0000-0000-0000-0000000010a2";
const L_BLANK = "00000000-0000-0000-0000-0000000010a3"; // property has blank address
const L_INACTIVE = "00000000-0000-0000-0000-0000000010a4";
const OPP_ROOF = "00000000-0000-0000-0000-0000000030a1"; // an OPPORTUNITY (deal-table) matching "roof"

let pg: PGlite;
let tdb: never;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA ${T};
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, name text, display_order int);
    CREATE TABLE ${T}.companies (id uuid PRIMARY KEY, name text);
    CREATE TABLE ${T}.properties (id uuid PRIMARY KEY, name text, address text, city text, state text);
    CREATE TABLE ${T}.contacts (id uuid PRIMARY KEY, first_name text, last_name text);
    CREATE TABLE ${T}.leads (
      id uuid PRIMARY KEY, name text NOT NULL, company_id uuid, property_id uuid,
      primary_contact_id uuid, stage_id uuid, assigned_rep_id uuid,
      source text, source_detail text, description text,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${T}.deals (
      id uuid PRIMARY KEY, name text NOT NULL, deal_number text, pipeline_disposition text,
      company_id uuid, property_id uuid, primary_contact_id uuid, stage_id uuid, assigned_rep_id uuid,
      source text, description text, property_address text, property_city text, property_state text,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    SET search_path TO ${T}, public;
  `);

  await pg.exec(`
    INSERT INTO public.pipeline_stage_config (id, name, display_order) VALUES ('${STAGE}', 'New Lead', 1);
    INSERT INTO ${T}.companies (id, name) VALUES ('${CO}', 'Birchstone Residential');
    INSERT INTO ${T}.properties (id, name, address, city, state) VALUES
      ('${PROP_ADDR}', 'Maple Court', '100 Oak Street', 'Dallas', 'TX'),
      ('${PROP_BLANK}', NULL, NULL, NULL, NULL);
    INSERT INTO ${T}.contacts (id, first_name, last_name) VALUES ('${CT}', 'Jane', 'Smith');
  `);

  // Leads owned by REP_B. "roof" appears only in the DESCRIPTION (relevance tier 1),
  // so the deal flood (name-prefix "Roof", tier 2) would evict them under the old cap.
  await pg.exec(`
    INSERT INTO ${T}.leads (id, name, company_id, property_id, primary_contact_id, stage_id, assigned_rep_id, description, updated_at) VALUES
      ('${L_ROOF1}', 'Oakwood Replacement', '${CO}', '${PROP_ADDR}', '${CT}', '${STAGE}', '${REP_B}', 'tear-off roof job', now() - interval '40 days'),
      ('${L_ROOF2}', 'Sunset Villas Job',  '${CO}', '${PROP_ADDR}', '${CT}', '${STAGE}', '${REP_B}', 'roof inspection',   now() - interval '41 days'),
      ('${L_BLANK}', 'Cottages at Bedford','${CO}', '${PROP_BLANK}','${CT}', '${STAGE}', '${REP_B}', 'roof leak',        now() - interval '42 days'),
      ('${L_INACTIVE}', 'Closed Roof Lead','${CO}', '${PROP_ADDR}', '${CT}', '${STAGE}', '${REP_B}', 'roof',            now() - interval '43 days');
    UPDATE ${T}.leads SET is_active = false WHERE id = '${L_INACTIVE}';
  `);

  // 40 deals owned by REP_A, name-prefix "Roof" (relevance tier 2) and most recently
  // updated -> under the old merged cap they fill all 30 slots and evict the leads.
  const dealValues = Array.from({ length: 40 }, (_, i) =>
    `('00000000-0000-0000-0000-0000000020${String(i).padStart(2, "0")}', 'Roof Job ${i}', 'D-${i}', 'deal', '${CO}', '${PROP_ADDR}', '${CT}', '${STAGE}', '${REP_A}', 'Dallas roof', now() - interval '${i} minutes')`
  ).join(",\n");
  await pg.exec(
    `INSERT INTO ${T}.deals (id, name, deal_number, pipeline_disposition, company_id, property_id, primary_contact_id, stage_id, assigned_rep_id, description, updated_at) VALUES ${dealValues};`
  );
  // One OPPORTUNITY (deal-table) matching "roof", owned by REP_B, OLDER than the deal
  // flood -> a shared deal/opportunity bucket would evict it before its own UI group.
  await pg.exec(
    `INSERT INTO ${T}.deals (id, name, deal_number, pipeline_disposition, company_id, property_id, primary_contact_id, stage_id, assigned_rep_id, description, updated_at) VALUES
      ('${OPP_ROOF}', 'Roof Opportunity', 'O-1', 'opportunity', '${CO}', '${PROP_ADDR}', '${CT}', '${STAGE}', '${REP_B}', 'roof opportunity', now() - interval '90 days');`
  );

  tdb = drizzle(pg) as never;
});

afterAll(async () => {
  await pg?.close?.();
});

function ids(targets: Array<{ id: string; type: string }>) {
  return new Set(targets.map((t) => t.id));
}

describe("searchPhotoUploadTargets — cross-type cap must not evict leads", () => {
  it("returns matching leads even when deals (>>leads) flood the same search", async () => {
    const { targets } = await searchPhotoUploadTargets(tdb, { search: "roof", limit: 30 });
    const leadIds = targets.filter((t) => t.type === "lead").map((t) => t.id);
    // All three active "roof" leads must survive alongside the 40-deal flood.
    expect(leadIds).toEqual(expect.arrayContaining([L_ROOF1, L_ROOF2, L_BLANK]));
    // The inactive lead is not a positive requirement here (the picker has no active
    // filter today); the assertion above is the regression lock for the cap fix.
  });

  it("caps deals at the limit while still returning leads (per-type budget)", async () => {
    const { targets } = await searchPhotoUploadTargets(tdb, { search: "roof", limit: 30 });
    const deals = targets.filter((t) => t.type === "deal");
    const leads = targets.filter((t) => t.type === "lead");
    expect(deals.length).toBeLessThanOrEqual(30);
    expect(leads.length).toBeGreaterThanOrEqual(3);
  });

  it("returns a matching OPPORTUNITY even when the deal flood would fill the cap", async () => {
    const { targets } = await searchPhotoUploadTargets(tdb, { search: "roof", limit: 30 });
    const opportunityIds = targets.filter((t) => t.type === "opportunity").map((t) => t.id);
    expect(opportunityIds).toContain(OPP_ROOF);
  });

  it("excludes INACTIVE records (they can't be attached, so must not appear)", async () => {
    const { targets } = await searchPhotoUploadTargets(tdb, { search: "roof", limit: 30 });
    expect(ids(targets).has(L_INACTIVE)).toBe(false);
  });
});

describe("searchPhotoUploadTargets — direct search returns the lead (left join, own fields)", () => {
  it("finds a lead by NAME even when its property has a blank address", async () => {
    const { targets } = await searchPhotoUploadTargets(tdb, { search: "Cottages at Bedford" });
    expect(ids(targets).has(L_BLANK)).toBe(true);
  });
  it("finds a lead by its SITE ADDRESS", async () => {
    const { targets } = await searchPhotoUploadTargets(tdb, { search: "100 Oak" });
    expect(ids(targets).has(L_ROOF1)).toBe(true);
  });
  it("finds a lead by its CONTACT name", async () => {
    const { targets } = await searchPhotoUploadTargets(tdb, { search: "Jane Smith" });
    const leadIds = ids(targets);
    expect(leadIds.has(L_ROOF1) || leadIds.has(L_ROOF2) || leadIds.has(L_BLANK)).toBe(true);
  });
});

describe("searchFieldCaptureTargets — UNSCOPED (any rep finds any lead)", () => {
  it("returns a lead owned by ANOTHER rep when the searcher is a rep", async () => {
    const { targets } = await searchFieldCaptureTargets(
      tdb,
      { userId: REP_A, userRole: "rep" },
      { search: "Cottages at Bedford", limit: 30 }
    );
    expect(ids(targets).has(L_BLANK)).toBe(true);
  });
});

describe("assertAccessibleFieldCaptureTarget — UNSCOPED attach (any rep attaches to any active lead)", () => {
  it("accepts an active lead owned by ANOTHER rep", async () => {
    await expect(
      assertAccessibleFieldCaptureTarget(tdb, {
        leadId: L_BLANK,
        userRole: "rep" as never,
        userId: REP_A,
      })
    ).resolves.toEqual({ id: L_BLANK, type: "lead" });
  });

  it("still rejects an INACTIVE lead", async () => {
    await expect(
      assertAccessibleFieldCaptureTarget(tdb, {
        leadId: L_INACTIVE,
        userRole: "rep" as never,
        userId: REP_A,
      })
    ).rejects.toThrow();
  });

  it("accepts an active deal owned by ANOTHER rep", async () => {
    const dealId = "00000000-0000-0000-0000-0000000020" + "00";
    await expect(
      assertAccessibleFieldCaptureTarget(tdb, {
        dealId,
        userRole: "rep" as never,
        userId: REP_B,
      })
    ).resolves.toEqual({ id: dealId, type: "deal" });
  });
});

describe("assertScopedCaptureTargetAccess — SCOPED (existing-photo edits stay rep-owned)", () => {
  it("rejects a rep accessing a lead they do NOT own (no broad cross-rep photo edits)", async () => {
    await expect(
      assertScopedCaptureTargetAccess(tdb, {
        leadId: L_BLANK, // owned by REP_B
        userRole: "rep" as never,
        userId: REP_A,
      })
    ).rejects.toThrow();
  });

  it("accepts the rep who OWNS the lead", async () => {
    await expect(
      assertScopedCaptureTargetAccess(tdb, {
        leadId: L_BLANK,
        userRole: "rep" as never,
        userId: REP_B,
      })
    ).resolves.toBeUndefined();
  });

  it("does not rep-gate a non-rep role (e.g. admin/director sees all)", async () => {
    await expect(
      assertScopedCaptureTargetAccess(tdb, {
        leadId: L_BLANK,
        userRole: "admin" as never,
        userId: REP_A,
      })
    ).resolves.toBeUndefined();
  });

  it("rejects an inactive lead even for its owner", async () => {
    await expect(
      assertScopedCaptureTargetAccess(tdb, {
        leadId: L_INACTIVE,
        userRole: "rep" as never,
        userId: REP_B,
      })
    ).rejects.toThrow();
  });
});
