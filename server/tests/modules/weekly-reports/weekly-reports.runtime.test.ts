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
import { deals, fieldResponders, files, offices, userOfficeAccess, users } from "@trock-crm/shared/schema";
import { WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS, WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import { migrationSql } from "../../helpers/migration-sql.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { AppError } from "../../../src/middleware/error-handler.js";
import {
  createWeeklyReportProject,
  deactivateWeeklyReportProject,
  getWeeklyReportProject,
  getWeeklyReportSettings,
  listWeeklyReportAssignableResponders,
  listWeeklyReportAssignableUsers,
  listWeeklyReportProjects,
  updateWeeklyReportProject,
  updateWeeklyReportSettings,
} from "../../../src/modules/weekly-reports/projects-service.js";
import {
  MAX_PHOTO_CANDIDATES,
  WEEKLY_REPORT_WEEK_EXISTS_CODE,
  canEditWeeklyReport,
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
// Field-team roster rows (0228). A project points at ONE of these; the login above is derived from the
// roster row's email. Kept as separate ids on purpose — a test that passed a user id where a roster id
// belongs must fail, because that is the escalation resolveRosterAssignee exists to refuse.
const PM_RESPONDER = U("44441");
const SUPER_RESPONDER = U("44442");
const DIRECTOR_RESPONDER = U("44443");
const OFF_ROSTER = U("44449");
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
 * A `db` that clears the work-completed section mid-call, at the transition's own write.
 *
 * The sibling above races a STATUS change; this races a CONTENT change, which is the harder case
 * precisely because it leaves `status` untouched. `updateWeeklyReport` authorises a PM to edit an
 * `approved` report, so this stands in for that edit committing between the forward gate's read and the
 * write it guards — the window a status-only condition cannot see.
 */
function racingContentClear(reportId: string) {
  let fired = false;
  return {
    query: async (text: string, params?: unknown[]) => {
      if (!fired && text.includes("UPDATE weekly_reports SET status")) {
        fired = true;
        await pg.query(
          `UPDATE office_dallas.weekly_reports SET work_completed = NULL WHERE id = $1::uuid`,
          [reportId],
        );
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
  // user_office_access carries the multi-office grants the assignee roster must honour.
  await pg.exec(tenantSchemaSql("public", [offices, users, userOfficeAccess]));
  await pg.exec(tenantSchemaSql("office_dallas", [deals, fieldResponders, files]));
  // Weekly reports may only be set up on a WON deal, so the suite needs the stage graph the check reads.
  await pg.exec(
    `CREATE TABLE IF NOT EXISTS public.pipeline_stage_config (id uuid PRIMARY KEY, slug text);`,
  );

  // The migrations under test — DO-loop, public tables and TENANT_SCHEMA block, verbatim from disk.
  await pg.exec(migrationSql("0222_weekly_reports"));
  await pg.exec(migrationSql("0223_weekly_report_pauses"));
  await pg.exec(migrationSql("0224_weekly_reports_pdf_content_generation"));
  // 0226 too, for the same reason and with more teeth: it ADDS COLUMNS to weekly_reports, and every
  // dashboard read selects them. A suite that stops at 0223 fails with "column send_delivered_at does
  // not exist" — or worse, would swallow it inside an office-level handler and skip the office.
  await pg.exec(migrationSql("0226_weekly_report_send"));
  // And 0227, which adds the DELIVERY VERDICT columns. Same reason again: `getWeeklyReportDashboard`
  // selects `send_delivery_status`, and `priorVersionReachedClient` binds it — a suite that stops at 0226
  // fails on a missing column rather than on its subject.
  await pg.exec(migrationSql("0227_weekly_report_delivery_events"));
  // 0228 links the PM/superintendent slots to the FIELD TEAM ROSTER, so every read of a project now
  // joins `field_responders` and selects `trock_*_responder_id`. A suite that stops at 0227 fails on a
  // missing column rather than on its subject.
  await pg.exec(migrationSql("0228_weekly_report_project_roster_link"));

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
    -- The field-team roster the PM/superintendent slots are chosen from. The EMAILS match the logins
    -- above, which is the only link between the two tables and what resolveRosterAssignee derives
    -- trock_*_user_id from — so asserting a resolved user id here is asserting that link works.
    INSERT INTO office_dallas.field_responders (id, name, email, role, is_active) VALUES
      ('${PM_RESPONDER}', 'Adam Sherwood', 'pm@example.com', 'project_manager', true),
      ('${SUPER_RESPONDER}', 'Steve Sanchez', 'super@example.com', 'superintendent', true),
      ('${DIRECTOR_RESPONDER}', 'Takashi', 'director@example.com', 'project_manager', true);
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
    DELETE FROM office_dallas.weekly_report_pauses;
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
    trockPmResponderId: PM_RESPONDER,
    trockSuperResponderId: SUPER_RESPONDER,
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

/**
 * A run of photos one minute apart, counting BACKWARDS from `newestAt`.
 *
 * The candidate cap only becomes reachable at 300 rows, and driving those through seedPhoto would be 300
 * round trips for a test about one query's ranking. The columns written here are exactly the ones that
 * query reads; the minute spacing gives it a deterministic newest-first order to rank by.
 */
async function seedPhotoBurst(count: number, newestAt: string): Promise<void> {
  await pg.query(
    `INSERT INTO office_dallas.files (
       id, category, display_name, system_filename, original_filename, mime_type,
       file_size_bytes, file_extension, r2_key, r2_bucket, uploaded_by, deal_id, taken_at
     )
     SELECT gen_random_uuid(), 'photo', 'burst-' || n, 'burst-' || n, 'burst-' || n, 'image/jpeg',
            1024, 'jpg', 'k/burst-' || n, 'test-bucket', $1::uuid, $2::uuid,
            $3::timestamptz - (n::int * interval '1 minute')
       FROM generate_series(0, $4::int - 1) AS n`,
    [SUPER, DEAL, newestAt, count],
  );
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

describe("migration 0224", () => {
  it("is replayable — running it a second time is a no-op, not an error", async () => {
    await expect(
      pg.exec(migrationSql("0224_weekly_reports_pdf_content_generation")),
    ).resolves.toBeDefined();
  });

  it("adds pdf_content_generation, which the artifact classifier reads on every download", async () => {
    // Not decoration: staleness is decided by comparing this against the report's live content generation,
    // and a schema without the column makes every PDF read fail on a missing column instead.
    //
    // This suite can only say the column is HERE. It cannot say which half of the migration put it here:
    // 0222's own TENANT block created office_dallas before 0224 ran, so the DO-loop and the
    // TENANT_SCHEMA block would each satisfy this assertion alone — and a missing tenant block is exactly
    // what leaves the NEXT office without the column. Told apart in
    // tests/migrations/0224-weekly-reports-pdf-content-generation.runtime.test.ts, which runs the two
    // halves separately against schemas of its own.
    const result = await pg.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'office_dallas'
          AND table_name = 'weekly_reports'
          AND column_name = 'pdf_content_generation'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.data_type).toBe("timestamp with time zone");
  });
});

describe("migration 0223", () => {
  it("is replayable — running it a second time is a no-op, not an error", async () => {
    await expect(pg.exec(migrationSql("0223_weekly_report_pauses"))).resolves.toBeDefined();
  });

  it("allows only ONE open pause per project", async () => {
    // Two overlapping open intervals would leave the next Resume closing one and not the other, and the
    // week generator would then treat a project that is demonstrably reporting again as still stopped.
    const project = await seedProject();
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_pauses (weekly_report_project_id, paused_from)
       VALUES ($1::uuid, '2026-08-03')`,
      [project.id],
    );
    await expect(
      pg.query(
        `INSERT INTO office_dallas.weekly_report_pauses (weekly_report_project_id, paused_from)
         VALUES ($1::uuid, '2026-08-10')`,
        [project.id],
      ),
    ).rejects.toThrow();
  });

  it("refuses a resume dated before the pause began", async () => {
    const project = await seedProject();
    await expect(
      pg.query(
        `INSERT INTO office_dallas.weekly_report_pauses (weekly_report_project_id, paused_from, resumed_on)
         VALUES ($1::uuid, '2026-08-10', '2026-08-03')`,
        [project.id],
      ),
    ).rejects.toThrow();
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
    // Still the resolved LOGIN, which after 0228 also proves the roster->user email link survived a
    // patch that never mentioned the team at all.
    expect(updated.trockPmResponderId).toBe(PM_RESPONDER);
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
    const updated = await updateWeeklyReportProject(
      db, created.id, { trockPmResponderId: DIRECTOR_RESPONDER }, OFFICE,
    );
    expect(updated.trockPmResponderId).toBe(DIRECTOR_RESPONDER);
    // The two move together. A patch that set the roster row and left the login behind would leave a
    // project whose printed PM is one person and whose approver is still the previous one.
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

  it("TAGS that conflict, so the phone can tell it from the other 409 this call can answer", async () => {
    // The app recovers from this one by ADOPTING the row that already exists for the week — without that
    // the phone's draft is unfilable: the create 409s identically on every retry and Discard is the only
    // exit. It must not attempt the same recovery for "Weekly reporting is paused for this project",
    // which is also a 409 and has no row to adopt. Matching on the prose would break the moment the copy
    // is improved, so the discriminator is the code.
    const project = await seedProject();
    await createWeeklyReportDraft(
      db,
      { clientSubmissionId: U("bbbb8"), weeklyReportProjectId: project.id, weekOf: WEEK_OF },
      SUPER_ACTOR,
    );
    let caught: unknown;
    try {
      await createWeeklyReportDraft(
        db,
        { clientSubmissionId: U("bbbb9"), weeklyReportProjectId: project.id, weekOf: WEEK_OF },
        PM_ACTOR,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(WEEKLY_REPORT_WEEK_EXISTS_CODE);

    // The paused answer is a 409 too, and carries no such tag.
    await db.query(`UPDATE weekly_report_projects SET status = 'paused' WHERE id = $1::uuid`, [project.id]);
    let paused: unknown;
    try {
      await createWeeklyReportDraft(
        db,
        { clientSubmissionId: U("bbba0"), weeklyReportProjectId: project.id, weekOf: WEEK_OF },
        SUPER_ACTOR,
      );
    } catch (error) {
      paused = error;
    }
    expect((paused as AppError).statusCode).toBe(409);
    expect((paused as AppError).code).toBeUndefined();
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

/**
 * Stand in for the delivery worker stamping a successful send.
 *
 * `status = 'sent'` alone means "a PM committed to sending"; the week is only SETTLED once the email
 * actually got out, which is `send_delivered_at`. These fixtures reach `sent` through the generic
 * transition (a path the API itself refuses), so nothing else here would ever stamp it.
 */
async function markDelivered(reportId: string) {
  await pg.query(
    `UPDATE office_dallas.weekly_reports SET send_delivered_at = now() WHERE id = $1::uuid`,
    [reportId],
  );
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

    // The counters are DELIVERED reports, not merely committed ones — "reports sent" and "last sent" are
    // numbers a director reads to a client, and `status = 'sent'` records only that somebody pressed a
    // button. Stamping delivery is what this fixture was implicitly assuming all along.
    await markDelivered(id);
    const [summary] = await listWeeklyReportProjectSummaries(db, WEEK_OF);
    expect(summary!.reportsSent).toBe(1);
    expect(summary!.lastSentAt).not.toBeNull();
    expect(summary!.undeliveredSends).toBe(0);
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

    const { photos: candidates } = await listWeeklyReportPhotoCandidates(db, id);
    expect(candidates.map((c) => c.fileId).sort()).toEqual([inWindowEdge, inWindow, onWeekOf].sort());
  });

  it("pre-fills a candidate's caption from the capture description, then prefers the saved caption", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const photo = await seedPhoto({ takenAt: "2026-08-11", description: "as captured" });

    expect((await listWeeklyReportPhotoCandidates(db, id)).photos[0]!.caption).toBe("as captured");

    await replaceWeeklyReportPhotos(db, id, [{ fileId: photo, caption: "edited for the client" }], SUPER_ACTOR);
    const after = await listWeeklyReportPhotoCandidates(db, id);
    // Falling back to the description here would silently revert the user's edit on every reload.
    expect(after.photos[0]!.caption).toBe("edited for the client");
    expect(after.photos[0]!.selected).toBe(true);
  });

  it("bounds a caption at the limit BOTH renderers honour, and pre-fills within it", async () => {
    // The API took 500 characters while the PDF drew the caption into a fixed two-line box and ellipsised
    // the rest, so the client's page and the PDF attached to the same email disagreed about what the
    // superintendent wrote. One shared limit now, enforced here as well as in both renderers.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const photo = await seedPhoto({ takenAt: "2026-08-11" });

    await expectAppError(
      replaceWeeklyReportPhotos(
        db,
        id,
        [{ fileId: photo, caption: "x".repeat(WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS + 1) }],
        SUPER_ACTOR,
      ),
      400,
      /limited to/i,
    );
    // Exactly at the limit is accepted — an off-by-one here would reject a caption both renderers can print.
    await replaceWeeklyReportPhotos(
      db,
      id,
      [{ fileId: photo, caption: "y".repeat(WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS) }],
      SUPER_ACTOR,
    );

    // And the DEFAULT the picker offers is cut to fit. files.description has no such limit, so a photo
    // captured with a long one used to pre-fill the form with a value that 400s the moment it is saved.
    const wordy = await seedPhoto({ takenAt: "2026-08-11", description: "z".repeat(600) });
    const { photos: wordyCandidates } = await listWeeklyReportPhotoCandidates(db, id);
    const candidate = wordyCandidates.find((c) => c.fileId === wordy);
    expect(candidate!.caption!.length).toBe(WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS);
    // The untouched capture description is still reported in full — only the suggested caption is cut.
    expect(candidate!.originalDescription).toHaveLength(600);
  });

  it("flags a photo already used on an earlier report", async () => {
    const project = await seedProject();
    const priorId = await seedDraft(project.id, PRIOR_WEEK, U("dddd1"));
    const photo = await seedPhoto({ takenAt: "2026-08-05" });
    await replaceWeeklyReportPhotos(db, priorId, [{ fileId: photo }], SUPER_ACTOR);

    const currentId = await seedDraft(project.id, WEEK_OF, U("dddd2"));
    const { photos: candidates } = await listWeeklyReportPhotoCandidates(db, currentId);
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

  it("reports the true depth of the window rather than truncating it silently", async () => {
    // The cap used to be a bare LIMIT with nothing in the payload to say it had bitten. Because the
    // window is anchored on `week_of` and ordered newest-first, the rows it removes are the EARLIEST
    // days of the fortnight — for a report filed late, the days the report is actually about.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await seedPhotoBurst(MAX_PHOTO_CANDIDATES + 5, "2026-08-13T12:00:00Z");

    const { photos, total } = await listWeeklyReportPhotoCandidates(db, id);
    expect(total).toBe(MAX_PHOTO_CANDIDATES + 5);
    expect(photos).toHaveLength(MAX_PHOTO_CANDIDATES);
  });

  it("never drops a photo already on the report, however deep in the window it sits", async () => {
    // A selected photo pushed past the cap disappeared from the grid while still counting toward the
    // picker's "N selected" — the count and the visible ticks disagreed, and there was no way to
    // deselect it.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const oldest = await seedPhoto({ takenAt: "2026-07-31" }); // first day of the window
    await replaceWeeklyReportPhotos(db, id, [{ fileId: oldest }], SUPER_ACTOR);
    // Every one of these is newer, so the selected photo ranks last of all.
    await seedPhotoBurst(MAX_PHOTO_CANDIDATES + 5, "2026-08-13T12:00:00Z");

    const { photos, total } = await listWeeklyReportPhotoCandidates(db, id);
    expect(total).toBe(MAX_PHOTO_CANDIDATES + 6);
    expect(photos.find((c) => c.fileId === oldest)?.selected).toBe(true);
    // The carve-out is for the SELECTED row only; the rest is still capped.
    expect(photos).toHaveLength(MAX_PHOTO_CANDIDATES + 1);
  });

  it("keeps a selected photo that has fallen outside the window", async () => {
    // An import carries the shot's own EXIF time, so a photo selected on the report can sit outside the
    // fortnight entirely. Filtering it out left the report holding a photo its own picker denied.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const ancient = await seedPhoto({ takenAt: "2026-05-02" });
    await replaceWeeklyReportPhotos(db, id, [{ fileId: ancient }], SUPER_ACTOR);

    const { photos } = await listWeeklyReportPhotoCandidates(db, id);
    expect(photos.map((c) => c.fileId)).toEqual([ancient]);
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
    // SETTLED means the client got it. A `sent` week whose email never reached the provider is the one
    // failure this board exists to catch, and it is deliberately kept — see the send suite.
    await markDelivered(priorId);

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
    await markDelivered(priorId);

    const [summary] = await listWeeklyReportProjectSummaries(db, WEEK_OF);
    expect(summary).toMatchObject({
      reportsSent: 1,
      lastSentWeekOf: PRIOR_WEEK,
      nextDueWeekOf: WEEK_OF,
    });
  });
});

/**
 * A DISMISSED WEEK CAN STILL OWE THE CLIENT AN EMAIL.
 *
 * `dismissWeeklyReportWeek` refuses only a week that ALREADY has a live report, and nothing stops one
 * being created afterwards — reports-service never so much as reads `weekly_report_dismissals`. So an
 * ordinary sequence reaches a week that is both dismissed and owed: the PM writes off a missed week, the
 * super files it late anyway, the PM approves and sends, and the delivery fails.
 *
 * Beyond the lookback window the tally tested the dismissal FIRST and short-circuited, so that week got
 * no row, no tally entry, and nothing from the second pass either — the cadence loop had already
 * "decided" it, which is what `cadenceDecidedKeys` records. The Projects tab meanwhile showed a permanent
 * red "1 not delivered" for it, contradicting the invariant the dashboard states in as many words:
 * every undelivered send that counter counts is accounted for, a row inside the window and a tally entry
 * beyond it, never dropped.
 */
describe("a dismissed week that gets filed anyway", () => {
  // ABSOLUTE, not derived: Thursdays from 2026-01-01 through the 2026-08-13 board date are 33 expected
  // weeks, of which `lookbackWeeks: 3` renders the last three and tallies the other 30. 2026-02-05 is
  // one of the 30. A fixture computed from the generator under test could not fail.
  const OLD_START = "2026-01-01";
  const OLD_WEEK = "2026-02-05";
  const OLDER_WEEKS = 30;

  /** File the week late, send it, and lose the email — the state the board has to keep hold of. */
  async function filedThenLost(projectId: string, weekOf: string) {
    const id = await seedDraft(projectId, weekOf, U("dddd1"));
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "approved", PM_ACTOR);
    await transitionWeeklyReport(db, id, "sent", PM_ACTOR);
    // `sent` with no `send_delivered_at`: committed, and the client never got it.
    await pg.query(
      `UPDATE office_dallas.weekly_reports SET send_error = 'Resend timed out', send_attempts = 3
        WHERE id = $1::uuid`,
      [id],
    );
    return id;
  }

  async function dismiss(projectId: string, weekOf: string) {
    await dismissWeeklyReportWeek(db, {
      weeklyReportProjectId: projectId,
      weekOf,
      reason: "Crew off site",
      actorUserId: DIRECTOR,
      asOf: WEEK_OF,
    });
  }

  it("still settles a dismissed old week nobody ever filed", async () => {
    // CONTROL. Dismissal has to keep clearing the weeks it is for, beyond the window as well as inside
    // it — a fix that simply stopped honouring dismissals out here would pass the test below while
    // handing back the guilt the ledger exists to write off.
    const project = await seedProject({ cadenceStartDate: OLD_START });
    await dismiss(project.id, OLD_WEEK);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF, lookbackWeeks: 3 });
    expect(board.olderOutstandingCounts[project.id]).toBe(OLDER_WEEKS - 1);
  });

  it("counts an undelivered old send with no dismissal in sight", async () => {
    // The second CONTROL: the tally does reach this state on its own. Without it the assertion below
    // could pass on a count that simply never moves.
    const project = await seedProject({ cadenceStartDate: OLD_START });
    await filedThenLost(project.id, OLD_WEEK);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF, lookbackWeeks: 3 });
    expect(board.olderOutstandingCounts[project.id]).toBe(OLDER_WEEKS);
  });

  it("keeps counting a week that was dismissed BEFORE it was filed and then lost", async () => {
    const project = await seedProject({ cadenceStartDate: OLD_START });
    await dismiss(project.id, OLD_WEEK);
    await filedThenLost(project.id, OLD_WEEK);

    // Was OLDER_WEEKS - 1: the dismissal short-circuited the delivery test, so the send vanished from
    // the only number that mentions weeks this old.
    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF, lookbackWeeks: 3 });
    expect(board.olderOutstandingCounts[project.id]).toBe(OLDER_WEEKS);

    // And the two surfaces agree again. This is the invariant, stated the way the dashboard states it:
    // whatever the Projects tab counts as undelivered, the board accounts for somewhere.
    const summary = (await listWeeklyReportProjectSummaries(db, WEEK_OF)).find(
      (entry) => entry.weeklyReportProjectId === project.id,
    )!;
    expect(summary.undeliveredSends).toBe(1);
  });

  it("renders the same state as a ROW inside the lookback window", async () => {
    // The half that was already right, pinned so the two halves cannot drift apart again: inside the
    // window a dismissed-then-filed week with a lost send is a row with a Retry on it, and the tally
    // beyond the window now says the same thing in the only language it has.
    const project = await seedProject();
    await dismiss(project.id, PRIOR_WEEK);
    const reportId = await filedThenLost(project.id, PRIOR_WEEK);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.weekOf === PRIOR_WEEK)!;
    expect(row.sendFailed).toBe(true);
    expect(row.sendRetryReportId).toBe(reportId);
    expect(row.dismissalReason).toBe("Crew off site");
  });
});

/**
 * Pausing, and what a project owes when it comes back.
 *
 * The defect these close: `status` says only where a setup stands TODAY, while the board regenerates its
 * expected weeks from `cadence_start_date` on every read. A project paused for three weeks therefore came
 * back owing all three as "Not started" and late, with reminders chasing a superintendent for reports
 * leadership had explicitly stood down — flatly contradicting the sentence the form shows when you pause
 * one. Migration 0223 records the interval; the generator skips it.
 */
describe("paused reporting", () => {
  // Cadence Thursdays from 2026-07-27, so the expected weeks are 07-30, 08-06, 08-13, 08-20, 08-27.
  const PAUSED_ON = "2026-08-03";
  const RESUMED_ON = "2026-08-24";
  const LATER_WEEK = "2026-08-27";

  async function setStatus(projectId: string, status: string, asOf: string) {
    await updateWeeklyReportProject(db, projectId, { status } as any, OFFICE, {
      asOf,
      actorUserId: DIRECTOR,
    });
  }

  async function pauseAndResume(projectId: string, pausedOn = PAUSED_ON, resumedOn = RESUMED_ON) {
    await setStatus(projectId, "paused", pausedOn);
    await setStatus(projectId, "active", resumedOn);
  }

  function pauseLedger(projectId: string) {
    return pg.query<{ paused_from: string; resumed_on: string | null; paused_by: string; resumed_by: string }>(
      `SELECT paused_from::text AS paused_from, resumed_on::text AS resumed_on, paused_by, resumed_by
         FROM office_dallas.weekly_report_pauses
        WHERE weekly_report_project_id = $1::uuid
        ORDER BY paused_from`,
      [projectId],
    );
  }

  it("does not bill back the weeks a project spent paused", async () => {
    const project = await seedProject();
    await pauseAndResume(project.id);

    const dashboard = await getWeeklyReportDashboard(db, { asOf: LATER_WEEK });
    // 07-30 was already missed when the pause began and is still owed. 08-06, 08-13 and 08-20 fell
    // inside it and were never owed at all.
    expect(dashboard.rows.map((row) => row.weekOf)).toEqual(["2026-07-30", LATER_WEEK]);
  });

  it("keeps the week missed before the pause aging rather than quietly clearing it", async () => {
    const project = await seedProject();
    await pauseAndResume(project.id);

    const dashboard = await getWeeklyReportDashboard(db, { asOf: LATER_WEEK });
    expect(dashboard.rows.find((row) => row.weekOf === "2026-07-30")).toMatchObject({
      state: "not_started",
      daysLate: 28,
    });
  });

  it("records the pause instead of moving the cadence start", async () => {
    // Advancing cadence_start_date on resume is the one-line alternative, and it forgets twice: the miss
    // above disappears, and so does the answer to "when did we start reporting to this client".
    const project = await seedProject();
    await pauseAndResume(project.id);

    expect((await getWeeklyReportProject(db, project.id))!.cadenceStartDate).toBe("2026-07-27");
    const ledger = await pauseLedger(project.id);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      paused_from: PAUSED_ON,
      resumed_on: RESUMED_ON,
      paused_by: DIRECTOR,
      resumed_by: DIRECTOR,
    });
  });

  it("keeps two pauses apart instead of merging them into one gap", async () => {
    const project = await seedProject();
    await pauseAndResume(project.id, "2026-08-03", "2026-08-10");
    await pauseAndResume(project.id, "2026-08-17", "2026-08-24");

    const dashboard = await getWeeklyReportDashboard(db, { asOf: LATER_WEEK });
    // The week between the two pauses was owed and stays owed.
    expect(dashboard.rows.map((row) => row.weekOf)).toEqual(["2026-07-30", WEEK_OF, LATER_WEEK]);
  });

  it("treats completed as stopped too, and does not reopen the interval on the way through", async () => {
    const project = await seedProject();
    await setStatus(project.id, "paused", PAUSED_ON);
    // paused -> completed is not a new boundary: reporting was already stopped.
    await setStatus(project.id, "completed", "2026-08-10");
    await setStatus(project.id, "active", RESUMED_ON);

    const dashboard = await getWeeklyReportDashboard(db, { asOf: LATER_WEEK });
    expect(dashboard.rows.map((row) => row.weekOf)).toEqual(["2026-07-30", LATER_WEEK]);
    expect((await pauseLedger(project.id)).rows).toHaveLength(1);
  });

  it("owes nothing for the stretch a project created paused spent switched off", async () => {
    // Created paused, so there is no active -> paused transition to catch; the interval opens at the
    // cadence start instead.
    const project = await seedProject({ status: "paused" });
    await setStatus(project.id, "active", RESUMED_ON);

    const dashboard = await getWeeklyReportDashboard(db, { asOf: LATER_WEEK });
    expect(dashboard.rows.map((row) => row.weekOf)).toEqual([LATER_WEEK]);
  });

  it("does not restart the pause when the form is saved again unchanged", async () => {
    // Re-saving the setup is not a new pause. Treating it as one would drag paused_from forward and
    // write off the weeks the project had already been stopped for.
    const project = await seedProject();
    await setStatus(project.id, "paused", PAUSED_ON);
    await updateWeeklyReportProject(
      db,
      project.id,
      { status: "paused", clientName: "Mack Real Estate Group LLC" },
      OFFICE,
      { asOf: "2026-08-17", actorUserId: DIRECTOR },
    );

    const ledger = await pauseLedger(project.id);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ paused_from: PAUSED_ON, resumed_on: null });
  });

  it("still hides a project that is paused right now", async () => {
    const project = await seedProject();
    await setStatus(project.id, "paused", PAUSED_ON);

    const dashboard = await getWeeklyReportDashboard(db, { asOf: LATER_WEEK });
    expect(dashboard.rows).toHaveLength(0);
    // …and the open interval is what stops those same weeks reappearing later.
    expect((await pauseLedger(project.id)).rows[0]).toMatchObject({ resumed_on: null });
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
    await updateWeeklyReportProject(
      db, project.id, { trockPmResponderId: DIRECTOR_RESPONDER, clientName: "New Owner LLC" }, OFFICE,
    );
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
  it("refuses an assignee who is not on the field-team roster", async () => {
    // THE ESCALATION: the project PATCH route is open to `rep`, and trock_pm_user_id is what decides
    // who may approve and send. The gate is now TIGHTER than the roles check it replaced — the id must
    // name a row on the director-managed roster, so a rep cannot nominate themselves (or anyone) by
    // sending their own user id, which is not a roster id at all.
    await expectAppError(seedProject({ trockPmResponderId: OFF_ROSTER }), 400, /field team/i);
    await expectAppError(seedProject({ trockPmResponderId: STRANGER }), 400, /field team/i);
  });

  it("refuses a MALFORMED responder id with a 400, not a 500", async () => {
    // `WHERE id = $1::uuid` raises 22P02 on anything that is not a uuid, and the route validates only
    // `dealId`. So a typo'd id was an unhandled server error rather than a refusal naming the field —
    // the same failure `resolveScorecardResponderPick`'s UUID_SHAPE guard exists to prevent, and worth
    // pinning because the difference between 400 and 500 here is invisible until somebody hits it.
    await expectAppError(seedProject({ trockPmResponderId: "not-a-uuid" }), 400, /valid field-team id/i);
    await expectAppError(
      updateWeeklyReportProject(db, (await seedProject()).id, { trockSuperResponderId: "nope" }, OFFICE),
      400,
      /valid field-team id/i,
    );
  });

  it("refuses a roster person whose role does not match the slot", async () => {
    // The direction that hands out approval rights: installing a superintendent as the PM would give
    // them the review gate's powers over their own reports.
    await expectAppError(
      seedProject({ trockPmResponderId: SUPER_RESPONDER }),
      400,
      /not a project manager/i,
    );
  });

  it("refuses an assignee from another office's roster", async () => {
    // `field_responders` is a TENANT table reached through the office's search_path, so another
    // office's roster row is not visible here at all — the id resolves to nothing and is refused.
    // Asserted rather than assumed: the lookup is by id, and an id is globally unique-looking.
    await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_atlanta;
      CREATE TABLE IF NOT EXISTS office_atlanta.field_responders (
        id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL,
        role text NOT NULL, is_active boolean NOT NULL DEFAULT true);`);
    const outsider = U("44448");
    await pg.query(
      `INSERT INTO office_atlanta.field_responders (id, name, email, role)
       VALUES ($1::uuid, 'Atlanta PM', 'atl-pm@example.com', 'project_manager')`,
      [outsider],
    );
    await expectAppError(seedProject({ trockPmResponderId: outsider }), 400, /field team/i);
  });

  it("refuses an assignee who has been removed from the roster", async () => {
    // Deactivating the ROSTER row is how a director takes somebody off the field team, and it is what
    // must block a new assignment — not the login's own is_active, which nobody edits for this reason.
    await pg.query(`UPDATE office_dallas.field_responders SET is_active = false WHERE id = $1::uuid`, [
      PM_RESPONDER,
    ]);
    await expectAppError(seedProject(), 400, /removed from the field team/i);
    await pg.query(`UPDATE office_dallas.field_responders SET is_active = true WHERE id = $1::uuid`, [
      PM_RESPONDER,
    ]);
  });

  it("re-validates the assignee on PATCH, not just on create", async () => {
    const project = await seedProject();
    await expectAppError(
      updateWeeklyReportProject(db, project.id, { trockPmResponderId: OFF_ROSTER }, OFFICE),
      400,
      /field team/i,
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

  it("does not approve a report whose work-completed was cleared while the approval was in flight", async () => {
    // The forward gate reads `work_completed` from loadReportWithProject, one statement earlier. Clearing
    // that section does NOT move `status`, so a status-only CAS still matched and the report reached
    // `approved` — and then `sent`, to the client — with the section the gate exists to require empty.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);

    await expectAppError(
      transitionWeeklyReport(racingContentClear(id), id, "approved", PM_ACTOR),
      409,
      /changed while you were working/i,
    );
    const after = await pg.query(`SELECT status FROM office_dallas.weekly_reports WHERE id = $1::uuid`, [id]);
    expect(after.rows[0].status).toBe("pending_review");
  });

  it("does not send a report whose work-completed was cleared while the send was in flight", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "approved", PM_ACTOR);

    await expectAppError(
      transitionWeeklyReport(racingContentClear(id), id, "sent", PM_ACTOR),
      409,
      /changed while you were working/i,
    );
    // Nothing reached the client: still approved, and no send stamps were written.
    const after = await pg.query(
      `SELECT status, sent_at, sent_by FROM office_dallas.weekly_reports WHERE id = $1::uuid`,
      [id],
    );
    expect(after.rows[0]).toMatchObject({ status: "approved", sent_at: null, sent_by: null });
  });

  it("still lets a BACKWARD move off an empty report, so a bounce-back is never trapped", async () => {
    // The content condition is scoped to forward gates on purpose. A report whose work-completed is
    // empty must still be able to go back to draft, or clearing the section would strand it.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await pg.query(`UPDATE office_dallas.weekly_reports SET work_completed = NULL WHERE id = $1::uuid`, [id]);

    await expect(transitionWeeklyReport(db, id, "draft", PM_ACTOR)).resolves.toMatchObject({ status: "draft" });
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
    const { photos: candidates } = await listWeeklyReportPhotoCandidates(db, earlierId);
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

// Third Codex pass on 1a000d1a. Seven findings, all real.
describe("review findings, round three", () => {
  const GRANTED = U("22226");
  const OTHER_OFFICE = U("00004");

  it("resolves the login of a multi-office member holding a user_office_access grant", async () => {
    // Office membership is not just users.office_id. A PM whose primary office is elsewhere but who
    // holds a grant here is exactly the person most likely to run a second office's projects — and
    // authentication already lets them act in it. The same omission has bitten the deal-reassign guard.
    //
    // After 0228 this decides the LOGIN half rather than assignability: the roster row is what makes
    // them selectable, and the email lookup is what turns them into somebody who can actually approve.
    // Getting it wrong is silent — the project saves, prints the right name, and nobody can approve it.
    const VISITING_RESPONDER = U("44444");
    await pg.query(`INSERT INTO public.offices (id, name, slug) VALUES ($1::uuid, 'Atlanta', 'atl2')`, [OTHER_OFFICE]);
    await pg.query(
      `INSERT INTO public.users (id, display_name, email, role, office_id)
       VALUES ($1::uuid, 'Visiting PM', 'visiting@example.com', 'construction', $2::uuid)`,
      [GRANTED, OTHER_OFFICE],
    );
    await pg.query(
      `INSERT INTO office_dallas.field_responders (id, name, email, role)
       VALUES ($1::uuid, 'Visiting PM', 'visiting@example.com', 'project_manager')`,
      [VISITING_RESPONDER],
    );

    // Without the grant they are still ASSIGNABLE — they are on this office's roster — but no login in
    // this office matches, so nothing authorises them and the slot resolves to a null user id.
    const ungranted = await seedProject({ trockPmResponderId: VISITING_RESPONDER });
    expect(ungranted.trockPmResponderId).toBe(VISITING_RESPONDER);
    expect(ungranted.trockPmUserId).toBeNull();
    expect((await listWeeklyReportAssignableResponders(db, OFFICE)).find((r) => r.id === VISITING_RESPONDER))
      .toMatchObject({ hasLogin: false });
    await pg.query(`DELETE FROM office_dallas.weekly_report_projects`);

    await pg.query(
      `INSERT INTO public.user_office_access (user_id, office_id) VALUES ($1::uuid, $2::uuid)`,
      [GRANTED, OFFICE],
    );
    // With it, the same roster row now resolves to the visiting PM's login and they can approve.
    await expect(seedProject({ trockPmResponderId: VISITING_RESPONDER })).resolves.toMatchObject({
      trockPmUserId: GRANTED,
    });
    // The picker must agree with the write path, or the form promises a login the server declines.
    expect((await listWeeklyReportAssignableResponders(db, OFFICE)).find((r) => r.id === VISITING_RESPONDER))
      .toMatchObject({ hasLogin: true });

    await pg.query(`DELETE FROM public.user_office_access WHERE user_id = $1::uuid`, [GRANTED]);
    await pg.query(`DELETE FROM office_dallas.field_responders WHERE id = $1::uuid`, [VISITING_RESPONDER]);
    await pg.query(`DELETE FROM public.users WHERE id = $1::uuid`, [GRANTED]);
    await pg.query(`DELETE FROM public.offices WHERE id = $1::uuid`, [OTHER_OFFICE]);
  });

  it("applies a grant's role_override when deciding assignability", async () => {
    // A sales rep granted into this office AS construction is assignable here even though their
    // primary role is not.
    await pg.query(
      `INSERT INTO public.user_office_access (user_id, office_id, role_override)
       VALUES ($1::uuid, $2::uuid, 'construction')`,
      [STRANGER, OFFICE],
    );
    expect((await listWeeklyReportAssignableUsers(db, OFFICE)).map((u) => u.id)).toContain(STRANGER);
    await pg.query(`DELETE FROM public.user_office_access WHERE user_id = $1::uuid`, [STRANGER]);
  });

  it("keeps an intentionally cleared caption cleared", async () => {
    // `??` treated a deliberately blank caption as absent and restored the capture description, so a
    // user could not remove a caption and have it stay removed.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const photo = await seedPhoto({ takenAt: "2026-08-11", description: "as captured" });

    await replaceWeeklyReportPhotos(db, id, [{ fileId: photo, caption: null }], SUPER_ACTOR);
    const { photos: candidates } = await listWeeklyReportPhotoCandidates(db, id);
    const match = candidates.find((c) => c.fileId === photo);
    expect(match?.selected).toBe(true);
    expect(match?.caption).toBeNull();
    // The original description is still reported separately, so the UI can offer it back.
    expect(match?.originalDescription).toBe("as captured");
  });

  it("refuses to approve or send a report whose work-completed was cleared after submit", async () => {
    // The PM may edit a report in review; a check that ran only on draft submission let the section be
    // emptied afterwards and an empty report delivered to the client.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await updateWeeklyReportContent(db, id, { workCompleted: null }, PM_ACTOR);

    await expectAppError(transitionWeeklyReport(db, id, "approved", PM_ACTOR), 400, /work completed/i);
  });

  it("refuses to send an approved report whose work-completed was cleared", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "approved", PM_ACTOR);
    await updateWeeklyReportContent(db, id, { workCompleted: null }, PM_ACTOR);

    await expectAppError(transitionWeeklyReport(db, id, "sent", PM_ACTOR), 400, /work completed/i);
  });

  it("rejects a non-string field instead of silently clearing it", async () => {
    // {"clientName": 123} previously succeeded and wiped the client's name.
    const project = await seedProject();
    await expectAppError(
      updateWeeklyReportProject(db, project.id, { clientName: 123 as never }, OFFICE),
      400,
      /text value/i,
    );
    expect((await getWeeklyReportProject(db, project.id))!.clientName).toBe("Mack Real Estate Group");
  });

  it("answers a duplicate setup with a conflict even when the pre-flight check is bypassed", async () => {
    // The existence SELECT serialises nothing; the unique index is what actually holds. Reaching the
    // INSERT with a live row present must still be a 409, not a raw 23505 surfaced as a 500.
    await seedProject();
    await expectAppError(seedProject(), 409, /already has a weekly report setup/i);
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

describe("edit authorisation helper", () => {
  // The matrix that has to agree with the transition matrix above: every actor granted a submit must also
  // be granted the write, because the clients PATCH the content and PUT the photos before transitioning.
  const project = { trock_pm_user_id: PM, trock_super_user_id: SUPER };
  const reassigned = { trock_pm_user_id: PM, trock_super_user_id: DIRECTOR };

  it("lets the author edit their own DRAFT after the assignment moves on", () => {
    const row = { status: "draft", authored_by: SUPER };
    expect(canEditWeeklyReport(reassigned, row, SUPER_ACTOR)).toBe(true);
    // Exactly the pairing that was broken: a submit right with no write right behind it.
    expect(canTransitionAs(reassigned, row, "pending_review", SUPER_ACTOR)).toBe(true);
  });

  it("takes it away again once the report has been submitted or approved", () => {
    for (const status of ["pending_review", "approved"] as const) {
      expect(canEditWeeklyReport(reassigned, { status, authored_by: SUPER }, SUPER_ACTOR)).toBe(false);
    }
  });

  it("keeps a sent report immutable for its author, its PM and a director alike", () => {
    const row = { status: "sent", authored_by: SUPER };
    for (const actor of [SUPER_ACTOR, PM_ACTOR, DIRECTOR_ACTOR]) {
      expect(canEditWeeklyReport(project, row, actor)).toBe(false);
    }
  });

  it("keeps an approved report the PM's alone, even for the super who wrote it", () => {
    expect(canEditWeeklyReport(project, { status: "approved", authored_by: SUPER }, SUPER_ACTOR)).toBe(false);
    expect(canEditWeeklyReport(project, { status: "approved", authored_by: SUPER }, PM_ACTOR)).toBe(true);
  });

  it("grants nothing on the strength of an absent author", () => {
    // `authored_by` is nullable (ON DELETE SET NULL). A null must never match an actor id.
    expect(canEditWeeklyReport(reassigned, { status: "draft", authored_by: null }, SUPER_ACTOR)).toBe(false);
  });
});
