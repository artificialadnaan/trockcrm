// Runtime suite for WEEK-TO-WEEK CONTINUITY.
//
// Each week's report used to be written as if no report had ever come before it: the percentage blank,
// the weather total blank, and last week's plan readable only by going and opening last week's report.
// A new draft now starts from the previous one.
//
// The interesting part is not the copying, it is WHICH ROW is copied from. Four predicates decide it and
// each of them is a way to be quietly wrong for weeks — carrying a number out of an abandoned draft, out
// of a version a correction already fixed, or out of a week that comes AFTER the one being filed. None
// of those throw. They just make the client's report say something untrue, one week at a time.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deals, fieldResponders, files, offices, userOfficeAccess, users } from "@trock-crm/shared/schema";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import { migrationSql } from "../../helpers/migration-sql.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import {
  createWeeklyReportDraft,
  previousWeeklyReportForCarryOver,
} from "../../../src/modules/weekly-reports/reports-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const OFFICE = U("00001");
const DEAL = U("11111");
const SUPER = U("22222");
const SUPER_RESPONDER = U("44442");
const WON_STAGE = U("33331");
const PROJECT = U("55551");

const SUPER_ACTOR = { id: SUPER, role: "construction" };
const THURSDAY = 4;

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
  await pg.exec(migrationSql("0229_weekly_report_rep_escalation_kind"));
  await pg.exec(migrationSql("0230_weekly_reports_carried_from"));

  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES ('${OFFICE}', 'Dallas', 'dallas');
    INSERT INTO public.users (id, display_name, email, role, office_id) VALUES
      ('${SUPER}', 'Steve Sanchez', 'super@example.com', 'construction', '${OFFICE}');
    INSERT INTO public.pipeline_stage_config (id, slug) VALUES ('${WON_STAGE}', '${WON_DEAL_STAGE_SLUGS[0]}');
    INSERT INTO office_dallas.deals (id, name, deal_number, stage_id, project_number) VALUES
      ('${DEAL}', '4123 Cedar Springs', 'DFW-10432', '${WON_STAGE}', 'DFW-10432');
    INSERT INTO office_dallas.field_responders (id, name, email, role) VALUES
      ('${SUPER_RESPONDER}', 'Steve Sanchez', 'super@example.com', 'superintendent');
    SET search_path TO office_dallas, public;
  `);
  db = { query: (text: any, params?: any) => pg.query(text, params) } as any;
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM office_dallas.weekly_reports;`);
  await pg.exec(`DELETE FROM office_dallas.weekly_report_projects;`);
  await pg.query(
    `INSERT INTO office_dallas.weekly_report_projects
       (id, deal_id, property_display_name, trock_super_responder_id, trock_super_user_id,
        cadence_weekday, cadence_start_date, projected_duration_weeks)
     VALUES ($1::uuid, $2::uuid, '4123 Cedar Springs', $3::uuid, $4::uuid, ${THURSDAY}, '2026-07-01', 19)`,
    [PROJECT, DEAL, SUPER_RESPONDER, SUPER],
  );
});

let seq = 0;

/** A report on a past week, in whatever state the case under test needs. */
async function seedPastReport(opts: {
  weekOf: string;
  status?: string;
  version?: number;
  percent?: string | null;
  weatherDays?: number | null;
  lookAhead?: string | null;
  supersededBy?: string | null;
  isActive?: boolean;
}): Promise<string> {
  seq += 1;
  const id = U(`6666${seq}`);
  await pg.query(
    `INSERT INTO office_dallas.weekly_reports
       (id, client_submission_id, weekly_report_project_id, deal_id, week_of, version, status,
        work_completed, next_week_look_ahead, completion_percent, weather_delay_days,
        superseded_by_id, is_active)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6, $7,
             'something was done', $8, $9::numeric, $10, $11::uuid, $12)`,
    [
      id,
      U(`7777${seq}`),
      PROJECT,
      DEAL,
      opts.weekOf,
      opts.version ?? 1,
      opts.status ?? "sent",
      opts.lookAhead ?? null,
      opts.percent ?? null,
      opts.weatherDays ?? null,
      opts.supersededBy ?? null,
      opts.isActive ?? true,
    ],
  );
  return id;
}

async function openWeek(weekOf: string) {
  seq += 1;
  const { report } = await createWeeklyReportDraft(
    db as any,
    { clientSubmissionId: U(`8888${seq}`), weeklyReportProjectId: PROJECT, weekOf },
    SUPER_ACTOR,
  );
  return report;
}

describe("what a new week starts from", () => {
  it("carries the percentage, the weather total and last week's plan", async () => {
    const previous = await seedPastReport({
      weekOf: "2026-08-13",
      percent: "45.00",
      weatherDays: 5,
      lookAhead: "- Complete sample balcony coat\n- David D. onsite 8/18-8/19",
    });

    const report = await openWeek("2026-08-20");

    expect(report.completionPercent).toBe(45);
    expect(report.weatherDelayDays).toBe(5);
    // Last week's PLAN becomes this week's starting point for what was done — the whole feature.
    expect(report.workCompleted).toContain("Complete sample balcony coat");
    expect(report.carriedFromReportId).toBe(previous);
  });

  it("starts blank when there is no previous report at all", async () => {
    const report = await openWeek("2026-08-20");

    expect(report.completionPercent).toBeNull();
    expect(report.weatherDelayDays).toBeNull();
    expect(report.workCompleted).toBeNull();
    expect(report.carriedFromReportId).toBeNull();
  });

  it("does NOT carry from a draft somebody abandoned half-filled", async () => {
    // A draft is not a statement about the job. Carrying 10% out of an abandoned one would report a
    // number to the client that its own author never stood behind.
    await seedPastReport({ weekOf: "2026-08-13", status: "draft", percent: "10.00", weatherDays: 99 });

    const report = await openWeek("2026-08-20");

    expect(report.completionPercent).toBeNull();
    expect(report.weatherDelayDays).toBeNull();
  });

  it("takes the CORRECTION's number, not the one it replaced", async () => {
    // The superseded row holds the number the correction existed to fix. Carrying it forward would
    // propagate the error into every week after it, silently.
    //
    // Note what does the work here: `ORDER BY week_of DESC, version DESC`. A correction is written as a
    // new row with version + 1, so the surviving version always outranks the one it replaced. An
    // explicit `superseded_by_id IS NULL` predicate looks like it is carrying this test and is not —
    // it was removed after mutation testing showed nothing could make it fire.
    const correction = await seedPastReport({ weekOf: "2026-08-13", version: 2, percent: "45.00" });
    await seedPastReport({
      weekOf: "2026-08-13",
      version: 1,
      percent: "80.00", // the wrong number, corrected above
      supersededBy: correction,
    });

    const report = await openWeek("2026-08-20");

    expect(report.completionPercent).toBe(45);
  });

  it("still carries from an original whose correction was abandoned and deleted", async () => {
    // THE CASE THAT KILLED THE `superseded_by_id IS NULL` PREDICATE. A correction is started, so the
    // original is stamped as superseded, and then the correction is abandoned and soft-deleted. The
    // original is now marked superseded AND is the only live version — and it is exactly the report the
    // client actually received.
    //
    // Skipping it would carry from a week further back and under-report progress to that client for
    // every week afterwards. `is_active` removes the dead correction; nothing should remove this row.
    const abandoned = U("66690");
    const original = await seedPastReport({ weekOf: "2026-08-13", version: 1, percent: "45.00" });
    await pg.query(
      `INSERT INTO office_dallas.weekly_reports
         (id, client_submission_id, weekly_report_project_id, deal_id, week_of, version, status, is_active)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-08-13'::date, 2, 'draft', false)`,
      [abandoned, U("77790"), PROJECT, DEAL],
    );
    await pg.query(`UPDATE office_dallas.weekly_reports SET superseded_by_id = $1::uuid WHERE id = $2::uuid`, [
      abandoned,
      original,
    ]);
    // An earlier week exists, so "carried from nothing" and "carried from the right row" are
    // distinguishable — without it a wrong answer and a null would look the same.
    await seedPastReport({ weekOf: "2026-08-06", percent: "20.00" });

    const report = await openWeek("2026-08-20");

    expect(report.completionPercent).toBe(45);
    expect(report.carriedFromReportId).toBe(original);
  });

  it("does NOT carry from a LATER week when an earlier one is filed late", async () => {
    // Week 8 is already on the board; week 6 is being filed late. It must inherit from week 5, not
    // from the future — otherwise a late filing claims progress that had not happened yet.
    await seedPastReport({ weekOf: "2026-08-06", percent: "30.00" });
    await seedPastReport({ weekOf: "2026-08-20", percent: "70.00" });

    const report = await openWeek("2026-08-13");

    expect(report.completionPercent).toBe(30);
  });

  it("does NOT carry from a soft-deleted report", async () => {
    await seedPastReport({ weekOf: "2026-08-13", percent: "45.00", isActive: false });

    const report = await openWeek("2026-08-20");

    expect(report.completionPercent).toBeNull();
  });

  it("carries a null as a null, never as zero", async () => {
    // "Nobody has said yet" and "zero percent complete" are different claims about a job, and the PDF
    // prints them differently. A `?? 0` here would tell every client the work had not started.
    await seedPastReport({ weekOf: "2026-08-13", percent: null, weatherDays: null, lookAhead: null });

    const report = await openWeek("2026-08-20");

    expect(report.completionPercent).toBeNull();
    expect(report.weatherDelayDays).toBeNull();
  });

  it("takes the latest surviving version of a corrected week", async () => {
    const v2 = await seedPastReport({ weekOf: "2026-08-13", version: 2, percent: "50.00", weatherDays: 7 });

    const report = await openWeek("2026-08-20");

    expect(report.completionPercent).toBe(50);
    expect(report.carriedFromReportId).toBe(v2);
  });

  it("keeps the stored scale of the percentage rather than rounding it", async () => {
    // `numeric` arrives from node-postgres as a string. Parsing it on the way through and writing a
    // JS number back loses the column's scale.
    await seedPastReport({ weekOf: "2026-08-13", percent: "45.50" });

    await openWeek("2026-08-20");

    const stored = await pg.query<{ p: string }>(
      `SELECT completion_percent::text AS p FROM office_dallas.weekly_reports WHERE week_of = '2026-08-20'`,
    );
    expect(stored.rows[0]?.p).toBe("45.50");
  });

  it("re-opening the same week returns the existing row and re-carries nothing", async () => {
    // The idempotent arm. A phone retrying over flaky LTE must not re-apply a prefill over text the
    // superintendent has since typed — this is the property the whole design rests on.
    await seedPastReport({ weekOf: "2026-08-13", lookAhead: "- carried plan" });
    const first = await openWeek("2026-08-20");

    await pg.query(`UPDATE office_dallas.weekly_reports SET work_completed = $1 WHERE id = $2::uuid`, [
      "what actually happened",
      first.id,
    ]);

    const again = await createWeeklyReportDraft(
      db as any,
      {
        clientSubmissionId: U(`8888${seq}`), // the SAME submission id — a retry, not a new week
        weeklyReportProjectId: PROJECT,
        weekOf: "2026-08-20",
      },
      SUPER_ACTOR,
    );

    expect(again.created).toBe(false);
    expect(again.report.workCompleted).toBe("what actually happened");
  });
});

describe("previousWeeklyReportForCarryOver", () => {
  it("returns null rather than throwing when the project has no history", async () => {
    expect(await previousWeeklyReportForCarryOver(db as any, PROJECT, "2026-08-20")).toBeNull();
  });

  it("is exclusive on the week being opened, so a week never carries from itself", async () => {
    // `week_of <`, not `<=`. A correction being drafted over the SAME week must not seed itself from
    // the version it is replacing.
    await seedPastReport({ weekOf: "2026-08-20", percent: "60.00" });

    expect(await previousWeeklyReportForCarryOver(db as any, PROJECT, "2026-08-20")).toBeNull();
  });
});
