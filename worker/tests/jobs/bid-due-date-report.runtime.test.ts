import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  effectiveOnHoldConditionSqlPredicate,
  genuineEstimatingStageSqlPredicate,
} from "@trock-crm/shared/types";
import {
  BID_DUE_REPORT_HORIZON_DAYS,
  BID_DUE_REPORT_OVERDUE_LOOKBACK_DAYS,
  countEstimatingDealsMissingBidDueDate,
  findBidDueDateReportRows,
  sectionBidDueDateReportRows,
  resolveGroupRecipients,
} from "../../src/jobs/bid-due-date-report.js";

/**
 * Against a REAL Postgres, asserting RETURNED ROWS.
 *
 * With `query` stubbed, every one of these degrades to `expect(sql).toContain(...)` — which passes if the
 * fragment appears in a comment, on the wrong column, or inside a leg that never runs. The `AT TIME ZONE
 * 'UTC'` guard is the sharpest case: its whole failure mode is a calendar day that is off by one, and no
 * amount of string matching can see a day.
 *
 * The session runs in America/Chicago DELIBERATELY. Prod happens to run Etc/UTC today, under which a bare
 * `::date` and a UTC-normalized one agree and the regression guard is untestable. West of UTC they differ
 * by exactly the day this report sorts, filters and displays on.
 */

const SCHEMA = "office_test";
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;

const ESTIMATING = U("a1");
const ESTIMATE_IN_PROGRESS = U("a2");
const SERVICE_ESTIMATING = U("a3");
const WON = U("a4");
const ESTIMATING_TERMINAL = U("a5"); // an 'estimating' row flipped is_terminal in the config table

const REP_HELMS = U("b1");
const REP_GIBSON = U("b2");

// The Wednesday every seeded date is stated relative to — and the ONE anchor the report renders against,
// on the normal tick and on the Thursday catch-up alike.
const TODAY = "2026-08-26";
// What the run date would be on the catch-up tick. Nothing in the report may be computed from it.
const THURSDAY = "2026-08-27";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let query: any;

const d = (isoDate: string) => `'${isoDate} 00:00:00+00'::timestamptz`;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    SET TIME ZONE 'America/Chicago';
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE public.pipeline_stage_config (
      id uuid PRIMARY KEY,
      slug varchar(100) NOT NULL,
      is_terminal boolean NOT NULL DEFAULT false
    );
    CREATE TABLE public.users (
      id uuid PRIMARY KEY,
      display_name text,
      email text,
      is_active boolean NOT NULL DEFAULT true,
      office_id uuid
    );
    CREATE TABLE public.notification_recipient_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key text NOT NULL UNIQUE
    );
    CREATE TABLE public.notification_recipient_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id uuid NOT NULL REFERENCES public.notification_recipient_groups(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      UNIQUE (group_id, user_id)
    );
    CREATE TABLE public.offices (
      id uuid PRIMARY KEY,
      slug varchar(100) NOT NULL,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE public.user_office_access (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      office_id uuid NOT NULL,
      UNIQUE (user_id, office_id)
    );
    CREATE TABLE ${SCHEMA}.deals (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      deal_number text,
      project_number text,
      stage_id uuid NOT NULL,
      assigned_rep_id uuid,
      estimator_user_id uuid,
      bid_due_date timestamptz,
      expected_close_date date,
      bid_board_stage_slug varchar(100),
      awarded_amount numeric(14,2),
      bid_board_total_sales numeric(14,2),
      bid_estimate numeric(14,2),
      dd_estimate numeric(14,2),
      is_active boolean NOT NULL DEFAULT true,
      is_test_data boolean NOT NULL DEFAULT false,
      is_change_order boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false
    );

    INSERT INTO public.pipeline_stage_config (id, slug, is_terminal) VALUES
      ('${ESTIMATING}', 'estimating', false),
      ('${ESTIMATE_IN_PROGRESS}', 'estimate_in_progress', false),
      ('${SERVICE_ESTIMATING}', 'service_estimating', false),
      ('${WON}', 'won', true),
      ('${ESTIMATING_TERMINAL}', 'estimating', true);

    INSERT INTO public.users (id, display_name, email, is_active) VALUES
      ('${REP_HELMS}', 'James Helms', 'jhelms@trockgc.com', true),
      ('${REP_GIBSON}', 'Sidney Gibson', 'sidney@trockgc.com', true);

    INSERT INTO ${SCHEMA}.deals (id, name, deal_number, project_number, stage_id, assigned_rep_id, bid_due_date, expected_close_date, bid_board_stage_slug, bid_estimate, is_active, is_test_data, is_change_order, on_hold) VALUES
      -- IN, and the UTC-midnight boundary row: 2026-09-04T00:00Z is 2026-09-03 19:00 in the session's CT.
      ('${U("d1")}', 'Cedar Park Retail', 'DFW-1-1', '24-131', '${ESTIMATING}', '${REP_GIBSON}', ${d("2026-09-04")}, '2026-12-01', NULL, 840000, true, false, false, false),
      -- IN, and FIRST: overdue by 7 days.
      ('${U("d2")}', 'Riverside Medical', 'DFW-1-2', '24-118', '${ESTIMATING}', '${REP_HELMS}', ${d("2026-08-19")}, '2026-12-01', NULL, 1200000, true, false, false, false),
      -- IN via the legacy alias slug.
      ('${U("d3")}', 'Legacy Alias', 'DFW-1-3', '24-140', '${ESTIMATE_IN_PROGRESS}', '${REP_HELMS}', ${d("2026-08-28")}, '2026-12-01', NULL, 500000, true, false, false, false),
      -- IN with NO assigned rep: rendered '—', never dropped.
      ('${U("d4")}', 'Unassigned Bid', 'DFW-1-4', '24-141', '${ESTIMATING}', NULL, ${d("2026-08-27")}, '2026-12-01', NULL, 250000, true, false, false, false),
      -- IN: Bid Board mirror is OPEN. The mirror may only ever REMOVE a deal, never contradict an open CRM stage.
      ('${U("d5")}', 'Mirrored Bidding', 'DFW-1-5', '24-142', '${ESTIMATING}', '${REP_HELMS}', ${d("2026-09-10")}, '2026-12-01', 'bidding', 700000, true, false, false, false),
      -- THE THREE SECTION BOUNDARIES, seeded because a boundary with no row on it is a boundary no test can
      -- move: today (this week, NOT overdue), today+6 (the last day of this week) and today+7 (the first day
      -- that is not). Without these, loosening either comparison leaves the whole suite green.
      ('${U("d6")}', 'Due Today', 'DFW-1-18', '24-143', '${ESTIMATING}', '${REP_HELMS}', ${d("2026-08-26")}, '2026-12-01', NULL, 300000, true, false, false, false),
      ('${U("d7")}', 'Week Edge', 'DFW-1-19', '24-144', '${ESTIMATING}', '${REP_HELMS}', ${d("2026-09-01")}, '2026-12-01', NULL, 310000, true, false, false, false),
      ('${U("d8")}', 'Just After Week', 'DFW-1-20', '24-145', '${ESTIMATING}', '${REP_HELMS}', ${d("2026-09-02")}, '2026-12-01', NULL, 320000, true, false, false, false),

      -- OUT: service_estimating is a different cohort (the service route maps estimating -> service_estimating).
      ('${U("e1")}', 'Service Estimating', 'DFW-4-1', '24-150', '${SERVICE_ESTIMATING}', '${REP_HELMS}', ${d("2026-09-01")}, '2026-12-01', NULL, 100000, true, false, false, false),
      -- OUT: C3. CRM stage still estimating, Bid Board mirror says the job is already won.
      ('${U("e2")}', 'Won On The Board', 'DFW-1-6', '24-151', '${ESTIMATING}', '${REP_HELMS}', ${d("2026-09-01")}, '2026-12-01', 'closed_won', 900000, true, false, false, false),
      -- OUT: test data.
      ('${U("e3")}', 'Test Deal', 'DFW-1-7', '24-152', '${ESTIMATING}', '${REP_HELMS}', ${d("2026-09-01")}, '2026-12-01', NULL, 100000, true, true, false, false),
      -- OUT: soft-deleted.
      ('${U("e4")}', 'Inactive Deal', 'DFW-1-8', '24-153', '${ESTIMATING}', '${REP_HELMS}', ${d("2026-09-01")}, '2026-12-01', NULL, 100000, false, false, false, false),
      -- OUT: change-order child.
      ('${U("e5")}', 'Change Order', 'DFW-1-9', '24-154', '${ESTIMATING}', '${REP_HELMS}', ${d("2026-09-01")}, '2026-12-01', NULL, 100000, true, false, true, false),
      -- OUT: parked.
      ('${U("e6")}', 'On Hold Deal', 'DFW-1-10', '24-155', '${ESTIMATING}', '${REP_HELMS}', ${d("2026-09-01")}, '2026-12-01', NULL, 100000, true, false, false, true),
      -- OUT: the stage row itself is configured terminal.
      ('${U("e7")}', 'Terminal Stage Row', 'DFW-1-11', '24-156', '${ESTIMATING_TERMINAL}', '${REP_HELMS}', ${d("2026-09-01")}, '2026-12-01', NULL, 100000, true, false, false, false),
      -- OUT of the WINDOW: 31 days out (horizon is 30).
      ('${U("e8")}', 'Just Past Horizon', 'DFW-1-12', '24-157', '${ESTIMATING}', '${REP_HELMS}', ${d("2026-09-26")}, '2026-12-01', NULL, 100000, true, false, false, false),
      -- OUT of the WINDOW: overdue by 91 days (lookback is 90).
      ('${U("e9")}', 'Ancient Overdue', 'DFW-1-13', '24-158', '${ESTIMATING}', '${REP_HELMS}', ${d("2026-05-27")}, '2026-12-01', NULL, 100000, true, false, false, false),

      -- NO BID DATE: excluded from the list, counted in the footer.
      ('${U("f1")}', 'No Bid Date A', 'DFW-1-14', '24-160', '${ESTIMATING}', '${REP_HELMS}', NULL, '2026-09-30', NULL, 100000, true, false, false, false),
      ('${U("f2")}', 'No Bid Date B', 'DFW-1-15', '24-161', '${ESTIMATE_IN_PROGRESS}', '${REP_HELMS}', NULL, '2026-09-30', NULL, 100000, true, false, false, false),
      -- NOT counted in the footer: same missing date, but excluded by the same predicates as the list.
      ('${U("f3")}', 'No Bid Date, Test', 'DFW-1-16', '24-162', '${ESTIMATING}', '${REP_HELMS}', NULL, '2026-09-30', NULL, 100000, true, true, false, false),

      -- VALUE CHAIN discriminators. The CRM's estimating-stage chain is awarded > dd > bid_board > bid;
      -- the worker's generic open chain is bid_board > bid > dd > awarded. These two rows are the only
      -- shapes where those disagree, and they are what the emailed figure is checked against.
      ('${U("d9")}', 'DD Beats Board', 'DFW-1-21', '24-146', '${ESTIMATING}', '${REP_HELMS}', ${d("2026-09-03")}, '2026-12-01', NULL, 50000, true, false, false, false),
      ('${U("da")}', 'Awarded Beats All', 'DFW-1-22', '24-147', '${ESTIMATING}', '${REP_HELMS}', ${d("2026-09-05")}, '2026-12-01', NULL, 50000, true, false, false, false),

      -- REALIZED + FAR OUT: proves the terminal leg of the effective-on-hold predicate. Won in the CRM,
      -- with a horizon date ~200 days out. Without the stage_id terminal guard the far-out leg auto-parks it.
      ('${U("c1")}', 'Won And Far Out', 'DFW-1-17', '24-170', '${WON}', '${REP_HELMS}', ${d("2027-03-15")}, '2027-03-15', NULL, 100000, true, false, false, false);

    UPDATE ${SCHEMA}.deals SET dd_estimate = 900000, bid_board_total_sales = 100000
      WHERE name = 'DD Beats Board';
    UPDATE ${SCHEMA}.deals SET awarded_amount = 700000, dd_estimate = 900000, bid_board_total_sales = 100000
      WHERE name = 'Awarded Beats All';

    -- RECIPIENTS AND OFFICE ACCESS, seeded once at file level so no suite depends on another suite's hook
    -- having run first. An earlier draft split these across two describes and the second one's tables did
    -- not exist yet — vitest reported that as 5 SKIPPED tests rather than failures, which is exactly the
    -- silent no-op these tests exist to rule out.
    INSERT INTO public.offices (id, slug) VALUES
      ('${U("f01")}', 'dfw'),
      ('${U("f02")}', 'atl');

    UPDATE public.users SET office_id = '${U("f01")}' WHERE email = 'sidney@trockgc.com';
    INSERT INTO public.users (id, display_name, email, is_active, office_id) VALUES
      ('${U("b3")}', 'Departed Person', 'departed@trockgc.com', false, '${U("f01")}'),
      ('${U("b4")}', 'No Address', NULL, true, '${U("f01")}'),
      ('${U("f11")}', 'Cross Office', 'cross@trockgc.com', true, '${U("f01")}'),
      ('${U("f12")}', 'Atlanta Only', 'atl@trockgc.com', true, '${U("f02")}');
    -- Cross Office is DFW-primary AND explicitly granted ATL: the two halves of the access rule.
    INSERT INTO public.user_office_access (user_id, office_id) VALUES ('${U("f11")}', '${U("f02")}');

    INSERT INTO public.notification_recipient_groups (id, key) VALUES
      ('${U("ca1")}', 'bid_due_date_report'),
      ('${U("ca2")}', 'empty_group');
    INSERT INTO public.notification_recipient_assignments (group_id, user_id) VALUES
      ('${U("ca1")}', '${REP_GIBSON}'),
      ('${U("ca1")}', '${U("b3")}'),
      ('${U("ca1")}', '${U("b4")}'),
      ('${U("ca1")}', '${U("f11")}'),
      ('${U("ca1")}', '${U("f12")}');
  `);
  query = (sql: string, params?: unknown[]) => pg.query(sql, params as never[]);
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

const names = (rows: { name: string }[]) => rows.map((row) => row.name);

async function reportRows() {
  return findBidDueDateReportRows(query, { tenantSchema: SCHEMA, weekOf: TODAY });
}

describe("findBidDueDateReportRows — population", () => {
  it("includes the canonical estimating stage AND its legacy alias, and never service_estimating", async () => {
    const rows = await reportRows();
    expect(names(rows)).toContain("Cedar Park Retail"); // estimating
    expect(names(rows)).toContain("Legacy Alias"); // estimate_in_progress
    expect(names(rows)).not.toContain("Service Estimating");
  });

  it("C3: a deal the Bid Board says is WON is excluded, even while its CRM stage reads estimating", async () => {
    // The two stage signals disagree, and the report picks one rule: the CRM stage_id selects the
    // population, the Bid Board mirror may only REMOVE from it. Chasing Sidney about a bid on a job
    // already won is the report earning itself a filter rule.
    const rows = await reportRows();
    expect(names(rows)).not.toContain("Won On The Board");
    // ...and the other half of the rule: an OPEN mirror slug does not remove anything. A mirror that could
    // also add or override would drop every live Bid Board bid from the one report meant to surface them.
    expect(names(rows)).toContain("Mirrored Bidding");
  });

  it("excludes test-data, inactive, change-order, on-hold and terminal-stage deals", async () => {
    const excluded = [
      "Test Deal",
      "Inactive Deal",
      "Change Order",
      "On Hold Deal",
      "Terminal Stage Row",
    ];
    const rows = await reportRows();
    for (const name of excluded) expect(names(rows)).not.toContain(name);
  });

  it("bounds the window: 30 days forward, 90 days of overdue lookback", async () => {
    expect(BID_DUE_REPORT_HORIZON_DAYS).toBe(30);
    expect(BID_DUE_REPORT_OVERDUE_LOOKBACK_DAYS).toBe(90);
    const rows = await reportRows();
    expect(names(rows)).not.toContain("Just Past Horizon"); // +31
    expect(names(rows)).not.toContain("Ancient Overdue"); // -91
  });

  it("excludes NULL bid due dates from the list", async () => {
    const rows = await reportRows();
    expect(names(rows)).not.toContain("No Bid Date A");
    expect(names(rows)).not.toContain("No Bid Date B");
  });

  it("keeps a deal with no assigned rep, and reports the rep as null rather than dropping the row", async () => {
    const rows = await reportRows();
    const unassigned = rows.find((row) => row.name === "Unassigned Bid");
    expect(unassigned).toBeDefined();
    expect(unassigned?.repName).toBeNull();
  });

  it("resolves the rep display name through public.users", async () => {
    const rows = await reportRows();
    expect(rows.find((row) => row.name === "Riverside Medical")?.repName).toBe("James Helms");
  });
});

describe("findBidDueDateReportRows — the date", () => {
  it("reads bid_due_date AT TIME ZONE 'UTC', so the UTC-midnight timestamp keeps its calendar day", async () => {
    // The session is America/Chicago. `'2026-09-04 00:00:00+00'::timestamptz::date` resolves to 2026-09-03
    // there — one day early, which would sort this row between two August rows and could file a due-today
    // bid as overdue. Dropping `AT TIME ZONE 'UTC'` from the source turns the value below into 2026-09-03.
    const rows = await reportRows();
    expect(rows.find((row) => row.name === "Cedar Park Retail")?.bidDueOn).toBe("2026-09-04");
    expect(rows.find((row) => row.name === "Riverside Medical")?.bidDueOn).toBe("2026-08-19");
  });

  it("sorts ascending — closest bid date first", async () => {
    const rows = await reportRows();
    const dates = rows.map((row) => row.bidDueOn);
    expect(dates).toEqual([...dates].sort());
    expect(rows[0]?.name).toBe("Riverside Medical"); // 2026-08-19, the only overdue row in the window
  });

  it("C4: the SAME date drives sort, window and display — one column, read one way", async () => {
    // Every row's rendered date is the value the ORDER BY and the BETWEEN used. There is no second
    // resolver: `resolveDealBidDueDateForRead` is server-only and flag-gated, and porting its precedence
    // to the display layer alone is how a row renders "Sep 30" between two August rows.
    const rows = await reportRows();
    for (const row of rows) {
      expect(row.bidDueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const sections = sectionBidDueDateReportRows(rows, TODAY);
    for (const section of sections) {
      for (const row of section.rows) {
        expect(rows.find((r) => r.id === row.id)?.bidDueOn).toBe(row.bidDueOn);
      }
    }
  });

  it("carries the deal value from the CRM's ESTIMATING-STAGE chain, not the generic open chain", async () => {
    // The email is a drill-down with a longer wire, and its CTA lands on the estimating stage page — which
    // resolves value awarded > dd > bid_board > bid. The worker's generic open chain
    // (workerCurrentDealValueSql) is bid_board-FIRST, so a deal carrying both a DD estimate and a Bid Board
    // total would be emailed $100,000 and then display $900,000 one click later. A figure and its
    // drill-down move together.
    const rows = await reportRows();
    expect(rows.find((row) => row.name === "DD Beats Board")?.value).toBe(900000);
    expect(rows.find((row) => row.name === "Awarded Beats All")?.value).toBe(700000);
    // Unchanged for the ordinary shape, where only one candidate is populated.
    expect(rows.find((row) => row.name === "Riverside Medical")?.value).toBe(1200000);
  });
});

describe("sectionBidDueDateReportRows", () => {
  it("splits Overdue / This week / Next 30 days, each ascending, in that order", async () => {
    const sections = sectionBidDueDateReportRows(await reportRows(), TODAY);
    expect(sections.map((section) => section.key)).toEqual(["overdue", "this_week", "next_30"]);
    expect(names(sections[0].rows)).toEqual(["Riverside Medical"]); // Aug 19, before today
    // Aug 26 (TODAY), 27, 28, Sep 1 (TODAY+6, the last day of the week)
    expect(names(sections[1].rows)).toEqual([
      "Due Today",
      "Unassigned Bid",
      "Legacy Alias",
      "Week Edge",
    ]);
    // Sep 2 (TODAY+7, the first day that is not this week), Sep 4, Sep 10
    expect(names(sections[2].rows)).toEqual([
      "Just After Week",
      "DD Beats Board",
      "Cedar Park Retail",
      "Awarded Beats All",
      "Mirrored Bidding",
    ]);
  });

  it("files a deal due TODAY under This week, never under Overdue", async () => {
    const sections = sectionBidDueDateReportRows(await reportRows(), TODAY);
    expect(names(sections[0].rows)).not.toContain("Due Today");
    expect(names(sections[1].rows)).toContain("Due Today");
  });

  it("keeps TODAY+6 in This week and pushes TODAY+7 out of it", async () => {
    const sections = sectionBidDueDateReportRows(await reportRows(), TODAY);
    expect(names(sections[1].rows)).toContain("Week Edge");
    expect(names(sections[1].rows)).not.toContain("Just After Week");
    expect(names(sections[2].rows)).toContain("Just After Week");
  });

  it("is GENUINELY anchor-sensitive — which is what makes the catch-up identity test mean something", async () => {
    // If sectioning did not move with its anchor, "Wednesday and Thursday agree" would be vacuously true
    // and would keep passing with the anchor wired to the run date. It moves: shifted a day forward,
    // 'Just After Week' (weekOf+7, i.e. Thursday+6) crosses into THIS WEEK and the deal due ON weekOf
    // becomes overdue. That is precisely the divergence the catch-up must not be able to produce.
    const rows = await reportRows();
    const onWednesday = sectionBidDueDateReportRows(rows, TODAY);
    const onThursday = sectionBidDueDateReportRows(rows, THURSDAY);
    expect(names(onThursday[1].rows)).toContain("Just After Week");
    expect(names(onWednesday[1].rows)).not.toContain("Just After Week");
    expect(names(onThursday[0].rows)).toContain("Due Today");
    expect(names(onWednesday[0].rows)).not.toContain("Due Today");
  });

  it("the window itself is anchor-sensitive, so the SQL bound must take weekOf too", async () => {
    // Same argument one layer down: 'Just Past Horizon' is weekOf+31, outside the 30-day window on the
    // normal tick and inside it if the query anchors on Thursday. A catch-up that returned an extra row
    // would produce a different email from the run it replaces before any sectioning happened.
    const shifted = await findBidDueDateReportRows(query, {
      tenantSchema: SCHEMA,
      weekOf: THURSDAY,
    });
    expect(names(shifted)).toContain("Just Past Horizon");
    expect(names(await reportRows())).not.toContain("Just Past Horizon");
  });

  it("drops a section that has no rows rather than printing an empty heading", async () => {
    const rows = (await reportRows()).filter((row) => row.bidDueOn >= TODAY);
    expect(sectionBidDueDateReportRows(rows, TODAY).map((s) => s.key)).toEqual([
      "this_week",
      "next_30",
    ]);
  });
});

describe("countEstimatingDealsMissingBidDueDate", () => {
  it("counts NULL-bid-date deals under the SAME predicates as the list, minus the date filter", async () => {
    // 91% of deals carry no bid due date, so a short list reads as "nothing due". The count only
    // reconciles with the report if it is drawn from the same population — 'No Bid Date, Test' is
    // excluded here for exactly the reason it would be excluded from the list.
    const count = await countEstimatingDealsMissingBidDueDate(query, { tenantSchema: SCHEMA });
    expect(count).toBe(2);
  });
});

describe("resolveGroupRecipients — OFFICE SCOPING (authorization, not preference)", () => {
  // This repo grants a user access to an office through their PRIMARY office (`users.office_id`) or an
  // explicit `user_office_access` grant — the rule getOfficeAccess() implements, and the one a background
  // job is expected to re-apply (that module's own header says so). The recipient groups are keyed UNIQUE
  // in `public`, so they are GLOBAL: without this filter, a person configured for one office receives
  // another office's estimating pipeline — deal names, numbers and dollar values — by email, for deals the
  // CRM would not let them open. Latent at one office, and what makes it fire is somebody adding a second.
  it("includes a user whose PRIMARY office is the one being reported on", async () => {
    const dfw = await resolveGroupRecipients(query, "bid_due_date_report", U("f01"));
    expect(dfw).toContain("sidney@trockgc.com");
  });

  it("includes a user holding an explicit user_office_access GRANT for that office", async () => {
    const atl = await resolveGroupRecipients(query, "bid_due_date_report", U("f02"));
    expect(atl).toContain("cross@trockgc.com");
  });

  it("EXCLUDES a recipient with no access to the office being reported on", async () => {
    // The leak, stated directly: Atlanta Only must never receive the DFW pipeline, and Sidney (DFW
    // primary, no ATL grant) must never receive Atlanta's.
    const dfw = await resolveGroupRecipients(query, "bid_due_date_report", U("f01"));
    expect(dfw).not.toContain("atl@trockgc.com");
    const atl = await resolveGroupRecipients(query, "bid_due_date_report", U("f02"));
    expect(atl).not.toContain("sidney@trockgc.com");
  });

  it("still applies is_active on top of the office filter", async () => {
    const dfw = await resolveGroupRecipients(query, "bid_due_date_report", U("f01"));
    expect(dfw).not.toContain("departed@trockgc.com");
  });

  it("returns [] when the group has members but NONE can see this office", async () => {
    // Must be a loud failure at the caller, not a silent skip — an office nobody is configured for is a
    // report that reaches nobody, which is the C1 case one level down.
    const other = await resolveGroupRecipients(query, "empty_group", U("f01"));
    expect(other).toEqual([]);
  });
});

describe("resolveGroupRecipients, executed", () => {
  // The worker resolves recipients in raw SQL because the server's getNotificationRecipients takes a
  // drizzle TenantDb a cron does not have. These assertions are the ones that make the C1 throw meaningful:
  // if this query did not filter is_active, a deactivated recipient would keep receiving mail and the
  // "resolves to nobody" case would never arise to be thrown on.
  it("returns only ACTIVE users who have an address", async () => {
    // Departed Person is inactive and No Address has none; both are assigned and both are dropped.
    expect(await resolveGroupRecipients(query, "bid_due_date_report", U("f01"))).toEqual([
      "cross@trockgc.com",
      "sidney@trockgc.com",
    ]);
  });

  it("returns [] for a group with no assignments — the case the caller must treat as fatal", async () => {
    expect(await resolveGroupRecipients(query, "empty_group", U("f01"))).toEqual([]);
  });

  it("returns [] for a key with no group row at all", async () => {
    expect(await resolveGroupRecipients(query, "no_such_group", U("f01"))).toEqual([]);
  });
});

describe("the effective-on-hold string twin, executed", () => {
  // The terminal leg C2 says is silently dropped when `terminalStageIds` goes unpassed. It cannot be
  // observed through the report's own query — inside a [-90, +30] day window the far-out leg can never
  // fire, because in the estimating stage the hold horizon IS bid_due_date — so it is proved directly.
  const verdictFor = async (predicate: string, name: string) => {
    const result = await query(
      `SELECT ${predicate} AS parked FROM ${SCHEMA}.deals d WHERE d.name = $1`,
      [name],
    );
    return result.rows[0]?.parked;
  };

  it("does NOT park a REALIZED deal whose horizon date is far out", async () => {
    expect(await verdictFor(effectiveOnHoldConditionSqlPredicate("d"), "Won And Far Out")).toBe(false);
  });

  it("...and DOES park it once the CRM-stage terminal leg is dropped — the arg that must not go unpassed", async () => {
    // `effectiveOnHoldConditionSqlPredicate("d", null)` is the shape
    // `aliasedEffectiveOnHoldConditionSql("d")` emits when a caller does not resolve the terminal ids.
    expect(await verdictFor(effectiveOnHoldConditionSqlPredicate("d", null), "Won And Far Out")).toBe(true);
  });

  it("parks a stored-on_hold deal regardless of dates", async () => {
    expect(await verdictFor(effectiveOnHoldConditionSqlPredicate("d"), "On Hold Deal")).toBe(true);
  });

  it("selects only the genuine estimating stages, executed against the real config table", async () => {
    const result = await query(
      `SELECT d.name FROM ${SCHEMA}.deals d WHERE ${genuineEstimatingStageSqlPredicate("d")} ORDER BY d.name`,
    );
    const selected = result.rows.map((row: { name: string }) => row.name);
    expect(selected).toContain("Cedar Park Retail");
    expect(selected).toContain("Legacy Alias");
    expect(selected).not.toContain("Service Estimating");
    expect(selected).not.toContain("Won And Far Out");
  });
});
