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
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import { migrationSql } from "../../helpers/migration-sql.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { AppError } from "../../../src/middleware/error-handler.js";
import { createWeeklyReportProject } from "../../../src/modules/weekly-reports/projects-service.js";
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
import { getWeeklyReportDashboard } from "../../../src/modules/weekly-reports/dashboard-service.js";
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

const OFFICE_CONTEXT = { tenantId: OFFICE, slug: "dallas" };

const THURSDAY = 4;
const WEEK_OF = "2026-08-13";
const PRIOR_WEEK = "2026-08-06";

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
    const draft = await buildWeeklyReportSendDraft(db, reportId, PM_ACTOR);

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
    // Not yet sent, so there is no working link to show — only a token HASH is ever stored.
    expect(draft.shareUrl).toBeNull();
    expect(draft.bodyPreview).toContain("Hello Jay,");
    expect(draft.bodyPreview).toContain("(214) 555-0142");
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
      actor: PM_ACTOR,
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
      actor: PM_ACTOR,
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
        actor: PM_ACTOR,
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
    await sendWeeklyReport(db, { reportId, office: OFFICE_CONTEXT, actor: PM_ACTOR, payload, shareUrlFor });
    await expectAppError(
      sendWeeklyReport(db, { reportId, office: OFFICE_CONTEXT, actor: PM_ACTOR, payload, shareUrlFor }),
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
        actor: PM_ACTOR,
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
        actor: PM_ACTOR,
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
      actor: PM_ACTOR,
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
      actor: PM_ACTOR,
      payload: { recipients: ["someone.else@client.com"] },
      shareUrlFor,
    });
    expect(result.sendRequest.greetingName).toBeNull();
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
      actor: PM_ACTOR,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    return { projectId, reportId, fileId };
  }

  it("clones content and REPORT captions to the next version, ready to send", async () => {
    const { reportId } = await sentReport();
    const correction = await createWeeklyReportCorrection(db, reportId, PM_ACTOR);

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
    await createWeeklyReportCorrection(db, reportId, PM_ACTOR);
    expect((await reportRow(reportId)).superseded_by_id).toBeNull();
  });

  it("supersedes the original on send, and the original link keeps resolving", async () => {
    const { reportId } = await sentReport();
    const originalToken = mintedTokens[0]!;
    const correction = await createWeeklyReportCorrection(db, reportId, PM_ACTOR);
    await sendWeeklyReport(db, {
      reportId: correction.id,
      office: OFFICE_CONTEXT,
      actor: PM_ACTOR,
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
    const correction = await createWeeklyReportCorrection(db, reportId, PM_ACTOR);
    const result = await sendWeeklyReport(db, {
      reportId: correction.id,
      office: OFFICE_CONTEXT,
      actor: PM_ACTOR,
      payload: { recipients: ["jay@example.com"], contextParagraph: "" },
      shareUrlFor,
    });
    expect(result.sendRequest.isCorrection).toBe(true);
  });

  it("gets its OWN delivery key, so the provider does not refuse it as a duplicate", async () => {
    // The retry path deliberately replays the key. If a correction reused it too, the provider would
    // answer "already delivered" and the client would never receive the fix.
    const { reportId } = await sentReport();
    const originalKey = (await reportRow(reportId)).send_delivery_key;
    const correction = await createWeeklyReportCorrection(db, reportId, PM_ACTOR);
    await sendWeeklyReport(db, {
      reportId: correction.id,
      office: OFFICE_CONTEXT,
      actor: PM_ACTOR,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    expect((await reportRow(correction.id)).send_delivery_key).not.toBe(originalKey);
  });

  it("takes the next FREE version rather than assuming source + 1", async () => {
    // Correcting v1 twice: naively `source.version + 1` collides with the live v2 on the week/version
    // unique index and surfaces as a raw 23505.
    const { reportId } = await sentReport();
    const v2 = await createWeeklyReportCorrection(db, reportId, PM_ACTOR);
    const v3 = await createWeeklyReportCorrection(db, reportId, PM_ACTOR);
    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
  });

  it("refuses a correction on a report that was never sent", async () => {
    const { reportId } = await seedApprovedReport();
    await expectAppError(createWeeklyReportCorrection(db, reportId, PM_ACTOR), 409, /edit it instead/i);
  });

  it("is refused to the superintendent", async () => {
    const { reportId } = await sentReport();
    await expectAppError(createWeeklyReportCorrection(db, reportId, SUPER_ACTOR), 403, /project manager/i);
  });

  it("leaves the SENT original immutable — the correction is where edits go", async () => {
    const { reportId } = await sentReport();
    await createWeeklyReportCorrection(db, reportId, PM_ACTOR);
    await expectAppError(
      updateWeeklyReportContent(db, reportId, { workCompleted: "rewritten" }, PM_ACTOR),
      409,
      /cannot be edited/i,
    );
  });
});

describe("retrying a failed send", () => {
  async function failedSend() {
    const { reportId } = await seedApprovedReport();
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: PM_ACTOR,
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

    await retryWeeklyReportSend(db, reportId, PM_ACTOR, OFFICE_CONTEXT);

    const jobs = await sendJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.deliveryKey).toBe(keyBefore);
    expect((await reportRow(reportId)).send_delivery_key).toBe(keyBefore);
  });

  it("clears the error but KEEPS the attempt count", async () => {
    // Zeroing attempts would hide a report that has failed nine times behind a chip reading "attempt 1".
    const reportId = await failedSend();
    const detail = await retryWeeklyReportSend(db, reportId, PM_ACTOR, OFFICE_CONTEXT);
    expect(detail.sendError).toBeNull();
    expect(detail.sendAttempts).toBe(3);
  });

  it("refuses once the client has actually received it", async () => {
    const reportId = await failedSend();
    await pg.query(`UPDATE office_dallas.weekly_reports SET send_delivered_at = now() WHERE id = $1::uuid`, [
      reportId,
    ]);
    await expectAppError(
      retryWeeklyReportSend(db, reportId, PM_ACTOR, OFFICE_CONTEXT),
      409,
      /already reached the client/i,
    );
    expect(await sendJobs()).toHaveLength(0);
  });

  it("refuses on a report that was never sent", async () => {
    const { reportId } = await seedApprovedReport();
    await expectAppError(retryWeeklyReportSend(db, reportId, PM_ACTOR, OFFICE_CONTEXT), 409, /has been sent/i);
  });

  it("is refused to the superintendent", async () => {
    const reportId = await failedSend();
    await expectAppError(
      retryWeeklyReportSend(db, reportId, SUPER_ACTOR, OFFICE_CONTEXT),
      403,
      /project manager/i,
    );
  });
});

describe("the dashboard's view of a send", () => {
  async function sentWeek(weekOf: string) {
    const project = await seedProject();
    const { reportId } = await seedApprovedReport({ weekOf, projectId: project.id });
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: PM_ACTOR,
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
    // send_error is deliberately LEFT as the record of what happened, so a chip keyed on the error alone
    // would keep shouting about a delivery that has since succeeded.
    const reportId = await sentWeek(WEEK_OF);
    await pg.query(
      `UPDATE office_dallas.weekly_reports
          SET send_error = 'Resend timed out', send_delivered_at = now() WHERE id = $1::uuid`,
      [reportId],
    );
    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    expect(board.rows.find((entry) => entry.reportId === reportId)!.sendFailed).toBe(false);
  });

  it("reads the LIVE version of a corrected week, not the superseded original", async () => {
    const reportId = await sentWeek(WEEK_OF);
    const correction = await createWeeklyReportCorrection(db, reportId, PM_ACTOR);
    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.weekOf === WEEK_OF);
    expect(row!.reportId).toBe(correction.id);
    expect(row!.reportVersion).toBe(2);
    expect(row!.state).toBe("approved");
  });
});

describe("the report detail a client-facing surface reads", () => {
  it("carries the delivery facts the chip is built from", async () => {
    const { reportId } = await seedApprovedReport();
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: PM_ACTOR,
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
