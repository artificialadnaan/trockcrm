// End-to-end runtime suite for the CLIENT's link: a real HTTP request, through the real router, against a
// real schema (migration 0222 read from disk), with only the two edges faked — the connection pool, which
// is pointed at PGlite, and R2, which is pointed at an in-memory map.
//
// The unit suites cover the pieces. This one exists because the properties that matter most on this surface
// are properties of the WHOLE path: that a report pulled back for rework stops being served, that a photo
// belonging to another report 404s, that a dead link answers a page rather than a stack trace. Every one of
// those could be broken while every unit test stayed green.

import express from "express";
import request from "supertest";
import sharp from "sharp";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  pg: null as any,
  objects: new Map<string, Buffer>(),
  /** Toggled by the tests that need storage to look unconfigured. */
  r2Configured: true,
  /** Ordered trace of the calls whose ORDER is the property under test. */
  trace: [] as string[],
  /**
   * How many artifacts were UPLOADED, not how many distinct keys survive.
   *
   * Counting keys is not the same assertion and quietly passes on the bug it is meant to catch: two renders
   * of identical content usually produce identical bytes in a quiet process, so a re-render lands on the
   * SAME content-addressed key and the object map still holds one entry. Under load pdfkit renumbers its
   * objects around the async PNG embed and the same re-render orphans a second object — which is the actual
   * defect. The upload count sees it either way.
   */
  puts: 0,
  /** The options getObjectStream was called with, so the PDF route's deadline is observable. */
  streamOptions: [] as Array<{ signal?: AbortSignal } | undefined>,
  /**
   * Run INSIDE a photo read, i.e. in the middle of a render.
   *
   * The only way to test the window that matters: a change landing between the read that starts a render
   * and the publish that ends it moves none of the timestamps the report row carries, and a test that
   * mutates between two complete request cycles never reaches it.
   */
  duringPhotoRead: null as null | (() => Promise<void>),
}));

// The pool, pointed at PGlite. `connect()` hands back the same underlying connection every time, which is
// exactly what a single-threaded test wants: BEGIN/COMMIT from withWeeklyReportOfficeClient run for real.
vi.mock("../../../src/db.js", () => {
  const query = async (text: string, params?: unknown[]) => {
    const result = await harness.pg.query(text, params as any[]);
    return {
      rows: result.rows as any[],
      // From PGlite's affectedRows, never rows.length — the latter is 0 for an UPDATE without RETURNING.
      rowCount: (result as { affectedRows?: number }).affectedRows ?? result.rows.length,
    };
  };
  const client = { query, release: () => {} };
  return {
    pool: { query, connect: async () => client },
    db: {},
    releasePooledClient: () => {},
    isBrokenConnectionError: () => false,
  };
});

vi.mock("../../../src/lib/r2-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/r2-client.js")>();
  return {
    ...actual,
    isR2Configured: () => harness.r2Configured,
    putObject: async (key: string, body: Buffer) => {
      harness.puts += 1;
      harness.objects.set(key, Buffer.from(body));
    },
    getObjectBuffer: async (key: string) => {
      harness.trace.push("read-original");
      // The interleave point. A render spends its whole life here — one read and transcode per photo — so
      // this is where a change that lands DURING a render belongs in a test.
      if (harness.duringPhotoRead) await harness.duringPhotoRead();
      const buffer = harness.objects.get(key);
      if (!buffer) throw new Error(`missing object ${key}`);
      return { buffer, contentType: "image/jpeg" };
    },
    getObjectStream: async (key: string, opts?: { signal?: AbortSignal }) => {
      harness.streamOptions.push(opts);
      const buffer = harness.objects.get(key);
      if (!buffer) throw new Error(`missing object ${key}`);
      return { stream: [new Uint8Array(buffer)], contentType: "application/pdf" };
    },
  };
});

// The process-wide HEIC permit, wrapped so the ORDER of "acquire" against "read-original" is observable.
// Everything else — the real semaphore, the real transcoder — is left alone; the property under test is the
// route's ordering, not the library's behaviour.
vi.mock("../../../src/lib/image-thumbnail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/image-thumbnail.js")>();
  return {
    ...actual,
    withHeicDecodePermit: async <T>(decode: (permit: symbol) => Promise<T>): Promise<T> => {
      harness.trace.push("acquire-heic-permit");
      return actual.withHeicDecodePermit(decode);
    },
  };
});

import { deals, fieldResponders, files, offices, userOfficeAccess, users } from "@trock-crm/shared/schema";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import { migrationSql } from "../../helpers/migration-sql.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { weeklyReportPublicRoutes, withDeadline } from "../../../src/modules/weekly-reports/public-routes.js";
import { CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION } from "../../../src/modules/weekly-reports/pdf-artifact.js";
import {
  loadWeeklyReportPdfSource,
  publishWeeklyReportPdf,
  resetWeeklyReportRenderBackoff,
} from "../../../src/modules/weekly-reports/pdf-service.js";
import { WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS } from "@trock-crm/shared/types";
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
import { mintWeeklyReportToken } from "../../../src/modules/weekly-reports/tokens-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const OFFICE = U("00001");
const DEAL = U("11111");
const PM = U("22221");
const SUPER = U("22222");
const DIRECTOR = U("22223");
// Field-team roster rows (0228): what the PM/superintendent slots now name. The LOGIN each
// resolves to is derived from the roster row's email, so these are seeded from public.users
// below rather than carrying a hand-typed address that could drift out of step.
const PM_RESPONDER = U("44441");
const SUPER_RESPONDER = U("44442");
const WON_STAGE = U("33331");
const PM_ACTOR = { id: PM, role: "construction" };
const SUPER_ACTOR = { id: SUPER, role: "construction" };
const WEEK_OF = "2026-08-13";
const THURSDAY = 4;

const app = express();
// Mounted exactly as app.ts mounts it, and nothing else — the app-level ordering (before the CSRF gate and
// the SPA fallback) is asserted separately in tests/weekly-report-public-route.test.ts.
app.use("/wr", weeklyReportPublicRoutes);

const db = {
  query: async (text: string, params?: unknown[]) => {
    const result = await harness.pg.query(text, params as any[]);
    return {
      rows: result.rows as any[],
      rowCount: (result as { affectedRows?: number }).affectedRows ?? result.rows.length,
    } as any;
  },
};

let jpegBytes: Buffer;

beforeAll(async () => {
  harness.pg = new PGlite();
  const pg = harness.pg;
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_dallas;`);
  await pg.exec(tenantSchemaSql("public", [offices, users, userOfficeAccess]));
  await pg.exec(tenantSchemaSql("office_dallas", [deals, fieldResponders, files]));
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
  // 0228 links the PM/superintendent slots to the FIELD TEAM ROSTER, so every read of a project now
  // joins `field_responders` and selects `trock_*_responder_id`. A suite that stops at 0227 fails on a
  // missing column rather than on its subject.
  await pg.exec(migrationSql("0228_weekly_report_project_roster_link"));
  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES ('${OFFICE}', 'Dallas', 'dallas');
    INSERT INTO public.users (id, display_name, email, role, office_id) VALUES
      ('${PM}', 'Adam Sherwood', 'adam@example.com', 'construction', '${OFFICE}'),
      ('${SUPER}', 'Steve Sanchez', 'steve@example.com', 'construction', '${OFFICE}'),
      ('${DIRECTOR}', 'Takashi', 'takashi@example.com', 'director', '${OFFICE}');
    INSERT INTO office_dallas.field_responders (id, name, email, role)
SELECT '${PM_RESPONDER}'::uuid, u.display_name, u.email, 'project_manager' FROM public.users u WHERE u.id = '${PM}'
      UNION ALL
      SELECT '${SUPER_RESPONDER}'::uuid, u.display_name, u.email, 'superintendent' FROM public.users u WHERE u.id = '${SUPER}';
    INSERT INTO public.pipeline_stage_config (id, slug) VALUES ('${WON_STAGE}', '${WON_DEAL_STAGE_SLUGS[0]}');
    INSERT INTO office_dallas.deals (id, name, deal_number, stage_id, project_number) VALUES
      ('${DEAL}', '4123 Cedar Springs', 'DFW-10432', '${WON_STAGE}', 'DFW-10432');
    SET search_path TO office_dallas, public;
  `);
  // A genuinely decodable original, so the photo route exercises the real re-encode rather than a stub.
  jpegBytes = await sharp({ create: { width: 24, height: 18, channels: 3, background: "#8899aa" } })
    .jpeg()
    .toBuffer();
});

afterAll(async () => {
  await harness.pg.close();
});

beforeEach(async () => {
  harness.objects.clear();
  harness.trace.length = 0;
  harness.r2Configured = true;
  harness.puts = 0;
  harness.streamOptions.length = 0;
  harness.duringPhotoRead = null;
  // Process-local, and a deadline remembered by one case would refuse the next case's render.
  resetWeeklyReportRenderBackoff();
  await harness.pg.exec(`
    DELETE FROM public.weekly_report_tokens;
    DELETE FROM office_dallas.weekly_report_photos;
    DELETE FROM office_dallas.weekly_reports;
    DELETE FROM office_dallas.weekly_report_projects;
    DELETE FROM office_dallas.files;
  `);
});

let seq = 0;

/** Every stored PDF artifact. Its LENGTH is the assertion: each render lands on a new key and orphans the last. */
function artifactKeys(): string[] {
  return [...harness.objects.keys()].filter((key) => key.includes("weekly-reports"));
}

async function seedPhoto(caption: string, mimeType = "image/jpeg") {
  seq += 1;
  const id = U(`9${String(seq).padStart(4, "0")}`);
  const key = `office_dallas/deals/DFW-10432/photos/${seq}.jpg`;
  harness.objects.set(key, jpegBytes);
  await harness.pg.query(
    `INSERT INTO office_dallas.files (
       id, category, display_name, system_filename, original_filename, mime_type,
       file_size_bytes, file_extension, r2_key, r2_bucket, uploaded_by, deal_id, description, taken_at
     ) VALUES ($1::uuid, 'photo', $2, $2, $2, $7, 1024, 'jpg', $3, 'test-bucket', $4::uuid,
              $5::uuid, $6, '2026-08-11T15:00:00Z')`,
    [id, `photo-${seq}.jpg`, key, SUPER, DEAL, caption, mimeType],
  );
  return id;
}

/** A project, a report carried all the way to `sent`, one photo, and a live link to it. */
async function seedSharedReport(options: { send?: boolean } = {}) {
  seq += 1;
  const project = await createWeeklyReportProject(
    db,
    {
      dealId: DEAL,
      propertyDisplayName: "4123 Cedar Springs",
      clientName: "Mack Real Estate Group",
      clientTeam: { doc: { name: "Jay Stauble", email: "jay@example.com" } },
      trockPmResponderId: PM_RESPONDER,
      trockSuperResponderId: SUPER_RESPONDER,
      contractDate: "2026-07-08",
      projectStartDateNote: "TBD Permit",
      projectedDurationWeeks: 19,
      cadenceWeekday: THURSDAY,
      cadenceStartDate: "2026-07-27",
    } as any,
    DIRECTOR,
    OFFICE,
  );
  const { report } = await createWeeklyReportDraft(
    db,
    { clientSubmissionId: U(`c${String(seq).padStart(4, "0")}`), weeklyReportProjectId: project.id, weekOf: WEEK_OF },
    SUPER_ACTOR,
  );
  await updateWeeklyReportContent(
    db,
    report.id,
    { workCompleted: "- Material delivered for balcony mock up", issuesConcerns: "Permit risk" },
    SUPER_ACTOR,
  );
  const photoId = await seedPhoto("Balcony mock-up complete");
  await replaceWeeklyReportPhotos(db, report.id, [{ fileId: photoId, caption: "Balcony mock-up complete" }], SUPER_ACTOR);
  await transitionWeeklyReport(db, report.id, "pending_review", SUPER_ACTOR);
  await transitionWeeklyReport(db, report.id, "approved", PM_ACTOR);
  if (options.send !== false) await transitionWeeklyReport(db, report.id, "sent", PM_ACTOR);

  const { rawToken, token } = await mintWeeklyReportToken(db, {
    weeklyReportId: report.id,
    tenantId: OFFICE,
    officeSlug: "dallas",
    createdByUserId: PM,
  });
  return { projectId: project.id, reportId: report.id, photoId, rawToken, tokenId: token.id };
}

describe("GET /wr/:token", () => {
  it("serves the report a client was sent", async () => {
    const { rawToken } = await seedSharedReport();
    const response = await request(app).get(`/wr/${rawToken}`);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/html/);
    expect(response.text).toContain("4123 Cedar Springs");
    expect(response.text).toContain("Mack Real Estate Group");
    expect(response.text).toContain("Material delivered for balcony mock up");
    expect(response.text).toContain("Balcony mock-up complete");
    expect(response.text).toContain("Adam Sherwood");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  it("never puts the R2 object key — and so the deal number — in front of the client", async () => {
    const { rawToken } = await seedSharedReport();
    const response = await request(app).get(`/wr/${rawToken}`);
    expect(response.text).not.toContain("DFW-10432");
    expect(response.text).not.toContain("office_dallas");
  });

  it("STOPS serving when the report is pulled back for rework", async () => {
    // The defect this closes: the link is minted for an `approved` report, but `approved -> pending_review`
    // is a transition the assigned superintendent may make alone, and a report in `pending_review` is one
    // they may then rewrite. Checking the status only at mint time left the client's live link streaming
    // unreviewed edits as they were typed.
    const { rawToken, reportId } = await seedSharedReport({ send: false });
    expect((await request(app).get(`/wr/${rawToken}`)).status).toBe(200);

    await transitionWeeklyReport(db, reportId, "pending_review", PM_ACTOR);
    await updateWeeklyReportContent(db, reportId, { workCompleted: "- Draft nobody has reviewed" }, SUPER_ACTOR);

    const response = await request(app).get(`/wr/${rawToken}`);
    expect(response.status).toBe(409);
    expect(response.text).toContain("being updated");
    expect(response.text).not.toContain("Draft nobody has reviewed");
    // Still names the PM, so the client has somewhere to go.
    expect(response.text).toContain("Adam Sherwood");
    expect(response.text).toContain("adam@example.com");
  });

  it("serves again once the PM re-approves", async () => {
    const { rawToken, reportId } = await seedSharedReport({ send: false });
    await transitionWeeklyReport(db, reportId, "pending_review", PM_ACTOR);
    expect((await request(app).get(`/wr/${rawToken}`)).status).toBe(409);
    await transitionWeeklyReport(db, reportId, "approved", PM_ACTOR);
    expect((await request(app).get(`/wr/${rawToken}`)).status).toBe(200);
  });

  it("answers a revoked link with the PM's details but NOT the property", async () => {
    // Revocation is the remedy for a link that reached the wrong person. Continuing to tell that person
    // which property the report covered would undo half of what revoking it was for.
    const { rawToken, tokenId } = await seedSharedReport();
    await harness.pg.query(`UPDATE public.weekly_report_tokens SET revoked_at = now() WHERE id = $1::uuid`, [tokenId]);

    const response = await request(app).get(`/wr/${rawToken}`);
    expect(response.status).toBe(410);
    expect(response.text).toContain("no longer active");
    expect(response.text).toContain("adam@example.com");
    expect(response.text).not.toContain("4123 Cedar Springs");
  });

  it("answers an expired link with the property and the PM", async () => {
    const { rawToken, tokenId } = await seedSharedReport();
    await harness.pg.query(`UPDATE public.weekly_report_tokens SET expires_at = now() - interval '1 day' WHERE id = $1::uuid`, [
      tokenId,
    ]);

    const response = await request(app).get(`/wr/${rawToken}`);
    expect(response.status).toBe(410);
    expect(response.text).toContain("has expired");
    expect(response.text).toContain("4123 Cedar Springs");
    expect(response.text).toContain("adam@example.com");
  });

  it("tells a reader on a superseded link that a newer version exists, without breaking the link", async () => {
    const { rawToken, reportId } = await seedSharedReport();
    await harness.pg.query(`UPDATE office_dallas.weekly_reports SET superseded_by_id = id WHERE id = $1::uuid`, [
      reportId,
    ]);
    const response = await request(app).get(`/wr/${rawToken}`);
    expect(response.status).toBe(200);
    expect(response.text).toContain("A newer version of this report has since been issued");
  });
});

describe("GET /wr/:token/photos/:fileId", () => {
  it("serves a re-encoded JPEG for a photo on this report", async () => {
    const { rawToken, photoId } = await seedSharedReport();
    const response = await request(app).get(`/wr/${rawToken}/photos/${photoId}`);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    // Re-encoded, not proxied: that is what strips the GPS a phone writes into every jobsite photo.
    expect(response.body.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(response.body.equals(jpegBytes)).toBe(false);
  });

  it("404s a photo that belongs to the office but NOT to this report", async () => {
    const { rawToken } = await seedSharedReport();
    const foreign = await seedPhoto("Not on this report");
    expect((await request(app).get(`/wr/${rawToken}/photos/${foreign}`)).status).toBe(404);
  });

  it("404s a non-UUID file id instead of raising a 500 out of Postgres", async () => {
    // Binding a non-UUID to `$2::uuid` raises 22P02, which costs a pooled connection and a BEGIN/ROLLBACK
    // per request and surfaces as a 500 — on a route anyone can call up to the rate limit.
    const { rawToken } = await seedSharedReport();
    const response = await request(app).get(`/wr/${rawToken}/photos/not-a-uuid`);
    expect(response.status).toBe(404);
    expect(response.text).toBe("");
    // The ONE failure on this route that is safe to cache: no id of that shape will ever name a photo. It
    // is kept apart from the transient failures precisely so they can carry no-store and this need not.
    expect(response.headers["cache-control"]).toBeUndefined();
  });

  it("answers a dead link with a bare status, not a page rendered into an img tag", async () => {
    const { rawToken, photoId, tokenId } = await seedSharedReport();
    await harness.pg.query(`UPDATE public.weekly_report_tokens SET revoked_at = now() WHERE id = $1::uuid`, [tokenId]);
    const response = await request(app).get(`/wr/${rawToken}/photos/${photoId}`);
    expect(response.status).toBe(410);
    expect(response.text).toBe("");
  });

  it("stops serving photos when the report is pulled back for rework", async () => {
    const { rawToken, photoId, reportId } = await seedSharedReport({ send: false });
    expect((await request(app).get(`/wr/${rawToken}/photos/${photoId}`)).status).toBe(200);
    await transitionWeeklyReport(db, reportId, "pending_review", PM_ACTOR);
    expect((await request(app).get(`/wr/${rawToken}/photos/${photoId}`)).status).toBe(404);
  });

  it("drops a photo soft-deleted after the report went out", async () => {
    const { rawToken, photoId } = await seedSharedReport();
    await harness.pg.query(`UPDATE office_dallas.files SET deleted_at = now() WHERE id = $1::uuid`, [photoId]);
    expect((await request(app).get(`/wr/${rawToken}/photos/${photoId}`)).status).toBe(404);
  });

  it("takes the HEIC decode permit BEFORE reading the original, not after", async () => {
    // The defect this closes. `generateEvidenceJpeg` acquires the permit itself if the caller has not, so
    // the route worked — but only after pulling up to 40 MB of original into memory. The permit is
    // process-wide at a concurrency of ONE, so a client page of twenty HEIC photos fires twenty parallel
    // requests that each hold a source buffer while queuing behind one decode; and that queue is shared
    // with the field scorecard and AI-report renders, so an unauthenticated page could stall those too.
    // image-thumbnail.ts states the rule and scorecard-evidence-image.ts follows it; this route now does.
    const { rawToken } = await seedSharedReport();
    const heic = await seedPhoto("Shot on a phone", "image/heic");
    // Attached with SQL rather than replaceWeeklyReportPhotos: the report is already SENT, and the service
    // correctly refuses to edit one. The route's own query is what this test exercises.
    await harness.pg.query(
      `INSERT INTO office_dallas.weekly_report_photos (weekly_report_id, file_id, caption, sort_order)
       SELECT id, $1::uuid, 'Shot on a phone', 1 FROM office_dallas.weekly_reports LIMIT 1`,
      [heic],
    );
    harness.trace.length = 0;

    await request(app).get(`/wr/${rawToken}/photos/${heic}`);
    expect(harness.trace).toEqual(["acquire-heic-permit", "read-original"]);
  });

  it("does not take the permit for a photo that needs no WASM decode", async () => {
    // JPEG/PNG/WebP go down sharp's own path. Queuing them on the HEIC semaphore would serialise an entire
    // photo page behind one decode at a time for no reason.
    const { rawToken, photoId } = await seedSharedReport();
    harness.trace.length = 0;
    expect((await request(app).get(`/wr/${rawToken}/photos/${photoId}`)).status).toBe(200);
    expect(harness.trace).toEqual(["read-original"]);
  });

  it("never lets a browser cache a photo failure that is only transient", async () => {
    // A bare 404/503 with no cache directive is heuristically cacheable, which freezes the broken image in
    // this reader's browser long after the cause has cleared. Two cases were missing the header: storage
    // reading as unconfigured, and a decode that threw — which sharp does under memory pressure.
    const { rawToken, photoId } = await seedSharedReport();
    const undecodable = await seedPhoto("Mislabelled", "image/heic");
    await harness.pg.query(
      `INSERT INTO office_dallas.weekly_report_photos (weekly_report_id, file_id, caption, sort_order)
       SELECT id, $1::uuid, 'Mislabelled', 2 FROM office_dallas.weekly_reports LIMIT 1`,
      [undecodable],
    );

    // JPEG bytes labelled image/heic: the WASM decoder rejects them, which is the throw path.
    const decodeFailed = await request(app).get(`/wr/${rawToken}/photos/${undecodable}`);
    expect(decodeFailed.status).toBe(404);
    expect(decodeFailed.headers["cache-control"]).toContain("no-store");

    harness.r2Configured = false;
    const noStorage = await request(app).get(`/wr/${rawToken}/photos/${photoId}`);
    expect(noStorage.status).toBe(503);
    expect(noStorage.headers["cache-control"]).toContain("no-store");
  });

});

describe("GET /wr/:token/pdf", () => {
  it("renders, stores and streams the PDF", async () => {
    const { rawToken } = await seedSharedReport();
    const response = await request(app).get(`/wr/${rawToken}/pdf`).buffer().parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toContain("attachment");
    // Named for the client's benefit, not ours.
    expect(response.headers["content-disposition"]).toContain("4123 Cedar Springs");
    expect((response.body as Buffer).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("stores the artifact under a content-addressed key and reuses it on the next request", async () => {
    const { rawToken, reportId } = await seedSharedReport();
    await request(app).get(`/wr/${rawToken}/pdf`);
    const keys = artifactKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(
      new RegExp(`weekly-reports/${reportId}\\.[a-f0-9]{64}\\.v${CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION}\\.pdf$`),
    );

    // A second download must not render again — the report is SENT, so its artifact is current and is
    // simply streamed. That, not byte-reproducibility, is what keeps a second object from appearing: the
    // render is not reproducible (pdfkit renumbers objects around its async PNG embedding), so anything
    // that DID re-render would land on a new key and leave the old object behind.
    await request(app).get(`/wr/${rawToken}/pdf`);
    expect(harness.puts).toBe(1);
    expect(artifactKeys()).toEqual(keys);
    const row = await harness.pg.query(`SELECT pdf_r2_key, pdf_render_version FROM office_dallas.weekly_reports WHERE id = $1::uuid`, [
      reportId,
    ]);
    expect((row.rows[0] as any).pdf_r2_key).toBe(keys[0]);
    expect((row.rows[0] as any).pdf_render_version).toBe(CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION);
  });

  it("reuses the artifact of an APPROVED report too, instead of re-rendering on every request", async () => {
    // The defect this closes, and the path nobody had a test for. `contentFrozen` is `status === "sent"`,
    // and an approved report therefore classified as "stale" on EVERY read — so every anonymous request on
    // this unauthenticated route rendered again and PUT another object. The render is not byte-reproducible,
    // so each one lands on a new content-addressed key, and nothing in this feature ever deletes one.
    // A client link points at an approved report far more often than at a sent one.
    const { rawToken } = await seedSharedReport({ send: false });
    for (let i = 0; i < 3; i += 1) expect((await request(app).get(`/wr/${rawToken}/pdf`)).status).toBe(200);
    expect(harness.puts).toBe(1);
    expect(artifactKeys()).toHaveLength(1);
  });

  it("re-renders an approved report the moment its CONTENT changes", async () => {
    // The property the cache must not cost: caching an approved report is only safe while a real edit still
    // invalidates it. `updated_at` is bumped by the content and photo write paths, which is what this uses.
    const { rawToken, reportId } = await seedSharedReport({ send: false });
    await request(app).get(`/wr/${rawToken}/pdf`);
    const first = artifactKeys();

    await transitionWeeklyReport(db, reportId, "pending_review", PM_ACTOR);
    await updateWeeklyReportContent(db, reportId, { workCompleted: "- Rewritten after review" }, SUPER_ACTOR);
    await transitionWeeklyReport(db, reportId, "approved", PM_ACTOR);

    expect((await request(app).get(`/wr/${rawToken}/pdf`)).status).toBe(200);
    expect(harness.puts).toBe(2);
    const after = artifactKeys();
    expect(after).toHaveLength(2);
    const row = await harness.pg.query(`SELECT pdf_r2_key FROM office_dallas.weekly_reports WHERE id = $1::uuid`, [
      reportId,
    ]);
    // The row points at the NEW render, never at the one that describes the previous week's text.
    expect((row.rows[0] as any).pdf_r2_key).not.toBe(first[0]);
    expect(after).toContain((row.rows[0] as any).pdf_r2_key);
  });

  it("re-renders an approved report when the LIVE header changes underneath it", async () => {
    // Why an approved report was never cached before. Its header is read live from weekly_report_projects
    // and public.users, neither of which touches weekly_reports.updated_at — so the cache has to key on
    // those rows' generations too, or a renamed property would show on the web page and not in the PDF.
    const { rawToken, projectId } = await seedSharedReport({ send: false });
    await request(app).get(`/wr/${rawToken}/pdf`);
    expect(harness.puts).toBe(1);

    await updateWeeklyReportProject(db, projectId, { propertyDisplayName: "4123 Cedar Springs — Phase II" }, OFFICE);

    expect((await request(app).get(`/wr/${rawToken}/pdf`)).status).toBe(200);
    expect(harness.puts).toBe(2);
    expect(artifactKeys()).toHaveLength(2);
  });

  it("re-renders an approved report when a photo is soft-deleted out from under it, then settles", async () => {
    // The other live input, and the awkward one: a soft delete stamps files.deleted_at and leaves
    // updated_at alone, so counting only live photos would miss the very change that drops one from the
    // document. The page filters deleted photos out on every read; a cached PDF would keep showing it.
    const { rawToken, photoId } = await seedSharedReport({ send: false });
    await request(app).get(`/wr/${rawToken}/pdf`);
    expect(harness.puts).toBe(1);

    // A REAL now(), and the settling assertion below is why it has to be. This used to stamp
    // `now() + interval '1 second'`, which parks the live generation permanently ahead of anything the
    // publisher can record — so "it re-rendered once" passed, and would have gone on passing if the code
    // re-rendered on EVERY request forever, which is the thrash the caching change exists to prevent.
    await harness.pg.query(
      `UPDATE office_dallas.files SET is_active = false, deleted_at = now() WHERE id = $1::uuid`,
      [photoId],
    );

    expect((await request(app).get(`/wr/${rawToken}/pdf`)).status).toBe(200);
    expect(harness.puts).toBe(2);

    // …and then it settles. The artifact records the generation it was rendered from, which now covers the
    // delete, so a further download streams it rather than making a third object nothing will ever delete.
    expect((await request(app).get(`/wr/${rawToken}/pdf`)).status).toBe(200);
    expect(harness.puts).toBe(2);
  });

  it("never freezes a change that lands DURING the render into the cached PDF", async () => {
    // THE defect. The generation was widened on the READ side only: the publish stamped pdf_generated_at =
    // now() — wall-clock, taken after the render — and its CAS was conditioned on weekly_reports.updated_at
    // alone. A photo soft-deleted while the render ran therefore moved nothing the CAS could see, and left
    // deleted_at EARLIER than the stamp, so every later read called the artifact current. The client's page
    // showed no photo and the PDF behind the same link showed one, indefinitely, on a report that sits in
    // `approved` with nothing that would ever move updated_at again.
    //
    // The delete is interleaved into the middle of the render — not between two requests, which is the
    // window the sibling test above misses.
    const { rawToken, reportId, photoId } = await seedSharedReport({ send: false });
    harness.duringPhotoRead = async () => {
      harness.duringPhotoRead = null;
      await harness.pg.query(
        `UPDATE office_dallas.files SET is_active = false, deleted_at = now() WHERE id = $1::uuid`,
        [photoId],
      );
    };

    const first = await request(app).get(`/wr/${rawToken}/pdf`);
    // The hook cleared itself, so the render really did read the photo before the delete landed.
    expect(harness.duringPhotoRead).toBeNull();
    // The render's own bytes are of a week that has already moved on, so they are not served: the row now
    // records the generation they cover, and the retry below re-renders from what the report says now.
    expect(first.status).toBe(503);

    // The web page reads live, and shows no photographs at all.
    const page = await request(app).get(`/wr/${rawToken}`);
    expect(page.status).toBe(200);
    expect(page.text).not.toContain("<figure");

    // The stored artifact must NOT read as current — it describes a photograph the report no longer has.
    expect((await loadWeeklyReportPdfSource(db, reportId))!.recheck).toBe("stale");

    // And the repair is real, asserted on CONTENT rather than on a count: a render of a report with no
    // photos reads no originals at all. A stale artifact served as current would leave this empty because
    // nothing re-rendered; a correct re-render leaves it empty because there is nothing left to fetch, so
    // the upload count is asserted alongside it.
    const putsBefore = harness.puts;
    harness.trace.length = 0;
    const second = await request(app).get(`/wr/${rawToken}/pdf`);
    expect(second.status).toBe(200);
    expect(harness.puts).toBe(putsBefore + 1);
    expect(harness.trace.filter((entry) => entry === "read-original")).toEqual([]);

    // Settled: the artifact now covers everything, so a further download renders nothing new.
    const settled = harness.puts;
    expect((await request(app).get(`/wr/${rawToken}/pdf`)).status).toBe(200);
    expect(harness.puts).toBe(settled);
  });

  it("stamps a superseded report's PDF, under a key that says which rendering it is", async () => {
    // A sent report's artifact is frozen and content-addressed, so it cannot be annotated after the fact —
    // and being superseded moves no timestamp on this row, because the correction is a DIFFERENT row. The
    // marker in the key is what lets a later read tell that the stored PDF predates the correction.
    const { rawToken, reportId } = await seedSharedReport();
    await request(app).get(`/wr/${rawToken}/pdf`);
    const before = artifactKeys();
    expect(before[0]).not.toContain(".superseded.");

    await harness.pg.query(`UPDATE office_dallas.weekly_reports SET superseded_by_id = id WHERE id = $1::uuid`, [
      reportId,
    ]);
    expect((await request(app).get(`/wr/${rawToken}/pdf`)).status).toBe(200);

    const row = await harness.pg.query(`SELECT pdf_r2_key FROM office_dallas.weekly_reports WHERE id = $1::uuid`, [
      reportId,
    ]);
    expect((row.rows[0] as any).pdf_r2_key).toContain(".superseded.pdf");

    // …and then it settles: the marked artifact is current, so a further download renders nothing new.
    const settled = harness.puts;
    await request(app).get(`/wr/${rawToken}/pdf`);
    expect(harness.puts).toBe(settled);
  });

  it("streams the stored PDF under a deadline it can actually abort on", async () => {
    // R2 can answer the GET promptly and then stall mid-body, which pins the request and its socket open
    // with nothing able to cancel it — on a route anyone holding a link can call.
    const { rawToken } = await seedSharedReport();
    await request(app).get(`/wr/${rawToken}/pdf`);
    expect(harness.streamOptions).toHaveLength(1);
    expect(harness.streamOptions[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails the render rather than freezing 'Image unavailable' into the artifact", async () => {
    // strictStorage covered the OBJECT READ only. The transcode catch below it degraded unconditionally,
    // and untranscodedFallback returns null for every non-JPEG/PNG original — so an iPhone HEIC whose
    // decode fell over (heic-convert is WASM, concurrency 1, shared with the field scorecard and AI-report
    // renders) produced a placeholder tile, a SUCCESSFUL render, and a content-addressed artifact that a
    // sent report never re-makes. The client's permanent record of the week would have a hole in it while
    // the web page, which re-encodes on demand, showed the photograph perfectly well.
    //
    // The fixture is JPEG bytes labelled image/heic, which is what the decoder actually rejects. That
    // makes this a PERMANENT failure being treated as if it might be transient — the deliberate side of a
    // distinction nothing can make from inside the catch. Failing loudly is recoverable (the PM sees the
    // download fail and can swap the photo); a frozen artifact with a hole in it is not.
    const { rawToken, reportId } = await seedSharedReport({ send: false });
    const undecodable = await seedPhoto("Shot on a phone", "image/heic");
    await harness.pg.query(
      `INSERT INTO office_dallas.weekly_report_photos (weekly_report_id, file_id, caption, sort_order)
       VALUES ($1::uuid, $2::uuid, 'Shot on a phone', 1)`,
      [reportId, undecodable],
    );

    const response = await request(app).get(`/wr/${rawToken}/pdf`);
    expect(response.status).toBe(503);
    // NOTHING was stored — not "one object instead of two". A degraded document must never become the
    // artifact, because for a sent report nothing will ever replace it.
    expect(harness.puts).toBe(0);
    expect(artifactKeys()).toEqual([]);
    const row = await harness.pg.query(
      `SELECT pdf_r2_key FROM office_dallas.weekly_reports WHERE id = $1::uuid`,
      [reportId],
    );
    expect((row.rows[0] as any).pdf_r2_key).toBeNull();
  });

  it("does not pay for the render again after one has already run out of time", async () => {
    // `/wr/:token/pdf` is anonymous and a render that exceeds its deadline stores NOTHING, so every retry
    // used to re-enter the publisher and pay the whole budget again — downloading and transcoding every
    // photo up to the moment it was abandoned. One reader with an impatient finger could keep a worker
    // busy indefinitely. MAX_REPORT_PHOTOS is 60, each an R2 round trip plus a transcode.
    const { rawToken, reportId } = await seedSharedReport({ send: false });
    // Slow enough to blow the budget below; the budget is shortened rather than the stall lengthened so
    // the test costs milliseconds. AbortSignal.timeout is not driven by vitest's fake timers.
    harness.duringPhotoRead = async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    };
    const source = (await loadWeeklyReportPdfSource(db, reportId))!;

    await expect(publishWeeklyReportPdf("dallas", source, { renderTimeoutMs: 5 })).rejects.toMatchObject({
      statusCode: 503,
      code: "WEEKLY_REPORT_PDF_RENDER_TIMED_OUT",
    });
    expect(harness.puts).toBe(0);

    // The retry is refused WITHOUT re-rendering, asserted on the work not done rather than on how long it
    // took: a second render would read the original again, and the trace records every read.
    harness.trace.length = 0;
    await expect(publishWeeklyReportPdf("dallas", source, { renderTimeoutMs: 5 })).rejects.toMatchObject({
      statusCode: 503,
      code: "WEEKLY_REPORT_PDF_RENDER_TIMED_OUT",
    });
    expect(harness.trace).toEqual([]);
    expect(harness.puts).toBe(0);

    // …and the backoff is a delay, not a tombstone: once it lapses the report renders normally again.
    resetWeeklyReportRenderBackoff();
    harness.duringPhotoRead = null;
    expect((await request(app).get(`/wr/${rawToken}/pdf`)).status).toBe(200);
    expect(harness.puts).toBe(1);
  });

  it("remembers ONLY a deadline, so one transient blip does not become a minute-long outage", async () => {
    // The backoff exists for a render that ran out of time: that one stores nothing and would pay the whole
    // budget again on every retry. Every OTHER failure either fails fast or is expected to succeed on the
    // very next attempt — an R2 read that reset, a report that moved while it rendered — and remembering
    // those turns a self-healing hiccup into sixty seconds of a client's link answering 503.
    const { reportId } = await seedSharedReport({ send: false });
    harness.duringPhotoRead = async () => {
      throw new Error("R2: connection reset by peer");
    };
    const source = (await loadWeeklyReportPdfSource(db, reportId))!;

    // Not a deadline: the render's own budget is untouched and generous.
    await expect(publishWeeklyReportPdf("dallas", source)).rejects.toThrow(/connection reset/);
    expect(harness.puts).toBe(0);

    // The very next attempt must RENDER, not be refused — asserted on the work done, so a 503 with the
    // timeout code would fail here even though it is also "not a 200".
    harness.duringPhotoRead = null;
    harness.trace.length = 0;
    await expect(publishWeeklyReportPdf("dallas", source)).resolves.toContain("weekly-reports/");
    expect(harness.trace).toContain("read-original");
    expect(harness.puts).toBe(1);
  });

  it("does not let a remembered deadline refuse the report after its CONTENT changed", async () => {
    // The backoff and the coalescer share one key, and the key carries the CONTENT GENERATION. Without it
    // a report that timed out at 11:00 is refused until 11:01 — including the corrected version the PM
    // published at 11:00:30 to fix exactly the problem — and a request arriving after an edit would join
    // the in-flight render of the document that preceded it and be handed its key.
    const { reportId } = await seedSharedReport({ send: false });
    harness.duringPhotoRead = async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    };
    const stale = (await loadWeeklyReportPdfSource(db, reportId))!;
    await expect(publishWeeklyReportPdf("dallas", stale, { renderTimeoutMs: 5 })).rejects.toMatchObject({
      code: "WEEKLY_REPORT_PDF_RENDER_TIMED_OUT",
    });

    harness.duringPhotoRead = null;
    await transitionWeeklyReport(db, reportId, "pending_review", PM_ACTOR);
    await updateWeeklyReportContent(db, reportId, { workCompleted: "- Rewritten after the timeout" }, SUPER_ACTOR);
    await transitionWeeklyReport(db, reportId, "approved", PM_ACTOR);

    const edited = (await loadWeeklyReportPdfSource(db, reportId))!;
    await expect(publishWeeklyReportPdf("dallas", edited)).resolves.toContain("weekly-reports/");
    expect(harness.puts).toBe(1);
  });

  it("does not let a remembered deadline refuse the SUPERSEDED rendering of the same content", async () => {
    // The other half of the key. Being superseded moves no timestamp on this row — the correction is a
    // different row — so the two renderings share a content generation and are told apart only by the
    // `superseded` marker. Without it in the key, a timeout on the unmarked document also refuses the
    // marked one, which is the version a client on the old link most needs to be shown.
    const { reportId } = await seedSharedReport({ send: false });
    harness.duringPhotoRead = async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    };
    await expect(
      publishWeeklyReportPdf("dallas", (await loadWeeklyReportPdfSource(db, reportId))!, { renderTimeoutMs: 5 }),
    ).rejects.toMatchObject({ code: "WEEKLY_REPORT_PDF_RENDER_TIMED_OUT" });

    harness.duringPhotoRead = null;
    await harness.pg.query(`UPDATE office_dallas.weekly_reports SET superseded_by_id = id WHERE id = $1::uuid`, [
      reportId,
    ]);

    const superseded = (await loadWeeklyReportPdfSource(db, reportId))!;
    const key = await publishWeeklyReportPdf("dallas", superseded);
    expect(key).toContain(".superseded.pdf");
  });

  it("re-renders when the DEAL is renamed and the header prints the deal's name", async () => {
    // `property_display_name` is nullable and a user can clear it, and both renderers then fall back to
    // `deals.name`. That fallback was a live render input covered by no generation at all: `deals` is
    // joined for the name but `deals.updated_at` was not in the widening, so on an approved report — where
    // a shared link sits indefinitely — a rename changed the client's page while the cached PDF kept the
    // old name for good.
    const { rawToken, projectId } = await seedSharedReport({ send: false });
    await updateWeeklyReportProject(db, projectId, { propertyDisplayName: null }, OFFICE);

    const before = await request(app).get(`/wr/${rawToken}`);
    expect(before.text).toContain("4123 Cedar Springs");
    expect((await request(app).get(`/wr/${rawToken}/pdf`)).status).toBe(200);
    expect(harness.puts).toBe(1);

    await harness.pg.query(
      `UPDATE office_dallas.deals SET name = '4123 Cedar Springs — Phase II', updated_at = now() WHERE id = $1::uuid`,
      [DEAL],
    );

    // The page reads live and has already changed…
    expect((await request(app).get(`/wr/${rawToken}`)).text).toContain("Phase II");
    // …so the artifact must not still be the one that says otherwise.
    expect((await request(app).get(`/wr/${rawToken}/pdf`)).status).toBe(200);
    expect(harness.puts).toBe(2);

    // And it settles: the stored generation now covers the rename, so a further download streams it.
    expect((await request(app).get(`/wr/${rawToken}/pdf`)).status).toBe(200);
    expect(harness.puts).toBe(2);

    await harness.pg.query(`UPDATE office_dallas.deals SET name = '4123 Cedar Springs' WHERE id = $1::uuid`, [DEAL]);
  });

  it("but does NOT re-render for a deal edit when the header names the property", async () => {
    // The other half, and why this is its own generation input rather than another entry in the widening:
    // `deals.updated_at` moves on any edit to the job, and a report that never reads the deal's name must
    // not re-render — orphaning another content-addressed object — every time somebody touches the deal.
    const { rawToken } = await seedSharedReport({ send: false });
    expect((await request(app).get(`/wr/${rawToken}/pdf`)).status).toBe(200);
    expect(harness.puts).toBe(1);

    await harness.pg.query(`UPDATE office_dallas.deals SET updated_at = now() WHERE id = $1::uuid`, [DEAL]);

    expect((await request(app).get(`/wr/${rawToken}/pdf`)).status).toBe(200);
    expect(harness.puts).toBe(1);
  });

  it("freezes the deal-name fallback into the snapshot when the report is SENT", async () => {
    // A sent report's artifact never re-renders, so anything it still reads live diverges from the page
    // behind the same link permanently. The snapshot therefore records the name that will be PRINTED —
    // resolved, not copied — rather than a null the renderers then fill in from the live deal.
    const { rawToken, reportId, projectId } = await seedSharedReport({ send: false });
    await updateWeeklyReportProject(db, projectId, { propertyDisplayName: null }, OFFICE);
    await transitionWeeklyReport(db, reportId, "sent", PM_ACTOR);

    await harness.pg.query(
      `UPDATE office_dallas.deals SET name = 'Renamed After Delivery', updated_at = now() WHERE id = $1::uuid`,
      [DEAL],
    );

    const page = await request(app).get(`/wr/${rawToken}`);
    expect(page.text).toContain("4123 Cedar Springs");
    expect(page.text).not.toContain("Renamed After Delivery");

    await harness.pg.query(`UPDATE office_dallas.deals SET name = '4123 Cedar Springs' WHERE id = $1::uuid`, [DEAL]);
  });

  it("refuses the PDF of a report pulled back for rework", async () => {
    const { rawToken, reportId } = await seedSharedReport({ send: false });
    await transitionWeeklyReport(db, reportId, "pending_review", PM_ACTOR);
    const response = await request(app).get(`/wr/${rawToken}/pdf`);
    expect(response.status).toBe(409);
    expect(response.headers["content-type"]).toMatch(/text\/html/);
  });
});

describe("withDeadline", () => {
  it("releases a request from a queue that cannot itself be cancelled", async () => {
    // The HEIC permit is a FIFO semaphore with no timeout and no cancellation, and it must stay that way —
    // the field scorecard and AI-report renders depend on its current behaviour. This is what stops an
    // unauthenticated request from sitting in it indefinitely with a socket open.
    await expect(withDeadline(new Promise<never>(() => {}), AbortSignal.timeout(5))).rejects.toThrow();
  });

  /**
   * Watch for an unhandled rejection while `body` runs, and report what Node actually emitted.
   *
   * Asserting on the EVENT rather than on "the suite did not crash": a test that merely rejects a promise
   * and waits passes whether or not anything was listening, which is how the branch below went uncovered.
   */
  async function unhandledRejectionsDuring(body: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const listener = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await body();
      // Node decides at the end of a microtask checkpoint, so give it one plus a macrotask.
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", listener);
    }
    return seen;
  }

  it("does not leave the abandoned work's later rejection unhandled", async () => {
    const unhandled = await unhandledRejectionsDuring(async () => {
      let fail: (error: Error) => void = () => {};
      const abandoned = new Promise<never>((_, reject) => {
        fail = reject;
      });
      await expect(withDeadline(abandoned, AbortSignal.timeout(5))).rejects.toThrow();
      // An unhandled rejection here would take the process down in production, long after the request that
      // started it had been answered.
      fail(new Error("the queued work finally gave up"));
    });
    expect(unhandled).toEqual([]);
  });

  it("does not leave it unhandled when the signal is ALREADY aborted on entry", async () => {
    // The branch the test above cannot reach, and therefore never protected: `AbortSignal.timeout(5)`
    // cannot possibly have fired by the time the synchronous call sequence runs, so it only ever exercises
    // the listener path. The early-return path attached NO handler to `work` at all before rejecting —
    // producing, inside the one function written to prevent it, exactly the unhandled rejection its doc
    // comment describes. It would have kept passing if that branch were deleted or made worse.
    const unhandled = await unhandledRejectionsDuring(async () => {
      let fail: (error: Error) => void = () => {};
      const abandoned = new Promise<never>((_, reject) => {
        fail = reject;
      });
      await expect(withDeadline(abandoned, AbortSignal.abort())).rejects.toThrow();
      fail(new Error("the queued work finally gave up"));
    });
    expect(unhandled).toEqual([]);
  });

  it("resolves normally when the work beats the deadline", async () => {
    await expect(withDeadline(Promise.resolve("done"), AbortSignal.timeout(1_000))).resolves.toBe("done");
  });
});
