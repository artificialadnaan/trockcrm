// REAL-SQL (PGlite) proof for the first link of the walkthrough ingress chain: the `files` row that a
// synthesized contact-sheet document hangs off.
//
// Why a runtime test rather than a unit test: `files` has TEN NOT NULL columns (display_name,
// system_filename, original_filename, mime_type, file_size_bytes, file_extension, r2_key, r2_bucket,
// uploaded_by, category — plus tags/version/is_active which carry defaults). Omitting any one is a
// 23502 at INSERT that no amount of type-checking catches, because Drizzle's insert type only knows
// about columns without defaults. The table is built from the REAL Drizzle definition via
// tenantSchemaSql, so the NOT NULLs and the file_category enum here are prod's, by construction.
//
// KNOWN TEST/PROD GAP: prod's `files` carries a `files_association_check` CHECK (migrations/
// 0001_initial.sql:660-662, redefined in 0058_allow_lead_file_attachments.sql:47-56) requiring at least
// one of deal_id / lead_id / contact_id / procore_project_id / change_order_id to be non-null. Drizzle
// declares no `check(...)` for it, so tenantSchemaSql cannot reproduce it and THIS TEST IS BLIND TO IT.
// The implementation satisfies it only by setting `dealId`; a future change that drops dealId would
// still pass here and fail in prod with a 23514. Do not assume this suite covers that.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  estimateDocumentParseRuns,
  estimateExtractions,
  estimateSourceDocuments,
  files,
} from "@trock-crm/shared/schema";
import type { WalkthroughScopeRow } from "@trock-crm/shared/types";
import { tenantSchemaSql } from "../../../tests/helpers/tenant-schema-from-drizzle.js";
import {
  createWalkthroughContactSheetFile,
  createWalkthroughSourceDocument,
  insertWalkthroughExtractions,
} from "./walkthrough-ingress-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("11111");
const WALKTHROUGH = U("22222");
const USER = U("33333");
const PROJECT = U("44444");

let pg: PGlite;
// The service is typed against NodePgDatabase; the PGlite driver is wire-compatible for these queries
// but not structurally identical, which is why the repo's other runtime suites hold it loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tenantDb: any;

beforeAll(async () => {
  pg = new PGlite();
  // "public" (not office_*) so the unqualified Drizzle tables resolve on the default search_path.
  await pg.exec(
    tenantSchemaSql("public", [
      files,
      estimateSourceDocuments,
      estimateDocumentParseRuns,
      estimateExtractions,
    ])
  );
  tenantDb = drizzle(pg);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe("createWalkthroughContactSheetFile", () => {
  it("inserts a files row satisfying every NOT NULL column, derived from the walkthrough input", async () => {
    const fileId = await createWalkthroughContactSheetFile({
      tenantDb,
      input: {
        dealId: DEAL,
        walkthroughId: WALKTHROUGH,
        siteLabel: "Unit 12B",
        r2Key: "walkthroughs/22222222/contact-sheet.jpg",
        r2Bucket: "trock-scope",
        bytes: 184320,
        mimeType: "image/jpeg",
        userId: USER,
      },
    });

    expect(fileId).toEqual(expect.any(String));

    const [row] = await tenantDb.select().from(files).where(eq(files.id, fileId));

    expect(row).toBeDefined();
    expect(row.mimeType).toBe("image/jpeg");
    expect(row.fileExtension).toBe("jpg");
    expect(row.fileSizeBytes).toBe(184320);
    expect(row.r2Key).toBe("walkthroughs/22222222/contact-sheet.jpg");
    expect(row.r2Bucket).toBe("trock-scope");
    expect(row.displayName).toContain("Unit 12B");
    expect(row.isActive).toBe(true);
    expect(row.category).toBe("estimate");
    // The walkthrough id reaches the DB ONLY through these two filename columns — nothing else on the
    // row carries it — so they are the only place its provenance can be pinned.
    expect(row.systemFilename).toContain(WALKTHROUGH);
    expect(row.originalFilename).toContain(WALKTHROUGH);
    // Provenance the rest of the chain (and any human opening the file) needs.
    expect(row.dealId).toBe(DEAL);
    expect(row.uploadedBy).toBe(USER);
  });
});

describe("createWalkthroughSourceDocument", () => {
  it("births the document already parsed, with an activated completed parse run", async () => {
    const fileId = await createWalkthroughContactSheetFile({
      tenantDb,
      input: {
        dealId: DEAL,
        walkthroughId: WALKTHROUGH,
        siteLabel: "Unit 12B",
        r2Key: "walkthroughs/22222222/contact-sheet.jpg",
        r2Bucket: "trock-scope",
        bytes: 184320,
        mimeType: "image/jpeg",
        userId: USER,
      },
    });

    const { documentId, parseRunId } = await createWalkthroughSourceDocument({
      tenantDb,
      input: {
        dealId: DEAL,
        projectId: PROJECT,
        fileId,
        walkthroughId: WALKTHROUGH,
        siteLabel: "Unit 12B",
        capturedAt: "2026-07-29T14:05:00Z",
        mimeType: "image/jpeg",
        storageKey: "walkthroughs/22222222/contact-sheet.jpg",
        bytes: 184320,
        userId: USER,
      },
    });

    const [doc] = await tenantDb
      .select()
      .from(estimateSourceDocuments)
      .where(eq(estimateSourceDocuments.id, documentId));

    expect(doc).toBeDefined();
    // The whole point of this helper: the document is born parsed, so nothing downstream waits on an
    // OCR job that will never run. `activeParseRunId` is what workbench-service.ts:153-172 reads to
    // decide a row is a live artifact — a null here silently hides every extraction.
    expect(doc.activeParseRunId).toBe(parseRunId);
    expect(doc.parseStatus).toBe("completed");
    expect(doc.ocrStatus).toBe("completed");
    expect(doc.parsedAt).not.toBeNull();
    expect(doc.mimeType).toBe("image/jpeg");
    // contentHash carries the walkthrough id deliberately: it gives a future caller (or a backfill
    // query) a key on which a re-ingest of the same walkthrough is DETECTABLE, on the same
    // (dealId, projectId, contentHash) triple document-service.ts:104-130 dedupes against. This
    // helper itself performs no dedupe check and the column carries no unique constraint, so calling
    // it twice still writes a second document — detection is available, not enforced.
    expect(doc.contentHash).toBe(WALKTHROUGH);
    expect(doc.dealId).toBe(DEAL);
    expect(doc.projectId).toBe(PROJECT);
    expect(doc.fileId).toBe(fileId);
    expect(doc.rootFileId).toBe(fileId);
    expect(doc.documentType).toBe("walkthrough");
    expect(doc.filename).toContain("Unit 12B");
    expect(doc.filename).toContain("2026-07-29T14:05:00Z");
    expect(doc.parseProvider).toBe("trock-scope");
    expect(doc.parseProfile).toBe("walkthrough");
    expect(doc.parseMeasurementsEnabled).toBe(false);
    expect(doc.fileSize).toBe(184320);
    expect(doc.storageKey).toBe("walkthroughs/22222222/contact-sheet.jpg");
    expect(doc.uploadedByUserId).toBe(USER);

    const [run] = await tenantDb
      .select()
      .from(estimateDocumentParseRuns)
      .where(eq(estimateDocumentParseRuns.id, parseRunId));

    expect(run).toBeDefined();
    expect(run.status).toBe("completed");
    expect(run.documentId).toBe(documentId);
    expect(run.completedAt).not.toBeNull();
    expect(run.parseProvider).toBe("trock-scope");
    expect(run.parseProfile).toBe("walkthrough");
    expect(run.parseMeasurementsEnabled).toBe(false);
  });
});

/** Build the document chain a set of extractions has to hang off. */
async function seedChain(walkthroughId: string) {
  const fileId = await createWalkthroughContactSheetFile({
    tenantDb,
    input: {
      dealId: DEAL,
      walkthroughId,
      siteLabel: "Unit 12B",
      r2Key: `walkthroughs/${walkthroughId}/contact-sheet.jpg`,
      r2Bucket: "trock-scope",
      bytes: 184320,
      mimeType: "image/jpeg",
      userId: USER,
    },
  });

  return createWalkthroughSourceDocument({
    tenantDb,
    input: {
      dealId: DEAL,
      projectId: PROJECT,
      fileId,
      walkthroughId,
      siteLabel: "Unit 12B",
      capturedAt: "2026-07-29T14:05:00Z",
      mimeType: "image/jpeg",
      storageKey: `walkthroughs/${walkthroughId}/contact-sheet.jpg`,
      bytes: 184320,
      userId: USER,
    },
  });
}

const CARPENTRY_ROW: WalkthroughScopeRow = {
  sourceScopeItemId: "scope-item-9001",
  rawLabel: "Replace rotted carpentry at eave",
  trade: "carpentry",
  divisionHint: "carpentry",
  quantity: 12.5,
  unit: "LF",
  confidence: 0.87,
  evidenceText: "so this whole eave here is rotted, we're replacing about twelve and a half feet",
  evidence: {
    clipId: "clip-a",
    timelineMs: 184_000,
    frameKey: "frames/clip-a/00184000.jpg",
  },
  locationLabel: "North elevation, eave",
};

describe("insertWalkthroughExtractions", () => {
  it("returns [] without touching the table when there are no rows", async () => {
    const { documentId, parseRunId } = await seedChain(U("22223"));

    const ids = await insertWalkthroughExtractions({
      tenantDb,
      input: {
        dealId: DEAL,
        projectId: PROJECT,
        documentId,
        parseRunId,
        walkthroughId: U("22223"),
        rows: [],
      },
    });

    expect(ids).toEqual([]);

    const written = await tenantDb
      .select()
      .from(estimateExtractions)
      .where(eq(estimateExtractions.documentId, documentId));

    expect(written).toHaveLength(0);
  });

  it("writes a row that clears all four visibility gates", async () => {
    const walkthroughId = U("22224");
    const { documentId, parseRunId } = await seedChain(walkthroughId);

    const ids = await insertWalkthroughExtractions({
      tenantDb,
      input: {
        dealId: DEAL,
        projectId: PROJECT,
        documentId,
        parseRunId,
        walkthroughId,
        rows: [CARPENTRY_ROW],
      },
    });

    expect(ids).toHaveLength(1);

    const [row] = await tenantDb
      .select()
      .from(estimateExtractions)
      .where(eq(estimateExtractions.id, ids[0]));

    expect(row).toBeDefined();

    // GATE 1 — estimate-generation.ts:256-261 only considers rows whose status is 'pending' (or whose
    // extractionType is 'measurement_candidate', which a scope utterance is not). Any other status and
    // the walkthrough's rows are simply never fed to generation.
    expect(row.status).toBe("pending");

    // GATE 2 — a JSON BOOLEAN, matching every other writer of this key
    // (document-parse-orchestrator.ts:166-179 builds it with jsonb_build_object over a boolean
    // expression; :298 and :331 write a JS `false`). Both consumers accept it: Postgres renders JSON
    // `true` as the text `'true'` under `->>`, so estimate-generation.ts:262 still matches, and
    // workbench-service.ts:171 tests `!== false`, which `true` passes.
    expect(row.metadataJson.activeArtifact).toBe(true);
    expect(typeof row.metadataJson.activeArtifact).toBe("boolean");

    // GATE 3 — workbench-service.ts:153-172 hides any row whose metadata sourceParseRunId is not
    // strictly equal to its document's activeParseRunId.
    expect(row.metadataJson.sourceParseRunId).toBe(parseRunId);
    const [doc] = await tenantDb
      .select()
      .from(estimateSourceDocuments)
      .where(eq(estimateSourceDocuments.id, documentId));
    expect(row.metadataJson.sourceParseRunId).toBe(doc.activeParseRunId);

    // GATE 4 — pricing needs a scope type/key; resolvePricingScopeFromExtraction is the same resolver
    // extraction-service.ts uses, so walkthrough rows price on the identical basis as parsed ones.
    // The row's authoritative `trade` is handed over as `metadataJson.tradeHint`, and the resolver's
    // tradeHint branch (pricing-service.ts:212-220) runs BEFORE its divisionHint branch (:231-236),
    // so the scope is "trade"/<trade> even though divisionHint is set. Verified against the real
    // function, not assumed.
    expect(row.metadataJson.pricingScopeType).toBe("trade");
    expect(row.metadataJson.pricingScopeKey).toBe("carpentry");
    // The classification itself is kept on the row for provenance, not just consumed by the resolver.
    expect(row.metadataJson.trade).toBe("carpentry");

    // All four gates again, this time through the ACTUAL SQL the worker runs, so a change to how the
    // metadata is encoded fails here rather than silently emptying the candidate set in prod.
    // Every predicate estimate-generation.ts:254-286 applies is reproduced, including the two on the
    // DOCUMENT (parse_status / ocr_status, :282-283) that the exists(...) sub-select carries — a
    // document born anything other than fully completed drops its whole extraction set here.
    const candidates = await pg.query<{ id: string }>(
      `SELECT e.id
         FROM public.estimate_extractions e
         JOIN public.estimate_source_documents d ON d.id = e.document_id
        WHERE e.deal_id = $1
          AND (e.status = 'pending' OR e.extraction_type = 'measurement_candidate')
          AND e.metadata_json->>'activeArtifact' = 'true'
          AND e.metadata_json->>'sourceParseRunId' = d.active_parse_run_id::text
          AND d.parse_status = 'completed'
          AND d.ocr_status = 'completed'
          AND e.document_id = $2`,
      [DEAL, documentId]
    );
    expect(candidates.rows.map((r) => r.id)).toEqual(ids);

    // Temporal evidence occupies evidenceBboxJson wholesale — there is no bbox for a spoken utterance.
    expect(row.evidenceBboxJson).toEqual({
      clipId: "clip-a",
      timelineMs: 184_000,
      frameKey: "frames/clip-a/00184000.jpg",
    });

    expect(row.extractionType).toBe("scope_utterance");
    expect(row.rawLabel).toBe(CARPENTRY_ROW.rawLabel);
    expect(row.normalizedLabel).toBe(CARPENTRY_ROW.rawLabel.toLowerCase());
    expect(row.evidenceText).toBe(CARPENTRY_ROW.evidenceText);
    expect(row.unit).toBe("LF");
    expect(row.divisionHint).toBe("carpentry");
    expect(row.dealId).toBe(DEAL);
    expect(row.projectId).toBe(PROJECT);
    expect(row.documentId).toBe(documentId);
    expect(row.pageId).toBeNull();
    // numeric(5,2) round-trips as a string, so 0.87 has to survive as "0.87" not 0.87 or "0.9".
    expect(row.confidence).toBe("0.87");
    expect(Number(row.confidence)).toBe(0.87);
    expect(Number(row.quantity)).toBe(12.5);

    // Provenance back to trock-scope: the scope item id is what makes re-export idempotent.
    expect(row.metadataJson.sourceScopeItemId).toBe("scope-item-9001");
    expect(row.metadataJson.locationLabel).toBe("North elevation, eave");
    expect(row.metadataJson.sourceWalkthroughId).toBe(walkthroughId);
    expect(row.metadataJson.extractionProvider).toBe("trock-scope");
    expect(row.metadataJson.extractionMethod).toBe("walkthrough_grounding");
  });

  it("resolves a trade scope when the row carries no divisionHint", async () => {
    const walkthroughId = U("22225");
    const { documentId, parseRunId } = await seedChain(walkthroughId);

    const ids = await insertWalkthroughExtractions({
      tenantDb,
      input: {
        dealId: DEAL,
        projectId: PROJECT,
        documentId,
        parseRunId,
        walkthroughId,
        rows: [{ ...CARPENTRY_ROW, divisionHint: null }],
      },
    });

    const [row] = await tenantDb
      .select()
      .from(estimateExtractions)
      .where(eq(estimateExtractions.id, ids[0]));

    // Same resolver, same tradeHint branch: dropping divisionHint changes nothing, because the trade
    // was never being inferred from prose in the first place — the row told us what it is.
    expect(row.metadataJson.pricingScopeType).toBe("trade");
    expect(row.metadataJson.pricingScopeKey).toBe("carpentry");
    expect(row.divisionHint).toBeNull();
  });

  it("prices from the row's authoritative trade, not from the words in the label", async () => {
    const walkthroughId = U("22227");
    const { documentId, parseRunId } = await seedChain(walkthroughId);

    // The adversarial case the whole tradeHint pass-through exists for: a ROOFING row whose prose
    // says "carpentry" and whose divisionHint says "carpentry" too. Left to itself the resolver's
    // text-inference (pricing-service.ts:222) scans rawLabel against the 19-member tradeScopeHints
    // set and lands on "carpentry"; its divisionHint branch (:231-236) would land there as well.
    // Only the authoritative classification off the walkthrough can produce "roofing".
    const ids = await insertWalkthroughExtractions({
      tenantDb,
      input: {
        dealId: DEAL,
        projectId: PROJECT,
        documentId,
        parseRunId,
        walkthroughId,
        rows: [{ ...CARPENTRY_ROW, trade: "roofing" }],
      },
    });

    const [row] = await tenantDb
      .select()
      .from(estimateExtractions)
      .where(eq(estimateExtractions.id, ids[0]));

    // PRECEDENCE, verified against the real resolver: the tradeHint branch (pricing-service.ts:212)
    // returns BEFORE the divisionHint branch (:231) is ever reached, so the trade wins outright.
    expect(row.metadataJson.pricingScopeType).toBe("trade");
    expect(row.metadataJson.pricingScopeKey).toBe("roofing");
    // The prose and the division hint are both still "carpentry" — proving the key above came from
    // `trade` and not from either of them.
    expect(row.rawLabel).toContain("carpentry");
    expect(row.divisionHint).toBe("carpentry");
    expect(row.metadataJson.trade).toBe("roofing");
  });

  it("writes SQL NULL for a row whose quantity was never spoken", async () => {
    const walkthroughId = U("22226");
    const { documentId, parseRunId } = await seedChain(walkthroughId);

    const ids = await insertWalkthroughExtractions({
      tenantDb,
      input: {
        dealId: DEAL,
        projectId: PROJECT,
        documentId,
        parseRunId,
        walkthroughId,
        rows: [{ ...CARPENTRY_ROW, quantity: null, unit: null }],
      },
    });

    const [row] = await tenantDb
      .select()
      .from(estimateExtractions)
      .where(eq(estimateExtractions.id, ids[0]));

    expect(row.quantity).toBeNull();

    // Asserted at the SQL level too: a stringified null ("null"), a 0, or a "1" would all be non-null
    // here, and only a real IS NULL keeps "no quantity was spoken" distinguishable from "zero of it".
    const probe = await pg.query<{ is_null: boolean; raw: string | null }>(
      `SELECT quantity IS NULL AS is_null, quantity::text AS raw
         FROM public.estimate_extractions WHERE id = $1`,
      [ids[0]]
    );
    expect(probe.rows[0].is_null).toBe(true);
    expect(probe.rows[0].raw).toBeNull();
  });
});
