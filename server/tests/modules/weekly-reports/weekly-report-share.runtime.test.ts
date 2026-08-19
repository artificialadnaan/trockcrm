// Runtime suite for the weekly report's PDF source and its durable client link.
//
// The schema is migration 0222 READ FROM DISK, DO-loop and `public.weekly_report_tokens` included, rather
// than a hand-copied CREATE TABLE. That matters here specifically: the token table's expiry/revocation
// columns and the reports table's pdf_* columns are what the two features under test are made of, and a
// hand copy would let this suite keep passing against a shape the migration no longer creates.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deals, files, offices, userOfficeAccess, users } from "@trock-crm/shared/schema";
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
  replaceWeeklyReportPhotos,
  transitionWeeklyReport,
  updateWeeklyReportContent,
} from "../../../src/modules/weekly-reports/reports-service.js";
import {
  coalesceWeeklyReportRender,
  loadWeeklyReportPdfSource,
  publishWeeklyReportPdfKey,
  weeklyReportRenderCoalescerKey,
} from "../../../src/modules/weekly-reports/pdf-service.js";
import {
  CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION,
  weeklyReportContentGeneration,
  weeklyReportGenerationSql,
} from "../../../src/modules/weekly-reports/pdf-artifact.js";
import {
  hashWeeklyReportToken,
  isWeeklyReportTokenShape,
  listWeeklyReportTokens,
  mintWeeklyReportToken,
  resolveWeeklyReportToken,
  revokeWeeklyReportToken,
  WEEKLY_REPORT_TOKEN_TTL_DAYS,
} from "../../../src/modules/weekly-reports/tokens-service.js";
import { renderWeeklyReportPdf } from "../../../src/modules/weekly-reports/pdf.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const OFFICE = U("00001");
const OTHER_OFFICE = U("00002");
const DEAL = U("11111");
const OTHER_DEAL = U("11112");
const PM = U("22221");
const SUPER = U("22222");
const DIRECTOR = U("22223");
const WON_STAGE = U("33331");

const PM_ACTOR = { id: PM, role: "construction" };
const SUPER_ACTOR = { id: SUPER, role: "construction" };

const THURSDAY = 4;
const WEEK_OF = "2026-08-13";

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
  await pg.exec(tenantSchemaSql("office_dallas", [deals, files]));
  await pg.exec(`CREATE TABLE IF NOT EXISTS public.pipeline_stage_config (id uuid PRIMARY KEY, slug text);`);
  await pg.exec(migrationSql("0222_weekly_reports"));
  // 0223 too. Nothing in the PDF path reads weekly_report_pauses today, but the cadence helpers
  // these suites reach through do, and two sibling suites already failed exactly this way.
  await pg.exec(migrationSql("0223_weekly_report_pauses"));
  // 0224 adds weekly_reports.pdf_content_generation, which the artifact classifier and the publication CAS
  // both read. Without it every PDF assertion below fails on a missing column rather than on its subject.
  await pg.exec(migrationSql("0224_weekly_reports_pdf_content_generation"));
  // 0226 too, for the same reason and with more teeth: it ADDS COLUMNS to weekly_reports, and every
  // dashboard read selects them. A suite that stops at 0223 fails with "column send_delivered_at does
  // not exist" — or worse, would swallow it inside an office-level handler and skip the office.
  await pg.exec(migrationSql("0226_weekly_report_send"));
  // And 0227, which adds the DELIVERY VERDICT columns. Same reason again: `getWeeklyReportDashboard`
  // selects `send_delivery_status`, and `priorVersionReachedClient` binds it — a suite that stops at 0226
  // fails on a missing column rather than on its subject.
  await pg.exec(migrationSql("0227_weekly_report_delivery_events"));

  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES
      ('${OFFICE}', 'Dallas', 'dallas'),
      ('${OTHER_OFFICE}', 'Atlanta', 'atlanta');
    INSERT INTO public.users (id, display_name, email, role, office_id) VALUES
      ('${PM}', 'Adam Sherwood', 'pm@example.com', 'construction', '${OFFICE}'),
      ('${SUPER}', 'Steve Sanchez', 'super@example.com', 'construction', '${OFFICE}'),
      ('${DIRECTOR}', 'Takashi', 'director@example.com', 'director', '${OFFICE}');
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
    DELETE FROM public.weekly_report_tokens;
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
      clientTeam: { doc: { name: "Jay Stauble", email: "jay@example.com" } },
      trockPmUserId: PM,
      trockSuperUserId: SUPER,
      contractDate: "2026-07-08",
      projectStartDateNote: "TBD Permit",
      projectedDurationWeeks: 19,
      cadenceWeekday: THURSDAY,
      cadenceStartDate: "2026-07-27",
      ...overrides,
    } as any,
    DIRECTOR,
    OFFICE,
  );
}

let photoSeq = 0;
async function seedPhoto(description: string | null = null) {
  photoSeq += 1;
  const id = U(`9${String(photoSeq).padStart(4, "0")}`);
  const filename = `photo-${photoSeq}.jpg`;
  await pg.query(
    `INSERT INTO office_dallas.files (
       id, category, display_name, system_filename, original_filename, mime_type,
       file_size_bytes, file_extension, r2_key, r2_bucket, uploaded_by, deal_id, description, taken_at
     ) VALUES ($1::uuid, 'photo', $2, $2, $2, 'image/jpeg', 1024, 'jpg', $3, 'test-bucket', $4::uuid,
              $5::uuid, $6, '2026-08-11T15:00:00Z')`,
    [id, filename, `k/${filename}`, SUPER, DEAL, description],
  );
  return id;
}

async function seedDraft(projectId: string, submissionId = U("cccc1")) {
  const { report } = await createWeeklyReportDraft(
    db,
    { clientSubmissionId: submissionId, weeklyReportProjectId: projectId, weekOf: WEEK_OF },
    SUPER_ACTOR,
  );
  await updateWeeklyReportContent(
    db,
    report.id,
    {
      workCompleted: "- Material delivered for balcony mock up",
      nextWeekLookAhead: "- Complete sample balcony coat",
      issuesConcerns: "Permit risk",
      completionPercent: 12.5,
      weatherDelayDays: 2,
    },
    SUPER_ACTOR,
  );
  return report.id;
}

async function sendReport(reportId: string) {
  await transitionWeeklyReport(db, reportId, "pending_review", SUPER_ACTOR);
  await transitionWeeklyReport(db, reportId, "approved", PM_ACTOR);
  await transitionWeeklyReport(db, reportId, "sent", PM_ACTOR);
}

const ARTIFACT_DIGEST = "a".repeat(64);
// Derived from the render version rather than written out, so a renderer bump does not leave this suite
// asserting against a key shape the publisher no longer emits.
const artifactKey = (reportId: string) =>
  `office_dallas/deals/DFW-10432/documents/weekly-reports/${reportId}.${ARTIFACT_DIGEST}.v${CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION}.pdf`;

/**
 * Stand in for the publisher: stamp a content-addressed key recording the generation it rendered.
 *
 * `pdf_content_generation` is set from the report's OWN widened generation, exactly as the real publisher
 * sets it — deliberately not `now()`. A clock reading here would make this helper reproduce the bug the
 * publisher was changed to remove, and the staleness cases below would then pass on a lie.
 */
async function stampArtifact(reportId: string) {
  const source = await loadWeeklyReportPdfSource(db, reportId);
  await pg.query(
    `UPDATE office_dallas.weekly_reports
        SET pdf_r2_key = $2, pdf_r2_bucket = 'test', pdf_generated_at = now(),
            pdf_content_generation = $4::timestamptz, pdf_render_version = $3
      WHERE id = $1::uuid`,
    [
      reportId,
      artifactKey(reportId),
      CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION,
      generationOf(weeklyReportContentGeneration(source!.state)),
    ],
  );
}

/**
 * The canonical generation text, or the epoch when there is none.
 *
 * Deliberately NOT `new Date(value).toISOString()`. That is the bug this suite has to be able to see: a JS
 * Date holds milliseconds, `timestamptz` holds microseconds, and rounding here would hand the publisher a
 * generation half a millisecond away from the one the row actually carries — so the CAS would compare a
 * value against a rounded copy of itself and every sub-millisecond case below would pass on a lie.
 */
function generationOf(value: string | null): string {
  return value ?? "1970-01-01T00:00:00.000000Z";
}

/** `weekly_reports.updated_at` at the resolution Postgres stores it, exactly as the loader reads it. */
async function currentGeneration(reportId: string): Promise<string> {
  const row = await pg.query<{ generation: string }>(
    `SELECT ${weeklyReportGenerationSql("updated_at")} AS generation
       FROM office_dallas.weekly_reports WHERE id = $1::uuid`,
    [reportId],
  );
  return (row.rows[0] as any).generation;
}

/** `pdf_content_generation` read back at full resolution — what the publisher claims the bytes cover. */
async function storedRenderedGeneration(reportId: string): Promise<string | null> {
  const row = await pg.query<{ generation: string | null }>(
    `SELECT ${weeklyReportGenerationSql("pdf_content_generation")} AS generation
       FROM office_dallas.weekly_reports WHERE id = $1::uuid`,
    [reportId],
  );
  return (row.rows[0] as any).generation ?? null;
}

/** The widened generation the render would have read — what the publisher records as rendered. */
async function currentContentGeneration(reportId: string): Promise<string> {
  const source = await loadWeeklyReportPdfSource(db, reportId);
  return generationOf(weeklyReportContentGeneration(source!.state));
}

async function mint(reportId: string, ttlDays?: number) {
  return mintWeeklyReportToken(db, {
    weeklyReportId: reportId,
    tenantId: OFFICE,
    officeSlug: "dallas",
    createdByUserId: PM,
    ttlDays,
  });
}

describe("the client link", () => {
  it("stores only a HASH — a database read cannot reconstruct a live link", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const { rawToken, token } = await mint(id);

    const stored = await pg.query<{ token: string }>(
      `SELECT token FROM public.weekly_report_tokens WHERE id = $1::uuid`,
      [token.id],
    );
    expect(stored.rows[0]!.token).toBe(hashWeeklyReportToken(rawToken));
    expect(stored.rows[0]!.token).not.toBe(rawToken);
    expect(isWeeklyReportTokenShape(rawToken)).toBe(true);
  });

  it("resolves a live token to its report AND its office, which is what the viewer needs first", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const { rawToken } = await mint(id);

    const resolved = await resolveWeeklyReportToken(db, rawToken);
    expect(resolved.status).toBe("active");
    expect(resolved.token).toMatchObject({ weeklyReportId: id, tenantId: OFFICE, officeSlug: "dallas" });
  });

  it("expires 180 days out — never never", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const { token } = await mint(id);
    const days =
      (new Date(token.expiresAt!).getTime() - new Date(token.createdAt).getTime()) / 86_400_000;
    // A link that never expires is a permanent unauthenticated read sitting in an email thread that will
    // outlive the project.
    expect(Math.round(days)).toBe(WEEKLY_REPORT_TOKEN_TTL_DAYS);
  });

  it("reports an EXPIRED token as expired, not as missing", async () => {
    // The distinction the viewer needs: a client whose link aged out gets "here is your PM", where a filter
    // that hid the row would collapse it into the same dead end as a mistyped URL.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const { rawToken } = await mint(id, -1);

    const resolved = await resolveWeeklyReportToken(db, rawToken);
    expect(resolved.status).toBe("expired");
    expect(resolved.token?.weeklyReportId).toBe(id);
  });

  it("reports a REVOKED token as revoked, and still names its report", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const { rawToken, token } = await mint(id);
    await revokeWeeklyReportToken(db, { tokenId: token.id, tenantId: OFFICE, weeklyReportId: id });

    const resolved = await resolveWeeklyReportToken(db, rawToken);
    expect(resolved.status).toBe("revoked");
    expect(resolved.token?.weeklyReportId).toBe(id);
  });

  it("is idempotent on revoke — a second click must not move the timestamp", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const { token } = await mint(id);
    const first = await revokeWeeklyReportToken(db, { tokenId: token.id, tenantId: OFFICE, weeklyReportId: id });
    const second = await revokeWeeklyReportToken(db, { tokenId: token.id, tenantId: OFFICE, weeklyReportId: id });
    expect(second.revokedAt).toBe(first.revokedAt);
  });

  it("refuses to revoke another office's token", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const { token } = await mint(id);
    await expectAppError(
      revokeWeeklyReportToken(db, { tokenId: token.id, tenantId: OTHER_OFFICE, weeklyReportId: id }),
      404,
    );
  });

  it("refuses to revoke a token belonging to a different report", async () => {
    // Scoped inside the UPDATE's own predicate rather than checked afterwards: a check after the write
    // would rely on a rollback to undo a revocation that should never have happened.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const { token } = await mint(id);
    await expectAppError(
      revokeWeeklyReportToken(db, { tokenId: token.id, tenantId: OFFICE, weeklyReportId: U("dead1") }),
      404,
    );
    const still = await resolveWeeklyReportToken(db, (await mint(id)).rawToken);
    expect(still.status).toBe("active");
  });

  it("mints a NEW link each time, so revoking a re-send cannot kill the link in use", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const first = await mint(id);
    const second = await mint(id);
    expect(second.rawToken).not.toBe(first.rawToken);

    await revokeWeeklyReportToken(db, { tokenId: second.token.id, tenantId: OFFICE, weeklyReportId: id });
    expect((await resolveWeeklyReportToken(db, first.rawToken)).status).toBe("active");
    expect((await resolveWeeklyReportToken(db, second.rawToken)).status).toBe("revoked");
  });

  it("answers unknown for a token that never existed", async () => {
    expect(await resolveWeeklyReportToken(db, "z".repeat(43))).toEqual({ status: "unknown", token: null });
  });

  it("rejects a malformed token BEFORE it reaches the database", async () => {
    // /wr/:token is world-reachable, so every path segment anyone types becomes a query unless the shape
    // gate stops it first.
    for (const bad of ["", "short", "../../etc/passwd", "a".repeat(200), "has spaces in it"]) {
      expect(isWeeklyReportTokenShape(bad)).toBe(false);
      expect(await resolveWeeklyReportToken(db, bad)).toEqual({ status: "unknown", token: null });
    }
  });

  it("lists every link ever minted for a report, newest first, and never a raw token", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await mint(id);
    await mint(id);

    const tokens = await listWeeklyReportTokens(db, id, OFFICE);
    expect(tokens).toHaveLength(2);
    expect(tokens.every((token) => token.weeklyReportId === id)).toBe(true);
    expect(JSON.stringify(tokens)).not.toContain("rawToken");
  });

  it("does not list another office's links", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await mint(id);
    expect(await listWeeklyReportTokens(db, id, OTHER_OFFICE)).toEqual([]);
  });
});

describe("the PDF source", () => {
  it("reads the LIVE setup row while the report is still a draft", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);

    const source = await loadWeeklyReportPdfSource(db, id);
    expect(source).not.toBeNull();
    expect(source!.view.fromSnapshot).toBe(false);
    expect(source!.view.pdf.propertyName).toBe("4123 Cedar Springs");
    expect(source!.view.pdf.trockTeam).toEqual([
      { label: "PM", name: "Adam Sherwood" },
      { label: "SUPER", name: "Steve Sanchez" },
    ]);
    expect(source!.dealNumber).toBe("DFW-10432");
  });

  it("renders a SENT report from its own frozen snapshot, ignoring later setup edits", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await sendReport(id);

    // Swap the PM and rename the client AFTER delivery. The client has already read the old header.
    await updateWeeklyReportProject(db, project.id, {
      trockPmUserId: DIRECTOR,
      clientName: "New Owner LLC",
      propertyDisplayName: "Somewhere Else",
    }, OFFICE);

    const source = await loadWeeklyReportPdfSource(db, id);
    expect(source!.view.fromSnapshot).toBe(true);
    expect(source!.view.pdf.clientName).toBe("Mack Real Estate Group");
    expect(source!.view.pdf.propertyName).toBe("4123 Cedar Springs");
    expect(source!.view.pdf.trockTeam[0]).toEqual({ label: "PM", name: "Adam Sherwood" });
  });

  it("carries the photo selection in order, with the report caption and not the capture description", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const a = await seedPhoto("north stair landing, pre-pour");
    const b = await seedPhoto("as captured");
    await replaceWeeklyReportPhotos(
      db,
      id,
      [{ fileId: b, caption: "Balcony mock-up complete" }, { fileId: a }],
      SUPER_ACTOR,
    );

    const source = await loadWeeklyReportPdfSource(db, id);
    expect(source!.view.pdf.photos.map((photo) => photo.fileId)).toEqual([b, a]);
    expect(source!.view.pdf.photos[0]!.caption).toBe("Balcony mock-up complete");
    // An unset caption prints nothing rather than leaking the crew's on-site note onto a client document.
    expect(source!.view.pdf.photos[1]!.caption).toBeNull();
    expect(source!.view.pdf.photos[0]!.r2Key).toBeTruthy();
  });

  it("drops a soft-deleted photo instead of rendering a hole", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const photo = await seedPhoto();
    await replaceWeeklyReportPhotos(db, id, [{ fileId: photo }], SUPER_ACTOR);
    await pg.query(`UPDATE office_dallas.files SET deleted_at = now() WHERE id = $1::uuid`, [photo]);

    const source = await loadWeeklyReportPdfSource(db, id);
    expect(source!.view.pdf.photos).toEqual([]);
  });

  it("classifies a never-rendered report as stale", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    const source = await loadWeeklyReportPdfSource(db, id);
    expect(source!.state.pdfR2Key).toBeNull();
    expect(source!.recheck).toBe("stale");
  });

  it("classifies a stored artifact as current, then STALE again after a content edit", async () => {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await sendReport(id);
    await stampArtifact(id);
    expect((await loadWeeklyReportPdfSource(db, id))!.recheck).toBe("current");

    // A sent report refuses content edits, so move updated_at the way any future writer would.
    await pg.query(`UPDATE office_dallas.weekly_reports SET updated_at = now() + interval '1 second' WHERE id = $1::uuid`, [id]);
    // A content-addressed key stays valid-LOOKING forever, which is exactly why the generation is compared.
    expect((await loadWeeklyReportPdfSource(db, id))!.recheck).toBe("stale");
  });

  it("returns null for a report that does not exist", async () => {
    expect(await loadWeeklyReportPdfSource(db, U("dead1"))).toBeNull();
  });

  it("reads a generation with every digit Postgres stored, and binds it back to the same instant", async () => {
    // The read side of the microsecond fix, EXECUTED rather than asserted against the SQL text. node-postgres
    // parses timestamptz into a millisecond JS Date, so a loader that took the column straight would hand
    // the comparison `.123000` for a row stored at `.123456` — and the publication CAS, which matches this
    // value exactly, would then never match at all.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await sendReport(id);
    await pg.query(
      `UPDATE office_dallas.weekly_reports SET updated_at = '2026-08-14T10:00:00.123456Z'::timestamptz
        WHERE id = $1::uuid`,
      [id],
    );

    const source = await loadWeeklyReportPdfSource(db, id);
    expect(source!.updatedAt).toBe("2026-08-14T10:00:00.123456Z");
    // A sent report is frozen, so its widened generation IS its updated_at — and this is the value the
    // publisher writes and the comparison reads back, so it has to survive the round trip verbatim.
    expect(weeklyReportContentGeneration(source!.state)).toBe("2026-08-14T10:00:00.123456Z");
    const bound = await pg.query(
      `SELECT 1 FROM office_dallas.weekly_reports WHERE id = $1::uuid AND updated_at = $2::timestamptz`,
      [id, source!.updatedAt],
    );
    expect(bound.rows).toHaveLength(1);

    // And it does not change with the session TimeZone. The offset is pinned to Z for exactly this reason:
    // one connection spelling the instant `+00` and another `-05` would make the CAS compare a value
    // against a differently-written copy of itself.
    try {
      await pg.exec(`SET TIME ZONE 'America/Chicago';`);
      expect((await loadWeeklyReportPdfSource(db, id))!.updatedAt).toBe("2026-08-14T10:00:00.123456Z");
    } finally {
      await pg.exec(`SET TIME ZONE 'UTC';`);
    }
  });

  it("caches an APPROVED report's artifact, and drops it when the LIVE header moves", async () => {
    // Before send the header block is read live from weekly_report_projects and public.users, and neither
    // touches weekly_reports.updated_at. An earlier revision answered that by never caching an unfrozen
    // report at all — which made every anonymous request on the client's link re-render and re-upload,
    // forever. The answer is to compare against those rows' generations too.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "approved", PM_ACTOR);
    await stampArtifact(id);
    expect((await loadWeeklyReportPdfSource(db, id))!.recheck).toBe("current");

    // Rename the property on the setup row. weekly_reports.updated_at does not move; the PDF must still go.
    await pg.query(
      `UPDATE office_dallas.weekly_report_projects
          SET property_display_name = 'Renamed', updated_at = now() + interval '1 second'
        WHERE id = $1::uuid`,
      [project.id],
    );
    expect((await loadWeeklyReportPdfSource(db, id))!.recheck).toBe("stale");

    // Once sent the render comes from the report's own snapshot, so a later header edit stops counting —
    // a PM swapped in September must not rewrite the PDF a client was emailed in August.
    await stampArtifact(id);
    await transitionWeeklyReport(db, id, "sent", PM_ACTOR);
    await stampArtifact(id);
    await pg.query(
      `UPDATE office_dallas.weekly_report_projects
          SET property_display_name = 'Renamed again', updated_at = now() + interval '1 hour'
        WHERE id = $1::uuid`,
      [project.id],
    );
    expect((await loadWeeklyReportPdfSource(db, id))!.recheck).toBe("current");
  });

  it("renders the loaded source to a real PDF", async () => {
    // End to end, minus storage: the photo has an r2_key but R2 is unconfigured in tests, so the tile draws
    // the placeholder rather than reaching the network. The page structure is the thing being proved.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await replaceWeeklyReportPhotos(db, id, [{ fileId: await seedPhoto(), caption: "On site" }], SUPER_ACTOR);
    await sendReport(id);

    const source = await loadWeeklyReportPdfSource(db, id);
    const pdf = await renderWeeklyReportPdf(source!.view.pdf);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.toString("latin1").match(/\/Count (\d+)/)?.[1]).toBe("2");
  });
});

describe("publishing an artifact", () => {
  async function sentReport() {
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await sendReport(id);
    return id;
  }

  it("points the row at the new artifact and records the generation it rendered", async () => {
    const id = await sentReport();
    const contentGeneration = await currentContentGeneration(id);
    const key = await publishWeeklyReportPdfKey(db, {
      reportId: id,
      r2Key: artifactKey(id),
      bucket: "test-bucket",
      generation: await currentGeneration(id),
      contentGeneration,
    });
    expect(key).toBe(artifactKey(id));

    const row = await pg.query(
      `SELECT pdf_r2_key, pdf_r2_bucket, pdf_render_version, pdf_generated_at, pdf_content_generation
         FROM office_dallas.weekly_reports WHERE id = $1::uuid`,
      [id],
    );
    expect(row.rows[0]).toMatchObject({
      pdf_r2_key: artifactKey(id),
      pdf_r2_bucket: "test-bucket",
      pdf_render_version: CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION,
    });
    expect((row.rows[0] as any).pdf_generated_at).not.toBeNull();
    // The GENERATION IT WAS GIVEN, verbatim — never now(). This is the assertion that keeps the publisher
    // honest: a wall-clock stamp taken after a render swallows everything that moved while it ran, and the
    // artifact then reads current forever. Read back at full resolution, so a publisher that rounded on the
    // way in could not pass by rounding again on the way out.
    expect(await storedRenderedGeneration(id)).toBe(contentGeneration);
    // The artifact it just published must read as current, or every download re-renders forever.
    expect((await loadWeeklyReportPdfSource(db, id))!.recheck).toBe("current");
  });

  it("refuses to publish a render of content that has since moved", async () => {
    // The losing half of the race the CAS exists for: the render read generation A, the row is now at B.
    // Publishing anyway would point a client's link at a week that has since been corrected.
    const id = await sentReport();
    const staleGeneration = await currentGeneration(id);
    const staleContentGeneration = await currentContentGeneration(id);
    await pg.query(`UPDATE office_dallas.weekly_reports SET updated_at = now() + interval '1 second' WHERE id = $1::uuid`, [id]);

    await expectAppError(
      publishWeeklyReportPdfKey(db, {
        reportId: id,
        r2Key: artifactKey(id),
        bucket: "test-bucket",
        generation: staleGeneration,
        contentGeneration: staleContentGeneration,
      }),
      503,
      /changed while its PDF was rendering/i,
    );
    const row = await pg.query(`SELECT pdf_r2_key FROM office_dallas.weekly_reports WHERE id = $1::uuid`, [id]);
    expect((row.rows[0] as any).pdf_r2_key).toBeNull();
  });

  it("refuses to let an OLDER render overwrite a newer one when only a LIVE input moved", async () => {
    // Last-writer-wins, and precisely the half a report-row CAS cannot see. Two renders of different
    // content take different coalescer entries and produce different content-addressed keys, so the only
    // thing between them is the publication CAS — and before an approved report is sent, its header is read
    // live from weekly_report_projects, which moves NOTHING on weekly_reports. So the slower render, started
    // first and finishing second, passed a CAS conditioned on updated_at alone, pointed the row at the
    // property name the client no longer has, and then read as current because it also stamped the clock.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await transitionWeeklyReport(db, id, "pending_review", SUPER_ACTOR);
    await transitionWeeklyReport(db, id, "approved", PM_ACTOR);

    const olderGeneration = await currentGeneration(id);
    const olderContentGeneration = await currentContentGeneration(id);

    // The live header moves. `updated_at` on the report is untouched by this — that is the whole point.
    await updateWeeklyReportProject(db, project.id, { propertyDisplayName: "4123 Cedar Springs — Phase II" }, OFFICE);
    expect(await currentGeneration(id)).toBe(olderGeneration);
    expect(await currentContentGeneration(id)).not.toBe(olderContentGeneration);

    // The newer render lands first, recording what it read.
    const newerKey = `office_dallas/deals/DFW-10432/documents/weekly-reports/${id}.${"c".repeat(64)}.v${CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION}.pdf`;
    const newerContentGeneration = await currentContentGeneration(id);
    await publishWeeklyReportPdfKey(db, {
      reportId: id,
      r2Key: newerKey,
      bucket: "test-bucket",
      generation: await currentGeneration(id),
      contentGeneration: newerContentGeneration,
    });

    // …and now the older one finishes. Its updated_at still matches, so only the recorded generation stops
    // it. It is handed the newer artifact — which is current and safe to serve — instead of its own.
    const key = await publishWeeklyReportPdfKey(db, {
      reportId: id,
      r2Key: artifactKey(id),
      bucket: "test-bucket",
      generation: olderGeneration,
      contentGeneration: olderContentGeneration,
    });
    expect(key).toBe(newerKey);

    const row = await pg.query(
      `SELECT pdf_r2_key FROM office_dallas.weekly_reports WHERE id = $1::uuid`,
      [id],
    );
    // The NEWER artifact still owns the row, and the recorded generation was not walked backwards either.
    expect((row.rows[0] as any).pdf_r2_key).toBe(newerKey);
    expect(await storedRenderedGeneration(id)).toBe(newerContentGeneration);
    expect((await loadWeeklyReportPdfSource(db, id))!.recheck).toBe("current");
  });

  it("refuses a publish whose read of updated_at was rounded to the millisecond", async () => {
    // How the defect actually presented. The render was handed `updated_at` as a millisecond JS Date, and
    // the CAS truncated the column to milliseconds so the two matched ANYWAY — a report edited 900µs after
    // the render read it therefore passed a CAS whose entire job is to catch that, and the row was pointed
    // at a PDF of the previous content. Worse, the same rounded value went into pdf_content_generation, so
    // the artifact then read CURRENT forever: a sent report never moves updated_at again.
    const id = await sentReport();
    await pg.query(
      `UPDATE office_dallas.weekly_reports SET updated_at = '2026-08-14T10:00:00.123900Z'::timestamptz
        WHERE id = $1::uuid`,
      [id],
    );

    await expectAppError(
      publishWeeklyReportPdfKey(db, {
        reportId: id,
        r2Key: artifactKey(id),
        bucket: "test-bucket",
        generation: "2026-08-14T10:00:00.123Z",
        contentGeneration: "2026-08-14T10:00:00.123Z",
      }),
      503,
      /changed while its PDF was rendering/i,
    );
    const row = await pg.query(`SELECT pdf_r2_key FROM office_dallas.weekly_reports WHERE id = $1::uuid`, [id]);
    expect((row.rows[0] as any).pdf_r2_key).toBeNull();
  });

  it("refuses an older render whose recorded generation is less than a millisecond behind", async () => {
    // The other CAS clause, at the same resolution. Two renders of different content produce different keys
    // and take different coalescer entries, so `pdf_content_generation <= ours` is all that orders them —
    // and truncating BOTH sides to milliseconds made a render 500µs older compare as "not older", so the
    // slower one won. The report row is pinned older than either, so the loser is handed the winner's key
    // rather than a stale verdict.
    const id = await sentReport();
    await pg.query(
      `UPDATE office_dallas.weekly_reports SET updated_at = '2026-08-14T10:00:00.123000Z'::timestamptz
        WHERE id = $1::uuid`,
      [id],
    );
    const generation = "2026-08-14T10:00:00.123000Z";
    const newerKey = `office_dallas/deals/DFW-10432/documents/weekly-reports/${id}.${"d".repeat(64)}.v${CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION}.pdf`;

    await publishWeeklyReportPdfKey(db, {
      reportId: id,
      r2Key: newerKey,
      bucket: "test-bucket",
      generation,
      contentGeneration: "2026-08-14T10:00:00.123900Z",
    });

    const key = await publishWeeklyReportPdfKey(db, {
      reportId: id,
      r2Key: artifactKey(id),
      bucket: "test-bucket",
      generation,
      contentGeneration: "2026-08-14T10:00:00.123400Z",
    });
    expect(key).toBe(newerKey);
    expect(await storedRenderedGeneration(id)).toBe("2026-08-14T10:00:00.123900Z");
  });

  it("hands back a NEWER renderer's artifact rather than walking the row backwards", async () => {
    // A rolling deploy: an instance on the old renderer finishes late. Its bytes are not wrong, but the
    // row already points at a NEWER artifact and must not be walked backwards.
    const newerVersion = CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION + 1;
    const id = await sentReport();
    const generation = await currentGeneration(id);
    const contentGeneration = await currentContentGeneration(id);
    const newerKey = `office_dallas/deals/DFW-10432/documents/weekly-reports/${id}.${"b".repeat(64)}.v${newerVersion}.pdf`;
    await pg.query(
      `UPDATE office_dallas.weekly_reports
          SET pdf_r2_key = $2, pdf_r2_bucket = 'test', pdf_generated_at = now(),
              pdf_content_generation = $4::timestamptz, pdf_render_version = $3
        WHERE id = $1::uuid`,
      [id, newerKey, newerVersion, contentGeneration],
    );

    const key = await publishWeeklyReportPdfKey(db, {
      reportId: id,
      r2Key: artifactKey(id),
      bucket: "test-bucket",
      generation,
      contentGeneration,
    });
    expect(key).toBe(newerKey);
    const row = await pg.query(`SELECT pdf_render_version FROM office_dallas.weekly_reports WHERE id = $1::uuid`, [id]);
    expect((row.rows[0] as any).pdf_render_version).toBe(newerVersion);
  });

  it("404s a report that vanished during the render", async () => {
    await expectAppError(
      publishWeeklyReportPdfKey(db, {
        reportId: U("dead1"),
        r2Key: artifactKey(U("dead1")),
        bucket: "test-bucket",
        generation: new Date().toISOString(),
        contentGeneration: new Date().toISOString(),
      }),
      404,
    );
  });
});

describe("the render coalescer", () => {
  it("collapses concurrent requests for the same artifact into ONE render", async () => {
    // Without it, an unauthenticated /wr/:token/pdf pays a full render — every photo downloaded and
    // transcoded — per request rather than per artifact.
    let renders = 0;
    const factory = async () => {
      renders += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "key-1";
    };
    const [a, b, c] = await Promise.all([
      coalesceWeeklyReportRender("k", factory),
      coalesceWeeklyReportRender("k", factory),
      coalesceWeeklyReportRender("k", factory),
    ]);
    expect([a, b, c]).toEqual(["key-1", "key-1", "key-1"]);
    expect(renders).toBe(1);
  });

  it("does not cache a FAILURE, or one bad render would break every later download", async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new Error("R2 unavailable");
      return "key-2";
    };
    await expect(coalesceWeeklyReportRender("k2", flaky)).rejects.toThrow(/R2 unavailable/);
    await expect(coalesceWeeklyReportRender("k2", flaky)).resolves.toBe("key-2");
  });

  it("keys two generations less than a millisecond apart APART", async () => {
    // The third place a content generation is used, and the only one with no database behind it to catch a
    // mistake. A generation rounded to the millisecond made a report and the edit that followed it 500µs
    // later produce the SAME key — so the request that arrived after the edit joined the render that
    // preceded it and was handed a key for the previous document, with nothing anywhere recording that it
    // had happened.
    const project = await seedProject();
    const id = await seedDraft(project.id);
    await sendReport(id);
    await pg.query(
      `UPDATE office_dallas.weekly_reports SET updated_at = '2026-08-14T10:00:00.123400Z'::timestamptz
        WHERE id = $1::uuid`,
      [id],
    );
    const before = weeklyReportRenderCoalescerKey("dallas", (await loadWeeklyReportPdfSource(db, id))!);

    await pg.query(
      `UPDATE office_dallas.weekly_reports SET updated_at = '2026-08-14T10:00:00.123900Z'::timestamptz
        WHERE id = $1::uuid`,
      [id],
    );
    const after = weeklyReportRenderCoalescerKey("dallas", (await loadWeeklyReportPdfSource(db, id))!);

    expect(before).not.toBe(after);
    // And it is the GENERATION that differs, not some other segment drifting — the key is the artifact's
    // identity, so a change here has to be a change to what the render would produce.
    expect(before).toContain("2026-08-14T10:00:00.123400Z");
    expect(after).toContain("2026-08-14T10:00:00.123900Z");
  });

  it("keeps different artifacts apart", async () => {
    const [a, b] = await Promise.all([
      coalesceWeeklyReportRender("x", async () => "key-x"),
      coalesceWeeklyReportRender("y", async () => "key-y"),
    ]);
    expect([a, b]).toEqual(["key-x", "key-y"]);
  });
});
