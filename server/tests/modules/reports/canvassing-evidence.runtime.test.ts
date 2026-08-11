// Real-SQL proof that every drillable number on the Canvassing Activity report RECONCILES with the records
// behind it (PGlite, Drizzle-derived schema).
//
// This is the property that makes a drill worth having. The report and the drill build on one shared row
// source (canvassingKindSourceSql), so these cases walk EVERY cell of a seeded report and assert the drill
// agrees — rather than spot-checking one and trusting the rest.
//
// The report makes four claims a mocked-SQL test cannot check, and all four are the kind that would send a
// manager after the wrong person:
//   1. a record counts for whoever CREATED it, never whoever currently owns it;
//   2. a record with no recorded creator counts as UNATTRIBUTED and is credited to nobody;
//   3. inactive and test-data rows do not count at all;
//   4. buckets are Sunday-anchored business-timezone weeks (and calendar months/quarters), so a week here
//      starts the same day it starts everywhere else in the platform.
//
// The schema comes from tenantSchemaSql rather than hand-rolled DDL so the new created_by_user_id columns
// arrive from the Drizzle definitions — a hand-rolled table would drift the moment migration 0220 changed.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  activities,
  companies,
  contacts,
  deals,
  leads,
  offices,
  pipelineStageConfig,
  properties,
  userOfficeAccess,
  users,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import {
  CANVASSING_KINDS,
  getCanvassingActivityReport,
  normalizeCanvassingFilters,
} from "../../../src/modules/reports/canvassing-activity-service.js";
import { getCanvassingEvidence } from "../../../src/modules/reports/canvassing-evidence-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;

const OFF = U("0ff1");
const ED = U("ed1"); // Edward McCarty
const CAL = U("ca1"); // Caleb Stone
const CHR = U("cb1"); // Chris — pinned in one case having entered nothing
const OWNER = U("0e1"); // owns records ED created, to prove owner is not the creator
const TESTER = U("7e57"); // users.is_test_data — their records must not reach the scoreboard

const CO_A = U("c0a"); // ED, 06-01
const CO_B = U("c0b"); // ED, 06-01
const CO_C = U("c0c"); // ED, 06-08
const CO_NULL = U("c0d"); // no creator recorded, 06-01
const CO_TEST = U("c0e"); // ED but is_test_data
const CO_GONE = U("c0f"); // ED but soft-deleted
const CO_HOST = U("c10"); // parent for properties, created before the window

const PR_A = U("b0a"); // CAL, 06-02
const CT_A = U("c7a"); // ED, 06-09
const CT_B = U("c7b"); // CAL, 06-15
const CT_C = U("c7c"); // CAL, 06-15
const LE_A = U("1ea"); // CHR, 06-03
const STAGE = U("57a1");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  // The service converts explicitly with AT TIME ZONE, so it should be independent of the session zone.
  // Pinning to a NON-UTC zone here is deliberate: it proves that independence rather than assuming it.
  await pg.exec("SET TimeZone='Asia/Tokyo';");
  await pg.exec(
    // userOfficeAccess: the roster lookup bounds pinned ids to this office via office_id OR a grant here.
    tenantSchemaSql("public", [offices, users, userOfficeAccess, pipelineStageConfig, companies, contacts, properties, leads, deals, activities])
  );

  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES ('${OFF}', 'Dallas', 'dallas');
    INSERT INTO public.users (id, email, display_name, role, office_id, is_active) VALUES
      ('${ED}',    'emccarty@example.com', 'Edward McCarty',  'rep',      '${OFF}', true),
      ('${CAL}',   'cstone@example.com',   'Caleb Stone',     'rep',      '${OFF}', true),
      ('${CHR}',   'chigg@example.com',    'Chris H',         'director', '${OFF}', true),
      ('${TESTER}','tester@example.com',   'QA Tester',       'rep',      '${OFF}', true),
      ('${OWNER}', 'owner@example.com',    'Book Owner',      'rep',      '${OFF}', true);
    UPDATE public.users SET is_test_data = true WHERE id = '${TESTER}';
    INSERT INTO public.pipeline_stage_config (id, slug, name, display_order) VALUES ('${STAGE}', 'estimating', 'Estimating', 3);
  `);

  // 12:00Z is 07:00 in America/Chicago, so every fixture's business date equals its UTC date and the
  // bucket assertions below are not secretly testing the timezone conversion. One boundary row at the
  // bottom does test exactly that, on purpose.
  await pg.exec(`
    INSERT INTO public.companies (id, name, slug, category, owner_id, created_by_user_id, is_active, is_test_data, created_at) VALUES
      ('${CO_HOST}', 'Host Co',   'host-co',   'client', NULL,       NULL,    true,  false, '2026-01-05T12:00:00Z'),
      ('${CO_A}',    'Acme One',  'acme-one',  'client', '${OWNER}', '${ED}', true,  false, '2026-06-01T12:00:00Z'),
      ('${CO_B}',    'Acme Two',  'acme-two',  'client', '${OWNER}', '${ED}', true,  false, '2026-06-01T12:00:00Z'),
      ('${CO_C}',    'Acme Three','acme-three','client', NULL,       '${ED}', true,  false, '2026-06-08T12:00:00Z'),
      ('${CO_NULL}', 'Imported',  'imported',  'client', NULL,       NULL,    true,  false, '2026-06-01T12:00:00Z'),
      ('${CO_TEST}', 'Test Co',   'test-co',   'client', NULL,       '${ED}', true,  true,  '2026-06-01T12:00:00Z'),
      ('${CO_GONE}', 'Deleted Co','deleted-co','client', NULL,       '${ED}', false, false, '2026-06-01T12:00:00Z');

    INSERT INTO public.properties (id, company_id, name, created_by_user_id, is_active, is_test_data, created_at) VALUES
      ('${PR_A}', '${CO_HOST}', 'Tower A', '${CAL}', true, false, '2026-06-02T12:00:00Z');

    INSERT INTO public.contacts (id, first_name, last_name, category, owner_id, created_by_user_id, is_active, is_test_data, created_at) VALUES
      ('${CT_A}', 'Jane', 'Doe',   'property_manager', '${OWNER}', '${ED}',  true, false, '2026-06-09T12:00:00Z'),
      ('${CT_B}', 'Ann',  'Smith', 'property_manager', NULL,       '${CAL}', true, false, '2026-06-15T12:00:00Z'),
      ('${CT_C}', 'Ben',  'Jones', 'property_manager', NULL,       '${CAL}', true, false, '2026-06-15T12:00:00Z');

    INSERT INTO public.leads (id, company_id, property_id, assigned_rep_id, office_code, office, name, stage_id, created_by_user_id, is_active, is_test_data, created_at) VALUES
      ('${LE_A}', '${CO_HOST}', '${PR_A}', '${OWNER}', 'dallas', 'dfw', 'Canvassed lead', '${STAGE}', '${CHR}', true, false, '2026-06-03T12:00:00Z');
  `);

  await pg.exec(`
    INSERT INTO public.activities
      (id, type, source_entity_type, source_entity_id, responsible_user_id, company_id, subject, body, occurred_at, created_at) VALUES
      ('${U("a01")}', 'note', 'company', '${CO_A}', '${ED}',  '${CO_A}', 'Door knock', 'Spoke to the facilities lead.', '2026-06-01T14:00:00Z', '2026-06-01T14:00:00Z'),
      ('${U("a02")}', 'note', 'company', '${CO_A}', '${ED}',  '${CO_A}', 'Follow-up',  'Left a card.',                  '2026-06-02T14:00:00Z', '2026-06-02T14:00:00Z'),
      ('${U("a03")}', 'call', 'company', '${CO_B}', '${CAL}', '${CO_B}', 'Cold call',  'Asked for the PM.',             '2026-06-15T14:00:00Z', '2026-06-15T14:00:00Z'),
      ('${U("a04")}', 'note', 'company', '${CO_B}', '${CAL}', '${CO_B}', 'Site walk',  'Walked the north building.',    '2026-06-16T14:00:00Z', '2026-06-16T14:00:00Z'),
      ('${U("a05")}', 'email','company', '${CO_A}', '${ED}',  '${CO_A}', 'Re: proposal', 'Private mailbox body.',       '2026-06-03T14:00:00Z', '2026-06-03T14:00:00Z');
  `);

  tdb = drizzle(pg);
}, 60_000);

afterAll(async () => {
  await pg?.close?.();
});

function filters(overrides: Partial<ReturnType<typeof normalizeCanvassingFilters>> = {}) {
  return {
    ...normalizeCanvassingFilters({ dateFrom: "2026-06-01", dateTo: "2026-06-30", bucket: "week" }),
    ...overrides,
  };
}

describe("canvassing drill-to-evidence reconciles with every cell", () => {
  it("agrees with each person's whole-range figure, for every kind", async () => {
    const report = await getCanvassingActivityReport(tdb, filters({ officeId: OFF }));

    for (const person of report.people) {
      for (const kind of CANVASSING_KINDS) {
        const drill = await getCanvassingEvidence(tdb, {
          kind,
          userId: person.userId,
          bucket: "week",
          dateFrom: "2026-06-01",
          dateTo: "2026-06-30",
          officeId: OFF,
          viewerRole: "director",
        });
        expect(drill.total, `${person.displayName}/${kind}`).toBe(person.counts[kind]);
        expect(drill.rows.length, `${person.displayName}/${kind} rows`).toBe(person.counts[kind]);
      }
    }
  });

  it("agrees with each PERIOD cell, which is where a mismatched window would show", async () => {
    const report = await getCanvassingActivityReport(tdb, filters({ officeId: OFF, bucket: "week" }));

    for (const bucketRow of report.buckets) {
      for (const cell of bucketRow.perUser) {
        for (const kind of CANVASSING_KINDS) {
          const drill = await getCanvassingEvidence(tdb, {
            kind,
            userId: cell.userId,
            bucketStart: bucketRow.bucketStart,
            bucket: "week",
            dateFrom: "2026-06-01",
            dateTo: "2026-06-30",
            officeId: OFF,
            viewerRole: "director",
          });
          expect(drill.total, `${bucketRow.bucketStart}/${cell.userId}/${kind}`).toBe(cell.counts[kind]);
        }
      }
    }
  });

  it("agrees with the notes figure", async () => {
    const report = await getCanvassingActivityReport(tdb, filters({ officeId: OFF, viewerRole: "director" }));

    for (const person of report.people) {
      const drill = await getCanvassingEvidence(tdb, {
        kind: "notes",
        userId: person.userId,
        bucket: "week",
        dateFrom: "2026-06-01",
        dateTo: "2026-06-30",
        officeId: OFF,
        viewerRole: "director",
      });
      expect(drill.total, person.displayName).toBe(person.notesLogged);
    }
  });

  // The drill must not become the way around the boundary the feed enforces: a rep drilling a COLLEAGUE's
  // notes cell gets the right count and no text.
  it("gives a rep the count but not the text when drilling a colleague's notes", async () => {
    const drill = await getCanvassingEvidence(tdb, {
      kind: "notes",
      userId: ED,
      bucket: "week",
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
      officeId: OFF,
      viewerRole: "rep",
      viewerUserId: CAL,
    });

    expect(drill.total).toBe(2);
    expect(drill.rows).toEqual([]);
    expect(drill.restrictedToSelf).toBe(true);
  });

  it("gives a rep their OWN notes in full", async () => {
    const drill = await getCanvassingEvidence(tdb, {
      kind: "notes",
      userId: CAL,
      bucket: "week",
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
      officeId: OFF,
      viewerRole: "rep",
      viewerUserId: CAL,
    });

    expect(drill.total).toBe(1);
    expect(drill.rows.map((r) => r.label)).toEqual(["Site walk"]);
  });

  it("excludes the same rows the report excludes — a soft-deleted record never appears", async () => {
    // CO_GONE is inactive and CO_TEST is test data; both were created by ED and neither is counted.
    const drill = await getCanvassingEvidence(tdb, {
      kind: "company",
      userId: ED,
      bucket: "week",
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
      officeId: OFF,
      viewerRole: "director",
    });

    expect(drill.total).toBe(3);
    expect(drill.rows.map((r) => r.label)).not.toContain("Deleted Co");
    expect(drill.rows.map((r) => r.label)).not.toContain("Test Co");
  });
});
