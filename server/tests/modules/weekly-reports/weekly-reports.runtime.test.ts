// Runtime suite for Weekly Reports.
//
// The schema under test is migration 0222 READ FROM DISK — the file that actually ships — rather than a
// hand-copied CREATE TABLE block. That matters more here than usual: the feature's two load-bearing
// guarantees (a caption that never writes back to files.description, and a PM gate no superintendent can
// step around) are both enforced partly by the schema's shape.
//
// The whole migration runs, DO-loop included, against a real `office_dallas` schema, and then runs a
// SECOND time to prove the replayability the migration claims.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deals, files, offices, users } from "@trock-crm/shared/schema";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import { migrationSql } from "../../helpers/migration-sql.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { AppError } from "../../../src/middleware/error-handler.js";
import {
  createWeeklyReportProject,
  deactivateWeeklyReportProject,
  getWeeklyReportProject,
  getWeeklyReportSettings,
  listWeeklyReportAssignableUsers,
  listWeeklyReportProjects,
  updateWeeklyReportProject,
  updateWeeklyReportSettings,
} from "../../../src/modules/weekly-reports/projects-service.js";
import {
  canTransitionAs,
  createWeeklyReportDraft,
  getWeeklyReportDetail,
  listWeeklyReportPhotoCandidates,
  listWeeklyReports,
  replaceWeeklyReportPhotos,
  transitionWeeklyReport,
  updateWeeklyReportContent,
} from "../../../src/modules/weekly-reports/reports-service.js";
import {
  dismissWeeklyReportWeek,
  getWeeklyReportDashboard,
  listWeeklyReportProjectSummaries,
} from "../../../src/modules/weekly-reports/dashboard-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const OFFICE = U("00001");
const DEAL = U("11111");
const OTHER_DEAL = U("11112");
const PM = U("22221");
const SUPER = U("22222");
const DIRECTOR = U("22223");
const STRANGER = U("22224");
const OPEN_DEAL = U("11113");
const WON_STAGE = U("33331");
const OPEN_STAGE = U("33332");

const PM_ACTOR = { id: PM, role: "construction" };
const SUPER_ACTOR = { id: SUPER, role: "construction" };
const DIRECTOR_ACTOR = { id: DIRECTOR, role: "director" };
const STRANGER_ACTOR = { id: STRANGER, role: "rep" };

// The reference report's week: Thursday 2026-08-13.
const THURSDAY = 4;
const WEEK_OF = "2026-08-13";
const PRIOR_WEEK = "2026-08-06";

let pg: PGlite;

/**
 * PGlite exposes `query`; the services only need that much of a PoolClient.
 *
 * `rowCount` comes from PGlite's own `affectedRows`, NOT from `rows.length`. Deriving it from the rows
 * reports 0 for every UPDATE without a RETURNING clause, which is the opposite of what node-postgres
 * does — a harness that lies in that direction makes "the write was rejected" and "the write succeeded"
 * indistinguishable.
 */
const db = {
  query: async (text: string, params?: unknown[]) => {
    const result = await pg.query(text, params as any[]);
    return {
      rows: result.rows as any[],
      rowCount: (result as { affectedRows?: number }).affectedRows ?? result.rows.length,
    } as any;
  },
};

/**
 * A `db` that fires a concurrent send at a chosen moment mid-call.
 *
 * The races these guards exist for open BETWEEN the read the permission check runs against and the
 * write that follows it. Mutating the row before the call instead lands on the up-front sent-report
 * guard and proves nothing, so this wrapper marks the report `sent` immediately before the first
 * statement matching `trigger` — standing in for another request committing in that window.
 */
function racingDb(reportId: string, trigger: string) {
  let fired = false;
  return {
    query: async (text: string, params?: unknown[]) => {
      if (!fired && text.includes(trigger)) {
        fired = true;
        await pg.query(`UPDATE office_dallas.weekly_reports SET status = 'sent' WHERE id = $1::uuid`, [reportId]);
      }
      return db.query(text, params);
    },
  } as typeof db;
}

/**
 * Assert a call fails with a specific AppError status.
 *
 * Deliberately awaits ONCE and fails loudly when the promise resolves — a helper that only asserts
 * inside a `catch` reports success for a call that did not throw at all, which is precisely backwards
 * for a suite whose job is proving that unauthorised writes are refused.
 */
async function expectAppError(promise: Promise<unknown>, status: number, matcher?: RegExp) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) {
    throw new Error(`Expected an AppError ${status}, but the call resolved successfully`);
  }
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).statusCode).toBe(status);
  if (matcher) expect((caught as AppError).message).toMatch(matcher);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_dallas;`);
  // Prerequisite graph, derived from the SAME Drizzle definitions prod is generated from rather than
  // hand-rolled, so a column type here cannot drift from production.
  await pg.exec(tenantSchemaSql("public", [offices, users]));
  await pg.exec(tenantSchemaSql("office_dallas", [deals, files]));
  // Weekly reports may only be set up on a WON deal, so the suite needs the stage graph the check reads.
  await pg.exec(
    `CREATE TABLE IF NOT EXISTS public.pipeline_stage_config (id uuid PRIMARY KEY, slug text);`,
  );

  // The migration under test — DO-loop, public tables and TENANT_SCHEMA block, verbatim from disk.
  await pg.exec(migrationSql("0222_weekly_reports"));

  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES ('${OFFICE}', 'Dallas', 'dallas');
    INSERT INTO public.users (id, display_name, email, role, office_id) VALUES
      ('${PM}', 'Adam Sherwood', 'pm@example.com', 'construction', '${OFFICE}'),
      ('${SUPER}', 'Steve Sanchez', 'super@example.com', 'construction', '${OFFICE}'),
      ('${DIRECTOR}', 'Takashi', 'director@example.com', 'director', '${OFFICE}'),
      ('${STRANGER}', 'Nobody', 'nobody@example.com', 'rep', '${OFFICE}');
    INSERT INTO public.pipeline_stage_config (id, slug) VALUES
      ('${WON_STAGE}', '${WON_DEAL_STAGE_SLUGS[0]}'),
      ('${OPEN_STAGE}', 'estimating');
    INSERT INTO office_dallas.deals (id, name, deal_number, stage_id, project_number) VALUES
      ('${DEAL}', '4123 Cedar Springs', 'DFW-10432', '${WON_STAGE}', 'DFW-10432'),
      ('${OTHER_DEAL}', 'Some Other Job', 'DFW-10433', '${WON_STAGE}', 'DFW-10433'),
      ('${OPEN_DEAL}', 'Still Bidding', 'DFW-10434', '${OPEN_STAGE}', 'DFW-10434');
    SET search_path TO office_dallas, public;
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM office_dallas.weekly_report_photos;
    DELETE FROM office_dallas.weekly_report_dismissals;
    DELETE FROM office_dallas.weekly_report_reminders_sent;
    DELETE FROM office_dallas.weekly_reports;
    DELETE FROM office_dallas.weekly_report_projects;
    DELETE FROM office_dallas.weekly_report_settings;
    DELETE FROM office_dallas.files;
  `);
});

function baseProjectInput(overrides: Record<string, unknown> = {}) {
  return {
    dealId: DEAL,
    propertyDisplayName: "4123 Cedar Springs",
    clientName: "Mack Real Estate Group",
    clientTeam: {
      doc: { name: "Jay Stauble", email: "jay@example.com" },
      pm: { name: "Melissa Garcia", email: "melissa@example.com" },
    },
    trockPmUserId: PM,
    trockSuperUserId: SUPER,
    contractDate: "2026-07-08",
    projectStartDateNote: "TBD Permit",
    projectedDurationWeeks: 19,
    cadenceWeekday: THURSDAY,
    cadenceStartDate: "2026-07-27",
    ...overrides,
  } as any;
}

async function seedProject(overrides: Record<string, unknown> = {}) {
  return createWeeklyReportProject(db, baseProjectInput(overrides), DIRECTOR, OFFICE);
}

let photoSeq = 0;
async function seedPhoto(input: { dealId?: string; takenAt: string; description?: string | null }) {
  photoSeq += 1;
  const id = U(`9${String(photoSeq).padStart(4, "0")}`);
  const filename = `photo-${photoSeq}.jpg`;
  await pg.query(
    `INSERT INTO office_dallas.files (
       id, category, display_name, system_filename, original_filename, mime_type,
       file_size_bytes, file_extension, r2_key, r2_bucket, uploaded_by,
       deal_id, description, taken_at
     ) VALUES (
       $1::uuid, 'photo', $2, $2, $2, 'image/jpeg',
       1024, 'jpg', $3, 'test-bucket', $4::uuid,
       $5::uuid, $6, $7::timestamptz
     )`,
    [id, filename, `k/${filename}`, SUPER, input.dealId ?? DEAL, input.description ?? null, `${input.takenAt}T15:00:00Z`],
  );
  return id;
}

describe("migration 0222", () => {
  it("is replayable — running it a second time is a no-op, not an error", async () => {
    await expect(pg.exec(migrationSql("0222_weekly_reports"))).resolves.toBeDefined();
  });

  it("creates the same tables for a new tenant as the DO-loop creates for existing ones", async () => {
    // The TENANT_SCHEMA block and the DO-loop are two hand-maintained copies of the same DDL; a column
    // added to one and not the other silently gives new offices a different schema.
    const result = await pg.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'office_dallas' AND table_name LIKE 'weekly_report%'
        ORDER BY table_name, column_name`,
    );
    const columns = result.rows.map((r) => `${r.table_name}.${r.column_name}`);
    expect(columns).toContain("weekly_report_projects.cadence_weekday");
    expect(columns).toContain("weekly_reports.superseded_by_id");
    expect(columns).toContain("weekly_report_photos.caption");
    expect(columns).toContain("weekly_report_dismissals.reason");
    expect(columns).toContain("weekly_report_reminders_sent.kind");
    expect(columns).toContain("weekly_report_settings.leadership_recipient_emails");
  });

  it("rejects a cadence weekday outside 0-6 at the database level", async () => {
    await expect(
      pg.query(
        `INSERT INTO office_dallas.weekly_report_projects (deal_id, cadence_weekday, cadence_start_date)
         VALUES ($1::uuid, 9, '2026-07-27')`,
        [DEAL],
      ),
    ).rejects.toThrow();
  });

  it("allows only one live setup per deal", async () => {
    await seedProject();
    await expectAppError(seedProject(), 409, /already has a weekly report setup/i);
  });
});

describe("project setup", () => {
  it("round-trips every field the report prints", async () => {
    const created = await seedProject();
    const read = await getWeeklyReportProject(db, created.id);
    expect(read).toMatchObject({
      propertyDisplayName: "4123 Cedar Springs",
      clientName: "Mack Real Estate Group",
      trockPmName: "Adam Sherwood",
      trockSuperName: "Steve Sanchez",
      contractDate: "2026-07-08",
      projectStartDate: null,
      projectStartDateNote: "TBD Permit",
      projectedDurationWeeks: 19,
      cadenceWeekday: THURSDAY,
    });
    expect(read!.clientTeam.doc).toEqual({ name: "Jay Stauble", email: "jay@example.com" });
    // Unset roles come back as an explicit empty pair rather than being absent, so the form can render
    // four rows without special-casing.
    expect(read!.clientTeam.rm).toEqual({ name: null, email: null });
  });

  it("keeps a date and its note independent, as the reference report needs", async () => {
    // "Project Start Date: TBD Permit" — a note in place of a date, with the date genuinely unknown.
    const created = await seedProject();
    expect(created.projectStartDate).toBeNull();
    expect(created.projectStartDateNote).toBe("TBD Permit");
  });

  it("rejects a malformed client email at setup rather than at send time", async () => {
    await expectAppError(
      seedProject({ clientTeam: { doc: { name: "Jay", email: "not-an-email" } } }),
      400,
      /valid email/i,
    );
  });

  it("rejects a cadence end date that precedes the start", async () => {
    await expectAppError(seedProject({ cadenceEndDate: "2026-07-01" }), 400, /cannot precede/i);
  });

  it("patches one field without clearing the others", async () => {
    const created = await seedProject();
    const updated = await updateWeeklyReportProject(db, created.id, { clientName: "New Client LLC" }, OFFICE);
    expect(updated.clientName).toBe("New Client LLC");
    // The bug this guards: a PATCH built from the patch alone nulls every column the caller omitted.
    expect(updated.propertyDisplayName).toBe("4123 Cedar Springs");
    expect(updated.trockPmUserId).toBe(PM);
    expect(updated.projectedDurationWeeks).toBe(19);
    expect(updated.clientTeam.doc.name).toBe("Jay Stauble");
  });

  it("distinguishes an omitted field from an explicit null", async () => {
    const created = await seedProject();
    const cleared = await updateWeeklyReportProject(db, created.id, { clientName: null }, OFFICE);
    expect(cleared.clientName).toBeNull();
    expect(cleared.propertyDisplayName).toBe("4123 Cedar Springs");
  });

  it("validates cross-field rules against the MERGED row, not the patch", async () => {
    const created = await seedProject();
    // cadenceEndDate alone would pass a patch-only check — it has no start date to compare against.
    await expectAppError(
      updateWeeklyReportProject(db, created.id, { cadenceEndDate: "2026-07-01" }, OFFICE),
      400,
      /cannot precede/i,
    );
  });

  it("swapping the PM mid-project changes who is assigned, not the history", async () => {
    const created = await seedProject();
    const updated = await updateWeeklyReportProject(db, created.id, { trockPmUserId: DIRECTOR }, OFFICE);
    expect(updated.trockPmUserId).toBe(DIRECTOR);
    expect(updated.trockPmName).toBe("Takashi");
  });

  it("soft-deletes so past reports keep resolving", async () => {
    const created = await seedProject();
    await deactivateWeeklyReportProject(db, created.id);
    expect(await listWeeklyReportProjects(db)).toHaveLength(0);
    // The row survives — a public link minted against it is live for 180 days.
    const raw = await pg.query(`SELECT is_active FROM office_dallas.weekly_report_projects WHERE id = $1::uuid`, [
      created.id,
    ]);
    expect((raw.rows[0] as any).is_active).toBe(false);
  });

  it("frees the deal for a new setup once the old one is deactivated", async () => {
    const created = await seedProject();
    await deactivateWeeklyReportProject(db, created.id);
    await expect(seedProject()).resolves.toBeDefined();
  });
});

describe("week_of validation", () => {
  it("accepts a date on the project's reporting day", async () => {
    const project = await seedProject();
    const { report } = await createWeeklyReportDraft(
      db,
      { clientSubmissionId: U("aaaa1"), weeklyReportProjectId: project.id, weekOf: WEEK_OF },
      SUPER_ACTOR,
    );
    expect(report.weekOf).toBe(WEEK_OF);
  });

  it("rejects a date that is not the project's reporting day", async () => {
    const project = await seedProject();
    // A Wednesday report on a Thursday-cadence project would exist in the table but never appear on the
    // dashboard, which generates Thursdays — the week would still read as missing.
    await expectAppError(
      createWeeklyReportDraft(
        db,
        { clientSubmissionId: U("aaaa2"), weeklyReportProjectId: project.id, weekOf: "2026-08-12" },
        SUPER_ACTOR,
      ),
      400,
      /reporting day/i,
    );
  });

  it("rejects a week before the cadence started", async () => {
    const project = await seedProject();
    await expectAppError(
      createWeeklyReportDraft(
        db,
        { clientSubmissionId: U("aaaa3"), weeklyReportProjectId: project.id, weekOf: "2026-07-23" },
        SUPER_ACTOR,
      ),
      400,
      /precedes/i,
    );
  });

  it("rejects a week after reporting ended", async () => {
    const project = await seedProject({ cadenceEndDate: "2026-08-06" });
    await expectAppError(
      createWeeklyReportDraft(
        db,
        { clientSubmissionId: U("aaaa4"), weeklyReportProjectId: project.id, weekOf: WEEK_OF },
        SUPER_ACTOR,
      ),
      400,
      /after/i,
    );
  });
});

describe("draft creation", () => {
  it("is idempotent on clientSubmissionId — a retry returns the same report, not a second one", async () => {
    const project = await seedProject();
    const first = await createWeeklyReportDraft(
      db,
      { clientSubmissionId: U("bbbb1"), weeklyReportProjectId: project.id, weekOf: WEEK_OF },
      SUPER_ACTOR,
    );
    const retry = await createWeeklyReportDraft(
      db,
      { clientSubmissionId: U("bbbb1"), weeklyReportProjectId: project.id, weekOf: WEEK_OF },
      SUPER_ACTOR,
    );
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.report.id).toBe(first.report.id);
    expect(await listWeeklyReports(db, { projectId: project.id })).toHaveLength(1);
  });

  it("treats a DIFFERENT submission id for the same week as a conflict, not a retry", async () => {
    const project = await seedProject();
    await createWeeklyReportDraft(
      db,
      { clientSubmissionId: U("bbbb2"), weeklyReportProjectId: project.id, weekOf: WEEK_OF },
      SUPER_ACTOR,
    );
    await expectAppError(
      createWeeklyReportDraft(
        db,
        { clientSubmissionId: U("bbbb3"), weeklyReportProjectId: project.id, weekOf: WEEK_OF },
        PM_ACTOR,
      ),
      409,
      /already exists/i,
    );
  });

  it("refuses a stranger who is neither the super nor the PM", async () => {
    const project = await seedProject();
    await expectAppError(
      createWeeklyReportDraft(
        db,
        { clientSubmissionId: U("bbbb4"), weeklyReportProjectId: project.id, weekOf: WEEK_OF },
        STRANGER_ACTOR,
      ),
      403,
      /not assigned/i,
    );
  });

  it("refuses a project whose reporting is paused", async () => {
    const project = await seedProject();
    await updateWeeklyReportProject(db, project.id, { status: "paused" }, OFFICE);
    await expectAppError(
      createWeeklyReportDraft(
        db,
        { clientSubmissionId: U("bbbb5"), weeklyReportProjectId: project.id, weekOf: WEEK_OF },
        SUPER_ACTOR,
      ),
      409,
      /paused/i,
    );
  });
});

async function seedDraft(projectId: string, weekOf = WEEK_OF, submissionId = U("cccc1")) {
  const { report } = await createWeeklyReportDraft(
    db,
    { clientSubmissionId: submissionId, weeklyReportProjectId: projectId, weekOf },
    SUPER_ACTOR,
  );
  await updateWeeklyReportContent(
    db,
    report.id,
    { workCompleted: "- Material delivered for balcony mock up", completionPercent: 12.5, weatherDelayDays: 2 },
    SUPER_ACTOR,
  );
  return report.id;
}

describe("the PM gate", () => {
  it("lets the super submit for review", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const submitted = await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    expect(submitted.status).toBe("pending_review");
    expect(submitted.submittedAt).not.toBeNull();
  });

  // The reason the review step exists at all.
  it("does NOT let the super approve their own report", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await expectAppError(transitionWeeklyReport(db, id, "approved", SUPER_ACTOR), 403, /permission/i);
  });

  it("does not let anyone jump straight from draft to sent", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await expectAppError(transitionWeeklyReport(db, id, "sent", PM_ACTOR), 409, /cannot move/i);
    await expectAppError(transitionWeeklyReport(db, id, "approved", DIRECTOR_ACTOR), 409, /cannot move/i);
  });

  it("lets the assigned PM approve", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    const approved = await transitionWeeklyReport(db, id, "approved", PM_ACTOR);
    expect(approved.status).toBe("approved");
    expect(approved.reviewedAt).not.toBeNull();
  });

  it("lets a director approve without being the assigned PM", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await expect(transitionWeeklyReport(db, id, "approved", DIRECTOR_ACTOR)).resolves.toMatchObject({
      status: "approved",
    });
  });

  it("lets the PM bounce it back, clearing the review stamp", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "approved", PM_ACTOR);
    await transitionWeeklyReport(db, id, "pending_review", PM_ACTOR);
    const bounced = await transitionWeeklyReport(db, id, "draft", PM_ACTOR);
    expect(bounced.status).toBe("draft");
    // Otherwise the dashboard would keep claiming a report was reviewed after it was sent back.
    expect(bounced.reviewedAt).toBeNull();
  });

  it("refuses to submit an empty report into the PM's queue", async () => {
    const project = await seedProject();
    const { report } = await createWeeklyReportDraft(
      db,
      { clientSubmissionId: U("cccc9"), weeklyReportProjectId: project.id, weekOf: WEEK_OF },
      SUPER_ACTOR,
    );
    await expectAppError(
      transitionWeeklyReport(db, report.id, "pending_review", SUPER_ACTOR),
      400,
      /work completed/i,
    );
  });

  it("stores remaining weeks at submit so a later duration change cannot rewrite it", async () => {
    const project = await seedProject({ projectStartDate: "2026-07-09", projectStartDateNote: null });
    const id = await seedDraft(project.id);
    const submitted = await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    expect(submitted.remainingWeeks).toBe(14); // 19 projected − 5 elapsed weeks

    await updateWeeklyReportProject(db, project.id, { projectedDurationWeeks: 40 }, OFFICE);
    const reread = await getWeeklyReportDetail(db, id);
    expect(reread!.remainingWeeks).toBe(14);
  });

  it("reports the full duration remaining for a project that has not started", async () => {
    // The reference PDF shows Remaining 0 against Projected 19 for a "TBD Permit" start. That is a blank
    // spreadsheet cell, not a rule — a job that has not broken ground has all its weeks ahead of it.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const submitted = await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    expect(submitted.remainingWeeks).toBe(19);
  });
});

describe("a sent report is immutable", () => {
  async function sendReport(projectId: string) {
    const id = await seedDraft(projectId);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "approved", PM_ACTOR);
    await transitionWeeklyReport(db, id, "sent", PM_ACTOR);
    return id;
  }

  it("stamps sent_at, so status and the per-project counters agree", async () => {
    const project = await seedProject();
    const id = await sendReport(project.id);
    const detail = await getWeeklyReportDetail(db, id);
    expect(detail!.status).toBe("sent");
    // A `sent` row with a null sent_at would make listWeeklyReportProjectSummaries report "never sent"
    // for a report the client has already received.
    expect(detail!.sentAt).not.toBeNull();

    const [summary] = await listWeeklyReportProjectSummaries(db, WEEK_OF);
    expect(summary!.reportsSent).toBe(1);
    expect(summary!.lastSentAt).not.toBeNull();
  });

  it("refuses content edits after send", async () => {
    const project = await seedProject();
    const id = await sendReport(project.id);
    await expectAppError(
      updateWeeklyReportContent(db, id, { workCompleted: "rewritten" }, PM_ACTOR),
      409,
      /correction/i,
    );
  });

  it("refuses photo changes after send", async () => {
    const project = await seedProject();
    const id = await sendReport(project.id);
    await expectAppError(replaceWeeklyReportPhotos(db, id, [], PM_ACTOR), 409, /correction/i);
  });

  it("refuses edits even from a director", async () => {
    // Elevated roles are not exempt: the client has already read this document.
    const project = await seedProject();
    const id = await sendReport(project.id);
    await expectAppError(
      updateWeeklyReportContent(db, id, { workCompleted: "rewritten" }, DIRECTOR_ACTOR),
      409,
      /correction/i,
    );
  });

  it("has no onward transition at all", async () => {
    const project = await seedProject();
    const id = await sendReport(project.id);
    for (const target of ["draft", "pending_review", "approved", "sent"] as const) {
      await expectAppError(transitionWeeklyReport(db, id, target, DIRECTOR_ACTOR), 409, /cannot move/i);
    }
  });
});

describe("photos", () => {
  it("keeps the report caption separate from the capture-time description", async () => {
    // The product requirement, and the reason caption lives on the link row: editing a caption for the
    // client-facing report must not rewrite what the crew typed on site.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const photo = await seedPhoto({ takenAt: "2026-08-11", description: "north stair landing, pre-pour" });

    await replaceWeeklyReportPhotos(db, id, [{ fileId: photo, caption: "Balcony mock-up complete" }], SUPER_ACTOR);

    const detail = await getWeeklyReportDetail(db, id);
    expect(detail!.photos[0]!.caption).toBe("Balcony mock-up complete");
    expect(detail!.photos[0]!.originalDescription).toBe("north stair landing, pre-pour");

    const file = await pg.query(`SELECT description FROM office_dallas.files WHERE id = $1::uuid`, [photo]);
    expect((file.rows[0] as any).description).toBe("north stair landing, pre-pour");
  });

  it("replaces the whole selection rather than merging", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const a = await seedPhoto({ takenAt: "2026-08-10" });
    const b = await seedPhoto({ takenAt: "2026-08-11" });

    await replaceWeeklyReportPhotos(db, id, [{ fileId: a }, { fileId: b }], SUPER_ACTOR);
    const after = await replaceWeeklyReportPhotos(db, id, [{ fileId: b }], SUPER_ACTOR);
    expect(after.photos.map((p) => p.fileId)).toEqual([b]);
  });

  it("orders by array position, not by a client-supplied index", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const a = await seedPhoto({ takenAt: "2026-08-10" });
    const b = await seedPhoto({ takenAt: "2026-08-11" });

    const saved = await replaceWeeklyReportPhotos(
      db,
      id,
      [{ fileId: b, sortOrder: 99 }, { fileId: a, sortOrder: 0 }],
      SUPER_ACTOR,
    );
    expect(saved.photos.map((p) => p.fileId)).toEqual([b, a]);
  });

  it("refuses a photo belonging to another project", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const foreign = await seedPhoto({ dealId: OTHER_DEAL, takenAt: "2026-08-11" });
    await expectAppError(
      replaceWeeklyReportPhotos(db, id, [{ fileId: foreign }], SUPER_ACTOR),
      400,
      /do not belong/i,
    );
  });

  it("refuses the same photo twice", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const a = await seedPhoto({ takenAt: "2026-08-10" });
    await expectAppError(
      replaceWeeklyReportPhotos(db, id, [{ fileId: a }, { fileId: a }], SUPER_ACTOR),
      400,
      /twice/i,
    );
  });

  it("offers only photos from the 14 days ending on week_of", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const inWindowEdge = await seedPhoto({ takenAt: "2026-07-31" }); // first day of the window
    const inWindow = await seedPhoto({ takenAt: "2026-08-11" });
    const onWeekOf = await seedPhoto({ takenAt: WEEK_OF }); // last day of the window
    await seedPhoto({ takenAt: "2026-07-30" }); // one day too old
    await seedPhoto({ takenAt: "2026-08-14" }); // after week_of
    await seedPhoto({ dealId: OTHER_DEAL, takenAt: "2026-08-11" }); // another project

    const candidates = await listWeeklyReportPhotoCandidates(db, id);
    expect(candidates.map((c) => c.fileId).sort()).toEqual([inWindowEdge, inWindow, onWeekOf].sort());
  });

  it("pre-fills a candidate's caption from the capture description, then prefers the saved caption", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const photo = await seedPhoto({ takenAt: "2026-08-11", description: "as captured" });

    expect((await listWeeklyReportPhotoCandidates(db, id))[0]!.caption).toBe("as captured");

    await replaceWeeklyReportPhotos(db, id, [{ fileId: photo, caption: "edited for the client" }], SUPER_ACTOR);
    const after = await listWeeklyReportPhotoCandidates(db, id);
    // Falling back to the description here would silently revert the user's edit on every reload.
    expect(after[0]!.caption).toBe("edited for the client");
    expect(after[0]!.selected).toBe(true);
  });

  it("flags a photo already used on an earlier report", async () => {
    const project = await seedProject();
    const priorId = await seedDraft(project.id, PRIOR_WEEK, U("dddd1"));
    const photo = await seedPhoto({ takenAt: "2026-08-05" });
    await replaceWeeklyReportPhotos(db, priorId, [{ fileId: photo }], SUPER_ACTOR);

    const currentId = await seedDraft(project.id, WEEK_OF, U("dddd2"));
    const candidates = await listWeeklyReportPhotoCandidates(db, currentId);
    const match = candidates.find((c) => c.fileId === photo);
    // Shown, not hidden — re-using a photo is sometimes right — but marked so it is a choice.
    expect(match?.alreadyUsedOn).toBe(PRIOR_WEEK);
  });

  it("drops a soft-deleted photo from a saved report rather than rendering a hole", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const photo = await seedPhoto({ takenAt: "2026-08-11" });
    await replaceWeeklyReportPhotos(db, id, [{ fileId: photo }], SUPER_ACTOR);

    await pg.query(`UPDATE office_dallas.files SET deleted_at = now() WHERE id = $1::uuid`, [photo]);
    const detail = await getWeeklyReportDetail(db, id);
    expect(detail!.photos).toHaveLength(0);
  });
});

describe("content validation", () => {
  it("rejects a completion percent outside 0-100", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await expectAppError(updateWeeklyReportContent(db, id, { completionPercent: 140 }, SUPER_ACTOR), 400);
    await expectAppError(updateWeeklyReportContent(db, id, { completionPercent: -1 }, SUPER_ACTOR), 400);
  });

  it("rejects negative weather delays", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await expectAppError(updateWeeklyReportContent(db, id, { weatherDelayDays: -3 }, SUPER_ACTOR), 400);
  });

  it("returns completion percent as a number, not a numeric string", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const updated = await updateWeeklyReportContent(db, id, { completionPercent: 12.5 }, SUPER_ACTOR);
    expect(updated.completionPercent).toBe(12.5);
    expect(typeof updated.completionPercent).toBe("number");
  });

  it("refuses edits from someone with no role on the project", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await expectAppError(
      updateWeeklyReportContent(db, id, { workCompleted: "nope" }, STRANGER_ACTOR),
      403,
      /permission/i,
    );
  });
});

describe("dashboard", () => {
  it("shows an untouched week as not started — the case reading the reports table would miss", async () => {
    const project = await seedProject();
    const dashboard = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const current = dashboard.rows.find((r) => r.isCurrentWeek);
    expect(current).toMatchObject({
      weekOf: WEEK_OF,
      state: "not_started",
      waitingOn: "Steve Sanchez",
      daysLate: 0,
    });
  });

  it("keeps earlier unfiled weeks outstanding and ages them", async () => {
    const project = await seedProject();
    const dashboard = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const stale = dashboard.rows.filter((r) => !r.isCurrentWeek);
    expect(stale.map((r) => r.weekOf)).toEqual(["2026-07-30", PRIOR_WEEK]);
    expect(stale[0]!.daysLate).toBe(14);
    expect(stale[1]!.daysLate).toBe(7);
  });

  it("names the PM as the blocker once the super has submitted", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);

    const dashboard = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const current = dashboard.rows.find((r) => r.isCurrentWeek);
    expect(current).toMatchObject({ state: "pending_review", waitingOn: "Adam Sherwood" });
  });

  it("drops a settled past week but keeps the current one visible", async () => {
    const project = await seedProject();
    const priorId = await seedDraft(project.id, PRIOR_WEEK, U("eeee1"));
    await transitionWeeklyReport(db, priorId, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, priorId, "approved", PM_ACTOR);
    await transitionWeeklyReport(db, priorId, "sent", PM_ACTOR);

    const dashboard = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    expect(dashboard.rows.some((r) => r.weekOf === PRIOR_WEEK)).toBe(false);
    expect(dashboard.rows.some((r) => r.weekOf === WEEK_OF)).toBe(true);
  });

  it("clears a dismissed week without pretending it was filed", async () => {
    const project = await seedProject();
    await dismissWeeklyReportWeek(db, {
      weeklyReportProjectId: project.id,
      weekOf: "2026-07-30",
      reason: "Site closed for the holiday",
      actorUserId: DIRECTOR,
      asOf: WEEK_OF,
    });
    const dashboard = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    expect(dashboard.rows.some((r) => r.weekOf === "2026-07-30")).toBe(false);
    expect(dashboard.rows.some((r) => r.weekOf === PRIOR_WEEK)).toBe(true);
  });

  it("counts outstanding weeks beyond the lookback instead of hiding them", async () => {
    const project = await seedProject({ cadenceStartDate: "2026-01-01" });
    const dashboard = await getWeeklyReportDashboard(db, { asOf: WEEK_OF, lookbackWeeks: 3 });
    expect(dashboard.rows.filter((r) => r.weeklyReportProjectId === project.id)).toHaveLength(3);
    // Silently truncating would read as "all caught up" on a project 30 weeks behind.
    expect(dashboard.olderOutstandingCounts[project.id]).toBeGreaterThan(0);
  });

  it("excludes a paused project from the cadence entirely", async () => {
    const project = await seedProject();
    await updateWeeklyReportProject(db, project.id, { status: "paused" }, OFFICE);
    const dashboard = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    expect(dashboard.rows).toHaveLength(0);
  });

  it("sorts the most overdue first", async () => {
    await seedProject();
    const dashboard = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const lateness = dashboard.rows.map((r) => r.daysLate);
    expect([...lateness].sort((a, b) => b - a)).toEqual(lateness);
  });

  it("summarises sent counts and the next due date per project", async () => {
    const project = await seedProject();
    const priorId = await seedDraft(project.id, PRIOR_WEEK, U("ffff1"));
    await transitionWeeklyReport(db, priorId, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, priorId, "approved", PM_ACTOR);
    await transitionWeeklyReport(db, priorId, "sent", PM_ACTOR);

    const [summary] = await listWeeklyReportProjectSummaries(db, WEEK_OF);
    expect(summary).toMatchObject({
      reportsSent: 1,
      lastSentWeekOf: PRIOR_WEEK,
      nextDueWeekOf: WEEK_OF,
    });
  });
});

// Every case below closes a defect Codex raised on #1070.
describe("review findings", () => {
  it("refuses a setup on a deal that was never won", async () => {
    // A weekly client progress report on an open or lost job is nonsense, and the cadence would start
    // generating outstanding weeks leadership then chases somebody about.
    await expectAppError(seedProject({ dealId: OPEN_DEAL }), 400, /Won project/i);
  });

  it("refuses a setup on an archived deal", async () => {
    await pg.query(`UPDATE office_dallas.deals SET is_active = false WHERE id = $1::uuid`, [OTHER_DEAL]);
    await expectAppError(seedProject({ dealId: OTHER_DEAL }), 404, /not found/i);
    await pg.query(`UPDATE office_dallas.deals SET is_active = true WHERE id = $1::uuid`, [OTHER_DEAL]);
  });

  it("stops the super editing once the PM has approved", async () => {
    // Otherwise the super can rewrite the narrative or swap the photos of an approved report and the PM
    // sends content they never reviewed — the approval gate defeated rather than merely bent.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "approved", PM_ACTOR);

    await expectAppError(
      updateWeeklyReportContent(db, id, { workCompleted: "snuck in" }, SUPER_ACTOR),
      403,
      /permission/i,
    );
    await expectAppError(replaceWeeklyReportPhotos(db, id, [], SUPER_ACTOR), 403, /permission/i);
    // The PM may still fix it.
    await expect(
      updateWeeklyReportContent(db, id, { workCompleted: "PM correction" }, PM_ACTOR),
    ).resolves.toMatchObject({ workCompleted: "PM correction" });
  });

  it("freezes the header on send, so later edits cannot rewrite a delivered report", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "approved", PM_ACTOR);
    await transitionWeeklyReport(db, id, "sent", PM_ACTOR);

    const sent = await getWeeklyReportDetail(db, id);
    expect(sent!.snapshot).toMatchObject({
      clientName: "Mack Real Estate Group",
      trockTeam: { pmName: "Adam Sherwood", superName: "Steve Sanchez" },
    });

    // Swap the PM and the client AFTER delivery. The client already read the old header.
    await updateWeeklyReportProject(db, project.id, { trockPmUserId: DIRECTOR, clientName: "New Owner LLC" }, OFFICE);
    const reread = await getWeeklyReportDetail(db, id);
    expect(reread!.snapshot).toMatchObject({
      clientName: "Mack Real Estate Group",
      trockTeam: { pmName: "Adam Sherwood" },
    });
  });

  it("rejects a transition raced against a status that has since moved on", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "approved", PM_ACTOR);

    // Simulate the losing half of a concurrent pair: validation passed against `approved`, but the row
    // moved before the write landed. Without the status predicate the update would happily pull an
    // already-sent report back into review.
    await pg.query(`UPDATE office_dallas.weekly_reports SET status = 'sent' WHERE id = $1::uuid`, [id]);
    await expectAppError(transitionWeeklyReport(db, id, "sent", PM_ACTOR), 409, /cannot move/i);
  });

  it("rejects a malformed photo payload instead of clearing the selection", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const photo = await seedPhoto({ takenAt: "2026-08-11" });
    await replaceWeeklyReportPhotos(db, id, [{ fileId: photo }], SUPER_ACTOR);

    await expectAppError(replaceWeeklyReportPhotos(db, id, "oops" as never, SUPER_ACTOR), 400, /array/i);
    // The selection must survive the rejected call.
    expect((await getWeeklyReportDetail(db, id))!.photos).toHaveLength(1);
  });

  it("will not pre-dismiss a week that is not yet due", async () => {
    // A future date dismissed in advance enters the board already settled, having never been missed —
    // which is precisely the accountability the ledger exists to create.
    const project = await seedProject();
    await expectAppError(
      dismissWeeklyReportWeek(db, {
        weeklyReportProjectId: project.id,
        weekOf: "2026-08-20",
        reason: "getting ahead",
        actorUserId: DIRECTOR,
        asOf: WEEK_OF,
      }),
      400,
      /future week/i,
    );
  });

  it("will not dismiss a date that is not one of the project's reporting days", async () => {
    const project = await seedProject();
    await expectAppError(
      dismissWeeklyReportWeek(db, {
        weeklyReportProjectId: project.id,
        weekOf: "2026-08-05",
        reason: "wrong day",
        actorUserId: DIRECTOR,
        asOf: WEEK_OF,
      }),
      400,
      /reporting days/i,
    );
  });

  it("will not dismiss a week that already has a report", async () => {
    const project = await seedProject();
    await seedDraft(project.id, PRIOR_WEEK, U("d1111"));
    await expectAppError(
      dismissWeeklyReportWeek(db, {
        weeklyReportProjectId: project.id,
        weekOf: PRIOR_WEEK,
        reason: "tidying up",
        actorUserId: DIRECTOR,
        asOf: WEEK_OF,
      }),
      409,
      /already has a report/i,
    );
  });

  it("falls back to the default lookback rather than rendering an empty board", async () => {
    // `?lookbackWeeks=abc` produced NaN, which survived Math.min/Math.max, turned both loops into
    // no-ops and rendered a board that read as "nothing outstanding".
    await seedProject();
    const dashboard = await getWeeklyReportDashboard(db, { asOf: WEEK_OF, lookbackWeeks: Number("abc") });
    expect(dashboard.rows.length).toBeGreaterThan(0);
    expect(dashboard.lookbackWeeks).toBe(26);
  });

  it("truncates a fractional lookback instead of indexing at a fraction", async () => {
    await seedProject();
    const dashboard = await getWeeklyReportDashboard(db, { asOf: WEEK_OF, lookbackWeeks: 1.5 });
    expect(dashboard.lookbackWeeks).toBe(1);
    expect(dashboard.rows).toHaveLength(1);
  });

  it("sorts by soonest due before falling back to the alphabet", async () => {
    // Before their deadlines every row has daysLate === 0, so a name-only tiebreak puts a Saturday
    // report above one due tomorrow purely because of how it is spelled.
    await seedProject({ propertyDisplayName: "Zulu Tower", cadenceWeekday: THURSDAY });
    await createWeeklyReportProject(
      db,
      baseProjectInput({
        dealId: OTHER_DEAL,
        propertyDisplayName: "Alpha Plaza",
        cadenceWeekday: 6, // Saturday — due later than Thursday
      }),
      DIRECTOR,
      OFFICE,
    );

    const dashboard = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const current = dashboard.rows.filter((row) => row.isCurrentWeek);
    expect(current.map((row) => row.projectName)).toEqual(["Zulu Tower", "Alpha Plaza"]);
  });

  it("reports no next-due date once reporting has stopped", async () => {
    const project = await seedProject();
    await updateWeeklyReportProject(db, project.id, { status: "completed" }, OFFICE);
    const [summary] = await listWeeklyReportProjectSummaries(db, WEEK_OF);
    expect(summary!.nextDueWeekOf).toBeNull();
  });

  it("reports no next-due date past the cadence end date", async () => {
    const project = await seedProject();
    await updateWeeklyReportProject(db, project.id, { cadenceEndDate: "2026-08-06" }, OFFICE);
    const [summary] = await listWeeklyReportProjectSummaries(db, WEEK_OF);
    expect(summary!.nextDueWeekOf).toBeNull();
  });
});

// Second Codex pass on the fixed commit. Nine further findings, all real.
describe("review findings, round two", () => {
  it("refuses an assignee who is not on the office roster", async () => {
    // THE ESCALATION: the project PATCH route is open to `rep`, and trock_pm_user_id is what decides
    // who may approve and send. Without this a rep sets themselves PM and unlocks the review gate.
    await expectAppError(seedProject({ trockPmUserId: STRANGER }), 400, /project team/i);
  });

  it("refuses an assignee from another office", async () => {
    const otherOffice = U("00003");
    const outsider = U("22225");
    await pg.query(`INSERT INTO public.offices (id, name, slug) VALUES ($1::uuid, 'Atlanta', 'atl')`, [otherOffice]);
    await pg.query(
      `INSERT INTO public.users (id, display_name, email, role, office_id)
       VALUES ($1::uuid, 'Other Office PM', 'other@example.com', 'construction', $2::uuid)`,
      [outsider, otherOffice],
    );
    await expectAppError(seedProject({ trockPmUserId: outsider }), 400, /project team/i);
    await pg.query(`DELETE FROM public.users WHERE id = $1::uuid`, [outsider]);
    await pg.query(`DELETE FROM public.offices WHERE id = $1::uuid`, [otherOffice]);
  });

  it("refuses a deactivated assignee", async () => {
    await pg.query(`UPDATE public.users SET is_active = false WHERE id = $1::uuid`, [PM]);
    await expectAppError(seedProject(), 400, /project team/i);
    await pg.query(`UPDATE public.users SET is_active = true WHERE id = $1::uuid`, [PM]);
  });

  it("re-validates the assignee on PATCH, not just on create", async () => {
    const project = await seedProject();
    await expectAppError(
      updateWeeklyReportProject(db, project.id, { trockPmUserId: STRANGER }, OFFICE),
      400,
      /project team/i,
    );
  });

  it("writes only the fields the patch supplied, so concurrent edits do not clobber", async () => {
    const project = await seedProject();
    // Two readers, both holding the ORIGINAL row, editing different fields.
    await updateWeeklyReportProject(db, project.id, { clientName: "Edited by A" }, OFFICE);
    await updateWeeklyReportProject(db, project.id, { propertyDisplayName: "Edited by B" }, OFFICE);
    const after = await getWeeklyReportProject(db, project.id);
    // A full-row write from a stale merge would have restored the original client name here.
    expect(after).toMatchObject({ clientName: "Edited by A", propertyDisplayName: "Edited by B" });
  });

  it("locks the reporting day once reports exist", async () => {
    // Moving Thursday to Friday mid-project orphans every Thursday already filed and invents a run of
    // Fridays nobody was ever asked for.
    const project = await seedProject();
    await seedDraft(project.id);
    await expectAppError(
      updateWeeklyReportProject(db, project.id, { cadenceWeekday: 5 }, OFFICE),
      409,
      /already started/i,
    );
    await expectAppError(
      updateWeeklyReportProject(db, project.id, { cadenceStartDate: "2026-07-20" }, OFFICE),
      409,
      /already started/i,
    );
  });

  it("still allows stopping future reporting once reports exist", async () => {
    // cadence_end_date is forward-only and must stay editable — that is how a project winds down.
    const project = await seedProject();
    await seedDraft(project.id);
    await expect(
      updateWeeklyReportProject(db, project.id, { cadenceEndDate: "2026-12-31" }, OFFICE),
    ).resolves.toMatchObject({ cadenceEndDate: "2026-12-31" });
  });

  it("allows changing the cadence before anything has been filed", async () => {
    const project = await seedProject();
    await expect(
      updateWeeklyReportProject(db, project.id, { cadenceWeekday: 5 }, OFFICE),
    ).resolves.toMatchObject({ cadenceWeekday: 5 });
  });

  it("does not let a content edit land on a report that has since been sent", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "approved", PM_ACTOR);

    // The permission check legitimately authorises an edit to an `approved` report. The send lands in
    // the window BETWEEN that check and the write — flipping the row up front would just hit the
    // sent-report guard and prove nothing about the race.
    await expectAppError(
      updateWeeklyReportContent(racingDb(id, "UPDATE weekly_reports SET"), id, { workCompleted: "raced in" }, PM_ACTOR),
      409,
      /changed while you were working/i,
    );
  });

  it("does not let a photo swap land on a report that has since been sent", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const photo = await seedPhoto({ takenAt: "2026-08-11" });
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "approved", PM_ACTOR);

    await expectAppError(
      replaceWeeklyReportPhotos(racingDb(id, "DELETE FROM weekly_report_photos"), id, [{ fileId: photo }], PM_ACTOR),
      409,
      /changed while you were working/i,
    );
  });

  it("does not let the super revoke the PM's approval", async () => {
    // approved -> pending_review is withdrawing an approval, not submitting work. Sharing the
    // permission branch with draft -> pending_review let the super reopen and then edit.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "approved", PM_ACTOR);
    await expectAppError(
      transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR),
      403,
      /permission/i,
    );
  });

  it("clears the review stamp when the PM withdraws approval", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "approved", PM_ACTOR);
    const reopened = await transitionWeeklyReport(db, id, "pending_review", PM_ACTOR);
    expect(reopened.status).toBe("pending_review");
    // Otherwise it reads "awaiting review" while stamped with the approval just revoked.
    expect(reopened.reviewedAt).toBeNull();
  });

  it("rejects a malformed photo id with a 400 rather than a cast error", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await expectAppError(
      replaceWeeklyReportPhotos(db, id, [{ fileId: "not-a-uuid" }], SUPER_ACTOR),
      400,
      /valid UUID/i,
    );
  });

  it("flags a photo only against EARLIER reports", async () => {
    const project = await seedProject();
    const photo = await seedPhoto({ takenAt: "2026-08-11" });

    // A LATER week already picked this photo; filing the earlier missed week must not claim it was
    // "already used" on a week that has not happened yet.
    const laterId = await seedDraft(project.id, "2026-08-20", U("e2221"));
    await replaceWeeklyReportPhotos(db, laterId, [{ fileId: photo }], SUPER_ACTOR);

    const earlierId = await seedDraft(project.id, WEEK_OF, U("e2222"));
    const candidates = await listWeeklyReportPhotoCandidates(db, earlierId);
    expect(candidates.find((c) => c.fileId === photo)?.alreadyUsedOn).toBeNull();
  });

  it("does not advertise a next-due date inside a window that has not opened", async () => {
    const project = await seedProject({ cadenceStartDate: "2026-09-17" });
    const summary = (await listWeeklyReportProjectSummaries(db, WEEK_OF)).find(
      (s) => s.weeklyReportProjectId === project.id,
    );
    // Asked on Aug 17, a Thursday cadence starting Sep 17 must not report Aug 20 — the board
    // correctly generates no obligation for that date, and the two must agree.
    expect(summary!.nextDueWeekOf).toBe("2026-09-17");
  });
});

describe("assignable users", () => {
  it("returns public.users ids, which is what the assignment columns reference", async () => {
    const users = await listWeeklyReportAssignableUsers(db, OFFICE);
    const ids = users.map((user) => user.id);
    // If these were field_responders ids (a different table entirely), no assignment would ever
    // authorise anyone — canTransitionAs compares them against the acting user's id.
    expect(ids).toContain(PM);
    expect(ids).toContain(SUPER);
  });

  it("excludes the sales roster, which would bury the real candidates", async () => {
    const users = await listWeeklyReportAssignableUsers(db, OFFICE);
    expect(users.map((user) => user.id)).not.toContain(STRANGER); // role 'rep'
  });

  it("includes leadership, who do carry projects", async () => {
    const users = await listWeeklyReportAssignableUsers(db, OFFICE);
    expect(users.map((user) => user.id)).toContain(DIRECTOR);
  });

  it("omits deactivated and test-data accounts", async () => {
    await pg.query(`UPDATE public.users SET is_active = false WHERE id = $1::uuid`, [SUPER]);
    expect((await listWeeklyReportAssignableUsers(db, OFFICE)).map((u) => u.id)).not.toContain(SUPER);
    await pg.query(`UPDATE public.users SET is_active = true WHERE id = $1::uuid`, [SUPER]);
  });

  it("does not leak another office's roster", async () => {
    const otherOffice = U("00002");
    await pg.query(`INSERT INTO public.offices (id, name, slug) VALUES ($1::uuid, 'Atlanta', 'atlanta')`, [
      otherOffice,
    ]);
    expect(await listWeeklyReportAssignableUsers(db, otherOffice)).toEqual([]);
    await pg.query(`DELETE FROM public.offices WHERE id = $1::uuid`, [otherOffice]);
  });
});

describe("settings", () => {
  it("starts empty rather than inventing recipients", async () => {
    expect(await getWeeklyReportSettings(db)).toMatchObject({ leadershipRecipientEmails: [] });
  });

  it("upserts a single row no matter how many times it is saved", async () => {
    await updateWeeklyReportSettings(db, ["adam@example.com"], DIRECTOR);
    await updateWeeklyReportSettings(db, ["adam@example.com", "takashi@example.com"], DIRECTOR);
    const settings = await getWeeklyReportSettings(db);
    expect(settings.leadershipRecipientEmails).toEqual(["adam@example.com", "takashi@example.com"]);

    const count = await pg.query(`SELECT COUNT(*)::int AS n FROM office_dallas.weekly_report_settings`);
    expect((count.rows[0] as any).n).toBe(1);
  });

  it("lowercases and de-duplicates recipients", async () => {
    const settings = await updateWeeklyReportSettings(
      db,
      ["Adam@Example.com", "adam@example.com", " takashi@example.com "],
      DIRECTOR,
    );
    expect(settings.leadershipRecipientEmails).toEqual(["adam@example.com", "takashi@example.com"]);
  });

  it("rejects a malformed recipient", async () => {
    await expectAppError(updateWeeklyReportSettings(db, ["nope"], DIRECTOR), 400, /valid email/i);
  });
});

describe("transition authorisation helper", () => {
  // Exercised directly so the matrix is legible in one place, independent of the database.
  const project = { trock_pm_user_id: PM, trock_super_user_id: SUPER };

  it("never lets a plain super reach approved or sent", () => {
    for (const status of ["pending_review", "approved"] as const) {
      expect(canTransitionAs(project, { status, authored_by: SUPER }, "approved", SUPER_ACTOR)).toBe(false);
      expect(canTransitionAs(project, { status, authored_by: SUPER }, "sent", SUPER_ACTOR)).toBe(false);
    }
  });

  it("lets a person who is both super and PM approve their own work", () => {
    // Deliberate: the gate is about the ROLE being satisfied, and on a one-person project it is.
    const solo = { trock_pm_user_id: SUPER, trock_super_user_id: SUPER };
    expect(canTransitionAs(solo, { status: "pending_review", authored_by: SUPER }, "approved", SUPER_ACTOR)).toBe(true);
  });

  it("lets the author submit even when the assignment has since moved on", () => {
    const reassigned = { trock_pm_user_id: PM, trock_super_user_id: DIRECTOR };
    expect(canTransitionAs(reassigned, { status: "draft", authored_by: SUPER }, "pending_review", SUPER_ACTOR)).toBe(
      true,
    );
  });
});
