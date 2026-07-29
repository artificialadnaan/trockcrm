// Walkthrough ingress: turning a TROCK Scope job-site walkthrough into estimating rows.
//
// `estimate_extractions.document_id` is NOT NULL with an FK to `estimate_source_documents`, which in
// turn requires a `files` row — so a walkthrough has to synthesize a document chain before its scope
// rows can land. The synthetic "document" is a contact-sheet image of the walkthrough's evidence
// frames: a real artifact a human can open, and `image/*` is one of only two mime families the
// estimating path accepts. This module builds that chain link by link: the `files` row, then the
// already-parsed source document and its activated parse run.
import { and, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  estimateDocumentParseRuns,
  estimateExtractions,
  estimateSourceDocuments,
  files,
} from "@trock-crm/shared/schema";
import type {
  WalkthroughIngressPayload,
  WalkthroughIngressResult,
  WalkthroughScopeRow,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { resolvePricingScopeFromExtraction } from "./pricing-service.js";

/** Same alias document-service.ts:6 uses. */
type TenantDb = NodePgDatabase<typeof schema>;

/**
 * The ONE bucket every CRM download is presigned against.
 *
 * `buildFileDownloadUrlFromRecord` (files/service.ts:1513) hands `generateDownloadUrl` the KEY only,
 * and `generateDownloadUrl` (r2-client.ts:168-186) signs it against `getBucket()` — i.e. this value —
 * ignoring `files.r2_bucket` entirely. A row stamped with any other bucket therefore yields a URL
 * pointing at an object that does not exist in the bucket it names.
 *
 * Resolved the same way the four other modules that stamp `files.r2_bucket` resolve it
 * (files/service.ts:794, companycam/service.ts:386, field/photo-reports-service.ts:307,
 * field/scorecards-service.ts:1384), and read here rather than imported from r2-client so this
 * pure-database module does not pull the S3 client onto its import path.
 */
export function getCrmFileBucket(): string {
  return process.env.R2_BUCKET_NAME || "trock-crm-files";
}

/** The only two mime families the estimating path accepts. */
export const WALKTHROUGH_CONTACT_SHEET_MIME_TYPES = ["image/jpeg", "application/pdf"] as const;

/**
 * A ceiling on one walkthrough's scope rows. Not a storage limit — a runaway-export limit: a real
 * walkthrough is a human talking through a building, and an export claiming thousands of spoken scope
 * items is a bug upstream, not a big job. Rows are also inserted in chunks (see
 * EXTRACTION_INSERT_CHUNK_ROWS), so this cap is not what keeps the INSERT inside Postgres's bind
 * limit — it is what keeps a nonsense payload from being ingested at all.
 */
export const MAX_WALKTHROUGH_SCOPE_ROWS = 1000;

/**
 * Rows per INSERT. Each row binds 15 parameters and Postgres's protocol caps a single statement at
 * 65535 of them, so an unchunked insert would break somewhere north of ~4300 rows with a protocol
 * error rather than anything actionable. 200 rows = 3000 parameters, comfortably clear, and few
 * enough statements that the transaction stays cheap.
 */
const EXTRACTION_INSERT_CHUNK_ROWS = 200;

/** Narrow, storage-shaped input for ONE link of the chain; `WalkthroughIngressPayload`'s wire names
 *  (contactSheetR2Key/…) are mapped onto it in `ingestWalkthrough`. */
export interface CreateWalkthroughContactSheetFileArgs {
  tenantDb: TenantDb;
  input: {
    dealId: string;
    walkthroughId: string;
    siteLabel: string;
    r2Key: string;
    r2Bucket: string;
    bytes: number;
    mimeType: "image/jpeg" | "application/pdf";
    /** When the walkthrough was captured — stored structurally on `files.taken_at`. */
    capturedAt: string;
    userId: string;
  };
}

/** Keyed off the args' own mime union, so adding a third accepted mime type is a compile error here
 *  rather than an `undefined` extension at runtime. */
type ContactSheetMimeType = CreateWalkthroughContactSheetFileArgs["input"]["mimeType"];

/** WITH the leading dot, matching `confirmUpload` (files/service.ts:790-792, which slices from the
 *  dot inclusive) — because `buildFileDownloadUrlFromRecord` builds its download filename as
 *  `displayName + (fileExtension ?? "")` (files/service.ts:1518). A bare "jpg" would render
 *  "Walkthrough evidence — Unit 12Bjpg". */
const EXTENSION_BY_MIME: Record<ContactSheetMimeType, string> = {
  "image/jpeg": ".jpg",
  "application/pdf": ".pdf",
};

export async function createWalkthroughContactSheetFile({
  tenantDb,
  input,
}: CreateWalkthroughContactSheetFileArgs): Promise<string> {
  const extension = EXTENSION_BY_MIME[input.mimeType];
  // The extension already carries its dot, so this concatenates rather than re-inserting one.
  const systemFilename = `walkthrough-${input.walkthroughId}${extension}`;

  const [row] = await tenantDb
    .insert(files)
    .values({
      dealId: input.dealId,
      // FILE_CATEGORIES has no "estimating" member; "estimate" is the estimating-path category and
      // adding an enum value would require a migration. See shared/src/types/enums.ts.
      category: "estimate",
      displayName: `Walkthrough evidence — ${input.siteLabel}`,
      systemFilename,
      originalFilename: systemFilename,
      mimeType: input.mimeType,
      fileSizeBytes: input.bytes,
      fileExtension: extension,
      r2Key: input.r2Key,
      r2Bucket: input.r2Bucket,
      // WHEN the evidence was captured, as a timestamp rather than as characters inside a filename.
      // Everything that orders files chronologically does it on COALESCE(taken_at, created_at)
      // (files/service.ts:2031) — leave this null and a walkthrough shot on Tuesday sorts as though it
      // happened at the moment the export finally posted.
      takenAt: new Date(input.capturedAt),
      uploadedBy: input.userId,
      isActive: true,
    })
    .returning({ id: files.id });

  return row.id;
}

/** Second link of the chain. Narrow input as above; the `WalkthroughIngressPayload` mapping lives in
 *  `ingestWalkthrough`. */
export interface CreateWalkthroughSourceDocumentArgs {
  tenantDb: TenantDb;
  input: {
    dealId: string;
    projectId: string | null;
    fileId: string;
    walkthroughId: string;
    siteLabel: string;
    capturedAt: string;
    mimeType: ContactSheetMimeType;
    storageKey: string;
    bytes: number;
    userId: string;
  };
}

/**
 * Create the source document a walkthrough's extractions hang off — already parsed.
 *
 * `createEstimateSourceDocument` (document-service.ts:99) cannot be reused: it hardcodes
 * `parseStatus: "queued"` / `activeParseRunId: null` and enqueues an OCR job that would re-derive
 * filename stubs over an image whose real content is a transcript we already have. A walkthrough
 * arrives with its parse ALREADY DONE upstream in trock-scope, so the document is born `completed`
 * with a completed parse run made active — which is the state workbench-service.ts:153-172 requires
 * before it will show any of the walkthrough's rows.
 */
export async function createWalkthroughSourceDocument({
  tenantDb,
  input,
}: CreateWalkthroughSourceDocumentArgs): Promise<{ documentId: string; parseRunId: string }> {
  const [document] = await tenantDb
    .insert(estimateSourceDocuments)
    .values({
      dealId: input.dealId,
      projectId: input.projectId,
      fileId: input.fileId,
      rootFileId: input.fileId,
      documentType: "walkthrough",
      filename: `Walkthrough ${input.siteLabel} ${input.capturedAt}`,
      storageKey: input.storageKey,
      mimeType: input.mimeType,
      fileSize: input.bytes,
      // Deliberate: the walkthrough id IS the content hash, so a re-ingest of the same walkthrough is
      // recognizable on the same (dealId, projectId, contentHash) triple document-service.ts:104-130
      // dedupes against. `ingestWalkthrough` reads exactly that triple before it writes anything, and
      // replays the existing chain instead of building a second one. This helper itself performs no
      // dedupe check and the column carries no unique constraint, so calling IT twice directly still
      // writes two documents — the guard lives one level up.
      contentHash: input.walkthroughId,
      parseStatus: "completed",
      ocrStatus: "completed",
      parseProvider: "trock-scope",
      parseProfile: "walkthrough",
      parseMeasurementsEnabled: false,
      parsedAt: new Date(),
      uploadedByUserId: input.userId,
    })
    .returning({ id: estimateSourceDocuments.id });

  const [parseRun] = await tenantDb
    .insert(estimateDocumentParseRuns)
    .values({
      documentId: document.id,
      status: "completed",
      parseProvider: "trock-scope",
      parseProfile: "walkthrough",
      parseMeasurementsEnabled: false,
      completedAt: new Date(),
    })
    .returning({ id: estimateDocumentParseRuns.id });

  // The run can only be pointed at after it exists (the FK runs document -> run), so activation is a
  // second statement rather than part of the insert above.
  await tenantDb
    .update(estimateSourceDocuments)
    .set({ activeParseRunId: parseRun.id })
    .where(eq(estimateSourceDocuments.id, document.id));

  return { documentId: document.id, parseRunId: parseRun.id };
}

/** Third link of the chain. Narrow input as above; the `WalkthroughIngressPayload` mapping lives in
 *  `ingestWalkthrough`. */
export interface InsertWalkthroughExtractionsArgs {
  tenantDb: TenantDb;
  input: {
    dealId: string;
    projectId: string | null;
    documentId: string;
    parseRunId: string;
    walkthroughId: string;
    rows: WalkthroughScopeRow[];
  };
}

/**
 * Write a walkthrough's scope rows as `estimate_extractions`.
 *
 * A row is only USEFUL if it clears four independent gates, none of which the schema enforces — miss
 * any one and the row lands in the table but is invisible to everything downstream:
 *   1. `status = 'pending'` — estimate-generation.ts:256-261 filters candidates on it.
 *   2. `metadataJson.activeArtifact` — written as the JSON BOOLEAN `true`, the encoding every other
 *      writer of this key uses (document-parse-orchestrator.ts:166-179, :298, :331). Both consumers
 *      accept it: `->>` renders JSON `true` as the text `'true'` for estimate-generation.ts:262, and
 *      workbench-service.ts:171 asks only that it not be `false`.
 *   3. `metadataJson.sourceParseRunId` equal to the document's `activeParseRunId` —
 *      workbench-service.ts:153-172 hides the row otherwise.
 *   4. a resolved pricing scope, via the SAME resolver extraction-service.ts uses, so walkthrough rows
 *      price on an identical basis to parsed-document ones.
 *
 * NOTE on `quantity`: this helper still writes SQL NULL for a row that names no quantity, because
 * "no quantity was spoken" must not collapse into "zero of it". Nothing reaches here through the
 * ingress with a null quantity — `validateWalkthroughIngressPayload` refuses those at the door — but
 * the helper is exported and the encoding is the one worth keeping if it is ever called directly.
 */
export async function insertWalkthroughExtractions({
  tenantDb,
  input,
}: InsertWalkthroughExtractionsArgs): Promise<string[]> {
  if (input.rows.length === 0) return [];

  const buildValues = (row: WalkthroughScopeRow) => ({
    dealId: input.dealId,
    projectId: input.projectId,
    documentId: input.documentId,
    // A contact sheet is not paginated the way a plan set is; there is no page to point at.
    pageId: null,
    extractionType: "scope_utterance",
    rawLabel: row.rawLabel,
    normalizedLabel: row.rawLabel.toLowerCase(),
    // numeric columns take strings — the same convention extraction-service.ts writes with. `null`
    // stays null: "no quantity was spoken" must not collapse into "zero of it".
    quantity: row.quantity === null ? null : String(row.quantity),
    unit: row.unit,
    divisionHint: row.divisionHint,
    confidence: row.confidence.toFixed(2),
    evidenceText: row.evidenceText,
    // Temporal evidence occupies the bbox column wholesale: a spoken utterance has a clip and a
    // timeline offset, not a rectangle on a page.
    evidenceBboxJson: {
      clipId: row.evidence.clipId,
      timelineMs: row.evidence.timelineMs,
      frameKey: row.evidence.frameKey,
    },
    status: "pending",
    metadataJson: {
      activeArtifact: true,
      sourceParseRunId: input.parseRunId,
      sourceWalkthroughId: input.walkthroughId,
      sourceScopeItemId: row.sourceScopeItemId,
      locationLabel: row.locationLabel,
      // Kept for provenance: the trade the walkthrough classified this row as, independent of
      // whatever the resolver below turns it into.
      trade: row.trade,
      extractionProvider: "trock-scope",
      extractionMethod: "walkthrough_grounding",
      // The walkthrough already KNOWS the trade, so it is handed over as `tradeHint` rather than
      // left to be re-guessed. Without it the resolver falls through to text inference
      // (pricing-service.ts:222), which scans rawLabel against a 19-member hardcoded set — and a
      // roofing row reading "Replace rotted carpentry at eave" would price as carpentry.
      // Precedence note: the tradeHint branch (pricing-service.ts:212-220) returns BEFORE the
      // divisionHint branch (:231-236), so the authoritative trade wins over divisionHint.
      ...resolvePricingScopeFromExtraction({
        divisionHint: row.divisionHint,
        metadataJson: { tradeHint: row.trade },
        normalizedIntent: row.rawLabel,
        rawLabel: row.rawLabel,
      }),
    },
  });

  // Chunked, not one statement: 15 bound parameters per row against Postgres's 65535-parameter cap
  // means a single INSERT stops working somewhere past ~4300 rows, and it stops working as a protocol
  // error rather than as anything a caller can act on. All chunks run inside the caller's transaction,
  // so a failure in chunk two still takes chunk one back out with it.
  const ids: string[] = [];
  for (let offset = 0; offset < input.rows.length; offset += EXTRACTION_INSERT_CHUNK_ROWS) {
    const chunk = input.rows.slice(offset, offset + EXTRACTION_INSERT_CHUNK_ROWS);
    const inserted = await tenantDb
      .insert(estimateExtractions)
      .values(chunk.map(buildValues))
      .returning({ id: estimateExtractions.id });
    ids.push(...inserted.map((r) => r.id));
  }

  return ids;
}

// ── Payload validation ─────────────────────────────────────────────────────────────────────────────
//
// `WalkthroughIngressPayload` is a COMPILE-time contract and the sender is another service across the
// network: at runtime the body is whatever was posted. Everything below runs before the first write,
// so a malformed export is a 400 naming the offending field instead of a 500 from inside a
// transaction (or, worse, a row that inserts and prices wrong).

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new AppError(400, `${field} must be a string`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  const str = requireString(value, field);
  if (str.trim() === "") {
    throw new AppError(400, `${field} must be a non-empty string`);
  }
  return str;
}

/** Absent and explicitly null are the same thing on the wire; anything else must be a string. */
function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, field);
}

/** As above, but for a value that reaches a uuid column, where "" is a 22P02 rather than a blank. */
function optionalNonEmptyString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requireNonEmptyString(value, field);
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError(400, `${field} must be a finite number`);
  }
  return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError(400, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateScopeRow(value: unknown, index: number): WalkthroughScopeRow {
  const row = requireObject(value, `rows[${index}]`);
  // Named by its scope item from here on: an index alone tells the sender nothing it can look up.
  const scopeItemId = requireNonEmptyString(row.sourceScopeItemId, `rows[${index}].sourceScopeItemId`);
  const at = `rows[${index}] (sourceScopeItemId "${scopeItemId}")`;

  // THE RULE THE WHOLE EXPORT IS BUILT ON. A quantity exists only if a human said it out loud and
  // confirmed it, so trock-scope withholds rows that have none — but a receiver that TRUSTS that is
  // one lost deploy away from pricing a guess. Downstream, `Number(extraction.quantity ?? 1)` (three
  // sites in worker/src/jobs/estimate-generation.ts) turns a null into ONE UNIT and prices it, so a
  // row that reached storage with no quantity does not surface as unpriceable — it surfaces as a
  // confident line item on an estimate a human signs. Refused here instead.
  if (row.quantity === null || row.quantity === undefined) {
    throw new AppError(
      400,
      `${at} has no spoken quantity. A walkthrough quantity exists only when it was spoken and ` +
        `confirmed, and a row without one is priced as a single unit downstream ` +
        `(Number(extraction.quantity ?? 1) in worker/src/jobs/estimate-generation.ts) — so it is ` +
        `refused here rather than exported as a confident wrong number.`
    );
  }
  const quantity = requireFiniteNumber(row.quantity, `${at}.quantity`);
  if (quantity <= 0) {
    throw new AppError(400, `${at}.quantity must be greater than zero`);
  }

  const confidence = requireFiniteNumber(row.confidence, `${at}.confidence`);
  // Passed to `.toFixed(2)` against a numeric(5,2) column: outside 0-1 it is either a 22003 overflow
  // at INSERT or a silently meaningless score.
  if (confidence < 0 || confidence > 1) {
    throw new AppError(400, `${at}.confidence must be a number between 0 and 1`);
  }

  const evidence = requireObject(row.evidence, `${at}.evidence`);
  const timelineMs = requireFiniteNumber(evidence.timelineMs, `${at}.evidence.timelineMs`);
  if (timelineMs < 0) {
    throw new AppError(400, `${at}.evidence.timelineMs must not be negative`);
  }

  return {
    sourceScopeItemId: scopeItemId,
    rawLabel: requireNonEmptyString(row.rawLabel, `${at}.rawLabel`),
    trade: requireNonEmptyString(row.trade, `${at}.trade`),
    divisionHint: optionalString(row.divisionHint, `${at}.divisionHint`),
    quantity,
    unit: optionalString(row.unit, `${at}.unit`),
    confidence,
    evidenceText: requireString(row.evidenceText, `${at}.evidenceText`),
    evidence: {
      clipId: requireNonEmptyString(evidence.clipId, `${at}.evidence.clipId`),
      timelineMs,
      frameKey: optionalString(evidence.frameKey, `${at}.evidence.frameKey`),
    },
    locationLabel: optionalString(row.locationLabel, `${at}.locationLabel`),
  };
}

/**
 * Runtime-validate a posted walkthrough and return it in canonical shape.
 *
 * Called from BOTH the route (so an invalid body never costs a deal lookup) and `ingestWalkthrough`
 * (so nothing reaches a write by calling the service directly). Throws `AppError(400, …)`, which the
 * error handler renders as a 400 naming the field.
 */
export function validateWalkthroughIngressPayload(input: unknown): WalkthroughIngressPayload {
  const raw = requireObject(input, "walkthrough ingress payload");

  const rowsValue = raw.rows;
  if (!Array.isArray(rowsValue)) {
    throw new AppError(400, "rows must be a non-empty array of walkthrough scope rows");
  }
  if (rowsValue.length === 0) {
    throw new AppError(400, "Walkthrough ingress requires at least one scope row");
  }
  if (rowsValue.length > MAX_WALKTHROUGH_SCOPE_ROWS) {
    throw new AppError(
      400,
      `rows must contain at most ${MAX_WALKTHROUGH_SCOPE_ROWS} scope rows (received ${rowsValue.length})`
    );
  }

  const contactSheetMimeType = requireNonEmptyString(
    raw.contactSheetMimeType,
    "contactSheetMimeType"
  );
  if (
    !(WALKTHROUGH_CONTACT_SHEET_MIME_TYPES as readonly string[]).includes(contactSheetMimeType)
  ) {
    throw new AppError(
      400,
      `contactSheetMimeType must be one of ${WALKTHROUGH_CONTACT_SHEET_MIME_TYPES.join(", ")}`
    );
  }

  const contactSheetBytes = requireFiniteNumber(raw.contactSheetBytes, "contactSheetBytes");
  if (!Number.isInteger(contactSheetBytes) || contactSheetBytes <= 0) {
    throw new AppError(400, "contactSheetBytes must be a positive integer");
  }

  // BUCKET, not just key. `buildFileDownloadUrlFromRecord` presigns against the CRM's configured
  // bucket and ignores `files.r2_bucket` (see getCrmFileBucket above), so recording a foreign bucket
  // produces a download link to an object that is not there — an estimator clicking the evidence gets
  // a 404 with nothing to explain it. A cross-bucket copy is out of scope for this seam (it performs
  // no object I/O at all), so the contact sheet has to be uploaded into the CRM's bucket before it is
  // announced, and a payload that says otherwise is refused loudly here.
  const contactSheetBucket = requireNonEmptyString(raw.contactSheetBucket, "contactSheetBucket");
  const crmBucket = getCrmFileBucket();
  if (contactSheetBucket !== crmBucket) {
    throw new AppError(
      400,
      `contactSheetBucket "${contactSheetBucket}" is not this CRM's file bucket ("${crmBucket}"). ` +
        `Downloads are presigned against the configured bucket only, so a contact sheet stored ` +
        `anywhere else would be unopenable. Upload it to "${crmBucket}" and re-post.`
    );
  }

  const capturedAt = requireNonEmptyString(raw.capturedAt, "capturedAt");
  if (Number.isNaN(new Date(capturedAt).getTime())) {
    throw new AppError(400, "capturedAt must be a parseable timestamp");
  }

  return {
    walkthroughId: requireNonEmptyString(raw.walkthroughId, "walkthroughId"),
    dealId: requireNonEmptyString(raw.dealId, "dealId"),
    // Optional, but never blank: it lands on a uuid column, where "" is a 22P02 and not a null.
    projectId: optionalNonEmptyString(raw.projectId, "projectId"),
    contactSheetR2Key: requireNonEmptyString(raw.contactSheetR2Key, "contactSheetR2Key"),
    contactSheetBucket,
    contactSheetBytes,
    contactSheetMimeType: contactSheetMimeType as ContactSheetMimeType,
    siteLabel: requireNonEmptyString(raw.siteLabel, "siteLabel"),
    capturedAt,
    userId: requireNonEmptyString(raw.userId, "userId"),
    rows: rowsValue.map(validateScopeRow),
  };
}

/**
 * Compose the three links into one ingress, atomically.
 *
 * This is the only place `WalkthroughIngressPayload` — the wire contract trock-scope posts — meets the
 * helpers' narrow, storage-shaped inputs. The rename is the point: `contactSheetR2Key`/`Bucket`/
 * `Bytes`/`MimeType` become `r2Key`/`r2Bucket`/`bytes`/`mimeType`, so the helpers stay ignorant of
 * where their bytes came from and the mapping is checked by the compiler rather than by convention.
 *
 * WHY A TRANSACTION (this module had none, and the rest of the module still has none): the chain is
 * three writes deep and its middle link is itself two statements — INSERT the run, then UPDATE the
 * document to point at it. Interrupt it anywhere and the deal is left with a `completed` document
 * whose `activeParseRunId` is null, which workbench-service.ts:157 reads as "hide every row of this
 * document, forever". Nothing sweeps that up; the document just sits in the documents list with
 * nothing under it. Atomic is the only state worth having: the whole walkthrough, or none of it.
 *
 * WHY NO `estimate_generation` ENQUEUE (deliberate, not an omission — reviewers have asked):
 * ingesting a walkthrough leaves its rows PENDING for an estimator, and nothing auto-prices them.
 * Two known defects make auto-pricing these rows produce confident wrong numbers rather than a
 * visible failure, and both are pinned by walkthrough-ingress-characterization.runtime.test.ts:
 *   1. `Number(extraction.quantity ?? 1)` at three sites in worker/src/jobs/estimate-generation.ts
 *      prices a quantity-less row as ONE unit. The ingress now refuses null quantities outright, but
 *      the coercion is still live for every other producer, so the hazard is unrepaired.
 *   2. Spoken scope is PROSE. matching-service.ts:69 awards its 50 name points only for whole-string
 *      equality against a catalog item name, so a walkthrough row scores ~30 where an exactly-named
 *      row scores 80 — and at 30 the winner is decided by wherever the catalog happened to order the
 *      ties that `matches[0]` picks from.
 * WHAT MUST BE TRUE BEFORE THIS CHANGES: the matcher handles natural language (fuzzy/token/embedding
 * scoring, so prose competes on merit instead of by catalog ordering), AND the worker either skips or
 * flags quantity-less rows instead of coercing them. Until then an estimator triggers generation
 * knowingly, from the workbench, having seen the rows.
 */
export async function ingestWalkthrough({
  tenantDb,
  payload: rawPayload,
}: {
  tenantDb: TenantDb;
  payload: WalkthroughIngressPayload;
}): Promise<WalkthroughIngressResult> {
  // Validated BEFORE the transaction opens, not inside it. `WalkthroughIngressPayload` is a
  // compile-time promise made by a caller across a network — the receiver checks it anyway. A
  // walkthrough with no scope rows, an unparseable capturedAt, or a row with no spoken quantity would
  // otherwise buy a contact-sheet file and a parse run to hold nothing, or land a row that prices wrong.
  const payload = validateWalkthroughIngressPayload(rawPayload);

  return tenantDb.transaction(async (tx) => {
    // IDEMPOTENCY. A lost response is indistinguishable from a lost request, so trock-scope retries —
    // and a retry must not double the deal's estimating rows. `contentHash` carries the walkthrough
    // id, so (dealId, projectId, contentHash) identifies THIS walkthrough on THIS deal: the same
    // triple document-service.ts:104-130 dedupes parsed uploads against. Found means the first call
    // already committed the whole chain, so the retry replays its ids and writes nothing. (Without
    // this: a retry reusing the contact-sheet key dies on `files.r2_key`'s unique index with a 23505,
    // and a retry that regenerated the key succeeds into a second document and a second set of rows.)
    const [existing] = await tx
      .select({
        id: estimateSourceDocuments.id,
        fileId: estimateSourceDocuments.fileId,
        activeParseRunId: estimateSourceDocuments.activeParseRunId,
      })
      .from(estimateSourceDocuments)
      .where(
        and(
          eq(estimateSourceDocuments.dealId, payload.dealId),
          payload.projectId === null
            ? isNull(estimateSourceDocuments.projectId)
            : eq(estimateSourceDocuments.projectId, payload.projectId),
          eq(estimateSourceDocuments.contentHash, payload.walkthroughId)
        )
      )
      .limit(1);

    if (existing) {
      if (!existing.activeParseRunId) {
        // Only reachable if a prior ingress was interrupted between the run INSERT and the activation
        // UPDATE — which the transaction is there to prevent. Loud rather than replayed, because
        // returning a null parse run would hand back a document whose rows the workbench will never
        // show (workbench-service.ts:157).
        throw new AppError(
          500,
          `Walkthrough ${payload.walkthroughId} already has a source document (${existing.id}) with ` +
            `no active parse run; its extractions cannot be displayed. Investigate before re-ingesting.`
        );
      }

      const existingRows = await tx
        .select({ id: estimateExtractions.id, metadataJson: estimateExtractions.metadataJson })
        .from(estimateExtractions)
        .where(eq(estimateExtractions.documentId, existing.id));

      // Returned in the payload's own row order rather than in whatever order the SELECT came back in:
      // the ids a retry gets back line up with the rows it sent, exactly as on the first call.
      const idByScopeItemId = new Map<string, string>();
      for (const row of existingRows) {
        const scopeItemId = (row.metadataJson as { sourceScopeItemId?: unknown } | null)
          ?.sourceScopeItemId;
        if (typeof scopeItemId === "string") idByScopeItemId.set(scopeItemId, row.id);
      }
      const orderedIds = payload.rows
        .map((row) => idByScopeItemId.get(row.sourceScopeItemId))
        .filter((id): id is string => id !== undefined);
      const claimed = new Set(orderedIds);
      // Anything the stored document has that this payload did not name (a retry whose rows drifted)
      // still belongs to the walkthrough, so the result stays a complete picture of what exists.
      const unmatchedIds = existingRows.map((row) => row.id).filter((id) => !claimed.has(id)).sort();

      return {
        documentId: existing.id,
        parseRunId: existing.activeParseRunId,
        fileId: existing.fileId,
        extractionIds: [...orderedIds, ...unmatchedIds],
      };
    }

    const fileId = await createWalkthroughContactSheetFile({
      tenantDb: tx,
      input: {
        dealId: payload.dealId,
        walkthroughId: payload.walkthroughId,
        siteLabel: payload.siteLabel,
        r2Key: payload.contactSheetR2Key,
        // Equal to getCrmFileBucket() by validation above — the file is recorded against the bucket
        // its download will actually be presigned against.
        r2Bucket: payload.contactSheetBucket,
        bytes: payload.contactSheetBytes,
        mimeType: payload.contactSheetMimeType,
        capturedAt: payload.capturedAt,
        userId: payload.userId,
      },
    });

    const { documentId, parseRunId } = await createWalkthroughSourceDocument({
      tenantDb: tx,
      input: {
        dealId: payload.dealId,
        projectId: payload.projectId,
        fileId,
        walkthroughId: payload.walkthroughId,
        siteLabel: payload.siteLabel,
        capturedAt: payload.capturedAt,
        mimeType: payload.contactSheetMimeType,
        // The contact sheet's R2 key is the document's storage key: the document IS the file.
        storageKey: payload.contactSheetR2Key,
        bytes: payload.contactSheetBytes,
        userId: payload.userId,
      },
    });

    const extractionIds = await insertWalkthroughExtractions({
      tenantDb: tx,
      input: {
        dealId: payload.dealId,
        projectId: payload.projectId,
        documentId,
        parseRunId,
        walkthroughId: payload.walkthroughId,
        rows: payload.rows,
      },
    });

    return { documentId, parseRunId, fileId, extractionIds };
  });
}
