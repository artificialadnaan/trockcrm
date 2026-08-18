// Runtime suite for the SEND flow: the composed draft, the `approved -> sent` transition, corrections,
// retries, and how a failed delivery reaches the dashboard.
//
// Every table is built from the migrations READ FROM DISK, 0226 included — the columns this whole feature
// records its outcome in are added by that file, and a suite that hand-rolled them would pass against a
// schema production does not have.
//
// job_queue is created from the real 0001 DDL shape rather than mocked, because "the delivery was queued"
// is half of what `sendWeeklyReport` promises and an assertion against a stub proves only that a stub was
// called.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deals, files, offices, userOfficeAccess, users } from "@trock-crm/shared/schema";
import {
  WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS,
  WEEKLY_REPORT_SEND_REQUEST_KEYS,
  weeklyReportRetryIsProviderDeduped,
} from "@trock-crm/shared/lib/weeklyReportEmail";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import { migrationSql } from "../../helpers/migration-sql.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { AppError } from "../../../src/middleware/error-handler.js";
import {
  createWeeklyReportProject,
  updateWeeklyReportProject,
} from "../../../src/modules/weekly-reports/projects-service.js";
import {
  createWeeklyReportDraft,
  getWeeklyReportDetail,
  replaceWeeklyReportPhotos,
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
import {
  getWeeklyReportDashboard,
  listWeeklyReportProjectSummaries,
} from "../../../src/modules/weekly-reports/dashboard-service.js";
import { canPublishWeeklyReport } from "../../../src/modules/weekly-reports/reports-service.js";
import {
  hashWeeklyReportToken,
  resolveWeeklyReportToken,
} from "../../../src/modules/weekly-reports/tokens-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const OFFICE = U("00001");
const DEAL = U("11111");
const PM = U("22221");
const SUPER = U("22222");
const DIRECTOR = U("22223");
const STRANGER = U("22224");
const WON_STAGE = U("33331");

const PM_ACTOR = { id: PM, role: "construction" };
const SUPER_ACTOR = { id: SUPER, role: "construction" };
const DIRECTOR_ACTOR = { id: DIRECTOR, role: "director" };
const STRANGER_ACTOR = { id: STRANGER, role: "rep" };

/**
 * WHO ACTUALLY SENDS, IN THE SHIPPED PRODUCT.
 *
 * These tests call the service directly, so any actor `canPublishWeeklyReport` accepts will "work" — and
 * an earlier revision of this suite used the assigned PM throughout, asserting a capability the API does
 * not grant anybody. The CRM router is admin/director/rep (routes.ts), `ASSIGNABLE_ROLES` — who may hold
 * the PM slot — is field_contractor/construction/admin/director, and the send routes narrow further to
 * admin/director. Intersect those and the CRM's sender is LEADERSHIP, full stop: a `construction` PM,
 * which is the normal case, is refused at the router.
 *
 * The assigned PM's send lives on the deferred T-Rock Cam field mount. The one test that still says so is
 * "the assigned PM has no send route yet" below; everything else uses the actor the product ships.
 */
const SENDER = DIRECTOR_ACTOR;

const OFFICE_CONTEXT = { tenantId: OFFICE, slug: "dallas" };

const THURSDAY = 4;
const WEEK_OF = "2026-08-13";
const PRIOR_WEEK = "2026-08-06";

/**
 * ABSOLUTE AGES, DELIBERATELY NOT DERIVED FROM `WEEKLY_REPORT_SEND_STALL_MINUTES`.
 *
 * The threshold is 30 minutes. This suite used to write `ageSend(id, WEEKLY_REPORT_SEND_STALL_MINUTES + 5)`
 * — importing the constant and ageing relative to it — which cannot detect a change to the constant at
 * all: raising it to 30000 moves the fixture with it and the whole suite stays green while the signal it
 * exists for is switched off. That is not hypothetical. With the mutant in place a send committed three
 * weeks ago with no error and no delivery reports `sendStalled: false, sendPending: true`: the board
 * renders "Sending…" forever, the row is excluded from the "Send failures" card and NO Retry is offered.
 *
 * Two absolute fixtures instead, one on each side of the threshold, so a move in either direction fails a
 * test. They are numbers rather than an import ON PURPOSE — if the product decides 30 minutes is wrong,
 * these are supposed to break and be re-chosen, not silently follow.
 *
 * (The sibling `WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS` is pinned the same way, by the CRM
 * suite's hard-coded `sentAt: "2026-08-01T10:00:00.000Z"`.)
 */
const STALLED_MINUTES = 35;
const IN_FLIGHT_MINUTES = 5;

let pg: PGlite;

/** PGlite exposes `query`; rowCount comes from its `affectedRows`, never from rows.length (0 for UPDATE). */
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
 * A `db` that commits a competing status change mid-call.
 *
 * The window this feature has to survive opens BETWEEN the status the permission check read and the write
 * that follows it. Mutating the row before the call lands on the up-front guard and proves nothing, so
 * this fires immediately before the first statement matching `trigger`.
 */
function racingDb(run: () => Promise<unknown>, trigger: string) {
  let fired = false;
  return {
    query: async (text: string, params?: unknown[]) => {
      if (!fired && text.includes(trigger)) {
        fired = true;
        await run();
      }
      return db.query(text, params);
    },
  } as typeof db;
}

/**
 * Run inside a REAL transaction.
 *
 * The `db` wrapper above hands every statement to PGlite in autocommit, so by default this suite has no
 * transaction at all — which is exactly what made the send service's all-or-nothing claim untestable
 * here. `sendWeeklyReport` mints the client token BEFORE the transition that can refuse the send, and
 * without a transaction that token is committed the moment it is written and survives the refusal: a live
 * public credential pointing at a report still sitting in `approved`. Production rolls it back through
 * tenant.ts, but nothing in this package asserted it, and send-service.ts is built to be reused by the
 * deferred field route.
 */
async function inTransaction<T>(run: () => Promise<T>): Promise<T> {
  await pg.exec("BEGIN");
  try {
    const result = await run();
    await pg.exec("COMMIT");
    return result;
  } catch (error) {
    await pg.exec("ROLLBACK");
    throw error;
  }
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

let mintedTokens: string[] = [];
function shareUrlFor(rawToken: string): string {
  mintedTokens.push(rawToken);
  return `https://reports.example.com/wr/${rawToken}`;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_dallas;`);
  await pg.exec(tenantSchemaSql("public", [offices, users, userOfficeAccess]));
  await pg.exec(tenantSchemaSql("office_dallas", [deals, files]));
  await pg.exec(`CREATE TABLE IF NOT EXISTS public.pipeline_stage_config (id uuid PRIMARY KEY, slug text);`);
  // The real job_queue shape from migration 0001, minus the job_status enum (created here so the DDL
  // runs standalone). `sendWeeklyReport` inserts into this table inside the caller's transaction, and
  // asserting that insert against the actual columns is the point.
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
  // And 0227, which adds the DELIVERY VERDICT columns. Same reason again: `getWeeklyReportDashboard`
  // selects `send_delivery_status`, and `priorVersionReachedClient` binds it — a suite that stops at 0226
  // fails on a missing column rather than on its subject.
  await pg.exec(migrationSql("0227_weekly_report_delivery_events"));

  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES ('${OFFICE}', 'Dallas', 'dallas');
    INSERT INTO public.users (id, display_name, email, role, office_id, phone) VALUES
      ('${PM}', 'Adam Sherwood', 'adam@trockconstruction.com', 'construction', '${OFFICE}', '(214) 555-0142'),
      ('${SUPER}', 'Steve Sanchez', 'super@example.com', 'construction', '${OFFICE}', NULL),
      ('${DIRECTOR}', 'Takashi', 'director@example.com', 'director', '${OFFICE}', NULL),
      ('${STRANGER}', 'Nobody', 'nobody@example.com', 'rep', '${OFFICE}', NULL);
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
  mintedTokens = [];
  await pg.exec(`
    DELETE FROM public.weekly_report_tokens;
    DELETE FROM public.job_queue;
    DELETE FROM office_dallas.weekly_report_photos;
    DELETE FROM office_dallas.weekly_reports;
    DELETE FROM office_dallas.weekly_report_projects;
    DELETE FROM office_dallas.files;
  `);
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
        // An RM with a NAME but no address: the modal must not offer an empty recipient row.
        rm: { name: "Dana Reyes", email: null },
      },
      trockPmUserId: PM,
      trockSuperUserId: SUPER,
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

let submissionSeq = 0;
async function seedApprovedReport(options: { weekOf?: string; projectId?: string } = {}) {
  submissionSeq += 1;
  const project = options.projectId ? { id: options.projectId } : await seedProject();
  const { report } = await createWeeklyReportDraft(
    db,
    {
      clientSubmissionId: U(`5${String(submissionSeq).padStart(4, "0")}`),
      weeklyReportProjectId: project.id,
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
  return { projectId: project.id, reportId: report.id };
}

let photoSeq = 0;
async function seedPhoto(description: string | null) {
  photoSeq += 1;
  const id = U(`9${String(photoSeq).padStart(4, "0")}`);
  const filename = `photo-${photoSeq}.jpg`;
  await pg.query(
    `INSERT INTO office_dallas.files (
       id, category, display_name, system_filename, original_filename, mime_type,
       file_size_bytes, file_extension, r2_key, r2_bucket, uploaded_by, deal_id, description, taken_at
     ) VALUES ($1::uuid, 'photo', $2, $2, $2, 'image/jpeg', 1024, 'jpg', $3, 'test-bucket', $4::uuid,
               $5::uuid, $6, $7::timestamptz)`,
    [id, filename, `k/${filename}`, SUPER, DEAL, description, `${WEEK_OF}T15:00:00Z`],
  );
  return id;
}

async function reportRow(id: string): Promise<Record<string, any>> {
  const result = await pg.query(`SELECT * FROM office_dallas.weekly_reports WHERE id = $1::uuid`, [id]);
  return result.rows[0] as Record<string, any>;
}

/** Stand in for the worker stamping a successful delivery. */
async function markDelivered(reportId: string): Promise<void> {
  await pg.query(
    `UPDATE office_dallas.weekly_reports
        SET send_delivered_at = now(), send_error = NULL, send_attempts = send_attempts + 1
      WHERE id = $1::uuid`,
    [reportId],
  );
}

/** Age the COMMIT, which is what the provider's 24-hour idempotency window is measured against. */
async function ageSend(reportId: string, minutes: number): Promise<void> {
  await pg.query(
    `UPDATE office_dallas.weekly_reports
        SET sent_at = now() - make_interval(mins => $2)
      WHERE id = $1::uuid`,
    [reportId, minutes],
  );
}

/**
 * Age the whole DELIVERY — both clocks the board's stall threshold reads.
 *
 * Separate from `ageSend` because the two answer different questions. The stall is measured against the
 * LATER of `sent_at` and `send_last_attempt_at`, so a row whose worker attempt is stamped `now()` is not
 * stale however far back its commit is pushed. Anything asserting a stall on a row that has been attempted
 * has to move both, or it is asserting against a clock that never advanced.
 */
async function ageDelivery(reportId: string, minutes: number): Promise<void> {
  await pg.query(
    `UPDATE office_dallas.weekly_reports
        SET sent_at = now() - make_interval(mins => $2),
            send_last_attempt_at = CASE
              WHEN send_last_attempt_at IS NULL THEN NULL
              ELSE now() - make_interval(mins => $2)
            END
      WHERE id = $1::uuid`,
    [reportId, minutes],
  );
}

async function sendJobs(): Promise<Array<Record<string, any>>> {
  const result = await pg.query(
    `SELECT * FROM public.job_queue WHERE job_type = $1 ORDER BY id`,
    [WEEKLY_REPORT_SEND_JOB],
  );
  return result.rows as Array<Record<string, any>>;
}

describe("migration 0226", () => {
  it("is replayable — running it a second time is a no-op, not an error", async () => {
    await expect(pg.exec(migrationSql("0226_weekly_report_send"))).resolves.toBeDefined();
  });

  it("gives a NEW tenant the same columns the DO-loop gives an existing one", async () => {
    // The DO loop and the TENANT_SCHEMA block are two hand-maintained copies of the same DDL. A column
    // added to one and not the other leaves every newly provisioned office unable to send at all.
    const result = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'office_dallas' AND table_name = 'weekly_reports'`,
    );
    const columns = result.rows.map((row) => row.column_name);
    expect(columns).toContain("send_request");
    expect(columns).toContain("send_delivery_key");
    expect(columns).toContain("send_delivered_at");
    expect(columns).toContain("send_last_attempt_at");
  });

  it("creates the partial index the undelivered-send lookup depends on", async () => {
    const result = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'office_dallas' AND tablename = 'weekly_reports'`,
    );
    expect(result.rows.map((row) => row.indexname)).toContain("weekly_reports_send_undelivered_idx");
  });
});

describe("the send draft", () => {
  it("composes the whole email server-side, so both surfaces render the same thing", async () => {
    const { reportId } = await seedApprovedReport();
    const draft = await buildWeeklyReportSendDraft(db, reportId, SENDER);

    expect(draft.subject).toBe("4123 Cedar Springs — Weekly Progress Report, Week of 8/13/26");
    expect(draft.greeting).toBe("Hello Jay,");
    // Prefilled from the client-team roles that CARRY an address. The RM has a name and no email and
    // must not appear as a blank recipient.
    expect(draft.recipients).toEqual(["jay@example.com", "melissa@example.com"]);
    expect(draft.recipientOptions.map((option) => option.role)).toEqual(["DOC", "PM"]);
    expect(draft.sender).toEqual({
      name: "Adam Sherwood",
      email: "adam@trockconstruction.com",
      phone: "(214) 555-0142",
    });
    expect(draft.attachPdf).toBe(true);
    expect(draft.isCorrection).toBe(false);
    expect(draft.bodyPreview).toContain("Hello Jay,");
    expect(draft.bodyPreview).toContain("(214) 555-0142");
    // The draft carries NO share URL, for any report. Asserted as key ABSENCE, not as a null value: a
    // `shareUrl: null` field would still pass a `toBeNull()` on the day somebody starts populating it.
    expect(Object.keys(draft)).not.toContain("shareUrl");
  });

  it("never hands back the raw client link, even for a report already sent", async () => {
    // The security property this pays for: public.weekly_report_tokens stores only a SHA-256 hash so that
    // reading the database cannot reconstruct a live 180-day link to a client's report. An earlier
    // revision read the raw URL back out of `send_request.shareUrl` and returned it here for every sent
    // report — which handed that property back through the API, to anyone who can open the modal, and
    // made the dialog's "This link is shown once" simply false.
    const { reportId } = await seedApprovedReport();
    const sent = await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    const draft = await buildWeeklyReportSendDraft(db, reportId, SENDER);
    expect(JSON.stringify(draft)).not.toContain(mintedTokens[0]!);
    expect(JSON.stringify(draft)).not.toContain(sent.shareUrl);
  });

  it("is refused to a rep who is not the assigned PM — it exposes the client's contacts", async () => {
    const { reportId } = await seedApprovedReport();
    await expectAppError(buildWeeklyReportSendDraft(db, reportId, STRANGER_ACTOR), 403, /project manager/i);
  });

  it("is refused to the superintendent, who cannot send their own work to a client", async () => {
    const { reportId } = await seedApprovedReport();
    await expectAppError(buildWeeklyReportSendDraft(db, reportId, SUPER_ACTOR), 403, /project manager/i);
  });

  it("is available to leadership", async () => {
    const { reportId } = await seedApprovedReport();
    await expect(buildWeeklyReportSendDraft(db, reportId, DIRECTOR_ACTOR)).resolves.toMatchObject({
      reportId,
    });
  });
});

describe("sending", () => {
  it("freezes the request, mints a live link and queues exactly one delivery", async () => {
    const { reportId } = await seedApprovedReport();
    const result = await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"], contextParagraph: "Framing is done." },
      shareUrlFor,
    });

    expect(result.report.status).toBe("sent");
    expect(result.shareUrl).toBe(`https://reports.example.com/wr/${mintedTokens[0]}`);

    const row = await reportRow(reportId);
    expect(row.send_request.recipients).toEqual(["jay@example.com"]);
    expect(row.send_request.contextParagraph).toBe("Framing is done.");
    // The URL the client will actually open, carried on the row — the raw token is unrecoverable from
    // public.weekly_report_tokens, which stores only its hash.
    expect(row.send_request.shareUrl).toBe(result.shareUrl);
    expect(row.send_delivery_key).toBeTruthy();
    expect(row.send_delivered_at).toBeNull();
    expect(row.sent_at).not.toBeNull();
    // The header snapshot is frozen in the SAME statement, so a sent report can never read a setup row
    // somebody edits next month.
    expect(row.snapshot.trockTeam.pmName).toBe("Adam Sherwood");

    const jobs = await sendJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({
      reportId,
      officeSlug: "dallas",
      tenantSchema: "office_dallas",
      deliveryKey: row.send_delivery_key,
    });
    expect(jobs[0]!.office_id).toBe(OFFICE);
    expect(jobs[0]!.status).toBe("pending");
  });

  it("mints a token that actually resolves, scoped to this report and office", async () => {
    const { reportId } = await seedApprovedReport();
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });

    const resolution = await resolveWeeklyReportToken(db, mintedTokens[0]!);
    expect(resolution.status).toBe("active");
    expect(resolution.token?.weeklyReportId).toBe(reportId);
    expect(resolution.token?.officeSlug).toBe("dallas");
    // Stored hashed, never in the clear — a database read must not reconstruct a live client link.
    const stored = await pg.query<{ token: string }>(`SELECT token FROM public.weekly_report_tokens`);
    expect(stored.rows[0]!.token).toBe(hashWeeklyReportToken(mintedTokens[0]!));
    expect(stored.rows[0]!.token).not.toBe(mintedTokens[0]);
  });

  it("refuses a report the PM has not approved", async () => {
    const project = await seedProject();
    const { report } = await createWeeklyReportDraft(
      db,
      { clientSubmissionId: U("59001"), weeklyReportProjectId: project.id, weekOf: WEEK_OF },
      SUPER_ACTOR,
    );
    await updateWeeklyReportContent(db, report.id, { workCompleted: "Some work." }, SUPER_ACTOR);
    await expectAppError(
      sendWeeklyReport(db, {
        reportId: report.id,
        office: OFFICE_CONTEXT,
        actor: SENDER,
        payload: { recipients: ["jay@example.com"] },
        shareUrlFor,
      }),
      409,
      /approved by the PM/i,
    );
    expect(await sendJobs()).toHaveLength(0);
  });

  it("refuses a second send, naming the correction rather than merely saying no", async () => {
    const { reportId } = await seedApprovedReport();
    const payload = { recipients: ["jay@example.com"] };
    await sendWeeklyReport(db, { reportId, office: OFFICE_CONTEXT, actor: SENDER, payload, shareUrlFor });
    await expectAppError(
      sendWeeklyReport(db, { reportId, office: OFFICE_CONTEXT, actor: SENDER, payload, shareUrlFor }),
      409,
      /already been sent/i,
    );
    expect(await sendJobs()).toHaveLength(1);
  });

  it("is refused to the superintendent even on their own report", async () => {
    const { reportId } = await seedApprovedReport();
    await expectAppError(
      sendWeeklyReport(db, {
        reportId,
        office: OFFICE_CONTEXT,
        actor: SUPER_ACTOR,
        payload: { recipients: ["jay@example.com"] },
        shareUrlFor,
      }),
      403,
      /project manager/i,
    );
  });

  it("LOSES a race against a concurrent withdrawal rather than sending anyway", async () => {
    // The bug this closes: read-then-write with no condition on the read. Two requests on an `approved`
    // report both pass validation — one sending, one withdrawing — and whichever writes last wins. The
    // transition's UPDATE is conditioned on the status it validated, so the send must fail outright.
    const { reportId } = await seedApprovedReport();
    const racing = racingDb(
      () =>
        pg.query(`UPDATE office_dallas.weekly_reports SET status = 'pending_review' WHERE id = $1::uuid`, [
          reportId,
        ]),
      "UPDATE weekly_reports SET status",
    );

    await expectAppError(
      sendWeeklyReport(racing, {
        reportId,
        office: OFFICE_CONTEXT,
        actor: SENDER,
        payload: { recipients: ["jay@example.com"] },
        shareUrlFor,
      }),
      409,
      /changed while you were working/i,
    );

    const row = await reportRow(reportId);
    expect(row.status).toBe("pending_review");
    expect(row.sent_at).toBeNull();
    expect(row.send_request).toBeNull();
  });

  it("validates the recipients before minting anything", async () => {
    const { reportId } = await seedApprovedReport();
    await expectAppError(
      sendWeeklyReport(db, {
        reportId,
        office: OFFICE_CONTEXT,
        actor: SENDER,
        payload: { recipients: [] },
        shareUrlFor,
      }),
      400,
      /at least one/i,
    );
    // No token, no job, no status change — a refused send must leave nothing behind.
    const tokens = await pg.query(`SELECT id FROM public.weekly_report_tokens`);
    expect(tokens.rows).toHaveLength(0);
    expect(await sendJobs()).toHaveLength(0);
    expect((await reportRow(reportId)).status).toBe("approved");
  });

  it("re-addresses the greeting when the PM removes the contact it was written for", async () => {
    const { reportId } = await seedApprovedReport();
    const result = await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["melissa@example.com"] },
      shareUrlFor,
    });
    expect(result.sendRequest.greetingName).toBe("Melissa Garcia");
  });

  it("leaves the greeting generic for a free-typed address it cannot attribute", async () => {
    const { reportId } = await seedApprovedReport();
    const result = await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["someone.else@client.com"] },
      shareUrlFor,
    });
    expect(result.sendRequest.greetingName).toBeNull();
  });
});

/**
 * THE SERVER -> WORKER CONTRACT.
 *
 * `send_request` is the only description of what was sent, and the worker reads it out of jsonb — so
 * nothing about it is typed at runtime. Every field below survived being silently dropped: the PM's
 * edited subject discarded, the 300-character cap unenforced, the entire PM signature written as null so
 * every client email arrived with nobody to reply to, and the attach-PDF toggle ignored. The worker suite
 * could not catch any of it, because it read the request from a fixture it wrote itself.
 */
describe("what gets frozen onto the row", () => {
  async function sentRequestFor(
    payload: Record<string, unknown>,
    seed: { weekOf?: string; projectId?: string } = {},
  ) {
    const { reportId } = await seedApprovedReport(seed);
    const result = await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload,
      shareUrlFor,
    });
    return { reportId, result, row: await reportRow(reportId) };
  }

  it("carries EXACTLY the keys the worker reads, so the two cannot drift apart", async () => {
    const { row } = await sentRequestFor({ recipients: ["jay@example.com"] });
    expect(Object.keys(row.send_request).sort()).toEqual([...WEEKLY_REPORT_SEND_REQUEST_KEYS].sort());
  });

  it("keeps the subject the PM actually typed", async () => {
    const { row, result } = await sentRequestFor({
      recipients: ["jay@example.com"],
      subject: "Cedar Springs — please read before Friday",
    });
    expect(result.sendRequest.subject).toBe("Cedar Springs — please read before Friday");
    expect(row.send_request.subject).toBe("Cedar Springs — please read before Friday");
  });

  it("falls back to the composed subject only when none was posted", async () => {
    const { row } = await sentRequestFor({ recipients: ["jay@example.com"] });
    expect(row.send_request.subject).toBe("4123 Cedar Springs — Weekly Progress Report, Week of 8/13/26");
  });

  it("enforces the subject cap rather than handing a provider an unbounded header", async () => {
    const { reportId } = await seedApprovedReport();
    await expectAppError(
      sendWeeklyReport(db, {
        reportId,
        office: OFFICE_CONTEXT,
        actor: SENDER,
        payload: { recipients: ["jay@example.com"], subject: "x".repeat(301) },
        shareUrlFor,
      }),
      400,
      /limited to 300 characters/i,
    );
    expect(await sendJobs()).toHaveLength(0);
  });

  it("strips CR/LF from the subject before it can reach a mail header", async () => {
    // Recipients are safe by their own pattern, and Resend builds the MIME server-side, so this is
    // defence in depth — but the value went to `resend.emails.send({ subject })` completely unsanitised.
    const { row } = await sentRequestFor({
      recipients: ["jay@example.com"],
      subject: "Weekly report\r\nBcc: attacker@example.com",
    });
    expect(row.send_request.subject).not.toMatch(/[\r\n]/);
    expect(row.send_request.subject).toBe("Weekly report Bcc: attacker@example.com");
  });

  it("carries the PM's whole signature, which is the client's only way to reply", async () => {
    // Nulled out, every client email goes out with no name, no address and no phone number — and the
    // footer explicitly tells the reader to use those details.
    const { row } = await sentRequestFor({ recipients: ["jay@example.com"] });
    expect(row.send_request.sender).toEqual({
      name: "Adam Sherwood",
      email: "adam@trockconstruction.com",
      phone: "(214) 555-0142",
    });
  });

  it("honours the attach-PDF toggle in both directions", async () => {
    // One project, two weeks: a deal carries a single weekly-report setup, so two sends have to be two
    // weeks rather than two projects.
    const project = await seedProject();
    const off = await sentRequestFor(
      { recipients: ["jay@example.com"], attachPdf: false },
      { projectId: project.id, weekOf: PRIOR_WEEK },
    );
    expect(off.row.send_request.attachPdf).toBe(false);
    const on = await sentRequestFor(
      { recipients: ["jay@example.com"], attachPdf: true },
      { projectId: project.id, weekOf: WEEK_OF },
    );
    expect(on.row.send_request.attachPdf).toBe(true);
  });
});

/**
 * The all-or-nothing guarantee, exercised against a REAL transaction.
 *
 * Every other test here runs in PGlite autocommit, where each statement commits on its own — so the claim
 * that a refused send leaves nothing behind was asserted by a harness in which it was not even true.
 */
describe("a refused send leaves nothing behind", () => {
  it("rolls the minted token back with the rest of the transaction", async () => {
    const { reportId } = await seedApprovedReport();
    // The window that matters is BETWEEN the permission check and the write, and the token is minted in
    // it — so a refusal here is the case where a live public credential could outlive its report.
    const racing = racingDb(
      () =>
        pg.query(`UPDATE office_dallas.weekly_reports SET status = 'pending_review' WHERE id = $1::uuid`, [
          reportId,
        ]),
      "UPDATE weekly_reports SET status",
    );

    await expectAppError(
      inTransaction(() =>
        sendWeeklyReport(racing, {
          reportId,
          office: OFFICE_CONTEXT,
          actor: SENDER,
          payload: { recipients: ["jay@example.com"] },
          shareUrlFor,
        }),
      ),
      409,
    );

    // A token minted for a report that never moved to `sent` is a state nothing reconciles: the link
    // resolves, the viewer serves whatever the super types next, and no CRM surface knows it exists.
    expect((await pg.query(`SELECT id FROM public.weekly_report_tokens`)).rows).toHaveLength(0);
    expect(await sendJobs()).toHaveLength(0);
    expect((await reportRow(reportId)).status).toBe("approved");
  });
});

describe("corrections", () => {
  async function sentReport() {
    const { projectId, reportId } = await seedApprovedReport();
    const fileId = await seedPhoto("Original capture description");
    await replaceWeeklyReportPhotos(
      db,
      reportId,
      [{ fileId, caption: "Level 4 framing" }],
      PM_ACTOR,
    );
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    return { projectId, reportId, fileId };
  }

  it("clones content and REPORT captions to the next version, ready to send", async () => {
    const { reportId } = await sentReport();
    const correction = await createWeeklyReportCorrection(db, reportId, SENDER);

    expect(correction.version).toBe(2);
    expect(correction.status).toBe("approved");
    expect(correction.workCompleted).toBe("Framing complete on levels 3 and 4.");
    // The report caption travels, not the file's own description — the correction starts as a copy of
    // what the client actually saw.
    expect(correction.photos).toHaveLength(1);
    expect(correction.photos[0]!.caption).toBe("Level 4 framing");
    expect(correction.photos[0]!.originalDescription).toBe("Original capture description");
    // Stamped as if it had walked the ladder, so the audit trail does not show an approval with no submit.
    expect(correction.submittedAt).not.toBeNull();
    expect(correction.reviewedAt).not.toBeNull();
  });

  it("does NOT supersede the original until the correction is actually sent", async () => {
    // A correction the PM abandons half-written must not put "a newer version was issued" in front of a
    // client, pointing at a version that does not exist for them to read.
    const { reportId } = await sentReport();
    await createWeeklyReportCorrection(db, reportId, SENDER);
    expect((await reportRow(reportId)).superseded_by_id).toBeNull();
  });

  it("supersedes the original on send, and the original link keeps resolving", async () => {
    const { reportId } = await sentReport();
    const originalToken = mintedTokens[0]!;
    const correction = await createWeeklyReportCorrection(db, reportId, SENDER);
    await sendWeeklyReport(db, {
      reportId: correction.id,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });

    expect((await reportRow(reportId)).superseded_by_id).toBe(correction.id);
    // The old link is NOT revoked. A client who bookmarked it must not hit a dead end; the viewer shows
    // the superseded banner instead (WEEKLY_REPORT_SUPERSEDED_NOTICE, asserted in the viewer suite).
    const resolution = await resolveWeeklyReportToken(db, originalToken);
    expect(resolution.status).toBe("active");
    expect(resolution.token?.weeklyReportId).toBe(reportId);
    // And the correction has its OWN link, so revoking one cannot kill the other.
    expect(mintedTokens[1]).not.toBe(originalToken);
  });

  it("tells the client, in the platform's own words, that this replaces what they have", async () => {
    const { reportId } = await sentReport();
    await markDelivered(reportId);
    const correction = await createWeeklyReportCorrection(db, reportId, SENDER);
    const result = await sendWeeklyReport(db, {
      reportId: correction.id,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"], contextParagraph: "" },
      shareUrlFor,
    });
    expect(result.sendRequest.isCorrection).toBe(true);
  });

  it("does NOT call itself a correction when the version it replaces never reached the client", async () => {
    // The common case, not an edge one: a PM staring at a "Send failed" chip reaches for the most
    // prominent button on the row, which is "Send correction". Keyed on `version > 1`, the email that
    // followed opened "This is a revised version of a report that was sent to you earlier. It replaces
    // the previous copy." — to a client who received nothing, and who now goes looking for an email that
    // does not exist. The v1 here is `sent` with no delivery, exactly as a failed send leaves it.
    const { reportId } = await sentReport();
    const correction = await createWeeklyReportCorrection(db, reportId, SENDER);
    const draft = await buildWeeklyReportSendDraft(db, correction.id, SENDER);
    expect(draft.version).toBe(2);
    // The modal and the email agree, because both ask the same question.
    expect(draft.isCorrection).toBe(false);

    const result = await sendWeeklyReport(db, {
      reportId: correction.id,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    expect(result.sendRequest.isCorrection).toBe(false);
  });

  it("gets its OWN delivery key, so the provider does not refuse it as a duplicate", async () => {
    // The retry path deliberately replays the key. If a correction reused it too, the provider would
    // answer "already delivered" and the client would never receive the fix.
    const { reportId } = await sentReport();
    const originalKey = (await reportRow(reportId)).send_delivery_key;
    const correction = await createWeeklyReportCorrection(db, reportId, SENDER);
    await sendWeeklyReport(db, {
      reportId: correction.id,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    expect((await reportRow(correction.id)).send_delivery_key).not.toBe(originalKey);
  });

  it("REFUSES a second correction while an unsent one already exists", async () => {
    // History offers "Send correction" on any sent row that is not yet superseded, and a row is only
    // superseded when its replacement is SENT — so a PM who drafts a v2 and comes back to the same v1 row
    // was offered the button again and got a v3. Both landed `approved`, sending v2 superseded only v1,
    // and the week was then left live on v3: the board said the client was still owed a report they had
    // already received, its Send button targeted a THIRD email, and a delivery failure on v2 raised no
    // chip at all because the live row was v3.
    const { reportId } = await sentReport();
    const v2 = await createWeeklyReportCorrection(db, reportId, SENDER);
    expect(v2.version).toBe(2);
    await expectAppError(
      createWeeklyReportCorrection(db, reportId, SENDER),
      409,
      /Version 2 of this week's report already exists/i,
    );
    const versions = await pg.query<{ version: number }>(
      `SELECT version FROM office_dallas.weekly_reports WHERE week_of = $1::date ORDER BY version`,
      [WEEK_OF],
    );
    expect(versions.rows.map((row) => Number(row.version))).toEqual([1, 2]);
  });

  it("takes the next FREE version once the previous correction has gone out", async () => {
    // Correcting the same week twice IS legitimate — it just has to happen in sequence. `MAX(version) + 1`
    // rather than `source.version + 1`: the latter collides with the live v2 on the week/version unique
    // index and surfaces as a raw 23505.
    const { reportId } = await sentReport();
    const v2 = await createWeeklyReportCorrection(db, reportId, SENDER);
    await sendWeeklyReport(db, {
      reportId: v2.id,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    const v3 = await createWeeklyReportCorrection(db, v2.id, SENDER);
    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
  });

  it("refuses a correction on a report that was never sent", async () => {
    const { reportId } = await seedApprovedReport();
    await expectAppError(createWeeklyReportCorrection(db, reportId, SENDER), 409, /edit it instead/i);
  });

  it("is refused to the superintendent", async () => {
    const { reportId } = await sentReport();
    await expectAppError(createWeeklyReportCorrection(db, reportId, SUPER_ACTOR), 403, /project manager/i);
  });

  it("leaves the SENT original immutable — the correction is where edits go", async () => {
    const { reportId } = await sentReport();
    await createWeeklyReportCorrection(db, reportId, SENDER);
    await expectAppError(
      updateWeeklyReportContent(db, reportId, { workCompleted: "rewritten" }, PM_ACTOR),
      409,
      /cannot be edited/i,
    );
  });
});

/**
 * THE SUPERSEDE CHAIN.
 *
 * Four predicates decide which rows a send stamps, and weakening any of them left a green suite: the only
 * test that touched this asserted v1's pointer and never looked at the correction's own row or at a
 * three-version chain.
 */
describe("superseding", () => {
  async function sentV1() {
    const { projectId, reportId } = await seedApprovedReport();
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    return { projectId, reportId };
  }

  async function send(reportId: string) {
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
  }

  it("never supersedes the version being sent", async () => {
    // `version <= $4` instead of `<`: the correction stamps ITSELF, so the week has no un-superseded row
    // at all and the dashboard's DISTINCT ON — which filters on `superseded_by_id IS NULL` — reports the
    // week as never started while the client is reading it.
    const { reportId } = await sentV1();
    const v2 = await createWeeklyReportCorrection(db, reportId, SENDER);
    await send(v2.id);
    expect((await reportRow(v2.id)).superseded_by_id).toBeNull();

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.weekOf === WEEK_OF);
    expect(row!.reportId).toBe(v2.id);
    expect(row!.state).toBe("sent");
  });

  it("keeps the chain intact across three versions instead of rewriting it", async () => {
    // Dropping `superseded_by_id IS NULL` re-points v1 at v3, losing the record that v2 ever replaced it.
    const { reportId } = await sentV1();
    const v2 = await createWeeklyReportCorrection(db, reportId, SENDER);
    await send(v2.id);
    const v3 = await createWeeklyReportCorrection(db, v2.id, SENDER);
    await send(v3.id);

    expect((await reportRow(reportId)).superseded_by_id).toBe(v2.id);
    expect((await reportRow(v2.id)).superseded_by_id).toBe(v3.id);
    expect((await reportRow(v3.id)).superseded_by_id).toBeNull();
  });

  it("does not supersede a version the client was never SENT", async () => {
    // Defence in depth. The correction guard makes two live drafts unreachable through this API today, so
    // the unsent v2 is inserted directly — the state a future caller (the deferred field route, a data
    // fix, a concurrent path) could still produce. Without `status = 'sent'` in the predicate, sending v3
    // stamps the unsent v2, and NOTHING ever clears it: send v2 afterwards and the client opens the link
    // in the email that has just arrived to be told their version is out of date.
    const { projectId, reportId } = await sentV1();
    const orphan = U("7f001");
    await pg.query(
      `INSERT INTO office_dallas.weekly_reports
         (id, client_submission_id, weekly_report_project_id, deal_id, week_of, version, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, 2, 'approved')`,
      [orphan, U("7f002"), projectId, DEAL, WEEK_OF],
    );
    const v3 = U("7f003");
    await pg.query(
      `INSERT INTO office_dallas.weekly_reports
         (id, client_submission_id, weekly_report_project_id, deal_id, week_of, version, status,
          work_completed)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, 3, 'approved', 'Framing.')`,
      [v3, U("7f004"), projectId, DEAL, WEEK_OF],
    );

    await send(v3);
    expect((await reportRow(orphan)).superseded_by_id).toBeNull();
    // v1 WAS sent, so it is superseded — the predicate is selective, not simply inert.
    expect((await reportRow(reportId)).superseded_by_id).toBe(v3);
  });
});

/**
 * WHO THE CRM ACTUALLY LETS SEND.
 *
 * Recorded as a test because the answer is not what the service layer suggests, and the gap is the kind
 * that reads as a working feature until a real PM tries it.
 */
describe("the assigned PM has no send route yet", () => {
  it("passes the SERVICE gate — which is why the field mount can reuse this code unchanged", async () => {
    const project = await seedProject();
    const row = await pg.query(
      `SELECT * FROM office_dallas.weekly_report_projects WHERE id = $1::uuid`,
      [project.id],
    );
    expect(canPublishWeeklyReport(row.rows[0] as Record<string, any>, PM_ACTOR)).toBe(true);
  });

  it("but reaches no CRM endpoint, because the router admits neither of the roles a PM holds", async () => {
    // `ASSIGNABLE_ROLES` (projects-service.ts) is field_contractor/construction/admin/director — the roles
    // that may hold the PM slot. The CRM send routes require admin/director. So the assigned-PM arm of
    // `canPublishWeeklyReport` is unreachable from the CRM for anyone who is not already leadership, and
    // this PR ships no send capability for a PM at all. The refusal itself is asserted end-to-end in
    // tests/weekly-report-send-route.test.ts; asserted here is that the two role sets genuinely disjoin.
    const assignableButNotLeadership = ["field_contractor", "construction"];
    const crmSenders = ["admin", "director"];
    expect(assignableButNotLeadership.some((role) => crmSenders.includes(role))).toBe(false);
  });
});

describe("retrying a failed send", () => {
  async function failedSend() {
    const { reportId } = await seedApprovedReport();
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    // Stand in for the worker's own failure bookkeeping.
    await pg.query(
      `UPDATE office_dallas.weekly_reports
          SET send_attempts = 3, send_error = 'Resend timed out', send_last_attempt_at = now()
        WHERE id = $1::uuid`,
      [reportId],
    );
    await pg.query(`DELETE FROM public.job_queue`);
    return reportId;
  }

  it("re-queues the SAME delivery key, so a send that actually succeeded cannot become a second copy", async () => {
    const reportId = await failedSend();
    const keyBefore = (await reportRow(reportId)).send_delivery_key;

    await retryWeeklyReportSend(db, reportId, SENDER, OFFICE_CONTEXT);

    const jobs = await sendJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.deliveryKey).toBe(keyBefore);
    expect((await reportRow(reportId)).send_delivery_key).toBe(keyBefore);
  });

  it("clears the error but KEEPS the attempt count", async () => {
    // Zeroing attempts would hide a report that has failed nine times behind a chip reading "attempt 1".
    const reportId = await failedSend();
    const detail = await retryWeeklyReportSend(db, reportId, SENDER, OFFICE_CONTEXT);
    expect(detail.sendError).toBeNull();
    expect(detail.sendAttempts).toBe(3);
  });

  it("refuses once the provider has accepted it — and says only what it can evidence", async () => {
    // The refusal used to read "This report has already reached the client", which the platform cannot
    // know: `send_delivered_at` records that RESEND ACCEPTED the message, and there is no bounce webhook
    // anywhere in this codebase, so a report addressed to a mistyped domain is accepted, hard-bounces,
    // and reads here exactly like one that landed in an inbox.
    const reportId = await failedSend();
    await markDelivered(reportId);
    await expectAppError(
      retryWeeklyReportSend(db, reportId, SENDER, OFFICE_CONTEXT),
      409,
      /accepted by the mail provider/i,
    );
    await expectAppError(
      retryWeeklyReportSend(db, reportId, SENDER, OFFICE_CONTEXT),
      409,
      /^(?!.*reached the client).*$/,
    );
    expect(await sendJobs()).toHaveLength(0);
  });

  it("refuses on a report that was never sent", async () => {
    const { reportId } = await seedApprovedReport();
    await expectAppError(retryWeeklyReportSend(db, reportId, SENDER, OFFICE_CONTEXT), 409, /has been sent/i);
  });

  it("REFUSES unacknowledged once the provider's idempotency window has closed", async () => {
    // The retry path's whole safety argument is that replaying the same key makes the worst outcome a
    // no-op. Resend keeps an idempotency key for 24 HOURS; this chip lives on the board for the 26-week
    // lookback. A PM clicking Retry the following Monday is far outside the window, the key no longer
    // dedupes, and the "no-op" is a second copy of the report in a client's inbox.
    const reportId = await failedSend();
    await ageSend(reportId, (WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS + 1) * 60);

    await expectAppError(
      retryWeeklyReportSend(db, reportId, SENDER, OFFICE_CONTEXT),
      409,
      /second copy in the client's inbox/i,
    );
    expect(await sendJobs()).toHaveLength(0);
  });

  it("allows it once the caller has acknowledged the duplicate risk", async () => {
    // Not blocked outright: an undelivered client report has to have a way forward. It is made a
    // deliberate act rather than a silent one.
    const reportId = await failedSend();
    await ageSend(reportId, (WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS + 1) * 60);
    await retryWeeklyReportSend(db, reportId, SENDER, OFFICE_CONTEXT, {
      acknowledgeDuplicateRisk: true,
    });
    expect(await sendJobs()).toHaveLength(1);
  });

  it("needs no acknowledgement inside the window, where the key really does dedupe", async () => {
    const reportId = await failedSend();
    await ageSend(reportId, (WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS - 1) * 60);
    await retryWeeklyReportSend(db, reportId, SENDER, OFFICE_CONTEXT);
    expect(await sendJobs()).toHaveLength(1);
  });

  it("is refused to the superintendent", async () => {
    const reportId = await failedSend();
    await expectAppError(
      retryWeeklyReportSend(db, reportId, SUPER_ACTOR, OFFICE_CONTEXT),
      403,
      /project manager/i,
    );
  });

  it("REFUSES a version a correction has already replaced, whatever the caller acknowledges", async () => {
    // THE ONE OUTCOME THIS FEATURE MUST NEVER PRODUCE, and every other predicate on this path waves it
    // through. v1 is sent and its delivery fails; the PM issues a correction; v2 is sent and DELIVERED.
    // v1 is then `sent`, `superseded_by_id` = v2, `send_delivered_at` still NULL, its stored request
    // still carrying the live share URL — that is only dropped on delivery — and `sent_at` recent enough
    // that even the duplicate-risk gate is satisfied.
    //
    // Replaying it emails a paying client the version they were already told was replaced, with
    // `isCorrection: false` so nothing in the message explains it, pointing at a page that then shows
    // them a superseded notice. Irreversible, and invisible: the board's undelivered query already
    // carries `superseded_by_id IS NULL`, so nothing on any dashboard would ever mention it.
    const v1 = await failedSend();
    const correction = await createWeeklyReportCorrection(db, v1, SENDER);
    await sendWeeklyReport(db, {
      reportId: correction.id,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    await markDelivered(correction.id);
    // Precisely the row shape that used to pass: sent, undelivered, superseded, request intact.
    const row = await reportRow(v1);
    expect(row.status).toBe("sent");
    expect(row.send_delivered_at).toBeNull();
    expect(row.superseded_by_id).toBe(correction.id);
    expect(row.send_request.shareUrl).toBeTruthy();
    await pg.query(`DELETE FROM public.job_queue`);

    await expectAppError(
      retryWeeklyReportSend(db, v1, SENDER, OFFICE_CONTEXT),
      409,
      /newer version/i,
    );
    // Acknowledging the duplicate risk is not a way past it. This is not a duplicate-risk question at
    // all — that message is about sending the SAME report twice, and this would send the WRONG one.
    await expectAppError(
      retryWeeklyReportSend(db, v1, SENDER, OFFICE_CONTEXT, { acknowledgeDuplicateRisk: true }),
      409,
      /newer version/i,
    );
    expect(await sendJobs()).toHaveLength(0);
  });

  it("still retries an undelivered version nothing has replaced yet", async () => {
    // The other direction, and why the predicate is `superseded_by_id` rather than "a later version
    // exists": superseding happens at SEND, so a v1 with a v2 merely DRAFTED beside it is still the
    // version the client is owed. The board points its own Retry at v1 in exactly this state.
    const v1 = await failedSend();
    await createWeeklyReportCorrection(db, v1, SENDER);
    expect((await reportRow(v1)).superseded_by_id).toBeNull();

    await retryWeeklyReportSend(db, v1, SENDER, OFFICE_CONTEXT);
    const jobs = await sendJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.reportId).toBe(v1);
  });
});

describe("the dashboard's view of a send", () => {
  async function sentWeek(weekOf: string) {
    const project = await seedProject();
    const { reportId } = await seedApprovedReport({ weekOf, projectId: project.id });
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    return reportId;
  }

  it("KEEPS a past week whose send failed, instead of filing it away as settled", async () => {
    // The bug this closes: the board drops every settled week that is not the current one, and a `sent`
    // report is settled. A send that failed three weeks ago therefore vanished from the one page whose
    // job is to catch it — nobody is waiting on it, and the client is simply never going to receive it.
    const reportId = await sentWeek(PRIOR_WEEK);
    await pg.query(
      `UPDATE office_dallas.weekly_reports SET send_error = 'Resend timed out', send_attempts = 2
        WHERE id = $1::uuid`,
      [reportId],
    );

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.weekOf === PRIOR_WEEK);
    expect(row).toBeDefined();
    expect(row!.sendFailed).toBe(true);
    expect(row!.sendAttempts).toBe(2);
    expect(row!.sendError).toBe("Resend timed out");
    // And it names somebody to chase, rather than leaving the column empty on the one row needing a person.
    expect(row!.waitingOn).toBe("Adam Sherwood");
  });

  it("still files away a past week that actually reached the client", async () => {
    const reportId = await sentWeek(PRIOR_WEEK);
    await pg.query(`UPDATE office_dallas.weekly_reports SET send_delivered_at = now() WHERE id = $1::uuid`, [
      reportId,
    ]);
    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    expect(board.rows.some((entry) => entry.weekOf === PRIOR_WEEK)).toBe(false);
  });

  it("does not call a still-queued send a failure", async () => {
    // No error yet — the job was queued seconds ago. Reporting that as "Send failed" would have PMs
    // re-sending on top of deliveries that are simply in flight.
    const reportId = await sentWeek(WEEK_OF);
    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.reportId === reportId);
    expect(row!.state).toBe("sent");
    expect(row!.sendFailed).toBe(false);
    expect(row!.sendDeliveredAt).toBeNull();
  });

  it("stops calling it a failure once a retry has delivered it", async () => {
    // Written to match what the two writers ACTUALLY do. An earlier version of this test hand-crafted a
    // row with an error AND a delivery, to exercise a conjunct that no producible state can reach: the
    // worker's success UPDATE binds `send_error = NULL` in the same statement that stamps
    // `send_delivered_at`, and `retryWeeklyReportSend` clears the error before requeueing. So a delivered
    // report never carries an error, and the claim that the text is "deliberately left in place after a
    // retry succeeds" was simply not true of this code.
    const reportId = await sentWeek(WEEK_OF);
    await pg.query(
      `UPDATE office_dallas.weekly_reports
          SET send_error = 'Resend timed out', send_attempts = 1 WHERE id = $1::uuid`,
      [reportId],
    );
    expect(
      (await getWeeklyReportDashboard(db, { asOf: WEEK_OF })).rows.find(
        (entry) => entry.reportId === reportId,
      )!.sendFailed,
    ).toBe(true);

    // The retry, and then the worker's own success write — error cleared, delivery stamped, together.
    await retryWeeklyReportSend(db, reportId, SENDER, OFFICE_CONTEXT);
    await markDelivered(reportId);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.reportId === reportId);
    expect(row!.sendFailed).toBe(false);
    expect(row!.sendStalled).toBe(false);
    expect(row!.sendPending).toBe(false);
  });

  it("surfaces a send that failed with NO error recorded at all", async () => {
    // THE FAILURE MODE WITH NOTHING TO READ. The delivery job records its own outcome in the same
    // database whose unavailability is the likeliest reason it failed, and the queue gives up after three
    // attempts with 3s/9s/27s backoff — so a fault lasting a couple of minutes dead-letters the job
    // having written nothing. The row then reads `sent`, `sent_at` set, `send_error` NULL,
    // `send_delivered_at` NULL, `send_attempts` 0: identical, to a predicate keyed on the error, to a
    // send queued five seconds ago. The board showed "Sending…" that week, dropped the row entirely the
    // next, and left it out of the older-outstanding tally too. Nothing anywhere said a client had been
    // promised a report they were never going to get.
    const reportId = await sentWeek(PRIOR_WEEK);
    const before = await reportRow(reportId);
    expect(before.send_error).toBeNull();
    expect(Number(before.send_attempts)).toBe(0);

    // THIRTY-FIVE MINUTES, an absolute fixture — see STALLED_MINUTES. Ageing by
    // `WEEKLY_REPORT_SEND_STALL_MINUTES + 5` let the threshold be raised to 30000 with this test still
    // green, which restores the exact failure the test is named for.
    await ageSend(reportId, STALLED_MINUTES);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.weekOf === PRIOR_WEEK);
    expect(row).toBeDefined();
    expect(row!.sendStalled).toBe(true);
    expect(row!.sendFailed).toBe(false);
    expect(row!.sendPending).toBe(false);
    // And it names somebody to chase, and points Retry at the report that actually needs one.
    expect(row!.waitingOn).toBe("Adam Sherwood");
    expect(row!.sendRetryReportId).toBe(reportId);
  });

  it("still calls a freshly queued send in flight rather than stuck", async () => {
    // The other side of the threshold: a send committed seconds ago must not raise an alarm, or PMs will
    // re-send on top of deliveries that are simply on their way.
    const reportId = await sentWeek(PRIOR_WEEK);
    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.weekOf === PRIOR_WEEK);
    expect(row!.sendStalled).toBe(false);
    expect(row!.sendPending).toBe(true);
  });

  it("still calls a send five minutes old in flight — the lower edge, pinned absolutely", async () => {
    // The companion to the 35-minute fixture above, and the reason BOTH are absolute: with only one of
    // them the threshold could be moved in the untested direction and the suite would not notice. Five
    // minutes is under any plausible value of the threshold and over zero, so lowering it towards zero
    // fails here and raising it fails the test above.
    const reportId = await sentWeek(PRIOR_WEEK);
    await ageSend(reportId, IN_FLIGHT_MINUTES);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.weekOf === PRIOR_WEEK);
    expect(row!.sendStalled).toBe(false);
    expect(row!.sendPending).toBe(true);
  });

  it("never reports a failed send as stuck as well, however old it is", async () => {
    // `sendStalled`'s `send_error == null` conjunct, pinned. The CRM happens to mask a break here — it
    // renders the `sendFailed` branch first — but `sendStalled` is a PUBLISHED field the deferred T-Rock
    // Cam surface reads directly, and deriving all three verdicts on the server exists precisely so the
    // two surfaces cannot disagree about what the chip means. Without the conjunct an old failed send
    // reports BOTH, and the app says "Send stuck" — no error to show, nothing to act on — for a delivery
    // that recorded exactly why it failed.
    //
    // Aged on BOTH clocks, so the row really is past the threshold and only the conjunct is holding
    // `sendStalled` false.
    const reportId = await sentWeek(PRIOR_WEEK);
    await pg.query(
      `UPDATE office_dallas.weekly_reports
          SET send_error = 'Resend timed out', send_attempts = 3, send_last_attempt_at = now()
        WHERE id = $1::uuid`,
      [reportId],
    );
    await ageDelivery(reportId, STALLED_MINUTES);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.weekOf === PRIOR_WEEK);
    expect(row!.sendFailed).toBe(true);
    expect(row!.sendStalled).toBe(false);
    expect(row!.sendPending).toBe(false);
  });

  it("reads a retried send as back in flight, not as stuck", async () => {
    // A LEGITIMATE RETRY MUST NOT BE FLAGGED "Send stuck". The stall was aged off `sent_at`, which is
    // stamped once when the PM commits and never moves, while `retryWeeklyReportSend` cleared the error
    // and wrote no timestamp at all. So a send committed ninety minutes ago and retried a moment ago went
    // straight from "Send failed · 3 attempts" to "Send stuck", whose title told the PM no delivery had
    // ever been recorded — for a delivery that had recorded three attempts and an error which this very
    // call had just erased. The PM got no signal that their click did anything.
    //
    // Worse past the provider's dedupe window: they acknowledge the duplicate risk, see the row unchanged
    // and click again, and a second acknowledged replay is a second real copy in the client's inbox.
    const reportId = await sentWeek(PRIOR_WEEK);
    await pg.query(
      `UPDATE office_dallas.weekly_reports
          SET send_error = 'Resend timed out', send_attempts = 3, send_last_attempt_at = now()
        WHERE id = $1::uuid`,
      [reportId],
    );
    await ageDelivery(reportId, 90);

    const failing = (await getWeeklyReportDashboard(db, { asOf: WEEK_OF })).rows.find(
      (entry) => entry.weekOf === PRIOR_WEEK,
    );
    expect(failing!.sendFailed).toBe(true);
    expect(failing!.sendStalled).toBe(false);

    // Ninety minutes is well inside the provider's 24-hour window, so no acknowledgement is needed —
    // this is the ordinary retry, not the risky one.
    await retryWeeklyReportSend(db, reportId, SENDER, OFFICE_CONTEXT);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.weekOf === PRIOR_WEEK);
    expect(row!.sendFailed).toBe(false);
    expect(row!.sendStalled).toBe(false);
    // The positive feedback the PM never used to get. "Sending…", and no second Retry to double-click.
    expect(row!.sendPending).toBe(true);
    // And the history of the trouble is still there — the retry clears the error, never the count.
    expect(row!.sendAttempts).toBe(3);
  });

  it("calls a retried send stuck again once IT has gone quiet for the threshold", async () => {
    // The clock restarts; it is not switched off. A retry that itself produces nothing must come back as
    // a problem, or "Sending…" becomes permanent for any report a PM has ever pressed Retry on.
    const reportId = await sentWeek(PRIOR_WEEK);
    await pg.query(
      `UPDATE office_dallas.weekly_reports
          SET send_error = 'Resend timed out', send_attempts = 3, send_last_attempt_at = now()
        WHERE id = $1::uuid`,
      [reportId],
    );
    await ageDelivery(reportId, 90);
    await retryWeeklyReportSend(db, reportId, SENDER, OFFICE_CONTEXT);
    await ageDelivery(reportId, STALLED_MINUTES);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.weekOf === PRIOR_WEEK);
    expect(row!.sendStalled).toBe(true);
    expect(row!.sendPending).toBe(false);
    expect(row!.sendRetryReportId).toBe(reportId);
  });

  it("counts an undelivered past send in the older-outstanding tally, not as settled", async () => {
    const project = await seedProject({ cadenceStartDate: "2026-01-01" });
    const { reportId } = await seedApprovedReport({ weekOf: "2026-02-05", projectId: project.id });
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    const withUndelivered = await getWeeklyReportDashboard(db, { asOf: WEEK_OF, lookbackWeeks: 3 });
    const undeliveredCount = withUndelivered.olderOutstandingCounts[project.id] ?? 0;

    await markDelivered(reportId);
    const delivered = await getWeeklyReportDashboard(db, { asOf: WEEK_OF, lookbackWeeks: 3 });
    expect(delivered.olderOutstandingCounts[project.id] ?? 0).toBe(undeliveredCount - 1);
  });

  it("reads the LIVE version of a corrected week, not the superseded original", async () => {
    const reportId = await sentWeek(WEEK_OF);
    const correction = await createWeeklyReportCorrection(db, reportId, SENDER);
    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.weekOf === WEEK_OF);
    expect(row!.reportId).toBe(correction.id);
    expect(row!.reportVersion).toBe(2);
    expect(row!.state).toBe("approved");
  });

  it("KEEPS the failure visible when a PM issues a correction over it", async () => {
    // The trap this closes. v1 is `sent` with an error, so the board shows the chip, a Retry and the
    // "Send failures" card. The PM does the obvious thing and presses "Send correction". The clone lands
    // `approved`, and because superseding only happens at SEND both rows are un-superseded — so
    // `ORDER BY version DESC` makes v2 the live row, and chip, Retry and card all vanish. v1 is still
    // `sent`, still undelivered, and if the PM is pulled away before finishing v2 the client never
    // receives that week at all, while the board reads "approved, waiting on the PM" — indistinguishable
    // from a Send button nobody has pressed.
    const reportId = await sentWeek(WEEK_OF);
    await pg.query(
      `UPDATE office_dallas.weekly_reports SET send_error = 'Resend timed out', send_attempts = 3
        WHERE id = $1::uuid`,
      [reportId],
    );
    const correction = await createWeeklyReportCorrection(db, reportId, SENDER);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.weekOf === WEEK_OF);
    // The live version is the correction — that part was right.
    expect(row!.reportId).toBe(correction.id);
    expect(row!.state).toBe("approved");
    // But the undelivered original is still the week's outstanding problem, and Retry addresses IT.
    expect(row!.sendFailed).toBe(true);
    expect(row!.sendError).toBe("Resend timed out");
    expect(row!.sendAttempts).toBe(3);
    expect(row!.sendRetryReportId).toBe(reportId);
    expect(row!.waitingOn).toBe("Adam Sherwood");
    // And the AGE of that send, not the clone's. The clone is `approved` and has no `sent_at` at all, so
    // a caller measuring the provider's 24-hour idempotency window off `row.sentAt` reads null — "outside
    // the window" — and warns the PM that retrying will put a second copy in the client's inbox, for a
    // send committed seconds ago that the provider provably still dedupes.
    expect(row!.sentAt).toBeNull();
    expect(row!.sendRetrySentAt).not.toBeNull();
    expect(weeklyReportRetryIsProviderDeduped(row!.sendRetrySentAt)).toBe(true);
  });

  it("stops nagging about the original once the correction has gone out", async () => {
    // The other direction: a superseded original is not a permanent complaint. The week's outstanding
    // delivery becomes the correction's.
    const reportId = await sentWeek(WEEK_OF);
    await pg.query(
      `UPDATE office_dallas.weekly_reports SET send_error = 'Resend timed out' WHERE id = $1::uuid`,
      [reportId],
    );
    const correction = await createWeeklyReportCorrection(db, reportId, SENDER);
    await sendWeeklyReport(db, {
      reportId: correction.id,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    await markDelivered(correction.id);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.weekOf === WEEK_OF);
    expect(row!.sendFailed).toBe(false);
    expect(row!.sendStalled).toBe(false);
    expect(row!.sendRetryReportId).toBeNull();
  });
});

/**
 * The Projects tab's counters.
 *
 * "Reports sent" and "Last sent" are the numbers a director reads to a client. Counting `status = 'sent'`
 * counted the button press.
 */
describe("the per-project counters", () => {
  it("counts DELIVERED reports, and shows the undelivered ones rather than hiding them", async () => {
    const { reportId } = await seedApprovedReport();
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });

    const pending = (await listWeeklyReportProjectSummaries(db, WEEK_OF))[0]!;
    // Committed but never delivered: not a report anyone can tell a client they received.
    expect(pending.reportsSent).toBe(0);
    expect(pending.lastSentAt).toBeNull();
    // Narrowing the count must not simply make the report disappear from the tab.
    expect(pending.undeliveredSends).toBe(1);

    await markDelivered(reportId);
    const delivered = (await listWeeklyReportProjectSummaries(db, WEEK_OF))[0]!;
    expect(delivered.reportsSent).toBe(1);
    expect(delivered.lastSentAt).not.toBeNull();
    expect(delivered.lastSentWeekOf).toBe(WEEK_OF);
    expect(delivered.undeliveredSends).toBe(0);
  });

  it("stops counting a failed version once its correction has reached the client", async () => {
    // The two surfaces have to mean the same thing by "still owed". The board drops the original the
    // moment the correction is sent (see "stops nagging about the original once the correction has gone
    // out"); without the same `superseded_by_id IS NULL` here this tab kept a permanent "1 not delivered"
    // against a week the client has actually received — a number a director reads to that client.
    const { reportId } = await seedApprovedReport();
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    await pg.query(
      `UPDATE office_dallas.weekly_reports SET send_error = 'Resend timed out' WHERE id = $1::uuid`,
      [reportId],
    );
    expect((await listWeeklyReportProjectSummaries(db, WEEK_OF))[0]!.undeliveredSends).toBe(1);

    const correction = await createWeeklyReportCorrection(db, reportId, SENDER);
    // Still outstanding while the correction is only DRAFTED — nothing has reached the client yet.
    expect((await listWeeklyReportProjectSummaries(db, WEEK_OF))[0]!.undeliveredSends).toBe(1);

    await sendWeeklyReport(db, {
      reportId: correction.id,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    await markDelivered(correction.id);

    const after = (await listWeeklyReportProjectSummaries(db, WEEK_OF))[0]!;
    expect(after.undeliveredSends).toBe(0);
    expect(after.reportsSent).toBe(1);
    // And the board agrees — the whole point of matching the predicate.
    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    expect(board.rows.find((entry) => entry.weekOf === WEEK_OF)!.sendFailed).toBe(false);
  });
});

/**
 * "Two surfaces, one definition of still-owed" — for a setup that has STOPPED reporting.
 *
 * This is the common end state, not an edge case: the last report of a job fails to send, the job
 * finishes, somebody marks the setup completed or paused. The board scoped its projects to
 * `wrp.status = 'active'` and the Projects tab's counters to `wrp.is_active` alone, so the tab showed a
 * permanent red "1 not delivered" for which the board had no row at all — not in This Week, not in the
 * "and N older" tally — and therefore no Retry beside the number that demanded one.
 */
describe("a setup that has stopped reporting can still owe the client an email", () => {
  /**
   * @param options.sendError explicit `null` leaves the row SILENT — committed, undelivered, nothing
   *   written down about why. Every test in this block used to take the default, so the pass's other two
   *   verdicts (`sendStalled`, `sendPending`) were never once produced by it.
   */
  async function undeliveredThenStopped(
    status: "paused" | "completed",
    options: { sendError?: string | null } = {},
  ) {
    const { projectId, reportId } = await seedApprovedReport();
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    const sendError = options.sendError === undefined ? "Resend timed out" : options.sendError;
    if (sendError != null) {
      await pg.query(
        `UPDATE office_dallas.weekly_reports SET send_error = $2, send_attempts = 3 WHERE id = $1::uuid`,
        [reportId, sendError],
      );
    }
    await pg.query(`UPDATE office_dallas.weekly_report_projects SET status = $2 WHERE id = $1::uuid`, [
      projectId,
      status,
    ]);
    return { projectId, reportId };
  }

  it("keeps the undelivered send on the board after the project is paused", async () => {
    const { reportId } = await undeliveredThenStopped("paused");

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.weekOf === WEEK_OF);
    expect(row).toBeDefined();
    expect(row!.sendFailed).toBe(true);
    expect(row!.sendError).toBe("Resend timed out");
    expect(row!.sendAttempts).toBe(3);
    // The Retry the Projects tab's counter implies actually exists here, pointed at the right report.
    expect(row!.sendRetryReportId).toBe(reportId);
    expect(row!.sendRetrySentAt).not.toBeNull();
    // Somebody to chase. Nobody is waiting on the superintendent for a project that has stopped.
    expect(row!.waitingOn).toBe("Adam Sherwood");
    // Never LATE, though: lateness measures a report the cadence still expects, and it expects none.
    expect(row!.daysLate).toBe(0);
  });

  it("keeps it after the project is marked completed, which is how this usually ends", async () => {
    const { reportId } = await undeliveredThenStopped("completed");
    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    expect(board.rows.map((entry) => entry.sendRetryReportId)).toContain(reportId);
  });

  it("agrees with the Projects tab, which is the whole claim", async () => {
    // The tab's number and the board's rows, read together — the reconciliation the commit message
    // asserts. One undelivered send, one row, one counter.
    await undeliveredThenStopped("paused");
    const summary = (await listWeeklyReportProjectSummaries(db, WEEK_OF))[0]!;
    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const boardOutstanding = board.rows.filter((entry) => entry.sendRetryReportId != null).length;

    expect(summary.undeliveredSends).toBe(1);
    expect(boardOutstanding).toBe(1);
    expect(summary.reportsSent).toBe(0);
    // And the tab still says the setup owes no NEW report, which is what pausing it meant.
    expect(summary.nextDueWeekOf).toBeNull();
  });

  it("does not double an ACTIVE project's failed week, which the cadence loop already emitted", async () => {
    // The stopped-setup pass reads the same undelivered set the cadence loop does. Without its skip on
    // `status = 'active'` every failed send in the office would appear on the board twice — the "Send
    // failures" card counts rows, so the number a director acts on would be exactly doubled.
    const { projectId, reportId } = await seedApprovedReport();
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    await pg.query(
      `UPDATE office_dallas.weekly_reports SET send_error = 'Resend timed out' WHERE id = $1::uuid`,
      [reportId],
    );

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const forThisWeek = board.rows.filter(
      (entry) => entry.weeklyReportProjectId === projectId && entry.weekOf === WEEK_OF,
    );
    expect(forThisWeek).toHaveLength(1);
    expect(forThisWeek[0]!.sendFailed).toBe(true);
  });

  it("calls a stopped setup's SILENT send stuck once the clock has run out", async () => {
    // The pass's `sendStalled` verdict, which nothing here ever drove: every test in this block that
    // produced an undelivered send at all wrote `send_error`, so `send_error == null &&
    // isStalledSend(...)` was never reached and dropping either half of it cost nothing. This state is
    // no rare shape on a stopped setup — the last send of a job dead-letters, somebody marks the setup
    // complete, and the row that reads `sent` with no error and no delivery is the ONLY trace that a
    // client was promised a report they were never going to receive.
    const { reportId } = await undeliveredThenStopped("completed", { sendError: null });
    await ageSend(reportId, STALLED_MINUTES);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.sendRetryReportId === reportId);
    expect(row).toBeDefined();
    expect(row!.sendStalled).toBe(true);
    expect(row!.sendFailed).toBe(false);
    expect(row!.sendPending).toBe(false);
    expect(row!.waitingOn).toBe("Adam Sherwood");
  });

  it("still calls a stopped setup's freshly queued send in flight rather than stuck", async () => {
    // `sendPending` on this pass, pinned. Hard-wiring it false was free before: the correction a PM sends
    // in the same hour the job is marked complete would then never say "Sending…" on the board at all,
    // and the row would sit with no verdict of any kind while the delivery was simply on its way.
    const { reportId } = await undeliveredThenStopped("completed", { sendError: null });
    await ageSend(reportId, IN_FLIGHT_MINUTES);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.sendRetryReportId === reportId);
    expect(row).toBeDefined();
    expect(row!.sendPending).toBe(true);
    expect(row!.sendStalled).toBe(false);
    expect(row!.sendFailed).toBe(false);
  });

  it("never reports a stopped setup's FAILED send as stuck as well, however old it is", async () => {
    // The `send_error == null` conjunct on THIS pass. The cadence loop's copy is pinned separately, and
    // that test does not cover this one — but the conjunct matters more here, because on a setup that has
    // stopped reporting an old failed send is the typical row rather than the exotic one. Without it both
    // verdicts read true and the deferred T-Rock Cam surface, which reads `sendStalled` directly and is
    // the whole reason these verdicts are derived server-side, renders "Send stuck" — no error shown,
    // nobody to chase — for a delivery that recorded exactly why it failed.
    //
    // Aged on BOTH clocks, so the row really is past the threshold and only the conjunct holds it false.
    const { reportId } = await undeliveredThenStopped("completed");
    await pg.query(
      `UPDATE office_dallas.weekly_reports SET send_last_attempt_at = now() WHERE id = $1::uuid`,
      [reportId],
    );
    await ageDelivery(reportId, STALLED_MINUTES);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.sendRetryReportId === reportId);
    expect(row).toBeDefined();
    expect(row!.sendFailed).toBe(true);
    expect(row!.sendStalled).toBe(false);
    expect(row!.sendPending).toBe(false);
    expect(row!.sendError).toBe("Resend timed out");
  });

  it("tags the stopped setup's current cadence week as current and an older one as backlog", async () => {
    // `isCurrentWeek` on this pass, pinned in BOTH directions. Hard-wiring it false renders every one of
    // these rows with the permanent "backlog" tag the CRM prints for a past week, including the send a PM
    // committed this morning; hard-wiring it true does the reverse and hides a genuinely old failure
    // among this week's work.
    const current = await seedApprovedReport();
    const backlog = await seedApprovedReport({ weekOf: PRIOR_WEEK, projectId: current.projectId });
    for (const reportId of [current.reportId, backlog.reportId]) {
      await sendWeeklyReport(db, {
        reportId,
        office: OFFICE_CONTEXT,
        actor: SENDER,
        payload: { recipients: ["jay@example.com"] },
        shareUrlFor,
      });
      await pg.query(
        `UPDATE office_dallas.weekly_reports SET send_error = 'Resend timed out' WHERE id = $1::uuid`,
        [reportId],
      );
    }
    await pg.query(`UPDATE office_dallas.weekly_report_projects SET status = 'completed' WHERE id = $1::uuid`, [
      current.projectId,
    ]);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const byReport = (reportId: string) => board.rows.find((entry) => entry.sendRetryReportId === reportId);
    // Both weeks are on the board — one stopped setup can owe more than one email.
    expect(byReport(current.reportId)!.weekOf).toBe(WEEK_OF);
    expect(byReport(backlog.reportId)!.weekOf).toBe(PRIOR_WEEK);
    expect(byReport(current.reportId)!.isCurrentWeek).toBe(true);
    expect(byReport(backlog.reportId)!.isCurrentWeek).toBe(false);
  });

  it("counts an undelivered send older than the lookback window instead of dropping it", async () => {
    // `lookbackWeeks` is a documented parameter with a documented contract — weeks beyond the window are
    // COUNTED, not dropped — and this pass escaped both halves of it: it neither bounded its rows nor
    // tallied them, so a narrow window rendered ancient sends that the cadence loop, reading the same
    // board, would have folded into "and N older".
    const project = await seedProject({ cadenceStartDate: "2026-01-01" });
    const januaryWeeks = ["2026-01-08", "2026-01-15", "2026-01-22"];
    for (const weekOf of januaryWeeks) {
      const { reportId } = await seedApprovedReport({ weekOf, projectId: project.id });
      await sendWeeklyReport(db, {
        reportId,
        office: OFFICE_CONTEXT,
        actor: SENDER,
        payload: { recipients: ["jay@example.com"] },
        shareUrlFor,
      });
    }
    await pg.query(`UPDATE office_dallas.weekly_report_projects SET status = 'completed' WHERE id = $1::uuid`, [
      project.id,
    ]);

    const narrow = await getWeeklyReportDashboard(db, { asOf: WEEK_OF, lookbackWeeks: 1 });
    expect(narrow.rows.filter((entry) => entry.weeklyReportProjectId === project.id)).toHaveLength(0);
    expect(narrow.olderOutstandingCounts[project.id]).toBe(3);

    // And a window wide enough to reach January renders them — a BOUND, not an unconditional drop. Both
    // directions, for the same reason the stall fixtures are pinned absolutely: with only the narrow case
    // asserted, a pass that simply never emitted these rows would stay green.
    const wide = await getWeeklyReportDashboard(db, { asOf: WEEK_OF, lookbackWeeks: 40 });
    expect(wide.rows.filter((entry) => entry.weeklyReportProjectId === project.id).map((e) => e.weekOf)).toEqual(
      januaryWeeks,
    );
    expect(wide.olderOutstandingCounts[project.id] ?? 0).toBe(0);

    // The Projects tab counts all three either way — the window is the board's, not the counter's.
    const summary = (await listWeeklyReportProjectSummaries(db, WEEK_OF)).find(
      (entry) => entry.weeklyReportProjectId === project.id,
    )!;
    expect(summary.undeliveredSends).toBe(3);
  });

  it("generates no cadence weeks for it — a stopped project owes no new reports", async () => {
    // The scope widened for undelivered sends ONLY. If the stopped project were simply folded into the
    // cadence loop it would return every week since its start date as outstanding, which is the opposite
    // of what the CRM told whoever stopped it — and a completed setup often has no cadence end date, so
    // the generator would keep producing weeks forever.
    const { projectId } = await seedApprovedReport({ weekOf: PRIOR_WEEK });
    await pg.query(`UPDATE office_dallas.weekly_report_projects SET status = 'paused' WHERE id = $1::uuid`, [
      projectId,
    ]);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    expect(board.rows).toHaveLength(0);
    expect(board.olderOutstandingCounts[projectId] ?? 0).toBe(0);
  });
});

/**
 * THE OTHER HALF OF THE SAME MISMATCH — and the half reachable through the workflow the product itself
 * recommends.
 *
 * Widening the board's project scope to every `wrp.is_active` setup closed the case where the SETUP had
 * stopped. It did not close the case where the setup is still `active` and the CADENCE has stopped
 * generating the week the undelivered send belongs to, because the pass tested `status`. Two ordinary
 * PATCHes get there:
 *
 *   1. A reporting END DATE entered behind the send. `weeklyReportWeekOf` returns the UPCOMING cadence
 *      day, so reports routinely go out days before their `week_of` — sent Monday for Thursday's week.
 *      The delivery fails, the job wraps up, and the PM sets the end date to the Tuesday. That PATCH is
 *      deliberately permitted (`cadence_end_date` is outside `CADENCE_COLUMNS`) and is literally what
 *      `updateWeeklyReportProject`'s 409 tells PMs to do: "Set a reporting end date and create a new
 *      setup instead."
 *   2. A PAUSE spanning the week, then a resume. `isWeeklyReportWeekPaused` excludes that week from the
 *      expected set permanently, and the setup is `active` again.
 *
 * In both, the cadence loop never reaches the week and a `status`-keyed skip sent it nowhere else. No
 * chip, no Retry, and nothing in the "and N older" tally either — that loop iterates the expected weeks,
 * which is precisely what no longer contains this one — while the Projects tab showed a permanent red
 * "1 not delivered". The client never receives their report, and History is the only surface left, which
 * requires already knowing which project to open.
 */
describe("an ACTIVE setup whose undelivered week the cadence has stopped generating", () => {
  async function failedSendOnActiveSetup() {
    const { projectId, reportId } = await seedApprovedReport();
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    await pg.query(
      `UPDATE office_dallas.weekly_reports SET send_error = 'Resend timed out', send_attempts = 3
        WHERE id = $1::uuid`,
      [reportId],
    );
    return { projectId, reportId };
  }

  /** The board's outstanding deliveries, as the "Send failures" card counts them. */
  function retryableRows(board: { rows: Array<{ sendRetryReportId: string | null }> }) {
    return board.rows.filter((entry) => entry.sendRetryReportId != null);
  }

  it("keeps the failed send on the board after a reporting end date is set behind it", async () => {
    const { projectId, reportId } = await failedSendOnActiveSetup();

    // The ordinary PATCH, through the service the route calls — not a hand-written UPDATE. The whole
    // point is that this is permitted and recommended.
    const updated = await updateWeeklyReportProject(
      db,
      projectId,
      { cadenceEndDate: "2026-08-11" },
      OFFICE,
      { actorUserId: DIRECTOR },
    );
    expect(updated.status).toBe("active");
    expect(updated.cadenceEndDate).toBe("2026-08-11");

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.weekOf === WEEK_OF);
    expect(row).toBeDefined();
    expect(row!.sendFailed).toBe(true);
    expect(row!.sendError).toBe("Resend timed out");
    expect(row!.sendAttempts).toBe(3);
    // The Retry the Projects tab's counter implies, pointed at the report that actually needs one.
    expect(row!.sendRetryReportId).toBe(reportId);
    expect(row!.sendRetrySentAt).not.toBeNull();
    expect(row!.waitingOn).toBe("Adam Sherwood");
    // Never late: the cadence has stopped expecting this week, so there is nothing to be late for.
    expect(row!.daysLate).toBe(0);
    expect(row!.isCurrentWeek).toBe(true);

    // One send, one row, one counter — the reconciliation the two surfaces claim to share.
    const summary = (await listWeeklyReportProjectSummaries(db, WEEK_OF))[0]!;
    expect(summary.undeliveredSends).toBe(1);
    expect(retryableRows(board)).toHaveLength(1);
  });

  it("keeps it on the board across a pause that spanned the week, with the setup active again", async () => {
    const { projectId, reportId } = await failedSendOnActiveSetup();

    // Paused before the week, resumed after it — the interval is half-open [from, to), so this week is
    // excluded from the expected set for good, while the setup itself is reporting again.
    await updateWeeklyReportProject(db, projectId, { status: "paused" }, OFFICE, {
      asOf: "2026-08-10",
      actorUserId: DIRECTOR,
    });
    const resumed = await updateWeeklyReportProject(db, projectId, { status: "active" }, OFFICE, {
      asOf: "2026-08-25",
      actorUserId: DIRECTOR,
    });
    expect(resumed.status).toBe("active");

    // The pause really does span the week, and it is the ledger — not `status` — that keeps the week out
    // of the expected set once the project is reporting again.
    const ledger = await pg.query<{ paused_from: string; resumed_on: string }>(
      `SELECT paused_from::text AS paused_from, resumed_on::text AS resumed_on
         FROM office_dallas.weekly_report_pauses WHERE weekly_report_project_id = $1::uuid`,
      [projectId],
    );
    expect(ledger.rows).toEqual([{ paused_from: "2026-08-10", resumed_on: "2026-08-25" }]);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    expect(board.rows.filter((entry) => entry.weekOf === WEEK_OF)).toHaveLength(1);

    const row = board.rows.find((entry) => entry.weekOf === WEEK_OF);
    expect(row).toBeDefined();
    expect(row!.sendFailed).toBe(true);
    expect(row!.sendRetryReportId).toBe(reportId);
    expect(row!.waitingOn).toBe("Adam Sherwood");

    const summary = (await listWeeklyReportProjectSummaries(db, WEEK_OF))[0]!;
    expect(summary.undeliveredSends).toBe(1);
    expect(retryableRows(board)).toHaveLength(1);
  });

  it("still emits exactly one row for a week the cadence DOES generate", async () => {
    // The skip is keyed on the week, not on the project, so it has to keep holding for the weeks the
    // cadence loop did decide — including on a project that also owns a week it did not. Emitting one
    // twice doubles the "Send failures" card, which counts rows.
    const { projectId, reportId } = await failedSendOnActiveSetup();
    const stray = await seedApprovedReport({ weekOf: PRIOR_WEEK, projectId });
    await sendWeeklyReport(db, {
      reportId: stray.reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    await updateWeeklyReportProject(db, projectId, { cadenceEndDate: "2026-08-11" }, OFFICE, {
      actorUserId: DIRECTOR,
    });

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    // PRIOR_WEEK is still inside the cadence (end date 08-11) and its send is undelivered, so the cadence
    // loop emits it; WEEK_OF fell outside and comes from the second pass. One row each.
    expect(board.rows.filter((entry) => entry.weekOf === PRIOR_WEEK)).toHaveLength(1);
    expect(board.rows.filter((entry) => entry.weekOf === WEEK_OF)).toHaveLength(1);
    expect(retryableRows(board).map((entry) => entry.sendRetryReportId).sort()).toEqual(
      [stray.reportId, reportId].sort(),
    );
    expect((await listWeeklyReportProjectSummaries(db, WEEK_OF))[0]!.undeliveredSends).toBe(2);
  });

  it("leaves a DELIVERED week the cadence dropped filed away, rather than resurrecting it", async () => {
    // The bound in the other direction. The pass is for sends that never got out; a week that reached the
    // client and then fell out of the cadence must stay off the board, or every completed project would
    // grow a permanent row for its final report.
    const { projectId, reportId } = await failedSendOnActiveSetup();
    await markDelivered(reportId);
    await updateWeeklyReportProject(db, projectId, { cadenceEndDate: "2026-08-11" }, OFFICE, {
      actorUserId: DIRECTOR,
    });

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    expect(board.rows.some((entry) => entry.weekOf === WEEK_OF)).toBe(false);
    expect(board.olderOutstandingCounts[projectId] ?? 0).toBe(0);
  });
});

describe("the report detail a client-facing surface reads", () => {
  it("carries the delivery facts the chip is built from", async () => {
    const { reportId } = await seedApprovedReport();
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    const detail = await getWeeklyReportDetail(db, reportId);
    expect(detail!.sentAt).not.toBeNull();
    expect(detail!.sendDeliveredAt).toBeNull();
    expect(detail!.sendAttempts).toBe(0);
    expect(detail!.sendError).toBeNull();
  });
});
