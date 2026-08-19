// Runtime suite for the per-project AUDIT TRAIL — the record behind a row in the Projects tab.
//
// Every fact it reports was already being written and none of it was reachable: the tab offered an Edit
// button and no way in, so "when did the client actually get week 8, and who approved it" was a question
// only answerable with SQL.
//
// The schema is the real migrations read from disk, so the columns these assertions name are the ones
// that ship. The events themselves are built on the SERVER and asserted here rather than in the browser,
// because their ORDER and their WORDING are the substance of an audit trail: "approved" and "sent" are
// different acts by potentially different people, and a bounce is not a delivery.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deals, fieldResponders, files, offices, userOfficeAccess, users } from "@trock-crm/shared/schema";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import { migrationSql } from "../../helpers/migration-sql.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { AppError } from "../../../src/middleware/error-handler.js";
import { getWeeklyReportProjectAudit } from "../../../src/modules/weekly-reports/project-audit-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const OFFICE = U("00001");
const DEAL = U("11111");
const PM = U("22221");
const SUPER = U("22222");
const DIRECTOR = U("22223");
const WON_STAGE = U("33331");
const PROJECT = U("55551");
const REPORT = U("66661");

let pg: PGlite;
let db: { query: PGlite["query"] };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_dallas;`);
  await pg.exec(tenantSchemaSql("public", [offices, users, userOfficeAccess]));
  await pg.exec(tenantSchemaSql("office_dallas", [deals, fieldResponders, files]));
  await pg.exec(`CREATE TABLE IF NOT EXISTS public.pipeline_stage_config (id uuid PRIMARY KEY, slug text);`);

  await pg.exec(migrationSql("0222_weekly_reports"));
  await pg.exec(migrationSql("0223_weekly_report_pauses"));
  await pg.exec(migrationSql("0224_weekly_reports_pdf_content_generation"));
  await pg.exec(migrationSql("0226_weekly_report_send"));
  await pg.exec(migrationSql("0227_weekly_report_delivery_events"));
  await pg.exec(migrationSql("0227_weekly_report_send_stall_alerted"));
  await pg.exec(migrationSql("0228_weekly_report_project_roster_link"));

  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES ('${OFFICE}', 'Dallas', 'dallas');
    INSERT INTO public.users (id, display_name, email, role, office_id) VALUES
      ('${PM}', 'Adam Sherwood', 'pm@example.com', 'construction', '${OFFICE}'),
      ('${SUPER}', 'Steve Sanchez', 'super@example.com', 'construction', '${OFFICE}'),
      ('${DIRECTOR}', 'Takashi', 'director@example.com', 'director', '${OFFICE}');
    INSERT INTO public.pipeline_stage_config (id, slug) VALUES ('${WON_STAGE}', '${WON_DEAL_STAGE_SLUGS[0]}');
    INSERT INTO office_dallas.deals (id, name, deal_number, stage_id, project_number) VALUES
      ('${DEAL}', '4123 Cedar Springs', 'DFW-10432', '${WON_STAGE}', 'DFW-10432');
    SET search_path TO office_dallas, public;
  `);
  db = { query: (text: any, params?: any) => pg.query(text, params) } as any;
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM office_dallas.weekly_report_reminders_sent;
    DELETE FROM office_dallas.weekly_report_dismissals;
    DELETE FROM office_dallas.weekly_report_pauses;
    DELETE FROM office_dallas.weekly_reports;
    DELETE FROM office_dallas.weekly_report_projects;
  `);
  await pg.query(
    `INSERT INTO office_dallas.weekly_report_projects
       (id, deal_id, property_display_name, client_name, cadence_weekday, cadence_start_date)
     VALUES ($1::uuid, $2::uuid, '4123 Cedar Springs', 'Mack Real Estate Group', 4, '2026-07-27')`,
    [PROJECT, DEAL],
  );
});

/** A report that went all the way through: drafted, submitted, approved, sent, accepted. */
async function seedFullySentReport(overrides: Record<string, unknown> = {}) {
  const values = {
    id: REPORT,
    // NOT NULL since 0222 — the phone's idempotency key for a draft it may re-upload.
    client_submission_id: U("77771"),
    week_of: "2026-08-13",
    version: 1,
    status: "sent",
    authored_by: SUPER,
    authored_at: "2026-08-13T14:00:00Z",
    submitted_by: SUPER,
    submitted_at: "2026-08-13T15:00:00Z",
    reviewed_by: PM,
    reviewed_at: "2026-08-13T16:00:00Z",
    sent_by: PM,
    sent_at: "2026-08-13T17:00:00Z",
    send_delivered_at: "2026-08-13T17:00:30Z",
    send_request: JSON.stringify({ to: ["jay@mackre.com", "melissa@mackre.com"] }),
    ...overrides,
  } as Record<string, unknown>;

  const cols = Object.keys(values);
  const placeholders = cols.map((c, i) => {
    const cast = c.endsWith("_at")
      ? "::timestamptz"
      : c === "send_request" || c === "send_delivery_detail"
        ? "::jsonb"
        : c.endsWith("_by") || c === "id" || c === "client_submission_id" || c === "superseded_by_id"
          ? "::uuid"
          : c === "week_of"
            ? "::date"
            : "";
    return `$${i + 1}${cast}`;
  });
  await pg.query(
    `INSERT INTO office_dallas.weekly_reports (weekly_report_project_id, deal_id, ${cols.join(", ")})
     VALUES ('${PROJECT}'::uuid, '${DEAL}'::uuid, ${placeholders.join(", ")})`,
    Object.values(values),
  );
}

function typesOf(events: { type: string }[]): string[] {
  return events.map((event) => event.type);
}

describe("the per-project audit trail", () => {
  it("404s a project that does not exist, rather than reporting an empty history for it", async () => {
    // An empty history and a missing project look identical to a reader, and only one of them means
    // "nothing has happened here".
    // The CODE, not just the class: AppError carries 400/403/404/409/500 across this codebase, so
    // `toBeInstanceOf` alone would still pass if this became a 500.
    await expect(getWeeklyReportProjectAudit(db as any, U("99999"))).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("reports who drafted, who approved and who sent — the question the page exists to answer", async () => {
    await seedFullySentReport();
    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);

    expect(audit.reports).toHaveLength(1);
    const events = audit.reports[0]!.events;
    const byType = Object.fromEntries(events.map((e) => [e.type, e]));

    expect(byType.drafted!.actorName).toBe("Steve Sanchez");
    expect(byType.approved!.actorName).toBe("Adam Sherwood");
    expect(byType.sent!.actorName).toBe("Adam Sherwood");
    expect(byType.sent!.at).toBe("2026-08-13T17:00:00.000Z");
  });

  it("orders the timeline by WHEN things happened, not by a fixed lifecycle sequence", async () => {
    // The two diverge the moment the happy path is departed from, and that is exactly when somebody is
    // reading this page. This fixture makes them disagree ON PURPOSE: the retry (17:30) happened BEFORE
    // the provider's verdict (18:00), while the builder pushes the verdict first. Assembly order alone
    // would print the bounce above the retry that preceded it — a false account of what happened.
    await seedFullySentReport({
      send_attempts: 3,
      send_last_attempt_at: "2026-08-13T17:30:00Z",
      send_error: "provider timeout",
      send_delivery_status: "bounced",
      send_delivery_status_at: "2026-08-13T18:00:00Z",
      send_delivery_detail: JSON.stringify({ message: "mailbox does not exist" }),
    });
    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    const events = audit.reports[0]!.events;

    expect(typesOf(events)).toEqual([
      "drafted",
      "submitted",
      "approved",
      "sent",
      "accepted",
      "retried", // 17:30 — pushed AFTER the verdict, printed BEFORE it
      "failed", // 18:00
    ]);
    const stamps = events.map((e) => e.at);
    expect([...stamps].sort()).toEqual(stamps);
  });

  it("separates the provider ACCEPTING a message from the client receiving it", async () => {
    // A message can be accepted and then hard-bounce. Collapsing the two renders that as a delivery,
    // which is the single most misleading thing this page could say.
    await seedFullySentReport({
      send_delivery_status: "bounced",
      send_delivery_status_at: "2026-08-13T18:00:00Z",
      send_delivery_detail: JSON.stringify({ message: "mailbox does not exist" }),
    });
    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    const report = audit.reports[0]!;

    expect(typesOf(report.events)).toContain("accepted");
    expect(typesOf(report.events)).toContain("failed");
    expect(typesOf(report.events)).not.toContain("delivered");
    expect(report.events.find((e) => e.type === "failed")!.detail).toContain("mailbox does not exist");
    // A bounce HAS a delivery stamp, so any predicate keyed on that alone reads it as a success.
    expect(report.undelivered).toBe(true);
  });

  it("does not call a report still in transit DELIVERED", async () => {
    // `delayed` means the provider is still trying, and the shared vocabulary says so explicitly. A
    // binary "failure or delivered" split sent it down the delivered branch, so a report the client did
    // not have was reported to a director as arrived — the same mistake as reading acceptance for
    // delivery, one field over, and on the page whose entire job is to be trusted about this.
    await seedFullySentReport({
      send_delivery_status: "delayed",
      send_delivery_status_at: "2026-08-13T17:10:00Z",
    });
    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    const report = audit.reports[0]!;

    expect(typesOf(report.events)).toContain("delayed");
    expect(typesOf(report.events)).not.toContain("delivered");
    expect(typesOf(report.events)).not.toContain("failed");
    // And it is not evidence of receipt, so the week still reads as outstanding.
    expect(report.undelivered).toBe(true);
  });

  it("treats a spam complaint as delivered, because a complaint can only follow one", async () => {
    // The other non-failure status, and it goes the OTHER way — the client demonstrably has the report.
    // Pinned so a future "anything that isn't `delivered` is a problem" simplification cannot pass.
    await seedFullySentReport({
      send_delivery_status: "complained",
      send_delivery_status_at: "2026-08-13T18:00:00Z",
    });
    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    const report = audit.reports[0]!;

    expect(typesOf(report.events)).toContain("delivered");
    expect(report.undelivered).toBe(false);
    // The word still shows, because "delivered, and they marked it as spam" is worth knowing.
    expect(report.events.find((e) => e.type === "delivered")!.detail).toContain("complained");
  });

  it("does not report a plain accepted send as undelivered", async () => {
    // The control. Without it the assertion above passes for a page that flags everything.
    await seedFullySentReport({
      send_delivery_status: "delivered",
      send_delivery_status_at: "2026-08-13T17:05:00Z",
    });
    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports[0]!.undelivered).toBe(false);
    expect(typesOf(audit.reports[0]!.events)).toContain("delivered");
  });

  it("flags a committed send the provider never accepted", async () => {
    await seedFullySentReport({ send_delivered_at: null });
    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports[0]!.undelivered).toBe(true);
    expect(typesOf(audit.reports[0]!.events)).not.toContain("accepted");
  });

  it("lists who the report was actually addressed to", async () => {
    await seedFullySentReport();
    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports[0]!.recipients).toEqual(["jay@mackre.com", "melissa@mackre.com"]);
    expect(audit.reports[0]!.events.find((e) => e.type === "sent")!.detail).toContain("jay@mackre.com");
  });

  it("does not invent a retry for an ordinary one-attempt send", async () => {
    // send_last_attempt_at is stamped even on a first attempt, so a naive read grows a redundant
    // "attempt 1" line under every send's own timestamp.
    await seedFullySentReport({ send_attempts: 1, send_last_attempt_at: "2026-08-13T17:00:00Z" });
    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(typesOf(audit.reports[0]!.events)).not.toContain("retried");
  });

  it("shows every version of a corrected week, newest first, and marks the superseded one", async () => {
    const V2 = U("66662");
    await seedFullySentReport();
    await pg.query(
      `INSERT INTO office_dallas.weekly_reports
         (id, client_submission_id, weekly_report_project_id, deal_id, week_of, version, status, created_at)
       VALUES ($1::uuid, $4::uuid, $2::uuid, $3::uuid, '2026-08-13'::date, 2, 'draft',
               '2026-08-14T09:00:00Z'::timestamptz)`,
      [V2, PROJECT, DEAL, U("77772")],
    );
    await pg.query(`UPDATE office_dallas.weekly_reports SET superseded_by_id = $1::uuid WHERE id = $2::uuid`, [
      V2,
      REPORT,
    ]);

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports.map((r) => r.version)).toEqual([2, 1]);
    const original = audit.reports.find((r) => r.version === 1)!;
    expect(original.supersededById).toBe(V2);
    // Dated off the REPLACEMENT's creation, not the old row's updated_at, which moves for any edit and
    // would date the supersede to whenever somebody last touched the old version.
    expect(original.events.find((e) => e.type === "superseded")!.at).toBe("2026-08-14T09:00:00.000Z");
  });

  it("carries the reminder, dismissal and pause ledgers", async () => {
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_reminders_sent (weekly_report_project_id, week_of, kind, sent_at)
       VALUES ($1::uuid, '2026-08-13'::date, 't_minus_2', '2026-08-11T12:00:00Z'::timestamptz)`,
      [PROJECT],
    );
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_dismissals
         (weekly_report_project_id, week_of, reason, dismissed_by, dismissed_at)
       VALUES ($1::uuid, '2026-08-06'::date, 'Crew off site', $2::uuid, '2026-08-07T12:00:00Z'::timestamptz)`,
      [PROJECT, DIRECTOR],
    );
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_pauses (weekly_report_project_id, paused_from, resumed_on, paused_by)
       VALUES ($1::uuid, '2026-07-30'::date, '2026-08-05'::date, $2::uuid)`,
      [PROJECT, DIRECTOR],
    );

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reminders).toEqual([{ weekOf: "2026-08-13", kind: "t_minus_2", at: "2026-08-11T12:00:00.000Z" }]);
    expect(audit.dismissals[0]).toMatchObject({
      weekOf: "2026-08-06",
      reason: "Crew off site",
      actorName: "Takashi",
    });
    expect(audit.pauses[0]).toMatchObject({
      pausedFrom: "2026-07-30",
      resumedOn: "2026-08-05",
      pausedByName: "Takashi",
    });
  });

  it("includes a soft-deleted report, because an audit trail that hides removals is not one", async () => {
    await seedFullySentReport({ is_active: false });
    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports).toHaveLength(1);
  });

  it("never returns the stored send request, which carries the RAW share token", async () => {
    // `send_request.shareUrl` holds the raw token — the only place it exists, since
    // `weekly_report_tokens` stores just its SHA-256. This endpoint is open to every `rep` in the
    // office, so returning the row would hand all of them a live client link to every report ever sent.
    // Asserted against the SERIALISED payload rather than the typed shape, because the leak this guards
    // against is a stray spread or a `...row`, which no interface would catch.
    await seedFullySentReport({
      send_request: JSON.stringify({
        to: ["jay@mackre.com"],
        shareUrl: "https://trockcrm.com/w/SUPER-SECRET-RAW-TOKEN",
      }),
    });

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    const serialised = JSON.stringify(audit);

    expect(serialised).not.toContain("SUPER-SECRET-RAW-TOKEN");
    expect(serialised).not.toContain("shareUrl");
    // The control: the recipient WAS read off that same object, so a blanket failure to parse it would
    // otherwise satisfy the two assertions above for the wrong reason.
    expect(audit.reports[0]!.recipients).toEqual(["jay@mackre.com"]);
  });

  it("survives a send_request that is not the shape it expects", async () => {
    // It is free-form jsonb written by another code path. A crash here takes down the whole record.
    await seedFullySentReport({ send_request: JSON.stringify({ to: "not-an-array" }) });
    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports[0]!.recipients).toBeNull();
    expect(typesOf(audit.reports[0]!.events)).toContain("sent");
  });
});
