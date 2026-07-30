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
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  deals,
  estimateDealMarketOverrides,
  estimateDocumentParseRuns,
  estimateExtractionMatches,
  estimateExtractions,
  estimateGenerationRuns,
  estimateLineItems,
  estimateMarketFallbackGeographies,
  estimateMarketZipMappings,
  estimateMarkets,
  estimatePricingRecommendationOptions,
  estimatePricingRecommendations,
  estimateReviewEvents,
  estimateSections,
  estimateSourceDocuments,
  files,
  properties,
} from "@trock-crm/shared/schema";
import type { WalkthroughIngressPayload, WalkthroughScopeRow } from "@trock-crm/shared/types";
import { tenantSchemaSql } from "../../../tests/helpers/tenant-schema-from-drizzle.js";
import { reprocessEstimateSourceDocument } from "./document-service.js";
import { canonicalizeTradeScopeKey, isKnownTradeScopeKey } from "./pricing-service.js";
import { buildEstimatingWorkbenchState } from "./workbench-service.js";
import {
  buildWalkthroughContactSheetDisplayName,
  createWalkthroughContactSheetFile,
  createWalkthroughSourceDocument,
  getCrmFileBucket,
  ingestWalkthrough,
  insertWalkthroughExtractions,
  MAX_WALKTHROUGH_DIVISION_HINT_CHARS,
  MAX_WALKTHROUGH_ID_CHARS,
  MAX_WALKTHROUGH_QUANTITY,
  MAX_WALKTHROUGH_RAW_LABEL_CHARS,
  MAX_WALKTHROUGH_SCOPE_ROWS,
  MAX_WALKTHROUGH_SITE_LABEL_CHARS,
  MAX_WALKTHROUGH_UNIT_CHARS,
  MIN_WALKTHROUGH_QUANTITY,
  WALKTHROUGH_NO_PROJECT_KEY_SEGMENT,
  walkthroughIngressLockKey,
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
/** The reprocess-guard suite gets its own deal for the same reason: it renders the workbench to prove
 *  the scope survived, and the two deals above assert EXACT row counts that a second walkthrough on
 *  them would break. */
const REPROCESS_DEAL = U("55553");
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
      // NOT on any walkthrough write path. These are the PROMOTION targets, and they are here so the
      // width-audit tests below can prove the chain NARROWS against real SQL — that a quantity or a
      // divisionHint this module's own insert accepts is rejected by the column promotion copies it
      // into — rather than asserting the narrowing from the Drizzle definitions the bounds were read
      // off in the first place. See "the promotion chain narrows" describe block.
      estimateLineItems,
      estimateSections,
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
    {
      id: REPROCESS_DEAL,
      dealNumber: "WB-0003",
      name: "Walkthrough reprocess-guard deal",
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

  // R11. The trade is handed over as the authoritative `tradeHint`, and market-rule lookup compares
  // scope keys with `===` (market-rate-service.ts:84). `normalizeScopeKey` in the resolver's tradeHint
  // branch only TRIMS, so a trade of "Roofing" became the scope key "Roofing", matched no roofing rule,
  // and fell back to the general adjustment — priced generally while looking trade-priced. Exactly the
  // divergence passing the trade was supposed to prevent.
  it("canonicalizes the trade so the pricing key matches a market rule exactly", async () => {
    const walkthroughId = U("22240");
    const { documentId, parseRunId } = await seedChain(walkthroughId);

    const ids = await insertWalkthroughExtractions({
      tenantDb,
      input: {
        dealId: DEAL,
        projectId: PROJECT,
        documentId,
        parseRunId,
        walkthroughId,
        // As a sender would plausibly spell it, and as the CRM would not.
        rows: [{ ...CARPENTRY_ROW, trade: canonicalizeTradeScopeKey("  Roofing  ") }],
      },
    });

    const [row] = await tenantDb
      .select()
      .from(estimateExtractions)
      .where(eq(estimateExtractions.id, ids[0]));

    expect(row.metadataJson.pricingScopeKey).toBe("roofing");
    expect(row.metadataJson.trade).toBe("roofing");
    expect(row.metadataJson.tradeHintApplied).toBe(true);

    // Asserted against the REAL comparison the market path performs, not against a lowercase string:
    // this is the predicate that decides whether the roofing rule is found at all.
    expect(isKnownTradeScopeKey(String(row.metadataJson.pricingScopeKey))).toBe(true);
  });

  // A trade outside the pricing path's 19-member set must NOT be passed as a hint: it would become a
  // scope key matching no rule, which resolves to the general adjustment while the row looks
  // trade-priced. The hint is dropped so the resolver takes its ordinary inference path (what every
  // non-walkthrough producer already does), the trade is still stored for provenance, and the fact that
  // the hint was unusable is recorded rather than invisible. Deliberately not a 400 — see the service.
  it("withholds the trade hint for a trade the pricing path cannot match, and says so on the row", async () => {
    const walkthroughId = U("22241");
    const { documentId, parseRunId } = await seedChain(walkthroughId);

    const ids = await insertWalkthroughExtractions({
      tenantDb,
      input: {
        dealId: DEAL,
        projectId: PROJECT,
        documentId,
        parseRunId,
        walkthroughId,
        rows: [
          {
            ...CARPENTRY_ROW,
            trade: "scaffolding",
            divisionHint: null,
            rawLabel: "Erect scaffolding at the north face",
          },
        ],
      },
    });

    const [row] = await tenantDb
      .select()
      .from(estimateExtractions)
      .where(eq(estimateExtractions.id, ids[0]));

    // Recorded, so an unrecognized trade is visible instead of being a silent fallback.
    expect(row.metadataJson.tradeHintApplied).toBe(false);
    // Provenance is kept regardless — the walkthrough's own classification is not thrown away.
    expect(row.metadataJson.trade).toBe("scaffolding");
    // And the pricing key is NOT the unmatched trade: passing it would have produced
    // pricingScopeKey "scaffolding", which no rule matches.
    expect(row.metadataJson.pricingScopeKey).not.toBe("scaffolding");
    expect(isKnownTradeScopeKey("scaffolding")).toBe(false);
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

/** See the R12/R13/R14 block below: unwraps a SQLSTATE from either a raw PGlite error or a Drizzle
 *  error that nests the driver's under `cause`. */
async function sqlStateOfFailure(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    const err = error as { code?: string; cause?: { code?: string } };
    return err?.code ?? err?.cause?.code;
  }
  // Distinguishable from a wrong code: the write was supposed to FAIL and did not.
  return "no error was raised";
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
    // DERIVED server-side from (dealId, projectId, walkthroughId) — never accepted from the wire.
    // dealId AND projectId are both in the path because files.r2_key is UNIQUE and the idempotency
    // lookup treats (deal, project, walkthrough) as the identity: the same walkthrough may legitimately
    // be ingested onto two deals, or onto two projects within one deal, and each of those is a separate
    // document that therefore needs a separate object key.
    expect(file.r2Key).toBe(`walkthroughs/${DEAL}/${PROJECT}/${walkthroughId}/contact-sheet.jpg`);
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
    expect(doc.storageKey).toBe(`walkthroughs/${DEAL}/${PROJECT}/${walkthroughId}/contact-sheet.jpg`);
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

  // ── R6: the quantity band numeric(14,3) can actually represent ───────────────────────────────────
  //
  // The column is numeric(14,3): 11 integer digits, 3 decimals. Validation used to check only "finite
  // and > 0", which left BOTH ends of the column unguarded — and the two ends fail differently.
  it.each<[string, number]>([
    // Overflows the 11 integer digits. Postgres raises 22003 from inside the transaction: a 500, in a
    // validator whose entire contract is a 400 before the first write. This PR's own rollback test
    // uses 1e12 deliberately to force that error, so the path was known-reachable and unguarded.
    ["overflows the column's 11 integer digits", 1e11],
    ["overflows after rounding up at the ceiling", 99999999999.9996],
    // Rounds to exactly 0.000 — see the characterization below. Worse than the overflow because it
    // SUCCEEDS: a zero quantity, which `quantity <= 0` explicitly refuses, arrived silently.
    ["rounds away to zero at scale 3", 0.0001],
    ["rounds away to zero at scale 3 (upper edge)", 0.0004],
  ])("refuses a quantity that %s, naming the row, without writing anything", async (_label, quantity) => {
    const before = await tableCounts();

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33060"), {
          rows: [{ ...CARPENTRY_ROW, sourceScopeItemId: "scope-item-unrepresentable", quantity }],
        }),
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("scope-item-unrepresentable"),
    });

    expect(await tableCounts()).toEqual(before);
  });

  // THE HAZARD ITSELF, read back out of the database rather than asserted about the input.
  //
  // `insertWalkthroughExtractions` is exported and performs no validation, so it reaches the column
  // directly — which is what makes this a characterization of POSTGRES, not of the validator. If this
  // ever stops storing 0, the min-bound guard is arguing against a behaviour that no longer exists and
  // should be revisited. (Same result on real PostgreSQL 16.14: 0.0001 and 0.0004 both store 0.000,
  // 0.0005 rounds up to 0.001.)
  it("characterizes WHY the minimum exists: numeric(14,3) silently rounds 0.0001 to exactly zero", async () => {
    const walkthroughId = U("33061");
    const { documentId, parseRunId } = await seedChain(walkthroughId);

    const ids = await insertWalkthroughExtractions({
      tenantDb,
      input: {
        dealId: DEAL,
        projectId: PROJECT,
        documentId,
        parseRunId,
        walkthroughId,
        rows: [{ ...CARPENTRY_ROW, quantity: 0.0001 }],
      },
    });

    // READ BACK from Postgres. Asserting on the input would pass no matter what the column did, which
    // is the vacuous-test trap this PR has already been bitten by twice.
    const probe = await pg.query<{ stored: string; is_zero: boolean }>(
      `SELECT quantity::text AS stored, (quantity = 0) AS is_zero
         FROM public.estimate_extractions WHERE id = $1`,
      [ids[0]]
    );
    expect(probe.rows[0].stored).toBe("0.000");
    // Not "small" — exactly the zero the contract forbids, stored without any error being raised.
    expect(probe.rows[0].is_zero).toBe(true);

    // And the guard refuses that same value at the door, so the ingress cannot reach this state.
    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33062"), {
          rows: [{ ...CARPENTRY_ROW, quantity: 0.0001 }],
        }),
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  // The boundaries are INCLUSIVE, and stored intact. Without this, tightening the bounds to something
  // convenient (say ">= 1") would silently start refusing legitimate fractional quantities, and no test
  // would notice.
  //
  // The literals are SPELLED OUT rather than interpolated from the constants: that is what makes this
  // test able to fail when the bound moves. It is how R12 was caught here — lowering
  // MAX_WALKTHROUGH_QUANTITY from the extraction column's 99999999999.999 to the line item's
  // 999999999.999 turned this assertion red instead of quietly following the constant.
  it("accepts the exact minimum and maximum the promotion chain can represent, and stores them unchanged", async () => {
    const walkthroughId = U("33063");

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, {
        rows: [
          { ...CARPENTRY_ROW, sourceScopeItemId: "scope-min", quantity: MIN_WALKTHROUGH_QUANTITY },
          { ...CARPENTRY_ROW, sourceScopeItemId: "scope-max", quantity: MAX_WALKTHROUGH_QUANTITY },
        ],
      }),
    });

    const stored = await pg.query<{ stored: string }>(
      `SELECT quantity::text AS stored FROM public.estimate_extractions
        WHERE id = ANY($1::uuid[]) ORDER BY metadata_json->>'sourceScopeItemId'`,
      [result.extractionIds]
    );
    // scope-max sorts before scope-min. Both round-trip exactly — the min is not zero and the max did
    // not overflow. The max is the numeric(12,3) limit of estimate_line_items.quantity, NOT the
    // numeric(14,3) limit of the column being written here, which would also have stored fine.
    expect(stored.rows.map((r) => r.stored)).toEqual(["999999999.999", "0.001"]);
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

  // SECURITY. `files.r2_key` is what buildFileDownloadUrlFromRecord presigns, and it authorizes on the
  // row's DEAL association rather than on the key. So a caller-supplied key is a confused-deputy read
  // primitive: an authenticated user who knows any key in the bucket could alias it onto a deal they
  // legitimately access and download an object they were never entitled to. The key is therefore
  // DERIVED, and the wire cannot influence it.
  //
  // TWO layers close this, and this test covers the end-to-end property rather than either one alone:
  // `validateWalkthroughIngressPayload` rebuilds the payload from known fields, so an unknown
  // `contactSheetR2Key` never reaches the transaction; and the key is derived rather than read even if
  // it did. Verified by mutation: honouring a wire key from the RAW body (the pre-fix behaviour)
  // makes this fail with `deals/…/private-bid.pdf`. Note that mutating only the derivation site does
  // NOT fail it — validation has already stripped the field by then — so a future refactor that drops
  // the validator would still be caught here, and one that drops the derivation would be caught by a
  // caller who bypasses validation.
  it("ignores a hostile contact-sheet key smuggled in the payload", async () => {
    const walkthroughId = U("33020");
    const hostile = "deals/00000000-0000-4000-8000-000000099999/private-bid.pdf";

    const result = await ingestWalkthrough({
      tenantDb,
      payload: {
        ...walkthroughPayload(walkthroughId),
        // Not on WalkthroughIngressPayload any more — cast past the compiler to simulate a hostile
        // body reaching the service with the field the type no longer admits.
        contactSheetR2Key: hostile,
      } as WalkthroughIngressPayload,
    });

    const [file] = await tenantDb.select().from(files).where(eq(files.id, result.fileId));
    expect(file.r2Key).toBe(`walkthroughs/${DEAL}/${PROJECT}/${walkthroughId}/contact-sheet.jpg`);
    expect(file.r2Key).not.toContain("private-bid");
    expect(file.r2Key).not.toContain("099999");

    // The document's storage key is the same derived value — the aliasing surface is closed on both
    // the file row and the document that points at it.
    const [doc] = await tenantDb
      .select()
      .from(estimateSourceDocuments)
      .where(eq(estimateSourceDocuments.id, result.documentId));
    expect(doc.storageKey).toBe(`walkthroughs/${DEAL}/${PROJECT}/${walkthroughId}/contact-sheet.jpg`);
  });

  // ── CONCURRENT IDEMPOTENCY (the advisory lock) ────────────────────────────────────────────────────
  //
  // READ THIS BEFORE TRUSTING THE TEST BELOW IT. PGlite is a single-connection, in-process Postgres,
  // and drizzle's pglite driver implements `transaction()` on top of PGlite's own `transaction()`,
  // which holds an internal mutex. Two concurrent `ingestWalkthrough` calls against it therefore do
  // NOT overlap — the second BEGIN waits for the first COMMIT. So the outcome test below CANNOT
  // distinguish "the advisory lock serialized these" from "PGlite serialized these"; it is a
  // regression guard on the OUTCOME (one document, identical ids) and nothing more. Deleting the lock
  // leaves it green — verified, not assumed.
  //
  // The lock is therefore proved in two other ways instead:
  //   • "takes the advisory lock as its first statement" (below) proves the real service really
  //     executes a real `pg_advisory_xact_lock`, keyed on this walkthrough, BEFORE the lookup — the
  //     one ordering that makes it protective. That test fails if the lock is removed or moved.
  //   • Genuine two-connection concurrency was verified out-of-band against real PostgreSQL 16.14:
  //     two transactions held open past each other's lookup both insert WITHOUT the lock (2 documents)
  //     and exactly one inserts WITH it (1 document). That experiment cannot be expressed here because
  //     PGlite has one connection; it is recorded in the PR discussion.
  it("returns one document and one set of extractions for two overlapping ingress calls", async () => {
    const walkthroughId = U("33030");
    const rows = [
      CARPENTRY_ROW,
      { ...CARPENTRY_ROW, sourceScopeItemId: "scope-item-9301", rawLabel: "Reseal the coping joints" },
    ];

    const [first, second] = await Promise.all([
      ingestWalkthrough({ tenantDb, payload: walkthroughPayload(walkthroughId, { rows }) }),
      ingestWalkthrough({ tenantDb, payload: walkthroughPayload(walkthroughId, { rows }) }),
    ]);

    // Both callers get the SAME ids — neither can tell it lost, which is what idempotency owes them.
    expect(second).toEqual(first);

    // Exactly ONE document for this walkthrough, not two.
    const documents = await tenantDb
      .select({ id: estimateSourceDocuments.id })
      .from(estimateSourceDocuments)
      .where(eq(estimateSourceDocuments.contentHash, walkthroughId));
    expect(documents).toHaveLength(1);

    // ...and exactly one set of extractions under it, not the doubled scope an estimator would
    // otherwise have to de-duplicate by hand.
    const extractions = await tenantDb
      .select({ id: estimateExtractions.id })
      .from(estimateExtractions)
      .where(eq(estimateExtractions.documentId, first.documentId));
    expect(extractions).toHaveLength(2);
  });

  // THE MECHANISM, as opposed to the outcome. Records the statements the real service issues inside its
  // real transaction, so three things are checked that the outcome test cannot see: the lock statement
  // is issued at all, it is issued FIRST (a lock taken after the lookup guards nothing — both racers
  // would already have read "no document"), and it is keyed on THIS walkthrough rather than on some
  // constant that would serialize every ingress in the system.
  it("takes the advisory lock as its first statement, before the idempotency lookup", async () => {
    const walkthroughId = U("33031");
    const log: Array<{ kind: string; sql: string; params: unknown[] }> = [];

    // `ingestWalkthrough` touches `tenantDb` only to open a transaction, so a stub with just
    // `transaction` is a complete stand-in. The tx handed to the body is proxied to record what runs.
    const recordingDb = {
      transaction: (body: (tx: unknown) => unknown) =>
        tenantDb.transaction((tx: any) =>
          body(
            new Proxy(tx, {
              get(target, prop) {
                const value = Reflect.get(target, prop);
                if (prop === "execute" && typeof value === "function") {
                  return async (query: unknown) => {
                    const compiled = tenantDb.dialect.sqlToQuery(query);
                    log.push({ kind: "execute", sql: compiled.sql, params: compiled.params });
                    const result = await value.call(target, query);
                    // Observe the REAL lock the REAL statement just took, on the same transaction.
                    // A statement that parses but locks nothing would leave this at 0.
                    if (compiled.sql.includes("pg_advisory_xact_lock")) {
                      const held: any = await value.call(
                        target,
                        sql`select count(*)::int as n from pg_locks where locktype = 'advisory'`
                      );
                      const rows = held?.rows ?? held;
                      log.push({
                        kind: "advisory-locks-held",
                        sql: String(rows[0].n),
                        params: [],
                      });
                    }
                    return result;
                  };
                }
                if (
                  (prop === "select" || prop === "insert" || prop === "update") &&
                  typeof value === "function"
                ) {
                  return (...args: unknown[]) => {
                    log.push({ kind: prop, sql: "", params: [] });
                    return value.apply(target, args);
                  };
                }
                return typeof value === "function" ? value.bind(target) : value;
              },
            })
          )
        ),
    };

    await ingestWalkthrough({
      tenantDb: recordingDb as never,
      payload: walkthroughPayload(walkthroughId),
    });

    // FIRST statement in the transaction, full stop. Not "somewhere before the select" — first, so
    // there is no window at all between BEGIN and the lock.
    expect(log[0].kind).toBe("execute");
    expect(log[0].sql).toContain("pg_advisory_xact_lock");
    // The bigint mapping actually used. `hashtextextended` is Postgres 11+; if it ever has to become
    // `hashtext` for an older server, this assertion is the one that should be edited deliberately.
    expect(log[0].sql).toContain("hashtextextended");

    // Keyed on THIS walkthrough on THIS deal. A lock on a constant would serialize every walkthrough
    // in the CRM into a single queue; a lock keyed on the wrong values would serialize the wrong pairs.
    //
    // Asserted on the key's CONTENT, deliberately not by calling `walkthroughIngressLockKey` to build
    // the expected value. That version of this assertion was a TAUTOLOGY and was caught by mutation:
    // replacing the builder's body with a constant moved both sides of the comparison together and the
    // test stayed green. The two `toContain`s below are the load-bearing ones — they name the identity
    // the lock must be derived from, and no mutation of the builder can satisfy them without actually
    // including those values.
    const lockKey = String(log[0].params[0]);
    expect(lockKey).toContain(DEAL);
    expect(lockKey).toContain(walkthroughId);
    // Namespaced, because the single-argument advisory-lock key space is global to the database.
    expect(lockKey).toContain("walkthrough-ingress");
    // And the exported builder is what produced it, so callers and tests agree on one spelling.
    expect(lockKey).toBe(walkthroughIngressLockKey(DEAL, walkthroughId));

    // The lock is really HELD inside the transaction — the statement acquired something, rather than
    // merely being valid SQL.
    expect(log[1]).toMatchObject({ kind: "advisory-locks-held", sql: "1" });

    // ...and the idempotency lookup is the next thing to happen, i.e. it runs UNDER the lock.
    expect(log[2].kind).toBe("select");

    // Transaction-scoped: gone once the transaction ended, without an explicit unlock, so a failed or
    // crashed ingress cannot wedge this walkthrough forever.
    //
    // HONEST LIMIT of this last assertion: it characterizes `pg_advisory_xact_lock`'s own contract and
    // cannot fail while the statement above IS an xact lock, so it is not independently
    // mutation-verifiable (swapping in the session-scoped `pg_advisory_lock` is caught by the sql
    // assertion above, which fires first). It earns its place by catching the careless version of that
    // change — one where the sql assertion is "fixed" to match a session lock — which would leak a lock
    // per ingress until the connection was returned to the pool.
    const after = await pg.query<{ n: number }>(
      `select count(*)::int as n from pg_locks where locktype = 'advisory'`
    );
    expect(after.rows[0].n).toBe(0);
  });

  // R4. `contentHash` is a shared column with UNRELATED meanings per producer: an ordinary upload puts
  // the file's R2 KEY there (routes.ts hands createEstimateSourceDocument `contentHash:
  // uploadedFile.r2Key`), a walkthrough puts the walkthrough id. Nothing keeps those namespaces apart,
  // so the idempotency lookup has to say WHICH KIND of document it is willing to recognize. Without
  // that predicate the collision below makes the ingress "recognize" a plan set as this walkthrough's
  // prior ingest and replay it: trock-scope gets a 200 and a foreign document's ids, and the
  // walkthrough's scope is never written by anyone.
  it("does not mistake a foreign document type sharing the contentHash for a prior ingest", async () => {
    const walkthroughId = U("33040");

    // A NON-walkthrough document on the same (deal, project) whose contentHash collides exactly.
    const foreignFileId = await createWalkthroughContactSheetFile({
      tenantDb,
      input: {
        dealId: DEAL,
        walkthroughId: U("33041"),
        siteLabel: "A plan set",
        r2Key: `plans/${walkthroughId}/plan-set.pdf`,
        r2Bucket: CRM_BUCKET,
        bytes: 4096,
        mimeType: "application/pdf",
        capturedAt: "2026-07-29T14:05:00Z",
        userId: USER,
      },
    });
    const [foreign] = await tenantDb
      .insert(estimateSourceDocuments)
      .values({
        dealId: DEAL,
        projectId: PROJECT,
        fileId: foreignFileId,
        rootFileId: foreignFileId,
        documentType: "plan",
        filename: "Level 2 plan set.pdf",
        mimeType: "application/pdf",
        // THE COLLISION: a plan set whose content hash happens to equal this walkthrough's id.
        contentHash: walkthroughId,
        parseStatus: "completed",
        ocrStatus: "completed",
        uploadedByUserId: USER,
      })
      .returning({ id: estimateSourceDocuments.id });

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId),
    });

    // The walkthrough got its OWN document, not the plan set's id.
    expect(result.documentId).not.toBe(foreign.id);
    const [ingested] = await tenantDb
      .select({ documentType: estimateSourceDocuments.documentType })
      .from(estimateSourceDocuments)
      .where(eq(estimateSourceDocuments.id, result.documentId));
    expect(ingested.documentType).toBe("walkthrough");

    // And its scope rows exist, under its own document — the thing a replay would have skipped.
    const extractions = await tenantDb
      .select({ id: estimateExtractions.id })
      .from(estimateExtractions)
      .where(eq(estimateExtractions.documentId, result.documentId));
    expect(extractions).toHaveLength(1);
    expect(result.extractionIds).toEqual(extractions.map((row: { id: string }) => row.id));
  });

  // R5. The replay used to `.filter()` unmatched rows away, so a retry whose rows had drifted got back
  // FEWER ids than it posted, with a 200 — the sender then recorded utterances as landed that nothing
  // had ever stored. A retry cannot add rows to an already-ingested walkthrough (the document exists,
  // so every future attempt replays it), which is exactly why silence here is unrecoverable: there is
  // no later attempt that fixes it.
  it("refuses a retry whose rows drifted, naming the scope items it cannot account for", async () => {
    const walkthroughId = U("33050");
    const rows = [CARPENTRY_ROW];

    const first = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { rows }),
    });
    const afterFirst = await tableCounts();

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(walkthroughId, {
          rows: [
            CARPENTRY_ROW,
            { ...CARPENTRY_ROW, sourceScopeItemId: "scope-item-drifted", rawLabel: "A new utterance" },
          ],
        }),
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      // NAMED. "some rows are missing" is not something the sender can act on.
      message: expect.stringContaining("scope-item-drifted"),
    });

    // The refusal writes nothing — it is not a partial ingest of the new row.
    expect(await tableCounts()).toEqual(afterFirst);
    const extractions = await tenantDb
      .select({ id: estimateExtractions.id })
      .from(estimateExtractions)
      .where(eq(estimateExtractions.documentId, first.documentId));
    expect(extractions).toHaveLength(1);
  });

  // The OTHER direction, unchanged on purpose: rows the stored document has that this payload did not
  // name are still that walkthrough's rows, so they are appended rather than treated as an error. Only
  // a payload row with no STORED counterpart is a conflict.
  it("still replays stored rows the retry's payload does not mention", async () => {
    const walkthroughId = U("33051");
    const rows = [
      CARPENTRY_ROW,
      { ...CARPENTRY_ROW, sourceScopeItemId: "scope-item-9501", rawLabel: "Reflash the parapet" },
    ];

    const first = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { rows }),
    });

    // A retry naming only the FIRST row. Nothing is unaccounted for — every row it posted is stored —
    // so it succeeds, and the answer still describes the whole walkthrough.
    const second = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { rows: [CARPENTRY_ROW] }),
    });

    expect(second.documentId).toBe(first.documentId);
    expect(second.extractionIds).toHaveLength(2);
    // The named row comes first (payload order), the unnamed one is appended.
    expect(second.extractionIds[0]).toBe(first.extractionIds[0]);
    expect([...second.extractionIds].sort()).toEqual([...first.extractionIds].sort());
  });

  // R7. Matching a retry's rows on `sourceScopeItemId` proves a row with that id EXISTS; it does not
  // prove it still says the same thing. A retry that kept the id and corrected the quantity used to be
  // treated as a clean replay — 200, original row kept — so trock-scope believed the correction had
  // landed while the estimator went on pricing the old number. Same disagreement as an unmatched id,
  // one level down, and it was completely silent.
  it("refuses a replay whose row contents changed under an unchanged sourceScopeItemId", async () => {
    const walkthroughId = U("33070");

    const first = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { rows: [CARPENTRY_ROW] }),
    });

    // The dangerous retry: same id, a quantity corrected by a factor of ten.
    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(walkthroughId, {
          rows: [{ ...CARPENTRY_ROW, quantity: 125 }],
        }),
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining(CARPENTRY_ROW.sourceScopeItemId),
    });

    // READ BACK FROM THE DATABASE, not from what the rejected call returned. The failure mode being
    // guarded is "the original row was silently kept", so the only assertion that can detect it is one
    // that looks at the stored row. Asserting on a return value would pass either way.
    const [stored] = await tenantDb
      .select()
      .from(estimateExtractions)
      .where(eq(estimateExtractions.id, first.extractionIds[0]));
    expect(Number(stored.quantity)).toBe(12.5);
    // ...and no second row was written for the corrected content either.
    const all = await tenantDb
      .select({ id: estimateExtractions.id })
      .from(estimateExtractions)
      .where(eq(estimateExtractions.documentId, first.documentId));
    expect(all).toHaveLength(1);
  });

  // Each case gets its OWN walkthrough id, spelled out rather than derived from the label: two derived
  // ids collided in the first draft of this test, which made one case's "first ingest" a replay of
  // another case's document instead of a fresh one. It still passed, for the wrong reason.
  it.each<[string, string, Partial<WalkthroughScopeRow>]>([
    ["rawLabel", U("33080"), { rawLabel: "Replace rotted carpentry at the eave" }],
    ["unit", U("33081"), { unit: "SF" }],
    ["divisionHint", U("33082"), { divisionHint: "roofing" }],
    ["trade", U("33083"), { trade: "roofing" }],
    ["locationLabel", U("33084"), { locationLabel: "South elevation, eave" }],
    ["the evidence timeline offset", U("33085"), { evidence: { ...CARPENTRY_ROW.evidence, timelineMs: 999_000 } }],
    ["the evidence clip", U("33086"), { evidence: { ...CARPENTRY_ROW.evidence, clipId: "clip-z" } }],
    ["the evidence frame", U("33087"), { evidence: { ...CARPENTRY_ROW.evidence, frameKey: "frames/clip-a/00999000.jpg" } }],
  ])("treats a changed %s as drift rather than a replay", async (_label, walkthroughId, override) => {
    const first = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { rows: [CARPENTRY_ROW] }),
    });
    // Proof this case really did create its own document rather than replaying another's.
    expect(first.extractionIds).toHaveLength(1);

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(walkthroughId, {
          rows: [{ ...CARPENTRY_ROW, ...override }],
        }),
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  // The other half of the contract: a TRUE retry must still be free. If the fingerprint were unstable
  // (key order, number formatting, a timestamp folded in) every retry would 409 and the seam would be
  // worse than before this check existed.
  it("still replays a byte-identical retry, and ignores a re-scored confidence", async () => {
    const walkthroughId = U("33090");
    const rows = [
      CARPENTRY_ROW,
      { ...CARPENTRY_ROW, sourceScopeItemId: "scope-item-9701", rawLabel: "Reflash the parapet" },
    ];

    const first = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { rows }),
    });
    const second = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { rows }),
    });
    expect(second).toEqual(first);

    // Confidence is deliberately OUTSIDE the fingerprint: a re-scored confidence on identical content is
    // the model changing its mind about the same utterance, not the utterance changing. Failing a retry
    // over it would be noise, so this must still replay.
    const third = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, {
        rows: rows.map((row) => ({ ...row, confidence: 0.42 })),
      }),
    });
    expect(third).toEqual(first);
  });

  // Casing is not semantic drift, because the validator canonicalizes `trade` before it is fingerprinted
  // or stored. Worth pinning: if canonicalization moved after the fingerprint, every sender that changed
  // its capitalization would start getting 409s.
  it("does not treat a trade's capitalization as drift", async () => {
    const walkthroughId = U("33091");

    const first = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { rows: [CARPENTRY_ROW] }),
    });
    const second = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, {
        rows: [{ ...CARPENTRY_ROW, trade: "  CARPENTRY  " }],
      }),
    });

    expect(second).toEqual(first);
  });

  // R8. The lookup keys on (dealId, projectId, contentHash, documentType), so the same walkthrough on
  // two projects within ONE deal is deliberately two documents — but the derived object key omitted the
  // project, so both wanted the same `files.r2_key` and the second died on the unique index with a
  // 23505 after passing the lookup. The derived key and the lookup key have to describe the same
  // identity.
  it("ingests the same walkthrough onto two projects of one deal, with distinct object keys", async () => {
    const walkthroughId = U("33100");
    const otherProject = U("44445");

    const first = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { projectId: PROJECT }),
    });
    // This is the call that used to fail with a 23505.
    const second = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { projectId: otherProject }),
    });

    expect(second.documentId).not.toBe(first.documentId);
    expect(second.fileId).not.toBe(first.fileId);

    const [firstFile] = await tenantDb.select().from(files).where(eq(files.id, first.fileId));
    const [secondFile] = await tenantDb.select().from(files).where(eq(files.id, second.fileId));
    expect(firstFile.r2Key).toBe(`walkthroughs/${DEAL}/${PROJECT}/${walkthroughId}/contact-sheet.jpg`);
    expect(secondFile.r2Key).toBe(
      `walkthroughs/${DEAL}/${otherProject}/${walkthroughId}/contact-sheet.jpg`
    );
    expect(firstFile.r2Key).not.toBe(secondFile.r2Key);
  });

  // The null-project sentinel. A deal-level walkthrough and a project-level one must not collapse onto
  // one path, and `_none` cannot be mistaken for a project id because projectId is validated as a UUID.
  it("keeps a deal-level walkthrough on a distinct key from a project-level one", async () => {
    const walkthroughId = U("33101");

    const dealLevel = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { projectId: null }),
    });
    const projectLevel = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { projectId: PROJECT }),
    });

    expect(dealLevel.documentId).not.toBe(projectLevel.documentId);
    const [dealFile] = await tenantDb.select().from(files).where(eq(files.id, dealLevel.fileId));
    expect(dealFile.r2Key).toBe(
      `walkthroughs/${DEAL}/${WALKTHROUGH_NO_PROJECT_KEY_SEGMENT}/${walkthroughId}/contact-sheet.jpg`
    );
    // The sentinel is not a UUID, so no real projectId can ever produce this same path.
    expect(WALKTHROUGH_NO_PROJECT_KEY_SEGMENT).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  // R9. `projectId` is compared against a uuid column by the idempotency lookup, so a non-UUID string
  // was a 22P02 from inside the transaction — a 500 out of a validator whose contract is a 400 before
  // the first write.
  it.each([["a slug", "proj-1"], ["a name", "Building B"], ["a truncated uuid", "00000000-0000-4000"]])(
    "refuses a projectId that is %s, without writing anything",
    async (_label, projectId) => {
      const before = await tableCounts();

      await expect(
        ingestWalkthrough({
          tenantDb,
          payload: walkthroughPayload(U("33110"), { projectId }),
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("projectId"),
      });

      expect(await tableCounts()).toEqual(before);
    }
  );

  // R10. rawLabel is unbounded `text` here but promotion copies it into
  // estimate_line_items.description, a varchar(500) — so an over-long label is accepted, generated,
  // APPROVED by an estimator, and only then fails promotion with a 22001.
  it("refuses a rawLabel longer than the promotable description column, naming the row", async () => {
    const before = await tableCounts();

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33120"), {
          rows: [
            {
              ...CARPENTRY_ROW,
              sourceScopeItemId: "scope-item-verbose",
              rawLabel: "x".repeat(MAX_WALKTHROUGH_RAW_LABEL_CHARS + 1),
            },
          ],
        }),
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("scope-item-verbose"),
    });

    expect(await tableCounts()).toEqual(before);
  });

  // The boundary is inclusive, and the label reaches the column intact — so a future "tidy up" that
  // truncated instead of refusing, or that tightened the bound, fails here.
  it("accepts a rawLabel of exactly the limit and stores it whole", async () => {
    const label = "y".repeat(MAX_WALKTHROUGH_RAW_LABEL_CHARS);

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(U("33121"), { rows: [{ ...CARPENTRY_ROW, rawLabel: label }] }),
    });

    const [row] = await tenantDb
      .select()
      .from(estimateExtractions)
      .where(eq(estimateExtractions.id, result.extractionIds[0]));
    expect(row.rawLabel).toBe(label);
    expect(row.rawLabel).toHaveLength(MAX_WALKTHROUGH_RAW_LABEL_CHARS);
    // The value that has to survive promotion is the one that actually landed in the column.
    expect(row.rawLabel.length).toBeLessThanOrEqual(500);
  });

  // ── R12/R13/R14: the promotion chain NARROWS ──────────────────────────────────────────────────────
  //
  // The SQLSTATE of a failed write, whether PGlite threw it raw (the direct `pg.query` probes below) or
  // Drizzle wrapped it (the `insertWalkthroughExtractions` probes, where the driver error is nested
  // under `cause`). Asserting the CODE rather than the message is what makes these pin the constraint
  // instead of Postgres's wording — and 22003 vs 22001 is exactly the distinction under test.
  //
  // These tests exist because the bug they pin is invisible from inside this module: every value they
  // refuse is a value `estimate_extractions` would have stored happily. The narrowing only shows up two
  // tables later, at promotion, after an estimator has approved the row — so each test proves BOTH
  // halves against real SQL: that the insert target accepts the value, and that the promotion target
  // does not. Asserting only "ingress said 400" would pass just as well if the downstream column were
  // wide and the bound were pointless.

  // R12. THE CORE PROOF. 1e9 fits estimate_extractions.quantity (numeric(14,3), eleven integer digits)
  // and does NOT fit estimate_line_items.quantity (numeric(12,3), nine) — so before this fix it was
  // accepted, priced, approved, and only then failed promotion with a 22003.
  it("refuses a quantity estimate_extractions can store but a promoted line item cannot", async () => {
    // Between the two limits by construction: over the line item's max, under the extraction's.
    const overPromotable = 1_000_000_000;
    expect(overPromotable).toBeGreaterThan(MAX_WALKTHROUGH_QUANTITY);

    // HALF ONE — the column this module inserts into takes it. Proven by calling the exported helper,
    // which performs NO validation, and reading the value back out of Postgres.
    const walkthroughId = U("33130");
    const { documentId, parseRunId } = await seedChain(walkthroughId);
    const ids = await insertWalkthroughExtractions({
      tenantDb,
      input: {
        dealId: DEAL,
        projectId: PROJECT,
        documentId,
        parseRunId,
        walkthroughId,
        rows: [{ ...CARPENTRY_ROW, quantity: overPromotable }],
      },
    });
    const stored = await pg.query<{ stored: string }>(
      `SELECT quantity::text AS stored FROM public.estimate_extractions WHERE id = $1`,
      [ids[0]]
    );
    // Stored EXACTLY. This is why bounding to the insert target was not enough: nothing here complains.
    expect(stored.rows[0].stored).toBe("1000000000.000");

    // HALF TWO — the column promotion copies it into REFUSES it, with the error the estimator would
    // have hit after approving the row. Raw SQL against the real numeric(12,3), not a mock.
    const sectionId = U("33131");
    await pg.query(`INSERT INTO public.estimate_sections (id, deal_id, name) VALUES ($1, $2, $3)`, [
      sectionId,
      DEAL,
      "Carpentry",
    ]);
    // 22003 = numeric field overflow. THE failure this bound exists to move to ingress.
    expect(
      await sqlStateOfFailure(
        pg.query(
          `INSERT INTO public.estimate_line_items (deal_id, section_id, description, quantity)
             VALUES ($1, $2, $3, $4)`,
          [DEAL, sectionId, "Replace rotted carpentry at eave", String(overPromotable)]
        )
      )
    ).toBe("22003");

    // HALF THREE — so ingress refuses it at the door, naming the row, and writes nothing.
    const before = await tableCounts();
    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33132"), {
          rows: [
            {
              ...CARPENTRY_ROW,
              sourceScopeItemId: "scope-item-unpromotable-qty",
              quantity: overPromotable,
            },
          ],
        }),
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("scope-item-unpromotable-qty"),
    });
    expect(await tableCounts()).toEqual(before);
  });

  // R13. unit was accepted as an arbitrary string against a varchar(50), so a longer value was a 22001
  // from the middle of the transaction and a 500 to the sender — not the 400 this validator promises.
  it("refuses a unit longer than the varchar(50) every column in the chain uses", async () => {
    // The column really is this narrow — proven by reaching it directly, since the whole point is that
    // the validator used not to.
    const walkthroughId = U("33133");
    const { documentId, parseRunId } = await seedChain(walkthroughId);
    // 22001 = value too long for type character varying(50).
    expect(
      await sqlStateOfFailure(
        insertWalkthroughExtractions({
          tenantDb,
          input: {
            dealId: DEAL,
            projectId: PROJECT,
            documentId,
            parseRunId,
            walkthroughId,
            rows: [{ ...CARPENTRY_ROW, unit: "u".repeat(MAX_WALKTHROUGH_UNIT_CHARS + 1) }],
          },
        })
      )
    ).toBe("22001");

    const before = await tableCounts();
    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33134"), {
          rows: [
            {
              ...CARPENTRY_ROW,
              sourceScopeItemId: "scope-item-wide-unit",
              unit: "u".repeat(MAX_WALKTHROUGH_UNIT_CHARS + 1),
            },
          ],
        }),
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("scope-item-wide-unit"),
    });
    expect(await tableCounts()).toEqual(before);
  });

  it("accepts a unit of exactly 50 characters and stores it whole", async () => {
    const unit = "u".repeat(MAX_WALKTHROUGH_UNIT_CHARS);

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(U("33135"), { rows: [{ ...CARPENTRY_ROW, unit }] }),
    });

    // Read back from the column, not from the input.
    const stored = await pg.query<{ unit: string; len: number }>(
      `SELECT unit, length(unit)::int AS len FROM public.estimate_extractions WHERE id = $1`,
      [result.extractionIds[0]]
    );
    expect(stored.rows[0].unit).toBe(unit);
    expect(stored.rows[0].len).toBe(MAX_WALKTHROUGH_UNIT_CHARS);
  });

  // R14. The finding the audit turned up: divisionHint is unbounded `text` on the extraction, but
  // promotion makes it the estimate's SECTION NAME, and estimate_sections.name is varchar(255).
  it("refuses a divisionHint longer than the section-name column promotion writes it to", async () => {
    const overWide = "d".repeat(MAX_WALKTHROUGH_DIVISION_HINT_CHARS + 1);

    // HALF ONE — the extraction column is unbounded text and stores it in full.
    const walkthroughId = U("33136");
    const { documentId, parseRunId } = await seedChain(walkthroughId);
    const ids = await insertWalkthroughExtractions({
      tenantDb,
      input: {
        dealId: DEAL,
        projectId: PROJECT,
        documentId,
        parseRunId,
        walkthroughId,
        rows: [{ ...CARPENTRY_ROW, divisionHint: overWide }],
      },
    });
    const stored = await pg.query<{ len: number }>(
      `SELECT length(division_hint)::int AS len FROM public.estimate_extractions WHERE id = $1`,
      [ids[0]]
    );
    expect(stored.rows[0].len).toBe(MAX_WALKTHROUGH_DIVISION_HINT_CHARS + 1);

    // HALF TWO — and the section-name lookup promotion does FIRST does not catch it either: comparing
    // a varchar(255) column against a longer parameter simply misses, no error. That is what lets the
    // over-long hint reach the INSERT instead of being treated as "no such section yet".
    const miss = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.estimate_sections WHERE name = $1`,
      [overWide]
    );
    expect(miss.rows[0].n).toBe(0);

    // HALF THREE — so promotion reaches createSection's INSERT, which is where it dies.
    // 22001 = value too long for type character varying(255).
    expect(
      await sqlStateOfFailure(
        pg.query(`INSERT INTO public.estimate_sections (deal_id, name) VALUES ($1, $2)`, [
          DEAL,
          overWide,
        ])
      )
    ).toBe("22001");

    // HALF FOUR — refused at ingress instead, naming the row, writing nothing.
    const before = await tableCounts();
    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33137"), {
          rows: [
            {
              ...CARPENTRY_ROW,
              sourceScopeItemId: "scope-item-wide-division",
              divisionHint: overWide,
            },
          ],
        }),
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("scope-item-wide-division"),
    });
    expect(await tableCounts()).toEqual(before);
  });

  // The boundary is inclusive AND promotable: the exact-limit hint has to survive the section INSERT,
  // which is the only thing that makes 255 the right number rather than a guess.
  it("accepts a divisionHint of exactly 255 characters, and promotion can section on it", async () => {
    const divisionHint = "e".repeat(MAX_WALKTHROUGH_DIVISION_HINT_CHARS);

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(U("33138"), { rows: [{ ...CARPENTRY_ROW, divisionHint }] }),
    });

    const stored = await pg.query<{ hint: string }>(
      `SELECT division_hint AS hint FROM public.estimate_extractions WHERE id = $1`,
      [result.extractionIds[0]]
    );
    expect(stored.rows[0].hint).toBe(divisionHint);

    // The value that landed in the column is the one promotion will hand to createSection — so put it
    // there, exactly as promotion would, and prove it fits.
    const section = await pg.query<{ len: number }>(
      `INSERT INTO public.estimate_sections (deal_id, name) VALUES ($1, $2)
         RETURNING length(name)::int AS len`,
      [DEAL, stored.rows[0].hint]
    );
    expect(section.rows[0].len).toBe(MAX_WALKTHROUGH_DIVISION_HINT_CHARS);
  });

  // R14, payload level. siteLabel and walkthroughId are not scope-row fields and never reach an
  // extraction, but ingress COMPOSES them into varchar(500) columns on the `files` row — which is the
  // FIRST write of the transaction, so an over-long one was a 22001 and a 500 rather than a 400.
  it("refuses a siteLabel too long for the display name it is composed into", async () => {
    const before = await tableCounts();

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33139"), {
          siteLabel: "s".repeat(MAX_WALKTHROUGH_SITE_LABEL_CHARS + 1),
        }),
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("siteLabel"),
    });

    expect(await tableCounts()).toEqual(before);
  });

  // The bound is DERIVED from the builder that does the composing, so the interesting assertion is not
  // "500 - 23 = 477" but "the exact-limit label composes to exactly the column width" — which stays
  // true if someone edits the prefix, and fails if the derivation is replaced by a literal.
  it("accepts a siteLabel of exactly the limit, filling display_name to precisely 500", async () => {
    const siteLabel = "s".repeat(MAX_WALKTHROUGH_SITE_LABEL_CHARS);

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(U("33140"), { siteLabel }),
    });

    const stored = await pg.query<{ len: number; name: string }>(
      `SELECT length(display_name)::int AS len, display_name AS name FROM public.files WHERE id = $1`,
      [result.fileId]
    );
    expect(stored.rows[0].len).toBe(500);
    expect(stored.rows[0].name).toBe(buildWalkthroughContactSheetDisplayName(siteLabel));
  });

  it("refuses a walkthroughId too long for the system filename it is composed into", async () => {
    const before = await tableCounts();

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload("w".repeat(MAX_WALKTHROUGH_ID_CHARS + 1)),
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("walkthroughId"),
    });

    expect(await tableCounts()).toEqual(before);
  });

  // Two claims in one, because the walkthroughId bound rests on both: the exact-limit id fills
  // system_filename to precisely 500, AND the r2 key it also composes into stays inside varchar(1000).
  // The second is what makes "system_filename is the tighter of the two" a checked statement rather
  // than a comment — if the key format ever grows past its ~895-character slack, this fails.
  it("accepts a walkthroughId of exactly the limit, and its r2 key still fits varchar(1000)", async () => {
    const walkthroughId = "w".repeat(MAX_WALKTHROUGH_ID_CHARS);

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId),
    });

    const stored = await pg.query<{ filename_len: number; key_len: number }>(
      `SELECT length(system_filename)::int AS filename_len, length(r2_key)::int AS key_len
         FROM public.files WHERE id = $1`,
      [result.fileId]
    );
    expect(stored.rows[0].filename_len).toBe(500);
    expect(stored.rows[0].key_len).toBeLessThanOrEqual(1000);
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
      }),
    });

    // Dedupe is on (dealId, projectId, contentHash) — the same triple document-service.ts:104-130
    // uses — so it cannot swallow a legitimate second ingress onto a different deal.
    expect(other.documentId).not.toBe(first.documentId);
  });
});

// R3 — THE DATA-LOSS PATH THROUGH AN ALREADY-SHIPPED ENDPOINT.
//
// `POST /:id/estimating/documents/:documentId/reprocess` means "throw the parse away and derive it
// again from the file". That is coherent for a plan set and destructive for a walkthrough, whose rows
// were never parsed from its file in the first place — they were spoken on site and ingested from TROCK
// Scope, and the "file" is only a contact sheet of evidence frames.
//
// Left unguarded, reprocessing a walkthrough clears `active_parse_run_id` and queues the generic OCR
// worker; the worker parses the CONTACT-SHEET IMAGE, and `activateCompletedParseRun`
// (document-parse-orchestrator.ts:173-182) then sets every extraction's `activeArtifact` to
// `sourceParseRunId = <the new run>`. The real walkthrough rows do not match it, so all of them flip
// inactive and disappear from the workbench, replaced by priced stubs derived from an image filename.
//
// These tests do not run the worker. They pin the two facts that make the hazard real and the guard
// necessary: reprocess DOES null the active parse run (proved on the ordinary document, where that is
// correct), and the walkthrough's rows are hidden the moment their run pointer stops matching (already
// proved by "drops the row when ONLY its sourceParseRunId stops matching", below). The guard is what
// keeps those two facts from meeting.
describe("reprocessEstimateSourceDocument on a walkthrough document", () => {
  it("refuses, leaves the parse run intact, and never queues the OCR worker", async () => {
    const walkthroughId = U("55001");
    const enqueue = vi.fn(async () => {});

    const ingested = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { dealId: REPROCESS_DEAL, projectId: null }),
    });

    await expect(
      reprocessEstimateSourceDocument({
        tenantDb,
        enqueueEstimateDocumentOcr: enqueue,
        input: {
          dealId: REPROCESS_DEAL,
          documentId: ingested.documentId,
          userId: USER,
          officeId: null,
        },
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      // The message has to tell an operator what to do INSTEAD, or they will just try again.
      message: expect.stringContaining("Re-ingest the walkthrough from TROCK Scope"),
    });

    // Nothing was queued — a walkthrough must never reach the generic OCR worker.
    expect(enqueue).not.toHaveBeenCalled();

    // The document is untouched: the active run still points at the ingested run, so the rows are still
    // live. A refusal that had already written the UPDATE would have destroyed the scope anyway.
    const [doc] = await tenantDb
      .select()
      .from(estimateSourceDocuments)
      .where(eq(estimateSourceDocuments.id, ingested.documentId));
    expect(doc.activeParseRunId).toBe(ingested.parseRunId);
    expect(doc.parseStatus).toBe("completed");
    expect(doc.ocrStatus).toBe("completed");
    expect(doc.parsedAt).not.toBeNull();

    // And the estimator still sees the scope — the actual thing being protected, asserted through the
    // real workbench service rather than inferred from the columns above.
    const state = await buildEstimatingWorkbenchState(tenantDb, REPROCESS_DEAL);
    expect(state.extractionRows.map((row: { id: string }) => row.id)).toEqual(ingested.extractionIds);
  });

  it("still reprocesses an ordinary parsed document, clearing its active run and queueing the worker", async () => {
    const enqueue = vi.fn(async () => {});
    const fileId = await createWalkthroughContactSheetFile({
      tenantDb,
      input: {
        dealId: DEAL,
        walkthroughId: U("55002"),
        siteLabel: "Level 2 plans",
        r2Key: "plans/55002/level-2.pdf",
        r2Bucket: CRM_BUCKET,
        bytes: 8192,
        mimeType: "application/pdf",
        capturedAt: "2026-07-29T14:05:00Z",
        userId: USER,
      },
    });

    // An ordinary parsed plan set, complete with an active parse run, so the ONLY difference from the
    // walkthrough above is `documentType`. That is what makes this the control: if the guard were
    // keyed on anything else (parse provider, filename, storage key), this test would fail too.
    const [doc] = await tenantDb
      .insert(estimateSourceDocuments)
      .values({
        dealId: DEAL,
        fileId,
        rootFileId: fileId,
        documentType: "plan",
        filename: "Level 2 plans.pdf",
        mimeType: "application/pdf",
        parseStatus: "completed",
        ocrStatus: "completed",
        parsedAt: new Date(),
        uploadedByUserId: USER,
      })
      .returning({ id: estimateSourceDocuments.id });
    const [run] = await tenantDb
      .insert(estimateDocumentParseRuns)
      .values({ documentId: doc.id, status: "completed", completedAt: new Date() })
      .returning({ id: estimateDocumentParseRuns.id });
    await tenantDb
      .update(estimateSourceDocuments)
      .set({ activeParseRunId: run.id })
      .where(eq(estimateSourceDocuments.id, doc.id));

    const result = await reprocessEstimateSourceDocument({
      tenantDb,
      enqueueEstimateDocumentOcr: enqueue,
      input: { dealId: DEAL, documentId: doc.id, userId: USER, officeId: null },
    });

    expect(result).not.toBeNull();
    expect(enqueue).toHaveBeenCalledTimes(1);

    // ...and this is the destructive step itself, proved on the document where it is CORRECT: the
    // active run is cleared and the document goes back to queued. On a walkthrough, that null is what
    // orphans the ingested rows.
    const [after] = await tenantDb
      .select()
      .from(estimateSourceDocuments)
      .where(eq(estimateSourceDocuments.id, doc.id));
    expect(after.activeParseRunId).toBeNull();
    expect(after.parseStatus).toBe("queued");
    expect(after.ocrStatus).toBe("queued");
    expect(after.parsedAt).toBeNull();
  });

  it("still reports a document that does not exist as not-found rather than refusing it", async () => {
    const enqueue = vi.fn(async () => {});
    // The guard must not turn the 404 path into a 400 — the route relies on a null return here.
    const result = await reprocessEstimateSourceDocument({
      tenantDb,
      enqueueEstimateDocumentOcr: enqueue,
      input: { dealId: DEAL, documentId: U("55009"), userId: USER, officeId: null },
    });

    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
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
