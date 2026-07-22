import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";

const officeDb = vi.hoisted(() => ({ current: null as any }));
const r2Mocks = vi.hoisted(() => ({
  getObjectBuffer: vi.fn(),
  putObject: vi.fn(async () => undefined),
  generateDownloadUrl: vi.fn(async (key: string) => `https://signed.example/${key}`),
  headObjectStrict: vi.fn(),
  isR2Configured: vi.fn(() => true),
}));

vi.mock("../../../src/modules/field/cross-office.js", () => ({
  runInOffice: vi.fn(async (_office: unknown, run: (db: unknown) => unknown) => run(officeDb.current)),
  runInOfficeTransaction: vi.fn(async (_office: unknown, _userId: string, run: (db: unknown) => unknown) => run(officeDb.current)),
}));

vi.mock("../../../src/lib/r2-client.js", () => {
  class ObjectTooLargeError extends Error {}
  return {
    ...r2Mocks,
    ObjectTooLargeError,
    isR2ObjectNotFoundError: (error: any) => error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404,
  };
});

import {
  finalizeFieldScorecardArtifacts,
  renderAndStoreFieldScorecardArtifacts,
} from "../../../src/modules/field/scorecards-service.js";
import { fieldScorecards, fieldScorecardItems, fieldScorecardPhotos } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const DEAL = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const FILE = "aaaaaaaa-0000-0000-0000-000000000001";
// A distinct file used only as a corrective-action RESPONSE photo — it must NOT participate in the PDF
// evidence fingerprint (corrective_action_id IS NULL excludes it on both the initial read and the recheck).
const RESPONSE_FILE = "aaaaaaaa-0000-0000-0000-000000000002";
const RESPONSE_PHOTO_CARD = "55555555-5555-5555-5555-000000000008";
const RESPONSE_CORRECTIVE_ACTION = "77777777-7777-7777-7777-000000000001";
const CARD = "55555555-5555-5555-5555-000000000001";
const RETRY_CARD = "55555555-5555-5555-5555-000000000002";
const CHANGED_CARD = "55555555-5555-5555-5555-000000000003";
const CAPTION_CHANGED_CARD = "55555555-5555-5555-5555-000000000004";
const INTERLEAVED_CARD = "55555555-5555-5555-5555-000000000005";
const CONTENT_CHANGED_CARD = "55555555-5555-5555-5555-000000000006";
const CONCURRENT_CARD = "55555555-5555-5555-5555-000000000007";
const EVIDENCE_PNG = readFileSync(new URL("../../../../client-field/public/favicon-32x32.png", import.meta.url));

let pg: PGlite;
let db: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE deals (id uuid PRIMARY KEY, name text, deal_number text);
    CREATE TABLE files (
      id uuid PRIMARY KEY,
      description text,
      r2_key text NOT NULL,
      thumbnail_r2_key text,
      mime_type text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      deleted_at timestamptz,
      created_at timestamptz DEFAULT NOW()
    );
  `);
  await pg.exec(tenantSchemaSql("public", [fieldScorecards, fieldScorecardItems, fieldScorecardPhotos]));
  await pg.exec(`
    INSERT INTO deals VALUES ('${DEAL}', 'Maple Street Tower', 'DFW-10432');
    INSERT INTO files VALUES (
      '${FILE}', 'Framing detail', 'original/photo.jpg', 'thumbs/photo.jpg', 'image/jpeg', true, NULL, NOW()
    );
    INSERT INTO files VALUES (
      '${RESPONSE_FILE}', 'Corrective action photo', 'original/response.jpg', 'thumbs/response.jpg', 'image/jpeg', true, NULL, NOW()
    );
  `);
  db = drizzle(pg);
  officeDb.current = db;
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  vi.clearAllMocks();
  r2Mocks.isR2Configured.mockReturnValue(true);
  r2Mocks.getObjectBuffer.mockResolvedValue({
    buffer: EVIDENCE_PNG,
    contentType: "image/png",
    contentLength: EVIDENCE_PNG.byteLength,
  });
  await db.execute(sql`DELETE FROM field_scorecard_photos`);
  await db.execute(sql`DELETE FROM field_scorecard_items`);
  await db.execute(sql`DELETE FROM field_scorecards`);
  await db.execute(sql`UPDATE files SET is_active = true, deleted_at = NULL, description = 'Framing detail'`);
});

async function seedScorecard(id: string) {
  await db.insert(fieldScorecards).values({
    id,
    clientSubmissionId: id.replace(/^55555555/, "66666666"),
    dealId: DEAL,
    weekOf: "2026-07-06",
    totalScore: 84,
    formVersion: 2,
    averageScore: "8.4",
    rating: "on_standard",
    submittedBy: USER,
    submittedByName: "Sam Super",
  });
  await db.insert(fieldScorecardItems).values({
    scorecardId: id,
    sectionKey: "quality",
    points: 8,
    note: "Reinspect framing.",
  });
  await db.insert(fieldScorecardPhotos).values({
    scorecardId: id,
    sectionKey: "quality",
    fileId: FILE,
  });
}

describe("finalizeFieldScorecardArtifacts", () => {
  it("loads and embeds active evidence, uploads a versioned PDF, and stamps the matching revision", async () => {
    await seedScorecard(CARD);

    const key = await finalizeFieldScorecardArtifacts({ id: "office-1", slug: "dallas" }, USER, CARD);

    expect(key).toMatch(new RegExp(`${CARD}\\.[a-f0-9]{64}\\.v2\\.pdf$`));
    expect(r2Mocks.getObjectBuffer).toHaveBeenCalledWith("thumbs/photo.jpg", { maxBytes: 750_000 });
    expect(r2Mocks.putObject).toHaveBeenCalledOnce();
    const [uploadedKey, pdf, contentType] = r2Mocks.putObject.mock.calls[0];
    expect(uploadedKey).toBe(key);
    expect(contentType).toBe("application/pdf");
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect((pdf as Buffer).subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const row = await db.execute(sql`
      SELECT pdf_r2_key, pdf_render_version FROM field_scorecards WHERE id = ${CARD}::uuid
    `);
    expect(row.rows[0]).toMatchObject({ pdf_r2_key: key, pdf_render_version: 2 });
  });

  it("does not upload or advance the version when evidence storage fails transiently", async () => {
    await seedScorecard(RETRY_CARD);
    r2Mocks.getObjectBuffer.mockRejectedValue(new Error("R2 timeout"));

    await expect(
      finalizeFieldScorecardArtifacts({ id: "office-1", slug: "dallas" }, USER, RETRY_CARD),
    ).rejects.toMatchObject({ statusCode: 503, code: "SCORECARD_EVIDENCE_UNAVAILABLE" });
    expect(r2Mocks.putObject).not.toHaveBeenCalled();

    const row = await db.execute(sql`
      SELECT pdf_r2_key, pdf_render_version FROM field_scorecards WHERE id = ${RETRY_CARD}::uuid
    `);
    expect(row.rows[0]).toMatchObject({ pdf_r2_key: null, pdf_render_version: 1 });
  });

  it("does not stamp a render when evidence is deleted during the slow R2/render window", async () => {
    await seedScorecard(CHANGED_CARD);
    r2Mocks.putObject.mockImplementationOnce(async () => {
      await db.execute(sql`UPDATE files SET is_active = false, deleted_at = NOW() WHERE id = ${FILE}::uuid`);
    });

    await expect(
      finalizeFieldScorecardArtifacts({ id: "office-1", slug: "dallas" }, USER, CHANGED_CARD),
    ).rejects.toMatchObject({ statusCode: 503, code: "SCORECARD_EVIDENCE_CHANGED" });

    const row = await db.execute(sql`
      SELECT pdf_r2_key, pdf_render_version FROM field_scorecards WHERE id = ${CHANGED_CARD}::uuid
    `);
    expect(row.rows[0]).toMatchObject({ pdf_r2_key: null, pdf_render_version: 1 });
  });

  it("does not stamp a render when an evidence caption changes during the slow R2/render window", async () => {
    await seedScorecard(CAPTION_CHANGED_CARD);
    r2Mocks.putObject.mockImplementationOnce(async () => {
      await db.execute(sql`UPDATE files SET description = 'Caption edited while rendering' WHERE id = ${FILE}::uuid`);
    });

    await expect(
      finalizeFieldScorecardArtifacts({ id: "office-1", slug: "dallas" }, USER, CAPTION_CHANGED_CARD),
    ).rejects.toMatchObject({ statusCode: 503, code: "SCORECARD_EVIDENCE_CHANGED" });

    const row = await db.execute(sql`
      SELECT pdf_r2_key, pdf_render_version FROM field_scorecards WHERE id = ${CAPTION_CHANGED_CARD}::uuid
    `);
    expect(row.rows[0]).toMatchObject({ pdf_r2_key: null, pdf_render_version: 1 });
  });

  it("does not publish a stale PDF when scorecard content changes without changing evidence", async () => {
    await seedScorecard(CONTENT_CHANGED_CARD);
    r2Mocks.putObject.mockImplementationOnce(async () => {
      await db.execute(sql`
        UPDATE field_scorecard_items
        SET points = 10, note = 'Edited while the original PDF was rendering.'
        WHERE scorecard_id = ${CONTENT_CHANGED_CARD}::uuid
      `);
      await db.execute(sql`
        UPDATE field_scorecards
        SET total_score = 100, average_score = 10, rating = 'elite', updated_at = updated_at + INTERVAL '1 second'
        WHERE id = ${CONTENT_CHANGED_CARD}::uuid
      `);
    });

    await expect(
      finalizeFieldScorecardArtifacts({ id: "office-1", slug: "dallas" }, USER, CONTENT_CHANGED_CARD),
    ).rejects.toMatchObject({ statusCode: 503, code: "SCORECARD_CONTENT_CHANGED" });

    const row = await db.execute(sql`
      SELECT pdf_r2_key, pdf_render_version FROM field_scorecards WHERE id = ${CONTENT_CHANGED_CARD}::uuid
    `);
    expect(row.rows[0]).toMatchObject({ pdf_r2_key: null, pdf_render_version: 1 });
  });

  it("lets two cross-instance finalizers for the same generation converge", async () => {
    await seedScorecard(CONCURRENT_CARD);

    // Hold both immutable uploads until both uncoalesced attempts reach publication. In production these
    // callbacks model separate server instances, whose process-local single-flight maps cannot coalesce.
    let entered = 0;
    let releaseBoth!: () => void;
    const bothEntered = new Promise<void>((resolve) => { releaseBoth = resolve; });
    r2Mocks.putObject.mockImplementation(async () => {
      entered += 1;
      if (entered === 2) releaseBoth();
      await bothEntered;
    });

    const [first, second] = await Promise.all([
      renderAndStoreFieldScorecardArtifacts({ id: "office-1", slug: "dallas" }, USER, CONCURRENT_CARD),
      renderAndStoreFieldScorecardArtifacts({ id: "office-1", slug: "dallas" }, USER, CONCURRENT_CARD),
    ]);

    expect(first).toMatch(new RegExp(`${CONCURRENT_CARD}\\.[a-f0-9]{64}\\.v2\\.pdf$`));
    expect(second).toMatch(new RegExp(`${CONCURRENT_CARD}\\.[a-f0-9]{64}\\.v2\\.pdf$`));
    const row = await db.execute(sql`
      SELECT pdf_r2_key, pdf_render_version FROM field_scorecards WHERE id = ${CONCURRENT_CARD}::uuid
    `);
    expect(row.rows[0]).toMatchObject({ pdf_render_version: 2 });
    expect([first, second]).toContain(row.rows[0]?.pdf_r2_key);
  });

  it("a stale finalizer cannot overwrite the object published by a newer evidence generation", async () => {
    await seedScorecard(INTERLEAVED_CARD);

    const objects = new Map<string, Buffer>();
    const puts: Array<{ key: string; pdf: Buffer }> = [];
    let signalFirstPut!: () => void;
    const firstPutEntered = new Promise<void>((resolve) => { signalFirstPut = resolve; });
    let releaseFirstPut!: () => void;
    const firstPutRelease = new Promise<void>((resolve) => { releaseFirstPut = resolve; });
    r2Mocks.putObject.mockImplementation(async (...args: unknown[]) => {
      const [key, pdf] = args as [string, Buffer, string];
      const call = { key, pdf };
      puts.push(call);
      if (puts.length === 1) {
        signalFirstPut();
        await firstPutRelease;
      }
      objects.set(key, pdf);
    });

    // Call the uncoalesced primitive twice to model two server processes (each process has its own
    // single-flight map). The first render captured the photo and pauses before its PUT completes.
    const stalePromise = renderAndStoreFieldScorecardArtifacts(
      { id: "office-1", slug: "dallas" },
      USER,
      INTERLEAVED_CARD,
    );
    const staleOutcome = stalePromise.then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
    await firstPutEntered;

    // Evidence is deleted, then a second process publishes and stamps the correct photo-free generation.
    await db.execute(sql`UPDATE files SET is_active = false, deleted_at = NOW() WHERE id = ${FILE}::uuid`);
    const currentKey = await renderAndStoreFieldScorecardArtifacts(
      { id: "office-1", slug: "dallas" },
      USER,
      INTERLEAVED_CARD,
    );
    expect(puts).toHaveLength(2);
    expect(currentKey).toBe(puts[1].key);

    // The stale process finishes last. It must fail validation, and its immutable orphan must not replace
    // the bytes stored at the DB-authoritative key.
    releaseFirstPut();
    const stale = await staleOutcome;
    expect(stale.error).toMatchObject({ statusCode: 503, code: "SCORECARD_EVIDENCE_CHANGED" });
    expect(puts[0].key).not.toBe(puts[1].key);

    const row = await db.execute(sql`
      SELECT pdf_r2_key, pdf_render_version FROM field_scorecards WHERE id = ${INTERLEAVED_CARD}::uuid
    `);
    expect(row.rows[0]).toMatchObject({ pdf_r2_key: currentKey, pdf_render_version: 2 });
    expect(objects.get(currentKey!)).toBe(puts[1].pdf);
    expect(objects.get(puts[0].key)).toBe(puts[0].pdf);
  });

  it("regenerates the PDF for a scorecard that has a corrective-action RESPONSE photo (recheck excludes it)", async () => {
    // A below-band scorecard accrued a corrective-action RESPONSE photo (corrective_action_id set). The PDF
    // embeds ONLY original evidence, so both the initial evidence read AND the publication recheck must
    // exclude the response photo. Before the fix, the recheck selected ALL field_scorecard_photos, so its
    // fingerprint included the response photo while the initial fingerprint did not → SCORECARD_EVIDENCE_CHANGED
    // on every regeneration. This proves the finalizer now succeeds with a response photo present.
    await seedScorecard(RESPONSE_PHOTO_CARD);
    await db.insert(fieldScorecardPhotos).values({
      scorecardId: RESPONSE_PHOTO_CARD,
      sectionKey: null,
      deficiencyKey: null,
      fileId: RESPONSE_FILE,
      correctiveActionId: RESPONSE_CORRECTIVE_ACTION,
    });

    const key = await finalizeFieldScorecardArtifacts(
      { id: "office-1", slug: "dallas" },
      USER,
      RESPONSE_PHOTO_CARD,
    );

    // The render published successfully (no spurious SCORECARD_EVIDENCE_CHANGED), and only the ORIGINAL
    // evidence file was pulled from R2 — the response file was never fetched for the PDF.
    expect(key).toMatch(new RegExp(`${RESPONSE_PHOTO_CARD}\\.[a-f0-9]{64}\\.v2\\.pdf$`));
    expect(r2Mocks.getObjectBuffer).toHaveBeenCalledWith("thumbs/photo.jpg", { maxBytes: 750_000 });
    expect(r2Mocks.getObjectBuffer).not.toHaveBeenCalledWith("thumbs/response.jpg", { maxBytes: 750_000 });

    const row = await db.execute(sql`
      SELECT pdf_r2_key, pdf_render_version FROM field_scorecards WHERE id = ${RESPONSE_PHOTO_CARD}::uuid
    `);
    expect(row.rows[0]).toMatchObject({ pdf_r2_key: key, pdf_render_version: 2 });
  });
});
