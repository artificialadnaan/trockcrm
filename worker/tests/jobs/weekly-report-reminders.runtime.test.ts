// Runtime suite for the Weekly Reports reminder cron.
//
// The schema is migration 0222 READ FROM DISK — the file that actually ships — because every guarantee
// this job makes is enforced by the schema: the `(project, week_of, kind)` unique constraint IS the
// idempotency, and a hand-copied CREATE TABLE that forgot it would let the suite pass while the deployed
// job double-emails every superintendent in the office.
//
// TZ: the harness pins `now` explicitly on every run rather than reading the runner's clock, and the
// cadence is business-timezone (America/Chicago), so the UTC/Chicago day boundary is asserted directly
// instead of being whatever the machine happens to say.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deals, files, offices, users } from "@trock-crm/shared/schema";
import { weeklyReportExpectedWeeks } from "@trock-crm/shared/types";
import { migrationSql } from "../../../server/tests/helpers/migration-sql.js";
import { tenantSchemaSql } from "../../../server/tests/helpers/tenant-schema-from-drizzle.js";
import {
  buildBacklog,
  buildWeeklyReportLeadershipDigestEmail,
  buildWeeklyReportReminderEmail,
  businessCalendarDay,
  formatDueDay,
  reminderKindForLeadDays,
  runWeeklyReportReminders,
  weeklyReportAppDeepLinksEnabled,
  weeklyReportDashboardUrl,
  weeklyReportReminderLinks,
} from "../../src/jobs/weekly-report-reminders.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const OFFICE = U("00001");
const DEAL = U("11111");
const OTHER_DEAL = U("11112");
const PM = U("22221");
const SUPER = U("22222");
const RETIRED_SUPER = U("22223");
const WON_STAGE = U("33331");
const PROJECT = U("44441");
const OTHER_PROJECT = U("44442");

// The reference report's cadence: Thursday (Postgres/JS DOW 4). Week of 2026-08-13 is a Thursday, so
// 08-11 is t-2 and 08-12 is t-1.
const THURSDAY = 4;
const DUE = "2026-08-13";
const T_MINUS_2 = "2026-08-11";
const T_MINUS_1 = "2026-08-12";

/**
 * Noon UTC on the given calendar day — inside business hours in America/Chicago in BOTH CDT and CST, so
 * the harness pins a date without silently depending on which offset is in force. (07:00 CT is 12:00Z
 * only under CDT; naming this "7am CT" would be a lie for half the year.)
 */
const atNoonUtc = (isoDate: string) => new Date(`${isoDate}T12:00:00Z`);

let pg: PGlite;

const query = async (text: string, params?: unknown[]) => {
  const result = await pg.query(text, params as any[]);
  return {
    rows: result.rows as any[],
    // PGlite reports writes as `affectedRows`; `rows.length` is 0 for every UPDATE/DELETE without
    // RETURNING. The job does not read rowCount today, but a harness that reports it WRONG is how a
    // future "the delete affected nothing" assertion silently passes.
    rowCount: (result as { affectedRows?: number }).affectedRows ?? result.rows.length,
  };
};

interface SentEmail {
  to: string[];
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}

function emailSpy(behaviour: { fail?: boolean } = {}) {
  const sent: SentEmail[] = [];
  const sendEmail = async (
    to: string | string[],
    subject: string,
    html: string,
    options: { text: string; idempotencyKey: string },
  ) => {
    sent.push({
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text: options.text,
      idempotencyKey: options.idempotencyKey,
    });
    if (behaviour.fail) return { success: false, messageId: null };
    return { success: true, messageId: `msg-${sent.length}` };
  };
  return { sent, sendEmail };
}

async function run(onDate: string, behaviour: { fail?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const spy = emailSpy(behaviour);
  const summary = await runWeeklyReportReminders({
    query,
    sendEmail: spy.sendEmail,
    env: behaviour.env ?? { FRONTEND_URL: "https://trockcrm.com", WEEKLY_REPORT_APP_DEEP_LINKS: "true" },
    now: atNoonUtc(onDate),
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    // The advisory lock needs a real pooled pg connection; the single-flight behaviour is orthogonal to
    // everything under test here, so the harness grants it.
    acquireLock: async () => async () => {},
  });
  return { ...spy, summary };
}

async function reminderLedger() {
  const res = await pg.query(
    `SELECT weekly_report_project_id, to_char(week_of, 'YYYY-MM-DD') AS week_of, kind
       FROM office_dallas.weekly_report_reminders_sent
      ORDER BY kind, weekly_report_project_id`,
  );
  return res.rows as Array<{ weekly_report_project_id: string; week_of: string; kind: string }>;
}

async function seedReport(input: {
  projectId?: string;
  weekOf?: string;
  status: string;
  version?: number;
  supersededById?: string | null;
  isActive?: boolean;
  id?: string;
}) {
  await pg.query(
    `INSERT INTO office_dallas.weekly_reports
       (id, client_submission_id, weekly_report_project_id, deal_id, week_of, version, status,
        superseded_by_id, is_active)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), gen_random_uuid(), $2::uuid, $3::uuid, $4::date, $5, $6,
             $7::uuid, $8)`,
    [
      input.id ?? null,
      input.projectId ?? PROJECT,
      DEAL,
      input.weekOf ?? DUE,
      input.version ?? 1,
      input.status,
      input.supersededById ?? null,
      input.isActive ?? true,
    ],
  );
}

async function setLeadershipRecipients(emails: string[]) {
  await pg.query(`DELETE FROM office_dallas.weekly_report_settings`);
  await pg.query(
    `INSERT INTO office_dallas.weekly_report_settings (leadership_recipient_emails) VALUES ($1::text[])`,
    [emails],
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_dallas;`);
  await pg.exec(tenantSchemaSql("public", [offices, users]));
  await pg.exec(tenantSchemaSql("office_dallas", [deals, files]));
  await pg.exec(`CREATE TABLE IF NOT EXISTS public.pipeline_stage_config (id uuid PRIMARY KEY, slug text);`);
  await pg.exec(migrationSql("0222_weekly_reports"));
  // 0223 adds weekly_report_pauses, which the cadence regeneration reads to skip paused stretches.
  await pg.exec(migrationSql("0223_weekly_report_pauses"));

  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES ('${OFFICE}', 'Dallas', 'dallas');
    INSERT INTO public.users (id, display_name, email, role, office_id, is_active) VALUES
      ('${PM}',            'Adam Sherwood', 'pm@example.com',      'construction', '${OFFICE}', true),
      ('${SUPER}',         'Steve Sanchez', 'super@example.com',   'construction', '${OFFICE}', true),
      ('${RETIRED_SUPER}', 'Gone Fishing',  'retired@example.com', 'construction', '${OFFICE}', false);
    INSERT INTO public.pipeline_stage_config (id, slug) VALUES ('${WON_STAGE}', 'won');
    INSERT INTO office_dallas.deals (id, name, deal_number, stage_id, project_number) VALUES
      ('${DEAL}',       '4123 Cedar Springs', 'DFW-10432', '${WON_STAGE}', 'DFW-10432'),
      ('${OTHER_DEAL}', 'Katy Freeway Shops', 'DFW-10433', '${WON_STAGE}', 'DFW-10433');
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM office_dallas.weekly_report_reminders_sent;
    DELETE FROM office_dallas.weekly_report_dismissals;
    DELETE FROM office_dallas.weekly_reports;
    DELETE FROM office_dallas.weekly_report_projects;
    DELETE FROM office_dallas.weekly_report_settings;
  `);
  await pg.query(
    `INSERT INTO office_dallas.weekly_report_projects
       (id, deal_id, property_display_name, client_name, trock_pm_user_id, trock_super_user_id,
        cadence_weekday, cadence_start_date, status, is_active)
     VALUES ($1::uuid, $2::uuid, '4123 Cedar Springs', 'Mack Real Estate Group', $3::uuid, $4::uuid,
             ${THURSDAY}, '2026-07-27', 'active', true)`,
    [PROJECT, DEAL, PM, SUPER],
  );
});

describe("cadence scheduling helpers", () => {
  it("maps lead days to reminder kinds out of the shared offset table", () => {
    expect(reminderKindForLeadDays(2)).toBe("t_minus_2");
    expect(reminderKindForLeadDays(1)).toBe("t_minus_1");
    expect(reminderKindForLeadDays(0)).toBe("due_digest");
    expect(reminderKindForLeadDays(3)).toBeNull();
    expect(reminderKindForLeadDays(-1)).toBeNull();
  });

  it("resolves the business day, not the container's UTC day — in CDT and in CST", () => {
    // CDT (UTC-5): 03:30 UTC on the 14th is 22:30 CT on the 13th. Reading the instant's UTC date would
    // schedule a day early for every evening run.
    expect(businessCalendarDay(new Date("2026-08-14T03:30:00Z"))).toBe("2026-08-13");
    expect(businessCalendarDay(new Date("2026-08-14T05:00:00Z"))).toBe("2026-08-14");
    // CST (UTC-6): the boundary moves an hour. A helper that hardcoded the summer offset would put every
    // January run between 05:00 and 06:00 UTC on the wrong cadence day.
    expect(businessCalendarDay(new Date("2026-01-15T05:30:00Z"))).toBe("2026-01-14");
    expect(businessCalendarDay(new Date("2026-01-15T06:00:00Z"))).toBe("2026-01-15");
  });

  it("formats a due date as a calendar day regardless of the runner's timezone", () => {
    expect(formatDueDay("2026-08-13")).toBe("Thursday, Aug 13");
    expect(formatDueDay("2026-01-01")).toBe("Thursday, Jan 1");
  });
});

describe("email links", () => {
  it("gates the deep link behind an explicit flag, defaulting OFF", () => {
    // The mobile `reports/` route does not exist yet, and mobile/src/wearables/pairing-callback.ts uses a
    // DENY-list (APP_OWN_ROUTES = accept-invite, scorecards) — so an unrecognised trockcam:// link is
    // retained as a possible Meta pairing callback and evicts a real held one. Off until both land.
    expect(weeklyReportAppDeepLinksEnabled({})).toBe(false);
    expect(weeklyReportAppDeepLinksEnabled({ WEEKLY_REPORT_APP_DEEP_LINKS: "false" })).toBe(false);
    expect(weeklyReportAppDeepLinksEnabled({ WEEKLY_REPORT_APP_DEEP_LINKS: "1" })).toBe(false);
    expect(weeklyReportAppDeepLinksEnabled({ WEEKLY_REPORT_APP_DEEP_LINKS: " TRUE " })).toBe(true);

    const off = weeklyReportReminderLinks({
      frontendUrl: "https://trockcrm.com",
      officeId: OFFICE,
      weeklyReportProjectId: PROJECT,
      weekOf: DUE,
      appDeepLinksEnabled: false,
    });
    expect(off.appUrl).toBeNull();
    expect(off.webUrl).toContain("/projects/weekly-reports?");
  });

  it("offers the trockcam:// deep link plus an https CRM fallback carrying officeId", () => {
    const links = weeklyReportReminderLinks({
      frontendUrl: "https://trockcrm.com/",
      officeId: OFFICE,
      weeklyReportProjectId: PROJECT,
      weekOf: DUE,
      appDeepLinksEnabled: true,
    });
    expect(links.appUrl).toBe(`trockcam://reports/weekly/${PROJECT}?weekOf=2026-08-13`);
    expect(links.webUrl).toContain("https://trockcrm.com/projects/weekly-reports?");
    // Office context is URL-driven in the CRM; dropping officeId lands the recipient on their home office.
    expect(links.webUrl).toContain(`officeId=${OFFICE}`);
    expect(links.webUrl).toContain(`projectId=${PROJECT}`);
    expect(links.webUrl).toContain("weekOf=2026-08-13");
  });

  it("keeps the dashboard URL usable without an office id", () => {
    expect(weeklyReportDashboardUrl("https://trockcrm.com", null)).toBe(
      "https://trockcrm.com/projects/weekly-reports",
    );
  });
});

describe("buildWeeklyReportReminderEmail", () => {
  const base = {
    projectName: "4123 <Cedar> Springs",
    projectNumber: "DFW-10432",
    clientName: "Mack Real Estate Group",
    weekOf: DUE,
    appUrl: `trockcam://reports/weekly/${PROJECT}?weekOf=2026-08-13`,
    webUrl: "https://trockcrm.com/projects/weekly-reports",
  };

  it("names the due DAY in the t-2 subject", () => {
    const email = buildWeeklyReportReminderEmail({ ...base, kind: "t_minus_2" });
    expect(email.subject).toBe("Weekly report due Thursday, Aug 13: DFW-10432 — 4123 <Cedar> Springs");
    expect(email.text).toContain("due Thursday, Aug 13");
  });

  it("escalates to 'tomorrow' at t-1", () => {
    const email = buildWeeklyReportReminderEmail({ ...base, kind: "t_minus_1" });
    expect(email.subject).toContain("due tomorrow (Thursday, Aug 13)");
    expect(email.text).toContain("has not been submitted yet");
  });

  it("promotes the CRM link to the button when there is no app link — never a footnote", () => {
    const email = buildWeeklyReportReminderEmail({ ...base, kind: "t_minus_2", appUrl: null });
    expect(email.html).not.toContain("trockcam://");
    expect(email.html).not.toContain("Open in T-Rock Cam");
    expect(email.html).toContain("Open the weekly reports board");
    expect(email.html).toContain(base.webUrl);
    expect(email.text).toContain(base.webUrl);
    // ...and it names where the work actually happens. The recipients are the assigned super and PM,
    // usually `construction` / `field_contractor` accounts — roles /projects/weekly-reports refuses,
    // and a field_contractor cannot sign into the web app at all. Without this the only instruction in
    // the email is a destination most of them bounce off.
    expect(email.html).toContain("T-Rock Cam");
    expect(email.text).toContain("Write it in T-Rock Cam on your phone");
    expect(email.text).toContain("needs CRM access");
  });

  it("carries both links and escapes the project name", () => {
    const email = buildWeeklyReportReminderEmail({ ...base, kind: "t_minus_2" });
    expect(email.html).toContain(base.appUrl);
    expect(email.html).toContain(base.webUrl);
    expect(email.text).toContain(base.appUrl);
    expect(email.text).toContain(base.webUrl);
    expect(email.html).toContain("4123 &lt;Cedar&gt; Springs");
    expect(email.html).not.toContain("4123 <Cedar> Springs");
  });
});

describe("buildWeeklyReportLeadershipDigestEmail", () => {
  const entry = (name: string, stateLabel: string) => ({
    projectName: name,
    projectNumber: null,
    superName: "Steve Sanchez",
    pmName: "Adam Sherwood",
    stateLabel,
  });

  it("counts filed vs outstanding in the subject and names both sides", () => {
    const email = buildWeeklyReportLeadershipDigestEmail({
      dueDate: DUE,
      filed: [entry("Cedar Springs", "Pending PM review")],
      outstanding: [entry("Katy Freeway", "Not started"), entry("Preston Hollow", "With super")],
      backlog: [],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
    });
    expect(email.subject).toBe("Weekly reports due Thursday, Aug 13 — 1 filed, 2 outstanding");
    expect(email.html).toContain("Cedar Springs");
    expect(email.html).toContain("Katy Freeway");
    expect(email.html).toContain("Steve Sanchez");
    expect(email.text).toContain("Outstanding (2)");
  });

  it("says so plainly when nothing is outstanding", () => {
    const email = buildWeeklyReportLeadershipDigestEmail({
      dueDate: DUE,
      filed: [entry("Cedar Springs", "Sent")],
      outstanding: [],
      backlog: [],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
    });
    expect(email.html).toContain("Everything due Thursday, Aug 13 has been filed.");
    expect(email.html).toContain("Nothing outstanding.");
  });

  it("lists the earlier-week backlog when there is one, and omits the block when there is not", () => {
    const withBacklog = buildWeeklyReportLeadershipDigestEmail({
      dueDate: DUE,
      filed: [],
      outstanding: [entry("Cedar Springs", "Not started")],
      backlog: [
        { projectName: "Katy Freeway", outstandingWeeks: 3, oldestWeekOf: "2026-07-23", olderOutstandingCount: 2 },
      ],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
    });
    expect(withBacklog.html).toContain("Still outstanding from earlier weeks");
    expect(withBacklog.html).toContain("3 weeks (+2 older) · oldest Thursday, Jul 23");
    expect(withBacklog.text).toContain("Katy Freeway: 3 weeks (+2 older) · oldest Thursday, Jul 23");

    const withoutBacklog = buildWeeklyReportLeadershipDigestEmail({
      dueDate: DUE,
      filed: [],
      outstanding: [entry("Cedar Springs", "Not started")],
      backlog: [],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
    });
    expect(withoutBacklog.html).not.toContain("Still outstanding from earlier weeks");
  });
});

describe("buildBacklog", () => {
  const project = {
    id: PROJECT,
    officeId: OFFICE,
    projectName: "Cedar Springs",
    projectNumber: null,
    clientName: null,
    cadenceWeekday: THURSDAY,
    cadenceStartDate: "2026-07-23",
    cadenceEndDate: null,
    superName: null,
    superEmail: null,
    pmName: null,
    pmEmail: null,
    dueDate: DUE,
  };

  it("excludes the current cadence week so a project cannot be counted twice in one digest", () => {
    const backlog = buildBacklog([project], DUE, new Set(), new Set());
    // Expected weeks are 07-23, 07-30, 08-06, 08-13; the last is the digest's own subject.
    expect(backlog).toEqual([
      { projectName: "Cedar Springs", outstandingWeeks: 3, oldestWeekOf: "2026-07-23", olderOutstandingCount: 0 },
    ]);
  });

  it("drops weeks that were DELIVERED or explicitly dismissed", () => {
    const backlog = buildBacklog(
      [project],
      DUE,
      new Set([`${PROJECT}|2026-07-23`]),
      new Set([`${PROJECT}|2026-07-30`]),
    );
    expect(backlog).toEqual([
      { projectName: "Cedar Springs", outstandingWeeks: 1, oldestWeekOf: "2026-08-06", olderOutstandingCount: 0 },
    ]);
  });

  it("returns nothing when every earlier week is accounted for", () => {
    const backlog = buildBacklog(
      [project],
      DUE,
      new Set([`${PROJECT}|2026-07-23`, `${PROJECT}|2026-07-30`, `${PROJECT}|2026-08-06`]),
      new Set(),
    );
    expect(backlog).toEqual([]);
  });

  it("does not bill a resumed project for the weeks it was paused", async () => {
    // The digest regenerated the cadence without the pause ledger, so a project paused for six weeks
    // came back with six never-owed reports in the backlog — telling leadership to chase work nobody
    // ever asked for, and disagreeing with the board the same email links to.
    const paused = { ...project, cadenceStartDate: "2026-07-23" };
    const backlog = buildBacklog(
      [{ ...paused, pausedIntervals: [{ from: "2026-07-27", to: "2026-08-13" }] }],
      DUE,
      new Set(),
      new Set(),
    );
    // 07-23 was owed before the pause and stays owed; 07-30 and 08-06 fell inside it.
    expect(backlog).toHaveLength(1);
    expect(backlog[0]!.outstandingWeeks).toBe(1);
    expect(backlog[0]!.oldestWeekOf).toBe("2026-07-23");
  });

  it("COUNTS weeks beyond the lookback window instead of dropping them", () => {
    // 30 expected weeks with a 26-week window leaves 4 outside it (one of which is skipped only if it is
    // the current week, which it is not). Dropping them would make the email claim a shorter backlog than
    // the board it links to.
    const long = { ...project, cadenceStartDate: "2026-01-15" };
    const backlog = buildBacklog([long], DUE, new Set(), new Set());
    expect(backlog).toHaveLength(1);
    expect(backlog[0]!.outstandingWeeks).toBe(25); // 26 in-window minus the current week
    expect(backlog[0]!.olderOutstandingCount).toBe(5);
    // The TRUE oldest — the cadence start — not the oldest week that happens to fall inside the
    // window. This previously read 2026-02-19, five weeks later, because oldestWeekOf was assigned
    // only while walking the in-window slice: the digest told leadership the backlog was five weeks
    // younger than it was, in the same line that admitted five older weeks existed.
    expect(backlog[0]!.oldestWeekOf).toBe("2026-01-15");
  });

  it("still names the oldest week when the only outstanding weeks are beyond the window", () => {
    // Recent weeks all filed, old ones not. Requiring an IN-WINDOW outstanding week dropped such a
    // project from the digest entirely — the opposite of what a backlog report is for.
    const long = { ...project, cadenceStartDate: "2026-01-15" };
    const expectedWeeks = weeklyReportExpectedWeeks({
      cadenceWeekday: long.cadenceWeekday,
      cadenceStartDate: long.cadenceStartDate,
      cadenceEndDate: long.cadenceEndDate,
      throughDate: DUE,
    });
    // Deliver everything except the first two weeks.
    const delivered = new Set(expectedWeeks.slice(2).map((weekOf) => `${long.id}|${weekOf}`));

    const backlog = buildBacklog([long], DUE, delivered, new Set());
    expect(backlog).toHaveLength(1);
    expect(backlog[0]!.outstandingWeeks).toBe(0);
    expect(backlog[0]!.olderOutstandingCount).toBe(2);
    expect(backlog[0]!.oldestWeekOf).toBe("2026-01-15");
  });

  it("sorts worst-first by total outstanding, in-window plus older", () => {
    const long = { ...project, id: OTHER_PROJECT, projectName: "Katy Freeway", cadenceStartDate: "2026-01-15" };
    const backlog = buildBacklog([project, long], DUE, new Set(), new Set());
    expect(backlog.map((entry) => entry.projectName)).toEqual(["Katy Freeway", "Cedar Springs"]);
  });
});

describe("t-2 heads-up", () => {
  it("emails the super and the PM two days before the cadence due date", async () => {
    const { sent, summary } = await run(T_MINUS_2);
    expect(summary.tMinus2Sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.sort()).toEqual(["pm@example.com", "super@example.com"]);
    expect(sent[0]!.subject).toContain("due Thursday, Aug 13");
    expect(await reminderLedger()).toEqual([
      { weekly_report_project_id: PROJECT, week_of: DUE, kind: "t_minus_2" },
    ]);
  });

  it("ships the CRM link only when the deep-link flag is unset — the production default", async () => {
    const { sent } = await run(T_MINUS_2, { env: { FRONTEND_URL: "https://trockcrm.com" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).not.toContain("trockcam://");
    expect(sent[0]!.text).not.toContain("trockcam://");
    expect(sent[0]!.html).toContain("https://trockcrm.com/projects/weekly-reports?");
  });

  it("sends nothing on a day that is neither t-2, t-1 nor the due date", async () => {
    const { sent, summary } = await run("2026-08-10"); // Monday, three days out
    expect(sent).toHaveLength(0);
    expect(summary.tMinus2Sent + summary.tMinus1Sent + summary.digestsSent).toBe(0);
    expect(await reminderLedger()).toEqual([]);
  });

  it("does not chase a project whose cadence has ended", async () => {
    await pg.query(`UPDATE office_dallas.weekly_report_projects SET cadence_end_date = '2026-08-06'`);
    const { sent } = await run(T_MINUS_2);
    expect(sent).toHaveLength(0);
  });

  it("does not chase a paused project", async () => {
    await pg.query(`UPDATE office_dallas.weekly_report_projects SET status = 'paused'`);
    const { sent } = await run(T_MINUS_2);
    expect(sent).toHaveLength(0);
  });

  it("skips a deactivated user's address rather than emailing a departed super", async () => {
    await pg.query(`UPDATE office_dallas.weekly_report_projects SET trock_super_user_id = $1::uuid`, [
      RETIRED_SUPER,
    ]);
    const { sent } = await run(T_MINUS_2);
    expect(sent[0]!.to).toEqual(["pm@example.com"]);
  });

  it("emails one person once when they are both the super and the PM", async () => {
    await pg.query(`UPDATE office_dallas.weekly_report_projects SET trock_pm_user_id = trock_super_user_id`);
    const { sent } = await run(T_MINUS_2);
    expect(sent[0]!.to).toEqual(["super@example.com"]);
  });

  it("claims nothing when neither super nor PM is deliverable, so a later assignment still gets chased", async () => {
    await pg.query(
      `UPDATE office_dallas.weekly_report_projects SET trock_super_user_id = NULL, trock_pm_user_id = NULL`,
    );
    const first = await run(T_MINUS_2);
    expect(first.sent).toHaveLength(0);
    expect(first.summary.skipped).toBe(1);
    expect(await reminderLedger()).toEqual([]);

    await pg.query(`UPDATE office_dallas.weekly_report_projects SET trock_super_user_id = $1::uuid`, [SUPER]);
    const second = await run(T_MINUS_2);
    expect(second.sent).toHaveLength(1);
  });
});

describe("idempotency", () => {
  it("never re-sends across a simulated worker restart inside the 07:00 window", async () => {
    const first = await run(T_MINUS_2);
    expect(first.sent).toHaveLength(1);

    // Same calendar day, fresh process: the ledger row written by the first run is the only thing that
    // stops the whole office being emailed twice.
    const second = await run(T_MINUS_2);
    expect(second.sent).toHaveLength(0);
    expect(second.summary.tMinus2Sent).toBe(0);
    expect(await reminderLedger()).toHaveLength(1);
  });

  it("releases the claim when the provider rejects the send, so the next tick retries", async () => {
    const failed = await run(T_MINUS_2, { fail: true });
    expect(failed.sent).toHaveLength(1);
    expect(failed.summary.failed).toBe(1);
    expect(await reminderLedger()).toEqual([]);

    const retried = await run(T_MINUS_2);
    expect(retried.sent).toHaveLength(1);
    expect(await reminderLedger()).toHaveLength(1);
  });

  it("scopes the provider idempotency key to the project, week and kind", async () => {
    const { sent } = await run(T_MINUS_2);
    expect(sent[0]!.idempotencyKey).toBe(
      `weekly-report-reminder-office_dallas-${PROJECT}-${DUE}-t_minus_2`,
    );
  });

  it("keeps t-2 and t-1 as separate ledger rows for the same week", async () => {
    await run(T_MINUS_2);
    await run(T_MINUS_1);
    expect((await reminderLedger()).map((row) => row.kind)).toEqual(["t_minus_1", "t_minus_2"]);
  });
});

describe("t-1 chase", () => {
  it("emails when the week is still unfiled", async () => {
    const { sent, summary } = await run(T_MINUS_1);
    expect(summary.tMinus1Sent).toBe(1);
    expect(sent[0]!.subject).toContain("due tomorrow");
  });

  it("still emails when the week is only a DRAFT — a draft is not a submission", async () => {
    await seedReport({ status: "draft" });
    const { sent, summary } = await run(T_MINUS_1);
    expect(summary.tMinus1Sent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("is silent — and writes NO ledger row — once the week is submitted", async () => {
    await seedReport({ status: "pending_review" });
    const { sent, summary } = await run(T_MINUS_1);
    expect(sent).toHaveLength(0);
    expect(summary.tMinus1Suppressed).toBe(1);
    // Nothing was delivered, so nothing is recorded: the ledger stays a record of sends, not decisions.
    expect(await reminderLedger()).toEqual([]);
  });

  it("is silent for an approved or already-sent week too", async () => {
    for (const status of ["approved", "sent"]) {
      await pg.query(`DELETE FROM office_dallas.weekly_reports`);
      await seedReport({ status });
      const { sent } = await run(T_MINUS_1);
      expect(sent, `status ${status} should suppress the chase`).toHaveLength(0);
    }
  });

  it("ignores a SUPERSEDED submission even when nothing live replaced it", async () => {
    // The superseding row is deliberately NOT live (a correction that was itself soft-deleted). With a
    // live v2 present, `ORDER BY version DESC` alone would give the same answer and the
    // `superseded_by_id IS NULL` filter would be untested — which is exactly the fixture that passed
    // while the filter was deleted.
    const originalId = U("55551");
    const correctionId = U("55552");
    await seedReport({ id: correctionId, status: "draft", version: 2, isActive: false });
    await seedReport({ id: originalId, status: "sent", version: 1, supersededById: correctionId });
    const { sent } = await run(T_MINUS_1);
    expect(sent).toHaveLength(1);
  });

  it("ignores a soft-deleted report row", async () => {
    await seedReport({ status: "pending_review", isActive: false });
    const { sent } = await run(T_MINUS_1);
    expect(sent).toHaveLength(1);
  });

  it("ignores a report filed against a DIFFERENT week", async () => {
    await seedReport({ status: "sent", weekOf: "2026-08-06" });
    const { sent } = await run(T_MINUS_1);
    expect(sent).toHaveLength(1);
  });
});

describe("due-date leadership digest", () => {
  beforeEach(async () => {
    await setLeadershipRecipients(["takashi@example.com", "shaw@example.com"]);
  });

  it("sends one digest naming who filed and who has not", async () => {
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_projects
         (id, deal_id, property_display_name, trock_super_user_id, cadence_weekday, cadence_start_date)
       VALUES ($1::uuid, $2::uuid, 'Katy Freeway Shops', $3::uuid, ${THURSDAY}, '2026-07-27')`,
      [OTHER_PROJECT, OTHER_DEAL, SUPER],
    );
    await seedReport({ status: "pending_review" });

    const { sent, summary } = await run(DUE);
    expect(summary.digestsSent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["takashi@example.com", "shaw@example.com"]);
    expect(sent[0]!.subject).toBe("Weekly reports due Thursday, Aug 13 — 1 filed, 1 outstanding");
    expect(sent[0]!.text).toContain("4123 Cedar Springs");
    expect(sent[0]!.text).toContain("Katy Freeway Shops");
    expect(sent[0]!.idempotencyKey).toMatch(
      new RegExp(`^weekly-report-digest-office_dallas-${DUE}-[0-9a-f]{16}$`),
    );
  });

  it("prints the week's REAL state, not one label for everything filed", async () => {
    // "Sent" and "Pending PM review" are different facts to a director deciding who to chase; collapsing
    // every filed week into one label makes the digest agree with the board only by coincidence.
    for (const [status, label] of [
      ["pending_review", "Pending PM review"],
      ["approved", "Approved, not sent"],
      ["sent", "Sent"],
      ["draft", "With super"],
    ] as const) {
      await pg.query(`DELETE FROM office_dallas.weekly_reports`);
      await pg.query(`DELETE FROM office_dallas.weekly_report_reminders_sent`);
      await seedReport({ status });
      const { sent } = await run(DUE);
      expect(sent[0]!.text, `status ${status}`).toContain(`(${label})`);
    }
  });

  it("rotates the idempotency key when the covered project set changes", async () => {
    const first = await run(DUE);
    const firstKey = first.sent[0]!.idempotencyKey;
    expect(firstKey.startsWith(`weekly-report-digest-office_dallas-${DUE}-`)).toBe(true);

    // A project that only becomes due after the first digest went out triggers a second one whose
    // subject counts and project list differ. Reusing the day-stable key would hand Resend the same key
    // with a different payload, which sendSystemEmailWithMetadata treats as already-delivered — the run
    // would report success and deliver nothing.
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_projects
         (id, deal_id, property_display_name, trock_super_user_id, cadence_weekday, cadence_start_date)
       VALUES ($1::uuid, $2::uuid, 'Katy Freeway Shops', $3::uuid, ${THURSDAY}, '2026-07-27')`,
      [OTHER_PROJECT, OTHER_DEAL, SUPER],
    );
    const second = await run(DUE);
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]!.idempotencyKey).not.toBe(firstKey);
  });

  it("records due_digest for every project it covered, and re-runs send nothing", async () => {
    await run(DUE);
    expect(await reminderLedger()).toEqual([
      { weekly_report_project_id: PROJECT, week_of: DUE, kind: "due_digest" },
    ]);
    const second = await run(DUE);
    expect(second.sent).toHaveLength(0);
  });

  it("sends nothing and claims nothing when the leadership roster is empty", async () => {
    await setLeadershipRecipients([]);
    const { sent, summary } = await run(DUE);
    expect(sent).toHaveLength(0);
    expect(summary.skipped).toBe(1);
    expect(await reminderLedger()).toEqual([]);
  });

  it("sends nothing when the office has no settings row at all", async () => {
    await pg.query(`DELETE FROM office_dallas.weekly_report_settings`);
    const { sent } = await run(DUE);
    expect(sent).toHaveLength(0);
  });

  it("releases only its OWN claims when the send fails, leaving an earlier run's receipt intact", async () => {
    // A second project already covered by a successful earlier digest. An unscoped rollback would delete
    // its receipt too and re-digest leadership about it on the catch-up tick.
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_projects
         (id, deal_id, property_display_name, trock_super_user_id, cadence_weekday, cadence_start_date)
       VALUES ($1::uuid, $2::uuid, 'Katy Freeway Shops', $3::uuid, ${THURSDAY}, '2026-07-27')`,
      [OTHER_PROJECT, OTHER_DEAL, SUPER],
    );
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_reminders_sent (weekly_report_project_id, week_of, kind)
       VALUES ($1::uuid, $2::date, 'due_digest')`,
      [OTHER_PROJECT, DUE],
    );

    const failed = await run(DUE, { fail: true });
    expect(failed.summary.failed).toBe(1);
    // Only PROJECT's freshly-claimed row is rolled back; OTHER_PROJECT's receipt survives.
    expect(await reminderLedger()).toEqual([
      { weekly_report_project_id: OTHER_PROJECT, week_of: DUE, kind: "due_digest" },
    ]);

    const retried = await run(DUE);
    expect(retried.sent).toHaveLength(1);
  });

  it("counts a dismissed week as accounted for rather than outstanding", async () => {
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_dismissals (weekly_report_project_id, week_of, reason)
       VALUES ($1::uuid, $2::date, 'Owner paused the job')`,
      [PROJECT, DUE],
    );
    const { sent } = await run(DUE);
    expect(sent[0]!.subject).toContain("1 filed, 0 outstanding");
    expect(sent[0]!.text).toContain("Dismissed");
  });

  it("surfaces earlier unfiled weeks as a backlog block", async () => {
    // The cadence starts 2026-07-27, so 07-30 and 08-06 precede the due week.
    await seedReport({ status: "sent", weekOf: "2026-07-30" });
    const { sent } = await run(DUE);
    expect(sent[0]!.text).toContain("1 week · oldest Thursday, Aug 6");
  });

  it("fires no digest on a day nothing is due, even with a roster configured", async () => {
    const { sent } = await run(T_MINUS_1);
    // The t-1 chase goes to the super/PM; leadership is not on it.
    expect(sent.every((email) => !email.to.includes("takashi@example.com"))).toBe(true);
    expect((await reminderLedger()).every((row) => row.kind !== "due_digest")).toBe(true);
  });
});

describe("failure isolation", () => {
  /** A query wrapper that throws once on the per-project reminder claim for `projectId`. */
  function claimFailsOnceFor(projectId: string) {
    let thrown = false;
    return async (text: string, params?: unknown[]) => {
      const isProjectClaim =
        text.includes("INSERT INTO") &&
        text.includes("weekly_report_reminders_sent") &&
        !Array.isArray(params?.[0]);
      if (!thrown && isProjectClaim && params?.[0] === projectId) {
        thrown = true;
        throw new Error("simulated claim failure");
      }
      return query(text, params);
    };
  }

  async function runWith(queryImpl: typeof query, onDate: string) {
    const spy = emailSpy();
    const summary = await runWeeklyReportReminders({
      query: queryImpl,
      sendEmail: spy.sendEmail,
      env: { FRONTEND_URL: "https://trockcrm.com" },
      now: atNoonUtc(onDate),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      acquireLock: async () => async () => {},
    });
    return { ...spy, summary };
  }

  it("still reminds the rest of the office when one project's claim throws", async () => {
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_projects
         (id, deal_id, property_display_name, trock_super_user_id, cadence_weekday, cadence_start_date)
       VALUES ($1::uuid, $2::uuid, 'Katy Freeway Shops', $3::uuid, ${THURSDAY}, '2026-07-27')`,
      [OTHER_PROJECT, OTHER_DEAL, SUPER],
    );

    const { sent, summary } = await runWith(claimFailsOnceFor(PROJECT), T_MINUS_2);
    expect(summary.failed).toBe(1);
    // Unguarded, the throw escapes the per-project loop and the second project is never reminded.
    expect(summary.tMinus2Sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain("Katy Freeway Shops");
  });

  it("still sends the leadership digest when an earlier project's reminder throws", async () => {
    // Saturday cadence: on Thursday this project is at t-2 while the Thursday one is due TODAY, so a
    // single run does both a per-project reminder and the digest.
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_projects
         (id, deal_id, property_display_name, trock_super_user_id, cadence_weekday, cadence_start_date)
       VALUES ($1::uuid, $2::uuid, 'Katy Freeway Shops', $3::uuid, 6, '2026-07-27')`,
      [OTHER_PROJECT, OTHER_DEAL, SUPER],
    );
    await setLeadershipRecipients(["takashi@example.com"]);

    const { sent, summary } = await runWith(claimFailsOnceFor(OTHER_PROJECT), DUE);
    expect(summary.failed).toBe(1);
    expect(summary.tMinus2Sent).toBe(0);
    // The digest is the last thing the office run does — an unguarded throw upstream loses it entirely.
    expect(summary.digestsSent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["takashi@example.com"]);
  });
});

describe("office guards", () => {
  it("skips an office whose schema has not received migration 0222 yet", async () => {
    // Migrations run on the API's boot, not the worker's, so this is the state of every office between a
    // worker deploy and the API applying 0222.
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS office_austin;
      INSERT INTO public.offices (id, name, slug) VALUES ('${U("00002")}', 'Austin', 'austin')
        ON CONFLICT (id) DO NOTHING;
    `);
    try {
      const { summary, sent } = await run(T_MINUS_2);
      expect(summary.offices).toBe(1);
      expect(summary.failed).toBe(0);
      expect(sent).toHaveLength(1);
    } finally {
      await pg.exec(`DELETE FROM public.offices WHERE slug = 'austin'; DROP SCHEMA office_austin CASCADE;`);
    }
  });

  it("skips this tick entirely when another run holds the advisory lock", async () => {
    const spy = emailSpy();
    const summary = await runWeeklyReportReminders({
      query,
      sendEmail: spy.sendEmail,
      env: {},
      now: atNoonUtc(T_MINUS_2),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      acquireLock: async () => null,
    });
    expect(spy.sent).toHaveLength(0);
    expect(summary.offices).toBe(0);
    expect(await reminderLedger()).toEqual([]);
  });
});
