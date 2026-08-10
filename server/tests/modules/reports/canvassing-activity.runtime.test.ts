// Real-SQL proof for the Canvassing Activity report (PGlite, Drizzle-derived schema).
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
  users,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import {
  getCanvassingActivityReport,
  normalizeCanvassingFilters,
} from "../../../src/modules/reports/canvassing-activity-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;

const OFF = U("0ff1");
const ED = U("ed1"); // Edward McCarty
const CAL = U("ca1"); // Caleb Stone
const CHR = U("cb1"); // Chris — pinned in one case having entered nothing
const OWNER = U("0e1"); // owns records ED created, to prove owner is not the creator

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
    tenantSchemaSql("public", [offices, users, pipelineStageConfig, companies, contacts, properties, leads, deals, activities])
  );

  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES ('${OFF}', 'Dallas', 'dallas');
    INSERT INTO public.users (id, email, display_name, role, office_id, is_active) VALUES
      ('${ED}',    'emccarty@example.com', 'Edward McCarty',  'rep',      '${OFF}', true),
      ('${CAL}',   'cstone@example.com',   'Caleb Stone',     'rep',      '${OFF}', true),
      ('${CHR}',   'chigg@example.com',    'Chris H',         'director', '${OFF}', true),
      ('${OWNER}', 'owner@example.com',    'Book Owner',      'rep',      '${OFF}', true);
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
      ('${U("a03")}', 'call', 'company', '${CO_B}', '${CAL}', '${CO_B}', 'Cold call',  'Asked for the PM.',             '2026-06-15T14:00:00Z', '2026-06-15T14:00:00Z');
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

describe("canvassing activity — what counts", () => {
  it("counts each kind by its CREATOR, not its owner", async () => {
    const report = await getCanvassingActivityReport(tdb, filters());

    // CO_A and CO_B are owned by OWNER but were created by ED. Crediting the owner would put four
    // records on a person who never canvassed anything.
    expect(report.totals).toEqual({ company: 3, property: 1, contact: 3, lead: 1, total: 8 });
    expect(report.people.find((p) => p.userId === OWNER)).toBeUndefined();

    const ed = report.people.find((p) => p.userId === ED);
    expect(ed?.counts).toEqual({ company: 3, property: 0, contact: 1, lead: 0, total: 4 });
    expect(ed?.displayName).toBe("Edward McCarty");

    const cal = report.people.find((p) => p.userId === CAL);
    expect(cal?.counts).toEqual({ company: 0, property: 1, contact: 2, lead: 0, total: 3 });

    const chr = report.people.find((p) => p.userId === CHR);
    expect(chr?.counts.lead).toBe(1);
  });

  it("credits a record with no recorded creator to NOBODY, and reports it separately", async () => {
    const report = await getCanvassingActivityReport(tdb, filters());

    expect(report.unattributed.company).toBe(1);
    expect(report.unattributed.total).toBe(1);
    // The unattributed row must not leak into anyone's totals, or an import would inflate a person.
    expect(report.people.reduce((sum, p) => sum + p.counts.total, 0)).toBe(report.totals.total);
  });

  it("excludes soft-deleted and test-data rows", async () => {
    const report = await getCanvassingActivityReport(tdb, filters());

    // ED created 5 companies in the window; one is test data and one is soft-deleted, so 3 count.
    expect(report.people.find((p) => p.userId === ED)?.counts.company).toBe(3);
    expect(report.totals.company).toBe(3);
  });

  it("sorts people by total entered, descending", async () => {
    const report = await getCanvassingActivityReport(tdb, filters());
    const totals = report.people.map((p) => p.counts.total);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
  });
});

describe("canvassing activity — bucketing", () => {
  it("buckets weeks on the platform's SUNDAY anchor", async () => {
    const report = await getCanvassingActivityReport(tdb, filters({ bucket: "week" }));
    const byStart = new Map(report.buckets.map((b) => [b.bucketStart, b]));

    // Mon 06-01 and Tue 06-02 and Wed 06-03 belong to the week beginning Sunday 05-31.
    expect(byStart.get("2026-05-31")?.counts).toEqual({ company: 2, property: 1, contact: 0, lead: 1, total: 4 });
    // Mon 06-08 and Tue 06-09 belong to the week beginning Sunday 06-07.
    expect(byStart.get("2026-06-07")?.counts).toEqual({ company: 1, property: 0, contact: 1, lead: 0, total: 2 });
    // Mon 06-15 belongs to the week beginning Sunday 06-14.
    expect(byStart.get("2026-06-14")?.counts).toEqual({ company: 0, property: 0, contact: 2, lead: 0, total: 2 });
  });

  it("keeps the unattributed row in its own bucket rather than the totals", async () => {
    const report = await getCanvassingActivityReport(tdb, filters({ bucket: "week" }));
    const first = report.buckets.find((b) => b.bucketStart === "2026-05-31");

    expect(first?.unattributed.company).toBe(1);
    expect(first?.counts.company).toBe(2);
  });

  it("collapses to one calendar month, and one calendar quarter", async () => {
    const month = await getCanvassingActivityReport(tdb, filters({ bucket: "month" }));
    expect(month.buckets.map((b) => b.bucketStart)).toEqual(["2026-06-01"]);
    expect(month.buckets[0]?.counts.total).toBe(8);

    const quarter = await getCanvassingActivityReport(tdb, filters({ bucket: "quarter" }));
    expect(quarter.buckets.map((b) => b.bucketStart)).toEqual(["2026-04-01"]);
    expect(quarter.buckets[0]?.counts.total).toBe(8);
  });

  it("returns buckets in chronological order", async () => {
    const report = await getCanvassingActivityReport(tdb, filters({ bucket: "week" }));
    const starts = report.buckets.map((b) => b.bucketStart);
    expect(starts).toEqual([...starts].sort());
  });
});

describe("canvassing activity — pinned people", () => {
  it("keeps a pinned person who entered NOTHING, as an explicit zero", async () => {
    // The whole point of an accountability report: a blank row is the finding. Building the roster only
    // from rows that exist would silently drop the person who did no canvassing at all.
    const report = await getCanvassingActivityReport(tdb, filters({ userIds: [CAL, OWNER] }));

    const owner = report.people.find((p) => p.userId === OWNER);
    expect(owner).toBeDefined();
    expect(owner?.counts).toEqual({ company: 0, property: 0, contact: 0, lead: 0, total: 0 });
    expect(owner?.displayName).toBe("Book Owner");
  });

  it("drops everyone who was not pinned", async () => {
    const report = await getCanvassingActivityReport(tdb, filters({ userIds: [CAL] }));

    expect(report.people.map((p) => p.userId)).toEqual([CAL]);
    expect(report.totals).toEqual({ company: 0, property: 1, contact: 2, lead: 0, total: 3 });
  });

  it("still reports whole-office unattributed counts when pinned — they belong to nobody", async () => {
    const report = await getCanvassingActivityReport(tdb, filters({ userIds: [CAL] }));
    expect(report.unattributed.company).toBe(1);
  });
});

describe("canvassing activity — notes feed", () => {
  it("returns the notes those people logged, newest first, with the record they are attached to", async () => {
    const report = await getCanvassingActivityReport(tdb, filters());

    expect(report.notesLogged).toBe(3);
    expect(report.notes).toHaveLength(3);
    expect(report.notes[0]?.subject).toBe("Cold call");
    expect(report.notes[0]?.userName).toBe("Caleb Stone");
    expect(report.notes[0]?.targetType).toBe("company");
    expect(report.notes[0]?.targetName).toBe("Acme Two");
    expect(report.notes[0]?.body).toBe("Asked for the PM.");
  });

  it("narrows the feed to pinned people", async () => {
    const report = await getCanvassingActivityReport(tdb, filters({ userIds: [ED] }));

    expect(report.notes.map((n) => n.subject)).toEqual(["Follow-up", "Door knock"]);
    expect(report.notesLogged).toBe(2);
  });

  it("reports truncation as a fact rather than stopping silently", async () => {
    const capped = await getCanvassingActivityReport(tdb, filters({ notesLimit: 2 }));

    expect(capped.notes).toHaveLength(2);
    expect(capped.notesTruncated).toBe(true);

    const uncapped = await getCanvassingActivityReport(tdb, filters({ notesLimit: 50 }));
    expect(uncapped.notesTruncated).toBe(false);
  });
});

describe("canvassing activity — attribution honesty", () => {
  it("reports the earliest attributed creation so a zero before it is not read as inactivity", async () => {
    const report = await getCanvassingActivityReport(tdb, filters());
    expect(report.attributionStartHint).toBe("2026-06-01");
  });

  it("reports a window entirely before attribution as zero WITH the hint still set", async () => {
    const report = await getCanvassingActivityReport(
      tdb,
      filters({ dateFrom: "2026-01-01", dateTo: "2026-01-31" })
    );

    expect(report.totals.total).toBe(0);
    expect(report.people).toHaveLength(0);
    // The hint is what stops "0 in January" from reading as "the team did nothing in January".
    expect(report.attributionStartHint).toBe("2026-06-01");
  });
});

describe("canvassing activity — filter normalization", () => {
  it("defaults an unknown bucket to week rather than failing a stale bookmark", () => {
    expect(normalizeCanvassingFilters({ bucket: "fortnight" }).bucket).toBe("week");
    expect(normalizeCanvassingFilters({}).bucket).toBe("week");
    expect(normalizeCanvassingFilters({ bucket: "QUARTER" }).bucket).toBe("quarter");
  });

  it("swaps an inverted range instead of returning nothing", () => {
    const parsed = normalizeCanvassingFilters({ dateFrom: "2026-06-30", dateTo: "2026-06-01" });
    expect(parsed.dateFrom).toBe("2026-06-01");
    expect(parsed.dateTo).toBe("2026-06-30");
  });

  it("drops anything in userIds that is not a UUID", () => {
    const parsed = normalizeCanvassingFilters({ userIds: `${ED},not-a-uuid,'; DROP TABLE users; --` });
    expect(parsed.userIds).toEqual([ED]);
  });

  it("caps notesLimit and ignores a nonsense value", () => {
    expect(normalizeCanvassingFilters({ notesLimit: "99999" }).notesLimit).toBe(500);
    expect(normalizeCanvassingFilters({ notesLimit: "-4" }).notesLimit).toBe(200);
    expect(normalizeCanvassingFilters({ notesLimit: "abc" }).notesLimit).toBe(200);
  });
});

describe("canvassing activity — timezone", () => {
  it("windows and buckets on the BUSINESS date, not the session's", async () => {
    // 2026-06-08T03:00:00Z is 2026-06-07 22:00 in America/Chicago, so it belongs to June 7 — which is
    // itself a Sunday, and therefore the start of its own week. Under the session zone set in this file
    // (Asia/Tokyo) the same instant is June 8, which would land it in the following week. The assertion
    // pins the business-timezone reading.
    const LATE = U("c99");
    await pg.exec(`
      INSERT INTO public.companies (id, name, slug, category, created_by_user_id, is_active, is_test_data, created_at)
      VALUES ('${LATE}', 'Late Night', 'late-night', 'client', '${ED}', true, false, '2026-06-08T03:00:00Z');
    `);

    const report = await getCanvassingActivityReport(tdb, filters({ bucket: "week" }));
    const byStart = new Map(report.buckets.map((b) => [b.bucketStart, b]));
    expect(byStart.get("2026-06-07")?.counts.company).toBe(2);

    await pg.exec(`DELETE FROM public.companies WHERE id = '${LATE}';`);
  });
});
