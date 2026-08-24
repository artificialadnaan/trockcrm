// Runtime suite for DELETING a weekly report — the writer `weekly_reports.is_active` never had.
//
// The column shipped with 0222 and ~20 queries have honoured it ever since; three separate code comments
// reason about soft-deleted reports as though the feature existed. Nothing could produce one. This suite
// covers the write that finally can, and it is written against the real migrations from disk because the
// guards it proves are SQL predicates rather than branches: the delete is conditioned on the status the
// permission check ran against, and a test that cannot make that condition fail proves nothing about it.
//
// The audit row is asserted through a Drizzle handle over the same PGlite instance, because
// `writeSoftDeleteAuditLog` takes `NodePgDatabase` and writes through the ORM — the bare `query` shim the
// services use cannot stand in for it, and a test that skipped the real writer would only assert that a
// hand-rolled INSERT works.

import express from "express";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditLog,
  deals,
  fieldResponders,
  files,
  offices,
  userOfficeAccess,
  users,
} from "@trock-crm/shared/schema";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import { migrationSql } from "../../helpers/migration-sql.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { AppError, errorHandler } from "../../../src/middleware/error-handler.js";
import { weeklyReportRoutes } from "../../../src/modules/weekly-reports/routes.js";
import { createWeeklyReportProject } from "../../../src/modules/weekly-reports/projects-service.js";
import {
  WEEKLY_REPORT_WEEK_EXISTS_CODE,
  createWeeklyReportDraft,
  deleteWeeklyReport,
  getWeeklyReportDetail,
  listWeeklyReports,
} from "../../../src/modules/weekly-reports/reports-service.js";
import { getWeeklyReportDashboard } from "../../../src/modules/weekly-reports/dashboard-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const OFFICE = U("00001");
const DEAL = U("11111");
const PM = U("22221");
const SUPER = U("22222");
const DIRECTOR = U("22223");
const ADMIN = U("22225");
const REP = U("22224");
const PM_RESPONDER = U("44441");
const SUPER_RESPONDER = U("44442");
const WON_STAGE = U("33331");

const PM_ACTOR = { id: PM, role: "construction" };
const SUPER_ACTOR = { id: SUPER, role: "construction" };
const DIRECTOR_ACTOR = { id: DIRECTOR, role: "director" };
const ADMIN_ACTOR = { id: ADMIN, role: "admin" };
const REP_ACTOR = { id: REP, role: "rep" };

// The reference report's week: Thursday 2026-08-13.
const THURSDAY = 4;
const WEEK_OF = "2026-08-13";
const PRIOR_WEEK = "2026-08-06";

let pg: PGlite;
/** Drizzle over the SAME instance — what `writeSoftDeleteAuditLog` requires and the services do not. */
let tdb: any;

/** See weekly-reports.runtime.test.ts: rowCount must come from PGlite's affectedRows, not rows.length. */
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
 * A `db` that commits a status change mid-call, immediately before the statement matching `trigger`.
 *
 * The window this stands in for is the one between the status the permission check read and the write
 * that acts on it. Mutating the row BEFORE the call instead lands on the up-front sent-report guard and
 * proves nothing about the UPDATE's own condition — which is the whole point of the predicate.
 */
function racingDb(reportId: string, trigger: string, to: string) {
  let fired = false;
  return {
    query: async (text: string, params?: unknown[]) => {
      if (!fired && text.includes(trigger)) {
        fired = true;
        await pg.query(`UPDATE office_dallas.weekly_reports SET status = $2 WHERE id = $1::uuid`, [
          reportId,
          to,
        ]);
      }
      return db.query(text, params);
    },
  } as typeof db;
}

/**
 * A `db` that soft-deletes the report mid-call, immediately before the statement matching `trigger`.
 *
 * The sibling above races a STATUS change, which the UPDATE's `status = $2` predicate catches. This one
 * races another DELETE, which it cannot: a soft delete leaves `status` exactly where it was, so both
 * requests read the same status and both write against it. Only `AND is_active` tells them apart.
 */
function racingDelete(reportId: string, trigger: string) {
  let fired = false;
  return {
    query: async (text: string, params?: unknown[]) => {
      if (!fired && text.includes(trigger)) {
        fired = true;
        await pg.query(`UPDATE office_dallas.weekly_reports SET is_active = false WHERE id = $1::uuid`, [
          reportId,
        ]);
      }
      return db.query(text, params);
    },
  } as typeof db;
}

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
  await pg.exec(tenantSchemaSql("public", [offices, users, userOfficeAccess]));
  // `audit_log` alongside the rest: the delete's forensic record is written through Drizzle into the
  // TENANT schema, and a suite without the table would pass by never reaching the writer.
  await pg.exec(tenantSchemaSql("office_dallas", [deals, fieldResponders, files, auditLog]));
  await pg.exec(
    `CREATE TABLE IF NOT EXISTS public.pipeline_stage_config (id uuid PRIMARY KEY, slug text);`,
  );

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
      ('${PM}', 'Adam Sherwood', 'pm@example.com', 'construction', '${OFFICE}'),
      ('${SUPER}', 'Steve Sanchez', 'super@example.com', 'construction', '${OFFICE}'),
      ('${DIRECTOR}', 'Takashi', 'director@example.com', 'director', '${OFFICE}'),
      ('${ADMIN}', 'Adnaan', 'admin@example.com', 'admin', '${OFFICE}'),
      ('${REP}', 'Nobody', 'nobody@example.com', 'rep', '${OFFICE}');
    INSERT INTO public.pipeline_stage_config (id, slug) VALUES ('${WON_STAGE}', '${WON_DEAL_STAGE_SLUGS[0]}');
    INSERT INTO office_dallas.field_responders (id, name, email, role, is_active) VALUES
      ('${PM_RESPONDER}', 'Adam Sherwood', 'pm@example.com', 'project_manager', true),
      ('${SUPER_RESPONDER}', 'Steve Sanchez', 'super@example.com', 'superintendent', true);
    INSERT INTO office_dallas.deals (id, name, deal_number, stage_id, project_number) VALUES
      ('${DEAL}', '4123 Cedar Springs', 'DFW-10432', '${WON_STAGE}', 'DFW-10432');
    SET search_path TO office_dallas, public;
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM office_dallas.audit_log;
    DELETE FROM office_dallas.weekly_report_photos;
    DELETE FROM office_dallas.weekly_report_dismissals;
    DELETE FROM office_dallas.weekly_report_pauses;
    DELETE FROM office_dallas.weekly_report_reminders_sent;
    DELETE FROM office_dallas.weekly_reports;
    DELETE FROM office_dallas.weekly_report_projects;
    DELETE FROM office_dallas.weekly_report_settings;
  `);
});

let submissionSeq = 0;
function nextSubmissionId(): string {
  submissionSeq += 1;
  return U(`8${String(submissionSeq).padStart(4, "0")}`);
}

async function seedProject(overrides: Record<string, unknown> = {}) {
  return createWeeklyReportProject(
    db,
    {
      dealId: DEAL,
      propertyDisplayName: "4123 Cedar Springs",
      clientName: "Mack Real Estate Group",
      clientTeam: { doc: { name: "Jay Stauble", email: "jay@example.com" } },
      trockPmResponderId: PM_RESPONDER,
      trockSuperResponderId: SUPER_RESPONDER,
      contractDate: "2026-07-08",
      projectedDurationWeeks: 19,
      cadenceWeekday: THURSDAY,
      cadenceStartDate: "2026-07-27",
      ...overrides,
    } as any,
    DIRECTOR,
    OFFICE,
  );
}

/** A draft authored by the superintendent, which is how every report begins. */
async function seedDraft(projectId: string, weekOf = WEEK_OF) {
  const { report } = await createWeeklyReportDraft(
    db,
    { clientSubmissionId: nextSubmissionId(), weeklyReportProjectId: projectId, weekOf },
    SUPER_ACTOR,
  );
  await pg.query(
    `UPDATE office_dallas.weekly_reports SET work_completed = 'Framing on level 3' WHERE id = $1::uuid`,
    [report.id],
  );
  return report.id;
}

/**
 * A second version of a week, written directly.
 *
 * `createWeeklyReportDraft` refuses a week that already has a live report — correctly, that is two people
 * starting the same week — so the correction chain has to be seeded the way `send-service` writes it.
 */
async function seedVersion(projectId: string, version: number, weekOf = WEEK_OF): Promise<string> {
  const result = await pg.query<{ id: string }>(
    `INSERT INTO office_dallas.weekly_reports
       (client_submission_id, weekly_report_project_id, deal_id, week_of, version, status,
        work_completed, authored_by, authored_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, 'draft', 'Framing on level 3', $6::uuid, now())
     RETURNING id`,
    [nextSubmissionId(), projectId, DEAL, weekOf, version, SUPER],
  );
  return result.rows[0]!.id;
}

/** Drop a report straight to a status without walking the ladder — the ladder is another suite's job. */
async function setStatus(reportId: string, status: string) {
  await pg.query(
    `UPDATE office_dallas.weekly_reports
        SET status = $2::text, sent_at = CASE WHEN $2::text = 'sent' THEN now() ELSE sent_at END
      WHERE id = $1::uuid`,
    [reportId, status],
  );
}

async function isActive(reportId: string): Promise<boolean> {
  const result = await pg.query<{ is_active: boolean }>(
    `SELECT is_active FROM office_dallas.weekly_reports WHERE id = $1::uuid`,
    [reportId],
  );
  return result.rows[0]!.is_active;
}

describe("deleting a weekly report", () => {
  it("soft-deletes a draft for an admin and reports back what it removed", async () => {
    const project = await seedProject();
    const reportId = await seedDraft(project.id);

    const removed = await deleteWeeklyReport(db, reportId, ADMIN_ACTOR, {
      reason: "Test data from the e2e runbook",
    });

    expect(removed).toMatchObject({ id: reportId, status: "draft", weekOf: WEEK_OF });
    expect(await isActive(reportId)).toBe(false);
  });

  it("lets a director delete too — leadership, not one named role", async () => {
    const project = await seedProject();
    const reportId = await seedDraft(project.id);

    await deleteWeeklyReport(db, reportId, DIRECTOR_ACTOR, { reason: "Duplicate week" });
    expect(await isActive(reportId)).toBe(false);
  });

  it("refuses the report's own author, which is the case the role gate exists for", async () => {
    // `canEditWeeklyReport` would allow this: the superintendent authored the draft and may write its
    // content. Deleting it is not an edit — the row is the record that the week was filed at all — so the
    // gate is deliberately NOT the edit predicate.
    const project = await seedProject();
    const reportId = await seedDraft(project.id);

    await expectAppError(
      deleteWeeklyReport(db, reportId, SUPER_ACTOR, { reason: "Filed it by mistake" }),
      403,
      /admin or director/i,
    );
    expect(await isActive(reportId)).toBe(true);
  });

  it("refuses a rep, who can otherwise read this whole router", async () => {
    const project = await seedProject();
    const reportId = await seedDraft(project.id);

    await expectAppError(
      deleteWeeklyReport(db, reportId, REP_ACTOR, { reason: "Tidying the board up" }),
      403,
    );
    expect(await isActive(reportId)).toBe(true);
  });

  it("requires a reason with something in it — whitespace is not one", async () => {
    const project = await seedProject();
    const reportId = await seedDraft(project.id);

    await expectAppError(deleteWeeklyReport(db, reportId, ADMIN_ACTOR, { reason: "   " }), 400, /reason/i);
    await expectAppError(deleteWeeklyReport(db, reportId, ADMIN_ACTOR, { reason: "" }), 400, /reason/i);
    expect(await isActive(reportId)).toBe(true);

    // The other side of the same rule: a SHORT reason is a reason. The dialog's disabled state and this
    // 400 have to agree, and the house rule everywhere else in the app is non-empty.
    await expect(
      deleteWeeklyReport(db, reportId, ADMIN_ACTOR, { reason: "dupe" }),
    ).resolves.toMatchObject({ id: reportId });
  });

  it("refuses a second delete with a 404 rather than reporting success twice", async () => {
    const project = await seedProject();
    const reportId = await seedDraft(project.id);

    await deleteWeeklyReport(db, reportId, ADMIN_ACTOR, { reason: "Test data" });
    await expectAppError(
      deleteWeeklyReport(db, reportId, ADMIN_ACTOR, { reason: "Test data" }),
      404,
      /not found/i,
    );
  });

  describe("a report the client already received", () => {
    it("refuses without the week typed back", async () => {
      const project = await seedProject();
      const reportId = await seedDraft(project.id);
      await setStatus(reportId, "sent");

      await expectAppError(
        deleteWeeklyReport(db, reportId, ADMIN_ACTOR, { reason: "Sent to the wrong client" }),
        400,
        /week of the sent report/i,
      );
      expect(await isActive(reportId)).toBe(true);
    });

    it("refuses the WRONG week", async () => {
      const project = await seedProject();
      const reportId = await seedDraft(project.id);
      await setStatus(reportId, "sent");

      await expectAppError(
        deleteWeeklyReport(db, reportId, ADMIN_ACTOR, {
          reason: "Sent to the wrong client",
          confirmWeekOf: PRIOR_WEEK,
        }),
        400,
        /week of the sent report/i,
      );
      expect(await isActive(reportId)).toBe(true);
    });

    it("accepts the right week — and the right week is the ISO string, not a Date", async () => {
      // `week_of` is a `date` column, so node-postgres hands back a Date object. Comparing the confirmed
      // string against the raw column value is `"2026-08-13" === Date` and therefore false forever: the
      // guard would refuse every correctly-typed week and the feature would be unusable on exactly the
      // reports it exists to protect.
      const project = await seedProject();
      const reportId = await seedDraft(project.id);
      await setStatus(reportId, "sent");

      await deleteWeeklyReport(db, reportId, ADMIN_ACTOR, {
        reason: "Sent to the wrong client",
        confirmWeekOf: WEEK_OF,
      });
      expect(await isActive(reportId)).toBe(false);
    });
  });

  it("refuses a report that supersedes a live predecessor, which would strand the week", async () => {
    // Deleting v2 leaves v1 excluded from the board (it is `superseded_by_id`-stamped) AND v2 excluded
    // (inactive). The week reappears as never filed, and the reminder job emails the super, the PM and
    // leadership about a week the client has already received twice. Nothing clears `superseded_by_id`
    // and History offers no action on either row, so the state has no way out.
    const project = await seedProject();
    const v1 = await seedDraft(project.id);
    await setStatus(v1, "sent");
    const v2 = await seedVersion(project.id, 2);
    await pg.query(`UPDATE office_dallas.weekly_reports SET superseded_by_id = $2::uuid WHERE id = $1::uuid`, [
      v1,
      v2,
    ]);

    await expectAppError(
      deleteWeeklyReport(db, v2, ADMIN_ACTOR, { reason: "Correction was a mistake" }),
      409,
      /replaced an earlier version/i,
    );
    expect(await isActive(v2)).toBe(true);

    // The predecessor itself is still deletable — it is the SUPERSEDING row that strands a week, not the
    // superseded one, whose replacement remains live and on the board.
    await expect(
      deleteWeeklyReport(db, v1, ADMIN_ACTOR, { reason: "Superseded", confirmWeekOf: WEEK_OF }),
    ).resolves.toMatchObject({ id: v1 });
  });

  it("refuses when the report is sent out from under it mid-call", async () => {
    // The permission check reads a status; the UPDATE writes against one. Between the two another request
    // can commit. Without the status predicate on the UPDATE the sent-report confirmation is bypassable:
    // read `approved`, skip the week-confirm because the status said `approved`, and delete a report the
    // client has since been emailed.
    const project = await seedProject();
    const reportId = await seedDraft(project.id);
    await setStatus(reportId, "approved");

    await expectAppError(
      deleteWeeklyReport(
        racingDb(reportId, "UPDATE weekly_reports SET is_active = false", "sent"),
        reportId,
        ADMIN_ACTOR,
        { reason: "Test data" },
      ),
      409,
      /changed while you were working on it/i,
    );
    expect(await isActive(reportId)).toBe(true);
  });

  it("refuses when somebody else deleted it mid-call, rather than auditing the same removal twice", async () => {
    // The double-delete test above is settled by the LOAD's `is_active`, before the write is reached —
    // so it says nothing about the UPDATE's own clause. This is the case only that clause can answer: a
    // soft delete does not move `status`, so the concurrency predicate the other guards rely on matches
    // happily and both callers would be told they removed the report. The second would go on to write a
    // second forensic row for a deletion that had already happened.
    const project = await seedProject();
    const reportId = await seedDraft(project.id);

    await expectAppError(
      deleteWeeklyReport(
        racingDelete(reportId, "UPDATE weekly_reports SET is_active = false"),
        reportId,
        ADMIN_ACTOR,
        { reason: "Test data" },
      ),
      409,
      /changed while you were working on it/i,
    );
  });

  it("deletes a report whose reporting setup has been stopped", async () => {
    // A stopped setup is exactly where leftover test data sits, and `getWeeklyReportProjectRow` filters
    // `is_active` — so gating on it would make those reports permanently undeletable, refused with
    // "Weekly report project not found", which is not even true. The share-link routes already opt out
    // of that filter for the same reason: you cannot withdraw what you cannot reach.
    const project = await seedProject();
    const reportId = await seedDraft(project.id);
    await pg.query(`UPDATE office_dallas.weekly_report_projects SET is_active = false WHERE id = $1::uuid`, [
      project.id,
    ]);

    await deleteWeeklyReport(db, reportId, ADMIN_ACTOR, { reason: "Archived setup, test data" });
    expect(await isActive(reportId)).toBe(false);
  });

});

/**
 * THROUGH THE ROUTE, against the same PGlite instance.
 *
 * Two things only exist at this layer and are therefore untestable one level down: the 204, and the
 * forensic audit row — `writeSoftDeleteAuditLog` takes a Drizzle handle rather than a query executor, so
 * the service cannot call it and a service-level test asserting one would be asserting a call the
 * production path never makes. `req.tenantDb` and `req.tenantClient` are the SAME connection in
 * production (tenant middleware builds the Drizzle instance over the pooled client), which is what makes
 * the audit row atomic with the delete, and they are the same connection here.
 */
describe("DELETE /weekly-reports/reports/:id", () => {
  function app(role: string, userId: string) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      (req as any).user = { id: userId, role, activeOfficeId: OFFICE };
      (req as any).tenantClient = db;
      (req as any).tenantDb = tdb;
      (req as any).commitTransaction = async () => {};
      next();
    });
    instance.use("/weekly-reports", weeklyReportRoutes);
    instance.use(errorHandler);
    return instance;
  }

  it("answers 204 and writes the forensic record the other soft-deleting modules write", async () => {
    // This module was the only soft-deleting one skipping the helper. The reason is the whole point of
    // demanding one: an audit row recording the deletion without it says no more than `is_active` does.
    const project = await seedProject();
    const reportId = await seedDraft(project.id);

    const response = await request(app("admin", ADMIN))
      .delete(`/weekly-reports/reports/${reportId}`)
      .send({ reason: "  Test data from the e2e runbook  " });

    expect(response.status).toBe(204);
    expect(await isActive(reportId)).toBe(false);

    const rows = await pg.query<{
      table_name: string;
      record_id: string;
      action: string;
      changed_by: string;
      full_row: { reason?: string } | null;
    }>(`SELECT table_name, record_id, action, changed_by, full_row FROM office_dallas.audit_log`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      table_name: "weekly_report",
      record_id: reportId,
      action: "soft_delete",
      changed_by: ADMIN,
    });
    // TRIMMED, and the same text the service validated. A reason recorded with the user's stray
    // whitespace is cosmetic; a reason recorded as something OTHER than what they typed is not.
    expect(rows.rows[0]!.full_row).toEqual({ reason: "Test data from the e2e runbook" });
  });

  it("writes no audit row for a delete it refused", async () => {
    // The audit log is evidence. A row for a delete that never happened is worse than no row at all —
    // and this is the ordering bug the route would have if the audit write came first.
    const project = await seedProject();
    const reportId = await seedDraft(project.id);
    await setStatus(reportId, "sent");

    const response = await request(app("admin", ADMIN))
      .delete(`/weekly-reports/reports/${reportId}`)
      .send({ reason: "Sent to the wrong client" });

    expect(response.status).toBe(400);
    expect(await isActive(reportId)).toBe(true);
    const rows = await pg.query(`SELECT 1 FROM office_dallas.audit_log`);
    expect(rows.rows).toHaveLength(0);
  });

  it("carries the typed week through the body, which is where the sent guard reads it", async () => {
    const project = await seedProject();
    const reportId = await seedDraft(project.id);
    await setStatus(reportId, "sent");

    const response = await request(app("director", DIRECTOR))
      .delete(`/weekly-reports/reports/${reportId}`)
      .send({ reason: "Sent to the wrong client", confirmWeekOf: WEEK_OF });

    expect(response.status).toBe(204);
    expect(await isActive(reportId)).toBe(false);
  });
});

describe("what a deleted report stops doing", () => {
  it("leaves the History list and the board, and stops being a source of truth for next week", async () => {
    const project = await seedProject();
    const reportId = await seedDraft(project.id);

    expect(await listWeeklyReports(db, { projectId: project.id }, DIRECTOR_ACTOR)).toHaveLength(1);
    await deleteWeeklyReport(db, reportId, ADMIN_ACTOR, { reason: "Test data" });

    expect(await listWeeklyReports(db, { projectId: project.id }, DIRECTOR_ACTOR)).toHaveLength(0);
    expect(await getWeeklyReportDetail(db, reportId)).toBeNull();

    const dashboard = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const week = dashboard.rows.find((row) => row.weekOf === WEEK_OF);
    expect(week?.reportId).toBeNull();
  });

  it("stops counting as the version a correction replaces, so the next email says the right thing", async () => {
    // `priorVersionReachedClient` filters `AND is_active`. A delivered v1 that is then deleted makes the
    // next version's email read "here is this week's report" to a client who is holding v1 — the one
    // sentence the correction wording exists to prevent.
    const project = await seedProject();
    const v1 = await seedDraft(project.id);
    await setStatus(v1, "sent");
    await pg.query(
      `UPDATE office_dallas.weekly_reports SET send_delivered_at = now(), send_delivery_status = 'delivered'
        WHERE id = $1::uuid`,
      [v1],
    );

    const before = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM office_dallas.weekly_reports
        WHERE weekly_report_project_id = $1::uuid AND week_of = $2::date AND version < 2
          AND is_active AND status = 'sent' AND send_delivered_at IS NOT NULL`,
      [project.id, WEEK_OF],
    );
    expect(before.rows[0]!.n).toBe(1);

    await deleteWeeklyReport(db, v1, ADMIN_ACTOR, {
      reason: "Sent to the wrong client",
      confirmWeekOf: WEEK_OF,
    });

    const after = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM office_dallas.weekly_reports
        WHERE weekly_report_project_id = $1::uuid AND week_of = $2::date AND version < 2
          AND is_active AND status = 'sent' AND send_delivered_at IS NOT NULL`,
      [project.id, WEEK_OF],
    );
    expect(after.rows[0]!.n).toBe(0);
  });
});

describe("creating a report after one has been deleted", () => {
  it("answers 409 for a deleted submission id, never a 404 on a create", async () => {
    // `client_submission_id` is the phone's idempotency key for flaky-LTE retries and its UNIQUE
    // constraint is NOT partial — so once a report is deleted, that key can never produce a row again.
    // Reading it without `is_active` and then dereferencing through a detail load that DOES filter
    // `is_active` answered 404 "Weekly report not found" to a CREATE call, permanently.
    const project = await seedProject();
    const submissionId = nextSubmissionId();
    const { report } = await createWeeklyReportDraft(
      db,
      { clientSubmissionId: submissionId, weeklyReportProjectId: project.id, weekOf: WEEK_OF },
      SUPER_ACTOR,
    );
    await deleteWeeklyReport(db, report.id, ADMIN_ACTOR, { reason: "Test data" });

    let caught: unknown;
    try {
      await createWeeklyReportDraft(
        db,
        { clientSubmissionId: submissionId, weeklyReportProjectId: project.id, weekOf: WEEK_OF },
        SUPER_ACTOR,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).statusCode).toBe(409);
    // The CODE, not the prose: the phone tells this 409 apart from "reporting is paused" by matching it,
    // and the two want opposite handling.
    expect((caught as AppError).code).toBe(WEEKLY_REPORT_WEEK_EXISTS_CODE);
  });

  it("lets a FRESH submission id refile the deleted week, which is the point of deleting it", async () => {
    const project = await seedProject();
    const reportId = await seedDraft(project.id);
    await deleteWeeklyReport(db, reportId, ADMIN_ACTOR, { reason: "Test data" });

    const { report, created } = await createWeeklyReportDraft(
      db,
      { clientSubmissionId: nextSubmissionId(), weeklyReportProjectId: project.id, weekOf: WEEK_OF },
      SUPER_ACTOR,
    );
    expect(created).toBe(true);
    expect(report.id).not.toBe(reportId);
  });
});

describe("what the history list says this actor may do", () => {
  it("offers delete to leadership and to nobody else", async () => {
    const project = await seedProject();
    await seedDraft(project.id);

    const [asAdmin] = await listWeeklyReports(db, { projectId: project.id }, ADMIN_ACTOR);
    const [asDirector] = await listWeeklyReports(db, { projectId: project.id }, DIRECTOR_ACTOR);
    const [asPm] = await listWeeklyReports(db, { projectId: project.id }, PM_ACTOR);
    const [asRep] = await listWeeklyReports(db, { projectId: project.id }, REP_ACTOR);

    expect(asAdmin!.permissions.canDelete).toBe(true);
    expect(asDirector!.permissions.canDelete).toBe(true);
    expect(asPm!.permissions.canDelete).toBe(false);
    expect(asRep!.permissions.canDelete).toBe(false);
  });

  it("resolves canEdit against the PROJECT, which the list query never used to join", async () => {
    // AT `pending_review`, DELIBERATELY. `canEditWeeklyReport` has a second arm — the author, while the
    // report is still a draft — and the superintendent authored every draft in this fixture, so a draft
    // would answer `canEdit: true` through that arm with the project row absent entirely. This status is
    // the one where the assignment is the ONLY thing granting the right, which is what the join is for.
    const project = await seedProject();
    const reportId = await seedDraft(project.id);
    await setStatus(reportId, "pending_review");

    const [asSuper] = await listWeeklyReports(db, { projectId: project.id }, SUPER_ACTOR);
    const [asPm] = await listWeeklyReports(db, { projectId: project.id }, PM_ACTOR);
    const [asRep] = await listWeeklyReports(db, { projectId: project.id }, REP_ACTOR);

    expect(asSuper!.permissions.canEdit).toBe(true);
    // The PM slot comes off the same join, and it decides a different question — nobody but the assigned
    // PM may approve. A join that resolved one and not the other would still pass on the line above.
    expect(asPm!.permissions.canApprove).toBe(true);
    expect(asRep!.permissions.canEdit).toBe(false);
    expect(asRep!.permissions.canApprove).toBe(false);
  });

  it("closes edit on a sent report for everyone, leadership included", async () => {
    const project = await seedProject();
    const reportId = await seedDraft(project.id);
    await setStatus(reportId, "sent");

    const [row] = await listWeeklyReports(db, { projectId: project.id }, ADMIN_ACTOR);
    expect(row!.permissions.canEdit).toBe(false);
    // And delete stays open, behind the typed-week confirmation — the two are different questions.
    expect(row!.permissions.canDelete).toBe(true);
  });
});
