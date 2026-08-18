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

import { deals, files, offices, userOfficeAccess, users } from "@trock-crm/shared/schema";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import { migrationSql } from "../../helpers/migration-sql.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { weeklyReportPublicRoutes, withDeadline } from "../../../src/modules/weekly-reports/public-routes.js";
import { CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION } from "../../../src/modules/weekly-reports/pdf-artifact.js";
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
  await pg.exec(tenantSchemaSql("office_dallas", [deals, files]));
  await pg.exec(`CREATE TABLE IF NOT EXISTS public.pipeline_stage_config (id uuid PRIMARY KEY, slug text);`);
  await pg.exec(migrationSql("0222_weekly_reports"));
  // 0223 too. Nothing in the PDF path reads weekly_report_pauses today, but the cadence helpers
  // these suites reach through do, and two sibling suites already failed exactly this way.
  await pg.exec(migrationSql("0223_weekly_report_pauses"));
  // 0226 too, for the same reason and with more teeth: it ADDS COLUMNS to weekly_reports, and every
  // dashboard read selects them. A suite that stops at 0223 fails with "column send_delivered_at does
  // not exist" — or worse, would swallow it inside an office-level handler and skip the office.
  await pg.exec(migrationSql("0226_weekly_report_send"));
  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES ('${OFFICE}', 'Dallas', 'dallas');
    INSERT INTO public.users (id, display_name, email, role, office_id) VALUES
      ('${PM}', 'Adam Sherwood', 'adam@example.com', 'construction', '${OFFICE}'),
      ('${SUPER}', 'Steve Sanchez', 'steve@example.com', 'construction', '${OFFICE}'),
      ('${DIRECTOR}', 'Takashi', 'takashi@example.com', 'director', '${OFFICE}');
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
      trockPmUserId: PM,
      trockSuperUserId: SUPER,
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

  it("re-renders an approved report when a photo is soft-deleted out from under it", async () => {
    // The other live input, and the awkward one: a soft delete stamps files.deleted_at and leaves
    // updated_at alone, so counting only live photos would miss the very change that drops one from the
    // document. The page filters deleted photos out on every read; a cached PDF would keep showing it.
    const { rawToken, photoId } = await seedSharedReport({ send: false });
    await request(app).get(`/wr/${rawToken}/pdf`);
    expect(harness.puts).toBe(1);

    await harness.pg.query(
      `UPDATE office_dallas.files SET is_active = false, deleted_at = now() + interval '1 second' WHERE id = $1::uuid`,
      [photoId],
    );

    expect((await request(app).get(`/wr/${rawToken}/pdf`)).status).toBe(200);
    expect(harness.puts).toBe(2);
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

  it("does not leave the abandoned work's later rejection unhandled", async () => {
    let fail: (error: Error) => void = () => {};
    const abandoned = new Promise<never>((_, reject) => {
      fail = reject;
    });
    await expect(withDeadline(abandoned, AbortSignal.timeout(5))).rejects.toThrow();
    // An unhandled rejection here would take the process down in production, long after the request that
    // started it had been answered.
    fail(new Error("the queued work finally gave up"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("resolves normally when the work beats the deadline", async () => {
    await expect(withDeadline(Promise.resolve("done"), AbortSignal.timeout(1_000))).resolves.toBe("done");
  });
});
