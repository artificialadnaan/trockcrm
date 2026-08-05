// Real-SQL proof for the Daily Activity Log report (PGlite, Drizzle-derived schema).
//
// This suite exists because the log's whole value rests on three claims that a mocked-SQL test cannot
// check: that days are bucketed on occurred_at (NOT created_at), that a rep cannot read another rep's
// entries, and that its per-day counts EQUAL Rep Activity's timeline. The last one is checked by
// running BOTH services against the SAME seeded database and comparing — the only way to know the two
// reports reconcile rather than merely looking like they should.
//
// The schema comes from tenantSchemaSql (#677) rather than hand-rolled DDL specifically because this
// report reads activities.type: hand-rolling that column as `text` is the #674 bug, and it would let a
// type filter pass here while failing against prod's 13-value activity_type enum.

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
import { USER_ROLES } from "@trock-crm/shared/types";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import {
  EMAIL_CONTENT_READER_ROLES,
  canReadOthersEmailContent,
  getDailyActivityLogReport,
  normalizeDailyActivityLogOptions,
} from "../../../src/modules/reports/daily-activity-log-service.js";
import { getRepActivityReport } from "../../../src/modules/reports/performance-tier2-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;

const OFF = U("0ff1");
const ALICE = U("a11ce");
const BOB = U("b0b");
const DANA = U("da4a");
const STAGE = U("57a1");
const DEAL1 = U("dea11");
const CO1 = U("c001");
const CT1 = U("c7a1");

// Every activity id is spelled out so the ordering assertions below read as a sequence, not a guess.
const A1 = U("ac01"); // Alice  note     06-01 15:00, logged same day        (deal)
const A2 = U("ac02"); // Alice  call     06-01 17:00, logged same day        (contact)
const A3 = U("ac03"); // Bob    note     06-01 18:00, logged same day        (company)
const A4 = U("ac04"); // Alice  note     06-02 14:00, logged 06-05  -> +3    BACK-DATED
const A5 = U("ac05"); // Bob    meeting  06-03 16:00, logged same day, performed by Dana (deal)
const A6 = U("ac06"); // Alice  note     06-04 10:00, logged 06-02  -> -2    FUTURE-DATED

// Email-privacy fixtures, deliberately in July so they cannot disturb the June assertions.
const E1 = U("e0a1"); // Alice  email    07-01 10:00  (Alice's mailbox)
const E2 = U("e0b2"); // Bob    email    07-01 11:00  (Bob's mailbox)
const E3 = U("e0c3"); // Alice  note     07-01 12:00  (control: never redacted)

const FILTERS = {
  dateFrom: "2026-06-01",
  dateTo: "2026-06-30",
  office: undefined as string | undefined,
  ownerIds: [] as string[],
  ownerNames: [] as string[],
};

// baseRole is the HOME role from users.role; `role` is the per-office EFFECTIVE role. For a normal
// director with no office override the two coincide, which is what this fixture represents.
const DIRECTOR = { role: "director" as const, baseRole: "director" as const, userId: DANA, displayName: "Dana Director" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  // Pin the session timezone. buildActivityScopeSql compares `occurred_at >= 'YYYY-MM-DD'::date` and
  // the day bucket is `occurred_at::date`, both of which resolve against the session TimeZone —
  // unpinned, PGlite inherits the host TZ and these assertions would pass locally and fail in a UTC
  // runner (or vice versa).
  await pg.exec("SET TimeZone='UTC';");
  await pg.exec(
    tenantSchemaSql("public", [offices, users, pipelineStageConfig, companies, contacts, properties, leads, deals, activities])
  );

  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES ('${OFF}', 'Dallas', 'dallas');
    INSERT INTO public.users (id, email, display_name, role, office_id, is_active) VALUES
      ('${ALICE}', 'alice@example.com', 'Alice Rep', 'rep', '${OFF}', true),
      ('${BOB}', 'bob@example.com', 'Bob Rep', 'rep', '${OFF}', true),
      ('${DANA}', 'dana@example.com', 'Dana Director', 'director', '${OFF}', true);
    INSERT INTO public.pipeline_stage_config (id, slug, name, display_order) VALUES
      ('${STAGE}', 'estimating', 'Estimating', 3);
    INSERT INTO public.companies (id, name, slug, category) VALUES ('${CO1}', 'Acme Property Group', 'acme-property-group', 'client');
    INSERT INTO public.contacts (id, first_name, last_name, category) VALUES ('${CT1}', 'Jane', 'Doe', 'property_manager');
    INSERT INTO public.deals (id, deal_number, name, stage_id, assigned_rep_id, company_id, is_active)
      VALUES ('${DEAL1}', 'D-1001', 'Roof Replacement - Tower A', '${STAGE}', '${ALICE}', '${CO1}', true);
  `);

  await pg.exec(`
    INSERT INTO public.activities
      (id, type, source_entity_type, source_entity_id, responsible_user_id, performed_by_user_id,
       deal_id, contact_id, company_id, subject, body, occurred_at, created_at) VALUES
      ('${A1}', 'note', 'deal', '${DEAL1}', '${ALICE}', NULL, '${DEAL1}', NULL, NULL,
        'Walked the roof with Jane', 'Ponding on the north bay. Sending a scope Monday.',
        '2026-06-01T15:00:00Z', '2026-06-01T15:05:00Z'),
      ('${A2}', 'call', 'contact', '${CT1}', '${ALICE}', NULL, NULL, '${CT1}', NULL,
        'Follow-up call', 'Confirmed the walk time.', '2026-06-01T17:00:00Z', '2026-06-01T17:01:00Z'),
      ('${A3}', 'note', 'company', '${CO1}', '${BOB}', NULL, NULL, NULL, '${CO1}',
        'New facilities contact', 'Ops manager changed over.', '2026-06-01T18:00:00Z', '2026-06-01T18:00:00Z'),
      ('${A4}', 'note', 'deal', '${DEAL1}', '${ALICE}', NULL, '${DEAL1}', NULL, NULL,
        'Site visit writeup', 'Wrote this up on Friday.', '2026-06-02T14:00:00Z', '2026-06-05T09:00:00Z'),
      ('${A5}', 'meeting', 'deal', '${DEAL1}', '${BOB}', '${DANA}', '${DEAL1}', NULL, NULL,
        'Scope review', 'Dana logged this on Bob''s behalf.', '2026-06-03T16:00:00Z', '2026-06-03T16:00:00Z'),
      ('${A6}', 'note', 'deal', '${DEAL1}', '${ALICE}', NULL, '${DEAL1}', NULL, NULL,
        'Pre-dated plan note', 'Entered ahead of the visit.', '2026-06-04T10:00:00Z', '2026-06-02T10:00:00Z');
  `);

  // Email-privacy fixtures live in their OWN month so the June assertions above stay untouched.
  // E1/E2 are two different reps' mailbox rows; E3 is a NOTE by Alice, present to prove the redaction
  // is scoped to email and does not blank ordinary entries for other viewers.
  await pg.exec(`
    INSERT INTO public.activities
      (id, type, source_entity_type, source_entity_id, responsible_user_id, deal_id,
       subject, body, outcome, next_step, occurred_at, created_at) VALUES
      ('${E1}', 'email', 'deal', '${DEAL1}', '${ALICE}', '${DEAL1}',
        'Re: Roof proposal', 'Alice mailbox body.', 'replied', 'Send revised pricing',
        '2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z'),
      ('${E2}', 'email', 'deal', '${DEAL1}', '${BOB}', '${DEAL1}',
        'Re: Scope questions', 'Bob mailbox body.', 'replied', 'Book the walk',
        '2026-07-01T11:00:00Z', '2026-07-01T11:00:00Z'),
      ('${E3}', 'note', 'deal', '${DEAL1}', '${ALICE}', '${DEAL1}',
        'Ordinary note', 'Not an email, so never redacted.', NULL, NULL,
        '2026-07-01T12:00:00Z', '2026-07-01T12:00:00Z');
  `);

  tdb = drizzle(pg);
}, 60_000);

afterAll(async () => {
  await pg?.close?.();
});

function opts(overrides: Partial<ReturnType<typeof normalizeDailyActivityLogOptions>> = {}) {
  return { ...normalizeDailyActivityLogOptions({}), ...overrides };
}

describe("daily activity log — day grouping and date basis", () => {
  it("groups entries into days newest-first and reports the full-window totals", async () => {
    const report = await getDailyActivityLogReport(tdb, FILTERS, opts(), DIRECTOR);

    expect(report.days.map((d) => d.date)).toEqual(["2026-06-04", "2026-06-03", "2026-06-02", "2026-06-01"]);
    expect(report.days.map((d) => d.entryCount)).toEqual([1, 1, 1, 3]);
    expect(report.kpis.totalEntries).toBe(6);
    expect(report.kpis.daysCovered).toBe(4);
    expect(report.kpis.repsLogging).toBe(2);
    // 4 of the 6 seeded activities are type 'note'.
    expect(report.kpis.notes).toBe(4);
  });

  it("buckets a back-dated entry on the day the work OCCURRED, not the day it was logged", async () => {
    const report = await getDailyActivityLogReport(tdb, FILTERS, opts(), DIRECTOR);

    // A4 occurred 06-02 and was logged 06-05. If the grouping ever moves to created_at this flips to
    // a 2026-06-05 bucket — which is exactly the regression this assertion exists to catch.
    const june2 = report.days.find((d) => d.date === "2026-06-02");
    expect(june2?.entries.map((e) => e.id)).toEqual([A4]);
    expect(report.days.some((d) => d.date === "2026-06-05")).toBe(false);

    const entry = june2!.entries[0];
    expect(entry.occurredDate).toBe("2026-06-02");
    expect(entry.loggedDate).toBe("2026-06-05");
    expect(entry.loggedSameDay).toBe(false);
    expect(entry.loggedDaysDiff).toBe(3);
    expect(june2?.offDayLoggedCount).toBe(1);
  });

  it("marks a future-dated entry with a negative offset and leaves same-day entries clean", async () => {
    const report = await getDailyActivityLogReport(tdb, FILTERS, opts(), DIRECTOR);

    const future = report.days.find((d) => d.date === "2026-06-04")!.entries[0];
    expect(future.id).toBe(A6);
    expect(future.loggedDate).toBe("2026-06-02");
    expect(future.loggedSameDay).toBe(false);
    expect(future.loggedDaysDiff).toBe(-2);

    const sameDay = report.days.find((d) => d.date === "2026-06-01")!.entries;
    expect(sameDay.every((e) => e.loggedSameDay)).toBe(true);
    expect(sameDay.every((e) => e.loggedDaysDiff === 0)).toBe(true);
    expect(report.days.find((d) => d.date === "2026-06-01")?.offDayLoggedCount).toBe(0);
    // Two of the six entries were logged on a different day than they occurred (A4 and A6).
    expect(report.kpis.offDayLogged).toBe(2);
  });
});

describe("daily activity log — content, targets and attribution", () => {
  it("returns the readable body and resolves the target entity per type", async () => {
    const report = await getDailyActivityLogReport(tdb, FILTERS, opts(), DIRECTOR);
    const byId = new Map(report.days.flatMap((d) => d.entries).map((e) => [e.id, e]));

    const dealNote = byId.get(A1)!;
    expect(dealNote.subject).toBe("Walked the roof with Jane");
    expect(dealNote.body).toContain("Ponding on the north bay");
    expect(dealNote.typeLabel).toBe("Note");
    expect(dealNote.targetType).toBe("deal");
    expect(dealNote.targetName).toBe("Roof Replacement - Tower A");
    expect(dealNote.dealId).toBe(DEAL1);
    expect(dealNote.dealNumber).toBe("D-1001");

    // A contact-attached entry names the person; a company-attached one names the company. Neither
    // carries a dealId, so the UI must not render a deal link for them.
    expect(byId.get(A2)!.targetType).toBe("contact");
    expect(byId.get(A2)!.targetName).toBe("Jane Doe");
    expect(byId.get(A2)!.dealId).toBeNull();
    expect(byId.get(A3)!.targetType).toBe("company");
    expect(byId.get(A3)!.targetName).toBe("Acme Property Group");
  });

  it("names the performer only when it differs from the responsible rep", async () => {
    const report = await getDailyActivityLogReport(tdb, FILTERS, opts(), DIRECTOR);
    const byId = new Map(report.days.flatMap((d) => d.entries).map((e) => [e.id, e]));

    // A5 is Bob's activity that Dana actually logged — a manager needs to see Bob did not type it.
    expect(byId.get(A5)!.responsibleName).toBe("Bob Rep");
    expect(byId.get(A5)!.performedByName).toBe("Dana Director");
    // A1 has no performed_by at all; A3 has none either. Neither should invent one.
    expect(byId.get(A1)!.performedByName).toBeNull();
    expect(byId.get(A3)!.performedByName).toBeNull();
  });
});

describe("daily activity log — type filtering", () => {
  it("returns only notes when the note type is selected alone", async () => {
    const report = await getDailyActivityLogReport(tdb, FILTERS, opts({ types: ["note"] }), DIRECTOR);
    const all = report.days.flatMap((d) => d.entries);

    // The NARROWED count is pagination.total. kpis stays on the window scope -- see the two-scope
    // cases below for why, and for the proof that it does not move.
    expect(report.pagination.total).toBe(4);
    expect(all.map((e) => e.id).sort()).toEqual([A1, A3, A4, A6].sort());
    expect(all.every((e) => e.type === "note")).toBe(true);
    // The 06-01 day header must drop to the note-only count too, not keep the unfiltered 3.
    expect(report.days.find((d) => d.date === "2026-06-01")?.entryCount).toBe(2);
    expect(report.appliedTypes).toEqual(["note"]);
  });

  it("supports a multi-type selection and drops unknown types instead of erroring", async () => {
    const report = await getDailyActivityLogReport(tdb, FILTERS, opts({ types: ["call", "meeting"] }), DIRECTOR);
    expect(report.pagination.total).toBe(2);
    expect(report.days.flatMap((d) => d.entries).map((e) => e.type).sort()).toEqual(["call", "meeting"]);

    // A stale bookmark carrying a type that no longer exists must widen, not 400.
    const normalized = normalizeDailyActivityLogOptions({ types: "note,not_a_real_type" });
    expect(normalized.types).toEqual(["note"]);
  });
});

// ---------------------------------------------------------------------------------------------
// The KPI cards are the narrowing controls, so the numbers on them must survive being clicked.
//
// The failure this guards against is specific and easy to reintroduce: compute `kpis` over the same
// predicate as the rows, and clicking "Notes" rewrites the Entries card from 6 to 4 -- the user loses
// the denominator they were comparing against and a filtered view becomes indistinguishable from a
// quiet week. Every case here asserts the WHOLE kpis object is byte-for-byte the unfiltered one.
// ---------------------------------------------------------------------------------------------
describe("daily activity log — window-scoped KPIs vs narrowed rows", () => {
  it("keeps every KPI identical under a type narrowing while the row count follows it", async () => {
    const unfiltered = await getDailyActivityLogReport(tdb, FILTERS, opts(), DIRECTOR);
    const notesOnly = await getDailyActivityLogReport(tdb, FILTERS, opts({ types: ["note"] }), DIRECTOR);

    expect(notesOnly.kpis).toEqual(unfiltered.kpis);
    // ...and the card that was clicked still states the number the drill returned.
    expect(notesOnly.pagination.total).toBe(unfiltered.kpis.notes);
    expect(notesOnly.pagination.total).not.toBe(unfiltered.pagination.total);
  });

  it("keeps every KPI identical under the logged-off-day drill and returns exactly those rows", async () => {
    const unfiltered = await getDailyActivityLogReport(tdb, FILTERS, opts(), DIRECTOR);
    const offDay = await getDailyActivityLogReport(tdb, FILTERS, opts({ loggedOffDay: true }), DIRECTOR);

    expect(offDay.kpis).toEqual(unfiltered.kpis);
    // The drill returns exactly as many rows as the card it was clicked from claims. This is the
    // property that breaks the moment "off-day" is re-derived somewhere instead of shared.
    expect(offDay.pagination.total).toBe(unfiltered.kpis.offDayLogged);
    expect(offDay.pagination.total).toBe(2);

    const rows = offDay.days.flatMap((d) => d.entries);
    expect(rows.map((e) => e.id).sort()).toEqual([A4, A6].sort());
    expect(rows.every((e) => e.loggedSameDay === false)).toBe(true);
    expect(offDay.appliedLoggedOffDay).toBe(true);
    // Both directions of "off-day" count: A4 was written up late, A6 was dated ahead.
    expect(rows.map((e) => e.loggedDaysDiff).sort((a, b) => a - b)).toEqual([-2, 3]);
  });

  it("composes the two narrowings without touching the KPIs", async () => {
    const unfiltered = await getDailyActivityLogReport(tdb, FILTERS, opts(), DIRECTOR);
    const both = await getDailyActivityLogReport(
      tdb,
      FILTERS,
      opts({ types: ["note"], loggedOffDay: true }),
      DIRECTOR
    );

    expect(both.kpis).toEqual(unfiltered.kpis);
    // A4 and A6 are both notes, so notes+off-day is the same two rows here; the point is that the
    // clauses AND together rather than one silently replacing the other.
    expect(both.days.flatMap((d) => d.entries).map((e) => e.id).sort()).toEqual([A4, A6].sort());

    const callsOffDay = await getDailyActivityLogReport(
      tdb,
      FILTERS,
      opts({ types: ["call"], loggedOffDay: true }),
      DIRECTOR
    );
    // The only call (A2) was logged the same day, so the intersection is genuinely empty -- proof the
    // second clause is applied and not dropped.
    expect(callsOffDay.pagination.total).toBe(0);
    expect(callsOffDay.days).toEqual([]);
    expect(callsOffDay.kpis).toEqual(unfiltered.kpis);
  });

  it("pages against the NARROWED total, not the window total", async () => {
    // 2 off-day rows in a window of 6. Clamping against the window total would let ?page=2 through
    // and serve an empty page under a footer reading "page 2 of 3".
    const offDay = await getDailyActivityLogReport(tdb, FILTERS, opts({ loggedOffDay: true, page: 2, limit: 2 }), DIRECTOR);

    expect(offDay.pagination).toMatchObject({ page: 1, total: 2, returned: 2, totalPages: 1, hasMore: false });
  });

  it("treats loggedOffDay as opt-in and echoes what it applied", () => {
    for (const raw of ["1", "true", "TRUE", " yes ", "on", true]) {
      expect(normalizeDailyActivityLogOptions({ loggedOffDay: raw }).loggedOffDay).toBe(true);
    }
    // Anything unrecognised must WIDEN (show everything), never silently hide rows. A NUMBER is in
    // this list on purpose: Express query values are only ever string | string[], so a numeric 1
    // cannot arrive from a URL and is deliberately not given a special case.
    for (const raw of ["0", "false", "", "maybe", undefined, null, 1]) {
      expect(normalizeDailyActivityLogOptions({ loggedOffDay: raw }).loggedOffDay).toBe(false);
    }
    expect(normalizeDailyActivityLogOptions({}).loggedOffDay).toBe(false);
    // A repeated query param arrives as an array; Express's own last-wins rule applies.
    expect(normalizeDailyActivityLogOptions({ loggedOffDay: ["0", "1"] }).loggedOffDay).toBe(true);
    expect(normalizeDailyActivityLogOptions({ loggedOffDay: ["1", "0"] }).loggedOffDay).toBe(false);
  });
});

describe("daily activity log — rep scoping", () => {
  it("collapses a rep to their own entries even when the request asks for another rep", async () => {
    // Bob asks for Alice's log. resolveRepActivityScope must overwrite ownerIds with Bob's own id.
    const report = await getDailyActivityLogReport(
      tdb,
      { ...FILTERS, ownerIds: [ALICE] },
      opts(),
      { role: "rep", userId: BOB, displayName: "Bob Rep" }
    );

    const all = report.days.flatMap((d) => d.entries);
    expect(all.map((e) => e.id).sort()).toEqual([A3, A5].sort());
    expect(all.every((e) => e.responsibleName === "Bob Rep")).toBe(true);
    expect(report.kpis.totalEntries).toBe(2);
    // Alice's entries must not leak in through the day counters either.
    expect(report.days.find((d) => d.date === "2026-06-01")?.entryCount).toBe(1);
    expect(report.days.some((d) => d.date === "2026-06-04")).toBe(false);
  });

  it("ignores ownerNames without ownerIds — the SAME way Rep Activity does", async () => {
    // Owner scoping is by id only, in both reports. Display names are not unique, so scoping
    // activities by name would leak one rep's entries to a namesake (there is a tier-2 test pinning
    // exactly that). The client resolves names to ids before calling, so this only arises from a
    // hand-written or legacy URL -- and when it does, BOTH reports must fall back the same way, or
    // they would disagree on that URL. This test fails if either side grows a display-name arm alone.
    const namesOnly = { ...FILTERS, ownerIds: [] as string[], ownerNames: ["Alice Rep"] };

    const log = await getDailyActivityLogReport(tdb, namesOnly, opts(), DIRECTOR);
    const repActivity = await getRepActivityReport(tdb, namesOnly, DIRECTOR, "daily-log-names-only");

    // Office-wide, not Alice-only: all 6 June entries from both reps.
    expect(log.kpis.totalEntries).toBe(6);
    expect(log.kpis.repsLogging).toBe(2);
    expect(log.kpis.totalEntries).toBe(repActivity.kpis.totalTouchpoints);
    const logByDay = Object.fromEntries(log.days.map((d) => [d.date, d.entryCount]));
    const repByDay = Object.fromEntries(repActivity.timeline.map((t) => [t.date, t.touchpoints]));
    expect(logByDay).toEqual(repByDay);
  });

  it("lets a director target one rep through the owner filter", async () => {
    const report = await getDailyActivityLogReport(tdb, { ...FILTERS, ownerIds: [ALICE] }, opts(), DIRECTOR);

    const all = report.days.flatMap((d) => d.entries);
    expect(all.map((e) => e.id).sort()).toEqual([A1, A2, A4, A6].sort());
    expect(report.kpis.repsLogging).toBe(1);
  });
});

describe("daily activity log — pagination", () => {
  it("pages the entries while keeping each day header on FULL-window counts", async () => {
    const page1 = await getDailyActivityLogReport(tdb, FILTERS, opts({ page: 1, limit: 2 }), DIRECTOR);
    expect(page1.days.flatMap((d) => d.entries).map((e) => e.id)).toEqual([A6, A5]);
    expect(page1.pagination).toMatchObject({ page: 1, limit: 2, total: 6, returned: 2, totalPages: 3, hasMore: true });

    const page2 = await getDailyActivityLogReport(tdb, FILTERS, opts({ page: 2, limit: 2 }), DIRECTOR);
    expect(page2.days.flatMap((d) => d.entries).map((e) => e.id)).toEqual([A4, A3]);
    // A3 is one of THREE entries on 06-01. The day header must still say 3 even though this page
    // carries one of them — otherwise paging would quietly restate the day totals and the reconcile
    // to Rep Activity's timeline would only hold on page 1.
    const june1 = page2.days.find((d) => d.date === "2026-06-01");
    expect(june1?.entries).toHaveLength(1);
    expect(june1?.entryCount).toBe(3);

    const page3 = await getDailyActivityLogReport(tdb, FILTERS, opts({ page: 3, limit: 2 }), DIRECTOR);
    expect(page3.days.flatMap((d) => d.entries).map((e) => e.id)).toEqual([A2, A1]);
    expect(page3.pagination.hasMore).toBe(false);

    // Every entry appears exactly once across the pages — the (occurred_at DESC, id DESC) ordering is
    // total, so nothing is duplicated or skipped at a page boundary.
    const seen = [page1, page2, page3].flatMap((r) => r.days.flatMap((d) => d.entries).map((e) => e.id));
    expect(new Set(seen).size).toBe(6);
  });

  it("clamps an out-of-range page to the last real page instead of rendering as empty", async () => {
    // A bookmarked ?page=9 (or a page that fell off the end after deletions) must not come back with
    // total>0 and zero rows -- that renders as "nothing was logged" under a footer reading
    // "0-0 of 6 - page 9 of 3". The response reports the page it actually served.
    const past = await getDailyActivityLogReport(tdb, FILTERS, opts({ page: 9, limit: 2 }), DIRECTOR);

    expect(past.pagination).toMatchObject({ page: 3, limit: 2, total: 6, returned: 2, totalPages: 3, hasMore: false });
    expect(past.days.flatMap((d) => d.entries).map((e) => e.id)).toEqual([A2, A1]);
  });

  it("still reports page 1 when the window genuinely has no entries", async () => {
    const empty = await getDailyActivityLogReport(
      tdb,
      { ...FILTERS, dateFrom: "2026-01-01", dateTo: "2026-01-31" },
      opts({ page: 4, limit: 2 }),
      DIRECTOR
    );
    expect(empty.days).toEqual([]);
    expect(empty.pagination).toMatchObject({ page: 1, total: 0, returned: 0, totalPages: 0, hasMore: false });
  });

  it("clamps an oversized limit instead of pulling the table through the API", () => {
    expect(normalizeDailyActivityLogOptions({ limit: "100000" }).limit).toBe(500);
    expect(normalizeDailyActivityLogOptions({ limit: "0" }).limit).toBe(200);
    expect(normalizeDailyActivityLogOptions({ page: "-3" }).page).toBe(1);
  });
});

describe("daily activity log — email content visibility", () => {
  // Email activities carry synced mailbox content. Who may READ that content is decided per viewer
  // role, by EMAIL_CONTENT_READER_ROLES, and this report DELIBERATELY DIVERGES from the activities
  // list endpoint (which still restricts email content to the mailbox owner for every viewer). The
  // divergence is owner-approved: this report exists so a manager can read down a salesperson's day.
  //
  // These cases pin BOTH halves. Delete the allowlist check and "admin sees content" still passes
  // while "a non-allowlisted viewer does not" fails, which is the direction that matters.
  const JULY = { ...FILTERS, dateFrom: "2026-07-01", dateTo: "2026-07-31" };

  const ADMIN = { role: "admin" as const, baseRole: "admin" as const, userId: DANA, displayName: "Dana Director" };
  // A viewer whose role is NOT on the allowlist AND is not collapsed to their own rows by
  // resolveRepActivityScope. requireAnyRole keeps this role off the route today; the point of testing
  // it is that the CONTENT decision must not depend on the ROW decision -- widen either guard and the
  // other still holds. This is the case that would fail if the predicate were simply deleted.
  const OUTSIDER = { role: "construction" as const, baseRole: "construction" as const, userId: DANA, displayName: "Dana Director" };

  it("shows a rep their OWN email content in full", async () => {
    const alice = { role: "rep" as const, userId: ALICE, displayName: "Alice Rep" };
    const report = await getDailyActivityLogReport(tdb, JULY, opts(), alice);
    const byId = new Map(report.days.flatMap((d) => d.entries).map((e) => [e.id, e]));

    const own = byId.get(E1)!;
    expect(own.contentRestricted).toBe(false);
    expect(own.subject).toBe("Re: Roof proposal");
    expect(own.body).toBe("Alice mailbox body.");
    expect(own.outcome).toBe("replied");
    expect(own.nextStep).toBe("Send revised pricing");
  });

  it("pins exactly which roles may read someone else's email content", () => {
    expect([...EMAIL_CONTENT_READER_ROLES].sort()).toEqual(["admin", "director"]);
    for (const role of ["rep", "construction", "field_contractor"] as const) {
      expect(EMAIL_CONTENT_READER_ROLES.has(role)).toBe(false);
    }
  });

  // The effective/home role split, decided in one pure function so it can be enumerated exhaustively
  // rather than sampled. `role` is what authMiddleware rewrites from user_office_access.role_override;
  // `baseRole` is users.role. Gating on the effective role alone is the #740 escalation.
  it("requires BOTH the effective office role and the home role to be allowlisted", () => {
    for (const role of USER_ROLES) {
      for (const baseRole of USER_ROLES) {
        const allowed = canReadOthersEmailContent({ role, baseRole });
        const bothAllowlisted =
          EMAIL_CONTENT_READER_ROLES.has(role) && EMAIL_CONTENT_READER_ROLES.has(baseRole);
        expect({ role, baseRole, allowed }).toEqual({ role, baseRole, allowed: bothAllowlisted });
      }
    }

    // The escalation itself, named: a rep handed a director override on an office.
    expect(canReadOthersEmailContent({ role: "director", baseRole: "rep" })).toBe(false);
    expect(canReadOthersEmailContent({ role: "admin", baseRole: "construction" })).toBe(false);
    // And the other direction: a real admin scoped DOWN to rep for an office gets no elevation there.
    expect(canReadOthersEmailContent({ role: "rep", baseRole: "admin" })).toBe(false);
    // Absent baseRole fails CLOSED, the same way requireGlobalAdmin does.
    expect(canReadOthersEmailContent({ role: "admin" })).toBe(false);
    expect(canReadOthersEmailContent({ role: "admin", baseRole: null })).toBe(false);
  });

  it("withholds content from a rep who holds a DIRECTOR override on this office", async () => {
    // authMiddleware would hand the service role=director (from user_office_access.role_override) with
    // baseRole=rep. The effective role is what stops resolveRepActivityScope collapsing them to their
    // own rows -- so they DO receive Alice's and Bob's rows. The home role is what must stop them
    // reading the mail in those rows. If this endpoint gated on `role` alone, this test returns
    // "Alice mailbox body." to a rep.
    const escalated = { role: "director" as const, baseRole: "rep" as const, userId: DANA, displayName: "Dana Director" };
    const report = await getDailyActivityLogReport(tdb, JULY, opts(), escalated);
    const byId = new Map(report.days.flatMap((d) => d.entries).map((e) => [e.id, e]));

    // They are NOT scope-collapsed -- every row is here, which is precisely what makes this dangerous.
    expect(report.kpis.totalEntries).toBe(3);
    expect(byId.has(E1)).toBe(true);
    expect(byId.has(E2)).toBe(true);

    for (const id of [E1, E2]) {
      expect(byId.get(id)!.contentRestricted).toBe(true);
      expect(byId.get(id)!.subject).toBeNull();
      expect(byId.get(id)!.body).toBeNull();
    }
    expect(JSON.stringify(report)).not.toContain("Alice mailbox body.");
    expect(JSON.stringify(report)).not.toContain("Bob mailbox body.");
  });

  it("withholds content from a caller that omits baseRole entirely", async () => {
    // Fail-closed. /api/reports always runs behind authMiddleware, which sets baseRole -- but a future
    // caller that forgets it must get redaction, not the admin view.
    const noBaseRole = { role: "admin" as const, userId: DANA, displayName: "Dana Director" };
    const report = await getDailyActivityLogReport(tdb, JULY, opts(), noBaseRole);
    const byId = new Map(report.days.flatMap((d) => d.entries).map((e) => [e.id, e]));

    expect(byId.get(E1)!.contentRestricted).toBe(true);
    expect(byId.get(E1)!.body).toBeNull();
  });

  for (const viewer of [ADMIN, DIRECTOR]) {
    it(`shows a ${viewer.role} the full content of email they do not own`, async () => {
      const report = await getDailyActivityLogReport(tdb, JULY, opts(), viewer);
      const byId = new Map(report.days.flatMap((d) => d.entries).map((e) => [e.id, e]));

      expect(report.kpis.totalEntries).toBe(3);

      // Neither mailbox belongs to the viewer (E1 is Alice's, E2 is Bob's) and both are readable.
      const alicesEmail = byId.get(E1)!;
      expect(alicesEmail.responsibleName).toBe("Alice Rep");
      expect(alicesEmail.contentRestricted).toBe(false);
      expect(alicesEmail.subject).toBe("Re: Roof proposal");
      expect(alicesEmail.body).toBe("Alice mailbox body.");
      expect(alicesEmail.outcome).toBe("replied");
      expect(alicesEmail.nextStep).toBe("Send revised pricing");

      const bobsEmail = byId.get(E2)!;
      expect(bobsEmail.responsibleName).toBe("Bob Rep");
      expect(bobsEmail.contentRestricted).toBe(false);
      expect(bobsEmail.subject).toBe("Re: Scope questions");
      expect(bobsEmail.body).toBe("Bob mailbox body.");

      // Ordinary entries are unaffected either way.
      const note = byId.get(E3)!;
      expect(note.contentRestricted).toBe(false);
      expect(note.subject).toBe("Ordinary note");
    });
  }

  it("still withholds content from a viewer outside the allowlist while KEEPING the row", async () => {
    const report = await getDailyActivityLogReport(tdb, JULY, opts(), OUTSIDER);
    const byId = new Map(report.days.flatMap((d) => d.entries).map((e) => [e.id, e]));

    // The rows are all present and countable...
    expect(report.kpis.totalEntries).toBe(3);
    expect(byId.has(E1)).toBe(true);
    expect(byId.has(E2)).toBe(true);

    // ...but neither email carries content, because redaction REDACTS rather than excludes.
    for (const id of [E1, E2]) {
      const entry = byId.get(id)!;
      expect(entry.contentRestricted).toBe(true);
      expect(entry.subject).toBeNull();
      expect(entry.body).toBeNull();
      expect(entry.outcome).toBeNull();
      expect(entry.nextStep).toBeNull();
      expect(entry.nextStepDueAt).toBeNull();
      // The countable, non-content fields survive so the entry still explains the day's volume.
      expect(entry.type).toBe("email");
      expect(entry.responsibleName).not.toBe("");
      expect(entry.occurredDate).toBe("2026-07-01");
    }

    // A NOTE is untouched -- the redaction is scoped to email, not to "not mine".
    const note = byId.get(E3)!;
    expect(note.contentRestricted).toBe(false);
    expect(note.body).toBe("Not an email, so never redacted.");
  });

  it("does not leak one rep's email to another rep under ANY filter", async () => {
    const bob = { role: "rep" as const, userId: BOB, displayName: "Bob Rep" };

    // Every shape of request Bob could construct by hand, including asking for Alice by id and
    // selecting the email type explicitly. Rep scoping must collapse all of them to Bob's own rows,
    // and no response may carry a byte of Alice's mailbox.
    const attempts = [
      { filters: JULY, options: opts() },
      { filters: JULY, options: opts({ types: ["email"] }) },
      { filters: JULY, options: opts({ loggedOffDay: true }) },
      { filters: { ...JULY, ownerIds: [ALICE] }, options: opts() },
      { filters: { ...JULY, ownerIds: [ALICE] }, options: opts({ types: ["email"] }) },
      { filters: { ...JULY, ownerIds: [ALICE, BOB] }, options: opts({ types: ["email"] }) },
      { filters: { ...JULY, ownerNames: ["Alice Rep"] }, options: opts({ types: ["email"] }) },
      { filters: { ...JULY, dateFrom: "2026-01-01", dateTo: "2026-12-31" }, options: opts({ types: ["email"] }) },
    ];

    for (const attempt of attempts) {
      const report = await getDailyActivityLogReport(tdb, attempt.filters, attempt.options, bob);
      const all = report.days.flatMap((d) => d.entries);

      expect(all.every((e) => e.responsibleUserId === BOB)).toBe(true);
      expect(all.some((e) => e.id === E1)).toBe(false);
      // Belt and braces: the mailbox text itself must not appear in ANY field of ANY row.
      expect(JSON.stringify(report)).not.toContain("Alice mailbox body.");
      expect(JSON.stringify(report)).not.toContain("Re: Roof proposal");
    }

    // ...and Bob's OWN email is still fully readable to him.
    const own = await getDailyActivityLogReport(tdb, JULY, opts({ types: ["email"] }), bob);
    const rows = own.days.flatMap((d) => d.entries);
    expect(rows.map((e) => e.id)).toEqual([E2]);
    expect(rows[0].contentRestricted).toBe(false);
    expect(rows[0].body).toBe("Bob mailbox body.");
  });

  it("keeps the Rep Activity reconcile intact for every viewer", async () => {
    // Redaction was chosen over exclusion because Rep Activity counts email activities for every
    // viewer; relaxing WHO can read the content does not change WHICH rows are returned, so this
    // still has to hold -- for the allowlisted viewer and the restricted one alike.
    for (const viewer of [ADMIN, DIRECTOR, OUTSIDER]) {
      const log = await getDailyActivityLogReport(tdb, JULY, opts(), viewer);
      const repActivity = await getRepActivityReport(tdb, JULY, viewer, `daily-log-email-reconcile-${viewer.role}`);

      expect(log.kpis.totalEntries).toBe(repActivity.kpis.totalTouchpoints);
      const logByDay = Object.fromEntries(log.days.map((d) => [d.date, d.entryCount]));
      const repByDay = Object.fromEntries(repActivity.timeline.map((t) => [t.date, t.touchpoints]));
      expect(logByDay).toEqual(repByDay);
      // Two of the three July rows are emails, and Rep Activity counts them in its own breakdown.
      expect(repActivity.kpis.emails).toBe(2);
    }
  });
});

describe("daily activity log — reconciliation with Rep Activity", () => {
  it("matches getRepActivityReport's per-day timeline and touchpoint total exactly", async () => {
    // The claim this whole report rests on: with no type filter, the log covers the SAME activities
    // Rep Activity counts. Both services run here against one database, so a divergence in date
    // basis, window bound, or scope predicate fails this test rather than shipping as a second number.
    const log = await getDailyActivityLogReport(tdb, FILTERS, opts(), DIRECTOR);
    const repActivity = await getRepActivityReport(tdb, FILTERS, DIRECTOR, "daily-log-reconcile");

    const logByDay = Object.fromEntries(log.days.map((d) => [d.date, d.entryCount]));
    const repByDay = Object.fromEntries(repActivity.timeline.map((t) => [t.date, t.touchpoints]));
    expect(logByDay).toEqual(repByDay);
    expect(log.kpis.totalEntries).toBe(repActivity.kpis.totalTouchpoints);
  });

  it("reconciles under an owner filter too", async () => {
    const scoped = { ...FILTERS, ownerIds: [ALICE] };
    const log = await getDailyActivityLogReport(tdb, scoped, opts(), DIRECTOR);
    const repActivity = await getRepActivityReport(tdb, scoped, DIRECTOR, "daily-log-reconcile-owner");

    const logByDay = Object.fromEntries(log.days.map((d) => [d.date, d.entryCount]));
    const repByDay = Object.fromEntries(repActivity.timeline.map((t) => [t.date, t.touchpoints]));
    expect(logByDay).toEqual(repByDay);
    expect(log.kpis.totalEntries).toBe(repActivity.kpis.totalTouchpoints);
  });

  it("reconciles for a rep reading their own log", async () => {
    const bob = { role: "rep" as const, userId: BOB, displayName: "Bob Rep" };
    const log = await getDailyActivityLogReport(tdb, FILTERS, opts(), bob);
    const repActivity = await getRepActivityReport(tdb, FILTERS, bob, "daily-log-reconcile-rep");

    const logByDay = Object.fromEntries(log.days.map((d) => [d.date, d.entryCount]));
    const repByDay = Object.fromEntries(repActivity.timeline.map((t) => [t.date, t.touchpoints]));
    expect(logByDay).toEqual(repByDay);
    expect(log.kpis.totalEntries).toBe(repActivity.kpis.totalTouchpoints);
  });
});
