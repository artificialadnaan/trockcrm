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
    isR2Configured: () => true,
    putObject: async (key: string, body: Buffer) => {
      harness.objects.set(key, Buffer.from(body));
    },
    getObjectBuffer: async (key: string) => {
      const buffer = harness.objects.get(key);
      if (!buffer) throw new Error(`missing object ${key}`);
      return { buffer, contentType: "image/jpeg" };
    },
    getObjectStream: async (key: string) => {
      const buffer = harness.objects.get(key);
      if (!buffer) throw new Error(`missing object ${key}`);
      return { stream: [new Uint8Array(buffer)], contentType: "application/pdf" };
    },
  };
});

import { deals, files, offices, userOfficeAccess, users } from "@trock-crm/shared/schema";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import { migrationSql } from "../../helpers/migration-sql.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { weeklyReportPublicRoutes } from "../../../src/modules/weekly-reports/public-routes.js";
import { createWeeklyReportProject } from "../../../src/modules/weekly-reports/projects-service.js";
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
  await harness.pg.exec(`
    DELETE FROM public.weekly_report_tokens;
    DELETE FROM office_dallas.weekly_report_photos;
    DELETE FROM office_dallas.weekly_reports;
    DELETE FROM office_dallas.weekly_report_projects;
    DELETE FROM office_dallas.files;
  `);
});

let seq = 0;

async function seedPhoto(caption: string) {
  seq += 1;
  const id = U(`9${String(seq).padStart(4, "0")}`);
  const key = `office_dallas/deals/DFW-10432/photos/${seq}.jpg`;
  harness.objects.set(key, jpegBytes);
  await harness.pg.query(
    `INSERT INTO office_dallas.files (
       id, category, display_name, system_filename, original_filename, mime_type,
       file_size_bytes, file_extension, r2_key, r2_bucket, uploaded_by, deal_id, description, taken_at
     ) VALUES ($1::uuid, 'photo', $2, $2, $2, 'image/jpeg', 1024, 'jpg', $3, 'test-bucket', $4::uuid,
              $5::uuid, $6, '2026-08-11T15:00:00Z')`,
    [id, `photo-${seq}.jpg`, key, SUPER, DEAL, caption],
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
    const keys = [...harness.objects.keys()].filter((key) => key.includes("weekly-reports"));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`weekly-reports/${reportId}\\.[a-f0-9]{64}\\.v1\\.pdf$`));

    // A second download must not render again — the report is SENT, so its artifact is current and is
    // simply streamed. That, not byte-reproducibility, is what keeps a second object from appearing: the
    // render is not reproducible (pdfkit renumbers objects around its async PNG embedding), so anything
    // that DID re-render would land on a new key and leave the old object behind.
    await request(app).get(`/wr/${rawToken}/pdf`);
    expect([...harness.objects.keys()].filter((key) => key.includes("weekly-reports"))).toEqual(keys);
    const row = await harness.pg.query(`SELECT pdf_r2_key, pdf_render_version FROM office_dallas.weekly_reports WHERE id = $1::uuid`, [
      reportId,
    ]);
    expect((row.rows[0] as any).pdf_r2_key).toBe(keys[0]);
    expect((row.rows[0] as any).pdf_render_version).toBe(1);
  });

  it("refuses the PDF of a report pulled back for rework", async () => {
    const { rawToken, reportId } = await seedSharedReport({ send: false });
    await transitionWeeklyReport(db, reportId, "pending_review", PM_ACTOR);
    const response = await request(app).get(`/wr/${rawToken}/pdf`);
    expect(response.status).toBe(409);
    expect(response.headers["content-type"]).toMatch(/text\/html/);
  });
});
