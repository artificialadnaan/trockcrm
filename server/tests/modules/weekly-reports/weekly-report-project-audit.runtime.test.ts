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
  // 0229 admits the rep_escalation reminder kind; 0230 adds `carried_from_report_id`, which the
  // draft-creation INSERT now writes. A suite that stops short fails on a missing column rather
  // than on its subject.
  await pg.exec(migrationSql("0229_weekly_report_rep_escalation_kind"));
  await pg.exec(migrationSql("0230_weekly_reports_carried_from"));
  await pg.exec(migrationSql("0231_weekly_report_views"));

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
    DELETE FROM public.weekly_report_views;
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

  /**
   * One week carried by N versions, oldest first, chained the way production chains them.
   *
   * `sendWeeklyReport` stamps `superseded_by_id` AT SEND and only onto rows that are themselves `sent`
   * and not already superseded — so v1 points at v2 and keeps pointing at v2 once v3 goes out. These
   * fixtures reproduce that chain rather than pointing every old row at the newest, because the
   * difference is exactly what the version comparison in `markOutstanding` reads.
   *
   * Returns the ids in the order given.
   */
  async function seedWeek(versions: Array<{ deliveryStatus?: string | null; status?: string }>) {
    const ids = versions.map((_, index) => (index === 0 ? REPORT : U(`6666${index + 1}`)));

    await seedFullySentReport({
      send_delivery_status: versions[0]!.deliveryStatus ?? null,
      ...(versions[0]!.status ? { status: versions[0]!.status } : {}),
    });

    for (let index = 1; index < versions.length; index += 1) {
      const spec = versions[index]!;
      const status = spec.status ?? "sent";
      const sent = status === "sent";
      await pg.query(
        `INSERT INTO office_dallas.weekly_reports
           (id, client_submission_id, weekly_report_project_id, deal_id, week_of, version, status,
            created_at, sent_by, sent_at, send_delivered_at, send_delivery_status, send_request)
         VALUES ($1::uuid, $4::uuid, $2::uuid, $3::uuid, '2026-08-13'::date, $5, $6,
                 $7::timestamptz, $8::uuid, $9::timestamptz, $10::timestamptz, $11, $12::jsonb)`,
        [
          ids[index],
          PROJECT,
          DEAL,
          U(`7777${index + 1}`),
          index + 1,
          status,
          `2026-08-${14 + index}T09:00:00Z`,
          sent ? PM : null,
          sent ? `2026-08-${14 + index}T10:00:00Z` : null,
          sent ? `2026-08-${14 + index}T10:00:30Z` : null,
          spec.deliveryStatus ?? null,
          sent ? JSON.stringify({ to: ["jay@mackre.com"] }) : null,
        ],
      );

      // The supersede lands on the immediately preceding SENT row, and only if nothing claimed it
      // first — the four predicates in send-service, reproduced.
      if (sent && (versions[index - 1]!.status ?? "sent") === "sent") {
        await pg.query(
          `UPDATE office_dallas.weekly_reports SET superseded_by_id = $1::uuid
            WHERE id = $2::uuid AND superseded_by_id IS NULL AND status = 'sent'`,
          [ids[index], ids[index - 1]],
        );
      }
    }

    return ids;
  }

  /** The common two-version shape: one send, one correction. */
  async function seedCorrectedWeek(
    v1: { deliveryStatus: string | null },
    v2: { deliveryStatus: string | null },
  ) {
    const ids = await seedWeek([{ deliveryStatus: v1.deliveryStatus }, { deliveryStatus: v2.deliveryStatus }]);
    return ids[1]!;
  }

  /**
   * THE FINDING GREPTILE CAUGHT ON THIS PR, and the reason `outstanding` exists as its own field.
   *
   * Suppressing every superseded row was right for `bounced -> delivered` and wrong here: the provider
   * ACCEPTING a correction is not the client receiving it. A week whose only hard evidence was a bounce
   * read as fully settled, on the one page whose entire job is answering "did they get it".
   */
  it("does not let a merely-accepted correction settle a week that bounced", async () => {
    const V2 = await seedCorrectedWeek({ deliveryStatus: "bounced" }, { deliveryStatus: null });

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    const outstanding = audit.reports.filter((r) => r.outstanding);
    expect(outstanding.map((r) => r.id)).toEqual([V2]);
    // The correction itself has no failure of its own — the flag is about the WEEK, and the page has to
    // be able to say "unconfirmed" rather than borrowing the red of the bounce it is fixing.
    expect(outstanding[0]!.undelivered).toBe(false);
  });

  it("settles the week once the correction is actually delivered", async () => {
    await seedCorrectedWeek({ deliveryStatus: "bounced" }, { deliveryStatus: "delivered" });

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports.filter((r) => r.outstanding)).toEqual([]);
  });

  /**
   * The control that keeps the fix narrow. Without the requirement that a PREVIOUS version FAILED, this
   * is the case that turns every report on the platform red for the minutes between the provider taking
   * it and the webhook coming back — which is precisely why `undelivered` does not flag it either.
   */
  it("leaves an ordinary send still waiting on the provider's verdict alone", async () => {
    await seedFullySentReport({ send_delivery_status: null });

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports.filter((r) => r.outstanding)).toEqual([]);
  });

  /** A correction can replace a version that arrived perfectly well — a wrong figure, a wrong photo. */
  it("leaves a correction alone when the version it replaced was delivered", async () => {
    await seedCorrectedWeek({ deliveryStatus: "delivered" }, { deliveryStatus: null });

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports.filter((r) => r.outstanding)).toEqual([]);
  });

  /**
   * GREPTILE'S SECOND FINDING, and the reason this compares versions instead of asking "did anything
   * fail". `v1 bounced → v2 delivered → v3 accepted` was flagged off v1 — a bounce the client's copy of
   * v2 had already made irrelevant — so a week they demonstrably received read as unresolved forever.
   *
   * A failure is spent once something later arrives. v3 is an ordinary correction in flight with
   * nothing behind it, which is precisely the case the narrow clause exists to leave alone.
   */
  it("does not resurrect a bounce that a later delivery already answered", async () => {
    await seedWeek([
      { deliveryStatus: "bounced" },
      { deliveryStatus: "delivered" },
      { deliveryStatus: null },
    ]);

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports.map((r) => r.version)).toEqual([3, 2, 1]);
    expect(audit.reports.filter((r) => r.outstanding)).toEqual([]);
  });

  /** The other side of it: a failure AFTER the last confirmed receipt is still unanswered. */
  it("flags a bounce that came after the last delivery the client is known to hold", async () => {
    const ids = await seedWeek([
      { deliveryStatus: "bounced" },
      { deliveryStatus: "delivered" },
      { deliveryStatus: "bounced" },
      { deliveryStatus: null },
    ]);

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports.filter((r) => r.outstanding).map((r) => r.id)).toEqual([ids[3]]);
  });

  it("counts a week once when both versions bounced, against the live one", async () => {
    const V2 = await seedCorrectedWeek({ deliveryStatus: "bounced" }, { deliveryStatus: "bounced" });

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    const outstanding = audit.reports.filter((r) => r.outstanding);
    expect(outstanding.map((r) => r.id)).toEqual([V2]);
    expect(outstanding[0]!.undelivered).toBe(true);
  });

  /**
   * A DRAFT is not a delivery problem, and a week can hold one alongside the live send: v1 bounces, v2
   * goes out as the correction, and the PM immediately starts a v3. All three rows are on this page and
   * only the sent one is anybody's problem.
   *
   * This exists because the `status === "sent"` half of the rule survived every other test in this file —
   * the fixtures all happened to send both versions, so nothing here could ever reach a live draft.
   * Deleting the predicate left the suite fully green while the page double-counted the week.
   */
  it("does not blame an in-progress draft for the failure it is being written to fix", async () => {
    const V2 = await seedCorrectedWeek({ deliveryStatus: "bounced" }, { deliveryStatus: null });
    await pg.query(
      `INSERT INTO office_dallas.weekly_reports
         (id, client_submission_id, weekly_report_project_id, deal_id, week_of, version, status, created_at)
       VALUES ($1::uuid, $4::uuid, $2::uuid, $3::uuid, '2026-08-13'::date, 3, 'draft',
               '2026-08-15T09:00:00Z'::timestamptz)`,
      [U("66663"), PROJECT, DEAL, U("77773")],
    );

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports.map((r) => r.version)).toEqual([3, 2, 1]);
    expect(audit.reports.filter((r) => r.outstanding).map((r) => r.id)).toEqual([V2]);
  });

  it("still flags a bounce that nothing has replaced", async () => {
    await seedFullySentReport({ send_delivery_status: "bounced" });

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports.filter((r) => r.outstanding).map((r) => r.version)).toEqual([1]);
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

describe("the record of who fetched the client's copy", () => {
  /** Record a fetch of the share link, as the public routes do. */
  async function seedView(opts: {
    at: string;
    eventType?: "page" | "pdf" | "photo";
    ip?: string;
    userAgent?: string;
  }) {
    await pg.query(
      `INSERT INTO public.weekly_report_views
         (weekly_report_id, event_type, occurred_at, ip, user_agent)
       VALUES ($1::uuid, $2, $3::timestamptz, $4::inet, $5)`,
      [
        REPORT,
        opts.eventType ?? "page",
        opts.at,
        opts.ip ?? "73.162.44.219",
        opts.userAgent ?? "Mozilla/5.0 (Macintosh) Chrome/141.0 Safari/537.36",
      ],
    );
  }

  it("does not count the client's mail scanner as the client opening it", async () => {
    // THE WHOLE REASON THIS IS CLASSIFIED. Proofpoint and its peers fetch every link within seconds of
    // delivery, so a raw open count says "opened!" on a report nobody read. Asserting that to a client
    // and being shown it was a datacentre discredits the rest of this page.
    // Committed 17:00:00, ACCEPTED by the provider 17:00:30 — client evidence starts at acceptance, and
    // a scanner fetches within seconds of THAT, not of the commit.
    await seedFullySentReport();
    await seedView({
      at: "2026-08-13T17:00:34.000Z",
      ip: "67.231.156.9",
      userAgent: "Mozilla/5.0 (compatible; ProofpointURLDefense/1.0)",
    });

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    const report = audit.reports[0]!;

    expect(report.viewSessions).toHaveLength(1);
    // The scanner's fetch is RECORDED, with the agent that identifies it — the page no longer decides
    // what it was, and that agent string is what lets a reader decide for themselves.
    expect(report.viewSessions).toHaveLength(1);
    expect(report.viewSessions[0]!.userAgent).toContain("Proofpoint");
  });

  it("records a real reader, with the address and browser to show for it", async () => {
    await seedFullySentReport();
    await seedView({ at: "2026-08-13T22:41:02.000Z" });
    await seedView({ at: "2026-08-13T22:41:05.000Z", eventType: "photo" });
    await seedView({ at: "2026-08-13T22:49:20.000Z", eventType: "pdf" });

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    const report = audit.reports[0]!;

    // THE FACTS, and no verdict. What a reader needs from this row is what was fetched, from where, and
    // on what — page, photo and PDF, one address, one browser, eight minutes apart. Whether that adds up
    // to a person is their judgement to make, and the row gives them everything it takes to make it.
    expect(report.viewSessions).toHaveLength(1);
    expect(report.viewSessions[0]!).toMatchObject({
      pageViews: 1,
      photoViews: 1,
      pdfDownloads: 1,
      // Bare, not CIDR: `inet` renders 73.162.44.219/32 and that reads as a subnet to anybody who
      // knows what one is.
      ip: "73.162.44.219",
    });
    expect(report.viewSessions[0]!.startedAt).toBe("2026-08-13T22:41:02.000Z");
    expect(report.viewSessions[0]!.endedAt).toBe("2026-08-13T22:49:20.000Z");
  });

  it("classifies against THIS report's send time, not another's", async () => {
    // The "arrived seconds after the email" signal is meaningless measured against a different report's
    // send. A shared timestamp would label a genuine reader of one week a scanner because their visit
    // happened to land near another week's send.
    await seedFullySentReport();
    // 5h41m after THIS report's 17:00 send — plainly a person's hour, not a scanner's.
    await seedView({ at: "2026-08-13T22:41:02.000Z" });
    // A PDF download rather than a photo burst: images inside the browser's lazy-load margin arrive
    // without anybody scrolling, so photos alone no longer carry "person" — the download does.
    await seedView({ at: "2026-08-13T22:41:06.000Z", eventType: "pdf" });

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);

    expect(audit.reports[0]!.viewSessions[0]!.pdfDownloads).toBe(1);
  });

  it("reports an unopened report as unopened rather than as unknown", async () => {
    // The answer to "we never got it" when nothing ever fetched the link. An empty list and a missing
    // one must not look the same to whoever is reading this in a dispute.
    await seedFullySentReport();

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);

    expect(audit.reports[0]!.viewSessions).toEqual([]);
    expect(audit.reports[0]!.viewSessions).toEqual([]);
  });

  /**
   * THE ONE THAT MANUFACTURES EVIDENCE.
   *
   * A link can be minted on an `approved` report — `isWeeklyReportShareableStatus` allows exactly that —
   * so checking a report before it goes out means opening the client's own URL. Those fetches are
   * logged, and a PM who scrolled the photos while checking is, to the classifier, indistinguishable
   * from a reader at the client: engagement is the signal, and the PM engaged.
   *
   * Counted, this page reports "opened at the client" about a report the client had not been sent. That
   * is the CRM inventing the evidence it exists to provide, and it would be said to a client's face.
   */
  it("does not count a staff check of the link before the send as a client open", async () => {
    await seedFullySentReport();
    await pg.query(
      `INSERT INTO public.weekly_report_views (weekly_report_id, event_type, occurred_at, ip, user_agent)
       VALUES ($1::uuid, 'page', '2026-08-13T16:30:00Z'::timestamptz, '10.9.9.9'::inet, 'Chrome'),
              ($1::uuid, 'pdf',  '2026-08-13T16:31:00Z'::timestamptz, '10.9.9.9'::inet, 'Chrome')`,
      [REPORT],
    );

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);

    // The send is stamped 17:00; both accesses above are half an hour EARLIER. Downloading the PDF is
    // the strongest person signal there is, which is exactly why leaving them in would be so convincing.
    expect(audit.reports[0]!.viewSessions).toEqual([]);
    expect(audit.reports[0]!.viewSessions).toEqual([]);
  });

  it("keeps a fetch that lands between the commit and the acceptance stamp", async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and the reversal is a deliberate trade rather than a
    // correction of an error.
    //
    // Gating on `send_delivered_at` excluded staff who open the link in the gap between pressing Send
    // and the worker recording the provider's acceptance. It also broke three ways: a genuine fetch
    // arriving before the worker got round to stamping was excluded PERMANENTLY; a send the provider
    // never accepted showed nothing at all, which the page rendered as nobody having opened it; and both
    // are silent, because a missing row looks exactly like an absent visitor.
    //
    // The gap is worker latency — usually seconds — and this page no longer says WHO fetched anything.
    // Losing real evidence to close a narrow window is the worse trade. `sent_at` still excludes the
    // case that mattered: a link minted on an `approved` report and opened before it was ever sent.
    // Caught by Codex.
    await seedFullySentReport({ send_delivered_at: "2026-08-13T17:30:00Z" });
    await pg.query(
      `INSERT INTO public.weekly_report_views (weekly_report_id, event_type, occurred_at, ip, user_agent)
       VALUES ($1::uuid, 'pdf', '2026-08-13T17:10:00Z'::timestamptz, '10.9.9.9'::inet, 'Chrome')`,
      [REPORT],
    );

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports[0]!.viewSessions).toHaveLength(1);
  });

  it("still shows fetches on a send the provider never accepted", async () => {
    // No acceptance stamp at all — a send that failed or is still in flight. Gating on acceptance made
    // this report show nothing, and an empty log is the one thing this page must not over-read.
    await seedFullySentReport({ send_delivered_at: null });
    await pg.query(
      `INSERT INTO public.weekly_report_views (weekly_report_id, event_type, occurred_at, ip, user_agent)
       VALUES ($1::uuid, 'page', '2026-08-13T18:00:00Z'::timestamptz, '10.9.9.9'::inet, 'Chrome')`,
      [REPORT],
    );

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports[0]!.viewSessions).toHaveLength(1);
  });

  it("admits an access once the provider has accepted it", async () => {
    await seedFullySentReport({ send_delivered_at: "2026-08-13T17:30:00Z" });
    await pg.query(
      `INSERT INTO public.weekly_report_views (weekly_report_id, event_type, occurred_at, ip, user_agent)
       VALUES ($1::uuid, 'pdf', '2026-08-13T17:31:00Z'::timestamptz, '10.9.9.9'::inet, 'Chrome')`,
      [REPORT],
    );

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports[0]!.viewSessions.length).toBeGreaterThan(0);
  });

  it("still counts an access after the send — the control", async () => {
    await seedFullySentReport();
    await pg.query(
      `INSERT INTO public.weekly_report_views (weekly_report_id, event_type, occurred_at, ip, user_agent)
       VALUES ($1::uuid, 'pdf', '2026-08-13T18:00:00Z'::timestamptz, '10.9.9.9'::inet, 'Chrome')`,
      [REPORT],
    );

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports[0]!.viewSessions.length).toBeGreaterThan(0);
  });

  it("keeps an access that lands on the send instant exactly", async () => {
    // The boundary value, and it is not hypothetical: a mail-security scanner fetches the link the
    // moment the provider accepts the message, which is the instant `send_delivered_at` records. `>`
    // instead of `>=` drops that access silently — the one fetch most likely to share the boundary's
    // timestamp — and every other fixture sits comfortably to one side of the line.
    await seedFullySentReport();
    await pg.query(
      `INSERT INTO public.weekly_report_views (weekly_report_id, event_type, occurred_at, ip, user_agent)
       VALUES ($1::uuid, 'page', '2026-08-13T17:00:30Z'::timestamptz, '10.4.4.4'::inet, 'Chrome')`,
      [REPORT],
    );

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports[0]!.viewSessions).toHaveLength(1);
  });

  it("bounds one report's accesses and says so, rather than loading all of them", async () => {
    // The rows come from a route with NO LOGIN: 300 requests a minute per address, tokens good for 180
    // days. A crawler in a redirect loop — or somebody who simply wants this page to stop working — can
    // put millions of rows behind one report, and an unbounded read pulled every one into the API
    // process and grouped them there long after the traffic stopped.
    //
    // 520 rows against a cap of 100, at three-second intervals — and the interval is load-bearing. The
    // cap keeps the EARLIEST rows, so it also decides the span the classifier measures: at one-second
    // steps the kept 100 span 99 seconds, fall under the reading threshold, and the verdict drops from
    // person to unclear. A cap can change a verdict, which is worth knowing and worth a fixture that
    // does not hide it.
    await seedFullySentReport();
    await pg.query(
      `INSERT INTO public.weekly_report_views (weekly_report_id, event_type, occurred_at, ip, user_agent)
       SELECT $1::uuid, 'photo', '2026-08-13T17:05:00Z'::timestamptz + (n * 3 || ' seconds')::interval,
              '10.5.5.5'::inet, 'Chrome'
         FROM generate_series(1, 520) AS n`,
      [REPORT],
    );

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);

    // Announced, not swallowed. A cap nobody is told about reads as a complete record, and somebody
    // counting opens off this page in a dispute would be counting a prefix without knowing it.
    expect(audit.reports[0]!.viewSessionsTruncated).toBe(true);
    expect(audit.reports[0]!.viewSessions.length).toBeGreaterThan(0);
  });

  it("keeps the one real reader buried under a flood of scanner traffic", async () => {
    // THE CASE THE CAP ITSELF BROKE, and the reason its ordering is not arbitrary.
    //
    // 600 page requests from a scanner, and then — later, past any earliest-N window — one person who
    // downloads the PDF. Taking simply "the earliest 500" drops that download entirely, so the record
    // loses the single most valuable row in it — the one action nothing automated performs by accident.
    await seedFullySentReport();
    await pg.query(
      `INSERT INTO public.weekly_report_views (weekly_report_id, event_type, occurred_at, ip, user_agent)
       SELECT $1::uuid, 'page', '2026-08-13T17:00:30Z'::timestamptz + (n || ' milliseconds')::interval,
              '10.7.7.7'::inet, 'Barracuda Link Protect'
         FROM generate_series(1, 600) AS n`,
      [REPORT],
    );
    await pg.query(
      `INSERT INTO public.weekly_report_views (weekly_report_id, event_type, occurred_at, ip, user_agent)
       VALUES ($1::uuid, 'pdf', '2026-08-22T14:00:00Z'::timestamptz, '73.162.44.219'::inet,
               'Mozilla/5.0 (Macintosh) Chrome/141.0')`,
      [REPORT],
    );

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);

    expect(audit.reports[0]!.viewSessions.length).toBeGreaterThan(0);
    expect(audit.reports[0]!.viewSessionsTruncated).toBe(true);
  });

  it("does not warn about truncation at exactly the cap", async () => {
    // The off-by-one. Truncation is `count > CAP`, so exactly CAP rows must report false — a warning on a
    // complete log is the same class of lie as a missing one on an incomplete log, pointed the other
    // way, and the 520-row case above cannot see the boundary. Flagged by CodeRabbit. Seeded from the
    // constant's value rather than a literal 500, which is what went stale when the cap moved.
    await seedFullySentReport();
    await pg.query(
      `INSERT INTO public.weekly_report_views (weekly_report_id, event_type, occurred_at, ip, user_agent)
       SELECT $1::uuid, 'page', '2026-08-13T17:05:00Z'::timestamptz + (n || ' milliseconds')::interval,
              '10.5.5.5'::inet, 'Chrome'
         FROM generate_series(1, 100) AS n`,
      [REPORT],
    );

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports[0]!.viewSessionsTruncated).toBe(false);
  });

  it("keeps engagement and page budgets separate, so a flood cannot crowd out the reader", async () => {
    // Engagement and page requests are read through SEPARATE bounded queries rather than competing for
    // one budget. 600 scanner page hits plus a handful of real photo fetches: the page bucket is
    // truncated, the photo fetches all survive, and the reader is still visible.
    await seedFullySentReport();
    await pg.query(
      `INSERT INTO public.weekly_report_views (weekly_report_id, event_type, occurred_at, ip, user_agent)
       SELECT $1::uuid, 'page', '2026-08-13T17:00:30Z'::timestamptz + (n || ' milliseconds')::interval,
              '10.7.7.7'::inet, 'Barracuda Link Protect'
         FROM generate_series(1, 600) AS n`,
      [REPORT],
    );
    await pg.query(
      `INSERT INTO public.weekly_report_views (weekly_report_id, event_type, occurred_at, ip, user_agent)
       SELECT $1::uuid, 'photo', '2026-08-25T14:00:00Z'::timestamptz + (n || ' minutes')::interval,
              '73.162.44.219'::inet, 'Mozilla/5.0 (Macintosh) Chrome/141.0'
         FROM generate_series(1, 4) AS n`,
      [REPORT],
    );

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);

    expect(audit.reports[0]!.viewSessions.length).toBeGreaterThan(0);
    expect(audit.reports[0]!.viewSessionsTruncated).toBe(true);
  });

  it("does not claim truncation on an ordinary report", async () => {
    // The control. A flag that is always true is as useless as one that is never set, and "we only show
    // some of this" on a report with four accesses would undermine the page it appears on.
    await seedFullySentReport();
    await pg.query(
      `INSERT INTO public.weekly_report_views (weekly_report_id, event_type, occurred_at, ip, user_agent)
       VALUES ($1::uuid, 'page', '2026-08-13T17:05:00Z'::timestamptz, '10.5.5.5'::inet, 'Chrome')`,
      [REPORT],
    );

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.reports[0]!.viewSessionsTruncated).toBe(false);
  });

  it("says the log's horizon is UNKNOWN rather than inventing one", async () => {
    // This suite builds its schema from the SQL files, so there is no `_migrations` ledger to read the
    // start of logging from — and with no view rows either, there is nothing to infer it from.
    //
    // The first version substituted the retention floor here, which asserts logging has been running a
    // full 24 months when the table might be a week old. Every week in between would then render as
    // "nobody opened the link" out of a gap in our own records — the exact finding this horizon exists
    // to prevent, reintroduced by its own fallback. Null is the honest answer and the page renders it
    // as "not on record". Caught by Codex.
    await seedFullySentReport();
    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.viewTrackingSince).toBeNull();
  });

  it("takes the oldest recorded access as the horizon once there is one", async () => {
    // A row is proof logging existed by then — a sound floor, and conservative in the safe direction:
    // it can only place the start LATER than the truth, which marks more weeks unknown, never fewer.
    await seedFullySentReport();
    await seedView({ at: "2026-08-13T22:41:02.000Z" });

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    expect(audit.viewTrackingSince).toBe("2026-08-13T22:41:02.000Z");
  });

  it("keeps one report's accesses off another's", async () => {
    const OTHER = U("66669");
    await seedFullySentReport();
    await pg.query(
      // `sent_at` stamped, because a `sent` row without one is a state `transitionWeeklyReport` cannot
      // produce — and client-open evidence is now bounded to accesses AT OR AFTER the send, so a fixture
      // missing it would silently contribute no sessions and quietly stop testing what it names.
      // `send_delivered_at` too: client evidence starts at PROVIDER ACCEPTANCE, so a row with only a
      // commit stamp contributes no sessions at all and the test would stop testing what it names.
      `INSERT INTO office_dallas.weekly_reports
         (id, client_submission_id, weekly_report_project_id, deal_id, week_of, status, sent_at,
          send_delivered_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-08-06'::date, 'sent',
               '2026-08-06T17:00:00Z'::timestamptz, '2026-08-06T17:00:30Z'::timestamptz)`,
      [OTHER, U("77779"), PROJECT, DEAL],
    );
    await pg.query(
      `INSERT INTO public.weekly_report_views (weekly_report_id, event_type, occurred_at, ip, user_agent)
       VALUES ($1::uuid, 'pdf', '2026-08-07T10:00:00Z'::timestamptz, '10.1.1.1'::inet, 'Chrome')`,
      [OTHER],
    );

    const audit = await getWeeklyReportProjectAudit(db as any, PROJECT);
    const week13 = audit.reports.find((r) => r.weekOf === "2026-08-13")!;
    const week06 = audit.reports.find((r) => r.weekOf === "2026-08-06")!;

    expect(week13.viewSessions).toEqual([]);
    expect(week06.viewSessions).toHaveLength(1);
  });
});
