// Runtime suite for the FIELD send: the assigned PM sending their own client report from T-Rock Cam.
//
// This is the capability the whole weekly-report feature was missing. The CRM's send is gated
// admin/director, and `ASSIGNABLE_ROLES` — who may hold the PM slot at all — is
// field_contractor/construction/admin/director. Intersect those and `canPublishWeeklyReport`'s assigned-PM
// arm could only fire for somebody who was already leadership, so the ordinary `construction` PM had no
// send anywhere in the product.
//
// WHY THIS SUITE EXERCISES THE ROUTE HANDLERS AND NOT ONLY THE SERVICE. Both halves can be wrong
// independently and each hides the other:
//
//   • a service-only suite proves the policy and nothing about the wiring — reading `req.user.role` where
//     the field mount puts the effective role on `req.fieldUser`, or resolving the office from the wrong
//     field, produces a router that authorises the wrong person or writes the token against the wrong
//     tenant, with every service test still green;
//   • a router-only suite proves nothing about the policy, because a router gate is bypassable. The
//     refusals that matter are asserted by calling the service DIRECTLY, so they hold for any caller.
//
// So the handlers are invoked with a field request, against real rows, from the migrations read from disk.
//
// AND THE CONTROL IS MANDATORY. A guard that refuses everybody passes every refusal test in this file.
// "the assigned construction PM sends" is the case the feature exists for, and it is asserted first.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deals, files, offices, userOfficeAccess, users } from "@trock-crm/shared/schema";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import { migrationSql } from "../../helpers/migration-sql.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { AppError } from "../../../src/middleware/error-handler.js";
import { weeklyReportFieldRoutes } from "../../../src/modules/weekly-reports/field-routes.js";
import { createWeeklyReportProject } from "../../../src/modules/weekly-reports/projects-service.js";
import {
  createWeeklyReportDraft,
  transitionWeeklyReport,
  updateWeeklyReportContent,
} from "../../../src/modules/weekly-reports/reports-service.js";
import {
  WEEKLY_REPORT_SEND_JOB,
  buildWeeklyReportSendDraft,
  createWeeklyReportCorrection,
  retryWeeklyReportSend,
  sendWeeklyReport,
} from "../../../src/modules/weekly-reports/send-service.js";
import { hashWeeklyReportToken } from "../../../src/modules/weekly-reports/tokens-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const OFFICE = U("00001");
const DEAL = U("11111");
const PM = U("22221");
const SUPER = U("22222");
const DIRECTOR = U("22223");
/** A `construction` user on the payroll who is on NO part of this project. The role is not the grant. */
const OTHER_SUPER = U("22225");
const WON_STAGE = U("33331");

const PM_ACTOR = { id: PM, role: "construction" };
const SUPER_ACTOR = { id: SUPER, role: "construction" };
const DIRECTOR_ACTOR = { id: DIRECTOR, role: "director" };
const OTHER_SUPER_ACTOR = { id: OTHER_SUPER, role: "construction" };

const OFFICE_CONTEXT = { tenantId: OFFICE, slug: "dallas" };
const OFFICE_SLUG = "dallas";

const THURSDAY = 4;
const WEEK_OF = "2026-08-13";

/**
 * The host the test's links are minted against, set as an ENV VAR rather than left to the request.
 *
 * `assertClientLinksAreConfigured` refuses the send outright in production when PUBLIC_SHARE_BASE_URL is
 * unset, and `publicViewerBaseUrl` falls back to FRONTEND_URL and then to the request host — so leaving it
 * unset here would make the minted URL depend on whatever `req.get("host")` this file happens to fake.
 */
const SHARE_BASE = "https://reports.example.com";

/**
 * A `sent_at` far enough in the past that the provider's idempotency window is CLOSED, stated absolutely.
 *
 * Deliberately not `now() - (WINDOW_HOURS + 1)`. A fixture derived from the constant it exercises moves
 * with the constant and can never fail — the trap this feature has already hit once, in the stall
 * threshold. This date is fixed and in the past, so it is outside a 24-hour window today and outside it
 * for every day this suite will ever run; if the product decides the window should be measured
 * differently, this is supposed to break and be re-chosen rather than silently follow.
 */
const OUTSIDE_PROVIDER_WINDOW = "2026-08-01T10:00:00.000Z";

let pg: PGlite;

/** PGlite exposes `query`; rowCount comes from its `affectedRows`, never rows.length (0 for UPDATE). */
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

// ── Driving the real route handlers ──────────────────────────────────────────

/**
 * The handler Express would run for `method path`, pulled off the router's own stack.
 *
 * Matched on METHOD as well as path: `/reports/:id` carries a GET and a PATCH as two separate layers, so
 * path alone would silently return whichever was registered first.
 */
function fieldHandler(method: "get" | "post", path: string) {
  const layer = (weeklyReportFieldRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} is mounted on the field router`);
  // One handler and no middleware in front of it — asserted structurally, and for its own sake, in
  // tests/weekly-report-field-route-surface.test.ts.
  return layer.route.stack[0].handle as (req: any, res: any, next: any) => Promise<void>;
}

interface FieldCallResult {
  status: number;
  body: any;
  error: unknown;
  committed: boolean;
}

/**
 * Invoke a field route the way the mount does: a field session, a tenant client, an office context.
 *
 * `fieldUser` carries the EFFECTIVE role (what requireFieldContractor resolved, including an office-scoped
 * override) and `user.activeOfficeId` the office the search_path was pinned to. Both are supplied because
 * the handlers read one for the actor and the other for the token/job rows, and a handler that reached for
 * the wrong one would authorise or write against the wrong thing.
 */
async function callField(
  method: "get" | "post",
  path: string,
  input: { id: string; actor: { id: string; role: string }; body?: unknown },
): Promise<FieldCallResult> {
  const handle = fieldHandler(method, path);
  const result: FieldCallResult = { status: 200, body: undefined, error: undefined, committed: false };
  const res: any = {
    json(payload: unknown) {
      result.body = payload;
      return res;
    },
    status(code: number) {
      result.status = code;
      return res;
    },
  };
  const req: any = {
    params: { id: input.id },
    body: input.body ?? {},
    query: {},
    fieldUser: { id: input.actor.id, role: input.actor.role },
    user: { id: input.actor.id, role: input.actor.role, activeOfficeId: OFFICE },
    officeSlug: OFFICE_SLUG,
    tenantClient: db,
    commitTransaction: async () => {
      result.committed = true;
    },
    // Only consulted if PUBLIC_SHARE_BASE_URL and FRONTEND_URL are both unset, which this suite prevents.
    protocol: "https",
    get: (header: string) => (header.toLowerCase() === "host" ? "api.example.com" : undefined),
  };
  await handle(req, res, (error: unknown) => {
    result.error = error;
  });
  return result;
}

function expectRouteError(result: FieldCallResult, status: number, matcher?: RegExp) {
  expect(result.error).toBeInstanceOf(AppError);
  expect((result.error as AppError).statusCode).toBe(status);
  if (matcher) expect((result.error as AppError).message).toMatch(matcher);
  // Nothing may be answered AND refused. A handler that called next(error) after res.json would have
  // already told the app it worked.
  expect(result.body).toBeUndefined();
  expect(result.committed).toBe(false);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_dallas;`);
  await pg.exec(tenantSchemaSql("public", [offices, users, userOfficeAccess]));
  await pg.exec(tenantSchemaSql("office_dallas", [deals, files]));
  await pg.exec(`CREATE TABLE IF NOT EXISTS public.pipeline_stage_config (id uuid PRIMARY KEY, slug text);`);
  // The real job_queue shape from migration 0001, minus the enum (created here so the DDL runs
  // standalone). "the delivery was queued" is half of what the send promises, and asserting it against a
  // stub would prove only that a stub was called.
  await pg.exec(`
    DO $$ BEGIN
      CREATE TYPE job_status AS ENUM ('pending', 'processing', 'completed', 'failed', 'dead');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE IF NOT EXISTS public.job_queue (
      id                    BIGSERIAL PRIMARY KEY,
      job_type              VARCHAR(100) NOT NULL,
      payload               JSONB NOT NULL,
      office_id             UUID,
      status                job_status NOT NULL DEFAULT 'pending',
      attempts              INTEGER NOT NULL DEFAULT 0,
      max_attempts          INTEGER NOT NULL DEFAULT 3,
      last_error            TEXT,
      started_processing_at TIMESTAMPTZ,
      run_after             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at          TIMESTAMPTZ
    );
  `);
  await pg.exec(migrationSql("0222_weekly_reports"));
  await pg.exec(migrationSql("0223_weekly_report_pauses"));
  await pg.exec(migrationSql("0226_weekly_report_send"));
  // 0227 too, even though this suite tests SENDING rather than the stall sweep. `retryWeeklyReportSend`
  // clears `send_stall_alerted_at` in the same statement that moves the stall clock — re-arming the alert
  // is the whole point of a human retry — so without this column every retry here dies on an undefined
  // column rather than on its subject. Neither branch could have written this line: the sweep never saw
  // this file, and this file predates the sweep.
  await pg.exec(migrationSql("0227_weekly_report_send_stall_alerted"));

  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES ('${OFFICE}', 'Dallas', 'dallas');
    INSERT INTO public.users (id, display_name, email, role, office_id, phone) VALUES
      ('${PM}', 'Adam Sherwood', 'adam@trockconstruction.com', 'construction', '${OFFICE}', '(214) 555-0142'),
      ('${SUPER}', 'Steve Sanchez', 'super@example.com', 'construction', '${OFFICE}', NULL),
      ('${DIRECTOR}', 'Takashi', 'director@example.com', 'director', '${OFFICE}', NULL),
      ('${OTHER_SUPER}', 'Someone Else', 'other@example.com', 'construction', '${OFFICE}', NULL);
    INSERT INTO public.pipeline_stage_config (id, slug) VALUES ('${WON_STAGE}', '${WON_DEAL_STAGE_SLUGS[0]}');
    INSERT INTO office_dallas.deals (id, name, deal_number, stage_id, project_number) VALUES
      ('${DEAL}', '4123 Cedar Springs', 'DFW-10432', '${WON_STAGE}', 'DFW-10432');
    SET search_path TO office_dallas, public;
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  vi.stubEnv("PUBLIC_SHARE_BASE_URL", SHARE_BASE);
  await pg.exec(`
    DELETE FROM public.weekly_report_tokens;
    DELETE FROM public.job_queue;
    DELETE FROM office_dallas.weekly_report_photos;
    DELETE FROM office_dallas.weekly_reports;
    DELETE FROM office_dallas.weekly_report_projects;
    DELETE FROM office_dallas.files;
  `);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function seedProject(overrides: Record<string, unknown> = {}) {
  return createWeeklyReportProject(
    db,
    {
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
      projectedDurationWeeks: 19,
      cadenceWeekday: THURSDAY,
      cadenceStartDate: "2026-07-27",
      ...overrides,
    } as any,
    // Created by a DIRECTOR, as it is in the product: the setup is CRM work. The PM's grant comes from
    // being named in the PM slot, not from having created anything.
    DIRECTOR,
    OFFICE,
  );
}

let submissionSeq = 0;
/** A report the superintendent wrote and the PM approved — the state a send starts from. */
async function seedApprovedReport(options: { projectId?: string; weekOf?: string } = {}) {
  submissionSeq += 1;
  const projectId = options.projectId ?? (await seedProject()).id;
  const { report } = await createWeeklyReportDraft(
    db,
    {
      clientSubmissionId: U(`5${String(submissionSeq).padStart(4, "0")}`),
      weeklyReportProjectId: projectId,
      weekOf: options.weekOf ?? WEEK_OF,
    },
    SUPER_ACTOR,
  );
  await updateWeeklyReportContent(
    db,
    report.id,
    { workCompleted: "Framing complete on levels 3 and 4.", completionPercent: 42 },
    SUPER_ACTOR,
  );
  await transitionWeeklyReport(db, report.id, "pending_review", SUPER_ACTOR);
  await transitionWeeklyReport(db, report.id, "approved", PM_ACTOR);
  return { projectId, reportId: report.id };
}

async function reportRow(id: string): Promise<Record<string, any>> {
  const result = await pg.query(`SELECT * FROM office_dallas.weekly_reports WHERE id = $1::uuid`, [id]);
  return result.rows[0] as Record<string, any>;
}

async function tokenRows(): Promise<Array<Record<string, any>>> {
  const result = await pg.query(`SELECT * FROM public.weekly_report_tokens ORDER BY created_at`);
  return result.rows as Array<Record<string, any>>;
}

async function sendJobs(): Promise<Array<Record<string, any>>> {
  const result = await pg.query(`SELECT * FROM public.job_queue WHERE job_type = $1 ORDER BY id`, [
    WEEKLY_REPORT_SEND_JOB,
  ]);
  return result.rows as Array<Record<string, any>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CONTROL
// ─────────────────────────────────────────────────────────────────────────────

describe("the assigned construction PM CAN send from the app", () => {
  it("moves the report to sent, mints a link, freezes the header and queues the delivery", async () => {
    const { reportId } = await seedApprovedReport();

    const result = await callField("post", "/reports/:id/send", {
      id: reportId,
      actor: PM_ACTOR,
      body: { recipients: ["jay@example.com"], contextParagraph: "Week 3 update attached." },
    });

    expect(result.error).toBeUndefined();
    // 202, not 200: the transition and the link are done, the EMAIL is queued work.
    expect(result.status).toBe(202);
    expect(result.committed).toBe(true);
    expect(result.body.report.status).toBe("sent");
    expect(result.body.shareUrl).toMatch(new RegExp(`^${SHARE_BASE}/wr/[A-Za-z0-9_-]{43}$`));

    const row = await reportRow(reportId);
    expect(row.status).toBe("sent");
    expect(row.sent_by).toBe(PM);
    expect(row.sent_at).not.toBeNull();
    // The header snapshot and the composed request are what make `sent` mean something. A report that
    // reached `sent` without them is the exact state the transition endpoint's 400 exists to prevent.
    expect(row.snapshot).not.toBeNull();
    expect(row.send_request).not.toBeNull();
    expect(row.send_delivery_key).not.toBeNull();

    const jobs = await sendJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.office_id).toBe(OFFICE);
    expect(jobs[0]!.payload.tenantSchema).toBe(`office_${OFFICE_SLUG}`);
    expect(jobs[0]!.payload.deliveryKey).toBe(row.send_delivery_key);

    expect(await tokenRows()).toHaveLength(1);
  });

  it("reads the send draft, so the app renders the same email the CRM would", async () => {
    const { reportId } = await seedApprovedReport();

    const result = await callField("get", "/reports/:id/send-draft", { id: reportId, actor: PM_ACTOR });

    expect(result.error).toBeUndefined();
    expect(result.committed).toBe(true);
    expect(result.body.draft.reportId).toBe(reportId);
    // Composed by the server from the setup's client team — not by the phone.
    expect(result.body.draft.recipients).toEqual(["jay@example.com", "melissa@example.com"]);
    expect(result.body.draft.subject).toContain("4123 Cedar Springs");
    // The PM block that signs the email is the ASSIGNED PM's contact card, resolved from public.users.
    expect(result.body.draft.sender.name).toBe("Adam Sherwood");
  });

  it("retries a delivery that has not reached the client", async () => {
    const { reportId } = await seedApprovedReport();
    await callField("post", "/reports/:id/send", {
      id: reportId,
      actor: PM_ACTOR,
      body: { recipients: ["jay@example.com"] },
    });
    const keyBefore = (await reportRow(reportId)).send_delivery_key;
    // Stand in for the worker's own failure bookkeeping.
    await pg.query(
      `UPDATE office_dallas.weekly_reports SET send_attempts = 2, send_error = 'Resend timed out'
        WHERE id = $1::uuid`,
      [reportId],
    );
    await pg.query(`DELETE FROM public.job_queue`);

    const result = await callField("post", "/reports/:id/send/retry", { id: reportId, actor: PM_ACTOR });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(202);
    const jobs = await sendJobs();
    expect(jobs).toHaveLength(1);
    // The SAME key. Rotating it would make the replay a genuinely new message to the provider, and a
    // "failed" job is not proof nothing was sent.
    expect(jobs[0]!.payload.deliveryKey).toBe(keyBefore);
    expect((await reportRow(reportId)).send_error).toBeNull();
  });

  it("issues a correction, which is the only way back from a sent report", async () => {
    const { reportId } = await seedApprovedReport();
    await callField("post", "/reports/:id/send", {
      id: reportId,
      actor: PM_ACTOR,
      body: { recipients: ["jay@example.com"] },
    });

    const result = await callField("post", "/reports/:id/correction", { id: reportId, actor: PM_ACTOR });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(201);
    expect(result.body.report.id).not.toBe(reportId);
    expect(result.body.report.version).toBe(2);
    // Lands `approved`, editable by PM powers, and NOT sent. The original is untouched until the
    // correction actually goes out, so a half-written fix never tells a client their copy was replaced.
    expect(result.body.report.status).toBe("approved");
    expect((await reportRow(reportId)).superseded_by_id).toBeNull();
  });

  it("still refuses a PM whose report the SUPER has not finished — the ladder is not bypassed", async () => {
    // The send is an authorisation change, not a licence to skip review. A draft cannot be sent by
    // anybody, the PM included.
    const projectId = (await seedProject()).id;
    submissionSeq += 1;
    const { report } = await createWeeklyReportDraft(
      db,
      {
        clientSubmissionId: U(`5${String(submissionSeq).padStart(4, "0")}`),
        weeklyReportProjectId: projectId,
        weekOf: WEEK_OF,
      },
      SUPER_ACTOR,
    );
    await updateWeeklyReportContent(db, report.id, { workCompleted: "Some work." }, SUPER_ACTOR);

    const result = await callField("post", "/reports/:id/send", {
      id: report.id,
      actor: PM_ACTOR,
      body: { recipients: ["jay@example.com"] },
    });

    expectRouteError(result, 409, /approved by the PM/i);
    expect(await tokenRows()).toHaveLength(0);
    expect(await sendJobs()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE REFUSALS — asserted against the SERVICE, because a router gate is bypassable
// ─────────────────────────────────────────────────────────────────────────────

describe("a construction user who is not this project's PM cannot send", () => {
  it("is refused by sendWeeklyReport ITSELF, not by any router", async () => {
    // Called directly, with no route in the picture at all. This is the assertion that survives somebody
    // adding a second caller: `/api/field` admits every field user in the company, so "the router did not
    // let them in" is a statement about one file, while this is a statement about the capability.
    const { reportId } = await seedApprovedReport();

    await expectAppError(
      sendWeeklyReport(db, {
        reportId,
        office: OFFICE_CONTEXT,
        actor: OTHER_SUPER_ACTOR,
        payload: { recipients: ["attacker@example.com"] },
        shareUrlFor: () => `${SHARE_BASE}/wr/should-never-be-minted`,
      }),
      403,
      /assigned project manager or office leadership/i,
    );

    // Refused BEFORE anything is minted or queued — the gate runs ahead of the token, not after it.
    expect(await tokenRows()).toHaveLength(0);
    expect(await sendJobs()).toHaveLength(0);
    expect((await reportRow(reportId)).status).toBe("approved");
  });

  it("is refused on all four field endpoints", async () => {
    // Retry and correction only exist for a SENT report, so this week is sent by the PM first; the second
    // week stays `approved` so the send itself can be refused on a report that is genuinely sendable.
    // (One setup per deal — hence the shared projectId rather than a second seedProject.)
    const { reportId, projectId } = await seedApprovedReport();
    await callField("post", "/reports/:id/send", {
      id: reportId,
      actor: PM_ACTOR,
      body: { recipients: ["jay@example.com"] },
    });

    // send-draft carries the client's addresses and the PM's phone number, so it takes the publication
    // gate rather than the weaker read gate the authoring endpoints use.
    expectRouteError(await callField("get", "/reports/:id/send-draft", { id: reportId, actor: OTHER_SUPER_ACTOR }), 403);
    expectRouteError(await callField("post", "/reports/:id/send/retry", { id: reportId, actor: OTHER_SUPER_ACTOR }), 403);
    expectRouteError(await callField("post", "/reports/:id/correction", { id: reportId, actor: OTHER_SUPER_ACTOR }), 403);

    const { reportId: second } = await seedApprovedReport({ projectId, weekOf: "2026-08-20" });
    expectRouteError(
      await callField("post", "/reports/:id/send", {
        id: second,
        actor: OTHER_SUPER_ACTOR,
        body: { recipients: ["attacker@example.com"] },
      }),
      403,
    );
    // The refused week is still sendable BY THE PM — so the 403 above is about who asked, not about a
    // report that could not have gone out anyway.
    expect((await reportRow(second)).status).toBe("approved");
  });

  it("is not saved by holding the same ROLE as the PM", async () => {
    // OTHER_SUPER and the PM are both `construction`. If the gate had been written as a role check — the
    // shape a router gate pushes people towards — this would pass and the previous cases would too.
    const { projectId } = await seedApprovedReport();
    const project = await pg.query(
      `SELECT trock_pm_user_id FROM office_dallas.weekly_report_projects WHERE id = $1::uuid`,
      [projectId],
    );
    expect(project.rows[0]!.trock_pm_user_id).toBe(PM);
    expect(OTHER_SUPER_ACTOR.role).toBe(PM_ACTOR.role);
  });
});

describe("the assigned superintendent cannot publish their own work", () => {
  it("is refused `sent` by canTransitionAs, proven by calling transitionWeeklyReport directly", async () => {
    // THE FAILURE MODE THIS EXISTS FOR: a superintendent posting `{"to":"sent"}` from a patched build.
    // The route answers 400 and tells them to use the send endpoint, but that is a router answer and a
    // router is one edit away from not being there. The refusal that matters is the service's.
    const { reportId } = await seedApprovedReport();

    await expectAppError(
      transitionWeeklyReport(db, reportId, "sent", SUPER_ACTOR),
      403,
      /do not have permission/i,
    );
    expect((await reportRow(reportId)).status).toBe("approved");
  });

  it("but the PM's identical call SUCCEEDS — so the refusal is about the person, not the transition", async () => {
    // The control for the case above. Without it, a `canTransitionAs` that returned false for everybody —
    // or a `canTransitionWeeklyReport` that had lost `approved -> sent` entirely — would pass it.
    const { reportId } = await seedApprovedReport();

    const moved = await transitionWeeklyReport(db, reportId, "sent", PM_ACTOR);

    expect(moved.status).toBe("sent");
  });

  it("cannot send, retry or correct either, however the report got to `sent`", async () => {
    const { reportId } = await seedApprovedReport();
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: PM_ACTOR,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor: (raw) => `${SHARE_BASE}/wr/${raw}`,
    });

    await expectAppError(buildWeeklyReportSendDraft(db, reportId, SUPER_ACTOR), 403);
    await expectAppError(retryWeeklyReportSend(db, reportId, SUPER_ACTOR, OFFICE_CONTEXT), 403);
    await expectAppError(createWeeklyReportCorrection(db, reportId, SUPER_ACTOR), 403);
  });
});

describe("leadership keeps its send on this mount too", () => {
  it("lets a director in the office send a report they are not the PM on", async () => {
    // The field mount does not narrow `canPublishWeeklyReport`; it stops SUBSTITUTING a role gate for it.
    // A director who works from the app is the same person the CRM would let send.
    const { reportId } = await seedApprovedReport();

    const result = await callField("post", "/reports/:id/send", {
      id: reportId,
      actor: DIRECTOR_ACTOR,
      body: { recipients: ["jay@example.com"] },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(202);
    expect((await reportRow(reportId)).sent_by).toBe(DIRECTOR);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RAW TOKEN
// ─────────────────────────────────────────────────────────────────────────────

describe("the raw share token exists exactly once", () => {
  it("is returned to the caller and stored only as a SHA-256 hash", async () => {
    const { reportId } = await seedApprovedReport();

    const result = await callField("post", "/reports/:id/send", {
      id: reportId,
      actor: PM_ACTOR,
      body: { recipients: ["jay@example.com"] },
    });

    const shareUrl: string = result.body.shareUrl;
    const rawToken = shareUrl.slice(shareUrl.lastIndexOf("/") + 1);
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const tokens = await tokenRows();
    expect(tokens).toHaveLength(1);
    // The stored value is the HASH. Asserted as an equality against the hash rather than only as
    // `not.toBe(rawToken)`: the weaker form passes for a column holding any garbage at all, including a
    // truncated token that still resolves.
    expect(tokens[0]!.token).toBe(hashWeeklyReportToken(rawToken));
    expect(tokens[0]!.token).not.toBe(rawToken);
    expect(tokens[0]!.tenant_id).toBe(OFFICE);
    expect(tokens[0]!.office_slug).toBe(OFFICE_SLUG);
  });

  it("is never handed back by a later read of the send draft", async () => {
    // The one API path that could re-expose it. An earlier revision read the link back off
    // `send_request.shareUrl` so the modal could re-show it, which made every sent report's live 180-day
    // client link readable by anyone who could open the modal.
    const { reportId } = await seedApprovedReport();
    const sent = await callField("post", "/reports/:id/send", {
      id: reportId,
      actor: PM_ACTOR,
      body: { recipients: ["jay@example.com"] },
    });
    const shareUrl: string = sent.body.shareUrl;
    const rawToken = shareUrl.slice(shareUrl.lastIndexOf("/") + 1);

    const draft = await callField("get", "/reports/:id/send-draft", { id: reportId, actor: PM_ACTOR });

    // Searched over the WHOLE serialised response rather than a named field, so a token that reappears in
    // some future addition to the payload is caught rather than missed for not being where it was looked
    // for. The control is the assertion above it: the send response DOES contain the token, so this is a
    // property of this payload and not of a search that can never match.
    expect(JSON.stringify(sent.body)).toContain(rawToken);
    expect(JSON.stringify(draft.body)).not.toContain(rawToken);

    // NOTE, precisely: `send_request.shareUrl` in the database DOES hold the raw URL until the worker
    // drops it on delivery (`send_request - 'shareUrl'`, weekly-report-send.ts). That is deliberate — the
    // worker has to be able to compose the email after a restart — and it is why the guarantee is worded
    // as "the API never hands it back", not "it exists nowhere".
    expect((await reportRow(reportId)).send_request.shareUrl).toBe(shareUrl);
  });

  it("is a NEW link on every send, so revoking one cannot kill another", async () => {
    const first = await seedApprovedReport();
    const firstResult = await callField("post", "/reports/:id/send", {
      id: first.reportId,
      actor: PM_ACTOR,
      body: { recipients: ["jay@example.com"] },
    });
    const correction = await callField("post", "/reports/:id/correction", {
      id: first.reportId,
      actor: PM_ACTOR,
    });
    const secondResult = await callField("post", "/reports/:id/send", {
      id: correction.body.report.id,
      actor: PM_ACTOR,
      body: { recipients: ["jay@example.com"] },
    });

    expect(secondResult.body.shareUrl).not.toBe(firstResult.body.shareUrl);
    expect(await tokenRows()).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE GUARDS THE APP INHERITS RATHER THAN RE-IMPLEMENTS
// ─────────────────────────────────────────────────────────────────────────────

describe("the app gets the CRM's safety rules for free, because it reuses the service", () => {
  it("refuses a retry outside the provider's dedupe window unless the risk is acknowledged", async () => {
    const { reportId } = await seedApprovedReport();
    await callField("post", "/reports/:id/send", {
      id: reportId,
      actor: PM_ACTOR,
      body: { recipients: ["jay@example.com"] },
    });
    await pg.query(`UPDATE office_dallas.weekly_reports SET sent_at = $2::timestamptz WHERE id = $1::uuid`, [
      reportId,
      OUTSIDE_PROVIDER_WINDOW,
    ]);
    await pg.query(`DELETE FROM public.job_queue`);

    const refused = await callField("post", "/reports/:id/send/retry", { id: reportId, actor: PM_ACTOR });
    expectRouteError(refused, 409, /second copy/i);
    expect(await sendJobs()).toHaveLength(0);

    // And goes through once the caller says so — the flag is the whole difference, so both halves are
    // asserted. Without the second, a retry broken for every input would pass the first.
    const acknowledged = await callField("post", "/reports/:id/send/retry", {
      id: reportId,
      actor: PM_ACTOR,
      body: { acknowledgeDuplicateRisk: true },
    });
    expect(acknowledged.error).toBeUndefined();
    expect(await sendJobs()).toHaveLength(1);
  });

  it("refuses to re-send an already-sent report, and points at the correction instead", async () => {
    const { reportId } = await seedApprovedReport();
    await callField("post", "/reports/:id/send", {
      id: reportId,
      actor: PM_ACTOR,
      body: { recipients: ["jay@example.com"] },
    });

    const result = await callField("post", "/reports/:id/send", {
      id: reportId,
      actor: PM_ACTOR,
      body: { recipients: ["jay@example.com"] },
    });

    expectRouteError(result, 409, /already been sent/i);
    expect(await tokenRows()).toHaveLength(1);
  });

  it("validates the recipients the phone posts, rather than trusting them", async () => {
    const { reportId } = await seedApprovedReport();

    const result = await callField("post", "/reports/:id/send", {
      id: reportId,
      actor: PM_ACTOR,
      body: { recipients: ["jay@example.com", "not-an-address"] },
    });

    // Rejected, not silently dropped: an email that quietly went to one person when the PM addressed it to
    // two is the failure this refusal exists for.
    expectRouteError(result, 400, /not a valid email address/i);
    expect((await reportRow(reportId)).status).toBe("approved");
  });

  it("refuses the send in production when no client-link host is configured", async () => {
    // The check runs BEFORE anything is minted. `publicViewerBaseUrl` falls back to FRONTEND_URL and then
    // to the request host, so an unset var mints links against a host that does not serve /wr — and the
    // client's one way into their report 404s, discoverable by nobody but them. A PM on a phone has no
    // way at all to notice.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_SHARE_BASE_URL", "");
    vi.stubEnv("FRONTEND_URL", "");
    const { reportId } = await seedApprovedReport();

    const result = await callField("post", "/reports/:id/send", {
      id: reportId,
      actor: PM_ACTOR,
      body: { recipients: ["jay@example.com"] },
    });

    expectRouteError(result, 500, /Nothing has been sent/i);
    expect(await tokenRows()).toHaveLength(0);
    expect((await reportRow(reportId)).status).toBe("approved");
  });
});
