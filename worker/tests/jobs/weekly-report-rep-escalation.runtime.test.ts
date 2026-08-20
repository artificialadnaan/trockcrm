// Runtime suite for the 17:00 SALES-REP ESCALATION — the fourth reminder tier.
//
// The first three all stay inside the project team and are finished by 11:00 on the due day. After that
// nothing happens, so a report that is simply never written goes unmentioned and the person who owns the
// CLIENT relationship finds out when the client asks. This tier is the one that leaves the team.
//
// Two things here are easy to get wrong in ways that are silent for a long time:
//
//   1. THE EVENING TICK MUST NOT RE-RUN THE MORNING'S WORK. `due_digest` also fires on the due day. A
//      pass that re-evaluated it would re-send the leadership digest every evening, and the fix for that
//      is usually to suppress the escalation instead.
//   2. A JOB WITH NO REP MUST STILL ESCALATE. The whole point is that a missed client report gets in
//      front of somebody; falling silent because a field is blank reproduces the failure it exists for.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deals, fieldResponders, files, offices, users } from "@trock-crm/shared/schema";
import { migrationSql } from "../../../server/tests/helpers/migration-sql.js";
import { tenantSchemaSql } from "../../../server/tests/helpers/tenant-schema-from-drizzle.js";
import type { SendSystemEmailResult } from "../../src/lib/system-email.js";
import {
  buildWeeklyReportRepEscalationEmail,
  officeAdmitsRepEscalation,
  runWeeklyReportRepEscalations,
  runWeeklyReportReminders,
} from "../../src/jobs/weekly-report-reminders.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const OFFICE = U("00001");
const DEAL = U("11111");
const PM = U("22221");
const SUPER = U("22222");
const REP = U("22224");
const RETIRED_REP = U("22225");
const PM_RESPONDER = U("44451");
const SUPER_RESPONDER = U("44452");
const WON_STAGE = U("33331");
const PROJECT = U("44441");

/** Thursday cadence. 2026-08-13 is a Thursday, so that is the due date the escalation fires on. */
const DUE_DATE = "2026-08-13";
const THURSDAY = 4;

let pg: PGlite;

const query = async (text: string, params?: unknown[]) => {
  const result = await pg.query(text, params as any[]);
  return {
    rows: result.rows as any[],
    rowCount: (result as { affectedRows?: number }).affectedRows ?? result.rows.length,
  };
};

/** Noon UTC on a date is 07:00 CT — inside the business day, and the same anchor the other suites use. */
function atNoonUtc(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00.000Z`);
}

interface SentEmail {
  to: string[];
  subject: string;
  html: string;
  text: string;
}

function emailSpy() {
  const sent: SentEmail[] = [];
  const sendEmail = async (
    to: string | string[],
    subject: string,
    html: string,
    options: { text: string; idempotencyKey: string },
  ): Promise<SendSystemEmailResult> => {
    sent.push({ to: Array.isArray(to) ? to : [to], subject, html, text: options.text });
    return { success: true, outcome: "delivered" } as SendSystemEmailResult;
  };
  return { sent, sendEmail };
}

function loggerSpy() {
  const logs = { log: [] as string[], warn: [] as string[], error: [] as string[] };
  const record = (bucket: string[]) => (...args: unknown[]) => bucket.push(String(args[0] ?? ""));
  return { logs, logger: { log: record(logs.log), warn: record(logs.warn), error: record(logs.error) } };
}

async function runEscalation(onDate = DUE_DATE) {
  const spy = emailSpy();
  const { logs, logger } = loggerSpy();
  const summary = await runWeeklyReportRepEscalations({
    query,
    sendEmail: spy.sendEmail,
    env: { FRONTEND_URL: "https://trockcrm.com" },
    now: atNoonUtc(onDate),
    logger,
    acquireLock: async () => async () => {},
  });
  return { ...spy, summary, logs };
}

async function runMorningReminders(onDate = DUE_DATE) {
  const spy = emailSpy();
  const { logs, logger } = loggerSpy();
  const summary = await runWeeklyReportReminders({
    query,
    sendEmail: spy.sendEmail,
    env: { FRONTEND_URL: "https://trockcrm.com" },
    now: atNoonUtc(onDate),
    logger,
    acquireLock: async () => async () => {},
  });
  return { ...spy, summary, logs };
}

async function ledgerKinds(): Promise<string[]> {
  const res = await pg.query(
    `SELECT kind FROM office_dallas.weekly_report_reminders_sent ORDER BY kind`,
  );
  return (res.rows as Array<{ kind: string }>).map((row) => row.kind);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_dallas;`);
  await pg.exec(tenantSchemaSql("public", [offices, users]));
  await pg.exec(tenantSchemaSql("office_dallas", [deals, fieldResponders, files]));
  await pg.exec(`CREATE TABLE IF NOT EXISTS public.pipeline_stage_config (id uuid PRIMARY KEY, slug text);`);

  await pg.exec(migrationSql("0222_weekly_reports"));
  await pg.exec(migrationSql("0223_weekly_report_pauses"));
  await pg.exec(migrationSql("0226_weekly_report_send"));
  await pg.exec(migrationSql("0227_weekly_report_delivery_events"));
  await pg.exec(migrationSql("0227_weekly_report_send_stall_alerted"));
  await pg.exec(migrationSql("0228_weekly_report_project_roster_link"));
  await pg.exec(migrationSql("0229_weekly_report_rep_escalation_kind"));
  await pg.exec(migrationSql("0230_weekly_reports_carried_from"));

  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES ('${OFFICE}', 'Dallas', 'dallas');
    INSERT INTO public.users (id, display_name, email, role, office_id, is_active) VALUES
      ('${PM}',    'Adam Sherwood', 'pm@example.com',      'construction', '${OFFICE}', true),
      ('${SUPER}', 'Steve Sanchez', 'super@example.com',   'construction', '${OFFICE}', true),
      ('${REP}',   'Colby Burling', 'rep@example.com',     'rep',          '${OFFICE}', true),
      ('${RETIRED_REP}', 'Gone Rep', 'gonerep@example.com', 'rep',         '${OFFICE}', false);
    INSERT INTO public.pipeline_stage_config (id, slug) VALUES ('${WON_STAGE}', 'won');
    INSERT INTO office_dallas.field_responders (id, name, email, role) VALUES
      ('${PM_RESPONDER}', 'Adam Sherwood', 'pm@example.com', 'project_manager'),
      ('${SUPER_RESPONDER}', 'Steve Sanchez', 'super@example.com', 'superintendent');
    INSERT INTO office_dallas.weekly_report_settings (leadership_recipient_emails)
      VALUES (ARRAY['director@example.com']);
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM office_dallas.weekly_report_reminders_sent;
    DELETE FROM office_dallas.weekly_reports;
    DELETE FROM office_dallas.weekly_report_projects;
    DELETE FROM office_dallas.deals;
  `);
  await pg.query(
    `INSERT INTO office_dallas.deals (id, name, deal_number, stage_id, project_number, assigned_rep_id)
     VALUES ($1::uuid, '4123 Cedar Springs', 'DFW-10432', $2::uuid, 'DFW-10432', $3::uuid)`,
    [DEAL, WON_STAGE, REP],
  );
  await pg.query(
    `INSERT INTO office_dallas.weekly_report_projects
       (id, deal_id, property_display_name, client_name,
        trock_pm_responder_id, trock_pm_user_id, trock_super_responder_id, trock_super_user_id,
        cadence_weekday, cadence_start_date)
     VALUES ($1::uuid, $2::uuid, '4123 Cedar Springs', 'Mack Real Estate Group',
             $3::uuid, $4::uuid, $5::uuid, $6::uuid, ${THURSDAY}, '2026-07-01')`,
    [PROJECT, DEAL, PM_RESPONDER, PM, SUPER_RESPONDER, SUPER],
  );
});

async function seedReport(status: string) {
  await pg.query(
    `INSERT INTO office_dallas.weekly_reports
       (id, client_submission_id, weekly_report_project_id, deal_id, week_of, status, work_completed)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6, 'done')`,
    [U("66661"), U("77771"), PROJECT, DEAL, DUE_DATE, status],
  );
}

describe("the 17:00 sales-rep escalation", () => {
  it("emails the rep and copies the PM when the report was never submitted", async () => {
    const { sent, summary } = await runEscalation();

    expect(summary.escalationsSent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["rep@example.com", "pm@example.com"]);
    expect(sent[0]!.subject).toContain("NOT submitted");
    expect(sent[0]!.subject).toContain("4123 Cedar Springs");
    // The ask is the whole point of the email — the rep does not write the report, they chase it.
    expect(sent[0]!.text).toContain("reach out to the PM");
  });

  it("stays silent once the report has been submitted", async () => {
    // Submitted is done as far as the superintendent is concerned. A report sitting with the PM is not
    // the rep's problem, and chasing it is how this email stops meaning anything.
    await seedReport("pending_review");

    const { sent, summary } = await runEscalation();

    expect(sent).toHaveLength(0);
    expect(summary.escalationsSent).toBe(0);
    expect(await ledgerKinds()).toEqual([]);
  });

  it("stays silent on a week somebody dismissed", async () => {
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_dismissals (weekly_report_project_id, week_of, reason)
       VALUES ($1::uuid, $2::date, 'Crew off site')`,
      [PROJECT, DUE_DATE],
    );

    const { sent } = await runEscalation();

    expect(sent).toHaveLength(0);
  });

  it("falls back to leadership when the job has no assigned rep, and says so", async () => {
    // The failure this fallback exists for: a missed client report going unescalated because a field
    // was blank. Silence here is indistinguishable from "nothing was owed".
    await pg.query(`UPDATE office_dallas.deals SET assigned_rep_id = NULL WHERE id = $1::uuid`, [DEAL]);

    const { sent } = await runEscalation();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["director@example.com", "pm@example.com"]);
    // The subject explains why leadership is receiving it — otherwise their first question is "why me".
    expect(sent[0]!.subject).toContain("No rep assigned");
  });

  it("treats a DEACTIVATED rep the same as no rep", async () => {
    // Emailing somebody who has left the company is silence with extra steps, and it looks like success
    // in every log and counter.
    await pg.query(`UPDATE office_dallas.deals SET assigned_rep_id = $1::uuid WHERE id = $2::uuid`, [
      RETIRED_REP,
      DEAL,
    ]);

    const { sent } = await runEscalation();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toContain("director@example.com");
    expect(sent[0]!.to).not.toContain("gonerep@example.com");
  });

  it("falls back to leadership when the rep's stored address is MALFORMED", async () => {
    // The hole a null-check alone left open, and it is the exact failure this fallback exists to close.
    // A rep row with a broken address passed `repEmail == null`, so `unassigned` stayed false and
    // leadership was never added — and then the deliverability filter dropped the bad address too.
    // Recipients: none. The escalation reached NOBODY, silently.
    await pg.query(`UPDATE public.users SET email = 'not-an-email' WHERE id = $1::uuid`, [REP]);
    try {
      const { sent } = await runEscalation();

      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toContain("director@example.com");
      expect(sent[0]!.to.join(",")).not.toContain("not-an-email");
      expect(sent[0]!.subject).toContain("No rep assigned");
    } finally {
      await pg.query(`UPDATE public.users SET email = 'rep@example.com' WHERE id = $1::uuid`, [REP]);
    }
  });

  it("fires ONCE — a second tick the same evening sends nothing", async () => {
    const first = await runEscalation();
    expect(first.sent).toHaveLength(1);

    const second = await runEscalation();
    expect(second.sent).toHaveLength(0);
    expect(await ledgerKinds()).toEqual(["rep_escalation"]);
  });

  it("does NOT re-send the morning's leadership digest", async () => {
    // THE REGRESSION THIS TICK COULD CAUSE. `due_digest` also fires on the due day, so an evening pass
    // that re-evaluated the lead-day kinds would mail leadership their digest a second time, every
    // single evening. The escalation computes only its own kind.
    await runMorningReminders();
    const kindsAfterMorning = await ledgerKinds();
    expect(kindsAfterMorning).toContain("due_digest");

    const { sent } = await runEscalation();

    // The REAL digest subject — "Weekly reports due {day} — N filed, M outstanding". The first version
    // of this assertion looked for "Weekly report status", a string no code path emits, so it passed
    // whether or not a digest went out. In the guard for the regression this whole design exists to
    // prevent, that is the worst place to have put an assertion that cannot fail.
    expect(sent.every((email) => !email.subject.includes("Weekly reports due"))).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain("NOT submitted");
  });

  it("does not fire on a day that is not the due date", async () => {
    const { sent } = await runEscalation("2026-08-12"); // the day before
    expect(sent).toHaveLength(0);
  });

  it("skips an office whose ledger has not been migrated to admit the kind", async () => {
    // Migrations do not run on the worker, so there is a real window on every deploy where the CHECK
    // still lists three kinds. Without the probe the claim fails a constraint, `guarded` swallows it,
    // and the escalation silently never arrives.
    await pg.exec(`
      ALTER TABLE office_dallas.weekly_report_reminders_sent
        DROP CONSTRAINT IF EXISTS weekly_report_reminders_sent_kind_check;
      ALTER TABLE office_dallas.weekly_report_reminders_sent
        ADD CONSTRAINT weekly_report_reminders_sent_kind_check
        CHECK (kind IN ('t_minus_2', 't_minus_1', 'due_digest'));
    `);
    try {
      expect(await officeAdmitsRepEscalation(query, "office_dallas")).toBe(false);

      const { sent, summary, logs } = await runEscalation();

      expect(sent).toHaveLength(0);
      expect(summary.failed).toBe(0);
      expect(logs.log.some((line) => line.includes("Escalation kind not migrated yet"))).toBe(true);
    } finally {
      await pg.exec(`
        ALTER TABLE office_dallas.weekly_report_reminders_sent
          DROP CONSTRAINT IF EXISTS weekly_report_reminders_sent_kind_check;
        ALTER TABLE office_dallas.weekly_report_reminders_sent
          ADD CONSTRAINT weekly_report_reminders_sent_kind_check
          CHECK (kind IN ('t_minus_2', 't_minus_1', 'due_digest', 'rep_escalation'));
      `);
    }
  });

  it("sees the widened constraint as admitting the kind", async () => {
    // The control for the probe. Without it the skip above could pass for a probe that always says no.
    expect(await officeAdmitsRepEscalation(query, "office_dallas")).toBe(true);
  });
});

describe("the escalation email", () => {
  it("names the PM the rep is being asked to contact", () => {
    const email = buildWeeklyReportRepEscalationEmail({
      projectName: "4123 Cedar Springs",
      projectNumber: "DFW-10432",
      clientName: "Mack Real Estate Group",
      weekOf: DUE_DATE,
      pmName: "Adam Sherwood",
      unassigned: false,
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
    });

    expect(email.text).toContain("Adam Sherwood");
    expect(email.subject).toContain("DFW-10432");
    expect(email.html).toContain("Mack Real Estate Group");
  });

  it("reads differently when nobody is assigned to chase it", () => {
    const email = buildWeeklyReportRepEscalationEmail({
      projectName: "4123 Cedar Springs",
      projectNumber: null,
      clientName: null,
      weekOf: DUE_DATE,
      pmName: null,
      unassigned: true,
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
    });

    expect(email.subject).toContain("No rep assigned");
    expect(email.text).toContain("no assigned sales rep");
  });
});
