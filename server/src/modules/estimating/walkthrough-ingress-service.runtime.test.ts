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
  offices,
  users,
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
  projects,
  properties,
} from "@trock-crm/shared/schema";
import type { WalkthroughIngressPayload, WalkthroughScopeRow } from "@trock-crm/shared/types";
import { tenantSchemaSql } from "../../../tests/helpers/tenant-schema-from-drizzle.js";
// The ceiling the ingress REUSES rather than re-declares — see the contactSheetBytes tests below.
import { MAX_FILE_SIZE_BYTES } from "../files/file-constants.js";
import { MAX_THUMBNAIL_SOURCE_BYTES } from "../../lib/image-thumbnail-constants.js";
// R30. The Files subsystem's OWN thumbnail-key derivation, imported rather than restated: the collision
// this seam had was between a walkthrough's ORIGINAL key and another walkthrough's THUMBNAIL key, and a
// hand-written copy of the second would let the two drift apart and the test go quietly vacuous. Safe to
// import here despite the ingress module's no-sharp rule — that module already imports
// `isThumbnailableImage` from this same file, so it is on the suite's graph either way.
import { deriveThumbnailKey } from "../../lib/image-thumbnail.js";

/** The narrower of the two ceilings ingress must satisfy — see the R26 comment in the service. */
const BINDING_CEILING = Math.min(MAX_FILE_SIZE_BYTES, MAX_THUMBNAIL_SOURCE_BYTES);
// R22. `createEstimateSourceDocument` is the OTHER producer — the one whose dedupe has no documentType
// predicate. The namespace test at the bottom of this file drives the real function rather than reasoning
// about it.
import {
  createEstimateSourceDocument,
  reprocessEstimateSourceDocument,
} from "./document-service.js";
import { buildEstimatingWorkbenchState } from "./workbench-service.js";
import type { WalkthroughContactSheetStore } from "./walkthrough-ingress-service.js";
import {
  buildWalkthroughContactSheetDisplayName,
  createWalkthroughContactSheetFile,
  createWalkthroughSourceDocument,
  deriveWalkthroughContactSheetR2Key,
  encodeWalkthroughIdKeySegment,
  getCrmFileBucket,
  ingestWalkthrough as ingestWalkthroughService,
  insertWalkthroughExtractions,
  MAX_WALKTHROUGH_DIVISION_HINT_CHARS,
  MAX_WALKTHROUGH_ENCODED_ID_CHARS,
  MAX_WALKTHROUGH_ID_CHARS,
  MAX_WALKTHROUGH_QUANTITY,
  MAX_WALKTHROUGH_RAW_LABEL_CHARS,
  MAX_WALKTHROUGH_SCOPE_ROWS,
  MAX_WALKTHROUGH_SITE_LABEL_CHARS,
  MAX_WALKTHROUGH_UNIT_CHARS,
  MIN_WALKTHROUGH_QUANTITY,
  validateWalkthroughIngressPayload,
  WALKTHROUGH_NO_PROJECT_KEY_SEGMENT,
  walkthroughContentHash,
  walkthroughIngressLockKey,
} from "./walkthrough-ingress-service.js";

/**
 * R23/R25. The object store the ingress verifies its contact sheet through, faked.
 *
 * DEFAULTS TO A HEALTHY STORE THAT AGREES WITH THE PAYLOAD — configured, the object present, its
 * Content-Type and Content-Length exactly what was declared. That is deliberate: every one of this
 * suite's ~60 happy-path ingests now runs THROUGH the verification, so a guard that refused a valid
 * upload would break all of them rather than hiding behind a stub that says "not configured".
 *
 * The two thumbnail fakes SELF-GATE on mime type exactly as the real helpers do
 * (`isThumbnailableImage` / `isPdfThumbnailable`), because the implementation calls them as a fallback
 * CHAIN rather than branching on the mime type — a fake that answered for both types would make the
 * chain's order unobservable.
 *
 * They also return the key the REAL helpers return — `deriveThumbnailKey(r2Key)`, which both arms use
 * (image-thumbnail.ts:62, pdf-thumbnail.ts:164) — rather than an invented `thumbnails/<key>` prefix.
 * That is not cosmetic: `files.thumbnail_r2_key` is a varchar(1000) like `r2_key` and the derived
 * thumbnail is SEVEN characters longer than its original, which makes it the column that actually binds
 * `MAX_WALKTHROUGH_ENCODED_ID_CHARS`. A fake with different overhead would put the boundary test's
 * limit in the wrong place — the environment failing to express the real failure.
 */
function contactSheetStoreFor(
  payload: WalkthroughIngressPayload,
  overrides: Partial<WalkthroughContactSheetStore> = {}
): WalkthroughContactSheetStore {
  return {
    isConfigured: () => true,
    head: async () => ({
      contentType: payload.contactSheetMimeType,
      contentLength: payload.contactSheetBytes,
    }),
    generateImageThumbnail: async (r2Key, mimeType) =>
      mimeType === "image/jpeg" ? deriveThumbnailKey(r2Key) : null,
    generatePdfThumbnail: async (r2Key, mimeType) =>
      mimeType === "application/pdf" ? deriveThumbnailKey(r2Key) : null,
    ...overrides,
  };
}

/**
 * Every test's door into the service, so the injected store has ONE default and the ~60 call sites that
 * do not care about object storage did not have to grow an argument. Tests that DO care pass
 * `contactSheetStore` overrides, which are merged over the healthy default above.
 */
function ingestWalkthrough(args: {
  tenantDb: unknown;
  payload: WalkthroughIngressPayload;
  contactSheetStore?: Partial<WalkthroughContactSheetStore>;
}) {
  return ingestWalkthroughService({
    tenantDb: args.tenantDb as never,
    payload: args.payload,
    contactSheetStore: contactSheetStoreFor(args.payload, args.contactSheetStore),
  });
}

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("11111");
const WALKTHROUGH = U("22222");
const USER = U("33333");
/** Two projects of DEAL, and one belonging to somebody else. `estimate_source_documents.project_id`
 *  carries no FK, so the ingress resolves the project itself and requires its `source_deal_id` to be
 *  the authorized deal — see "refuses a project that belongs to another deal" below. */
const PROJECT = U("44444");
const SECOND_PROJECT_OF_DEAL = U("44445");
const FOREIGN_DEAL = U("11119");
const PROJECT_OF_FOREIGN_DEAL = U("44446");
/** A syntactically perfect projectId with no `projects` row at all. */
const UNKNOWN_PROJECT = U("44447");
/**
 * R15 fixtures, and they cannot come from `U()`: that helper produces UUIDs made ENTIRELY of decimal
 * digits, so `toUpperCase()` on one is a no-op and a case test built on it would be vacuous. (It was,
 * in the first draft — `expect(mixedCase(DEAL)).not.toBe(DEAL)` is the assertion that caught it.) These
 * are hex-letter-dense on purpose, so re-casing them genuinely changes the string.
 */
const CASE_DEAL = "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5";
const CASE_PROJECT = "b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6";
/** Uppercase every OTHER hex letter — genuinely mixed, so neither a whole-string `toUpperCase()` nor a
 *  whole-string `toLowerCase()` in the implementation could satisfy the test by accident. */
const mixedCase = (id: string) => {
  let seen = 0;
  return id.replace(/[a-f]/g, (char) => (seen++ % 2 === 0 ? char.toUpperCase() : char));
};
/** Own deals for the workbench tests, so "the state contains exactly this row" / "…contains nothing"
 *  are exact counts rather than containment checks against every row the rest of the suite wrote. */
const WORKBENCH_DEAL = U("55551");
const WORKBENCH_NEGATIVE_DEAL = U("55552");
/** The reprocess-guard suite gets its own deal for the same reason: it renders the workbench to prove
 *  the scope survived, and the two deals above assert EXACT row counts that a second walkthrough on
 *  them would break. */
const REPROCESS_DEAL = U("55553");
/** R21. Soft-deleted, so the ingress's own in-transaction deal check can be proved against a real row
 *  rather than an absent one — an archived deal and an unknown deal are different failures, and only
 *  the first is the TOCTOU the row lock exists to close. */
const ARCHIVED_DEAL = U("55554");
/** R21b fixtures: a revoked capturer and a switched-off office. */
const DEACTIVATED_USER = U("33334");
const ACTIVE_OFFICE = U("88881");
const INACTIVE_OFFICE = U("88882");
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
/**
 * R20. A SECOND Drizzle handle over the SAME PGlite instance, differing only in that it records every
 * statement it executes — through Drizzle's supported `logger` hook rather than a monkey-patch, so it
 * sees statements issued INSIDE a transaction too (those go through the transaction's own client, which
 * a patch on `pg.query` would miss entirely).
 *
 * Needed because the `recordIngressStatements` proxy above logs only the KIND of a select, not its SQL —
 * a select's SQL is not compiled until the builder is awaited, by which point the chain has returned the
 * raw builder rather than the proxy.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loggingDb: any;
const executedSql: string[] = [];

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
      // R19. On the ingress WRITE path now: `estimate_source_documents.project_id` and
      // `estimate_extractions.project_id` carry no foreign key, so `ingestWalkthrough` resolves the
      // project itself and requires `projects.source_deal_id` to equal the authorized deal.
      projects,
      // R21b. The ingress locks the ACTOR as well as the deal — `payload.userId` is stamped on
      // `files.uploaded_by` — so `users` is on the write path now. It is a PUBLIC table, which is
      // exactly why a capturer whose home office differs from the deal's still resolves here.
      users,
      offices,
    ])
  );
  tenantDb = drizzle(pg);
  loggingDb = drizzle(pg, {
    logger: {
      logQuery: (query: string) => {
        executedSql.push(query);
      },
    },
  });

  // A global default market. Without one, resolveMarketContext (market-resolution-service.ts:159-162)
  // throws "No default estimating market is configured" and the workbench never renders for ANY deal —
  // a prod precondition, not a test artifact.
  await tenantDb
    .insert(estimateMarkets)
    .values({ id: DEFAULT_MARKET, name: "Global Default", slug: "global-default", type: "global" });
  await tenantDb
    .insert(estimateMarketFallbackGeographies)
    .values({ marketId: DEFAULT_MARKET, resolutionType: "global", resolutionKey: "default" });

  // R21. EVERY deal this suite posts to needs a row now: `ingestWalkthrough` re-reads and locks the
  // deal inside its own transaction, so an ingress onto an unseeded id is a 404 rather than a write.
  // Previously only the workbench deals existed, because nothing on the write path looked.
  await tenantDb.insert(deals).values([
    {
      id: DEAL,
      dealNumber: "WT-0001",
      name: "Walkthrough ingress deal",
      stageId: U("77771"),
    },
    {
      id: U("11112"),
      dealNumber: "WT-0002",
      name: "Walkthrough second deal",
      stageId: U("77771"),
    },
    {
      id: CASE_DEAL,
      dealNumber: "WT-0003",
      name: "Walkthrough mixed-case deal",
      stageId: U("77771"),
    },
    {
      id: ARCHIVED_DEAL,
      dealNumber: "WT-0004",
      name: "Walkthrough archived deal",
      stageId: U("77771"),
      // The point of the fixture.
      isActive: false,
    },
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

  // The actor every payload names. Active, because the ingress now requires it to be.
  await tenantDb.insert(users).values({
    id: USER,
    email: "walkthrough-capturer@example.com",
    displayName: "Walkthrough Capturer",
    role: "rep",
    officeId: U("99991"),
  });
  await tenantDb.insert(users).values({
    id: DEACTIVATED_USER,
    email: "revoked@example.com",
    displayName: "Revoked Capturer",
    role: "rep",
    officeId: U("99991"),
    isActive: false,
  });
  await tenantDb.insert(offices).values([
    { id: ACTIVE_OFFICE, name: "Active Office", slug: "active-office" },
    { id: INACTIVE_OFFICE, name: "Closed Office", slug: "closed-office", isActive: false },
  ]);

  // R19. Every projectId the suite posts has to resolve to a project OF THE POSTING DEAL, because the
  // ingress now refuses one that does not. `source_deal_id` is the association it checks (projects.ts:20).
  // UNKNOWN_PROJECT is deliberately absent from this list.
  await tenantDb.insert(projects).values([
    {
      id: PROJECT,
      sourceDealId: DEAL,
      procoreProjectId: "pc-44444",
      procoreCompanyId: "pc-co-1",
      name: "Unit 12B",
    },
    {
      id: SECOND_PROJECT_OF_DEAL,
      sourceDealId: DEAL,
      procoreProjectId: "pc-44445",
      procoreCompanyId: "pc-co-1",
      name: "Unit 12B — phase 2",
    },
    {
      // Belongs to a DIFFERENT deal, which is the whole point of it.
      id: PROJECT_OF_FOREIGN_DEAL,
      sourceDealId: FOREIGN_DEAL,
      procoreProjectId: "pc-44446",
      procoreCompanyId: "pc-co-1",
      name: "Somebody else's building",
    },
    {
      // The R15 hex-case pair. Stored canonically, which is how Postgres renders a `uuid` column — the
      // ownership comparison reads `source_deal_id` back out and compares it with `===` against the
      // canonicalized payload dealId, so this row is also what proves that comparison survives a
      // mixed-case post.
      id: CASE_PROJECT,
      sourceDealId: CASE_DEAL,
      procoreProjectId: "pc-case-1",
      procoreCompanyId: "pc-co-1",
      name: "Mixed-case identity project",
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
        thumbnailR2Key: null,
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
        thumbnailR2Key: null,
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
        thumbnailR2Key: null,
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
    //
    // R22. NAMESPACED, because that same triple is what `createEstimateSourceDocument` dedupes ORDINARY
    // uploads on, with no documentType predicate — see the R22 test below for what a bare id costs. Both
    // halves are asserted: the exact stored value, and that it is NOT the bare id (which is what makes
    // this more than a restatement of the implementation).
    expect(doc.contentHash).toBe(`walkthrough:${WALKTHROUGH}`);
    expect(doc.contentHash).toBe(walkthroughContentHash(WALKTHROUGH));
    expect(doc.contentHash).not.toBe(WALKTHROUGH);
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
      thumbnailR2Key: null,
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

    // Through `ingestWalkthrough`, with the trade spelled RAW — `"  Roofing  "`, as a sender
    // plausibly would and as the CRM would not. Canonicalization lives in the validator, so an
    // earlier version of this test that pre-canonicalized the value and called
    // `insertWalkthroughExtractions` directly could not fail: it asserted that "roofing" is stored
    // as "roofing", bypassing the only code that does the work. Deleting the canonicalization
    // entirely left it green.
    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, {
        rows: [{ ...CARPENTRY_ROW, trade: "  Roofing  " }],
      }),
    });

    const [row] = await tenantDb
      .select()
      .from(estimateExtractions)
      .where(eq(estimateExtractions.id, result.extractionIds[0]));

    // The pricing key and the stored provenance must agree, or the row is priced under one trade
    // while claiming another (`market-rate-service.ts` compares scope keys with `===`).
    expect(row.metadataJson.pricingScopeKey).toBe("roofing");
    expect(row.metadataJson.trade).toBe("roofing");
    expect(row.metadataJson.pricingScopeType).toBe("trade");
  });

  // R16. The hint used to be FILTERED through `isKnownTradeScopeKey` — membership of the resolver's
  // `tradeScopeHints` set (pricing-service.ts:116) — on the theory that a scope key matching no rule was
  // worse than no key. That set is the TEXT-INFERENCE vocabulary: 19 roofing-heavy terms with no
  // flooring, millwork, tile or ACT. `estimate_market_adjustment_rules.scope_key` is a varchar(120) that
  // takes ARBITRARY keys (estimate-markets.ts:117), so a tenant with a configured `flooring` rule had
  // the hint filtered away, the resolver fell back to division or inferred-prose scope, and
  // `market-rate-service.ts:84`'s `===` never selected the rule they configured.
  //
  // `flooring` is chosen deliberately: it is a real T Rock trade, and it is NOT in the inference
  // vocabulary — so this test is only green if the hint survives WITHOUT any help from that set.
  it("passes a trade outside the inference vocabulary through as the pricing key", async () => {
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
            trade: "flooring",
            // Both fallbacks the filtered version would have landed on are set to something ELSE, so
            // "flooring" can only have come from the hint: divisionHint would have produced the
            // division scope "09", and prose inference would have produced "carpentry" (which IS in the
            // vocabulary — that is the point).
            divisionHint: "09",
            rawLabel: "Replace carpentry-grade wall base throughout",
          },
        ],
      },
    });

    const [row] = await tenantDb
      .select()
      .from(estimateExtractions)
      .where(eq(estimateExtractions.id, ids[0]));

    // THE ASSERTION THIS FINDING IS ABOUT: the hint reached the resolver and became the pricing key.
    expect(row.metadataJson.pricingScopeType).toBe("trade");
    expect(row.metadataJson.pricingScopeKey).toBe("flooring");
    // Provenance unchanged.
    expect(row.metadataJson.trade).toBe("flooring");
    // Neither fallback won — proof the key above is the hint and not a coincidence. "carpentry" is what
    // prose inference yields for this label, and "09" is what the divisionHint branch yields.
    expect(row.metadataJson.pricingScopeKey).not.toBe("carpentry");
    expect(row.metadataJson.pricingScopeKey).not.toBe("09");
    expect(row.divisionHint).toBe("09");

    // ...and the key is one a real market rule can be configured under: the same `scopeType`/`scopeKey`
    // equality market-rate-service.ts:84 performs, against a rule that is NOT in the inference set.
    const configuredRule = { scopeType: "trade", scopeKey: "flooring" };
    expect(
      configuredRule.scopeType === row.metadataJson.pricingScopeType &&
        configuredRule.scopeKey === row.metadataJson.pricingScopeKey
    ).toBe(true);
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

/**
 * Run a REAL ingress in a REAL transaction, recording the statements it issues in order.
 *
 * `ingestWalkthrough` touches `tenantDb` only to open a transaction, so a stub carrying just
 * `transaction` is a complete stand-in; the tx handed to the body is proxied so every `execute`,
 * `select`, `insert` and `update` is logged as it happens. Used to assert the ORDER of the transaction's
 * statements — which no outcome-shaped test can see.
 */
async function recordIngressStatements(
  payload: WalkthroughIngressPayload
): Promise<Array<{ kind: string; sql: string; params: unknown[] }>> {
  const log: Array<{ kind: string; sql: string; params: unknown[] }> = [];

  // This probe compiles each statement to inspect its SQL, which needs Drizzle's `dialect.sqlToQuery`.
  // That is an INTERNAL api with no public equivalent, so it is asserted once, here, with a message
  // naming the dependency — otherwise a Drizzle upgrade surfaces as a TypeError from inside a Proxy
  // getter, which reads like a bug in the service rather than in the harness.
  if (typeof (tenantDb as any)?.dialect?.sqlToQuery !== "function") {
    throw new Error(
      "recordIngressStatements depends on Drizzle's internal `dialect.sqlToQuery`, which is no longer " +
        "available. Statement-order and advisory-lock observation cannot be verified without an " +
        "equivalent SQL compilation path — fix the harness rather than deleting the assertions."
    );
  }

  const recordingDb = {
    transaction: (body: (tx: unknown) => unknown) =>
      tenantDb.transaction((tx: any) =>
        body(
          new Proxy(tx, {
            get(target: any, prop: string | symbol) {
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
                    log.push({ kind: "advisory-locks-held", sql: String(rows[0].n), params: [] });
                  }
                  return result;
                };
              }
              if (
                (prop === "select" || prop === "insert" || prop === "update") &&
                typeof value === "function"
              ) {
                return (...args: unknown[]) => {
                  log.push({ kind: String(prop), sql: "", params: [] });
                  return value.apply(target, args);
                };
              }
              return typeof value === "function" ? value.bind(target) : value;
            },
          })
        )
      ),
  };

  await ingestWalkthrough({ tenantDb: recordingDb as never, payload });
  return log;
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

  // ── R35: excess precision — the SAME rounding as the floor above, at the other end of the range ────
  //
  // The floor exists because scale 3 rounds 0.0001 down to the zero the contract forbids. The identical
  // rounding at a normal magnitude is silent: 1.2345 is stored, priced and promoted as 1.235. That
  // contradicts the rule the whole export is built on — a quantity exists only when it was spoken and
  // human-confirmed — and it breaks replay, because `fingerprintWalkthroughScopeRow` hashes the POSTED
  // number while the table holds the rounded one.
  //
  // The fixture value MATTERS. A whole-number quantity (or 12.5, the suite's default) cannot see a
  // precision rule at all — every assertion about it passes identically with and without the check. Each
  // case below carries real digits past the third decimal.
  it.each<[string, number, string]>([
    // The finding's own value: four decimals, rounds DOWN to 1.234.
    ["a fourth decimal", 1.2345, "1.234"],
    // Rounds UP, so the stored number is larger than the one that was spoken — the same defect with the
    // opposite sign, which a down-only implementation would miss.
    ["a fourth decimal that rounds up", 2.0006, "2.001"],
    // Far more decimals than the column holds, at a magnitude nowhere near either bound.
    ["far more decimals than the column holds", 18.123456, "18.123"],
  ])(
    "refuses a quantity carrying %s, naming the row and the scale, without writing anything",
    async (_label, quantity, wouldStore) => {
      const before = await tableCounts();

      const failure = await ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33064"), {
          rows: [{ ...CARPENTRY_ROW, sourceScopeItemId: "scope-item-over-precise", quantity }],
        }),
        // A resolved value has no statusCode, so an implementation that ACCEPTED this fails the next
        // line rather than sliding past a `.catch` that never ran.
      }).catch((error: Error) => error);

      expect((failure as { statusCode?: number }).statusCode).toBe(400);
      // NAMES THE ROW, so the sender can look the utterance up...
      expect((failure as Error).message).toContain("scope-item-over-precise");
      // ...and names the MECHANISM — the column's scale, and the number that would have been stored in
      // place of the one that was spoken. Without these two the test would also pass on an arithmetic
      // complaint thrown from somewhere else entirely.
      expect((failure as Error).message).toContain("carries more than 3 decimal places");
      expect((failure as Error).message).toContain(`would ROUND it and store ${wouldStore}`);

      // NOTHING WAS WRITTEN. This is the assertion that separates "refused" from "canonicalized": an
      // implementation that rounded 1.2345 to 1.235 instead of refusing it would build the whole chain
      // and move all four counts.
      expect(await tableCounts()).toEqual(before);
    }
  );

  // The other side of the boundary, and it is what keeps the new rule from being over-tight. A value
  // AT the column's scale, and a value at the representable floor, both have to survive untouched —
  // READ BACK OUT OF POSTGRES as text, because `quantity::text` is the only thing that can tell 1.234
  // apart from a rounded 1.230.
  //
  // Each case carries its OWN walkthrough id, spelled out rather than derived from the label — the same
  // precaution the drift table below documents, so one case's "fresh ingest" cannot silently become a
  // replay of the other's document.
  it.each<[string, string, number, string]>([
    ["exactly three decimals", U("33067"), 1.234, "1.234"],
    // 0.001 is simultaneously the floor and a three-decimal value: proof the new check did not shift
    // the existing lower bound by rejecting the smallest representable quantity.
    ["the representable floor", U("33068"), MIN_WALKTHROUGH_QUANTITY, "0.001"],
  ])("accepts %s and stores it unchanged", async (_label, walkthroughId, quantity, expectedStored) => {
    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, {
        rows: [{ ...CARPENTRY_ROW, quantity }],
      }),
    });

    const stored = await pg.query<{ stored: string }>(
      `SELECT quantity::text AS stored FROM public.estimate_extractions WHERE id = $1`,
      [result.extractionIds[0]]
    );
    expect(stored.rows[0].stored).toBe(expectedStored);
    // ...and the number it round-trips to is the number that was posted, not merely something close.
    expect(Number(stored.rows[0].stored)).toBe(quantity);
  });

  // R35, THE STRUCTURAL POINT — why the finding was closed by REFUSING rather than by rounding.
  //
  // The row fingerprint is taken over the POSTED quantity. Had ingress canonicalized 1.2345 to 1.235,
  // the table would hold 1.235 under a fingerprint of 1.2345 — so a well-behaved sender that reads back
  // what we stored and replays it would be refused with a 409 for content drift, for matching us
  // exactly. Refusing over-precise values makes stored == posted an invariant, which makes that
  // divergence unconstructible. This test walks that sender's path: ingest, read the stored value out of
  // Postgres, and re-post THAT.
  it("replays a fractional quantity read back out of the database, rather than calling it drift", async () => {
    const walkthroughId = U("33069");
    const posted = 1.234;

    const first = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, {
        rows: [{ ...CARPENTRY_ROW, quantity: posted }],
      }),
    });

    // What a sender reading our own storage back would see — from Postgres, not from the payload.
    const stored = await pg.query<{ stored: string }>(
      `SELECT quantity::text AS stored FROM public.estimate_extractions WHERE id = $1`,
      [first.extractionIds[0]]
    );
    const readBack = Number(stored.rows[0].stored);
    expect(readBack).toBe(posted);

    const second = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, {
        rows: [{ ...CARPENTRY_ROW, quantity: readBack }],
      }),
    });

    // A RETRY, not a correction: the same chain replayed, nothing new written.
    expect(second).toEqual(first);
    const all = await tenantDb
      .select({ id: estimateExtractions.id })
      .from(estimateExtractions)
      .where(eq(estimateExtractions.documentId, first.documentId));
    expect(all).toHaveLength(1);
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
      .where(eq(estimateSourceDocuments.contentHash, walkthroughContentHash(walkthroughId)));
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
      .where(eq(estimateSourceDocuments.contentHash, walkthroughContentHash(walkthroughId)));
    expect(documents).toHaveLength(1);

    // ...and exactly one set of extractions under it, not the doubled scope an estimator would
    // otherwise have to de-duplicate by hand.
    const extractions = await tenantDb
      .select({ id: estimateExtractions.id })
      .from(estimateExtractions)
      .where(eq(estimateExtractions.documentId, first.documentId));
    expect(extractions).toHaveLength(2);
  });

  // R15 — THE ONE THAT DEFEATED BOTH PROTECTIONS ABOVE.
  //
  // Postgres compares `uuid` columns by VALUE, so "…AB" and "…ab" are the SAME deal row. JavaScript
  // string concatenation compares BYTES, so they are two different strings. Both of this branch's
  // safeguards are built by concatenation:
  //   • the advisory-lock key (`walkthrough-ingress:${dealId}:${walkthroughId}`) — two hex-case
  //     spellings take two DIFFERENT locks, so neither transaction is serialized against the other;
  //   • the derived r2 key (`walkthroughs/${dealId}/${projectId}/${walkthroughId}/…`) — two spellings
  //     derive two DIFFERENT keys, so `files.r2_key`'s UNIQUE index has nothing to collide on.
  // While the idempotency lookup, comparing `deal_id`/`project_id` as `uuid`, sees one deal and one
  // project and cannot tell the two calls apart. Both pass, neither is blocked, both build a full chain.
  //
  // Fixed at ONE point — the validator canonicalizes, so every derivation downstream sees one form.
  //
  // ASSERTED ON ROWS READ BACK, AND COUNTED, IN THAT ORDER — the counts come BEFORE the id comparison
  // deliberately. A test that only compared the two returned results would pass while two complete chains
  // sat in the table: the second call returns its OWN internally-consistent ids, so `toEqual` is the only
  // thing that notices, and it notices the symptom rather than the damage. Counting first means a
  // regression report names "2 documents where 1 was expected".
  //
  // DEAL-LEVEL, and that is a considered choice rather than a convenience. A case-only difference in
  // `projectId` cannot by itself produce two chains — the idempotency lookup compares `project_id` as a
  // `uuid` (case-insensitive, so it still finds the document and replays) and the lock omits the project
  // entirely.
  //
  // ── HONEST LIMIT OF THIS TEST, established by mutation rather than reasoned about ──────────────────
  //
  // Removing the canonicalization entirely makes this test report 2 documents, so it is not vacuous. But
  // the two halves of the fix are NOT equally observable here, and the mutations say which is which:
  //
  //   • canonicalizing `walkthroughId` is what this test catches. It reaches `content_hash`, which is
  //     `text` and therefore compared case-SENSITIVELY, so an uncanonicalized retry misses the lookup and
  //     builds a second chain right here. (Mutation: canonicalize dealId only → 2 documents. Verified.)
  //   • canonicalizing `dealId` is NOT catchable by any outcome test on PGlite, and pretending otherwise
  //     would be the third species of false green. `deal_id` is a `uuid`, so the lookup finds the stored
  //     document whatever the case — the damage from a raw `dealId` is that the LOCK KEY and the R2 KEY
  //     diverge, and both of those only bite under genuine two-connection concurrency, which PGlite (one
  //     connection, internal mutex) cannot express. (Mutation: canonicalize walkthroughId only → this
  //     test stays GREEN, 1 document. Verified — that is why the next test exists.)
  //
  // So the `dealId` half is pinned at the DERIVATION level by "canonicalizes the ids once…" below, which
  // asserts both derived keys agree under re-casing and — the load-bearing part — that they DISAGREE when
  // handed the raw spellings. Same division of labour the advisory lock itself already has in this suite.
  // R15, RE-CONFIRMED UNDER R29 rather than deleted with it. R29 narrowed the canonicalization to the
  // two UUIDs, so this test now re-cases ONLY the ids that are uuids — the `walkthroughId` below is
  // byte-identical on both posts, because folding an opaque export id was the finding (see the test that
  // follows). The deal half is still load-bearing and is what this proves.
  it("treats two hex-case spellings of one deal as one walkthrough, not two chains", async () => {
    // Hex-letter-dense so re-casing it is a real change — see CASE_DEAL for why `U()` cannot be used.
    // BYTE-IDENTICAL on both calls: it is the opaque export id and its case is information now.
    const walkthroughId = "c3d4e5f6-a7b8-4c9d-8e0f-a1b2c3d4e5f6";

    // Sanity FIRST: the fixtures really do differ from their canonical spelling, and differ only in
    // case. Without these the whole test would pass on ids that were never re-cased at all — which is
    // exactly what happened on the first draft, built on the digit-only `U()` ids.
    expect(mixedCase(CASE_DEAL)).not.toBe(CASE_DEAL);
    expect(mixedCase(CASE_PROJECT)).not.toBe(CASE_PROJECT);
    expect(mixedCase(CASE_DEAL).toLowerCase()).toBe(CASE_DEAL);
    // Genuinely MIXED, not uniformly upper — so an implementation that happened to uppercase everything
    // would not satisfy this either.
    expect(mixedCase(CASE_DEAL)).not.toBe(CASE_DEAL.toUpperCase());

    const first = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, {
        dealId: CASE_DEAL,
        projectId: CASE_PROJECT,
        rows: [CARPENTRY_ROW],
      }),
    });

    // The SAME walkthrough on the SAME deal, its two UUIDs spelled in different hex case — which is what
    // a retry from a sender that re-serialized its ids looks like.
    //
    // WHICH MUTATION REDDENS THIS, stated so the assertions below are not credited with work they do not
    // do: drop `canonicalizeWalkthroughIngressId` from `requireUuid` and THIS CALL throws a 400 from the
    // project-ownership check — `projects.source_deal_id` comes back out of Postgres lowercase and is
    // compared with `===` against the payload's dealId, so a mixed-case spelling stops matching the deal
    // that owns the project. (Verified: the 8-4-4-4-12 pattern carries the `i` flag, so an uncanonical
    // id still passes validation and reaches that comparison.) The counting assertions below are the
    // belt-and-braces half — the idempotency lookup compares `deal_id` as a `uuid` and so finds the
    // stored document either way, which is exactly why the lock-key and r2-key halves of this finding
    // need the pure-function test that follows rather than an outcome test.
    const second = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, {
        dealId: mixedCase(CASE_DEAL),
        projectId: mixedCase(CASE_PROJECT),
        rows: [CARPENTRY_ROW],
      }),
    });

    // ONE document, counted in the database.
    const documents = await tenantDb
      .select({ id: estimateSourceDocuments.id, contentHash: estimateSourceDocuments.contentHash })
      .from(estimateSourceDocuments)
      .where(eq(estimateSourceDocuments.contentHash, walkthroughContentHash(walkthroughId)));
    expect(documents).toHaveLength(1);
    expect(documents[0].id).toBe(first.documentId);

    // ONE set of extractions — the count that would be 2 if a second chain had landed, and the thing an
    // estimator would actually have seen (the workbench loads them by deal).
    const extractions = await tenantDb
      .select({ id: estimateExtractions.id })
      .from(estimateExtractions)
      .where(eq(estimateExtractions.dealId, CASE_DEAL));
    expect(extractions).toHaveLength(1);
    expect(extractions[0].id).toBe(first.extractionIds[0]);

    // ONE contact-sheet object, on the CANONICAL key. With an uncanonicalized dealId the second post
    // would want `walkthroughs/A1b2…/…` where the first stored `walkthroughs/a1b2…/…`, and the UNIQUE
    // index on r2_key would not have objected to either — which is why the counting predicate matches
    // any deal segment and pins the stored spelling separately.
    const chainFiles = await tenantDb
      .select({ id: files.id, r2Key: files.r2Key })
      .from(files)
      .where(sql`${files.r2Key} LIKE ${`%/${walkthroughId}/contact-sheet.jpg`}`);
    expect(chainFiles).toHaveLength(1);
    expect(chainFiles[0].r2Key).toBe(
      `walkthroughs/${CASE_DEAL}/${CASE_PROJECT}/${walkthroughId}/contact-sheet.jpg`
    );

    // ...and only THEN the ids, which is what the sender sees: it cannot tell which call won.
    expect(second).toEqual(first);
  });

  // ── R29: the walkthrough id is OPAQUE, so its case is information ────────────────────────────────────
  //
  // The fix above canonicalized all THREE ingress ids. That is right for `dealId` and `projectId`, which
  // are uuids compared by value in Postgres and by bytes in JavaScript. It was wrong for `walkthroughId`:
  // it is trock-scope's own export id, typed `string` with no format guarantee, so lowercasing collapsed
  // two genuinely distinct walkthroughs onto ONE advisory lock, ONE `content_hash`, ONE row fingerprint
  // and ONE r2 key. The second walkthrough could then never be ingested under its real identity — it
  // replayed as the first where their rows agreed, and 409'd as a "correction" where they did not.
  it("treats two case-differing walkthrough ids as two walkthroughs, not one", async () => {
    // DELIBERATELY NOT UUID-SHAPED: an opaque trock-scope export id, so nothing here can be confused with
    // the uuid canonicalization the test above depends on.
    const upper = "Walkthrough-A";
    const lower = "walkthrough-a";
    // The fixtures differ ONLY in case — otherwise this test would prove that two different strings are
    // two walkthroughs, which nothing ever disputed.
    expect(upper).not.toBe(lower);
    expect(upper.toLowerCase()).toBe(lower);

    // The validator is where the folding lived, so this is the most direct statement of the fix.
    expect(validateWalkthroughIngressPayload(walkthroughPayload(upper)).walkthroughId).toBe(upper);

    const first = await ingestWalkthrough({ tenantDb, payload: walkthroughPayload(upper) });
    const second = await ingestWalkthrough({ tenantDb, payload: walkthroughPayload(lower) });

    // TWO documents. Under the fold this was one: the second post's `content_hash` lowercased onto the
    // first's, the idempotency lookup found it, the envelope and the row fingerprints matched, and the
    // second walkthrough was reported as a successful replay of the first.
    expect(second.documentId).not.toBe(first.documentId);
    const documents = await tenantDb
      .select({ id: estimateSourceDocuments.id, contentHash: estimateSourceDocuments.contentHash })
      .from(estimateSourceDocuments)
      .where(
        sql`${estimateSourceDocuments.contentHash} IN (${walkthroughContentHash(upper)}, ${walkthroughContentHash(lower)})`
      );
    expect(documents).toHaveLength(2);
    expect(documents.map((row: { contentHash: string }) => row.contentHash).sort()).toEqual(
      [walkthroughContentHash(upper), walkthroughContentHash(lower)].sort()
    );

    // TWO sets of rows, so the estimator sees each walkthrough's own scope rather than one of them twice.
    expect(second.extractionIds).toHaveLength(1);
    expect(second.extractionIds[0]).not.toBe(first.extractionIds[0]);

    // TWO objects, on keys that differ in exactly the byte that distinguishes the two ids. This is the
    // r2-key half: folded, both wanted `.../walkthrough-a/contact-sheet.jpg`.
    const [firstFile] = await tenantDb.select().from(files).where(eq(files.id, first.fileId));
    const [secondFile] = await tenantDb.select().from(files).where(eq(files.id, second.fileId));
    expect(firstFile.r2Key).toBe(`walkthroughs/${DEAL}/${PROJECT}/${upper}/contact-sheet.jpg`);
    expect(secondFile.r2Key).toBe(`walkthroughs/${DEAL}/${PROJECT}/${lower}/contact-sheet.jpg`);

    // ...and the lock half. Driven THROUGH THE VALIDATOR on purpose: `walkthroughIngressLockKey` never
    // folded case itself, so calling it with the two raw ids would compare two literals and pass no
    // matter what the validator does (the tautology its own docblock warns about). Fed the validator's
    // output, re-adding the fold makes both sides equal and this assertion fails.
    expect(
      walkthroughIngressLockKey(
        DEAL,
        validateWalkthroughIngressPayload(walkthroughPayload(upper)).walkthroughId
      )
    ).not.toBe(
      walkthroughIngressLockKey(
        DEAL,
        validateWalkthroughIngressPayload(walkthroughPayload(lower)).walkthroughId
      )
    );
  });

  // The mechanism the test above depends on, isolated: the two derivations that used to disagree are
  // driven from the validator's output, so they cannot see a raw wire spelling. Distinct from the
  // outcome test because it names WHICH values must be canonical rather than only that the outcome
  // collapsed to one — a fix that deduped some other way would pass that test and fail this one.
  it("canonicalizes the two UUIDs once, and leaves the opaque walkthrough id alone", () => {
    // Mixed-case ON PURPOSE, and it must survive: R29. Hex-shaped only so the two halves of this test sit
    // side by side — the validator does not require the walkthrough id to be a uuid and must not treat it
    // as one.
    const walkthroughId = "D4e5F6a7-B8c9-4D0e-8F1a-B2c3D4e5F6a7";

    const payload = validateWalkthroughIngressPayload({
      ...walkthroughPayload(walkthroughId),
      dealId: mixedCase(CASE_DEAL),
      projectId: mixedCase(CASE_PROJECT),
      walkthroughId,
    });

    // The validator is the single canonicalization point for the two UUIDS — everything downstream reads
    // THESE values.
    expect(payload.dealId).toBe(CASE_DEAL);
    expect(payload.projectId).toBe(CASE_PROJECT);
    // ...and the opaque id comes through BYTE-EXACT, not folded with them.
    expect(payload.walkthroughId).toBe(walkthroughId);
    expect(payload.walkthroughId).not.toBe(walkthroughId.toLowerCase());

    // ...so the two derived keys, built from the validator's output, equal the ones built from canonical
    // UUIDs and the RAW walkthrough id. That equality IS the property: it is what makes two hex-case
    // retries take the same advisory lock and want the same `files.r2_key`.
    expect(walkthroughIngressLockKey(payload.dealId, payload.walkthroughId)).toBe(
      walkthroughIngressLockKey(CASE_DEAL, walkthroughId)
    );
    expect(
      deriveWalkthroughContactSheetR2Key(
        payload.dealId,
        payload.projectId,
        payload.walkthroughId,
        "image/jpeg"
      )
    ).toBe(deriveWalkthroughContactSheetR2Key(CASE_DEAL, CASE_PROJECT, walkthroughId, "image/jpeg"));

    // The NEGATIVE half, and the one that makes the two above more than a tautology: fed the RAW wire
    // spellings of the UUIDs, the very same builders disagree. That is the finding, reproduced in two
    // lines — string concatenation is case-sensitive where the `uuid` comparison behind the idempotency
    // lookup is not.
    expect(walkthroughIngressLockKey(mixedCase(CASE_DEAL), walkthroughId)).not.toBe(
      walkthroughIngressLockKey(CASE_DEAL, walkthroughId)
    );
    expect(
      deriveWalkthroughContactSheetR2Key(
        mixedCase(CASE_DEAL),
        mixedCase(CASE_PROJECT),
        walkthroughId,
        "image/jpeg"
      )
    ).not.toBe(deriveWalkthroughContactSheetR2Key(CASE_DEAL, CASE_PROJECT, walkthroughId, "image/jpeg"));
  });

  // THE MECHANISM, as opposed to the outcome. Records the statements the real service issues inside its
  // real transaction, so three things are checked that the outcome test cannot see: the lock statement
  // is issued at all, it is issued FIRST (a lock taken after the lookup guards nothing — both racers
  // would already have read "no document"), and it is keyed on THIS walkthrough rather than on some
  // constant that would serialize every ingress in the system.
  it("takes the advisory lock as its first statement, before every read and every write", async () => {
    const walkthroughId = U("33031");

    const log = await recordIngressStatements(walkthroughPayload(walkthroughId));

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

    // EVERYTHING ELSE RUNS UNDER IT, asserted as the exact prefix rather than as "a select happens
    // somewhere later": FOUR reads — the R21 deal authorization, the R21b actor authorization, the R19
    // project-ownership resolution, then the idempotency lookup — and no write until all four have
    // answered. (The office authorization is a fifth, but only when a caller supplies `officeId`; this
    // harness does not, which is what keeps the count here stable.)
    // ("advisory-locks-held" is this test's own probe, injected right after the lock statement; the rest
    // is the service's.)
    const firstWriteAt = log.findIndex((entry) => entry.kind === "insert");
    expect(firstWriteAt).toBeGreaterThan(-1);
    expect(log.slice(0, firstWriteAt).map((entry) => entry.kind)).toEqual([
      "execute",
      "advisory-locks-held",
      "select",
      "select",
      "select",
      "select",
    ]);

    // WHICH select is which, established by removing one of them: a deal-level walkthrough has no
    // project to resolve, so exactly THREE reads precede the first write — the deal and actor
    // authorizations, which every ingress does, and the idempotency lookup. That is what attributes the
    // FOURTH select above to the project resolution rather than to some unrelated query, and it is the
    // assertion that would fail if the ownership check were moved after the first write.
    const dealLevelLog = await recordIngressStatements(
      walkthroughPayload(U("33032"), { projectId: null })
    );
    const dealLevelFirstWriteAt = dealLevelLog.findIndex((entry) => entry.kind === "insert");
    // Guarded like `firstWriteAt` above: without this, a run that recorded no insert at all gives
    // findIndex -1, and `slice(0, -1)` quietly drops the last entry instead of failing.
    expect(dealLevelFirstWriteAt).toBeGreaterThan(-1);
    expect(dealLevelLog.slice(0, dealLevelFirstWriteAt).map((entry) => entry.kind)).toEqual([
      "execute",
      "advisory-locks-held",
      "select",
      "select",
      "select",
    ]);

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
        thumbnailR2Key: null,
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

  // R32. THE OTHER DIRECTION, and this test used to assert the opposite. A retry that OMITS a stored
  // scope item — trock-scope correcting an export by removing an erroneous row — appended that row's
  // extraction id to the response and returned success. The stale row stayed visible in the workbench and
  // eligible for pricing while the sender recorded the corrected payload as accepted, so the one part of
  // the correction that mattered was the one part that did not land.
  //
  // The asymmetry is the argument: adding a row 409s, changing a row's content under the same id 409s,
  // and removing one was the only edit a replay quietly accepted.
  it("refuses a replay that omits a stored scope row, naming it", async () => {
    const walkthroughId = U("33051");
    const rows = [
      CARPENTRY_ROW,
      { ...CARPENTRY_ROW, sourceScopeItemId: "scope-item-9501", rawLabel: "Reflash the parapet" },
    ];

    const first = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { rows }),
    });
    const afterFirst = await tableCounts();

    // A retry naming only the FIRST row — the parapet row withdrawn by leaving it out. Every row it POSTS
    // is stored, so the unmatched check above cannot be what fires (species 3), and the rows it does post
    // are byte-identical, so the fingerprint check cannot be either.
    const failure = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { rows: [CARPENTRY_ROW] }),
    }).catch((error: Error) => error);

    expect((failure as { statusCode?: number }).statusCode).toBe(409);
    // NAMED BY SCOPE ITEM ID — the sender never saw the extraction ids until the response it is retrying.
    expect((failure as Error).message).toContain("scope-item-9501");
    // ...and ONLY the omitted one. An implementation that listed every stored row would satisfy the line
    // above while telling the sender nothing about which row it dropped.
    expect((failure as Error).message).not.toContain(CARPENTRY_ROW.sourceScopeItemId);

    // The refusal is "we will not do this", not a partial application: nothing written, and — the harm
    // being fixed — the omitted row is still THERE. The 409 does not delete it; it declines to pretend
    // the omission landed.
    expect(await tableCounts()).toEqual(afterFirst);
    const stored = await tenantDb
      .select({ id: estimateExtractions.id })
      .from(estimateExtractions)
      .where(eq(estimateExtractions.documentId, first.documentId));
    expect(stored).toHaveLength(2);
  });

  // The surviving append branch, narrowed by R32 to rows this mapping cannot NAME. A stored extraction
  // whose `metadataJson` carries no `sourceScopeItemId` has no counterpart the sender could have posted
  // and cannot be reported to it by id, so it is neither drift nor an omission — it is appended, exactly
  // as before, and the result stays a complete picture of the document.
  //
  // The row is written by hand because nothing in this module can produce one: `insertWalkthroughExtractions`
  // always writes a `sourceScopeItemId`. That is the point — this branch guards against a row some other
  // writer left under the document, and a fixture that could not reach the condition would prove nothing.
  it("appends a stored row it cannot name, rather than reporting it as an omission", async () => {
    const walkthroughId = U("33052");

    const first = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { rows: [CARPENTRY_ROW] }),
    });

    const [anonymous] = await tenantDb
      .insert(estimateExtractions)
      .values({
        dealId: DEAL,
        projectId: PROJECT,
        documentId: first.documentId,
        extractionType: "scope_utterance",
        rawLabel: "A row with no scope item id",
        // NOT NULL, like `rawLabel` — this is a raw insert, so nothing fills it in.
        normalizedLabel: "a row with no scope item id",
        status: "pending",
        // No `sourceScopeItemId`, which is the whole fixture.
        metadataJson: { activeArtifact: true },
      })
      .returning({ id: estimateExtractions.id });

    const second = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { rows: [CARPENTRY_ROW] }),
    });

    expect(second.documentId).toBe(first.documentId);
    // The posted row first, in payload order, then the unnameable one appended.
    expect(second.extractionIds).toEqual([first.extractionIds[0], anonymous.id]);
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
    // R17. The fingerprint carried all three TEMPORAL evidence fields and omitted the transcript quote
    // itself, so a retry correcting only the words was a "successful replay" — see the dedicated test
    // below for what the stale text then does.
    ["evidenceText", U("33088"), { evidenceText: "so this whole eave is rotted, replacing about twelve point five feet" }],
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

  // R17, stated as the harm rather than as a table row. `evidenceText` is the transcript quote the row is
  // grounded in, and promotion copies it into `estimate_line_items.notes`
  // (draft-estimate-service.ts:95) — it is what an estimator reads to decide whether the row means what
  // it claims. With the quote outside the fingerprint, a retry that corrected ONLY the words matched,
  // reported a successful replay, and left the STALE quote in the table to be promoted later. The sender
  // believed the correction had landed; the estimator was reading the superseded sentence.
  it("refuses a retry that corrected only the transcript quote, and keeps nothing stale", async () => {
    const walkthroughId = U("33089");
    const corrected = "so this whole eave here is rotted, we're replacing about fifteen feet";

    const first = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { rows: [CARPENTRY_ROW] }),
    });

    // Everything else identical — the id, the label, the quantity, the unit, the trade, the location and
    // all three temporal evidence fields. ONLY the words changed, which is exactly the case that used to
    // pass. (Species-3 guard: nothing else about this row can be what fails the fingerprint.)
    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(walkthroughId, {
          rows: [{ ...CARPENTRY_ROW, evidenceText: corrected }],
        }),
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining(CARPENTRY_ROW.sourceScopeItemId),
    });

    // READ BACK FROM THE DATABASE, and honest about which assertion does the work: the REJECTION above is
    // what catches the omission (mutation — drop `row.evidenceText` from the fingerprint and this call
    // resolves instead of throwing). The two assertions below cannot fail for that mutation, because a
    // silent replay leaves the ORIGINAL text in place and "original" is what they expect. They guard the
    // OTHER direction — an implementation that applied the correction and then reported a conflict, which
    // would leave the table holding the new quote behind a 409.
    const [stored] = await tenantDb
      .select({ evidenceText: estimateExtractions.evidenceText })
      .from(estimateExtractions)
      .where(eq(estimateExtractions.id, first.extractionIds[0]));
    expect(stored.evidenceText).toBe(CARPENTRY_ROW.evidenceText);
    expect(stored.evidenceText).not.toBe(corrected);

    // ...and the refusal did not write a second row for the corrected quote either.
    const all = await tenantDb
      .select({ id: estimateExtractions.id })
      .from(estimateExtractions)
      .where(eq(estimateExtractions.documentId, first.documentId));
    expect(all).toHaveLength(1);
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
    // Both projects belong to DEAL — required now that the ingress verifies ownership (R19), and
    // faithful to the case this test is about: two projects WITHIN one deal.
    const otherProject = SECOND_PROJECT_OF_DEAL;

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

  // R19. A SHAPE check is not an EXISTENCE check. `estimate_source_documents.project_id` and
  // `estimate_extractions.project_id` carry no foreign key, so a syntactically perfect projectId that
  // belongs to another deal was written — the route authorizes the DEAL and nothing authorized the
  // project. And because projectId participates in idempotency (dealId, projectId, contentHash,
  // documentType), the correction is not an amendment: it misses the stored document and builds a SECOND
  // chain, while the workbench loads extractions by DEAL alone and shows the estimator both copies.
  it("refuses a project that belongs to another deal, without writing anything", async () => {
    const before = await tableCounts();

    await expect(
      ingestWalkthrough({
        tenantDb,
        // Perfectly well-formed, and a real project row — just not one of DEAL's.
        payload: walkthroughPayload(U("33111"), { projectId: PROJECT_OF_FOREIGN_DEAL }),
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      // Names BOTH deals, so the sender can see which one it actually addressed.
      message: expect.stringContaining(FOREIGN_DEAL),
    });

    // Not a shape complaint dressed up as an ownership one: the message has to name the project too.
    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33111"), { projectId: PROJECT_OF_FOREIGN_DEAL }),
      })
    ).rejects.toMatchObject({ message: expect.stringContaining(PROJECT_OF_FOREIGN_DEAL) });

    // Refused BEFORE the first write, like every other guard in this validator's contract.
    expect(await tableCounts()).toEqual(before);

    // The control that makes the assertion above about OWNERSHIP rather than about this walkthrough id
    // being unusable: the identical payload with one of DEAL's own projects ingests.
    // (Species-2 guard — proof the refusal is reachable from, and specific to, this input.)
    const ok = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(U("33111"), { projectId: PROJECT }),
    });
    expect(ok.extractionIds).toHaveLength(1);
  });

  // The other half of "resolve the project": a projectId with no `projects` row at all. 404 rather than
  // 400, mirroring the route's own `getDealById` miss ("Deal not found") — the request names something
  // absent, as opposed to something it may not have.
  it("refuses a projectId with no project row, without writing anything", async () => {
    const before = await tableCounts();

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33112"), { projectId: UNKNOWN_PROJECT }),
      })
    ).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringContaining(UNKNOWN_PROJECT),
    });

    expect(await tableCounts()).toEqual(before);
  });

  // R18. `contactSheetBytes` lands on `files.file_size_bytes` (bigint NOT NULL) — the same column
  // ordinary uploads reach through `validateFileSize` (files/service.ts:401), which refuses anything over
  // `MAX_FILE_SIZE_BYTES` with a 413. The ingress checked only "positive integer", so it accepted a file
  // the CRM refuses by every other door, and a value past signed-bigint range was a 22003 from the FIRST
  // write of the transaction — a 500 out of a validator that promises a 400 before anything is written.
  //
  // The ceiling is IMPORTED, not restated, so the two move together.
  it.each<[string, number]>([
    ["one byte over the Files subsystem's ceiling", MAX_FILE_SIZE_BYTES + 1],
    // Also over the ceiling, and the largest integer JS represents exactly — so it passes
    // `Number.isInteger` and reaches the bound rather than being rejected as non-integral first.
    // (It is NOT past signed-bigint range: 2^53-1 is ~1000x below 2^63-1. Nothing here exercises
    // a bigint overflow, and the ceiling makes that path unreachable by design.)
    ["the largest exactly-representable integer", Number.MAX_SAFE_INTEGER],
    // R26. The band the Files ceiling alone let through. `generateAndStoreThumbnail` caps its source
    // fetch at MAX_SOURCE_BYTES (40 MiB), so a JPEG above it yields NO thumbnail — image arm null, pdf
    // arm self-rejects a jpeg — and `resolveFileThumbnailUrl` then presigns the FULL ORIGINAL as the
    // list tile. Accepted at 200 MiB, that is a 200 MiB download to render one thumbnail.
    ["one byte over the thumbnailer's readable source limit", MAX_THUMBNAIL_SOURCE_BYTES + 1],
  ])("refuses a contact sheet of %s, without writing anything", async (_label, contactSheetBytes) => {
    const before = await tableCounts();

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33113"), { contactSheetBytes }),
      })
    ).rejects.toMatchObject({
      // 413, matching `validateFileSize`'s own answer for this condition — one column, one limit, one
      // status code. A 400 here would mean the two doors disagree about the same file.
      statusCode: 413,
      message: expect.stringContaining("contactSheetBytes"),
    });

    expect(await tableCounts()).toEqual(before);
  });

  // The boundary, from the other side: EXACTLY the Files subsystem's limit is accepted and stored whole.
  // Without this the check above would also pass if the ingress refused every contact sheet.
  it("accepts a contact sheet of exactly the binding ceiling and stores the size unchanged", async () => {
    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(U("33114"), { contactSheetBytes: BINDING_CEILING }),
    });

    const [file] = await tenantDb
      .select({ fileSizeBytes: files.fileSizeBytes })
      .from(files)
      .where(eq(files.id, result.fileId));
    expect(file.fileSizeBytes).toBe(BINDING_CEILING);

    // The bound is the Files subsystem's, not a copy of it: this is the same constant `validateFileSize`
    // reads, so a change there moves the ingress too. Pinned as a real number as well, so a mutation
    // that redefined MAX_FILE_SIZE_BYTES itself does not move both sides of the comparison together.
    // Both constants pinned as real numbers, so a mutation redefining either does not move both sides
    // of the comparison together — and the BINDING one is the thumbnailer's, not the Files subsystem's.
    expect(MAX_FILE_SIZE_BYTES).toBe(200 * 1024 * 1024);
    expect(MAX_THUMBNAIL_SOURCE_BYTES).toBe(40 * 1024 * 1024);
    expect(BINDING_CEILING).toBe(MAX_THUMBNAIL_SOURCE_BYTES);
  });

  // R27. The ceiling is MIME-AWARE, and this is the half a blanket `Math.min` got wrong. The 40 MiB cap
  // exists only because an unthumbnailed IMAGE gets its original served as the list tile — and
  // `resolveFileThumbnailUrl` gates that fallback on `isThumbnailableImage`, which excludes PDFs. A PDF
  // with no thumbnail resolves to null and the UI shows a type badge, so the image cap would have
  // refused a legitimate ~100 MiB pdf contact sheet for a hazard it does not have.
  it("accepts a pdf contact sheet far above the image thumbnail cap", async () => {
    const bytes = MAX_THUMBNAIL_SOURCE_BYTES * 2;
    expect(bytes).toBeLessThan(MAX_FILE_SIZE_BYTES); // the band this test is about

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(U("33116"), {
        contactSheetMimeType: "application/pdf",
        contactSheetBytes: bytes,
      }),
    });

    const [file] = await tenantDb
      .select({ fileSizeBytes: files.fileSizeBytes, mimeType: files.mimeType })
      .from(files)
      .where(eq(files.id, result.fileId));
    expect(file.mimeType).toBe("application/pdf");
    expect(file.fileSizeBytes).toBe(bytes);
  });

  // R28. JSON can carry \u0000; Postgres cannot store it in text, varchar OR jsonb. Without a central
  // guard the first insert touching the value raises a database error mid-transaction — a 500 out of a
  // validator whose whole contract is a 400 before anything is written.
  it("refuses a NUL character in a string field, without writing anything", async () => {
    const before = await tableCounts();

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("33117"), { siteLabel: "Unit\u000012B" }),
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(await tableCounts()).toEqual(before);
  });

  // R10. rawLabel is unbounded `text` here but promotion copies it into
  // estimate_line_items.description, a varchar(500) — so an over-long label is accepted, generated,
  // APPROVED by an estimator, and only then fails promotion with a 22001.
  // ── R34: an unpaired UTF-16 surrogate, the same class as the NUL guard ──────────────────────────────
  //
  // `JSON.parse` accepts `"\ud800"` and hands back that lone code unit, so a body can carry one in any
  // field. It is embedded in `metadataJson`, and Postgres rejects the serialized JSONB with a 22P02 from
  // inside the ingress transaction — a 500 out of a validator whose whole contract is a 400 before the
  // first write. Both halves of the pattern are exercised (a high surrogate with no low one, and a low
  // one with no high one), because a guard covering only the first would pass a one-case test.
  it.each<[string, string]>([
    ["a high surrogate with no low one", String.fromCharCode(0xd800)],
    ["a low surrogate with no high one", String.fromCharCode(0xdc00)],
  ])("refuses %s, without writing anything", async (_label, lone) => {
    const before = await tableCounts();

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("34080"), {
          rows: [{ ...CARPENTRY_ROW, sourceScopeItemId: `scope-item-${lone}` }],
        }),
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("unpaired UTF-16 surrogate"),
    });

    expect(await tableCounts()).toEqual(before);
  });

  // WHY THE GUARD EXISTS, against real SQL rather than as a claim. Driven through
  // `insertWalkthroughExtractions` — the exported helper, which does NOT run the validator — so the value
  // actually reaches Postgres and the SQLSTATE is observed rather than asserted from a docblock. Without
  // this, the test above could be pinning a guard against a condition that never fails (species 5).
  it("characterizes WHY: a lone surrogate in jsonb is a 22P02 from inside the transaction", async () => {
    const walkthroughId = U("34081");
    const { documentId, parseRunId } = await seedChain(walkthroughId);

    const code = await sqlStateOfFailure(
      insertWalkthroughExtractions({
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
              sourceScopeItemId: `scope-item-${String.fromCharCode(0xd800)}`,
            },
          ],
        },
      })
    );

    expect(code).toBe("22P02");
  });

  // THE OVER-TIGHTNESS CONTROL, and it is as load-bearing as the rejections above: an ASCII-plus-lone-
  // surrogate fixture cannot tell "rejects unpaired surrogates" apart from "rejects anything non-ASCII",
  // and the second would be worse than the bug. A real emoji is a WELL-FORMED pair — its high surrogate is
  // followed by its low one — so it must sail straight through, into both a varchar and a jsonb.
  it("accepts real astral characters, so the guard is not a ban on non-ASCII text", async () => {
    const walkthroughId = U("34082");
    const emoji = "😀";
    // The fixture really is a surrogate pair — otherwise this control tests nothing about the pattern.
    expect(emoji.length).toBe(2);
    expect(emoji.charCodeAt(0)).toBeGreaterThanOrEqual(0xd800);
    expect(emoji.charCodeAt(0)).toBeLessThanOrEqual(0xdbff);
    expect(emoji.charCodeAt(1)).toBeGreaterThanOrEqual(0xdc00);
    expect(emoji.charCodeAt(1)).toBeLessThanOrEqual(0xdfff);

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, {
        siteLabel: `Unit 12B ${emoji}`,
        rows: [
          {
            ...CARPENTRY_ROW,
            sourceScopeItemId: `scope-item-${emoji}`,
            rawLabel: `Replace rotted carpentry at eave ${emoji}`,
          },
        ],
      }),
    });

    // varchar(500), composed by the display-name builder…
    const [storedFile] = await tenantDb.select().from(files).where(eq(files.id, result.fileId));
    expect(storedFile.displayName).toBe(
      buildWalkthroughContactSheetDisplayName(`Unit 12B ${emoji}`)
    );
    // …and jsonb, which is the type that raises the 22P02 for the malformed case.
    const [storedRow] = await tenantDb
      .select()
      .from(estimateExtractions)
      .where(eq(estimateExtractions.id, result.extractionIds[0]));
    expect(storedRow.rawLabel).toBe(`Replace rotted carpentry at eave ${emoji}`);
    expect((storedRow.metadataJson as { sourceScopeItemId: string }).sourceScopeItemId).toBe(
      `scope-item-${emoji}`
    );
  });

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
  // WARNING for anyone mutation-checking these by name: vitest's `-t` is a REGEX, and three of the
  // names below contain parentheses ("varchar(50)", "varchar(1000)"). `-t 'refuses a unit longer than
  // the varchar(50)…'` therefore matches NOTHING, skips all 73 tests, and exits 0 — which reads as "the
  // mutation survived" when in fact nothing ran. Two of the mutation checks for this block were briefly
  // recorded as false greens for exactly that reason. Filter on a paren-free prefix, and confirm the
  // pattern selects 1 test on unmutated code before trusting a green.
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

  // ── R30: the opaque id must occupy EXACTLY ONE r2-key path segment ──────────────────────────────────
  //
  // `walkthroughId` has no format guarantee and was interpolated raw into a slash-delimited key, so an id
  // containing a slash escaped its intended prefix. The collision is between two ordinary ingests, not an
  // abstract hazard — see the dedicated test below. Encoded now, so no input can introduce a separator.
  it.each<[string, string, string]>([
    ["a slash", "wt-a/thumbs", "wt-a%2Fthumbs"],
    ["a parent-directory hop", "../../wt-a", "..%2F..%2Fwt-a"],
    ["a percent sign", "wt-a%2Fthumbs", "wt-a%252Fthumbs"],
  ])("keeps %s inside one r2-key path segment", (_label, walkthroughId, encoded) => {
    const key = deriveWalkthroughContactSheetR2Key(DEAL, PROJECT, walkthroughId, "image/jpeg");

    // FIVE segments, always: the prefix, the deal, the project, the id, the filename. This is the
    // property — the count cannot depend on what the sender put in its id.
    expect(key.split("/")).toHaveLength(5);
    expect(key.split("/")[3]).toBe(encoded);
    expect(key).toBe(`walkthroughs/${DEAL}/${PROJECT}/${encoded}/contact-sheet.jpg`);
    // Reversible, which is half of why percent-encoding was chosen over a hash: a key in a bucket
    // listing still names its walkthrough.
    expect(decodeURIComponent(key.split("/")[3])).toBe(walkthroughId);
  });

  // THE HARM, rather than a segment count: an id containing a slash could address ANOTHER walkthrough's
  // thumbnail prefix. `deriveThumbnailKey` (image-thumbnail.ts:62-69) inserts a `thumbs/` segment before
  // the filename, so walkthrough `wt-9200`'s thumbnail lives at `.../wt-9200/thumbs/contact-sheet.jpg` —
  // which is EXACTLY the original key walkthrough `wt-9200/thumbs` used to derive for itself. Whichever
  // landed second won: either thumbnail generation overwrote the second walkthrough's committed evidence,
  // or the second upload clobbered the first's tile. `files.r2_key`'s unique index cannot see it, because
  // only one of the two keys is ever stored in the column.
  it("cannot let one walkthrough's id address another walkthrough's thumbnail prefix", async () => {
    const plainId = "wt-9200";
    const colliderId = "wt-9200/thumbs";

    const plainKey = deriveWalkthroughContactSheetR2Key(DEAL, PROJECT, plainId, "image/jpeg");
    const colliderKey = deriveWalkthroughContactSheetR2Key(DEAL, PROJECT, colliderId, "image/jpeg");

    // The Files subsystem's OWN derivation, not a string this test invented — so the collision is stated
    // against the real thumbnail key rather than against a guess at it.
    const plainThumbnailKey = deriveThumbnailKey(plainKey);
    // Sanity: the fixture really does reach the condition it names. Without this, an unrelated change to
    // `deriveThumbnailKey` would make the assertion below vacuously true.
    expect(plainThumbnailKey).toBe(`walkthroughs/${DEAL}/${PROJECT}/${plainId}/thumbs/contact-sheet.jpg`);

    // THE FINDING, reproduced: raw interpolation would have made these two the same object.
    expect(`walkthroughs/${DEAL}/${PROJECT}/${colliderId}/contact-sheet.jpg`).toBe(plainThumbnailKey);
    // ...and the fix: encoded, the collider cannot name it.
    expect(colliderKey).not.toBe(plainThumbnailKey);

    // Both ingest, end to end, onto distinct objects — through the real unique index on `files.r2_key`.
    const plain = await ingestWalkthrough({ tenantDb, payload: walkthroughPayload(plainId) });
    const collider = await ingestWalkthrough({ tenantDb, payload: walkthroughPayload(colliderId) });

    const [plainFile] = await tenantDb.select().from(files).where(eq(files.id, plain.fileId));
    const [colliderFile] = await tenantDb.select().from(files).where(eq(files.id, collider.fileId));
    expect(plainFile.r2Key).toBe(plainKey);
    expect(colliderFile.r2Key).toBe(colliderKey);
    expect(colliderFile.r2Key.split("/")).toHaveLength(5);
  });

  // R30's second-order cost, and the reason `MAX_WALKTHROUGH_ID_CHARS` no longer covers both columns:
  // `files.system_filename` composes the id RAW (484 characters fill its varchar(500)) while `files.r2_key`
  // now composes it ENCODED, and encoding trebles a `/`-dense id. An id that clears the first bound can
  // therefore still be a 22001 on the first write — the failure shape this validator exists to prevent.
  it("refuses a walkthroughId whose percent-encoded form overflows the r2 key column", async () => {
    const before = await tableCounts();
    const walkthroughId = "/".repeat(400);

    // SPECIES-3 GUARD: this id is comfortably inside the system_filename bound, so that check cannot be
    // what fires — only the encoded one can.
    expect(walkthroughId.length).toBeLessThanOrEqual(MAX_WALKTHROUGH_ID_CHARS);
    expect(encodeWalkthroughIdKeySegment(walkthroughId).length).toBeGreaterThan(
      MAX_WALKTHROUGH_ENCODED_ID_CHARS
    );

    await expect(
      ingestWalkthrough({ tenantDb, payload: walkthroughPayload(walkthroughId) })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("percent-encodes"),
    });

    expect(await tableCounts()).toEqual(before);
  });

  // The accepting side of the same bound, AT THE EXACT BOUNDARY, and it is the assertion that found the
  // bound's first draft wrong. 296 slashes encode to exactly the limit; the r2 key lands on 993 and the
  // THUMBNAIL key — `<dir>/thumbs/<stem>.jpg`, seven characters longer, and `files.thumbnail_r2_key` is
  // a varchar(1000) too — lands on exactly 1000. So the thumbnail is the column that binds, which the
  // first draft (measured against `r2_key` alone) missed and this test caught as a 22001.
  //
  // Measured against real SQL rather than against the constant the bound was computed from, so an
  // off-by-one that made the limit one character too generous fails here as a database error instead of
  // passing arithmetic.
  it("accepts a walkthroughId whose encoding lands exactly inside the object-key columns", async () => {
    const walkthroughId = "/".repeat(296);
    expect(encodeWalkthroughIdKeySegment(walkthroughId).length).toBe(MAX_WALKTHROUGH_ENCODED_ID_CHARS);

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId),
    });

    const stored = await pg.query<{ key_len: number; thumb_len: number; key: string }>(
      `SELECT length(r2_key)::int AS key_len, length(thumbnail_r2_key)::int AS thumb_len, r2_key AS key
         FROM public.files WHERE id = $1`,
      [result.fileId]
    );
    // BOTH columns, filled to their limit — the thumbnail exactly, which is what makes it the binding one.
    expect(stored.rows[0].key_len).toBe(993);
    expect(stored.rows[0].thumb_len).toBe(1000);
    // Still ONE segment for the id, at 296 slashes — the encoding is what makes the length bound
    // meaningful in the first place.
    expect(stored.rows[0].key.split("/")).toHaveLength(5);
  });

  // The relationship the bound RESTS on, pinned against the real function rather than against the
  // service's local `THUMBNAIL_KEY_OVERHEAD_CHARS` constant. The service cannot import
  // `deriveThumbnailKey` (it would put sharp on a pure-database module's import path — see the R26 note),
  // so this is where the seven characters are actually checked. If `deriveThumbnailKey` ever changes
  // shape, this fails rather than `MAX_WALKTHROUGH_ENCODED_ID_CHARS` quietly becoming too generous.
  it("derives a thumbnail key exactly seven characters longer than its original, for both mime types", () => {
    for (const [mimeType, extension] of [
      ["image/jpeg", ".jpg"],
      ["application/pdf", ".pdf"],
    ] as const) {
      const key = deriveWalkthroughContactSheetR2Key(DEAL, PROJECT, "wt-9300", mimeType);
      expect(key.endsWith(extension)).toBe(true);
      expect(deriveThumbnailKey(key).length - key.length).toBe("thumbs/".length);
    }
  });

  it("scopes the retry check to the deal, so the same walkthrough on another deal still ingests", async () => {
    const walkthroughId = U("33010");

    // Deal-level on BOTH sides, so `dealId` is the only component of the dedupe triple that differs —
    // otherwise this would also pass on a projectId difference and prove less than it claims. (It is
    // also what keeps the second call clear of the R19 ownership check, which would otherwise refuse
    // DEAL's project on another deal — correctly, but for an unrelated reason.)
    const first = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { projectId: null }),
    });
    const other = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, {
        dealId: U("11112"),
        projectId: null,
      }),
    });

    // Dedupe is on (dealId, projectId, contentHash) — the same triple document-service.ts:104-130
    // uses — so it cannot swallow a legitimate second ingress onto a different deal.
    expect(other.documentId).not.toBe(first.documentId);
  });

  // ── R20: the project-ownership check takes a ROW LOCK ───────────────────────────────────────────────
  //
  // WHAT PGLITE CAN AND CANNOT SHOW, stated before the assertions so neither is oversold.
  //
  // CANNOT: PGlite is a SINGLE-CONNECTION engine. The hazard is a genuinely concurrent
  // `upsertProjectMirror` re-parenting the project between our ownership SELECT and our writes
  // (projects/service.ts:412, `source_deal_id = COALESCE(EXCLUDED.source_deal_id, …)`), and two
  // connections cannot be expressed here at all. A test that "simulated" it by interleaving awaits on one
  // connection would prove nothing about locking — species 6.
  //
  // CAN, and these are the two assertions below:
  //   1. STATEMENT LEVEL — the SQL the service actually sends carries `for share`. That is what pins the
  //      MODE, and it is the only thing that distinguishes `for share` from `for key share` here.
  //   2. ENGINE LEVEL — while the ingress transaction is still open, `pg_locks` shows a RowShareLock on
  //      `projects` rather than the AccessShareLock a plain SELECT takes. That proves the clause is in
  //      force in the engine and not merely present in a string. It does NOT distinguish the strengths:
  //      verified in PGlite that `for key share`, `for share` and `for update` all report RowShareLock at
  //      relation level (the strength lives in the tuple header, not in pg_locks), which is exactly why
  //      assertion 1 exists.
  //
  // THE BLOCKING CLAIM ITSELF was verified out of band on real Postgres 16.14 with two concurrent
  // connections — session A holding the lock, session B running the re-parent UPDATE under `lock_timeout`:
  //   no clause → UPDATE proceeds (the race);  for key share → UPDATE proceeds (a non-key column update
  //   is precisely what KEY SHARE permits);  for share → UPDATE blocks, 55P03, row unchanged;
  //   for update → blocks too, but needlessly also blocks another ingress that merely reads the project.
  // Recorded in the PR discussion; it cannot be re-run from this suite.
  it("locks the project row it just authorized, in the mode that blocks a re-parent", async () => {
    const walkthroughId = U("34010");

    executedSql.length = 0;
    let heldModes: string[] = [];

    // Run the real ingress inside an OUTER transaction we control, so we are still inside it when the
    // ingress returns: row locks are held until the transaction ends, so this is the only window in which
    // the lock is observable from one connection. The fake `transaction` hands the body our own tx rather
    // than opening a nested one.
    await loggingDb.transaction(async (outerTx: any) => {
      await ingestWalkthroughService({
        tenantDb: { transaction: (body: (tx: unknown) => unknown) => body(outerTx) } as never,
        payload: walkthroughPayload(walkthroughId),
        contactSheetStore: contactSheetStoreFor(walkthroughPayload(walkthroughId)),
      });

      const held: any = await outerTx.execute(
        sql`select mode from pg_locks l join pg_class c on c.oid = l.relation where c.relname = 'projects'`
      );
      heldModes = (held?.rows ?? held).map((row: { mode: string }) => row.mode);
    });

    // 1. STATEMENT LEVEL. Filtered rather than indexed, and the count is asserted: a filter that matched
    //    nothing would otherwise make every assertion below vacuously true — the species-4 shape.
    const projectSelects = executedSql.filter((statement) => /from "projects"/i.test(statement));
    expect(projectSelects).toHaveLength(1);
    expect(projectSelects[0].toLowerCase()).toContain("for share");
    // ...and NOT the weaker mode, spelled out because the two read almost identically. "for key share"
    // does not contain "for share" as a substring, so the assertion above already excludes it; this one
    // says so in the failure message.
    expect(projectSelects[0].toLowerCase()).not.toContain("for key share");

    // 2. ENGINE LEVEL. The clause really took a row-level lock: a plain SELECT leaves only
    //    AccessShareLock on the relation.
    expect(heldModes).toContain("RowShareLock");
    expect(heldModes).not.toEqual(["AccessShareLock"]);
  });

  // ── R21: the DEAL is re-read and locked inside the write transaction ────────────────────────────────
  //
  // The route proves the deal is active before it calls in, but that check runs in its own statement
  // outside the service's transaction — a TOCTOU gate. A deal archived in the window between them left
  // the request creating a file, a source document, a parse run and extraction rows under a deal no CRM
  // screen will ever show, and answering 201 so the sender recorded it as filed.
  //
  // The check belongs HERE and not only at the door for the same reason the project check does: the
  // ingress is reachable by any caller, and a guarantee that lives in one route is not a guarantee.
  it("REFUSES a DEACTIVATED actor, and writes nothing", async () => {
    // The same TOCTOU as the deal, one row over. `payload.userId` is stamped on `files.uploadedBy`
    // and the source document's uploader, so a walkthrough filed under a revoked account puts a
    // name the system has switched off onto a client-facing estimate's source material. Callers
    // prove the actor before calling in; that proof is a separate statement in a separate
    // transaction, so only a re-read inside this one is authoritative.
    const before = await tableCounts();

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("35020"), { projectId: null, userId: DEACTIVATED_USER }),
      })
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(await tableCounts()).toEqual(before);
  });

  it("REFUSES an office switched off mid-write, when the caller names one", async () => {
    // The tenant schema is bound once, at connection setup, and never re-checks itself — so an
    // office deactivated after admission still had its whole chain written and answered 201.
    // `officeId` travels with the call because the service genuinely cannot derive it: the session
    // carries a search_path, not an id.
    const before = await tableCounts();

    await expect(
      ingestWalkthroughService({
        tenantDb: tenantDb as never,
        payload: walkthroughPayload(U("35021"), { projectId: null }),
        contactSheetStore: contactSheetStoreFor(walkthroughPayload(U("35021"), { projectId: null })),
        officeId: INACTIVE_OFFICE,
      })
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(await tableCounts()).toEqual(before);
  });

  it("ACCEPTS an active office named by the caller, so the guard is not simply refusing everything", async () => {
    // The counterweight: without this, the test above would pass just as well against a guard that
    // rejected every `officeId` it was handed.
    const result = await ingestWalkthroughService({
      tenantDb: tenantDb as never,
      payload: walkthroughPayload(U("35022"), { projectId: null }),
      contactSheetStore: contactSheetStoreFor(walkthroughPayload(U("35022"), { projectId: null })),
      officeId: ACTIVE_OFFICE,
    });
    expect(result.documentId).toBeTruthy();
  });

  it("REFUSES a soft-deleted deal, and writes nothing", async () => {
    const before = await tableCounts();

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("35010"), { dealId: ARCHIVED_DEAL, projectId: null }),
      })
    ).rejects.toMatchObject({ statusCode: 404 });

    // The transaction must have rolled back whole. A partial chain is the failure mode that makes this
    // worth asserting on counts rather than on the throw alone: the contact sheet file is written
    // BEFORE the extractions, so "it threw" and "it wrote nothing" are genuinely separate claims.
    expect(await tableCounts()).toEqual(before);
  });

  it("locks the deal row it just authorized, in the mode that blocks an archive", async () => {
    const walkthroughId = U("35011");

    executedSql.length = 0;
    let heldModes: string[] = [];

    await loggingDb.transaction(async (outerTx: any) => {
      await ingestWalkthroughService({
        tenantDb: { transaction: (body: (tx: unknown) => unknown) => body(outerTx) } as never,
        payload: walkthroughPayload(walkthroughId, { projectId: null }),
        contactSheetStore: contactSheetStoreFor(walkthroughPayload(walkthroughId, { projectId: null })),
      });

      const held: any = await outerTx.execute(
        sql`select mode from pg_locks l join pg_class c on c.oid = l.relation where c.relname = 'deals'`
      );
      heldModes = (held?.rows ?? held).map((row: { mode: string }) => row.mode);
    });

    // 1. STATEMENT LEVEL, and the count is asserted so a filter that matched nothing cannot make the
    //    rest vacuous — the same shape as the projects lock test above.
    const dealSelects = executedSql.filter((statement) => /from "deals"/i.test(statement));
    expect(dealSelects).toHaveLength(1);
    expect(dealSelects[0].toLowerCase()).toContain("for share");
    // `is_active` is a NON-KEY column, so `for key share` would let the archive UPDATE straight through
    // — exactly the mode confusion the projects lock test documents. Spelled out for the failure message.
    expect(dealSelects[0].toLowerCase()).not.toContain("for key share");

    // 2. ENGINE LEVEL: a real row lock, not merely a clause in a string.
    expect(heldModes).toContain("RowShareLock");
    expect(heldModes).not.toEqual(["AccessShareLock"]);
  });

  // The negative half of assertion 2, and what makes it non-vacuous: the SAME probe on a table the ingress
  // only READS shows the plain-select mode. Without this, "RowShareLock is present" could be an artifact
  // of anything else the transaction did.
  it("leaves the tables it only reads on the plain-select lock mode", async () => {
    const walkthroughId = U("34011");
    let documentModes: string[] = [];

    await loggingDb.transaction(async (outerTx: any) => {
      await ingestWalkthroughService({
        tenantDb: { transaction: (body: (tx: unknown) => unknown) => body(outerTx) } as never,
        payload: walkthroughPayload(walkthroughId, { projectId: null }),
        contactSheetStore: contactSheetStoreFor(walkthroughPayload(walkthroughId)),
      });
      const held: any = await outerTx.execute(
        sql`select mode from pg_locks l join pg_class c on c.oid = l.relation
             where c.relname = 'projects' and l.mode = 'RowShareLock'`
      );
      documentModes = (held?.rows ?? held).map((row: { mode: string }) => row.mode);
    });

    // A DEAL-LEVEL walkthrough never resolves a project, so nothing locked a projects row — the mode the
    // test above found is attributable to the ownership SELECT specifically.
    expect(documentModes).toEqual([]);
  });

  // ── R21: replay compares row fingerprints AND the envelope ──────────────────────────────────────────
  //
  // The replay path validated per-row fingerprints and returned the original chain while never looking at
  // `contactSheetMimeType`, `contactSheetBytes`, `capturedAt` or `siteLabel`. The MIME case is the
  // damaging one: the R2 key is DERIVED from the mime type, so a corrected mime means the sender uploaded
  // the corrected sheet to a NEW key while the replayed response still points at the old one — a 200, and
  // a sender that believes the correction landed.
  //
  // Each case changes exactly ONE envelope field and nothing else, so no other guard can be what fires
  // (species 3). All four go through the same 409 path as the row-level drift, naming the field.
  it.each<[string, string, Partial<WalkthroughIngressPayload>]>([
    ["contactSheetMimeType", U("34020"), { contactSheetMimeType: "application/pdf" }],
    ["contactSheetBytes", U("34021"), { contactSheetBytes: 999_999 }],
    ["siteLabel", U("34022"), { siteLabel: "Unit 14C" }],
    ["capturedAt", U("34023"), { capturedAt: "2026-07-30T14:05:00Z" }],
  ])("refuses a replay whose %s changed, naming that field", async (field, walkthroughId, override) => {
    const first = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId),
    });
    // Proof this case built its own chain rather than replaying another case's document.
    expect(first.extractionIds).toHaveLength(1);

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(walkthroughId, override),
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      // NAMES THE FIELD. A single "the envelope changed" message would satisfy the status code for all
      // four cases while telling the sender nothing, and would let one comparison stand in for four.
      message: expect.stringContaining(field),
    });

    // READ BACK FROM THE DATABASE. The failure being guarded is "the original was silently kept and
    // reported as success", so the stored row is the only place the outcome is visible.
    const [storedFile] = await tenantDb.select().from(files).where(eq(files.id, first.fileId));
    expect(storedFile.mimeType).toBe("image/jpeg");
    expect(storedFile.fileSizeBytes).toBe(184320);
    expect(storedFile.displayName).toBe(buildWalkthroughContactSheetDisplayName("Unit 12B"));

    // And the refusal wrote no second chain for the corrected envelope either — counted, because
    // duplication is the risk.
    const documents = await tenantDb
      .select({ id: estimateSourceDocuments.id })
      .from(estimateSourceDocuments)
      .where(eq(estimateSourceDocuments.contentHash, walkthroughContentHash(walkthroughId)));
    expect(documents).toHaveLength(1);
  });

  // The mime case stated as its HARM rather than as a table row: the two keys, side by side. This is the
  // assertion that explains why an envelope check was worth a 409 at all.
  it("names both R2 keys when the corrected mime type moved the object", async () => {
    const walkthroughId = U("34024");

    const first = await ingestWalkthrough({ tenantDb, payload: walkthroughPayload(walkthroughId) });

    const storedKey = `walkthroughs/${DEAL}/${PROJECT}/${walkthroughId}/contact-sheet.jpg`;
    const correctedKey = `walkthroughs/${DEAL}/${PROJECT}/${walkthroughId}/contact-sheet.pdf`;

    // The stored chain really is on the .jpg key — otherwise the message assertions below would be about
    // strings this test invented.
    const [storedFile] = await tenantDb.select().from(files).where(eq(files.id, first.fileId));
    expect(storedFile.r2Key).toBe(storedKey);

    const failure = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { contactSheetMimeType: "application/pdf" }),
    }).catch((error: Error) => error);

    expect((failure as { statusCode?: number }).statusCode).toBe(409);
    // BOTH keys, so the sender can see that its corrected upload went somewhere this document does not
    // point at — the whole reason a 200 here was dangerous rather than merely untidy.
    expect((failure as Error).message).toContain(storedKey);
    expect((failure as Error).message).toContain(correctedKey);
  });

  // The other half of the contract, and the guard against an over-tight envelope check: a byte-identical
  // envelope must still replay, and two SPELLINGS of one instant are the same capture. `capturedAt` is
  // compared as an instant precisely so this does not 409.
  it("still replays when only the capturedAt spelling differs, naming the same instant", async () => {
    const walkthroughId = U("34025");

    const first = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { capturedAt: "2026-07-29T14:05:00Z" }),
    });

    // Same instant, three ways of writing it: with milliseconds, and as a -05:00 offset. All must replay.
    for (const spelling of ["2026-07-29T14:05:00.000Z", "2026-07-29T09:05:00-05:00"]) {
      const replay = await ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(walkthroughId, { capturedAt: spelling }),
      });
      expect(replay).toEqual(first);
    }
  });

  // ── R23: the object has to be there, and be what was declared ───────────────────────────────────────
  //
  // The sender uploads the contact sheet to the derived key BEFORE it posts, and nothing checked. A failed
  // or in-flight pre-upload produced a full chain and a 201 — and because retries REPLAY that chain, no
  // later attempt would fix it: the estimator opens the evidence and gets a 404.
  //
  // Each case fails a DIFFERENT one of `confirmUpload`'s three checks (files/service.ts:773-785), and each
  // asserts nothing was written — the guard runs before the first write.
  it("refuses a walkthrough whose contact sheet is not in object storage", async () => {
    const before = await tableCounts();

    const failure = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(U("34030")),
      // The pre-upload never landed.
      contactSheetStore: { head: async () => null },
    }).catch((error: Error) => error);

    expect((failure as { statusCode?: number }).statusCode).toBe(400);
    // The DERIVED key, in the message: the sender cannot fix this without being told where to upload, and
    // it never sent the key in the first place (it is derived on both sides).
    expect((failure as Error).message).toContain(
      `walkthroughs/${DEAL}/${PROJECT}/${U("34030")}/contact-sheet.jpg`
    );
    // Refused BEFORE the first write, like every other guard in this seam's contract.
    expect(await tableCounts()).toEqual(before);
  });

  it("refuses a contact sheet whose stored Content-Type is not the declared one", async () => {
    const before = await tableCounts();

    const failure = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(U("34031")),
      // Present, but it is a PDF sitting at the .jpg key the jpeg declaration derived.
      contactSheetStore: {
        head: async () => ({ contentType: "application/pdf", contentLength: 184320 }),
      },
    }).catch((error: Error) => error);

    expect((failure as { statusCode?: number }).statusCode).toBe(400);
    // Names WHICH field disagreed and both values.
    expect((failure as Error).message).toContain("Content-Type");
    expect((failure as Error).message).toContain("application/pdf");
    expect((failure as Error).message).toContain("image/jpeg");
    expect(await tableCounts()).toEqual(before);
  });

  it("refuses a contact sheet whose stored byte count is not the declared one", async () => {
    const before = await tableCounts();

    const failure = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(U("34032")),
      contactSheetStore: {
        head: async () => ({ contentType: "image/jpeg", contentLength: 77 }),
      },
    }).catch((error: Error) => error);

    expect((failure as { statusCode?: number }).statusCode).toBe(400);
    expect((failure as Error).message).toContain("Content-Length");
    expect((failure as Error).message).toContain("77");
    expect((failure as Error).message).toContain("184320");
    expect(await tableCounts()).toEqual(before);
  });

  // The header-absent case, which is `confirmUpload`'s own tolerance rather than a hole we invented: R2 may
  // not report either header, and an absent header is not a mismatch. Without this, the two `!= null`
  // guards in the implementation would be untested and could be "simplified" away.
  it("accepts a verified object that reports no Content-Type or Content-Length", async () => {
    const walkthroughId = U("34033");

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId),
      contactSheetStore: { head: async () => ({}) },
    });

    expect(result.extractionIds).toHaveLength(1);
  });

  // The configured gate, mirroring `confirmUpload`'s `isR2Configured()`: with no object store the
  // verification is skipped rather than failing every ingress. Asserted so the behaviour is a decision on
  // the record — and so the gate cannot be removed silently, which would break every local dev ingest.
  it("skips verification entirely when no object store is configured", async () => {
    const walkthroughId = U("34034");
    const head = vi.fn(async () => null);

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId),
      // A store that would REFUSE if it were consulted — so a green here means it was not consulted.
      contactSheetStore: { isConfigured: () => false, head },
    });

    expect(result.extractionIds).toHaveLength(1);
    expect(head).not.toHaveBeenCalled();
  });

  // The verification reads the DERIVED key, not anything the payload could name. Pinned because a version
  // of this check that HEADed a caller-supplied key would restore exactly the confused-deputy read
  // primitive R1 removed — the caller could confirm the existence of any object in the bucket.
  it("verifies the derived key rather than any key the payload carried", async () => {
    const walkthroughId = U("34035");
    const seen: string[] = [];

    await ingestWalkthrough({
      tenantDb,
      // A hostile key smuggled under the wire name the validator drops. Cast because the field is not on
      // the contract at all — which is the point: it cannot reach a column even if a sender sends it.
      payload: {
        ...walkthroughPayload(walkthroughId),
        contactSheetR2Key: "deals/other-deal/contracts/master-agreement.pdf",
      } as WalkthroughIngressPayload,
      contactSheetStore: {
        head: async (r2Key) => {
          seen.push(r2Key);
          return { contentType: "image/jpeg", contentLength: 184320 };
        },
      },
    });

    expect(seen).toEqual([`walkthroughs/${DEAL}/${PROJECT}/${walkthroughId}/contact-sheet.jpg`]);
  });

  // ── R31: a replay's pre-upload silently overwrites committed evidence ───────────────────────────────
  //
  // The r2 key is DETERMINISTIC — that is what makes it safe, because no wire input can name another
  // deal's object. It also means a retry's REQUIRED pre-upload targets THE SAME KEY as the committed
  // contact sheet, and the contract is "upload, then post". So by the time the replay path looks at row
  // or envelope drift, the artifact this deal's `files` row points at has ALREADY been replaced. A 409
  // over the rows does not undo that write: the refusal is honest about the rows while the estimator is
  // shown evidence nobody verified against the rows they reviewed. Nothing in any column changes, which
  // is why it was silent.
  //
  // Each case leaves the PAYLOAD byte-identical to the first call's, so the envelope check cannot be what
  // fires (species 3) — only the HEAD of the stored object differs.
  it.each<[string, string, { contentType?: string; contentLength?: number }]>([
    ["Content-Length", U("34060"), { contentType: "image/jpeg", contentLength: 999_999 }],
    ["Content-Type", U("34061"), { contentType: "application/pdf", contentLength: 184320 }],
  ])(
    "refuses a replay whose committed contact sheet was overwritten (%s)",
    async (header, walkthroughId, nowAtTheKey) => {
      const first = await ingestWalkthrough({ tenantDb, payload: walkthroughPayload(walkthroughId) });
      // Proof this case built its own chain rather than replaying another case's document.
      expect(first.extractionIds).toHaveLength(1);
      const afterFirst = await tableCounts();

      const failure = await ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(walkthroughId),
        // The object at the derived key is no longer the one that was verified when this walkthrough was
        // ingested — i.e. the retry re-uploaded before it posted.
        contactSheetStore: { head: async () => nowAtTheKey },
      }).catch((error: Error) => error);

      expect((failure as { statusCode?: number }).statusCode).toBe(409);
      // NAMES THE HEADER that disagreed, and the key, so the sender can tell this from a row conflict.
      expect((failure as Error).message).toContain(header);
      expect((failure as Error).message).toContain(
        `walkthroughs/${DEAL}/${PROJECT}/${walkthroughId}/contact-sheet.jpg`
      );
      // ...and the MECHANISM, not just the symptom: this is what makes the message actionable.
      expect((failure as Error).message).toContain("overwrote committed evidence");

      // READ BACK FROM THE DATABASE. The failure being guarded is "reported as a successful replay", so
      // the stored row is where the outcome is visible — and the refusal must not have rewritten it to
      // match the new object either.
      const [storedFile] = await tenantDb.select().from(files).where(eq(files.id, first.fileId));
      expect(storedFile.mimeType).toBe("image/jpeg");
      expect(storedFile.fileSizeBytes).toBe(184320);
      expect(await tableCounts()).toEqual(afterFirst);
    }
  );

  // The other half of the contract, and the guard against a check that 409s every retry: an UNCHANGED
  // object must still replay. Also pins WHICH key is HEADed — the one stored on the `files` row, i.e. the
  // object this document actually points at.
  it("still replays when the object at the committed key is unchanged", async () => {
    const walkthroughId = U("34062");
    const storedKey = `walkthroughs/${DEAL}/${PROJECT}/${walkthroughId}/contact-sheet.jpg`;
    const first = await ingestWalkthrough({ tenantDb, payload: walkthroughPayload(walkthroughId) });

    const seen: string[] = [];
    const second = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId),
      contactSheetStore: {
        head: async (r2Key) => {
          seen.push(r2Key);
          return { contentType: "image/jpeg", contentLength: 184320 };
        },
      },
    });

    expect(second).toEqual(first);
    expect(seen).toEqual([storedKey]);
  });

  // The header-absent case, the same tolerance the fresh-ingest verification extends and for the same
  // reason: R2 may not report either header, and an absent header is not a change. Without this the two
  // `!= null` guards in `detectWalkthroughContactSheetArtifactDrift` would be untested.
  it("still replays when the object reports no Content-Type or Content-Length", async () => {
    const walkthroughId = U("34063");
    const first = await ingestWalkthrough({ tenantDb, payload: walkthroughPayload(walkthroughId) });

    const second = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId),
      contactSheetStore: { head: async () => ({}) },
    });

    expect(second).toEqual(first);
  });

  // A DELIBERATE SCOPE LINE, asserted so it is a decision rather than an accident: an object that is GONE
  // is not overwrite drift. The replay path reconciles a submission against stored state; it is not an
  // audit of the bucket, and failing every retry after a lifecycle deletion would make the seam worse.
  it("still replays when the committed object has since been deleted", async () => {
    const walkthroughId = U("34064");
    const first = await ingestWalkthrough({ tenantDb, payload: walkthroughPayload(walkthroughId) });

    const second = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId),
      contactSheetStore: { head: async () => null },
    });

    expect(second).toEqual(first);
  });

  // The configured gate on the REPLAY path, mirroring the fresh one: with no object store the artifact
  // check is skipped rather than failing every replay in local dev and CI.
  it("does not consult object storage on a replay when none is configured", async () => {
    const walkthroughId = U("34065");
    const first = await ingestWalkthrough({ tenantDb, payload: walkthroughPayload(walkthroughId) });
    // A store that would REFUSE if it were consulted — so a green here means it was not consulted.
    const head = vi.fn(async () => ({ contentType: "application/pdf", contentLength: 1 }));

    const second = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId),
      contactSheetStore: { isConfigured: () => false, head },
    });

    expect(second).toEqual(first);
    expect(head).not.toHaveBeenCalled();
  });

  // ── R33: "we could not check" is not "your object is missing" ───────────────────────────────────────
  //
  // The production store wired `head` to `headObject`, whose own docblock calls itself "best-effort":
  // `try { headObjectStrict } catch { return null }` (r2-client.ts:210-220). So a 403, a timeout, a DNS
  // blip or R2 being down all arrived here as `null`, and ingress answered with the NON-RETRYABLE 400
  // that means "your upload is not there, fix it and re-post" — an answer a correct integration acts on
  // by abandoning a perfectly good upload. The port now promises null ONLY for a genuine not-found and a
  // THROW for everything else; these two tests are the two arms of that promise.
  it("refuses with a retryable 5xx when object storage cannot be reached at all", async () => {
    const before = await tableCounts();

    const failure = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(U("34070")),
      // What `headObjectStrict` does with a non-404: it rethrows. `headObject` would have swallowed this
      // into a null — which is exactly the mutation this test exists to catch.
      contactSheetStore: {
        head: async () => {
          throw Object.assign(new Error("connect ETIMEDOUT"), {
            $metadata: { httpStatusCode: 500 },
          });
        },
      },
    }).catch((error: Error) => error);

    // 5xx, so the sender's retry logic comes back rather than treating this as its own fault.
    expect((failure as { statusCode?: number }).statusCode).toBe(503);
    // ...and the message says so explicitly, because the two conditions are one word apart in effect.
    expect((failure as Error).message).toContain("NOT a statement that the object is missing");
    // Nothing was written: this still runs before the first write.
    expect(await tableCounts()).toEqual(before);
  });

  // The OTHER arm, so the pair proves a DISTINCTION rather than one behaviour. Without this, "storage
  // failures are 503" could be satisfied by making every HEAD miss a 503 — which would be a new bug.
  it("still refuses a genuinely absent object with a non-retryable 400", async () => {
    const before = await tableCounts();

    const failure = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(U("34071")),
      // `headObjectStrict`'s null: a real 404 / NoSuchKey, and nothing else.
      contactSheetStore: { head: async () => null },
    }).catch((error: Error) => error);

    expect((failure as { statusCode?: number }).statusCode).toBe(400);
    expect((failure as Error).message).toContain("is not in object storage at its derived key");
    expect(await tableCounts()).toEqual(before);
  });

  // The same distinction on the REPLAY path, where swallowing is worse than a wrong status code: a HEAD
  // that failed would read as "the artifact is unchanged" and wave the submission through, which is the
  // R33 conflation defeating the R31 check.
  it("refuses a replay with a retryable 5xx when the artifact HEAD fails", async () => {
    const walkthroughId = U("34072");
    const first = await ingestWalkthrough({ tenantDb, payload: walkthroughPayload(walkthroughId) });
    expect(first.extractionIds).toHaveLength(1);

    const failure = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId),
      contactSheetStore: {
        head: async () => {
          throw new Error("connect ETIMEDOUT");
        },
      },
    }).catch((error: Error) => error);

    expect((failure as { statusCode?: number }).statusCode).toBe(503);
    expect((failure as Error).message).toContain("NOT a statement that the object is missing");
  });

  // ── R25: the file list must not present the original as its tile image ──────────────────────────────
  //
  // `resolveFileThumbnailUrl` (files/service.ts:1574-1580) presigns `thumbnailR2Key` when there is one and
  // otherwise falls through to `isThumbnailableImage(mimeType) && r2Key` — the ORIGINAL. So a jpeg contact
  // sheet with a null thumbnail makes opening a deal's file list download the whole sheet to draw one
  // tile. (A pdf sheet fails that predicate and gets a badge, which is why only jpeg was affected.)
  //
  // Fixed by calling the Files subsystem's OWN helpers rather than by adding a second derived key the
  // sender must upload: see the parity audit on `WalkthroughContactSheetStore`.
  it("stores the thumbnail key the image helper produced for a jpeg contact sheet", async () => {
    const walkthroughId = U("34040");
    const derivedKey = `walkthroughs/${DEAL}/${PROJECT}/${walkthroughId}/contact-sheet.jpg`;
    const pdfArm = vi.fn(async () => null);

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId),
      contactSheetStore: { generatePdfThumbnail: pdfArm },
    });

    // READ BACK FROM THE DATABASE: the column is what `resolveFileThumbnailUrl` reads.
    const [file] = await tenantDb.select().from(files).where(eq(files.id, result.fileId));
    expect(file.thumbnailR2Key).toBe(deriveThumbnailKey(derivedKey));
    // Non-null is the property that actually matters — a null here is the fallback that serves the
    // original as the list image.
    expect(file.thumbnailR2Key).not.toBeNull();
    // The image arm answered, so the fallback chain stopped there.
    expect(pdfArm).not.toHaveBeenCalled();
  });

  it("falls through to the pdf arm for a pdf contact sheet", async () => {
    const walkthroughId = U("34041");
    const derivedKey = `walkthroughs/${DEAL}/${PROJECT}/${walkthroughId}/contact-sheet.pdf`;

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { contactSheetMimeType: "application/pdf" }),
    });

    // The default fakes self-gate exactly as the real helpers do, so reaching this key means the image arm
    // returned null and the chain continued — the composition confirmUpload uses.
    const [file] = await tenantDb.select().from(files).where(eq(files.id, result.fileId));
    expect(file.thumbnailR2Key).toBe(deriveThumbnailKey(derivedKey));
  });

  it("still ingests when neither thumbnail arm can produce one", async () => {
    const walkthroughId = U("34042");

    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId),
      contactSheetStore: {
        generateImageThumbnail: async () => null,
        generatePdfThumbnail: async () => null,
      },
    });

    // BEST-EFFORT, matching confirmUpload: a thumbnail is a tile, not a reason to refuse a walkthrough.
    expect(result.extractionIds).toHaveLength(1);
    const [file] = await tenantDb.select().from(files).where(eq(files.id, result.fileId));
    expect(file.thumbnailR2Key).toBeNull();
  });
});

// ── R24: capturedAt has to name a date that exists ────────────────────────────────────────────────────
//
// `Number.isNaN(new Date(value).getTime())` — the whole of the old check — PASSES for 2026-02-30, which
// JavaScript silently normalizes to March 2. `files.taken_at` then records a capture instant two days off
// and every chronological view of the evidence misorders it, which is the exact problem storing `taken_at`
// structurally was meant to solve.
//
// The cases are split by WHICH check catches them, because that is the species-2 question: an impossible
// date that was already NaN would never reach the new calendar check, and a test that could not tell the
// difference would pass either way.
describe("capturedAt calendar validation", () => {
  // SILENT SHIFTS — not NaN, so the old check accepted them. Verified on this Node: 2026-02-30 parses to
  // 2026-03-02 and 2026-04-31 to 2026-05-01. These are the cases the calendar round-trip exists for, and
  // the ONLY ones that reach it.
  it.each([
    ["february 30th", "2026-02-30T00:00:00Z", "2026-03-02"],
    ["april 31st", "2026-04-31T00:00:00Z", "2026-05-01"],
    ["february 29th of a non-leap year", "2026-02-29T00:00:00Z", "2026-03-01"],
  ])("refuses %s, which JavaScript would have shifted", async (_label, capturedAt, shiftsTo) => {
    // The premise, asserted rather than assumed: this string really does parse without NaN, so the check
    // that catches it can only be the calendar one. Without this the test would still pass if the value
    // were rejected for being unparseable — a different bug, and not the one under test.
    expect(Number.isNaN(new Date(capturedAt).getTime())).toBe(false);
    expect(new Date(capturedAt).toISOString().slice(0, 10)).toBe(shiftsTo);

    const before = await tableCounts();
    await expect(
      ingestWalkthrough({ tenantDb, payload: walkthroughPayload(U("34050"), { capturedAt }) })
    ).rejects.toMatchObject({
      statusCode: 400,
      // Names the field AND the day it would have become, so the sender can see the shift.
      message: expect.stringContaining("capturedAt"),
    });
    await expect(
      ingestWalkthrough({ tenantDb, payload: walkthroughPayload(U("34050"), { capturedAt }) })
    ).rejects.toMatchObject({ message: expect.stringContaining(shiftsTo) });
    expect(await tableCounts()).toEqual(before);
  });

  // An out-of-range month, which V8 rejects outright — so this is caught by the calendar check ONLY
  // because the calendar check runs first. Recorded as a distinct case so the ordering is deliberate
  // rather than incidental: swap the two checks and the message changes.
  it("refuses a thirteenth month", async () => {
    expect(Number.isNaN(new Date("2026-13-01T00:00:00Z").getTime())).toBe(true);

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("34051"), { capturedAt: "2026-13-01T00:00:00Z" }),
      })
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("capturedAt") });
  });

  // The one case that reaches the PARSE check — the calendar day exists, so only the time-of-day is
  // wrong. Without it that check would be unreachable from any test and could be deleted as dead.
  it("refuses a twenty-fifth hour on a real calendar day", async () => {
    // The date part is a real day, so the calendar check passes it through: the parse check is what fires.
    expect(new Date(Date.UTC(2026, 6, 29)).getUTCDate()).toBe(29);
    expect(Number.isNaN(new Date("2026-07-29T25:00:00Z").getTime())).toBe(true);

    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("34056"), { capturedAt: "2026-07-29T25:00:00Z" }),
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("not a parseable timestamp"),
    });
  });

  // A timestamp with no offset names a LOCAL wall-clock time, not an instant, so what lands on
  // `files.taken_at` would depend on the server's timezone.
  it("refuses a timestamp with no UTC designator or offset", async () => {
    await expect(
      ingestWalkthrough({
        tenantDb,
        payload: walkthroughPayload(U("34052"), { capturedAt: "2026-07-29T14:05:00" }),
      })
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("offset") });
  });

  // THE OVER-TIGHTNESS CONTROL, and it is the half that makes the rest of this block meaningful: a check
  // that refused everything would satisfy every assertion above. A real leap day, a real offset timestamp
  // whose UTC day is the NEXT one (which is why the calendar check reads the string's own components
  // rather than the parsed instant), and a plain UTC timestamp all have to be accepted and stored as the
  // instant they name.
  it.each([
    ["a leap day", U("34053"), "2028-02-29T09:30:00Z", "2028-02-29T09:30:00.000Z"],
    ["an offset timestamp whose UTC day differs", U("34054"), "2026-07-29T23:00:00-05:00", "2026-07-30T04:00:00.000Z"],
    ["fractional seconds", U("34055"), "2026-07-29T14:05:00.250Z", "2026-07-29T14:05:00.250Z"],
  ])("accepts %s and stores the instant it names", async (_label, walkthroughId, capturedAt, instant) => {
    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { capturedAt }),
    });

    const [file] = await tenantDb.select().from(files).where(eq(files.id, result.fileId));
    expect(file.takenAt.toISOString()).toBe(instant);
  });
});

// ── R22: our content hash must not share a namespace with an upload's ─────────────────────────────────
//
// We protected OURSELVES with `documentType = 'walkthrough'` on the idempotency lookup and left the other
// producer exposed. `createEstimateSourceDocument` (document-service.ts:104-130) dedupes ORDINARY uploads
// on (dealId, projectId, contentHash) with NO documentType predicate — so a walkthrough id that happened
// to equal an upload's content hash on the same deal and project would make that upload match OUR
// completed walkthrough document, return it, and skip its OCR enqueue entirely. The upload is accepted and
// silently never parsed.
//
// Fixed on our side only, by prefixing the stored hash: the shared function is left alone.
describe("walkthrough content hash namespace", () => {
  it("leaves an ordinary upload sharing the raw walkthrough id free to enqueue its own parse", async () => {
    const walkthroughId = U("34060");

    const ingested = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId),
    });

    // A real `files` row for the ordinary upload, so this goes through createEstimateSourceDocument the
    // way routes.ts does rather than through a stub.
    const uploadFileId = await createWalkthroughContactSheetFile({
      tenantDb,
      input: {
        dealId: DEAL,
        walkthroughId: U("34061"),
        siteLabel: "Level 2 plan set",
        r2Key: `estimate/${DEAL}/level-2-plans.pdf`,
        thumbnailR2Key: null,
        r2Bucket: CRM_BUCKET,
        bytes: 8192,
        mimeType: "application/pdf",
        capturedAt: "2026-07-29T14:05:00Z",
        userId: USER,
      },
    });

    // Typed on its payload so the assertion below can read `documentId` off the recorded call rather than
    // only counting invocations.
    const enqueue = vi.fn(async (_payload: { documentId: string }) => {});
    const upload = await createEstimateSourceDocument({
      tenantDb,
      enqueueEstimateDocumentOcr: enqueue,
      input: {
        dealId: DEAL,
        projectId: PROJECT,
        fileId: uploadFileId,
        filename: "Level 2 plan set.pdf",
        mimeType: "application/pdf",
        // THE COLLISION: an ordinary upload whose content hash is exactly the walkthrough's raw id, on the
        // same deal and the same project. This is the input that used to match the walkthrough document.
        contentHash: walkthroughId,
        userId: USER,
        officeId: null,
      },
    });

    // It got its OWN document, not the walkthrough's.
    expect(upload.id).not.toBe(ingested.documentId);
    // ...and — the part that was silently skipped — its parse was ENQUEUED. A dedupe hit returns early,
    // before the enqueue, so this assertion is the one that fails when the namespaces collide.
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({ documentId: upload.id });

    // Two documents on this (deal, project) whose hash mentions this walkthrough id — ours namespaced,
    // theirs raw. COUNTED, because "the upload silently became the walkthrough" is a missing row.
    const documents = await tenantDb
      .select({ id: estimateSourceDocuments.id, contentHash: estimateSourceDocuments.contentHash })
      .from(estimateSourceDocuments)
      .where(
        sql`${estimateSourceDocuments.contentHash} IN (${walkthroughId}, ${walkthroughContentHash(walkthroughId)})`
      );
    expect(documents).toHaveLength(2);
    expect(documents.map((row: { contentHash: string }) => row.contentHash).sort()).toEqual(
      [walkthroughId, walkthroughContentHash(walkthroughId)].sort()
    );

    // The walkthrough's own replay still works — the prefix is applied on BOTH sides of the lookup, and a
    // one-sided change would make every retry build a second chain instead.
    const replay = await ingestWalkthrough({ tenantDb, payload: walkthroughPayload(walkthroughId) });
    expect(replay).toEqual(ingested);
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
        thumbnailR2Key: null,
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

    // Deal-level: this suite's `projects` fixtures belong to DEAL, and the workbench loads extractions
    // by deal regardless of project, so a project here would only mean seeding one to satisfy the R19
    // ownership check without changing anything the test asserts.
    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, { dealId: WORKBENCH_DEAL, projectId: null }),
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

    // Deal-level, for the same reason as the positive test above.
    const result = await ingestWalkthrough({
      tenantDb,
      payload: walkthroughPayload(walkthroughId, {
        dealId: WORKBENCH_NEGATIVE_DEAL,
        projectId: null,
      }),
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
