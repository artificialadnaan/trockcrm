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
  userOfficeAccess,
  users,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import {
  asIsoDate,
  getCanvassingActivityReport,
  labelForBucket,
  normalizeCanvassingFilters,
} from "../../../src/modules/reports/canvassing-activity-service.js";

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

describe("canvassing activity — what counts", () => {
  it("counts each kind by its CREATOR, not its owner", async () => {
    const report = await getCanvassingActivityReport(tdb, filters());

    // CO_A and CO_B are owned by OWNER but were created by ED. Crediting the owner would put four
    // records on a person who never canvassed anything.
    expect(report.totals).toEqual({ company: 3, property: 1, contact: 3, lead: 1, total: 8 });
    // OWNER owns CO_A and CO_B but created nothing. They appear (the default roster is the office's sales
    // carriers, so a zero week is visible) but are credited with NOTHING — which is the actual claim here.
    expect(report.people.find((p) => p.userId === OWNER)?.counts.total).toBe(0);

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
    expect(report.notes[0]?.subject).toBe("Site walk");
    expect(report.notes[0]?.userName).toBe("Caleb Stone");
    expect(report.notes[0]?.targetType).toBe("company");
    expect(report.notes[0]?.targetName).toBe("Acme Two");
    expect(report.notes[0]?.body).toBe("Walked the north building.");
  });

  // "Notes logged" has to mean what it means on Rep Activity and the Daily Activity Log: type='note'.
  // Counting every activity type would fold in the email rows the Outlook sync mints per synced message —
  // machine-generated rather than logged by anyone, and carrying real mailbox subjects and bodies. An
  // earlier draft of this suite seeded a 'call' and asserted it AS a note, which is how the bug survived.
  it("counts and shows ONLY notes — never calls, and never synced email", async () => {
    const report = await getCanvassingActivityReport(tdb, filters());

    expect(report.notes.map((note) => note.type)).toEqual(["note", "note", "note"]);
    expect(report.notes.map((note) => note.subject)).not.toContain("Cold call");
    expect(report.notes.map((note) => note.subject)).not.toContain("Re: proposal");
    expect(report.notes.map((note) => note.body)).not.toContain("Private mailbox body.");
    // Three notes exist in this window; five activities do.
    expect(report.notesLogged).toBe(3);
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
    // The roster still lists the office's sales carriers, all at zero — that is the point of the hint below.
    expect(report.people.every((p) => p.counts.total === 0)).toBe(true);
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

  // ISO-SHAPED is not the same as REAL. "2026-13-45" passes a /^\d{4}-\d{2}-\d{2}$/ test and then reaches
  // Postgres as `'2026-13-45'::date`, which errors — turning a stale bookmark into a 500, the exact opposite
  // of what this normalizer promises.
  it("rejects an ISO-shaped date that is not a real date", () => {
    const bad = normalizeCanvassingFilters({ dateFrom: "2026-13-45", dateTo: "2026-02-30" });
    expect(bad.dateFrom).not.toBe("2026-13-45");
    expect(bad.dateTo).not.toBe("2026-02-30");
    expect(bad.dateFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(bad.dateTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // And the fallback it chose must itself be a real, ordered range.
    expect(bad.dateFrom <= bad.dateTo).toBe(true);
  });

  it("accepts a real leap day and rejects a fake one", () => {
    expect(normalizeCanvassingFilters({ dateFrom: "2024-02-29", dateTo: "2024-03-01" }).dateFrom).toBe("2024-02-29");
    expect(normalizeCanvassingFilters({ dateFrom: "2026-02-29", dateTo: "2026-03-01" }).dateFrom).not.toBe("2026-02-29");
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

// The bug this section exists for: `::date` columns do NOT arrive as strings in production. node-postgres
// registers a parser for type 1082 that returns a JS Date, so `String(bucket_start).slice(0,10)` read
// "Sun May 31" and labelForBucket then threw a RangeError formatting an Invalid Date — a 500 on the default
// view. It was invisible here because drizzle's PGlite driver overrides the DATE parser to pass the raw
// string through, so the runtime suite exercises a shape production never produces.
//
// The real fix is the `::text` cast in the queries. These cases cover the second line of defence, which is
// the part a test CAN reach: the normaliser must handle both shapes, and the label must never throw.
describe("canvassing activity — date shapes across drivers", () => {
  it("normalises the Date that node-postgres actually returns, not just the string PGlite returns", () => {
    expect(asIsoDate(new Date(Date.UTC(2026, 4, 31)))).toBe("2026-05-31");
    expect(asIsoDate("2026-05-31")).toBe("2026-05-31");
    expect(asIsoDate("2026-05-31T00:00:00Z")).toBe("2026-05-31");
  });

  it("labels every bucket type without throwing", () => {
    expect(labelForBucket("month", "2026-06-01")).toBe("Jun 2026");
    expect(labelForBucket("quarter", "2026-04-01")).toBe("Q2 2026");
    expect(labelForBucket("quarter", "2026-01-01")).toBe("Q1 2026");
    expect(labelForBucket("week", "2026-05-31")).toBe("May 31 – Jun 6");
  });

  // Formatting an Invalid Date raises a RangeError, which would turn one odd value into a 500 for the whole
  // report. Degrade to the raw key instead.
  it("degrades to the raw key rather than throwing on a value it cannot parse", () => {
    expect(() => labelForBucket("week", "Sun May 31")).not.toThrow();
    expect(labelForBucket("week", "Sun May 31")).toBe("Sun May 31");
    expect(labelForBucket("month", "")).toBe("");
  });

  it("emits plain YYYY-MM-DD bucket keys and real labels end to end", async () => {
    const report = await getCanvassingActivityReport(tdb, filters({ bucket: "week" }));

    for (const bucket of report.buckets) {
      expect(bucket.bucketStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(bucket.label).not.toContain("NaN");
      expect(bucket.label).not.toBe(bucket.bucketStart);
    }
    expect(report.buckets.map((b) => b.label)).toContain("May 31 – Jun 6");
  });
});


describe("canvassing activity — findings from review", () => {
  const TEST_CO = U("dead");
  const OLD_LEAD = U("01d1");

  // A user flagged is_test_data creating an otherwise ordinary company was counted: the stream filtered the
  // ROW's test flag but never the CREATOR's, while the notes queries did. That inflates the scoreboard and
  // contradicts this file's own "test data excluded" rule.
  it("excludes records created BY a test user, even when the record itself is not test data", async () => {
    await pg.exec(`
      INSERT INTO public.companies (id, name, slug, category, created_by_user_id, is_active, is_test_data, created_at)
      VALUES ('${TEST_CO}', 'QA Co', 'qa-co', 'client', '${TESTER}', true, false, '2026-06-01T12:00:00Z');
    `);

    const report = await getCanvassingActivityReport(tdb, filters({ officeId: OFF }));
    // Absent entirely: excluded from the counting queries AND from the default roster.
    expect(report.people.find((p) => p.userId === TESTER)).toBeUndefined();
    expect(report.totals.company).toBe(3);
    // And it is not silently reclassified as unattributed either — it is simply not this report's business.
    expect(report.unattributed.company).toBe(1);

    await pg.exec(`DELETE FROM public.companies WHERE id = '${TEST_CO}';`);
  });

  // leads has carried created_by_user_id since migration 0128, long before 0220 gave it to the other three.
  // Taking the hint from all four would report the older lead's date, telling a reader that creator tracking
  // began then — while companies/properties/contacts were still structurally unattributed.
  it("does not let an older attributed LEAD drag the attribution hint back before 0220", async () => {
    await pg.exec(`
      INSERT INTO public.leads (id, company_id, property_id, assigned_rep_id, office_code, office, name, stage_id, created_by_user_id, is_active, is_test_data, created_at)
      VALUES ('${OLD_LEAD}', '${CO_HOST}', '${PR_A}', '${OWNER}', 'dallas', 'dfw', 'Ancient lead', '${STAGE}', '${ED}', true, false, '2025-03-04T12:00:00Z');
    `);

    const report = await getCanvassingActivityReport(tdb, filters());
    expect(report.attributionStartHint).toBe("2026-06-01");
    expect(report.attributionStartHint).not.toBe("2025-03-04");

    await pg.exec(`DELETE FROM public.leads WHERE id = '${OLD_LEAD}';`);
  });
});

describe("canvassing activity — findings from the second review round", () => {
  // A period with nothing in it produced no row at all, so weeks 1 and 3 rendered as adjacent columns and
  // the quiet week between them vanished — the exact opposite of what an accountability report is for.
  it("materialises every calendar week in the range, including the empty ones", async () => {
    const report = await getCanvassingActivityReport(tdb, filters({ bucket: "week" }));

    // 2026-06-01..06-30 spans the Sundays May 31, Jun 7, 14, 21 and 28.
    expect(report.buckets.map((b) => b.bucketStart)).toEqual([
      "2026-05-31",
      "2026-06-07",
      "2026-06-14",
      "2026-06-21",
      "2026-06-28",
    ]);
    // Jun 21 and Jun 28 have no activity at all and must still be present, at zero.
    const quiet = report.buckets.find((b) => b.bucketStart === "2026-06-21");
    expect(quiet?.counts).toEqual({ company: 0, property: 0, contact: 0, lead: 0, total: 0 });
    expect(quiet?.perUser).toEqual([]);
  });

  it("materialises months and quarters the same way", async () => {
    const months = await getCanvassingActivityReport(
      tdb,
      filters({ bucket: "month", dateFrom: "2026-05-01", dateTo: "2026-08-31" })
    );
    expect(months.buckets.map((b) => b.bucketStart)).toEqual(["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"]);

    const quarters = await getCanvassingActivityReport(
      tdb,
      filters({ bucket: "quarter", dateFrom: "2026-02-01", dateTo: "2026-08-31" })
    );
    expect(quarters.buckets.map((b) => b.bucketStart)).toEqual(["2026-01-01", "2026-04-01", "2026-07-01"]);
  });

  it("gives a pinned person who did nothing all range a full row of zero buckets", async () => {
    const report = await getCanvassingActivityReport(tdb, filters({ userIds: [OWNER], officeId: OFF }));

    expect(report.people.map((p) => p.userId)).toEqual([OWNER]);
    expect(report.buckets).toHaveLength(5);
    expect(report.buckets.every((b) => b.counts.total === 0)).toBe(true);
  });

  // `users` is a single GLOBAL table. Resolving an arbitrary pinned uuid returned that person's name,
  // email, role and active flag as a zero-count row — reading the global directory through a tenant report.
  it("refuses to resolve a pinned user who is not a member of this office", async () => {
    const OTHER_OFFICE = U("0ff2");
    const OUTSIDER = U("0475");
    await pg.exec(`
      INSERT INTO public.offices (id, name, slug) VALUES ('${OTHER_OFFICE}', 'Atlanta', 'atlanta');
      INSERT INTO public.users (id, email, display_name, role, office_id, is_active)
      VALUES ('${OUTSIDER}', 'outsider@example.com', 'Outside Person', 'rep', '${OTHER_OFFICE}', true);
    `);

    const report = await getCanvassingActivityReport(tdb, filters({ userIds: [OUTSIDER], officeId: OFF }));

    expect(report.people).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("outsider@example.com");
    expect(JSON.stringify(report)).not.toContain("Outside Person");

    // A member of THIS office is still resolved, so the guard narrows rather than breaking the feature.
    const ok = await getCanvassingActivityReport(tdb, filters({ userIds: [OWNER], officeId: OFF }));
    expect(ok.people.map((p) => p.displayName)).toEqual(["Book Owner"]);

    await pg.exec(`DELETE FROM public.users WHERE id = '${OUTSIDER}'; DELETE FROM public.offices WHERE id = '${OTHER_OFFICE}';`);
  });

  it("still lists someone who created records here, even without a current office grant", async () => {
    // Their rows live in this schema, so they are already this tenant's business — the guard is about
    // arbitrary lookups, not about erasing real contributors.
    const report = await getCanvassingActivityReport(tdb, filters({ officeId: OFF }));
    expect(report.people.map((p) => p.displayName)).toContain("Edward McCarty");
  });

  // Postgres has no year zero, so this reached `'0000-01-01'::date` and 500'd instead of falling back.
  it("rejects year zero, which JavaScript round-trips happily", () => {
    const parsed = normalizeCanvassingFilters({ dateFrom: "0000-01-01", dateTo: "2026-01-01" });
    expect(parsed.dateFrom).not.toBe("0000-01-01");
    expect(parsed.dateFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number(parsed.dateFrom.slice(0, 4))).toBeGreaterThan(0);
  });
});

describe("canvassing activity — the window is sargable AND still exact", () => {
  // The WHERE moved off `((created_at AT TIME ZONE ...)::date) BETWEEN a AND b` onto a half-open range on
  // the bare column, so the created_at indexes can actually narrow it. These cases pin that the rewrite
  // selects the SAME rows: both endpoints inclusive by business date, nothing either side.
  const EDGE_BEFORE = U("ed9e");
  const EDGE_FIRST = U("ed01");
  const EDGE_LAST = U("ed30");
  const EDGE_AFTER = U("ed31");

  it("includes both endpoint days in full and excludes the days either side", async () => {
    await pg.exec(`
      INSERT INTO public.companies (id, name, slug, category, created_by_user_id, is_active, is_test_data, created_at) VALUES
        -- 2026-05-31 23:59 business time = 2026-06-01T04:59Z. Outside a June 1-30 window.
        ('${EDGE_BEFORE}', 'Edge Before', 'edge-before', 'client', '${ED}', true, false, '2026-06-01T04:59:00Z'),
        -- 2026-06-01 00:01 business time. The first instant inside.
        ('${EDGE_FIRST}', 'Edge First',  'edge-first',  'client', '${ED}', true, false, '2026-06-01T05:01:00Z'),
        -- 2026-06-30 23:59 business time. The last instant inside — the half-open end must not clip it.
        ('${EDGE_LAST}',  'Edge Last',   'edge-last',   'client', '${ED}', true, false, '2026-07-01T04:59:00Z'),
        -- 2026-07-01 00:01 business time. The first instant outside.
        ('${EDGE_AFTER}', 'Edge After',  'edge-after',  'client', '${ED}', true, false, '2026-07-01T05:01:00Z');
    `);

    const report = await getCanvassingActivityReport(tdb, filters());
    // 3 from the base fixture + the two edge rows that genuinely fall inside.
    expect(report.totals.company).toBe(5);

    await pg.exec(`DELETE FROM public.companies WHERE id IN ('${EDGE_BEFORE}','${EDGE_FIRST}','${EDGE_LAST}','${EDGE_AFTER}');`);
  });

  // The old code capped the bucket LOOP, so a very long range silently lost periods out of a grid that
  // promises every one — with no explanation anywhere in the payload. The window is clamped instead, and
  // the returned range says so.
  it("clamps an absurd range instead of silently truncating the bucket grid", () => {
    const parsed = normalizeCanvassingFilters({ dateFrom: "2000-01-01", dateTo: "2026-12-31", bucket: "week" });

    expect(parsed.dateTo).toBe("2026-12-31");
    expect(parsed.dateFrom).not.toBe("2000-01-01");
    expect(parsed.dateFrom > "2020-01-01").toBe(true);
  });

  it("reports buckets covering exactly the clamped range it returns", async () => {
    const parsed = normalizeCanvassingFilters({ dateFrom: "2000-01-01", dateTo: "2026-12-31", bucket: "quarter" });
    const report = await getCanvassingActivityReport(tdb, { ...parsed, officeId: OFF });

    expect(report.range.from).toBe(parsed.dateFrom);
    expect(report.buckets[0]!.bucketStart <= parsed.dateFrom).toBe(true);
    expect(report.buckets[report.buckets.length - 1]!.bucketStart <= parsed.dateTo).toBe(true);
    // No gap: consecutive quarters, start to finish.
    for (let i = 1; i < report.buckets.length; i += 1) {
      expect(report.buckets[i]!.bucketStart > report.buckets[i - 1]!.bucketStart).toBe(true);
    }
  });
});

describe("canvassing activity — owner selections in their legacy forms", () => {
  // The filter bar writes ?owners= and ?ownerEmails= as well as ?ownerIds=, resolves them locally and ticks
  // the person — but only ids reached this report, so the page showed a filter applied while the numbers
  // stayed office-wide until Apply was pressed.
  it("resolves an owner NAME to the same report a pinned id produces", async () => {
    const byName = await getCanvassingActivityReport(tdb, filters({ ownerNames: ["Caleb Stone"], officeId: OFF }));
    const byId = await getCanvassingActivityReport(tdb, filters({ userIds: [CAL], officeId: OFF }));

    expect(byName.people.map((p) => p.userId)).toEqual([CAL]);
    expect(byName.totals).toEqual(byId.totals);
  });

  it("resolves an owner EMAIL the same way, case-insensitively", async () => {
    const report = await getCanvassingActivityReport(
      tdb,
      filters({ ownerEmails: ["CSTONE@EXAMPLE.COM"], officeId: OFF })
    );
    expect(report.people.map((p) => p.userId)).toEqual([CAL]);
  });

  // Same reason the roster lookup is bounded: `users` is global, so resolving an arbitrary name must not
  // become a way to discover who exists in another office.
  it("will not resolve a name belonging to another office", async () => {
    const OTHER_OFFICE = U("0ff3");
    const OUTSIDER = U("0476");
    await pg.exec(`
      INSERT INTO public.offices (id, name, slug) VALUES ('${OTHER_OFFICE}', 'Atlanta 2', 'atlanta-2');
      INSERT INTO public.users (id, email, display_name, role, office_id, is_active)
      VALUES ('${OUTSIDER}', 'outsider2@example.com', 'Outside Person Two', 'rep', '${OTHER_OFFICE}', true);
    `);

    const report = await getCanvassingActivityReport(
      tdb,
      filters({ ownerNames: ["Outside Person Two"], officeId: OFF })
    );
    // Unresolvable, so the selection is simply not applied — and the outsider never appears.
    expect(report.people.some((p) => p.userId === OUTSIDER)).toBe(false);
    expect(JSON.stringify(report)).not.toContain("Outside Person Two");

    await pg.exec(`DELETE FROM public.users WHERE id = '${OUTSIDER}'; DELETE FROM public.offices WHERE id = '${OTHER_OFFICE}';`);
  });

  it("reads the attribution hint the same way after moving the tz conversion out of the aggregate", async () => {
    const report = await getCanvassingActivityReport(tdb, filters({ officeId: OFF }));
    expect(report.attributionStartHint).toBe("2026-06-01");
  });
});

describe("canvassing activity — a converted lead is the WIN, not a deletion", () => {
  // The worst defect this report had. Converting a lead sets is_active=false while keeping
  // status='converted', so an `is_active = true` rule removed a canvasser's converted leads from their own
  // count — the report docked people for the outcome it exists to encourage. Not a corner case either:
  // 155 of the 209 leads in office_dallas are converted+inactive, so most of the lead column was missing.
  const CONVERTED = U("c0117");
  const DELETED = U("de1e7");

  it("counts a converted lead, and still ignores a soft-deleted one", async () => {
    const before = await getCanvassingActivityReport(tdb, filters({ officeId: OFF }));
    expect(before.totals.lead).toBe(1);

    await pg.exec(`
      INSERT INTO public.leads (id, company_id, property_id, assigned_rep_id, office_code, office, name, stage_id, created_by_user_id, status, is_active, is_test_data, created_at) VALUES
        -- The success state: converted, and therefore inactive.
        ('${CONVERTED}', '${CO_HOST}', '${PR_A}', '${OWNER}', 'dallas', 'dfw', 'Converted lead', '${STAGE}', '${CAL}', 'converted', false, false, '2026-06-02T12:00:00Z'),
        -- A genuine soft delete: open, but removed. Must stay excluded.
        ('${DELETED}',   '${CO_HOST}', '${PR_A}', '${OWNER}', 'dallas', 'dfw', 'Deleted lead',   '${STAGE}', '${CAL}', 'open',      false, false, '2026-06-02T12:00:00Z');
    `);

    const after = await getCanvassingActivityReport(tdb, filters({ officeId: OFF }));
    expect(after.totals.lead).toBe(2);
    expect(after.people.find((p) => p.userId === CAL)?.counts.lead).toBe(1);

    await pg.exec(`DELETE FROM public.leads WHERE id IN ('${CONVERTED}','${DELETED}');`);
  });

  it("does not extend the exception to the other three tables", async () => {
    // Only leads repurpose is_active as a success state; a deactivated company is simply gone.
    const GONE = U("9017");
    await pg.exec(`
      INSERT INTO public.companies (id, name, slug, category, created_by_user_id, is_active, is_test_data, created_at)
      VALUES ('${GONE}', 'Retired Co', 'retired-co', 'client', '${CAL}', false, false, '2026-06-02T12:00:00Z');
    `);

    const report = await getCanvassingActivityReport(tdb, filters({ officeId: OFF }));
    expect(report.totals.company).toBe(3);

    await pg.exec(`DELETE FROM public.companies WHERE id = '${GONE}';`);
  });
});

describe("canvassing activity — partial periods are labelled as such", () => {
  // The default trailing-90-day view almost never starts on a Sunday or the 1st, so its first and last
  // buckets hold only the part inside the range. Charted beside whole periods without a marker, a clipped
  // week reads as a quiet week.
  it("flags the clipped first and last buckets and no others", async () => {
    // 2026-06-03 is a Wednesday and 2026-06-24 a Wednesday, so both ends clip their week.
    const report = await getCanvassingActivityReport(
      tdb,
      filters({ bucket: "week", dateFrom: "2026-06-03", dateTo: "2026-06-24", officeId: OFF })
    );

    expect(report.buckets[0]!.partial).toBe(true);
    expect(report.buckets[report.buckets.length - 1]!.partial).toBe(true);
    for (const middle of report.buckets.slice(1, -1)) {
      expect(middle.partial, middle.bucketStart).toBe(false);
    }
  });

  it("flags nothing when the range lands exactly on calendar boundaries", async () => {
    // Sunday through Saturday: every week is whole.
    const report = await getCanvassingActivityReport(
      tdb,
      filters({ bucket: "week", dateFrom: "2026-05-31", dateTo: "2026-06-27", officeId: OFF })
    );
    expect(report.buckets.every((b) => b.partial === false)).toBe(true);
  });

  it("treats a whole calendar month and quarter as complete", async () => {
    const month = await getCanvassingActivityReport(
      tdb,
      filters({ bucket: "month", dateFrom: "2026-06-01", dateTo: "2026-06-30", officeId: OFF })
    );
    expect(month.buckets.map((b) => b.partial)).toEqual([false]);

    const clipped = await getCanvassingActivityReport(
      tdb,
      filters({ bucket: "month", dateFrom: "2026-06-02", dateTo: "2026-06-30", officeId: OFF })
    );
    expect(clipped.buckets.map((b) => b.partial)).toEqual([true]);
  });
});

describe("canvassing activity — the default roster", () => {
  // Built only from people WITH activity, someone who canvassed nothing all week simply vanished — you
  // cannot notice an absence that is not drawn, and a visible zero is what this report is for. But
  // "every active office member" would list admins and construction staff at zero forever and bury the
  // handful it is about. generates_sales (migration 0219) already means "expected to produce sales
  // activity", so that is the line.
  it("lists the office's sales carriers even when they entered nothing", async () => {
    const report = await getCanvassingActivityReport(tdb, filters({ officeId: OFF }));

    // OWNER created nothing all window and is still on the report, at zero.
    const owner = report.people.find((p) => p.userId === OWNER);
    expect(owner).toBeDefined();
    expect(owner?.counts.total).toBe(0);
    expect(owner?.notesLogged).toBe(0);
  });

  it("leaves off someone who does not carry sales", async () => {
    const BACKOFFICE = U("bac1");
    await pg.exec(`
      INSERT INTO public.users (id, email, display_name, role, office_id, is_active, generates_sales)
      VALUES ('${BACKOFFICE}', 'ops@example.com', 'Back Office', 'admin', '${OFF}', true, false);
    `);

    const report = await getCanvassingActivityReport(tdb, filters({ officeId: OFF }));
    expect(report.people.find((p) => p.userId === BACKOFFICE)).toBeUndefined();

    await pg.exec(`DELETE FROM public.users WHERE id = '${BACKOFFICE}';`);
  });

  it("still credits a non-carrier who DID create something", async () => {
    // The flag decides who is listed by default, never who gets credit: real work always counts.
    const BACKOFFICE = U("bac2");
    const THEIR_CO = U("bac2c0");
    await pg.exec(`
      INSERT INTO public.users (id, email, display_name, role, office_id, is_active, generates_sales)
      VALUES ('${BACKOFFICE}', 'ops2@example.com', 'Back Office Two', 'admin', '${OFF}', true, false);
      INSERT INTO public.companies (id, name, slug, category, created_by_user_id, is_active, is_test_data, created_at)
      VALUES ('${THEIR_CO}', 'Ops Co', 'ops-co', 'client', '${BACKOFFICE}', true, false, '2026-06-02T12:00:00Z');
    `);

    const report = await getCanvassingActivityReport(tdb, filters({ officeId: OFF }));
    expect(report.people.find((p) => p.userId === BACKOFFICE)?.counts.company).toBe(1);

    await pg.exec(`DELETE FROM public.companies WHERE id = '${THEIR_CO}'; DELETE FROM public.users WHERE id = '${BACKOFFICE}';`);
  });

  it("a pinned selection overrides the default roster entirely", async () => {
    const report = await getCanvassingActivityReport(tdb, filters({ userIds: [CAL], officeId: OFF }));
    expect(report.people.map((p) => p.userId)).toEqual([CAL]);
  });
});

describe("canvassing activity — note CONTENT respects the rep boundary", () => {
  // Being on the allowlist buys the scoreboard, not a way around the platform's activity-content rule.
  // GET /activities pins an unscoped rep to their own rows and the Daily Activity Log does the same, so an
  // allowlisted viewer holding `rep` must not read the office's note text here either.
  it("shows a rep only their own notes, while leaving the COUNTS office-wide", async () => {
    const asRep = await getCanvassingActivityReport(
      tdb,
      filters({ officeId: OFF, viewerRole: "rep", viewerUserId: CAL })
    );

    expect(asRep.notes.every((note) => note.userId === CAL)).toBe(true);
    expect(asRep.notes.map((n) => n.subject)).toEqual(["Site walk"]);
    // "Caleb logged 12 notes" is the accountability figure and is a different disclosure from the text.
    expect(asRep.notesLogged).toBe(3);
  });

  it("shows a director every note", async () => {
    const asDirector = await getCanvassingActivityReport(
      tdb,
      filters({ officeId: OFF, viewerRole: "director", viewerUserId: CHR })
    );

    expect(asDirector.notes).toHaveLength(3);
    expect(asDirector.notes.map((n) => n.subject)).toContain("Door knock");
  });

  // Attribution stays on responsible_user_id so the figure reconciles with Rep Activity and the Daily
  // Activity Log — but a note logged on someone's behalf has to say so, or the feed reads as evidence the
  // attributed person did the work.
  it("names who actually logged a note when that differs from who it is attributed to", async () => {
    const ON_BEHALF = U("0b1f");
    await pg.exec(`
      INSERT INTO public.activities
        (id, type, source_entity_type, source_entity_id, responsible_user_id, performed_by_user_id, company_id, subject, body, occurred_at, created_at)
      VALUES ('${ON_BEHALF}', 'note', 'company', '${CO_A}', '${ED}', '${CHR}', '${CO_A}',
              'Logged for Edward', 'Chris wrote this up for him.', '2026-06-05T14:00:00Z', '2026-06-05T14:00:00Z');
    `);

    const report = await getCanvassingActivityReport(tdb, filters({ officeId: OFF, viewerRole: "director" }));
    const row = report.notes.find((note) => note.subject === "Logged for Edward");

    expect(row?.userName).toBe("Edward McCarty");
    expect(row?.performedByName).toBe("Chris H");
    // An ordinary note, written by the person it belongs to, carries no marker.
    expect(report.notes.find((note) => note.subject === "Door knock")?.performedByName).toBeNull();

    await pg.exec(`DELETE FROM public.activities WHERE id = '${ON_BEHALF}';`);
  });
});
