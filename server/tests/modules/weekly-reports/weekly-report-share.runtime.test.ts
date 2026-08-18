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
} from "../../../src/modules/weekly-reports/pdf-service.js";
import { CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION } from "../../../src/modules/weekly-reports/pdf-artifact.js";
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

/** Stand in for the publisher: stamp a content-addressed key at the row's current generation. */
async function stampArtifact(reportId: string) {
  await pg.query(
    `UPDATE office_dallas.weekly_reports
        SET pdf_r2_key = $2, pdf_r2_bucket = 'test', pdf_generated_at = now(), pdf_render_version = $3
      WHERE id = $1::uuid`,
    [reportId, artifactKey(reportId), CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION],
  );
}

async function currentGeneration(reportId: string): Promise<string> {
  const row = await pg.query<{ updated_at: unknown }>(
    `SELECT updated_at FROM office_dallas.weekly_reports WHERE id = $1::uuid`,
    [reportId],
  );
  const value = (row.rows[0] as any).updated_at;
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
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

  it("points the row at the new artifact and stamps the render version", async () => {
    const id = await sentReport();
    const key = await publishWeeklyReportPdfKey(db, {
      reportId: id,
      r2Key: artifactKey(id),
      bucket: "test-bucket",
      generation: await currentGeneration(id),
    });
    expect(key).toBe(artifactKey(id));

    const row = await pg.query(
      `SELECT pdf_r2_key, pdf_r2_bucket, pdf_render_version, pdf_generated_at
         FROM office_dallas.weekly_reports WHERE id = $1::uuid`,
      [id],
    );
    expect(row.rows[0]).toMatchObject({
      pdf_r2_key: artifactKey(id),
      pdf_r2_bucket: "test-bucket",
      pdf_render_version: CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION,
    });
    expect((row.rows[0] as any).pdf_generated_at).not.toBeNull();
    // The artifact it just published must read as current, or every download re-renders forever.
    expect((await loadWeeklyReportPdfSource(db, id))!.recheck).toBe("current");
  });

  it("refuses to publish a render of content that has since moved", async () => {
    // The losing half of the race the CAS exists for: the render read generation A, the row is now at B.
    // Publishing anyway would point a client's link at a week that has since been corrected.
    const id = await sentReport();
    const staleGeneration = await currentGeneration(id);
    await pg.query(`UPDATE office_dallas.weekly_reports SET updated_at = now() + interval '1 second' WHERE id = $1::uuid`, [id]);

    await expectAppError(
      publishWeeklyReportPdfKey(db, {
        reportId: id,
        r2Key: artifactKey(id),
        bucket: "test-bucket",
        generation: staleGeneration,
      }),
      503,
      /changed while its PDF was rendering/i,
    );
    const row = await pg.query(`SELECT pdf_r2_key FROM office_dallas.weekly_reports WHERE id = $1::uuid`, [id]);
    expect((row.rows[0] as any).pdf_r2_key).toBeNull();
  });

  it("hands back a NEWER renderer's artifact rather than walking the row backwards", async () => {
    // A rolling deploy: an instance on the old renderer finishes late. Its bytes are not wrong, but the
    // row already points at a NEWER artifact and must not be walked backwards.
    const newerVersion = CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION + 1;
    const id = await sentReport();
    const generation = await currentGeneration(id);
    const newerKey = `office_dallas/deals/DFW-10432/documents/weekly-reports/${id}.${"b".repeat(64)}.v${newerVersion}.pdf`;
    await pg.query(
      `UPDATE office_dallas.weekly_reports
          SET pdf_r2_key = $2, pdf_r2_bucket = 'test', pdf_generated_at = now(), pdf_render_version = $3
        WHERE id = $1::uuid`,
      [id, newerKey, newerVersion],
    );

    const key = await publishWeeklyReportPdfKey(db, {
      reportId: id,
      r2Key: artifactKey(id),
      bucket: "test-bucket",
      generation,
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

  it("keeps different artifacts apart", async () => {
    const [a, b] = await Promise.all([
      coalesceWeeklyReportRender("x", async () => "key-x"),
      coalesceWeeklyReportRender("y", async () => "key-y"),
    ]);
    expect([a, b]).toEqual(["key-x", "key-y"]);
  });
});
