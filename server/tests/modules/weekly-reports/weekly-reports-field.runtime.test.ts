// Runtime suite for the T-Rock Cam half of Weekly Reports: what the hub feed offers a given person, and
// who may open a given report by id.
//
// Both are new authorisation surfaces rather than new business rules. /api/field admits every
// superintendent in the company, so anything the app can read is readable by all of them unless the
// service says otherwise — a burden the CRM router never carried, because its role gate stood in for one.
//
// Same harness as weekly-reports.runtime.test.ts: migration 0222 read FROM DISK against a real
// office_dallas schema, so a column that exists only in the test cannot make a query pass.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deals, fieldResponders, files, offices, userOfficeAccess, users } from "@trock-crm/shared/schema";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import { migrationSql } from "../../helpers/migration-sql.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { AppError } from "../../../src/middleware/error-handler.js";
import {
  createWeeklyReportProject,
  toFieldWeeklyReportProject,
  updateWeeklyReportProject,
} from "../../../src/modules/weekly-reports/projects-service.js";
import {
  createWeeklyReportDraft,
  getWeeklyReportForActor,
  replaceWeeklyReportPhotos,
  transitionWeeklyReport,
  updateWeeklyReportContent,
} from "../../../src/modules/weekly-reports/reports-service.js";
import {
  APP_OUTSTANDING_WEEK_LIMIT,
  APP_REVIEW_QUEUE_LIMIT,
  listWeeklyReportAssignments,
} from "../../../src/modules/weekly-reports/assignments-service.js";
import { createWeeklyReportCorrection } from "../../../src/modules/weekly-reports/send-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const OFFICE = U("00001");
const DEAL = U("11111");
const OTHER_DEAL = U("11112");
const PM = U("22221");
const SUPER = U("22222");
const DIRECTOR = U("22223");
// Field-team roster rows (0228): what the PM/superintendent slots now name. The LOGIN each
// resolves to is derived from the roster row's email, so these are seeded from public.users
// below rather than carrying a hand-typed address that could drift out of step.
const PM_RESPONDER = U("44441");
const SUPER_RESPONDER = U("44442");
const OTHER_SUPER_RESPONDER = U("44445");
const OTHER_PM_RESPONDER = U("44446");
const OTHER_SUPER = U("22225");
const WON_STAGE = U("33331");

const PM_ACTOR = { id: PM, role: "construction" };
const SUPER_ACTOR = { id: SUPER, role: "construction" };
const DIRECTOR_ACTOR = { id: DIRECTOR, role: "director" };
const OTHER_SUPER_ACTOR = { id: OTHER_SUPER, role: "construction" };

// The reference report's week: Thursday 2026-08-13.
const THURSDAY = 4;
const WEEK_OF = "2026-08-13";
const PRIOR_WEEK = "2026-08-06";

let pg: PGlite;

const db = {
  query: async (text: string, params?: unknown[]) => {
    const result = await pg.query(text, params as any[]);
    return {
      rows: result.rows as any[],
      rowCount: (result as { affectedRows?: number }).affectedRows ?? result.rows.length,
    } as any;
  },
};

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
  // user_office_access carries the multi-office grants the assignee roster resolves through.
  await pg.exec(tenantSchemaSql("public", [offices, users, userOfficeAccess]));
  await pg.exec(tenantSchemaSql("office_dallas", [deals, fieldResponders, files]));
  await pg.exec(
    `CREATE TABLE IF NOT EXISTS public.pipeline_stage_config (id uuid PRIMARY KEY, slug text);`,
  );
  await pg.exec(migrationSql("0222_weekly_reports"));
  // 0223 adds weekly_report_pauses, which the cadence generator reads to skip paused stretches.
  await pg.exec(migrationSql("0223_weekly_report_pauses"));
  // 0226 adds `send_delivered_at` and `send_last_attempt_at` — the two columns that separate "the PM
  // pressed Send" from "the client received it", and the whole basis of the undelivered list below.
  // Read from disk like the rest, so a column that exists only in a test fixture cannot make a query pass.
  await pg.exec(migrationSql("0226_weekly_report_send"));
  // 0228 links the PM/superintendent slots to the FIELD TEAM ROSTER, so every read of a project now
  // joins `field_responders` and selects `trock_*_responder_id`. A suite that stops at 0227 fails on a
  // missing column rather than on its subject.
  await pg.exec(migrationSql("0228_weekly_report_project_roster_link"));
  // 0229 admits the rep_escalation reminder kind; 0230 adds `carried_from_report_id`, which the
  // draft-creation INSERT now writes. A suite that stops short fails on a missing column rather
  // than on its subject.
  await pg.exec(migrationSql("0229_weekly_report_rep_escalation_kind"));
  await pg.exec(migrationSql("0230_weekly_reports_carried_from"));

  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES ('${OFFICE}', 'Dallas', 'dallas');
    INSERT INTO public.users (id, display_name, email, role, office_id) VALUES
      ('${PM}', 'Adam Sherwood', 'pm@example.com', 'construction', '${OFFICE}'),
      ('${SUPER}', 'Steve Sanchez', 'super@example.com', 'construction', '${OFFICE}'),
      ('${DIRECTOR}', 'Takashi', 'director@example.com', 'director', '${OFFICE}'),
      ('${OTHER_SUPER}', 'Someone Else', 'other@example.com', 'construction', '${OFFICE}');
    INSERT INTO office_dallas.field_responders (id, name, email, role)
SELECT '${PM_RESPONDER}'::uuid, u.display_name, u.email, 'project_manager' FROM public.users u WHERE u.id = '${PM}'
      UNION ALL
      SELECT '${SUPER_RESPONDER}'::uuid, u.display_name, u.email, 'superintendent' FROM public.users u WHERE u.id = '${SUPER}'
      UNION ALL
      SELECT '${OTHER_SUPER_RESPONDER}'::uuid, u.display_name, u.email, 'superintendent' FROM public.users u WHERE u.id = '${OTHER_SUPER}'
      UNION ALL
      SELECT '${OTHER_PM_RESPONDER}'::uuid, u.display_name, u.email, 'project_manager' FROM public.users u WHERE u.id = '${OTHER_SUPER}';
    INSERT INTO public.pipeline_stage_config (id, slug) VALUES ('${WON_STAGE}', '${WON_DEAL_STAGE_SLUGS[0]}');
    INSERT INTO office_dallas.deals (id, name, deal_number, stage_id, project_number) VALUES
      ('${DEAL}', '4123 Cedar Springs', 'DFW-10432', '${WON_STAGE}', 'DFW-10432'),
      ('${OTHER_DEAL}', 'Some Other Job', 'DFW-10433', '${WON_STAGE}', 'DFW-10433');
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
    DELETE FROM office_dallas.weekly_reports;
    DELETE FROM office_dallas.weekly_report_projects;
  `);
});

function baseProjectInput(overrides: Record<string, unknown> = {}) {
  return {
    dealId: DEAL,
    propertyDisplayName: "4123 Cedar Springs",
    clientName: "Mack Real Estate Group",
    clientTeam: { doc: { name: "Jay Stauble", email: "jay@example.com" } },
    trockPmResponderId: PM_RESPONDER,
    trockSuperResponderId: SUPER_RESPONDER,
    projectedDurationWeeks: 19,
    cadenceWeekday: THURSDAY,
    cadenceStartDate: "2026-07-30",
    ...overrides,
  } as any;
}

async function seedProject(overrides: Record<string, unknown> = {}) {
  return createWeeklyReportProject(db, baseProjectInput(overrides), DIRECTOR, OFFICE);
}

let submissionSeq = 0;
async function seedDraft(projectId: string, weekOf: string, actor = SUPER_ACTOR) {
  submissionSeq += 1;
  const { report } = await createWeeklyReportDraft(
    db,
    {
      clientSubmissionId: U(`c${String(submissionSeq).padStart(4, "0")}`),
      weeklyReportProjectId: projectId,
      weekOf,
    },
    actor,
  );
  return report.id;
}

/**
 * A week actually FILED: submitted, out of the super's hands.
 *
 * Distinct from seedDraft on purpose. A draft leaves the week owed — nobody has seen anything — so it
 * stays on the hub as outstanding; only a submission takes the week off the super's list.
 */
async function seedFiled(projectId: string, weekOf: string, actor = SUPER_ACTOR) {
  const id = await seedDraft(projectId, weekOf, actor);
  await updateWeeklyReportContent(db, id, { workCompleted: "- Framing" }, actor);
  await transitionWeeklyReport(db, id, "pending_review", actor);
  return id;
}

/** UTC throughout, matching the date-only columns these tests compare against. */
const addDays = (isoDate: string, days: number): string =>
  new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Weekly consecutive submitted reports, inserted directly.
 *
 * The queue cap needs more than a hundred rows to be reachable at all, and driving them through
 * create/update/transition would be several hundred statements for a test about ONE query's ORDER BY and
 * LIMIT. The columns written here are exactly the ones that query reads.
 */
async function seedReviewRows(projectId: string, count: number, firstWeekOf: string): Promise<void> {
  await pg.query(
    `INSERT INTO office_dallas.weekly_reports
       (client_submission_id, weekly_report_project_id, deal_id, week_of, status,
        work_completed, authored_by, authored_at, submitted_by, submitted_at)
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::date + (n::int * 7), 'pending_review',
            '- Framing', $4::uuid, now(), $4::uuid, now()
       FROM generate_series(0, $5::int - 1) AS n`,
    [projectId, DEAL, firstWeekOf, SUPER, count],
  );
}

describe("hub assignments", () => {
  it("offers a superintendent their own project and nobody else's", async () => {
    await seedProject();
    await createWeeklyReportProject(
      db,
      baseProjectInput({ dealId: OTHER_DEAL, propertyDisplayName: "Somebody Else's Job", trockSuperResponderId: OTHER_SUPER_RESPONDER, trockPmResponderId: OTHER_PM_RESPONDER }),
      DIRECTOR,
      OFFICE,
    );

    const mine = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    expect(mine.projects.map((p) => p.projectName)).toEqual(["4123 Cedar Springs"]);
    expect(mine.projects[0]).toMatchObject({ isSuper: true, isPm: false, currentWeekOf: WEEK_OF });
  });

  it("carries the LAST SENT report, which survives a cadence rollover", async () => {
    // #17's reachability. `currentReportId` describes `currentWeekOf` only, so the moment the cadence
    // moves on, a report the client DID receive is neither the current week nor in `undeliveredSends` —
    // that query carries `send_delivered_at IS NULL` — and the phone loses every route to it. Which is
    // precisely when somebody asks for the link again.
    //
    // Asserted from a week EARLIER than the one being viewed, because a fixture where the sent week and
    // the current week coincide passes just as well when the field is wired to `currentReportId`, and
    // that is the bug.
    const project = await seedProject();
    const reportId = await seedDraft(project.id, PRIOR_WEEK);
    await pg.query(
      `UPDATE office_dallas.weekly_reports SET status = 'sent', sent_at = now() WHERE id = $1::uuid`,
      [reportId],
    );

    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    const card = view.projects[0]!;
    expect(card.currentWeekOf).toBe(WEEK_OF);
    expect(card.lastSentWeekOf).toBe(PRIOR_WEEK);
    expect(card.lastSentReportId).toBe(reportId);
    // And it is NOT the current week's id — the distinction the whole fix rests on.
    expect(card.lastSentReportId).not.toBe(card.currentReportId);
  });

  it("still reaches the delivered report while a CORRECTION is open on that same week", async () => {
    // The assignments query is `DISTINCT ON (project, week_of) … ORDER BY version DESC`, so the LIVE row
    // for a week is its highest unsuperseded version. `createWeeklyReportCorrection` clones a sent report
    // to `version + 1` in `approved`, and supersession is stamped at SEND, not at clone — so while a
    // correction is being worked, v1 is still `sent` and unsuperseded but v2 outranks it and wins the
    // DISTINCT ON. The week stops reading as `sent`, the last-sent walk skips it, and `lastSentReportId`
    // falls back to an older week or to null.
    //
    // Starting a correction is an ordinary thing for a PM to do, and it is MOST likely on exactly the
    // report a client is currently asking about. So the single action most correlated with needing the
    // link again was the action that removed the route to it.
    //
    // The state and the route are different questions. The week's state is the correction's — that is
    // what the DISTINCT ON is for and it is right. The delivered report is still v1, because that is the
    // copy the client actually has in their inbox.
    const project = await seedProject();
    const sentId = await seedDraft(project.id, PRIOR_WEEK);
    await pg.query(
      `UPDATE office_dallas.weekly_reports SET status = 'sent', sent_at = now() WHERE id = $1::uuid`,
      [sentId],
    );

    const correction = await createWeeklyReportCorrection(db, sentId, PM_ACTOR);
    expect(correction.id).not.toBe(sentId);
    expect(correction.version).toBe(2);

    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    const card = view.projects[0]!;
    expect(card.lastSentReportId).toBe(sentId);
    expect(card.lastSentWeekOf).toBe(PRIOR_WEEK);
    // Explicitly NOT the correction: that version has never been delivered to anybody.
    expect(card.lastSentReportId).not.toBe(correction.id);
  });

  it("has no last-sent report before anything has gone out", async () => {
    // The control. A field that returned some id unconditionally would satisfy the test above.
    await seedProject();
    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    expect(view.projects[0]!.lastSentReportId).toBeNull();
    expect(view.projects[0]!.lastSentWeekOf).toBeNull();
  });

  it("shows a director every active project, matching what the services let them act on", async () => {
    await seedProject();
    await createWeeklyReportProject(
      db,
      baseProjectInput({ dealId: OTHER_DEAL, propertyDisplayName: "Alpha Plaza", trockSuperResponderId: OTHER_SUPER_RESPONDER }),
      DIRECTOR,
      OFFICE,
    );

    const all = await listWeeklyReportAssignments(db, { userId: DIRECTOR, role: "director", asOf: WEEK_OF });
    expect(all.projects).toHaveLength(2);
  });

  it("returns nothing at all for a field user assigned to no project", async () => {
    await seedProject();
    const none = await listWeeklyReportAssignments(db, { userId: OTHER_SUPER, role: "construction", asOf: WEEK_OF });
    expect(none.projects).toEqual([]);
    expect(none.pendingReview).toEqual([]);
  });

  it("auto-fills week_of to the cadence due date, not to today", async () => {
    await seedProject();
    // Monday the 10th: the report being worked on is Thursday the 13th's.
    const monday = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: "2026-08-10" });
    expect(monday.projects[0]!.currentWeekOf).toBe(WEEK_OF);
  });

  it("keeps an unfiled earlier week outstanding instead of absorbing it into this one", async () => {
    await seedProject();
    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    // Cadence starts 2026-07-30, so 07-30 and 08-06 are both due and unfiled.
    expect(view.projects[0]!.outstandingWeeks).toEqual(["2026-07-30", PRIOR_WEEK]);
    expect(view.projects[0]!.currentWeekOf).toBe(WEEK_OF);
  });

  it("does not offer a week once its report has left the super's hands", async () => {
    // Submitted, approved or sent: nothing there is the superintendent's move, and the chip would open a
    // wizard whose final button 403s. A DRAFT is the opposite case — see the test below.
    const project = await seedProject();
    const id = await seedDraft(project.id, PRIOR_WEEK);
    await updateWeeklyReportContent(db, id, { workCompleted: "- Framing" }, SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);

    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    expect(view.projects[0]!.outstandingWeeks).toEqual(["2026-07-30"]);
  });

  it("keeps a week whose report is still a DRAFT outstanding, carrying its report id", async () => {
    // The row is created lazily on the photos step, so a super who walked that far and then discarded
    // the local draft — or reinstalled, or changed phone — used to lose the week entirely: it was not
    // the current week so it had no card, it was not pending_review so it was not in the PM's queue,
    // and a report row existed so it was struck off `outstandingWeeks`. Invisible on the phone forever
    // while the CRM board still showed "With super".
    const project = await seedProject();
    const priorId = await seedDraft(project.id, PRIOR_WEEK);

    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    const assignment = view.projects[0]!;
    expect(assignment.outstandingWeeks).toEqual(["2026-07-30", PRIOR_WEEK]);
    // The id is what makes the wizard RESUME the row rather than post a second create for the week.
    expect(assignment.outstandingWeekReportIds).toEqual({ [PRIOR_WEEK]: priorId });
    // A week nobody has started carries no id at all.
    expect(assignment.outstandingWeekReportIds["2026-07-30"]).toBeUndefined();
  });

  it("still hides a week that was dismissed rather than filed", async () => {
    // Draft-tolerance must not become dismissal-tolerance: a dismissed week is a decision that the week
    // is not owed, and it has no report row to distinguish it.
    const project = await seedProject();
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_dismissals (weekly_report_project_id, week_of, reason, dismissed_by)
       VALUES ($1::uuid, $2::date, 'No crew on site', $3::uuid)`,
      [project.id, PRIOR_WEEK, PM],
    );
    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    expect(view.projects[0]!.outstandingWeeks).toEqual(["2026-07-30"]);
  });

  it("truncates a long backlog from the OLD end and says it did", async () => {
    // A project 30 weeks behind must not turn the phone's project card into a wall of dates, but the app
    // has to be able to say there are more — silently stopping at five reads as "you are nearly caught up".
    await seedProject({ cadenceStartDate: "2026-01-01" });
    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    const weeks = view.projects[0]!.outstandingWeeks;
    expect(weeks).toHaveLength(APP_OUTSTANDING_WEEK_LIMIT);
    expect(view.projects[0]!.hasMoreOutstandingWeeks).toBe(true);
    // Ascending, and ending at the week just before the current one — the recent misses, not the ancient ones.
    expect([...weeks].sort()).toEqual(weeks);
    expect(weeks[weeks.length - 1]).toBe(PRIOR_WEEK);
  });

  it("prefills the numbers from the last filed week", async () => {
    const project = await seedProject();
    const priorId = await seedDraft(project.id, PRIOR_WEEK);
    await updateWeeklyReportContent(
      db,
      priorId,
      { workCompleted: "- Balcony mock up", completionPercent: 12.5, weatherDelayDays: 2 },
      SUPER_ACTOR,
    );

    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    expect(view.projects[0]).toMatchObject({
      previousWeekOf: PRIOR_WEEK,
      previousCompletionPercent: 12.5,
      previousWeatherDelayDays: 2,
    });
    // numeric(5,2) arrives as a string from the driver; the app renders it into a number input.
    expect(typeof view.projects[0]!.previousCompletionPercent).toBe("number");
  });

  it("prefills each missed week from ITS OWN predecessor, never from a later one", async () => {
    // Completion % and weather delays are CUMULATIVE. A single project-level predecessor seeded a
    // missed July week with August's figures once August had been filed — overstating that week's
    // progress and delay total on a document the client keeps as the record of it.
    //
    // Weeks: 07-23 filed, 07-30 GAP, 08-06 filed, 08-13 current.
    const project = await seedProject({ cadenceStartDate: "2026-07-23" });

    const firstId = await seedDraft(project.id, "2026-07-23");
    await updateWeeklyReportContent(
      db,
      firstId,
      { workCompleted: "- Mobilisation", completionPercent: 5, weatherDelayDays: 1 },
      SUPER_ACTOR,
    );
    const laterId = await seedDraft(project.id, PRIOR_WEEK);
    await updateWeeklyReportContent(
      db,
      laterId,
      { workCompleted: "- Framing", completionPercent: 40, weatherDelayDays: 6 },
      SUPER_ACTOR,
    );

    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    const assignment = view.projects[0]!;

    // THE BUG: the 07-30 gap must inherit 07-23's 5%/1d, not the LATER 08-06 report's 40%/6d.
    expect(assignment.previousByWeekOf["2026-07-30"]).toMatchObject({
      weekOf: "2026-07-23",
      completionPercent: 5,
      weatherDelayDays: 1,
    });
    // The current week still inherits the most recent filed week, as before.
    expect(assignment.previousByWeekOf[WEEK_OF]).toMatchObject({
      weekOf: PRIOR_WEEK,
      completionPercent: 40,
      weatherDelayDays: 6,
    });
  });

  it("prefills from nothing on the first week of a project", async () => {
    await seedProject();
    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    expect(view.projects[0]).toMatchObject({
      previousWeekOf: null,
      previousCompletionPercent: null,
      previousWeatherDelayDays: null,
    });
  });

  it("does not bill a resumed project for the weeks it was paused", async () => {
    // The hub regenerated the cadence without the pause ledger, so a project paused for weeks came
    // back showing every one of them as an outstanding card — disagreeing with the CRM board, which
    // loads the ledger, and letting a superintendent file CLIENT reports for weeks nobody owed.
    const project = await seedProject({ cadenceStartDate: "2026-07-23" });
    await pg.query(
      `INSERT INTO office_dallas.weekly_report_pauses (weekly_report_project_id, paused_from, resumed_on)
       VALUES ($1::uuid, '2026-07-27'::date, '2026-08-13'::date)`,
      [project.id],
    );

    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    const assignment = view.projects[0]!;
    // 07-23 was owed before the pause and stays owed; 07-30 and 08-06 fell inside it.
    expect(assignment.outstandingWeeks).toEqual(["2026-07-23"]);
  });

  it("drops a paused project off the hub entirely", async () => {
    const project = await seedProject();
    await updateWeeklyReportProject(db, project.id, { status: "paused" }, OFFICE);
    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    expect(view.projects).toEqual([]);
  });

  it("drops a project whose cadence has not started yet", async () => {
    // Otherwise the card offers a week createWeeklyReportDraft would reject with "precedes the project's
    // reporting start date" — an action the hub should never have offered.
    await seedProject({ cadenceStartDate: "2026-09-03" });
    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    expect(view.projects).toEqual([]);
  });

  it("ages from the OLDEST week still owed, not from the current one", async () => {
    // The defect this closes: daysLate was measured against `currentWeekOf`, which `weeklyReportWeekOf`
    // defines as the first cadence day ON OR AFTER today — never in the past. The value was therefore
    // structurally 0 in every case, and the app's "N days late" line and its red chip were dead code.
    await seedProject();
    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    // Cadence starts 2026-07-30, so 07-30 is the oldest week owed on 08-13 — a fortnight late.
    expect(view.projects[0]!.outstandingWeeks[0]).toBe("2026-07-30");
    expect(view.projects[0]!.daysLate).toBe(14);
  });

  it("ages from the oldest week owed even when the offered list was truncated", async () => {
    // `outstanding` is collected walking backwards from the newest and stops at APP_OUTSTANDING_WEEK_LIMIT,
    // so `outstanding[0]` is the oldest of the five NEWEST weeks — not the oldest owed. Reading daysLate
    // off it understated lateness on exactly the projects neglected longest: this project is 32 weeks
    // behind and reported 35 days late.
    await seedProject({ cadenceStartDate: "2026-01-01" });
    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    const assignment = view.projects[0]!;
    expect(assignment.hasMoreOutstandingWeeks).toBe(true);
    expect(assignment.outstandingWeeks).toHaveLength(APP_OUTSTANDING_WEEK_LIMIT);
    // 2026-01-01 is the first Thursday owed; 2026-07-09 is the oldest week the list carries.
    expect(assignment.outstandingWeeks[0]).toBe("2026-07-09");
    expect(assignment.daysLate).toBe(224);
    expect(assignment.daysLate).not.toBe(35);
  });

  it("reports 0 late when the only week owed is the current one, before its due date", async () => {
    const project = await seedProject();
    // File both earlier weeks so the current one is all that is left. Filed, not merely started: a draft
    // leaves the week owed.
    await seedFiled(project.id, "2026-07-30");
    await seedFiled(project.id, PRIOR_WEEK);
    const monday = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: "2026-08-10" });
    expect(monday.projects[0]!.outstandingWeeks).toEqual([]);
    expect(monday.projects[0]!.daysLate).toBe(0);
  });

  it("starts ageing the moment a due date passes, because the week becomes outstanding", async () => {
    const project = await seedProject();
    await seedFiled(project.id, "2026-07-30");
    await seedFiled(project.id, PRIOR_WEEK);
    // Friday: the 13th is now late, and the 20th has become the current week.
    const friday = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: "2026-08-14" });
    expect(friday.projects[0]!.currentWeekOf).toBe("2026-08-20");
    expect(friday.projects[0]!.outstandingWeeks).toEqual([WEEK_OF]);
    expect(friday.projects[0]!.daysLate).toBe(1);
  });

  it("marks the current week unfilable once reporting has ended, keeping the misses fileable", async () => {
    // weeklyReportExpectedWeeks clamps to the end date and still returns the historical weeks, so the
    // project stays on the hub — but currentWeekOf is past the end date and assertValidWeekOf refuses it.
    // Without the flag the card renders a "Start week of Aug 13" button that always 400s.
    const project = await seedProject();
    await updateWeeklyReportProject(db, project.id, { cadenceEndDate: PRIOR_WEEK }, OFFICE);
    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    expect(view.projects[0]!.currentWeekFilable).toBe(false);
    expect(view.projects[0]!.outstandingWeeks).toEqual(["2026-07-30", PRIOR_WEEK]);
  });

  it("leaves the current week filable while reporting is still open", async () => {
    await seedProject();
    const view = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    expect(view.projects[0]!.currentWeekFilable).toBe(true);
  });
});

describe("the PM review queue", () => {
  it("holds a submitted report for the assigned PM and nobody else", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id, WEEK_OF);
    await updateWeeklyReportContent(db, id, { workCompleted: "- Framing complete" }, SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);

    const pmView = await listWeeklyReportAssignments(db, { userId: PM, role: "construction", asOf: WEEK_OF });
    expect(pmView.pendingReview).toHaveLength(1);
    expect(pmView.pendingReview[0]).toMatchObject({
      reportId: id,
      weekOf: WEEK_OF,
      status: "pending_review",
      authoredByName: "Steve Sanchez",
      projectName: "4123 Cedar Springs",
    });

    // The super who wrote it is not its reviewer — that is the entire point of the gate.
    const superView = await listWeeklyReportAssignments(db, { userId: SUPER, role: "construction", asOf: WEEK_OF });
    expect(superView.pendingReview).toEqual([]);
  });

  it("keeps an approved-but-unsent report in the queue", async () => {
    // Approving is not the end of the line — the send step is still the PM's move — so dropping it here
    // would make an approved report vanish with nobody responsible for it.
    const project = await seedProject();
    const id = await seedDraft(project.id, WEEK_OF);
    await updateWeeklyReportContent(db, id, { workCompleted: "- Framing complete" }, SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "approved", PM_ACTOR);

    const pmView = await listWeeklyReportAssignments(db, { userId: PM, role: "construction", asOf: WEEK_OF });
    expect(pmView.pendingReview.map((r) => r.status)).toEqual(["approved"]);
  });

  it("leaves a draft out of the queue", async () => {
    const project = await seedProject();
    await seedDraft(project.id, WEEK_OF);
    const pmView = await listWeeklyReportAssignments(db, { userId: PM, role: "construction", asOf: WEEK_OF });
    expect(pmView.pendingReview).toEqual([]);
  });

  it("still holds a submitted report after the project is paused", async () => {
    // The projects query is scoped to `status = 'active'` and the queue is not. An early return on "no
    // active projects" therefore hid a real submission the moment somebody paused the job it belongs to.
    const project = await seedProject();
    const id = await seedDraft(project.id, WEEK_OF);
    await updateWeeklyReportContent(db, id, { workCompleted: "- Framing complete" }, SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await updateWeeklyReportProject(db, project.id, { status: "paused" }, OFFICE);

    const pmView = await listWeeklyReportAssignments(db, { userId: PM, role: "construction", asOf: WEEK_OF });
    expect(pmView.projects).toEqual([]);
    expect(pmView.pendingReview.map((row) => row.reportId)).toEqual([id]);
    expect(pmView.pendingReviewTotal).toBe(1);
  });

  it("reports the queue's true depth when nothing was dropped", async () => {
    const project = await seedProject();
    await seedReviewRows(project.id, 3, "2026-06-04");
    const pmView = await listWeeklyReportAssignments(db, { userId: PM, role: "construction", asOf: WEEK_OF });
    expect(pmView.pendingReview).toHaveLength(3);
    expect(pmView.pendingReviewTotal).toBe(3);
  });

  it("caps a deep queue, says how deep it is, and keeps the NEWEST work reachable", async () => {
    // The cap was silent AND anchored at the oldest end. Because approving does not remove a row — an
    // approved-but-unsent report deliberately stays here — the first hundred could never be cleared from
    // the phone, so a report submitted this morning was permanently invisible to the PM who had to
    // review it, with nothing on screen admitting anything was missing.
    const project = await seedProject();
    const overflow = 4;
    const first = "2026-01-01";
    await seedReviewRows(project.id, APP_REVIEW_QUEUE_LIMIT + overflow, first);

    const pmView = await listWeeklyReportAssignments(db, { userId: PM, role: "construction", asOf: WEEK_OF });
    expect(pmView.pendingReview).toHaveLength(APP_REVIEW_QUEUE_LIMIT);
    expect(pmView.pendingReviewTotal).toBe(APP_REVIEW_QUEUE_LIMIT + overflow);

    const weeks = pmView.pendingReview.map((row) => row.weekOf);
    // Newest first, and what fell off the end is the ancient tail rather than this week's submission.
    expect([...weeks].sort().reverse()).toEqual(weeks);
    expect(weeks[0]).toBe(addDays(first, 7 * (APP_REVIEW_QUEUE_LIMIT + overflow - 1)));
    expect(weeks).not.toContain(first);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SENDS THAT NEVER REACHED THE CLIENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A week the PM actually SENT, walked up the real ladder, with the delivery outcome applied afterwards.
 *
 * The ladder is driven through the service so `status`, `sent_at` and `sent_by` are written by the code
 * that writes them in production. Only the DELIVERY columns are set directly, because in production those
 * are the WORKER's writes and this suite has no worker — which is the honest split: the test fakes the mail
 * provider's answer, not the CRM's behaviour.
 */
async function seedSent(
  projectId: string,
  weekOf: string,
  delivery: {
    deliveredAt?: string | null;
    sendError?: string | null;
    sendAttempts?: number;
    lastAttemptAt?: string | null;
    supersededById?: string | null;
  } = {},
): Promise<string> {
  const id = await seedFiled(projectId, weekOf);
  await transitionWeeklyReport(db, id, "approved", PM_ACTOR);
  await transitionWeeklyReport(db, id, "sent", PM_ACTOR);
  await pg.query(
    `UPDATE office_dallas.weekly_reports
        SET send_delivered_at = $2::timestamptz,
            send_error = $3,
            send_attempts = $4,
            send_last_attempt_at = $5::timestamptz,
            superseded_by_id = $6::uuid
      WHERE id = $1::uuid`,
    [
      id,
      delivery.deliveredAt ?? null,
      delivery.sendError ?? null,
      delivery.sendAttempts ?? 0,
      delivery.lastAttemptAt ?? null,
      delivery.supersededById ?? null,
    ],
  );
  return id;
}

describe("sends that never reached the client", () => {
  it("puts a FAILED send in front of the assigned PM", async () => {
    // The gap this list closes. A PM sends, the provider refuses the client's address, the worker stamps
    // `send_error` — and before this the week left the review queue, its project card read "Sent", and
    // T-Rock Cam showed that PM nothing ever again. The failure lived only on the CRM board and in the
    // sweep's alert email, neither of which a `construction` PM can open.
    const project = await seedProject();
    const id = await seedSent(project.id, WEEK_OF, {
      sendError: "The recipient address is invalid",
      sendAttempts: 3,
    });

    const pmView = await listWeeklyReportAssignments(db, { userId: PM, role: "construction", asOf: WEEK_OF });
    expect(pmView.undeliveredSends).toHaveLength(1);
    expect(pmView.undeliveredSends[0]).toMatchObject({
      reportId: id,
      weekOf: WEEK_OF,
      projectName: "4123 Cedar Springs",
      sendError: "The recipient address is invalid",
      sendAttempts: 3,
      version: 1,
    });
    // `sentAt` is not decoration: it is the age the provider's idempotency window is measured against, so
    // without it the app cannot tell whether a Retry needs the duplicate-risk acknowledgement.
    expect(pmView.undeliveredSends[0]!.sentAt).not.toBeNull();
    expect(pmView.undeliveredSendsTotal).toBe(1);
  });

  it("does NOT list a week the client actually received — the control", async () => {
    // THE CONTROL THAT MAKES THE TEST ABOVE MEAN ANYTHING. A list that simply returned every `sent` week
    // would pass "shows the failed one" perfectly, and would park every delivered week on the PM's hub for
    // ever. `send_delivered_at` is what empties this list, so an ordinary week appears for the seconds its
    // delivery is in flight and is gone on the next refresh.
    const project = await seedProject();
    await seedSent(project.id, WEEK_OF, { deliveredAt: "2026-08-13T20:00:30.000Z" });

    const pmView = await listWeeklyReportAssignments(db, { userId: PM, role: "construction", asOf: WEEK_OF });
    expect(pmView.undeliveredSends).toEqual([]);
    expect(pmView.undeliveredSendsTotal).toBe(0);
  });

  it("lists a send with NO error recorded, which is the failure nothing else would ever mention", async () => {
    // The delivery job records its outcome in the same database whose unavailability is the likeliest
    // reason it failed, so a job that dead-letters writes nothing at all: no error, no delivery, zero
    // attempts. Keying this list on `send_error IS NOT NULL` would have been tighter and would have missed
    // exactly the row that has nobody looking for it.
    const project = await seedProject();
    const id = await seedSent(project.id, WEEK_OF);

    const pmView = await listWeeklyReportAssignments(db, { userId: PM, role: "construction", asOf: WEEK_OF });
    expect(pmView.undeliveredSends.map((row) => row.reportId)).toEqual([id]);
    expect(pmView.undeliveredSends[0]!.sendError).toBeNull();
  });

  it("never lists a SUPERSEDED version, whose email must not go out at all", async () => {
    // v1 sent and undelivered, corrected, v2 sent and delivered. v1 is then still `sent`, still
    // undelivered, and its stored request still carries a live share URL — every predicate a naive query
    // checks is satisfied. `retryWeeklyReportSend` refuses that row outright, so listing it would put a
    // button in front of the PM that cannot work; and if it ever did work it would email a paying client
    // the version they were already told was replaced.
    const project = await seedProject();
    const live = await seedSent(project.id, PRIOR_WEEK, { deliveredAt: "2026-08-07T09:00:00.000Z" });
    await seedSent(project.id, WEEK_OF, { supersededById: live });

    const pmView = await listWeeklyReportAssignments(db, { userId: PM, role: "construction", asOf: WEEK_OF });
    expect(pmView.undeliveredSends).toEqual([]);
  });

  it("keeps an undelivered send OFF the review queue, which is a different job", async () => {
    // The obvious implementation was to widen `status IN ('pending_review','approved')` to include `sent`.
    // That would have brought every DELIVERED week back into "waiting on your review" for ever — and,
    // because `mobile/` has no OTA, would have pushed un-actionable `sent` rows into the review list of
    // every app build already on a phone, where the only tap opens a wizard that refuses to edit a sent
    // report. The two lists stay separate.
    const project = await seedProject();
    await seedSent(project.id, WEEK_OF, { sendError: "Refused" });

    const pmView = await listWeeklyReportAssignments(db, { userId: PM, role: "construction", asOf: WEEK_OF });
    expect(pmView.pendingReview).toEqual([]);
    expect(pmView.undeliveredSends).toHaveLength(1);
  });

  it("shows it to the assigned PM and to leadership, and to nobody else", async () => {
    const project = await seedProject();
    await seedSent(project.id, WEEK_OF, { sendError: "Refused" });

    const pmView = await listWeeklyReportAssignments(db, { userId: PM, role: "construction", asOf: WEEK_OF });
    expect(pmView.undeliveredSends).toHaveLength(1);

    const directorView = await listWeeklyReportAssignments(db, {
      userId: DIRECTOR,
      role: "director",
      asOf: WEEK_OF,
    });
    expect(directorView.undeliveredSends).toHaveLength(1);

    // The superintendent who WROTE the report is not the person who sent it and cannot retry it — the
    // service refuses them regardless, and the hub must not imply otherwise.
    const superView = await listWeeklyReportAssignments(db, {
      userId: SUPER,
      role: "construction",
      asOf: WEEK_OF,
    });
    expect(superView.undeliveredSends).toEqual([]);

    const strangerView = await listWeeklyReportAssignments(db, {
      userId: OTHER_SUPER,
      role: "construction",
      asOf: WEEK_OF,
    });
    expect(strangerView.undeliveredSends).toEqual([]);
  });

  it("still lists an undelivered send after the project is paused", async () => {
    // Pausing a job stops the cadence generating weeks; it does not un-send an email. A client owed a
    // report they never received is owed it whatever the project's status says.
    const project = await seedProject();
    const id = await seedSent(project.id, WEEK_OF, { sendError: "Refused" });
    await updateWeeklyReportProject(db, project.id, { status: "paused" }, OFFICE);

    const pmView = await listWeeklyReportAssignments(db, { userId: PM, role: "construction", asOf: WEEK_OF });
    expect(pmView.projects).toEqual([]);
    expect(pmView.undeliveredSends.map((row) => row.reportId)).toEqual([id]);
  });
});

describe("who may open a report by id", () => {
  async function seedSubmitted() {
    const project = await seedProject();
    const id = await seedDraft(project.id, WEEK_OF);
    await updateWeeklyReportContent(db, id, { workCompleted: "- Framing complete" }, SUPER_ACTOR);
    return id;
  }

  it("refuses a superintendent with no role on the project, without confirming the id exists", async () => {
    // 404, not 403: a 403 tells an unrelated field user that the id names a real report on a project they
    // are not on, which is exactly the probe this check exists to defeat. /api/field admits every field
    // user in the company, so a bare id would otherwise be enough to read a client's contact block.
    const id = await seedSubmitted();
    await expectAppError(getWeeklyReportForActor(db, id, OTHER_SUPER_ACTOR), 404, /not found/i);
  });

  it("lets the assigned super, the assigned PM and a director in", async () => {
    const id = await seedSubmitted();
    for (const actor of [SUPER_ACTOR, PM_ACTOR, DIRECTOR_ACTOR]) {
      await expect(getWeeklyReportForActor(db, id, actor)).resolves.toMatchObject({ report: { id } });
    }
  });

  it("still lets the author open what they wrote after the assignment moves on", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id, WEEK_OF);
    await updateWeeklyReportProject(db, project.id, { trockSuperResponderId: OTHER_SUPER_RESPONDER }, OFFICE);
    await expect(getWeeklyReportForActor(db, id, SUPER_ACTOR)).resolves.toMatchObject({ report: { id } });
  });

  it("answers the permission questions the app would otherwise guess at", async () => {
    const id = await seedSubmitted();

    const asSuper = await getWeeklyReportForActor(db, id, SUPER_ACTOR);
    expect(asSuper.permissions).toEqual({
      canEdit: true,
      canSubmit: true,
      canApprove: false,
      canReturnToDraft: false,
      // FALSE FOR THE WHOLE FIELD SURFACE. Delete is admin/director only and both actors here are
      // `construction`, which is what the assigned PM and superintendent actually are — so the phone
      // reads `canDelete: false` on every report it will ever be shown, and there is no delete route on
      // /api/field to reach even if it did not.
      canDelete: false,
    });

    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    const asPm = await getWeeklyReportForActor(db, id, PM_ACTOR);
    expect(asPm.permissions).toEqual({
      canEdit: true,
      canSubmit: false,
      canApprove: true,
      canReturnToDraft: true,
      canDelete: false,
    });
  });

  it("reports a sent report as readable by all and editable by none", async () => {
    const id = await seedSubmitted();
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "approved", PM_ACTOR);
    await transitionWeeklyReport(db, id, "sent", PM_ACTOR);

    const asSuper = await getWeeklyReportForActor(db, id, SUPER_ACTOR);
    expect(asSuper.report.status).toBe("sent");
    expect(asSuper.permissions).toMatchObject({ canEdit: false, canApprove: false });
    const asPm = await getWeeklyReportForActor(db, id, PM_ACTOR);
    expect(asPm.permissions).toMatchObject({ canEdit: false });
  });

  it("carries the project header the wizard renders", async () => {
    const id = await seedSubmitted();
    const { project } = await getWeeklyReportForActor(db, id, SUPER_ACTOR);
    expect(project).toMatchObject({
      propertyDisplayName: "4123 Cedar Springs",
      clientName: "Mack Real Estate Group",
      trockSuperName: "Steve Sanchez",
      trockPmName: "Adam Sherwood",
      projectedDurationWeeks: 19,
    });
  });

  it("keeps the client contact block off the field response", async () => {
    // The service returns the whole setup row, `clientTeam` included — four client contacts by name and
    // email. The CRM dashboard needs those; a surface every field user in the company can authenticate
    // against does not, so the field route projects the response down to the header the wizard renders.
    const id = await seedSubmitted();
    const { project } = await getWeeklyReportForActor(db, id, SUPER_ACTOR);
    expect(project.clientTeam.doc).toEqual({ name: "Jay Stauble", email: "jay@example.com" });
    expect(toFieldWeeklyReportProject(project)).not.toHaveProperty("clientTeam");
    expect(JSON.stringify(toFieldWeeklyReportProject(project))).not.toContain("jay@example.com");
  });
});

describe("an author reassigned off the project mid-draft", () => {
  async function seedReassignedDraft() {
    const project = await seedProject();
    const id = await seedDraft(project.id, WEEK_OF);
    await updateWeeklyReportContent(db, id, { workCompleted: "- Framing complete" }, SUPER_ACTOR);
    // Somebody else is the superintendent now; SUPER holds nothing but `authored_by`.
    await updateWeeklyReportProject(db, project.id, { trockSuperResponderId: OTHER_SUPER_RESPONDER }, OFFICE);
    return { project, id };
  }

  it("can finish the submit the payload promises them", async () => {
    // THE BUG. canViewWeeklyReport and canTransitionAs both honour `authored_by`, so the app showed this
    // person their draft with `canSubmit: true` — but canEditWeeklyReport recognised only the current
    // assignments, and a submit is a content PATCH and a whole-set photo PUT BEFORE the transition. Both
    // 403'd, the transition was never reached, and the work sitting on their phone could never be filed
    // by anyone: the new superintendent cannot see the local draft, and there is no other copy of it.
    const { id } = await seedReassignedDraft();

    const before = await getWeeklyReportForActor(db, id, SUPER_ACTOR);
    expect(before.permissions).toMatchObject({ canEdit: true, canSubmit: true });

    await expect(
      updateWeeklyReportContent(db, id, { workCompleted: "- Roof dried in" }, SUPER_ACTOR),
    ).resolves.toMatchObject({ workCompleted: "- Roof dried in" });
    await expect(replaceWeeklyReportPhotos(db, id, [], SUPER_ACTOR)).resolves.toMatchObject({ id });
    await expect(transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR)).resolves.toMatchObject({
      status: "pending_review",
    });
  });

  it("loses the edit the moment the report leaves draft", async () => {
    // Draft-only. Once it is with the PM, a former assignee has no more claim on it than any other, and
    // letting them rewrite what is under review would be a bigger hole than the one this closes.
    const { id } = await seedReassignedDraft();
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);

    const after = await getWeeklyReportForActor(db, id, SUPER_ACTOR);
    expect(after.permissions).toMatchObject({ canEdit: false, canSubmit: false });
    await expectAppError(
      updateWeeklyReportContent(db, id, { workCompleted: "- Rewritten" }, SUPER_ACTOR),
      403,
      /permission/i,
    );
  });

  it("never becomes an editor of an approved report", async () => {
    const { id } = await seedReassignedDraft();
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "approved", PM_ACTOR);
    await expectAppError(replaceWeeklyReportPhotos(db, id, [], SUPER_ACTOR), 403, /permission/i);
  });

  it("leaves a report the author never wrote alone", async () => {
    // The clause keys on `authored_by`, not on "was ever on this project" — an unrelated field user with
    // a valid session still gets nothing.
    const project = await seedProject();
    const id = await seedDraft(project.id, WEEK_OF);
    await expectAppError(
      updateWeeklyReportContent(db, id, { workCompleted: "- Not mine" }, OTHER_SUPER_ACTOR),
      403,
      /permission/i,
    );
  });
});
