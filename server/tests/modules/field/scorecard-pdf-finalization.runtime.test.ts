import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
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
import { CURRENT_SCORECARD_PDF_RENDER_VERSION } from "../../../src/modules/field/scorecard-pdf-artifact.js";
import {
  fieldScorecards,
  fieldScorecardItems,
  fieldScorecardPhotos,
  scorecardCorrectiveActions,
  scorecardCorrectiveActionEvents,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const DEAL = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const FILE = "aaaaaaaa-0000-0000-0000-000000000001";
// A distinct file used only as a corrective-action RESPONSE photo. It must NOT participate in the PDF
// evidence fingerprint (corrective_action_id IS NULL excludes it on both the initial read and the recheck),
// but since PDF v3 it IS embedded in the document — in the corrective-action section, not the evidence pages.
const RESPONSE_FILE = "aaaaaaaa-0000-0000-0000-000000000002";
// Two more response files, used to prove the pre-cap photo slice and the renderer agree on item order.
const REORDER_FILE_A = "aaaaaaaa-0000-0000-0000-000000000003";
const REORDER_FILE_B = "aaaaaaaa-0000-0000-0000-000000000004";
const REORDER_CARD = "55555555-5555-5555-5555-000000000010";
const REORDER_ITEM_A = "77777777-7777-7777-7777-000000000002";
const REORDER_ITEM_B = "77777777-7777-7777-7777-000000000003";
const RESPONSE_PHOTO_CARD = "55555555-5555-5555-5555-000000000008";
const RESPONSE_CORRECTIVE_ACTION = "77777777-7777-7777-7777-000000000001";
const CARD = "55555555-5555-5555-5555-000000000001";
const RETRY_CARD = "55555555-5555-5555-5555-000000000002";
const CHANGED_CARD = "55555555-5555-5555-5555-000000000003";
const CAPTION_CHANGED_CARD = "55555555-5555-5555-5555-000000000004";
const INTERLEAVED_CARD = "55555555-5555-5555-5555-000000000005";
const CONTENT_CHANGED_CARD = "55555555-5555-5555-5555-000000000006";
const CONCURRENT_CARD = "55555555-5555-5555-5555-000000000007";
const CONTENT_GENERATION_CARD = "55555555-5555-5555-5555-000000000009";
const THREAD_CARD = "55555555-5555-5555-5555-000000000011";
const THREAD_CORRECTIVE_ACTION = "77777777-7777-7777-7777-000000000004";
const GENERATION_UNPUBLISHED_CARD = "55555555-5555-5555-5555-000000000010";
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
  await pg.exec(tenantSchemaSql("public", [fieldScorecards, fieldScorecardItems, fieldScorecardPhotos, scorecardCorrectiveActions, scorecardCorrectiveActionEvents]));
  await pg.exec(`
    INSERT INTO deals VALUES ('${DEAL}', 'Maple Street Tower', 'DFW-10432');
    INSERT INTO files VALUES (
      '${FILE}', 'Framing detail', 'original/photo.jpg', 'thumbs/photo.jpg', 'image/jpeg', true, NULL, NOW()
    );
    INSERT INTO files VALUES (
      '${RESPONSE_FILE}', 'Corrective action photo', 'original/response.jpg', 'thumbs/response.jpg', 'image/jpeg', true, NULL, NOW()
    );
    INSERT INTO files VALUES (
      '${REORDER_FILE_A}', 'Item A evidence', 'original/a.jpg', 'thumbs/a.jpg', 'image/jpeg', true, NULL, NOW()
    );
    INSERT INTO files VALUES (
      '${REORDER_FILE_B}', 'Item B evidence', 'original/b.jpg', 'thumbs/b.jpg', 'image/jpeg', true, NULL, NOW()
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
  await db.execute(sql`DELETE FROM scorecard_corrective_actions`);
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

    expect(key).toMatch(new RegExp(`${CARD}\\.[a-f0-9]{64}\\.v${CURRENT_SCORECARD_PDF_RENDER_VERSION}\\.pdf$`));
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
    expect(row.rows[0]).toMatchObject({ pdf_r2_key: key, pdf_render_version: CURRENT_SCORECARD_PDF_RENDER_VERSION });
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

    expect(first).toMatch(new RegExp(`${CONCURRENT_CARD}\\.[a-f0-9]{64}\\.v${CURRENT_SCORECARD_PDF_RENDER_VERSION}\\.pdf$`));
    expect(second).toMatch(new RegExp(`${CONCURRENT_CARD}\\.[a-f0-9]{64}\\.v${CURRENT_SCORECARD_PDF_RENDER_VERSION}\\.pdf$`));
    const row = await db.execute(sql`
      SELECT pdf_r2_key, pdf_render_version FROM field_scorecards WHERE id = ${CONCURRENT_CARD}::uuid
    `);
    expect(row.rows[0]).toMatchObject({ pdf_render_version: CURRENT_SCORECARD_PDF_RENDER_VERSION });
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
    expect(row.rows[0]).toMatchObject({ pdf_r2_key: currentKey, pdf_render_version: CURRENT_SCORECARD_PDF_RENDER_VERSION });
    expect(objects.get(currentKey!)).toBe(puts[1].pdf);
    expect(objects.get(puts[0].key)).toBe(puts[0].pdf);
  });

  it("embeds a corrective-action RESPONSE photo while keeping it out of the evidence fingerprint", async () => {
    // A below-band scorecard accrued a corrective-action RESPONSE photo (corrective_action_id set).
    //
    // TWO separate invariants meet here:
    //   1. FINGERPRINT symmetry — the response photo must be excluded from BOTH the initial evidence read
    //      and the publication recheck. When only the recheck selected ALL field_scorecard_photos, its
    //      fingerprint included the response photo while the initial one did not → a spurious
    //      SCORECARD_EVIDENCE_CHANGED on every regeneration.
    //   2. RENDERING — since PDF v3 the response photo IS fetched and embedded, in the corrective-action
    //      section rather than the original-evidence pages. Excluding it from the fingerprint must not be
    //      confused with excluding it from the document.
    await seedScorecard(RESPONSE_PHOTO_CARD);
    await db.insert(scorecardCorrectiveActions).values({
      id: RESPONSE_CORRECTIVE_ACTION,
      scorecardId: RESPONSE_PHOTO_CARD,
      itemType: "action_item",
      itemRef: "0",
      itemLabel: "Re-inspect framing",
      status: "approved",
      responderName: "Pat Manager",
      responseComment: "Re-inspected and corrected.",
      respondedAt: new Date(),
    });
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

    // Published successfully — no spurious SCORECARD_EVIDENCE_CHANGED (invariant 1) — and BOTH the original
    // evidence and the response photo were pulled from R2 for the document (invariant 2).
    expect(key).toMatch(new RegExp(`${RESPONSE_PHOTO_CARD}\\.[a-f0-9]{64}\\.v${CURRENT_SCORECARD_PDF_RENDER_VERSION}\\.pdf$`));
    expect(r2Mocks.getObjectBuffer).toHaveBeenCalledWith("thumbs/photo.jpg", { maxBytes: 750_000 });
    expect(r2Mocks.getObjectBuffer).toHaveBeenCalledWith("thumbs/response.jpg", { maxBytes: 750_000 });

    const row = await db.execute(sql`
      SELECT pdf_r2_key, pdf_render_version FROM field_scorecards WHERE id = ${RESPONSE_PHOTO_CARD}::uuid
    `);
    expect(row.rows[0]).toMatchObject({ pdf_r2_key: key, pdf_render_version: CURRENT_SCORECARD_PDF_RENDER_VERSION });
  });

  it("stamps pdf_content_generation with the updated_at the render read", async () => {
    // The staleness check compares this against the live updated_at, so a render that does not stamp it
    // leaves the artifact permanently "stale" and re-renders on every single download.
    await seedScorecard(CONTENT_GENERATION_CARD);

    const key = await finalizeFieldScorecardArtifacts(
      { id: "office-1", slug: "dallas" },
      USER,
      CONTENT_GENERATION_CARD,
    );
    expect(key).toBeTruthy();

    const row = await db.execute(sql`
      SELECT pdf_content_generation, updated_at FROM field_scorecards WHERE id = ${CONTENT_GENERATION_CARD}::uuid
    `);
    const { pdf_content_generation: stamped, updated_at: current } = row.rows[0] as Record<string, Date>;
    expect(stamped).not.toBeNull();
    expect(new Date(stamped).getTime()).toBe(new Date(current).getTime());
  });

  it("leaves pdf_content_generation untouched when the render never publishes", async () => {
    await seedScorecard(GENERATION_UNPUBLISHED_CARD);
    r2Mocks.getObjectBuffer.mockRejectedValue(new Error("R2 timeout"));

    await expect(
      finalizeFieldScorecardArtifacts({ id: "office-1", slug: "dallas" }, USER, GENERATION_UNPUBLISHED_CARD),
    ).rejects.toMatchObject({ statusCode: 503 });

    const row = await db.execute(sql`
      SELECT pdf_content_generation FROM field_scorecards WHERE id = ${GENERATION_UNPUBLISHED_CARD}::uuid
    `);
    expect(row.rows[0]).toMatchObject({ pdf_content_generation: null });
  });

  it("REGRESSION: the pre-cap photo slice ranks items the same way the renderer does", async () => {
    // The loader slices response photos to a global cap BEFORE the renderer sees them, so the two MUST rank
    // items identically. When the loader ranked by item_ref while the renderer ranked by the live
    // action-item list, a reorder made them disagree: the cap kept photos for one item and the renderer drew
    // a different one, so an item silently lost its response evidence.
    //
    // Fetch ORDER is the observable proxy for the ranking — the loader resolves photos in rank order.
    await db.insert(fieldScorecards).values({
      id: REORDER_CARD,
      clientSubmissionId: "66666666-5555-5555-5555-000000000010",
      dealId: DEAL,
      weekOf: "2026-07-06",
      totalScore: 40,
      formVersion: 2,
      averageScore: "4.0",
      rating: "corrective_action",
      submittedBy: USER,
      submittedByName: "Sam Super",
      // The editor REORDERED the list: "Item B" is now first, though its row still carries the higher ref.
      actionItems: ["Item B", "Item A"],
    });
    await db.insert(scorecardCorrectiveActions).values([
      {
        id: REORDER_ITEM_A,
        scorecardId: REORDER_CARD,
        itemType: "action_item",
        itemRef: "0",
        itemLabel: "Item A",
        status: "approved",
        responderName: "Pat Manager",
        responseComment: "A done.",
        respondedAt: new Date(),
      },
      {
        id: REORDER_ITEM_B,
        scorecardId: REORDER_CARD,
        itemType: "action_item",
        itemRef: "1",
        itemLabel: "Item B",
        status: "approved",
        responderName: "Pat Manager",
        responseComment: "B done.",
        respondedAt: new Date(),
      },
    ]);
    await db.insert(fieldScorecardPhotos).values([
      { scorecardId: REORDER_CARD, sectionKey: null, deficiencyKey: null, fileId: REORDER_FILE_A, correctiveActionId: REORDER_ITEM_A },
      { scorecardId: REORDER_CARD, sectionKey: null, deficiencyKey: null, fileId: REORDER_FILE_B, correctiveActionId: REORDER_ITEM_B },
    ]);

    r2Mocks.getObjectBuffer.mockClear();
    await finalizeFieldScorecardArtifacts({ id: "office-1", slug: "dallas" }, USER, REORDER_CARD);

    const responseFetchOrder = r2Mocks.getObjectBuffer.mock.calls
      .map((call) => call[0] as string)
      .filter((key) => key === "thumbs/a.jpg" || key === "thumbs/b.jpg");
    // Item B renders first now, so its evidence is ranked first — matching buildScorecardPdfData. Ranking by
    // item_ref would put "thumbs/a.jpg" first.
    expect(responseFetchOrder).toEqual(["thumbs/b.jpg", "thumbs/a.jpg"]);
  });

  it("writes the whole back-and-forth into the PDF, not just the outcome", async () => {
    // The end-to-end claim of this feature: "all back and forth is documented into the pdf of the score card
    // report". The item row holds only the LATEST attempt, so without the event thread reaching the renderer
    // the document could show that the fix was approved but never that it was once sent back, or why.
    await seedScorecard(THREAD_CARD);
    await db.insert(scorecardCorrectiveActions).values({
      id: THREAD_CORRECTIVE_ACTION,
      scorecardId: THREAD_CARD,
      itemType: "action_item",
      itemRef: "0",
      itemLabel: "Re-torque the anchors",
      status: "approved",
      responderName: "Pat Manager",
      responseComment: "Re-torqued to spec, values logged.",
      respondedAt: new Date(),
    });
    await db.insert(scorecardCorrectiveActionEvents).values([
      {
        correctiveActionId: THREAD_CORRECTIVE_ACTION,
        scorecardId: THREAD_CARD,
        eventType: "submitted",
        actorName: "Pat Manager",
        comment: "Anchors tightened.",
      },
      {
        correctiveActionId: THREAD_CORRECTIVE_ACTION,
        scorecardId: THREAD_CARD,
        eventType: "rejected",
        actorName: "James Helms",
        comment: "Torque values were not documented.",
      },
      {
        correctiveActionId: THREAD_CORRECTIVE_ACTION,
        scorecardId: THREAD_CARD,
        eventType: "submitted",
        actorName: "Pat Manager",
        comment: "Re-torqued to spec, values logged.",
      },
      {
        correctiveActionId: THREAD_CORRECTIVE_ACTION,
        scorecardId: THREAD_CARD,
        eventType: "approved",
        actorName: "James Helms",
        comment: null,
      },
    ]);

    const key = await finalizeFieldScorecardArtifacts({ id: "office-1", slug: "dallas" }, USER, THREAD_CARD);
    expect(key).toBeTruthy();

    const written = r2Mocks.putObject.mock.calls.at(-1)?.[1] as Buffer;
    const text = renderedText(written);
    // The REJECTION and its reason — the part that exists only in the thread.
    expect(text).toContain("Rejected by James Helms");
    expect(text).toContain("Torque values were not documented.");
    // Both attempts, in order, and the approval that closed it.
    expect(text).toContain("Anchors tightened.");
    expect(text).toContain("Re-torqued to spec, values logged.");
    expect(text).toContain("Approved by James Helms");
    expect(text.indexOf("Anchors tightened.")).toBeLessThan(text.indexOf("Torque values were not documented."));
    // And the item is labelled APPROVED, not merely answered.
    expect(text).toContain("APPROVED");
  });
});

/**
 * The literal text drawn into the document, so a render can be asserted on its CONTENT rather than its size.
 *
 * PDFKit writes runs as hex-encoded TJ arrays against a subsetted font — `[<48656c6c6f> 20 <21> 0] TJ` — with
 * the numbers being kerning adjustments, not characters. Concatenating the hex chunks of one array
 * reconstructs the run; a plain `(text) Tj` is handled too for any run PDFKit emits literally.
 */
function renderedText(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  const streamRe = /stream\r?\n/g;
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(raw)) !== null) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    let text: string;
    try {
      text = inflateSync(Buffer.from(raw.slice(start, end), "latin1")).toString("latin1");
    } catch {
      continue; // not a Flate stream (e.g. an embedded image)
    }
    for (const tj of text.matchAll(/\[((?:<[0-9A-Fa-f]*>|[-\d.\s])*)\]\s*TJ/g)) {
      const run = [...tj[1].matchAll(/<([0-9A-Fa-f]*)>/g)]
        .map((hex) => Buffer.from(hex[1], "hex").toString("latin1"))
        .join("");
      if (run) out.push(run);
    }
    for (const tj of text.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
      out.push(tj[1].replace(/\\([()\\])/g, "$1"));
    }
  }
  return out.join(" ");
}
