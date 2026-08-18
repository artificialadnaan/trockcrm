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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deals, files, offices, users } from "@trock-crm/shared/schema";
import { weeklyReportExpectedWeeks } from "@trock-crm/shared/types";
import { migrationSql } from "../../../server/tests/helpers/migration-sql.js";
import { tenantSchemaSql } from "../../../server/tests/helpers/tenant-schema-from-drizzle.js";
// Across the workspace boundary on purpose: the worker's lookback constant is a hand-copy of the CRM
// board's, and an assertion is the only thing that can notice the two drifting apart.
import { DEFAULT_OUTSTANDING_LOOKBACK_WEEKS } from "../../../server/src/modules/weekly-reports/dashboard-service.js";
import type { SendSystemEmailOutcome, SendSystemEmailResult } from "../../src/lib/system-email.js";
import {
  acquireReminderAdvisoryLock,
  buildBacklog,
  buildWeeklyReportLeadershipDigestEmail,
  buildWeeklyReportReminderEmail,
  businessCalendarDay,
  formatDueDay,
  reminderKindForLeadDays,
  runWeeklyReportReminders,
  WEEKLY_REPORT_DIGEST_LOOKBACK_WEEKS,
  WEEKLY_REPORT_REMINDER_LOCK_KEY,
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

/**
 * `rejected` and `unknown` are DIFFERENT failures and the job must treat them differently. BOTH are
 * `{success:false}`, which is precisely why the stub has to carry `outcome`.
 *
 * This stub used to offer `throws` for the ambiguous case, on the stated theory that
 * `sendSystemEmailWithMetadata` "lets exceptions through" so a socket timeout propagates. It does not.
 * `resend@6` wraps its entire `fetch` in `try { ... } catch { return { error: { name:
 * "application_error", statusCode: null } } }`, so a socket hang-up, a DNS failure, a 504 and a 409
 * "still in flight" ALL return `{success:false}` — the production stack cannot raise the exception the
 * old stub raised. Every test that "proved" the double-digest protection rode on that, and the protection
 * was in fact unreachable. `real-transport.test.ts` in this directory drives the actual sender with
 * `fetch` stubbed and asserts these shapes, so this stub cannot drift back into fiction.
 *
 * `throws` is kept for the one thing a throw still models — a bug in the send path, not a transport
 * failure — and is used by exactly one test that says so.
 */
function emailSpy(behaviour: { outcome?: SendSystemEmailOutcome; throws?: boolean } = {}) {
  const sent: SentEmail[] = [];
  const sendEmail = async (
    to: string | string[],
    subject: string,
    html: string,
    options: { text: string; idempotencyKey: string },
  ): Promise<SendSystemEmailResult> => {
    sent.push({
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text: options.text,
      idempotencyKey: options.idempotencyKey,
    });
    if (behaviour.throws) throw new Error("send path blew up");
    const outcome = behaviour.outcome ?? "delivered";
    if (outcome === "delivered") return { success: true, messageId: `msg-${sent.length}`, outcome };
    return { success: false, messageId: null, outcome };
  };
  return { sent, sendEmail };
}

/** Captures what the job logged, at the level it logged it — the level IS the operator-facing contract. */
function loggerSpy() {
  const logs = { log: [] as string[], warn: [] as string[], error: [] as string[] };
  const record = (bucket: string[]) => (...args: unknown[]) => {
    bucket.push(String(args[0] ?? ""));
  };
  return { logs, logger: { log: record(logs.log), warn: record(logs.warn), error: record(logs.error) } };
}

async function run(
  onDate: string,
  behaviour: { outcome?: SendSystemEmailOutcome; throws?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  const spy = emailSpy(behaviour);
  const { logs, logger } = loggerSpy();
  const summary = await runWeeklyReportReminders({
    query,
    sendEmail: spy.sendEmail,
    env: behaviour.env ?? { FRONTEND_URL: "https://trockcrm.com", WEEKLY_REPORT_APP_DEEP_LINKS: "true" },
    now: atNoonUtc(onDate),
    logger,
    // The advisory lock needs a real pooled pg connection; the single-flight behaviour is exercised
    // directly against a fake pool below, so the harness grants it here.
    acquireLock: async () => async () => {},
  });
  return { ...spy, summary, logs };
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

/** A stretch in the 0223 pause ledger. Half-open [from, to): the resume day is owed again. */
async function seedPause(input: { projectId?: string; from: string; to?: string | null }) {
  await pg.query(
    `INSERT INTO office_dallas.weekly_report_pauses (weekly_report_project_id, paused_from, resumed_on)
     VALUES ($1::uuid, $2::date, $3::date)`,
    [input.projectId ?? PROJECT, input.from, input.to ?? null],
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
    DELETE FROM office_dallas.weekly_report_pauses;
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
  });

  it("emits NO query parameters the weekly-reports board does not read", () => {
    // client/src/pages/projects/weekly-reports-page.tsx has no useSearchParams, no URLSearchParams and
    // never touches location.search. `projectId` and `weekOf` therefore filtered nothing: the URL
    // promised the recipient their project's row and delivered the whole unfiltered board. A parameter
    // no page consumes is a promise to the reader only — these come back in the change that teaches the
    // board to honour them, not before. `officeId` stays because office context genuinely IS URL-driven.
    const links = weeklyReportReminderLinks({
      frontendUrl: "https://trockcrm.com",
      officeId: OFFICE,
      weeklyReportProjectId: PROJECT,
      weekOf: DUE,
      appDeepLinksEnabled: false,
    });
    expect(links.webUrl).toBe(`https://trockcrm.com/projects/weekly-reports?officeId=${OFFICE}`);
    expect(links.webUrl).not.toContain("projectId=");
    expect(links.webUrl).not.toContain("weekOf=");
    // ...and the deep link, which DOES route by project and week, keeps both.
    const deepLinked = weeklyReportReminderLinks({
      frontendUrl: "https://trockcrm.com",
      officeId: null,
      weeklyReportProjectId: PROJECT,
      weekOf: DUE,
      appDeepLinksEnabled: true,
    });
    expect(deepLinked.appUrl).toContain(`weekly/${PROJECT}?weekOf=2026-08-13`);
    expect(deepLinked.webUrl).toBe("https://trockcrm.com/projects/weekly-reports");
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
  const entry = (
    name: string,
    stateLabel: string,
    overrides: { superReachable?: boolean; pmReachable?: boolean; remindersSent?: number } = {},
  ) => ({
    projectName: name,
    projectNumber: null,
    superName: "Steve Sanchez",
    pmName: "Adam Sherwood",
    stateLabel,
    superReachable: true,
    pmReachable: true,
    // The ordinary case: both nudges went out. Every test that cares about the ledger says so explicitly,
    // because the ledger and reachability are separate facts and the digest must not infer one from the other.
    remindersSent: 2,
    ...overrides,
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
    expect(withBacklog.html).toContain("5 weeks (2 older than the board shows) · oldest Thursday, Jul 23");
    expect(withBacklog.text).toContain(
      "Katy Freeway: 5 weeks (2 older than the board shows) · oldest Thursday, Jul 23",
    );

    const withoutBacklog = buildWeeklyReportLeadershipDigestEmail({
      dueDate: DUE,
      filed: [],
      outstanding: [entry("Cedar Springs", "Not started")],
      backlog: [],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
    });
    expect(withoutBacklog.html).not.toContain("Still outstanding from earlier weeks");
  });

  it("leads a backlog row with the TOTAL, so a project with no in-window weeks does not read as '0 weeks'", () => {
    // The entry gate counts older weeks too, so a project whose recent weeks are all filed and whose
    // older ones are not appears here with outstandingWeeks = 0. Leading with that number rendered
    // "0 weeks (+4 older)" — noise, in the row added for exactly this project.
    const email = buildWeeklyReportLeadershipDigestEmail({
      dueDate: DUE,
      filed: [entry("Cedar Springs", "Sent")],
      outstanding: [],
      backlog: [
        { projectName: "Preston Hollow", outstandingWeeks: 0, oldestWeekOf: "2026-01-15", olderOutstandingCount: 4 },
      ],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
    });
    expect(email.html).not.toContain("0 week");
    // ...and "4 weeks (4 older)" would be its own kind of noise, so the whole-backlog case says so.
    expect(email.text).toContain("Preston Hollow: 4 weeks (all older than the board shows) · oldest Thursday, Jan 15");
    // Singular still reads correctly at a total of one.
    const single = buildWeeklyReportLeadershipDigestEmail({
      dueDate: DUE,
      filed: [],
      outstanding: [],
      backlog: [
        { projectName: "Preston Hollow", outstandingWeeks: 1, oldestWeekOf: "2026-08-06", olderOutstandingCount: 0 },
      ],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
    });
    expect(single.text).toContain("1 week · oldest Thursday, Aug 6");
  });

  it("puts the backlog in the SUBJECT — an all-filed cohort must not read as all clear", () => {
    // The normal shape of this email once the feature beds in: everything due today is filed, while a
    // job that stopped delivering in May sits below. Subject and preheader that report only the
    // due-today cohort tell a director triaging on a phone there is nothing to do.
    const email = buildWeeklyReportLeadershipDigestEmail({
      dueDate: DUE,
      filed: [entry("Cedar Springs", "Sent"), entry("Katy Freeway", "Sent")],
      outstanding: [],
      backlog: [
        { projectName: "Preston Hollow", outstandingWeeks: 11, oldestWeekOf: "2026-05-28", olderOutstandingCount: 0 },
      ],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
    });
    expect(email.subject).toBe(
      "Weekly reports due Thursday, Aug 13 — 2 filed, 0 outstanding, 11 weeks behind on 1 project",
    );
    expect(email.html).toContain("Everything due Thursday, Aug 13 has been filed. Earlier weeks: 11 weeks behind on 1 project.");

    const twoProjects = buildWeeklyReportLeadershipDigestEmail({
      dueDate: DUE,
      filed: [],
      outstanding: [entry("Cedar Springs", "Not started")],
      backlog: [
        { projectName: "Preston Hollow", outstandingWeeks: 3, oldestWeekOf: "2026-05-28", olderOutstandingCount: 1 },
        { projectName: "Katy Freeway", outstandingWeeks: 1, oldestWeekOf: "2026-08-06", olderOutstandingCount: 0 },
      ],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
    });
    expect(twoProjects.subject).toContain("0 filed, 1 outstanding, 5 weeks behind on 2 projects");
    expect(twoProjects.text).toContain("are still outstanding. Earlier weeks: 5 weeks behind on 2 projects.");
  });

  it("marks an outstanding project nobody was ever reminded about", () => {
    // Nothing in the ledger and nobody reachable — a departed super whose account was deactivated, and no
    // PM. The job warned, counted a skip and sent nothing, so listing the project as ordinary Outstanding
    // beside the departed name tells leadership to chase somebody who was never asked, every week, forever.
    const email = buildWeeklyReportLeadershipDigestEmail({
      dueDate: DUE,
      filed: [],
      outstanding: [
        {
          projectName: "Preston Hollow",
          projectNumber: null,
          superName: "Gone Fishing",
          pmName: null,
          stateLabel: "Not started",
          superReachable: false,
          pmReachable: false,
          remindersSent: 0,
        },
        entry("Cedar Springs", "Not started"),
      ],
      backlog: [],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
    });
    expect(email.html).toContain("Outstanding — 1 never reminded");
    expect(email.html).toContain("Super: Gone Fishing (unreachable) · PM: unassigned");
    expect(email.html).toContain(
      "No reminder was sent for this week — and with no reachable super or PM email, none can be sent now either.",
    );
    expect(email.text).toContain("Outstanding (2, 1 never reminded)");
    // The project that WAS reminded carries neither the annotation nor the note.
    expect(email.html).toContain("Super: Steve Sanchez · PM: Adam Sherwood");
    expect(email.text.match(/No reminder was sent/g)).toHaveLength(1);
  });

  it("says a reminder went out, and only that the NEXT one cannot, when the ledger and reachability disagree", () => {
    // The ledger is the record of what was delivered; reachability is evaluated at digest time and predicts
    // only the next send. Two projects, opposite directions, and reading either fact off the other prints a
    // falsehood: a super assigned this morning is reachable and was never emailed, and a super deactivated
    // last night received both nudges.
    const email = buildWeeklyReportLeadershipDigestEmail({
      dueDate: DUE,
      filed: [],
      outstanding: [
        // Reachable now, never chased — assigned after both nudges had already skipped the project.
        entry("Cedar Springs", "Not started", { remindersSent: 0 }),
        // Chased twice, unreachable now — the super left on Wednesday night.
        entry("Katy Freeway", "Not started", {
          superReachable: false,
          pmReachable: false,
          remindersSent: 2,
        }),
      ],
      backlog: [],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
    });
    // Exactly ONE project was never reminded, and it is the reachable one.
    expect(email.html).toContain("Outstanding — 1 never reminded");
    expect(email.text).toContain("Outstanding (2, 1 never reminded)");
    expect(email.text).toContain(
      "  - Cedar Springs (Not started) — Super: Steve Sanchez, PM: Adam Sherwood\n" +
        "      No reminder was sent for this week.",
    );
    // The chased-then-departed project must NOT be told it was never emailed. "logged", not "sent": the
    // row it comes from is a claim, taken BEFORE the send — see the claim-vs-delivery suite.
    expect(email.text).toContain(
      "2 reminders were logged for this week, but there is no reachable super or PM email now.",
    );
    expect(email.text.match(/No reminder was sent/g)).toHaveLength(1);
    // Singular reads correctly when only the t-2 landed.
    const one = buildWeeklyReportLeadershipDigestEmail({
      dueDate: DUE,
      filed: [],
      outstanding: [
        entry("Katy Freeway", "Not started", { superReachable: false, pmReachable: false, remindersSent: 1 }),
      ],
      backlog: [],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
    });
    expect(one.text).toContain("1 reminder was logged for this week, but there is no reachable super or PM email now.");
    expect(one.html).not.toContain("never reminded");
    // The zero case keeps the flat past-tense claim, and deliberately so: an ABSENT row proves nothing was
    // attempted, while a PRESENT one proves only that the slot was taken. The asymmetry is the point.
    expect(email.text).toContain("No reminder was sent for this week.");
  });

  it("counts dismissed weeks apart from filed ones in the subject and the preheader", () => {
    // A dismissed week is a decision not to file, not a report. Folding it into `filed` told a director
    // reading only the subject that reports exist when none do.
    const allDismissed = buildWeeklyReportLeadershipDigestEmail({
      dueDate: DUE,
      filed: [],
      outstanding: [],
      dismissed: [entry("Cedar Springs", "Dismissed")],
      backlog: [],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
    });
    expect(allDismissed.subject).toBe("Weekly reports due Thursday, Aug 13 — 0 filed, 0 outstanding, 1 dismissed");
    expect(allDismissed.html).toContain("Nothing due Thursday, Aug 13 is outstanding: 0 filed, 1 dismissed.");
    expect(allDismissed.html).not.toContain("has been filed");
    // Placement is unchanged: the row still sits in the Filed section, under a heading that says what it is.
    expect(allDismissed.html).toContain("Filed — 1 dismissed, not filed");
    expect(allDismissed.text).toContain("Filed (0, plus 1 dismissed):\n  - Cedar Springs (Dismissed)");

    const mixed = buildWeeklyReportLeadershipDigestEmail({
      dueDate: DUE,
      filed: [entry("Preston Hollow", "Sent")],
      outstanding: [entry("Katy Freeway", "Not started")],
      dismissed: [entry("Cedar Springs", "Dismissed")],
      backlog: [],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
    });
    expect(mixed.subject).toBe("Weekly reports due Thursday, Aug 13 — 1 filed, 1 outstanding, 1 dismissed");
    // "1 of 3", so the three rows below add up — with the dismissed one named rather than counted as filed.
    expect(mixed.text).toContain("1 of 3 reports due Thursday, Aug 13 are still outstanding, 1 dismissed.");
  });

  it("does not flag reachability or the ledger on FILED projects — nobody is being chased there", () => {
    const email = buildWeeklyReportLeadershipDigestEmail({
      dueDate: DUE,
      filed: [entry("Cedar Springs", "Sent", { superReachable: false, pmReachable: false, remindersSent: 0 })],
      outstanding: [],
      backlog: [],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
    });
    expect(email.html).not.toContain("never reminded");
    expect(email.html).not.toContain("No reminder was sent");
    expect(email.html).not.toContain("(unreachable)");
    expect(email.html).toContain("Super: Steve Sanchez · PM: Adam Sherwood");
  });

  it("says it is an UPDATE when a second digest re-lists the first one's projects", () => {
    const email = buildWeeklyReportLeadershipDigestEmail({
      dueDate: DUE,
      filed: [entry("Cedar Springs", "Sent")],
      outstanding: [entry("Katy Freeway", "Not started"), entry("Preston Hollow", "Not started")],
      backlog: [],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
      followUpForProjects: ["Katy Freeway", "Preston Hollow"],
    });
    expect(email.subject).toBe("Update — Weekly reports due Thursday, Aug 13 — 1 filed, 2 outstanding");
    expect(email.html).toContain("This updates the digest sent earlier today");
    expect(email.html).toContain("Katy Freeway and Preston Hollow became due after it went out");
    expect(email.text.startsWith("This updates the digest sent earlier today")).toBe(true);
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
    pausedIntervals: null,
    superName: null,
    superEmail: null,
    pmName: null,
    pmEmail: null,
    dueDate: DUE,
  };

  it("uses the SAME lookback the CRM board cuts on", () => {
    // A hand-copied literal, because dashboard-service.ts lives in server/ and the worker cannot import
    // it at runtime. Nothing else notices when one of the two moves, and the symptom would be an email
    // whose backlog silently disagrees with the board it links to — for months, in one direction only.
    expect(WEEKLY_REPORT_DIGEST_LOOKBACK_WEEKS).toBe(DEFAULT_OUTSTANDING_LOOKBACK_WEEKS);
  });

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
    const failed = await run(T_MINUS_2, { outcome: "rejected" });
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
    // Both projects also owe 07-30 and 08-06, so the subject carries the backlog as well as the cohort.
    expect(sent[0]!.subject).toBe(
      "Weekly reports due Thursday, Aug 13 — 1 filed, 1 outstanding, 4 weeks behind on 2 projects",
    );
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

  it("sends nothing and claims nothing when the leadership roster is empty — and WARNS about it", async () => {
    await setLeadershipRecipients([]);
    const { sent, summary, logs } = await run(DUE);
    expect(sent).toHaveLength(0);
    expect(summary.skipped).toBe(1);
    expect(await reminderLedger()).toEqual([]);
    // `leadership_recipient_emails` defaults to '{}', so this is the state of every freshly migrated
    // office and it means the whole leadership half of the feature is inert. At INFO that is
    // indistinguishable from the run's routine chatter; the reminder side's no-recipient path warns.
    expect(logs.warn.some((line) => line.includes("No leadership recipients configured"))).toBe(true);
    expect(logs.log.some((line) => line.includes("No leadership recipients configured"))).toBe(false);
  });

  it("keeps the SAME idempotency key when a failed digest is retried", async () => {
    // The key is what stops a double send when the failure was at the transport layer AFTER Resend
    // accepted the message: the catch-up tick re-sends, and only a key that hashes the same cohort makes
    // the provider recognise it. A key that rotated per attempt — random bytes, a timestamp — would pass
    // every other test in this file and put two copies of the digest in front of leadership.
    const failed = await run(DUE, { outcome: "rejected" });
    const retried = await run(DUE);
    expect(failed.sent).toHaveLength(1);
    expect(retried.sent).toHaveLength(1);
    expect(retried.sent[0]!.idempotencyKey).toBe(failed.sent[0]!.idempotencyKey);
  });

  it("marks an outstanding project the job could not notify at all", async () => {
    // A departed super (deactivated account, so the address is nulled) and no PM. The reminder path
    // warns and skips; the digest used to list the project as ordinary Outstanding under the departed
    // name, so leadership chased somebody who was never asked — every week, with nothing saying why.
    await pg.query(
      `UPDATE office_dallas.weekly_report_projects
          SET trock_super_user_id = $1::uuid, trock_pm_user_id = NULL`,
      [RETIRED_SUPER],
    );

    const headsUp = await run(T_MINUS_2);
    expect(headsUp.sent).toHaveLength(0);
    expect(headsUp.summary.skipped).toBe(1);
    // Nothing sent, so nothing recorded — which is what the digest reads.
    expect(await reminderLedger()).toEqual([]);

    const { sent } = await run(DUE);
    expect(sent[0]!.subject).toContain("0 filed, 1 outstanding");
    expect(sent[0]!.html).toContain("Outstanding — 1 never reminded");
    expect(sent[0]!.text).toContain("Super: Gone Fishing (unreachable)");
    expect(sent[0]!.text).toContain(
      "No reminder was sent for this week — and with no reachable super or PM email, none can be sent now either.",
    );
  });

  it("says NO REMINDER WAS SENT for a project whose super was assigned after both nudges had skipped it", async () => {
    // The common setup pattern: a project is created without a super and gets one later in the week. The
    // digest used to decide "was anybody reminded" from reachability AT DIGEST TIME, so this project — a
    // fresh, valid address by Thursday morning — printed as ordinary Outstanding beside a name that had
    // never been emailed. The ledger is the record of what was sent, and it is empty here.
    await pg.query(
      `UPDATE office_dallas.weekly_report_projects
          SET trock_super_user_id = NULL, trock_pm_user_id = NULL`,
    );

    const tMinus2 = await run(T_MINUS_2);
    expect(tMinus2.sent).toHaveLength(0);
    expect(tMinus2.summary.skipped).toBe(1);
    const tMinus1 = await run(T_MINUS_1);
    expect(tMinus1.sent).toHaveLength(0);
    expect(tMinus1.summary.skipped).toBe(1);
    expect(await reminderLedger()).toEqual([]);

    // Thursday morning: a super is assigned, hours before the digest.
    await pg.query(`UPDATE office_dallas.weekly_report_projects SET trock_super_user_id = $1::uuid`, [SUPER]);

    const { sent } = await run(DUE);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain("Outstanding — 1 never reminded");
    expect(sent[0]!.text).toContain(
      "  - DFW-10432 — 4123 Cedar Springs (Not started) — Super: Steve Sanchez, PM: unassigned\n" +
        "      No reminder was sent for this week.",
    );
    // Steve IS reachable — the next reminder can land. The note is about the past, and says only that.
    expect(sent[0]!.text).not.toContain("(unreachable)");
  });

  it("does NOT claim a reminder was never sent when two were delivered before the super left", async () => {
    // The mirror image. Both nudges are delivered on Tuesday and Wednesday; the super is deactivated on
    // Wednesday night. Reading the past off present reachability printed "No reminder was sent" over two
    // emails that leadership can see in the super's inbox.
    await pg.query(`UPDATE office_dallas.weekly_report_projects SET trock_pm_user_id = NULL`);
    expect((await run(T_MINUS_2)).summary.tMinus2Sent).toBe(1);
    expect((await run(T_MINUS_1)).summary.tMinus1Sent).toBe(1);

    await pg.query(`UPDATE public.users SET is_active = false WHERE id = $1::uuid`, [SUPER]);
    try {
      const { sent } = await run(DUE);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).not.toContain("No reminder was sent");
      expect(sent[0]!.html).not.toContain("never reminded");
      // Both facts, each said as itself: two reminders went out, and the next one cannot. "logged", not
      // "sent", because the ledger row is a CLAIM — see the claim-vs-delivery tests below.
      expect(sent[0]!.text).toContain(
        "2 reminders were logged for this week, but there is no reachable super or PM email now.",
      );
      expect(sent[0]!.text).toContain("Super: Steve Sanchez (unreachable)");
    } finally {
      await pg.query(`UPDATE public.users SET is_active = true WHERE id = $1::uuid`, [SUPER]);
    }
  });

  it("labels the SECOND digest of a day as an update, not a near-identical repeat", async () => {
    const first = await run(DUE);
    expect(first.sent[0]!.subject.startsWith("Update")).toBe(false);

    // A project that becomes due today between ticks — a setup created this morning, a cadence weekday
    // changed, a project un-paused. It claims its own row and triggers a second, FULL digest.
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_projects
         (id, deal_id, property_display_name, trock_super_user_id, cadence_weekday, cadence_start_date)
       VALUES ($1::uuid, $2::uuid, 'Katy Freeway Shops', $3::uuid, ${THURSDAY}, '2026-07-27')`,
      [OTHER_PROJECT, OTHER_DEAL, SUPER],
    );
    const second = await run(DUE);
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]!.subject).toContain("Update — Weekly reports due Thursday, Aug 13");
    expect(second.sent[0]!.text).toContain("Katy Freeway Shops became due after it went out");
    // It re-lists the first email's project, which is exactly why it has to say what it is.
    expect(second.sent[0]!.text).toContain("4123 Cedar Springs");
  });

  it("claims the digest LAST, with nothing between the claim and the send", async () => {
    // The claim must sit before the send (that is what stops a restart double-emailing), so everything
    // that can throw — the filed/outstanding split, buildBacklog over EVERY active project, the render —
    // has to sit before the claim. A throw in that window is swallowed by `guarded`, leaves the claims
    // in place, and the 09:00/11:00 catch-up ticks then find the day already digested: no email, no
    // retry, and a ledger row asserting a send that never happened. This pins the ordering.
    const timeline: string[] = [];
    const spy = emailSpy();
    const summary = await runWeeklyReportReminders({
      query: async (text: string, params?: unknown[]) => {
        timeline.push(text);
        return query(text, params);
      },
      sendEmail: async (to, subject, html, options) => {
        timeline.push("SEND");
        return spy.sendEmail(to, subject, html, options);
      },
      env: { FRONTEND_URL: "https://trockcrm.com" },
      now: atNoonUtc(DUE),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      acquireLock: async () => async () => {},
    });
    expect(summary.digestsSent).toBe(1);
    const sendIndex = timeline.indexOf("SEND");
    expect(sendIndex).toBeGreaterThan(0);
    const lastBeforeSend = timeline[sendIndex - 1]!;
    expect(lastBeforeSend).toContain("INSERT INTO office_dallas.weekly_report_reminders_sent");
    expect(lastBeforeSend).toContain("due_digest");
  });

  it("reads the pause ledger from the DATABASE, not just from a hand-built interval", async () => {
    // The cadence's earlier weeks are 07-30 and 08-06; a pause covering both must reach buildBacklog
    // through `weekly_report_pauses`. Without the DB read the digest bills a resumed project for weeks
    // nobody ever owed and contradicts the board it links to.
    await seedPause({ from: "2026-07-28", to: "2026-08-10" });
    const { sent } = await run(DUE);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).not.toContain("Still outstanding from earlier weeks");
    expect(sent[0]!.subject).toBe("Weekly reports due Thursday, Aug 13 — 0 filed, 1 outstanding");
  });

  it("owes nothing at all for a current week that fell inside a pause", async () => {
    // [from, to) covers the due week itself, so the cadence never expects it: no digest, no t-2, and no
    // ledger row. This is the suppression at the dueDate assignment, which no test reached before.
    await seedPause({ from: "2026-08-11", to: "2026-08-14" });
    const onDue = await run(DUE);
    expect(onDue.sent).toHaveLength(0);
    expect(onDue.summary.digestsSent).toBe(0);
    const headsUp = await run(T_MINUS_2);
    expect(headsUp.sent).toHaveLength(0);
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

    const failed = await run(DUE, { outcome: "rejected" });
    expect(failed.summary.failed).toBe(1);
    // Only PROJECT's freshly-claimed row is rolled back; OTHER_PROJECT's receipt survives.
    expect(await reminderLedger()).toEqual([
      { weekly_report_project_id: OTHER_PROJECT, week_of: DUE, kind: "due_digest" },
    ]);

    const retried = await run(DUE);
    expect(retried.sent).toHaveLength(1);
  });

  it("reports a dismissed week as dismissed, not as a report that was filed", async () => {
    // Dismissing the due week and both earlier ones leaves an office where NOT ONE report exists. The
    // subject used to read "1 filed, 0 outstanding" and the preheader "Everything due Thursday, Aug 13 has
    // been filed" — the same defect the backlog clause already fixed, on the same argument: a director
    // triaging on a phone reads the subject and the preheader and stops.
    for (const weekOf of [DUE, "2026-08-06", "2026-07-30"]) {
      await pg.query(
        `INSERT INTO office_dallas.weekly_report_dismissals (weekly_report_project_id, week_of, reason)
         VALUES ($1::uuid, $2::date, 'Owner paused the job')`,
        [PROJECT, weekOf],
      );
    }
    const { sent } = await run(DUE);
    expect(sent[0]!.subject).toBe("Weekly reports due Thursday, Aug 13 — 0 filed, 0 outstanding, 1 dismissed");
    expect(sent[0]!.html).toContain("Nothing due Thursday, Aug 13 is outstanding: 0 filed, 1 dismissed.");
    expect(sent[0]!.html).not.toContain("has been filed");

    // Placement is deliberately UNCHANGED: a dismissed week is not chaseable, so it stays out of
    // Outstanding, where it would inflate a count nobody can act on. Only the counting changed.
    const text = sent[0]!.text;
    expect(text).toContain("Filed (0, plus 1 dismissed):");
    expect(text).toContain("(Dismissed)");
    expect(text.indexOf("(Dismissed)")).toBeGreaterThan(text.indexOf("Filed (0, plus 1 dismissed):"));
    expect(text.indexOf("(Dismissed)")).toBeLessThan(text.indexOf("Outstanding (0):"));
  });

  it("does not send a second, unlabelled digest after a send whose outcome is unknown", async () => {
    // 07:00. The send comes back `{success:false, outcome:"unknown"}` — the REAL shape of a socket
    // hang-up, a 504 or a 409 "still in flight", every one of which resend@6 swallows into an ordinary
    // error result rather than an exception (see real-transport.test.ts). Resend may have accepted and
    // delivered the digest before the connection died. Releasing the claims here (the old behaviour) is
    // what turns one ambiguous send into two unlabelled digests: the rollback empties the very ledger
    // `alreadyDigested` is read from.
    //
    // This test previously drove a THROWN error, which the production transport cannot produce — so it
    // passed against a guard no real failure could ever reach.
    const first = await run(DUE, { outcome: "unknown" });
    expect(first.sent).toHaveLength(1);
    expect(first.summary.digestsSent).toBe(0);
    expect(first.summary.failed).toBe(1);
    // Claims KEPT — an unknown outcome is treated as delivered, and the log says so in those terms.
    expect(await reminderLedger()).toEqual([
      { weekly_report_project_id: PROJECT, week_of: DUE, kind: "due_digest" },
    ]);
    expect(first.logs.error.some((line) => line.includes("outcome UNKNOWN"))).toBe(true);

    // 09:00. A second project becomes due, so the cohort — and therefore the idempotency key — changes.
    // Resend cannot dedup a key it has never seen, so the ONLY thing that can stop leadership reading this
    // as an independent second report is the subject.
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_projects
         (id, deal_id, property_display_name, trock_super_user_id, cadence_weekday, cadence_start_date)
       VALUES ($1::uuid, $2::uuid, 'Katy Freeway Shops', $3::uuid, ${THURSDAY}, '2026-07-27')`,
      [OTHER_PROJECT, OTHER_DEAL, SUPER],
    );
    const second = await run(DUE);
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]!.idempotencyKey).not.toBe(first.sent[0]!.idempotencyKey);
    expect(second.sent[0]!.subject.startsWith("Update — Weekly reports due Thursday, Aug 13")).toBe(true);
    expect(second.sent[0]!.text.startsWith("This updates the digest sent earlier today")).toBe(true);
    // Still a FULL digest, so nothing is lost if the first email never arrived.
    expect(second.sent[0]!.text).toContain("4123 Cedar Springs");
    expect(second.sent[0]!.text).toContain("Katy Freeway Shops");
  });

  it("does not re-send at all after an unknown outcome when the cohort has not changed", async () => {
    // The deliberate cost of treating "accepted, then the connection died" as delivered: if the message
    // really was lost, the day's digest is lost with it. That is logged and counted (`summary.failed`),
    // and it is the trade the alternative cannot make — a blind retry cannot be labelled as a repeat,
    // because at 09:00 nothing distinguishes a lost send from a delivered one.
    const first = await run(DUE, { outcome: "unknown" });
    expect(first.summary.failed).toBe(1);

    const second = await run(DUE);
    expect(second.sent).toHaveLength(0);
    expect(second.summary.digestsSent).toBe(0);
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

  it("treats a REJECTED digest differently from an UNKNOWN one — one retries, the other does not", async () => {
    // The whole point of widening the transport. Both are `{success:false}`; only the outcome separates
    // "the address was malformed, nothing exists, re-send it" from "the socket died, leadership may
    // already have this". Collapsing them means choosing which bug to ship.
    const rejected = await run(DUE, { outcome: "rejected" });
    expect(rejected.summary.failed).toBe(1);
    expect(await reminderLedger()).toEqual([]); // rolled back — a catch-up tick will retry
    expect(rejected.logs.error.some((line) => line.includes("REJECTED - claims released for retry"))).toBe(true);

    const retry = await run(DUE, { outcome: "unknown" });
    expect(retry.sent).toHaveLength(1); // the retry the rejected path exists to allow
    expect(retry.summary.failed).toBe(1);
    // ...and now the claims STAY, because this time we do not know what happened.
    expect(await reminderLedger()).toEqual([
      { weekly_report_project_id: PROJECT, week_of: DUE, kind: "due_digest" },
    ]);
    expect(retry.logs.error.some((line) => line.includes("outcome UNKNOWN"))).toBe(true);
  });

  it("does not claim it released the digest claims when the rollback itself failed", async () => {
    // The saturated pool this job already guards against elsewhere. A DELETE that never lands leaves the
    // claims standing and no catch-up tick will retry — so the log must not say "released for retry",
    // which is what an operator reads to decide whether to intervene.
    const spy = emailSpy({ outcome: "rejected" });
    const { logs, logger } = loggerSpy();
    const summary = await runWeeklyReportReminders({
      query: async (text: string, params?: unknown[]) => {
        if (text.includes("DELETE FROM office_dallas.weekly_report_reminders_sent")) {
          throw new Error("timeout exceeded when trying to connect");
        }
        return query(text, params);
      },
      sendEmail: spy.sendEmail,
      env: { FRONTEND_URL: "https://trockcrm.com" },
      now: atNoonUtc(DUE),
      logger,
      acquireLock: async () => async () => {},
    });

    expect(summary.failed).toBe(1);
    // The row survived the failed rollback — that is the state the log has to describe.
    expect(await reminderLedger()).toEqual([
      { weekly_report_project_id: PROJECT, week_of: DUE, kind: "due_digest" },
    ]);
    expect(logs.error.some((line) => line.includes("claim rollback FAILED"))).toBe(true);
    expect(logs.error.some((line) => line.includes("claims released for retry"))).toBe(false);
  });

  it("treats a THROWN send as unknown too — defence in depth, not the transport's failure path", async () => {
    // Kept deliberately small and labelled for what it is. `sendSystemEmailWithMetadata` does not throw
    // for ANY provider or network failure (real-transport suite), so nothing here models production; it
    // models a bug in the send path. The previous round's protection was tested ONLY through this door,
    // which is why it looked verified while the real failure walked straight past it.
    const first = await run(DUE, { throws: true });
    expect(first.summary.failed).toBe(1);
    expect(await reminderLedger()).toEqual([
      { weekly_report_project_id: PROJECT, week_of: DUE, kind: "due_digest" },
    ]);
    expect(first.logs.error.some((line) => line.includes("outcome UNKNOWN"))).toBe(true);
  });
});

// -----------------------------------------------------------------------------------------------------
// The bug the previous round did not fix, driven through the code that actually ships.
// -----------------------------------------------------------------------------------------------------

describe("leadership digest — against the REAL email transport", () => {
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    await setLeadershipRecipients(["takashi@example.com", "shaw@example.com"]);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  /**
   * The job wired to the real `sendSystemEmailWithMetadata`, with `fetch` stubbed underneath it — the same
   * boundary the reviewer probed. No `sendEmail` injection, so the ONLY thing standing between this test
   * and a second digest is the production code path.
   */
  async function runAgainstRealTransport(fetchBehaviour: () => Promise<Response>) {
    const requests: Array<{ subject: string; idempotencyKey: string | null; html: string }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const headers = new Headers(init?.headers);
      requests.push({
        subject: String(body.subject ?? ""),
        idempotencyKey: headers.get("Idempotency-Key"),
        html: String(body.html ?? ""),
      });
      return fetchBehaviour();
    }) as typeof fetch;

    const { logs, logger } = loggerSpy();
    const summary = await runWeeklyReportReminders({
      query,
      // sendEmail deliberately NOT injected.
      env: { FRONTEND_URL: "https://trockcrm.com" },
      now: atNoonUtc(DUE),
      logger,
      acquireLock: async () => async () => {},
    });
    return { requests, summary, logs };
  }

  it("sends ONE digest when the socket hangs up mid-send, even after the cohort grows", async () => {
    // Verbatim the reviewer's reproduction. 07:00: `fetch` rejects. resend@6 swallows it into
    // `{success:false}` — no exception — so the previous round's protection, which hung off a `catch`,
    // never ran: the claims were rolled back, `alreadyDigested` emptied, and when a project became due at
    // 09:00 the cohort hash rotated (so Resend could not dedup) and the `Update — ` prefix vanished with
    // the ledger it is gated on. Two full unlabelled digests.
    vi.stubEnv("RESEND_API_KEY", "re_test_e2e_key");

    const first = await runAgainstRealTransport(async () => {
      throw new Error("socket hang up");
    });
    expect(first.requests).toHaveLength(1);
    expect(first.summary.digestsSent).toBe(0);
    expect(first.summary.failed).toBe(1);
    // The claim SURVIVES an unknown outcome. This is the assertion the old test could not make, because
    // its stub raised an exception the transport cannot raise.
    expect(await reminderLedger()).toEqual([
      { weekly_report_project_id: PROJECT, week_of: DUE, kind: "due_digest" },
    ]);
    expect(first.logs.error.some((line) => line.includes("outcome UNKNOWN"))).toBe(true);

    // 09:00: a second project becomes due, so the cohort — and the idempotency key — changes.
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_projects
         (id, deal_id, property_display_name, trock_super_user_id, cadence_weekday, cadence_start_date)
       VALUES ($1::uuid, $2::uuid, 'Katy Freeway Shops', $3::uuid, ${THURSDAY}, '2026-07-27')`,
      [OTHER_PROJECT, OTHER_DEAL, SUPER],
    );
    const second = await runAgainstRealTransport(
      async () =>
        new Response(JSON.stringify({ id: "msg-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    expect(second.requests).toHaveLength(1);
    const digest = second.requests[0]!;
    // The key DID rotate — Resend cannot dedup this — so the subject is the only thing that can stop
    // leadership reading it as an independent second report. Before the fix it read "0 filed, 2
    // outstanding" with no prefix at all.
    expect(digest.idempotencyKey).not.toBe(first.requests[0]!.idempotencyKey);
    expect(digest.subject).toContain("Update — Weekly reports due Thursday, Aug 13 — 0 filed, 2 outstanding");
    expect(digest.html).toContain("This updates the digest sent earlier today");
    expect(digest.html).toContain("Katy Freeway Shops became due after it went out");
  });

  it("sends ONE digest on a 409 concurrent_idempotent_requests — an in-flight original is not a rejection", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_e2e_key");

    const first = await runAgainstRealTransport(
      async () =>
        new Response(
          JSON.stringify({
            name: "concurrent_idempotent_requests",
            message: "Same idempotency key is being processed",
            statusCode: 409,
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    );
    expect(first.summary.failed).toBe(1);
    expect(await reminderLedger()).toEqual([
      { weekly_report_project_id: PROJECT, week_of: DUE, kind: "due_digest" },
    ]);

    // Same cohort at 09:00: no second attempt at all.
    const second = await runAgainstRealTransport(
      async () =>
        new Response(JSON.stringify({ id: "msg-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(second.requests).toEqual([]);
    expect(second.summary.digestsSent).toBe(0);
  });

  it("DOES retry a 422 validation error — the case that must not be stranded", async () => {
    // The cost of the alternative fix (treating every `{success:false}` as unknown): a fixable rejection
    // would never retry and leadership would silently get nothing, for the whole day, with no email ever
    // attempted again.
    vi.stubEnv("RESEND_API_KEY", "re_test_e2e_key");

    const first = await runAgainstRealTransport(
      async () =>
        new Response(
          JSON.stringify({ name: "validation_error", message: "Invalid `to` field", statusCode: 422 }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    );
    expect(first.requests).toHaveLength(1);
    expect(first.summary.failed).toBe(1);
    expect(await reminderLedger()).toEqual([]); // released, because nothing exists to duplicate

    const retry = await runAgainstRealTransport(
      async () =>
        new Response(JSON.stringify({ id: "msg-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(retry.summary.digestsSent).toBe(1);
    // Same cohort, so the SAME key — a true duplicate would still be deduped by the provider.
    expect(retry.requests[0]!.idempotencyKey).toBe(first.requests[0]!.idempotencyKey);
    // And it is the FIRST digest of the day, not an "Update".
    expect(retry.requests[0]!.subject).toContain("Weekly reports due Thursday, Aug 13 — 0 filed, 1 outstanding");
    expect(retry.requests[0]!.subject.startsWith("Update")).toBe(false);
  });
});

// -----------------------------------------------------------------------------------------------------
// The ledger is a CLAIM ledger. What the digest is allowed to say about it.
// -----------------------------------------------------------------------------------------------------

describe("digest: claims vs deliveries", () => {
  beforeEach(async () => {
    await setLeadershipRecipients(["takashi@example.com", "shaw@example.com"]);
  });

  it("does not tell leadership a reminder was SENT when only a claim survives", async () => {
    // The reviewer's reproduction. The t-2 send is rejected and the compensating DELETE throws — the same
    // saturated pool the probe guard cites — so the row outlives a nudge that provably never went out.
    // The super is then deactivated overnight, which is what makes the digest print the note at all.
    //
    // Nothing can make that row mean "delivered", so the sentence must not say it does. Before this fix it
    // read "1 reminder was sent for this week", i.e. leadership was told a superintendent had ignored an
    // email he was never sent.
    await pg.query(`UPDATE office_dallas.weekly_report_projects SET trock_pm_user_id = NULL`);

    const spy = emailSpy({ outcome: "rejected" });
    const { logs, logger } = loggerSpy();
    await runWeeklyReportReminders({
      query: async (text: string, params?: unknown[]) => {
        if (text.includes("DELETE FROM office_dallas.weekly_report_reminders_sent")) {
          throw new Error("timeout exceeded when trying to connect");
        }
        return query(text, params);
      },
      sendEmail: spy.sendEmail,
      env: { FRONTEND_URL: "https://trockcrm.com" },
      now: atNoonUtc(T_MINUS_2),
      logger,
      acquireLock: async () => async () => {},
    });

    // The slot is burned over a delivery that never happened, and the log says so.
    expect(await reminderLedger()).toEqual([
      { weekly_report_project_id: PROJECT, week_of: DUE, kind: "t_minus_2" },
    ]);
    expect(logs.error.some((line) => line.includes("claim rollback FAILED"))).toBe(true);

    await pg.query(`UPDATE public.users SET is_active = false WHERE id = $1::uuid`, [SUPER]);
    try {
      const { sent } = await run(DUE);
      expect(sent).toHaveLength(1);
      // The claim-supported sentence, in both renderings.
      expect(sent[0]!.text).toContain(
        "1 reminder was logged for this week, but there is no reachable super or PM email now.",
      );
      expect(sent[0]!.html).toContain(
        "1 reminder was logged for this week, but there is no reachable super or PM email now.",
      );
      // The delivery assertion is gone from the email entirely.
      expect(sent[0]!.text).not.toContain("reminder was sent for this week, but");
      expect(sent[0]!.html).not.toContain("reminder was sent for this week, but");
    } finally {
      await pg.query(`UPDATE public.users SET is_active = true WHERE id = $1::uuid`, [SUPER]);
    }
  });
});

// -----------------------------------------------------------------------------------------------------
// The two guards on the widened ledger read. Either mutation used to leave the whole suite green.
// -----------------------------------------------------------------------------------------------------

describe("digest: the ledger read's scoping guards", () => {
  beforeEach(async () => {
    await setLeadershipRecipients(["takashi@example.com", "shaw@example.com"]);
  });

  it("ignores LAST week's ledger rows entirely — week_of bounds the read", async () => {
    // `due_digest` rows accumulate one per project per week and are never cleaned up. Drop the `week_of`
    // bound (replace it with a tautology) and `alreadyDigested` holds every project ever digested:
    // `newlyDue` empties and the leadership digest silently never sends again after its first week. No
    // error, no log line — the feature just stops.
    //
    // The prior week's t_minus_2 row is seeded too, because the SAME bound is what stops it inflating
    // `remindersSent` and silencing this week's "never reminded" heading.
    const LAST_WEEK = "2026-08-06";
    for (const kind of ["due_digest", "t_minus_2"]) {
      await pg.query(
        `INSERT INTO office_dallas.weekly_report_reminders_sent (weekly_report_project_id, week_of, kind)
         VALUES ($1::uuid, $2::date, $3)`,
        [PROJECT, LAST_WEEK, kind],
      );
    }

    const { sent, summary } = await run(DUE);

    // Consumer 1 — `alreadyDigested`: this week's digest still goes out, and as a FIRST digest.
    expect(sent).toHaveLength(1);
    expect(summary.digestsSent).toBe(1);
    expect(sent[0]!.subject).toContain("Weekly reports due Thursday, Aug 13 — 0 filed, 1 outstanding");
    expect(sent[0]!.subject.startsWith("Update")).toBe(false);
    // Consumer 2 — `remindersSent`: last week's chase says nothing about this week.
    expect(sent[0]!.html).toContain("Outstanding — 1 never reminded");
    expect(sent[0]!.text).toContain("No reminder was sent for this week.");
  });

  it("does not let a project's OWN due_digest receipt count as having chased anybody", async () => {
    // On a follow-up digest every project already covered carries a `due_digest` row. Count all kinds
    // instead of the two CHASE kinds and that receipt reads as "somebody was chased" — which silences the
    // `— N never reminded` heading and the `No reminder was sent for this week.` note for exactly the
    // never-chased project the follow-up digest exists to re-surface.
    const first = await run(DUE);
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]!.html).toContain("Outstanding — 1 never reminded");

    // A second project becomes due mid-morning, triggering a follow-up digest. Neither project has ever
    // been chased: no t-2 or t-1 ran on either.
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_projects
         (id, deal_id, property_display_name, trock_super_user_id, cadence_weekday, cadence_start_date)
       VALUES ($1::uuid, $2::uuid, 'Katy Freeway Shops', $3::uuid, ${THURSDAY}, '2026-07-27')`,
      [OTHER_PROJECT, OTHER_DEAL, SUPER],
    );
    // PROJECT now holds a due_digest row and OTHER_PROJECT holds none — so a mutation that counts all
    // kinds shows up as a DIFFERENCE between the two, not as a uniform shift.
    expect((await reminderLedger()).map((row) => row.kind)).toEqual(["due_digest"]);

    const second = await run(DUE);
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]!.subject).toContain(
      "Update — Weekly reports due Thursday, Aug 13 — 0 filed, 2 outstanding",
    );
    // BOTH are still never-reminded. Counting the due_digest receipt drops this to 1.
    expect(second.sent[0]!.html).toContain("Outstanding — 2 never reminded");
    // ...and the note survives on the project that carries its own receipt.
    expect(second.sent[0]!.text).toContain(
      "  - DFW-10432 — 4123 Cedar Springs (Not started) — Super: Steve Sanchez, PM: Adam Sherwood\n" +
        "      No reminder was sent for this week.",
    );
    expect(second.sent[0]!.text).toContain(
      "  - DFW-10433 — Katy Freeway Shops (Not started) — Super: Steve Sanchez, PM: unassigned\n" +
        "      No reminder was sent for this week.",
    );
    // Both notes present — the mutation removes the one on the project holding the due_digest receipt.
    expect(second.sent[0]!.text.match(/No reminder was sent for this week\./g)).toHaveLength(2);
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

  it("skips an office that has 0222 but NOT 0223, instead of losing its whole tick", async () => {
    // Migrations do not run on the worker's boot, and the weekly-report tables do not arrive together:
    // `weekly_report_pauses` is 0223. A guard that probed only 0222's `weekly_report_projects` let this
    // office through, and the pauses query then threw 42P01 out of processOffice — caught one level up,
    // so the office silently lost its t-2, its t-1 AND its digest, visible only as one logger.error.
    // Any database where 0222 applied and 0223 did not: a branch, a restore, a 0223 that errored.
    await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_austin;`);
    await pg.exec(tenantSchemaSql("office_austin", [deals, files]));
    // 0222's DO-loop walks every office_ schema, so this gives Austin the 0222 tables. 0223 is withheld.
    await pg.exec(migrationSql("0222_weekly_reports"));
    await pg.exec(`
      INSERT INTO public.offices (id, name, slug) VALUES ('${U("00002")}', 'Austin', 'austin')
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO office_austin.deals (id, name, deal_number, stage_id, project_number)
        VALUES ('${U("11113")}', 'Congress Ave Retail', 'ATX-1', '${WON_STAGE}', 'ATX-1');
    `);
    await pg.query(
      `INSERT INTO office_austin.weekly_report_projects
         (id, deal_id, property_display_name, trock_super_user_id, cadence_weekday, cadence_start_date)
       VALUES ($1::uuid, $2::uuid, 'Congress Ave Retail', $3::uuid, ${THURSDAY}, '2026-07-27')`,
      [U("44443"), U("11113"), SUPER],
    );
    try {
      const { summary, sent, logs } = await run(T_MINUS_2);
      expect(summary.failed).toBe(0);
      expect(summary.offices).toBe(1);
      // Dallas is reminded as usual; Austin is skipped by NAME, not by exception.
      expect(sent).toHaveLength(1);
      expect(sent[0]!.subject).toContain("4123 Cedar Springs");
      expect(logs.log.some((line) => line.includes("Weekly-report tables not present"))).toBe(true);
    } finally {
      await pg.exec(`DELETE FROM public.offices WHERE slug = 'austin'; DROP SCHEMA office_austin CASCADE;`);
    }
  });

  it("still runs the remaining offices when one office's table probe THROWS", async () => {
    // The probe is a query like any other, and it can fail for reasons that say nothing about this office:
    // a pool-acquisition timeout under saturation (`connectionTimeoutMillis: 10000` in worker/src/db.ts) is
    // a known production failure mode here. It was the ONE per-office statement outside processOffice's
    // try, so the first office's timeout propagated out of runWeeklyReportReminders and offices 2..N never
    // ran — precisely the silent whole-office loss the probe was added to prevent, one level further out.
    //
    // Offices are ordered by slug, so Austin runs FIRST: Dallas's reminder only exists if the throw was
    // contained.
    await pg.exec(`
      INSERT INTO public.offices (id, name, slug) VALUES ('${U("00002")}', 'Austin', 'austin')
        ON CONFLICT (id) DO NOTHING;
    `);
    const spy = emailSpy();
    const { logs, logger } = loggerSpy();
    try {
      const summary = await runWeeklyReportReminders({
        query: async (text: string, params?: unknown[]) => {
          if (text.includes("to_regclass") && JSON.stringify(params ?? []).includes("office_austin.")) {
            throw new Error("timeout exceeded when trying to connect");
          }
          return query(text, params);
        },
        sendEmail: spy.sendEmail,
        env: { FRONTEND_URL: "https://trockcrm.com" },
        now: atNoonUtc(T_MINUS_2),
        logger,
        acquireLock: async () => async () => {},
      });
      expect(summary.failed).toBe(1);
      expect(summary.offices).toBe(1);
      expect(spy.sent).toHaveLength(1);
      expect(spy.sent[0]!.subject).toContain("4123 Cedar Springs");
      // A probe that threw and tables that are legitimately absent mean OPPOSITE things — unknown state
      // versus a migration that has not landed — so they must not read the same in the logs.
      expect(logs.error.some((line) => line.includes("Weekly-report table probe failed"))).toBe(true);
      expect(logs.log.some((line) => line.includes("Weekly-report tables not present"))).toBe(false);
    } finally {
      await pg.exec(`DELETE FROM public.offices WHERE slug = 'austin';`);
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

describe("acquireReminderAdvisoryLock", () => {
  // Every run above injects `acquireLock`, so until now not one line of the real lock executed — while it
  // is the ONLY thing stopping a second worker replica emailing every superintendent in the office twice.
  // A fake pool exercises it without a live Postgres, which the PGlite harness cannot provide (a session
  // advisory lock has to be taken and released on the SAME connection).
  function fakePool(behaviour: { locked?: boolean; lockThrows?: boolean; unlockThrows?: boolean } = {}) {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const released: Array<Error | undefined> = [];
    const client = {
      query: async (text: string, params?: unknown[]) => {
        calls.push({ text, params: params ?? [] });
        if (text.includes("pg_advisory_unlock")) {
          if (behaviour.unlockThrows) throw new Error("connection lost");
          return { rows: [{ pg_advisory_unlock: true }] };
        }
        if (behaviour.lockThrows) throw new Error("connection lost");
        return { rows: [{ locked: behaviour.locked ?? true }] };
      },
      release: (err?: Error) => {
        released.push(err);
      },
    };
    return { calls, released, connect: async () => client };
  }

  it("locks and unlocks the same connection under ONE stable key", async () => {
    const pool = fakePool();
    const release = await acquireReminderAdvisoryLock(pool);
    expect(release).toBeTypeOf("function");
    // Held: the connection stays checked out until the release, or the lock dies with it.
    expect(pool.released).toEqual([]);

    await release!();
    expect(pool.calls.map((call) => call.text)).toEqual([
      "SELECT pg_try_advisory_lock($1) AS locked",
      "SELECT pg_advisory_unlock($1)",
    ]);
    // The SAME key both times. Unlocking a different one frees nothing and leaves the lock held for the
    // life of the process — every later tick would then skip, silently, forever.
    expect(pool.calls[0]!.params).toEqual([WEEKLY_REPORT_REMINDER_LOCK_KEY]);
    expect(pool.calls[1]!.params).toEqual([WEEKLY_REPORT_REMINDER_LOCK_KEY]);
    expect(pool.released).toEqual([undefined]);
  });

  it("returns null and hands the connection back when another replica holds the lock", async () => {
    const pool = fakePool({ locked: false });
    expect(await acquireReminderAdvisoryLock(pool)).toBeNull();
    // Returned to the pool healthy — this run simply has nothing to do.
    expect(pool.released).toEqual([undefined]);
  });

  it("releases the connection when the lock query itself throws", async () => {
    const pool = fakePool({ lockThrows: true });
    await expect(acquireReminderAdvisoryLock(pool)).rejects.toThrow("connection lost");
    expect(pool.released).toEqual([undefined]);
  });

  it("DESTROYS the connection when the unlock fails rather than returning a locked one to the pool", async () => {
    const pool = fakePool({ unlockThrows: true });
    const release = await acquireReminderAdvisoryLock(pool);
    await expect(release!()).rejects.toThrow("connection lost");
    // release(err) evicts the client instead of pooling it; Postgres frees session locks on disconnect.
    expect(pool.released).toHaveLength(1);
    expect(pool.released[0]).toBeInstanceOf(Error);
  });
});
