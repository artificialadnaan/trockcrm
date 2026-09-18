// The day bucket must be UTC regardless of the DATABASE SESSION timezone.
//
// This suite deliberately runs its PGlite session on America/Chicago — the opposite of every other
// runtime suite, which pins UTC. That pinning is the point: a bare `a.occurred_at::date` follows the
// session zone, so under UTC the bug is invisible and the assertions below would pass either way.
//
// The client renders row clocks in UTC and labels them "times UTC". That label is a claim about the
// DATA, and before the bucket was pinned the QUERY did not guarantee it: on a Chicago session an
// activity at 2026-06-10T04:30Z filed under the Jun 9 bucket while the page rendered it as 4:30 AM
// "UTC" — a Jun 10 time under a Jun 9 heading. Exactly the row/header contradiction the UTC rendering
// was introduced to remove, reintroduced by an unstated assumption about server configuration.

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
  getDailyActivityLogReport,
  normalizeDailyActivityLogOptions,
} from "../../../src/modules/reports/daily-activity-log-service.js";
import { getRepActivityReport } from "../../../src/modules/reports/performance-tier2-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const OFF = U("0ff1");
const ALICE = U("a11ce");
const STAGE = U("57a1");
const DEAL1 = U("dea11");
const CO1 = U("c001");

// 04:30Z on Jun 10 is 23:30 on Jun 9 in Chicago (UTC-5 in June). The two zones disagree about which
// DAY this is, which is the whole point of the fixture. It sits comfortably inside the requested
// window under either zone, so the window bounds are not what is under test here.
const CROSS_MIDNIGHT = U("ac0a");
// A control on the same UTC day whose Chicago date also happens to be Jun 10, so the day must hold
// exactly two entries once bucketing is correct.
const SAME_DAY = U("ac0b");

const FILTERS = {
  dateFrom: "2026-06-01",
  dateTo: "2026-06-30",
  office: undefined as string | undefined,
  ownerIds: [] as string[],
  ownerNames: [] as string[],
};
const DIRECTOR = { role: "director" as const, userId: ALICE, displayName: "Alice Rep" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  // NOT UTC. This is what makes the suite discriminating.
  await pg.exec("SET TimeZone='America/Chicago';");
  await pg.exec(
    tenantSchemaSql("public", [offices, users, pipelineStageConfig, companies, contacts, properties, leads, deals, activities])
  );
  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES ('${OFF}', 'Dallas', 'dallas');
    INSERT INTO public.users (id, email, display_name, role, office_id, is_active) VALUES
      ('${ALICE}', 'alice@example.com', 'Alice Rep', 'rep', '${OFF}', true);
    INSERT INTO public.pipeline_stage_config (id, slug, name, display_order) VALUES
      ('${STAGE}', 'estimating', 'Estimating', 3);
    INSERT INTO public.companies (id, name, slug, category) VALUES ('${CO1}', 'Acme', 'acme', 'client');
    INSERT INTO public.deals (id, deal_number, name, stage_id, assigned_rep_id, company_id, is_active)
      VALUES ('${DEAL1}', 'D-1001', 'Roof Replacement', '${STAGE}', '${ALICE}', '${CO1}', true);
    INSERT INTO public.activities
      (id, type, source_entity_type, source_entity_id, responsible_user_id, deal_id, subject, occurred_at, created_at) VALUES
      ('${CROSS_MIDNIGHT}', 'note', 'deal', '${DEAL1}', '${ALICE}', '${DEAL1}',
        'Late night note', '2026-06-10T04:30:00Z', '2026-06-10T04:30:00Z'),
      ('${SAME_DAY}', 'note', 'deal', '${DEAL1}', '${ALICE}', '${DEAL1}',
        'Midday note', '2026-06-10T17:00:00Z', '2026-06-10T17:00:00Z');
  `);
  tdb = drizzle(pg);
}, 60_000);

afterAll(async () => {
  await pg?.close?.();
});

describe("daily activity log — day bucket under a non-UTC database session", () => {
  it("confirms the session really is non-UTC, so these assertions can discriminate", async () => {
    // Guards the suite itself: under a UTC session the pinned and unpinned expressions coincide and
    // every assertion below would pass regardless of the fix.
    const res: any = await pg.query(
      "SELECT current_setting('TimeZone') AS tz, ($1::timestamptz)::date::text AS session_day, (($1::timestamptz) AT TIME ZONE 'UTC')::date::text AS utc_day",
      ["2026-06-10T04:30:00Z"]
    );
    const row = res.rows[0];
    expect(row.tz).toBe("America/Chicago");
    expect(row.session_day).toBe("2026-06-09"); // what a bare ::date would have produced
    expect(row.utc_day).toBe("2026-06-10"); // what the pinned bucket produces
    expect(row.session_day).not.toBe(row.utc_day);
  });

  it("files an activity under its UTC day, not the session's day", async () => {
    const report = await getDailyActivityLogReport(tdb, FILTERS, normalizeDailyActivityLogOptions({}), DIRECTOR);

    expect(report.days.map((d) => d.date)).toEqual(["2026-06-10"]);
    expect(report.days[0].entryCount).toBe(2);
    // The session's own answer must NOT appear as a bucket.
    expect(report.days.some((d) => d.date === "2026-06-09")).toBe(false);
    expect(report.kpis.daysCovered).toBe(1);
  });

  it("reports occurredDate per row in UTC so the row agrees with its heading", async () => {
    const report = await getDailyActivityLogReport(tdb, FILTERS, normalizeDailyActivityLogOptions({}), DIRECTOR);
    const entry = report.days[0].entries.find((e) => e.id === CROSS_MIDNIGHT)!;

    // 04:30Z — the client renders this as 4:30 AM under a "times UTC" label, so the row's own date
    // must be the UTC one or the page contradicts itself.
    expect(entry.occurredDate).toBe("2026-06-10");
    expect(entry.loggedDate).toBe("2026-06-10");
    expect(entry.loggedSameDay).toBe(true);
    expect(entry.loggedDaysDiff).toBe(0);
  });

  it("still reconciles with Rep Activity under the same non-UTC session", async () => {
    // Both buckets were pinned in the same change precisely so this holds on any server, not just a
    // UTC one. If only one side had been pinned, this is the test that would catch it.
    const log = await getDailyActivityLogReport(tdb, FILTERS, normalizeDailyActivityLogOptions({}), DIRECTOR);
    const repActivity = await getRepActivityReport(tdb, FILTERS, DIRECTOR, "session-tz-reconcile");

    const logByDay = Object.fromEntries(log.days.map((d) => [d.date, d.entryCount]));
    const repByDay = Object.fromEntries(repActivity.timeline.map((t) => [t.date, t.touchpoints]));
    expect(logByDay).toEqual(repByDay);
    expect(repByDay["2026-06-10"]).toBe(2);
    expect(log.kpis.totalEntries).toBe(repActivity.kpis.totalTouchpoints);
  });
});
