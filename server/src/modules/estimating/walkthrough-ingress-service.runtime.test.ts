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
  deals,
  estimateDealMarketOverrides,
  estimateDocumentParseRuns,
  estimateExtractionMatches,
  estimateExtractions,
  estimateGenerationRuns,
  estimateMarketFallbackGeographies,
  estimateMarketZipMappings,
  estimateMarkets,
  estimatePricingRecommendationOptions,
  estimatePricingRecommendations,
  estimateReviewEvents,
  estimateSourceDocuments,
  files,
  properties,
} from "@trock-crm/shared/schema";
import type { WalkthroughIngressPayload, WalkthroughScopeRow } from "@trock-crm/shared/types";
import { tenantSchemaSql } from "../../../tests/helpers/tenant-schema-from-drizzle.js";
import { buildEstimatingWorkbenchState } from "./workbench-service.js";
import {
  createWalkthroughContactSheetFile,
  createWalkthroughSourceDocument,
  getCrmFileBucket,
  ingestWalkthrough,
  insertWalkthroughExtractions,
  MAX_WALKTHROUGH_SCOPE_ROWS,
} from "./walkthrough-ingress-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("11111");
const WALKTHROUGH = U("22222");
const USER = U("33333");
const PROJECT = U("44444");
/** Own deals for the workbench tests, so "the state contains exactly this row" / "…contains nothing"
 *  are exact counts rather than containment checks against every row the rest of the suite wrote. */
const WORKBENCH_DEAL = U("55551");
const WORKBENCH_NEGATIVE_DEAL = U("55552");
const DEFAULT_MARKET = U("66661");
/** The bucket the CRM presigns every download against. A `files` row recorded against any other
 *  bucket yields a download URL for an object that is not there (r2-client.ts:168-186 signs the key
 *  against the CONFIGURED bucket and never reads files.r2_bucket), which is why ingress refuses a
 *  foreign one — see "refuses a contact sheet stored outside the CRM's own bucket" below. */
const CRM_BUCKET = getCrmFileBucket();

let pg: PGlite;
// The service is typed against NodePgDatabase; the PGlite driver is wire-compatible for these queries
// but not structurally identical, which is why the repo's other runtime suites hold it loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tenantDb: any;

beforeAll(async () => {
  pg = new PGlite();
  // "public" (not office_*) so the unqualified Drizzle tables resolve on the default search_path.
  //
  // The first four tables are the ingress chain itself. Everything after them exists because
  // buildEstimatingWorkbenchState reads it: matches/pricing/options/review-events/generation-runs are
  // queried unconditionally per deal, and the market block is reached through
  // getDealEffectiveMarketContext (deal-market-override-service.ts:164) — which loads the DEAL row
  // (404 if absent) and then resolves a market, so `deals`, `properties` and the four market tables
  // are all on the read path even though a walkthrough writes none of them.
  await pg.exec(
    tenantSchemaSql("public", [
      files,
      estimateSourceDocuments,
      estimateDocumentParseRuns,
      estimateExtractions,
      estimateExtractionMatches,
      estimatePricingRecommendations,
      estimatePricingRecommendationOptions,
      estimateReviewEvents,
      estimateGenerationRuns,
      deals,
      properties,
      estimateMarkets,
      estimateMarketZipMappings,
      estimateMarketFallbackGeographies,
      estimateDealMarketOverrides,
    ])
  );
  tenantDb = drizzle(pg);

  // A global default market. Without one, resolveMarketContext (market-resolution-service.ts:159-162)
  // throws "No default estimating market is configured" and the workbench never renders for ANY deal —
  // a prod precondition, not a test artifact.
  await tenantDb
    .insert(estimateMarkets)
    .values({ id: DEFAULT_MARKET, name: "Global Default", slug: "global-default", type: "global" });
  await tenantDb
    .insert(estimateMarketFallbackGeographies)
    .values({ marketId: DEFAULT_MARKET, resolutionType: "global", resolutionKey: "default" });

  await tenantDb.insert(deals).values([
    {
      id: WORKBENCH_DEAL,
      dealNumber: "WB-0001",
      name: "Walkthrough workbench deal",
      stageId: U("77771"),
    },
    {
      id: WORKBENCH_NEGATIVE_DEAL,
      dealNumber: "WB-0002",
      name: "Walkthrough workbench negative deal",
      stageId: U("77771"),
    },
  ]);
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
        r2Bucket: CRM_BUCKET,
        bytes: 184320,
        mimeType: "image/jpeg",
        capturedAt: "2026-07-29T14:05:00Z",
        userId: USER,
      },
    });

    expect(fileId).toEqual(expect.any(String));

    const [row] = await tenantDb.select().from(files).where(eq(files.id, fileId));

    expect(row).toBeDefined();
    expect(row.mimeType).toBe("image/jpeg");
    // WITH the leading dot, because buildFileDownloadUrlFromRecord (files/service.ts:1518) builds the
    // download filename as `displayName + (fileExtension ?? "")`. A bare "jpg" would hand an estimator
    // a file called "Walkthrough evidence — Unit 12Bjpg". confirmUpload derives it the same way
    // (files/service.ts:790-792 slices from the dot INCLUSIVE), so this matches every other row.
    expect(row.fileExtension).toBe(".jpg");
    expect(row.displayName + row.fileExtension).toBe("Walkthrough evidence — Unit 12B.jpg");
    expect(row.fileSizeBytes).toBe(184320);
    expect(row.r2Key).toBe("walkthroughs/22222222/contact-sheet.jpg");
    expect(row.r2Bucket).toBe(CRM_BUCKET);
    expect(row.displayName).toContain("Unit 12B");
    expect(row.isActive).toBe(true);
    expect(row.category).toBe("estimate");
    // The walkthrough id reaches the DB ONLY through these two filename columns — nothing else on the
    // row carries it — so they are the only place its provenance can be pinned. Exactly one dot: the
    // extension carries its own, so the filename must not have doubled it.
    expect(row.systemFilename).toBe(`walkthrough-${WALKTHROUGH}.jpg`);
    expect(row.originalFilename).toBe(`walkthrough-${WALKTHROUGH}.jpg`);
    // WHEN the walkthrough was captured, stored as a timestamp rather than as characters inside the
    // document filename. Everything that orders files chronologically reads
    // COALESCE(taken_at, created_at) (files/service.ts:2031), so a null here would date the evidence
    // to whenever the export happened to post rather than to when the estimator walked the building.
    expect(row.takenAt).not.toBeNull();
    expect(new Date(row.takenAt).toISOString()).toBe("2026-07-29T14:05:00.000Z");
    // Provenance the rest of the chain (and any human opening the file) needs.
    expect(row.dealId).toBe(DEAL);
    expect(row.uploadedBy).toBe(USER);
  });

  it("derives the pdf extension with its dot too", async () => {
    const fileId = await createWalkthroughContactSheetFile({
      tenantDb,
      input: {
        dealId: DEAL,
        walkthroughId: U("22299"),
        siteLabel: "Unit 12B",
        r2Key: "walkthroughs/22299/contact-sheet.pdf",
        r2Bucket: CRM_BUCKET,
        bytes: 184320,
        mimeType: "application/pdf",
        capturedAt: "2026-07-29T14:05:00Z",
        userId: USER,
      },
    });

    const [row] = await tenantDb.select().from(files).where(eq(files.id, fileId));
    expect(row.fileExtension).toBe(".pdf");
    expect(row.systemFilename).toBe(`walkthrough-${U("22299")}.pdf`);
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
        r2Bucket: CRM_BUCKET,
        bytes: 184320,
        mimeType: "image/jpeg",
        capturedAt: "2026-07-29T14:05:00Z",
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
      r2Bucket: CRM_BUCKET,
      bytes: 184320,
      mimeType: "image/jpeg",
      capturedAt: "2026-07-29T14:05:00Z",
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

    // All four gates again, this time as executable SQL, so a change to how the metadata is encoded
    // fails here rather than silently emptying the candidate set in prod.
    //
    // This is a HAND-TRANSCRIBED COPY of the worker's candidate filter (estimate-generation.ts:254-286
    // builds it as Drizzle fragments, not as a statement this test could import and run), NOT the
    // worker's own query. Every predicate it applies is reproduced — including the two on the DOCUMENT
    // (parse_status / ocr_status, :282-283) the exists(...) sub-select carries, so a document born
    // anything other than fully completed drops its whole extraction set here. Kept verbatim on
    // purpose rather than rewritten as an independently-worded predicate: a mirror written in its own
    // words can drift from the worker without either side going red, which is precisely the failure
    // this replay exists to catch. If the worker's filter changes, re-transcribe it here.
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

/** A wire-shaped payload, i.e. what trock-scope actually posts. Note the field names: contactSheet*
 *  rather than the helpers' r2Key/bytes/mimeType — mapping between the two is `ingestWalkthrough`'s
 *  job, and the only place the wire contract touches storage-shaped inputs. */
function walkthroughPayload(
  walkthroughId: string,
  overrides: Partial<WalkthroughIngressPayload> = {}
): WalkthroughIngressPayload {
  return {
    walkthroughId,
    dealId: DEAL,
    projectId: PROJECT,
    contactSheetR2Key: `walkthroughs/${walkthroughId}/contact-sheet.jpg`,
    contactSheetBucket: CRM_BUCKET,
    contactSheetBytes: 184320,
    contactSheetMimeType: "image/jpeg",
    siteLabel: "Unit 12B",
    capturedAt: "2026-07-29T14:05:00Z",
    userId: USER,
    rows: [CARPENTRY_ROW],
    ...overrides,
  };
}

/** Whole-table row counts. The suite shares one PGlite instance, so "wrote nothing" can only be
 *  asserted as "the counts did not move" — a per-deal filter would miss a row written under some
 *  other deal id. */
async function tableCounts() {
  const result = await pg.query<{
    files: string;
    documents: string;
    runs: string;
    extractions: string;
  }>(
    `SELECT (SELECT count(*) FROM public.files) AS files,
            (SELECT count(*) FROM public.estimate_source_documents) AS documents,
            (SELECT count(*) FROM public.estimate_document_parse_runs) AS runs,
            (SELECT count(*) FROM public.estimate_extractions) AS extractions`
  );
  return result.rows[0];
}

describe("ingestWalkthrough", () => {
  it("builds the whole chain and links every link to the next", async () => {
    const walkthroughId = U("33001");

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId),
    });

    expect(result.fileId).toEqual(expect.any(String));
    expect(result.documentId).toEqual(expect.any(String));
    expect(result.parseRunId).toEqual(expect.any(String));
    expect(result.extractionIds).toHaveLength(1);

    const [file] = await tenantDb.select().from(files).where(eq(files.id, result.fileId));
    // The wire contract's contactSheet* fields landed on the storage-shaped columns — this mapping is
    // the only thing that connects WalkthroughIngressPayload to the three narrow helper inputs.
    expect(file.r2Key).toBe(`walkthroughs/${walkthroughId}/contact-sheet.jpg`);
    expect(file.r2Bucket).toBe(CRM_BUCKET);
    expect(file.fileSizeBytes).toBe(184320);
    expect(file.mimeType).toBe("image/jpeg");

    const [doc] = await tenantDb
      .select()
      .from(estimateSourceDocuments)
      .where(eq(estimateSourceDocuments.id, result.documentId));

    // LINK 1 — the document points at the file the first helper made.
    expect(doc.fileId).toBe(result.fileId);
    expect(doc.rootFileId).toBe(result.fileId);
    expect(doc.storageKey).toBe(`walkthroughs/${walkthroughId}/contact-sheet.jpg`);
    // LINK 2 — the document's ACTIVE run is the run this call created. A null here is the exact
    // failure the transaction exists to prevent (workbench-service.ts:157 reads it as "never show
    // any of this document's rows"), and it is a separate UPDATE from the document INSERT.
    expect(doc.activeParseRunId).toBe(result.parseRunId);

    const [run] = await tenantDb
      .select()
      .from(estimateDocumentParseRuns)
      .where(eq(estimateDocumentParseRuns.id, result.parseRunId));
    expect(run.documentId).toBe(result.documentId);

    const [extraction] = await tenantDb
      .select()
      .from(estimateExtractions)
      .where(eq(estimateExtractions.id, result.extractionIds[0]));

    // LINK 3 — the extraction hangs off that document, and its metadata names that same run, which
    // is what makes it visible (workbench-service.ts:153-172 compares the two).
    expect(extraction.documentId).toBe(result.documentId);
    expect(extraction.metadataJson.sourceParseRunId).toBe(result.parseRunId);
    expect(extraction.rawLabel).toBe(CARPENTRY_ROW.rawLabel);
    expect(extraction.metadataJson.sourceWalkthroughId).toBe(walkthroughId);
  });

  it("refuses an empty walkthrough without writing anything", async () => {
    const before = await tableCounts();

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33002"), { rows: [] }),
      })
    ).rejects.toThrow("Walkthrough ingress requires at least one scope row");

    // A document with no scope rows is a contact sheet nobody will ever look at plus a parse run
    // nothing points to — so the guard fires BEFORE the first insert, not after.
    expect(await tableCounts()).toEqual(before);
  });

  it("rolls the whole chain back when the last link fails", async () => {
    const before = await tableCounts();

    // quantity is numeric(14,3) (estimate-extractions.ts:37), so it holds ELEVEN integer digits; 1e12
    // has thirteen and overflows at INSERT with a 22003. Chosen over an out-of-range confidence
    // because validation now rejects that before the transaction ever opens, and what this test needs
    // is a real SQL failure in the THIRD write — after the file, the document, the parse run and the
    // activation UPDATE have all already succeeded.
    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33003"), {
          rows: [{ ...CARPENTRY_ROW, quantity: 1e12 }],
        }),
      })
    ).rejects.toThrow();

    // Without the transaction this leaves an orphan file + a document whose extractions never
    // arrived — permanently visible in the workbench documents list with nothing under it.
    expect(await tableCounts()).toEqual(before);
  });

  // THE RECEIVER DOES NOT TRUST THE SENDER. trock-scope withholds rows with no spoken quantity, but a
  // walkthrough quantity that reaches storage as null is priced as ONE UNIT downstream
  // (`Number(extraction.quantity ?? 1)`, three sites in worker/src/jobs/estimate-generation.ts) — so a
  // single bad deploy on the other side of the wire would put confident invented numbers on estimates
  // a human signs. Refused at the door instead.
  it("refuses a row with no spoken quantity, naming it, without writing anything", async () => {
    const before = await tableCounts();

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33004"), {
          rows: [CARPENTRY_ROW, { ...CARPENTRY_ROW, sourceScopeItemId: "scope-item-9002", quantity: null }],
        }),
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      // Named, because "one of your rows is bad" is not something the sender can act on...
      message: expect.stringContaining("scope-item-9002"),
    });
    // ...and DIAGNOSED, because "quantity must be a finite number" would leave the sender guessing
    // that a null is a type error rather than the one rule this export is built on.
    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33004"), {
          rows: [{ ...CARPENTRY_ROW, quantity: null }],
        }),
      })
    ).rejects.toMatchObject({ message: expect.stringContaining("has no spoken quantity") });

    // Not "the bad row was skipped" — the WHOLE walkthrough is refused, including its good first row.
    expect(await tableCounts()).toEqual(before);
  });

  // The bucket the row is stamped with is the bucket its download is presigned against — except that
  // buildFileDownloadUrlFromRecord (files/service.ts:1513-1524) never reads files.r2_bucket at all: it
  // hands generateDownloadUrl the KEY, which signs against the CRM's configured bucket
  // (r2-client.ts:168-186). A contact sheet announced from another bucket is therefore a link to
  // nothing — and this seam performs no object I/O, so it cannot copy the bytes across. Loud 400.
  it("refuses a contact sheet stored outside the CRM's own bucket", async () => {
    const before = await tableCounts();

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33005"), { contactSheetBucket: "trock-scope" }),
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(CRM_BUCKET),
    });

    expect(await tableCounts()).toEqual(before);
  });

  it.each<[string, Partial<WalkthroughIngressPayload>]>([
    ["a row is null", { rows: [null] as unknown as WalkthroughScopeRow[] }],
    ["a row has no rawLabel", { rows: [{ ...CARPENTRY_ROW, rawLabel: undefined }] as unknown as WalkthroughScopeRow[] }],
    ["confidence is out of the 0-1 range", { rows: [{ ...CARPENTRY_ROW, confidence: 12345 }] }],
    ["confidence is not a number", { rows: [{ ...CARPENTRY_ROW, confidence: "high" }] as unknown as WalkthroughScopeRow[] }],
    ["capturedAt is unparseable", { capturedAt: "last tuesday" }],
    ["contactSheetMimeType is not an accepted family", { contactSheetMimeType: "image/png" as never }],
    ["contactSheetBytes is not a positive integer", { contactSheetBytes: 0 }],
    ["siteLabel is blank", { siteLabel: "   " }],
    ["evidence is missing", { rows: [{ ...CARPENTRY_ROW, evidence: undefined }] as unknown as WalkthroughScopeRow[] }],
  ])("rejects a payload where %s, without writing anything", async (_label, overrides) => {
    const before = await tableCounts();

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33006"), overrides),
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    // Every one of these used to be a 500 from inside the transaction (a NOT NULL violation, a
    // `.toFixed` on a string, a 22003) or, worse, a row that inserted and priced wrong.
    expect(await tableCounts()).toEqual(before);
  });

  // The scope item id is what a retry is matched back on (see the idempotency test below), so two rows
  // claiming the same one would make the replay ambiguous — one id returned twice, the other row's id
  // appended as an orphan.
  it("refuses two rows claiming the same sourceScopeItemId", async () => {
    const before = await tableCounts();

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33011"), {
          rows: [CARPENTRY_ROW, { ...CARPENTRY_ROW, rawLabel: "A different utterance entirely" }],
        }),
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(CARPENTRY_ROW.sourceScopeItemId),
    });

    expect(await tableCounts()).toEqual(before);
  });

  it("refuses more scope rows than one walkthrough can plausibly carry", async () => {
    const before = await tableCounts();

    const tooMany = Array.from({ length: MAX_WALKTHROUGH_SCOPE_ROWS + 1 }, (_, index) => ({
      ...CARPENTRY_ROW,
      sourceScopeItemId: `scope-flood-${index}`,
    }));

    await expect(
      ingestWalkthrough({ tenantDb, payload: walkthroughPayload(U("33007"), { rows: tooMany }) })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(await tableCounts()).toEqual(before);
  });

  // Rows are inserted in chunks of 200 because each binds 15 parameters against Postgres's 65535-per-
  // statement cap. This walkthrough straddles two chunks, so a chunking bug (dropped tail, duplicated
  // slice, wrong offset) shows up as a wrong count or a wrong last row rather than passing quietly.
  it("writes every row of a multi-chunk walkthrough exactly once, in order", async () => {
    const walkthroughId = U("33008");
    const rows = Array.from({ length: 250 }, (_, index) => ({
      ...CARPENTRY_ROW,
      sourceScopeItemId: `scope-chunk-${index}`,
      rawLabel: `Chunked scope row ${index}`,
    }));

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { rows }),
    });

    expect(result.extractionIds).toHaveLength(250);
    expect(new Set(result.extractionIds).size).toBe(250);

    const written = await tenantDb
      .select({ rawLabel: estimateExtractions.rawLabel })
      .from(estimateExtractions)
      .where(eq(estimateExtractions.documentId, result.documentId));
    expect(written).toHaveLength(250);

    // The returned ids are in payload order across the chunk boundary, not just present in bulk.
    const [firstOfSecondChunk] = await tenantDb
      .select({ rawLabel: estimateExtractions.rawLabel })
      .from(estimateExtractions)
      .where(eq(estimateExtractions.id, result.extractionIds[200]));
    expect(firstOfSecondChunk.rawLabel).toBe("Chunked scope row 200");
  });

  // IDEMPOTENCY. A lost response is indistinguishable from a lost request, so trock-scope retries. On
  // the old code the retry either died on `files.r2_key`'s unique index (23505, after the first call
  // had already built the whole chain) or — with a regenerated key — succeeded into a SECOND document
  // and a second set of extractions, silently doubling the deal's estimating work.
  it("replays the first call's ids on a retry, writing nothing the second time", async () => {
    const walkthroughId = U("33009");
    const rows = [
      CARPENTRY_ROW,
      { ...CARPENTRY_ROW, sourceScopeItemId: "scope-item-9101", rawLabel: "Reflash the parapet" },
    ];

    const first = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { rows }),
    });

    const afterFirst = await tableCounts();

    const second = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { rows }),
    });

    // Same answer, id for id — the caller cannot tell which attempt won, which is the whole point.
    expect(second).toEqual(first);
    // And nothing moved: no second file, no second document, no second parse run, no second row set.
    expect(await tableCounts()).toEqual(afterFirst);

    const documents = await tenantDb
      .select({ id: estimateSourceDocuments.id })
      .from(estimateSourceDocuments)
      .where(eq(estimateSourceDocuments.contentHash, walkthroughId));
    expect(documents).toHaveLength(1);

    const extractions = await tenantDb
      .select({ id: estimateExtractions.id })
      .from(estimateExtractions)
      .where(eq(estimateExtractions.documentId, first.documentId));
    expect(extractions).toHaveLength(2);
  });

  it("scopes the retry check to the deal, so the same walkthrough on another deal still ingests", async () => {
    const walkthroughId = U("33010");

    const first = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId),
    });
    const other = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, {
        dealId: U("11112"),
        // A retry reuses its key; a genuinely different ingress has its own object.
        contactSheetR2Key: `walkthroughs/${walkthroughId}/contact-sheet-b.jpg`,
      }),
    });

    // Dedupe is on (dealId, projectId, contentHash) — the same triple document-service.ts:104-130
    // uses — so it cannot swallow a legitimate second ingress onto a different deal.
    expect(other.documentId).not.toBe(first.documentId);
  });
});

// THE POINT OF THE WHOLE SEAM. Everything above proves rows land in the right columns; this proves a
// walkthrough actually SHOWS UP for an estimator. buildEstimatingWorkbenchState is the real service
// behind GET /api/estimating/deals/:dealId/workbench — unmodified, called exactly as the route calls
// it — so the row either survives its filters or it doesn't.
describe("walkthrough rows in the estimating workbench", () => {
  it("renders an ingested walkthrough row, id and label intact", async () => {
    const walkthroughId = U("44001");

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { dealId: WORKBENCH_DEAL }),
    });

    const state = await buildEstimatingWorkbenchState(tenantDb, WORKBENCH_DEAL);

    // Exactly one, because this deal is the walkthrough's alone — so this is "the walkthrough row and
    // nothing else", not "at least one row from somewhere".
    expect(state.extractionRows).toHaveLength(1);
    expect(state.extractionRows[0].id).toBe(result.extractionIds[0]);
    // The estimator's eyes land on the label; an id-only assertion would pass on a blank row.
    expect(state.extractionRows[0].rawLabel).toBe(CARPENTRY_ROW.rawLabel);
    expect(state.extractionRows[0].evidenceText).toBe(CARPENTRY_ROW.evidenceText);

    // The counters the workbench header renders off.
    expect(state.summary.extractions.total).toBe(1);
    expect(state.summary.extractions.pending).toBe(1);

    // And the contact sheet is listed as the source document it came from, not queued or failed.
    expect(state.documents).toHaveLength(1);
    expect(state.documents[0].id).toBe(result.documentId);
    expect(state.summary.documents.queued).toBe(0);
    expect(state.summary.documents.failed).toBe(0);
  });

  it("drops the row when ONLY its sourceParseRunId stops matching", async () => {
    const walkthroughId = U("44002");
    const strangerRunId = U("44003");

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { dealId: WORKBENCH_NEGATIVE_DEAL }),
    });

    // Baseline: it renders. Without this the disappearance below could be a row that never appeared.
    const before = await buildEstimatingWorkbenchState(tenantDb, WORKBENCH_NEGATIVE_DEAL);
    expect(before.extractionRows.map((row) => row.id)).toEqual(result.extractionIds);

    // Break gate 3 and NOTHING else — the row keeps its pending status, its activeArtifact, its deal,
    // its document; the document keeps its completed parse and its active run. Only the pointer from
    // the extraction back to that run is changed.
    await pg.query(
      `UPDATE public.estimate_extractions
          SET metadata_json = jsonb_set(metadata_json, '{sourceParseRunId}', to_jsonb($1::text))
        WHERE id = $2`,
      [strangerRunId, result.extractionIds[0]]
    );

    const after = await buildEstimatingWorkbenchState(tenantDb, WORKBENCH_NEGATIVE_DEAL);

    // Gone. This is what makes the positive test above meaningful: the workbench really is filtering
    // on the run pointer, so a row that renders is a row that cleared the gate rather than one the
    // service happened to wave through.
    expect(after.extractionRows).toHaveLength(0);
    expect(after.summary.extractions.total).toBe(0);
    expect(after.summary.extractions.pending).toBe(0);
    // The document itself is still listed — the row vanished, not the paperwork around it.
    expect(after.documents).toHaveLength(1);

    // Proof the row is still in the table and still satisfies every OTHER gate, so its absence above
    // is attributable to the one field that changed.
    const [row] = await tenantDb
      .select()
      .from(estimateExtractions)
      .where(eq(estimateExtractions.id, result.extractionIds[0]));
    expect(row.status).toBe("pending");
    expect(row.metadataJson.activeArtifact).toBe(true);
    expect(row.metadataJson.sourceParseRunId).toBe(strangerRunId);
    expect(row.documentId).toBe(result.documentId);

    const [doc] = await tenantDb
      .select()
      .from(estimateSourceDocuments)
      .where(eq(estimateSourceDocuments.id, result.documentId));
    expect(doc.activeParseRunId).toBe(result.parseRunId);
    expect(doc.parseStatus).toBe("completed");
  });
});
