// Walkthrough ingress: turning a TROCK Scope job-site walkthrough into estimating rows.
//
// `estimate_extractions.document_id` is NOT NULL with an FK to `estimate_source_documents`, which in
// turn requires a `files` row — so a walkthrough has to synthesize a document chain before its scope
// rows can land. The synthetic "document" is a contact-sheet image of the walkthrough's evidence
// frames: a real artifact a human can open, and `image/*` is one of only two mime families the
// estimating path accepts. This module builds that chain link by link: the `files` row, then the
// already-parsed source document and its activated parse run.
import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
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
import {
  canonicalizeTradeScopeKey,
  isKnownTradeScopeKey,
  resolvePricingScopeFromExtraction,
} from "./pricing-service.js";

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
 * The advisory-lock key one walkthrough ingress serializes on.
 *
 * NAMESPACED, matching `lockPromotionCandidates` (draft-estimate-service.ts:136) — the single-argument
 * `pg_advisory_xact_lock(bigint)` key space is GLOBAL to the database, shared with every other feature
 * that takes one, so an un-prefixed "<uuid>:<uuid>" would be a key another module could in principle
 * mint too. (The `pg_advisory_lock(int4, int4)` two-argument form bid-board-sync uses is a SEPARATE
 * space and cannot collide with this one.)
 *
 * Deliberately COARSER than the idempotency lookup, which keys on (dealId, projectId, contentHash):
 * `projectId` is left out. That is the safe direction — every pair of transactions that could collide
 * on the lookup necessarily collides on this lock, so the lock can never under-serialize. The cost is
 * that the same walkthrough arriving on one deal under two different projects serializes when it did
 * not strictly have to, which is a wait, not a wrong answer.
 *
 * Exported so callers and tests agree on one spelling of the key. NOTE for anyone adding a test here:
 * asserting a recorded lock parameter EQUALS this function's output is a tautology — mutating the body
 * moves both sides together and the assertion cannot fail. The runtime suite therefore asserts the
 * key's CONTENT (that it contains the deal id, the walkthrough id and this namespace) and treats the
 * equality check as documentation only.
 */
export function walkthroughIngressLockKey(dealId: string, walkthroughId: string): string {
  return `walkthrough-ingress:${dealId}:${walkthroughId}`;
}

/**
 * The quantity band `estimate_extractions.quantity` can actually represent.
 *
 * The column is `numeric(14,3)` (estimate-extractions.ts:37) — 14 digits of precision, scale 3, so 11
 * integer digits and exactly three decimal places. Both ends of that band are enforced in validation
 * rather than discovered at INSERT, and each end fails a DIFFERENT way if it is not:
 *
 *   MAX — Postgres refuses a value that rounds to an absolute value >= 10^11 with a `numeric field
 *   overflow` (22003). That is a 500 out of the middle of the transaction, contradicting the
 *   400-before-any-write contract the rest of this validator establishes. Verified against real
 *   Postgres 16.14: 1e11 and 99999999999.9996 both raise 22003; 99999999999.999 and
 *   99999999999.9994 (which rounds DOWN) are accepted. The bound below is therefore very slightly
 *   conservative — it also refuses the sliver between 99999999999.999 and the true rounding
 *   threshold — which is the harmless direction, and no walkthrough reaches eleven digits anyway.
 *
 *   MIN — and this is the dangerous one, because it SUCCEEDS. Scale 3 makes Postgres ROUND, not
 *   reject: verified on the same server, 0.0001 and 0.0004 both store as exactly 0.000. So a payload
 *   this module explicitly refuses at `quantity <= 0` can walk straight back in as 0.0001 and land in
 *   the table as a zero — the very value the guard above exists to keep out, arrived at silently.
 *   (0.0005 rounds UP to 0.001 and would survive; the bound is set at the column's smallest
 *   representable value, 0.001, rather than at the exact collapse threshold, because "the column
 *   stores three decimals" is a rule a sender can act on and "below 0.0005 you become zero" is not.)
 */
export const MAX_WALKTHROUGH_QUANTITY = 99999999999.999;
export const MIN_WALKTHROUGH_QUANTITY = 0.001;

/**
 * The longest `rawLabel` that can survive all the way to a promoted estimate.
 *
 * `estimate_extractions.raw_label` is unbounded `text`, so ingress alone would accept any length — but
 * promotion copies it into `estimate_line_items.description`, which is `varchar(500) NOT NULL`
 * (estimate-line-items.ts:21, verified rather than assumed). The path is
 * `promoteEstimatePricingRecommendations` → the select at draft-estimate-service.ts:91
 * (`description: estimateExtractions.rawLabel`) → the insert at :345.
 *
 * So an over-long label is accepted at ingress, survives generation and matching, gets APPROVED by an
 * estimator, and only then fails promotion with a 22001 — at the single worst moment, after a human has
 * signed off on the row. Bounded here instead.
 *
 * REFUSED rather than truncated: silently shortening a scope description is its own hazard (the part
 * that gets cut is exactly the qualifying detail — "…except the north elevation" — and the estimator
 * would never know it was dropped). A sender that produced a 600-character utterance label has a
 * segmentation problem worth hearing about.
 */
export const MAX_WALKTHROUGH_RAW_LABEL_CHARS = 500;

/**
 * A fingerprint of one scope row's SEMANTIC content, stored on the extraction and re-checked on replay.
 *
 * WHY. Idempotency matches a retry's rows to stored extractions on `sourceScopeItemId`. That is the
 * right key, but on its own it only proves a row with that id EXISTS — not that it says the same thing.
 * A retry that keeps the id and corrects the quantity from 12.5 to 125 was therefore treated as a
 * successful replay: the caller got a 200 and the ORIGINAL row was kept, so the estimator went on
 * pricing 12.5 while trock-scope believed the correction had landed. Drift that introduces a NEW id
 * already 409s; this is the same disagreement, one level down, and it was silent.
 *
 * WHY A 409 AND NOT AN UPDATE. A genuine retry is byte-identical — that is what makes it a retry.
 * Changed content is a different submission wearing a retry's clothes, and applying it would let a
 * replay silently mutate rows an estimator may already have reviewed, matched and approved.
 * Propagating post-export corrections is a real requirement, but it needs the export ledger to say
 * which version is authoritative and what happens to downstream pricing; it does not belong in a
 * retry path. Refused loudly here, so the correction is a conversation instead of a surprise.
 *
 * WHAT IS IN IT. Everything a human would call "what this row says": the id, the label, the quantity
 * and unit, the division hint, the trade, the location, and the evidence triple. Deliberately NOT
 * `confidence` — a re-scored confidence on identical content is the model changing its mind about the
 * same utterance, not the utterance changing, and failing a retry over it would be noise.
 *
 * Canonical by construction: a fixed field ORDER (not object key order) and `JSON.stringify` on
 * primitives only, so the same row always produces the same string. `trade` is already canonicalized
 * by the validator, which means a casing-only change is correctly NOT drift.
 */
export function fingerprintWalkthroughScopeRow(row: WalkthroughScopeRow): string {
  const canonical = JSON.stringify([
    row.sourceScopeItemId,
    row.rawLabel,
    row.quantity,
    row.unit,
    row.divisionHint,
    row.trade,
    row.locationLabel,
    row.evidence.clipId,
    row.evidence.timelineMs,
    row.evidence.frameKey,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

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
 *  (contactSheetBucket/…) are mapped onto it in `ingestWalkthrough`, and its `r2Key` is DERIVED there
 *  rather than carried on the wire — see `deriveWalkthroughContactSheetR2Key`. */
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

/**
 * The contact sheet's R2 key, DERIVED — never accepted from the caller.
 *
 * SECURITY, and the reason this function exists at all. `files.r2_key` is what
 * `buildFileDownloadUrlFromRecord` (files/service.ts:1513) hands to `generateDownloadUrl` for
 * presigning, and the only authorization in front of it is the row's DEAL association — the key itself
 * is never checked against anything. So a wire field that lands in `files.r2_key` is a confused-deputy
 * READ primitive: an authenticated caller who knows any key in the bucket (another deal's contract, a
 * scorecard, a photo report) could post it as their walkthrough's contact sheet, have it associated
 * with a deal they legitimately access, and then download it through the ordinary files endpoint.
 *
 * No amount of validation closes that hole, because a hostile key is a perfectly well-formed key.
 * Deriving it does: `walkthroughId` is the same value that becomes the document's `contentHash`, so
 * the key is bound to walkthrough identity and there is no input from which a caller could name
 * another deal's object. The path is the CONTRACT with trock-scope — the exporter uploads the contact
 * sheet to exactly this key before it posts — so both sides compute it rather than exchange it.
 */
export function deriveWalkthroughContactSheetR2Key(
  dealId: string,
  projectId: string | null,
  walkthroughId: string,
  mimeType: ContactSheetMimeType
): string {
  // `dealId` is in the path because `files.r2_key` is UNIQUE and one walkthrough may legitimately be
  // ingested onto more than one deal (a re-bid, or scope split across two deals). Keying on
  // walkthroughId alone would make the second deal collide with a 23505. It costs nothing
  // security-wise: dealId comes from the authorized URL, never the body, so it still cannot be used
  // to name another deal's object.
  //
  // `projectId` is here for exactly the same reason, one level down, and its absence was a BUG: the
  // idempotency lookup keys on (dealId, projectId, contentHash, documentType), so the same walkthrough
  // ingested onto two different projects WITHIN one deal is deliberately two documents — but with the
  // project missing from the path both wanted the same r2_key, so the second one passed the lookup and
  // then died on the unique index with a 23505. The derived key has to agree with the lookup key or
  // "these are two legitimate documents" and "these are one object" contradict each other.
  //
  // The null case gets an explicit sentinel rather than an empty segment, so a deal-level walkthrough
  // ("no project") and a project-level one can never collapse onto the same path. `_none` is safe as a
  // sentinel because `projectId` is validated as a UUID (see requireUuid in the validator) and `_none`
  // is not a syntactically valid UUID — no real project id can ever spell it.
  //
  // EXTENSION_BY_MIME carries its own leading dot, so this yields ".../contact-sheet.jpg".
  return `walkthroughs/${dealId}/${projectId ?? WALKTHROUGH_NO_PROJECT_KEY_SEGMENT}/${walkthroughId}/contact-sheet${EXTENSION_BY_MIME[mimeType]}`;
}

/** Path segment standing in for "no project". Not a valid UUID, so it cannot collide with a real
 *  `projectId` — see `deriveWalkthroughContactSheetR2Key`. */
export const WALKTHROUGH_NO_PROJECT_KEY_SEGMENT = "_none";

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
      // What this row SAID, so a retry that keeps the id but changes the content is detectable rather
      // than silently replayed against the original — see fingerprintWalkthroughScopeRow.
      contentFingerprint: fingerprintWalkthroughScopeRow(row),
      locationLabel: row.locationLabel,
      // Kept for provenance: the trade the walkthrough classified this row as, independent of
      // whatever the resolver below turns it into.
      trade: row.trade,
      extractionProvider: "trock-scope",
      extractionMethod: "walkthrough_grounding",
      // Whether the authoritative trade was usable as a pricing key at all — see below. Recorded so an
      // unrecognized trade is visible on the row instead of being an invisible fallback.
      tradeHintApplied: isKnownTradeScopeKey(row.trade),
      // The walkthrough already KNOWS the trade, so it is handed over as `tradeHint` rather than
      // left to be re-guessed. Without it the resolver falls through to text inference
      // (pricing-service.ts:222), which scans rawLabel against a 19-member hardcoded set — and a
      // roofing row reading "Replace rotted carpentry at eave" would price as carpentry.
      // Precedence note: the tradeHint branch (pricing-service.ts:212-220) returns BEFORE the
      // divisionHint branch (:231-236), so the authoritative trade wins over divisionHint.
      //
      // The hint is passed ONLY when the canonical trade is one the pricing path can match a rule on.
      // A trade outside that 19-member set would otherwise become a scope key matching no rule, which
      // `market-rate-service.ts:84` resolves by falling back to the general adjustment — the row would
      // look trade-priced while being priced generally. Omitting the hint instead lets the resolver take
      // its ordinary inference path, which is what every non-walkthrough producer already does, and the
      // trade is still stored above for provenance.
      //
      // DELIBERATELY NOT a 400: an unrecognized trade is not a malformed payload, and refusing one would
      // couple this ingress to a hardcoded set living in a service it does not own — trock-scope would
      // start failing whenever that set was edited. It is surfaced as `tradeHintApplied: false` instead.
      ...resolvePricingScopeFromExtraction({
        divisionHint: row.divisionHint,
        metadataJson: isKnownTradeScopeKey(row.trade) ? { tradeHint: row.trade } : {},
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

/**
 * The 8-4-4-4-12 hex shape Postgres's `uuid` input parser accepts (canonical, unbraced form — which is
 * the only form anything in this codebase emits).
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Optional, and a real UUID if present.
 *
 * `projectId` lands on `estimate_source_documents.project_id`, a `uuid` column, and it is read there by
 * the idempotency lookup BEFORE anything is written. A non-empty non-UUID string ("proj-1", a slug, a
 * name) therefore reached Postgres as a uuid comparison and raised 22P02 — a 500 out of the middle of
 * the transaction, in a validator whose whole contract is a 400 before the first write. Checked here
 * for the same reason the quantity bounds are.
 *
 * NOTE on `dealId`: deliberately NOT validated this way. It comes from the authorized URL rather than
 * the body, and the route resolves the deal through `getDealById` before the ingress is called, so an
 * unparseable one is already refused upstream — whereas `projectId` arrives only in the payload and
 * nothing else looks at it first.
 */
function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const str = requireNonEmptyString(value, field);
  if (!UUID_PATTERN.test(str)) {
    throw new AppError(
      400,
      `${field} must be a UUID (received "${str}"). It is compared against a uuid column, where a ` +
        `non-UUID string is a 22P02 rather than a miss.`
    );
  }
  return str;
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
  // Both ends of numeric(14,3) — see MAX_WALKTHROUGH_QUANTITY / MIN_WALKTHROUGH_QUANTITY. Checked here
  // so an unrepresentable quantity is a 400 naming the row, not a 22003 from inside the transaction
  // (the max) or a silent zero in the table (the min).
  if (quantity > MAX_WALKTHROUGH_QUANTITY) {
    throw new AppError(
      400,
      `${at}.quantity ${quantity} exceeds the largest quantity this column can hold ` +
        `(${MAX_WALKTHROUGH_QUANTITY}). estimate_extractions.quantity is numeric(14,3), so a value ` +
        `rounding to 10^11 or more is a numeric overflow at INSERT — refused here instead.`
    );
  }
  if (quantity < MIN_WALKTHROUGH_QUANTITY) {
    throw new AppError(
      400,
      `${at}.quantity ${quantity} is smaller than the smallest quantity this column can represent ` +
        `(${MIN_WALKTHROUGH_QUANTITY}). estimate_extractions.quantity is numeric(14,3) — three ` +
        `decimal places — so Postgres would ROUND this and store it as 0.000, turning a quantity ` +
        `this contract requires to be greater than zero into exactly the zero it forbids.`
    );
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

  // Bounded to what promotion's varchar(500) can hold — see MAX_WALKTHROUGH_RAW_LABEL_CHARS. Refused
  // here so the failure lands on the sender now, rather than as a 22001 after an estimator has approved
  // the row.
  const rawLabel = requireNonEmptyString(row.rawLabel, `${at}.rawLabel`);
  if (rawLabel.length > MAX_WALKTHROUGH_RAW_LABEL_CHARS) {
    throw new AppError(
      400,
      `${at}.rawLabel is ${rawLabel.length} characters, over the ${MAX_WALKTHROUGH_RAW_LABEL_CHARS}-` +
        `character limit. Promotion copies rawLabel into estimate_line_items.description, which is ` +
        `varchar(${MAX_WALKTHROUGH_RAW_LABEL_CHARS}) — a longer label would be accepted here, approved ` +
        `by an estimator, and only then fail promotion. Split the utterance instead; it is not ` +
        `truncated, because the clause that would be cut is usually the qualifying one.`
    );
  }

  // NORMALIZED to the pricing path's canonical spelling, because it is handed over as the authoritative
  // `tradeHint` and market-rule lookup compares scope keys with `===`
  // (market-rate-service.ts:84). "Roofing" would match no roofing rule and fall back to the general
  // adjustment — silent pricing divergence, and precisely what passing the trade was meant to prevent.
  // Canonicalized once, here, so the stored provenance value and the pricing key cannot disagree.
  const trade = canonicalizeTradeScopeKey(requireNonEmptyString(row.trade, `${at}.trade`));

  return {
    sourceScopeItemId: scopeItemId,
    rawLabel,
    trade,
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

  const rows = rowsValue.map(validateScopeRow);

  // `sourceScopeItemId` is the export's own idempotency key, and `ingestWalkthrough` replays a retry's
  // ids by matching stored rows back to it. Two rows sharing one id make that mapping ambiguous — the
  // retry would get one id twice and the other row's id appended as an orphan — so a duplicate is a
  // bug upstream, refused here rather than papered over with a "last one wins".
  const seenScopeItemIds = new Set<string>();
  for (const row of rows) {
    if (seenScopeItemIds.has(row.sourceScopeItemId)) {
      throw new AppError(
        400,
        `rows contains more than one row with sourceScopeItemId "${row.sourceScopeItemId}"; ` +
          `scope item ids identify a row across retries and must be unique within a walkthrough`
      );
    }
    seenScopeItemIds.add(row.sourceScopeItemId);
  }

  return {
    walkthroughId: requireNonEmptyString(raw.walkthroughId, "walkthroughId"),
    dealId: requireNonEmptyString(raw.dealId, "dealId"),
    // Optional, never blank, and a real UUID: it lands on (and is compared against) a uuid column,
    // where "" and "proj-1" are both a 22P02 rather than a null or a miss.
    projectId: optionalUuid(raw.projectId, "projectId"),
    // NO contactSheetR2Key. Whatever the body carried under that name is dropped on the floor here —
    // the key is derived from `walkthroughId` in `ingestWalkthrough`. See
    // `deriveWalkthroughContactSheetR2Key` for why accepting one is a read primitive rather than a
    // convenience. Returning the canonical shape (rather than spreading `raw`) is what makes that
    // dropping structural: an unknown wire field cannot reach a column by accident.
    contactSheetBucket,
    contactSheetBytes,
    contactSheetMimeType: contactSheetMimeType as ContactSheetMimeType,
    siteLabel: requireNonEmptyString(raw.siteLabel, "siteLabel"),
    capturedAt,
    userId: requireNonEmptyString(raw.userId, "userId"),
    rows,
  };
}

/**
 * Compose the three links into one ingress, atomically.
 *
 * This is the only place `WalkthroughIngressPayload` — the wire contract trock-scope posts — meets the
 * helpers' narrow, storage-shaped inputs. The rename is the point: `contactSheetBucket`/`Bytes`/
 * `MimeType` become `r2Bucket`/`bytes`/`mimeType`, so the helpers stay ignorant of where their bytes
 * came from and the mapping is checked by the compiler rather than by convention. `r2Key` has NO wire
 * counterpart — it is derived here (`deriveWalkthroughContactSheetR2Key`), because a caller-supplied
 * key would let an authenticated user alias any object in the bucket onto a deal they can read.
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
    // CONCURRENT IDEMPOTENCY, and it has to be the FIRST statement in the transaction — before the
    // lookup below, or it protects nothing.
    //
    // The lookup handles a SEQUENTIAL retry: the first call committed, so the second sees its document
    // and replays it. It does nothing for two OVERLAPPING attempts. This transaction runs at READ
    // COMMITTED (Postgres's default; nothing in this codebase sets an isolation level), so two ingress
    // transactions that open together both take their snapshot before either has inserted, both find no
    // existing document, and both build a full chain — one walkthrough, two documents, two sets of
    // extractions, and an estimator looking at every scope row twice. trock-scope retrying a timed-out
    // request while the original is still in flight is exactly how that happens.
    //
    // WHY A LOCK RATHER THAN A UNIQUE INDEX. The honest fix is a partial unique index on
    // (deal_id, project_id, content_hash) where document_type = 'walkthrough', which would make the
    // second insert a 23505 no matter how the two callers interleave. That is a PRODUCTION MIGRATION
    // against a large existing table, and this PR deliberately ships no schema change — so it would
    // arrive later, leaving the race open in the meantime. An advisory lock closes it now, touches no
    // schema, and is the same instrument `lockPromotionCandidates` (draft-estimate-service.ts:136)
    // already uses a few files away. It is not a strictly equal substitute and should not be sold as
    // one: it binds only callers that take it, so a future writer of walkthrough documents that skips
    // this lock re-opens the window, where an index would have bound everyone. The index remains the
    // right eventual fix; this is what makes the seam safe without one.
    //
    // WHY IT WORKS AT READ COMMITTED SPECIFICALLY: the loser blocks here until the winner COMMITS, and
    // because each statement at READ COMMITTED takes a fresh snapshot, the loser's lookup then SEES the
    // winner's committed document and replays it. Verified on real Postgres 16.14 with two genuinely
    // concurrent connections: without the lock both insert (2 documents); with it, exactly one inserts
    // and the other replays (1 document). Under REPEATABLE READ the same experiment yields 2 documents
    // even WITH the lock — the loser's snapshot predates the insert, so it still sees nothing. If this
    // transaction is ever given a stronger isolation level, this lock stops being sufficient and the
    // unique index becomes mandatory.
    //
    // The lock is transaction-scoped: released on COMMIT or ROLLBACK, including a crash, so a failed
    // ingress cannot wedge a walkthrough. `hashtextextended(text, int8)` maps the key onto the bigint
    // the single-argument lock takes (64-bit, chosen over the neighbour's 32-bit `hashtext` because
    // this key space is database-global and a wider hash makes an unrelated collision less likely; a
    // collision would only ever cause a needless wait, never a wrong result). Postgres 11+, and it runs
    // on PGlite 17.5, which is what the runtime suite exercises it on.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${walkthroughIngressLockKey(
        payload.dealId,
        payload.walkthroughId
      )}, 0))`
    );

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
          eq(estimateSourceDocuments.contentHash, payload.walkthroughId),
          // DOCUMENT TYPE, not just the hash. `contentHash` means different things to different
          // producers: an ordinary upload stores the file's R2 KEY there (routes.ts, the
          // createEstimateSourceDocument call passes `contentHash: uploadedFile.r2Key`), while a
          // walkthrough stores the walkthrough id. Nothing makes those two namespaces disjoint, so
          // without this predicate a walkthrough id that happens to equal some existing document's
          // content hash on the same deal would make this lookup "find" that FOREIGN document and
          // replay it — handing trock-scope a 200, a plan set's document id, and whatever extraction
          // ids that document owns, while the walkthrough's own scope was never written at all. The
          // guard is cheap and it keeps idempotency keyed on this producer's own records only.
          eq(estimateSourceDocuments.documentType, "walkthrough")
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
      const fingerprintByScopeItemId = new Map<string, string | null>();
      for (const row of existingRows) {
        const metadata = row.metadataJson as {
          sourceScopeItemId?: unknown;
          contentFingerprint?: unknown;
        } | null;
        const scopeItemId = metadata?.sourceScopeItemId;
        if (typeof scopeItemId === "string") {
          idByScopeItemId.set(scopeItemId, row.id);
          fingerprintByScopeItemId.set(
            scopeItemId,
            typeof metadata?.contentFingerprint === "string" ? metadata.contentFingerprint : null
          );
        }
      }
      // A payload row with no stored extraction is a REAL disagreement, so it is raised rather than
      // dropped. The previous `.filter(id => id !== undefined)` silently discarded those, which made
      // the worst case invisible: a retry whose rows drifted got back FEWER ids than it sent, with a
      // 200 and no indication which rows were missing, so the sender recorded every utterance as
      // landed while some were never written by anybody. Two ways to get here, and neither is
      // survivable by guessing: the sender changed the walkthrough's rows between attempts (so these
      // rows were never ingested and never will be, because the document now exists and every future
      // retry replays it), or the stored extractions were deleted underneath us. Both need a human.
      const orderedIds: string[] = [];
      const unmatchedScopeItemIds: string[] = [];
      const driftedScopeItemIds: string[] = [];
      for (const row of payload.rows) {
        const id = idByScopeItemId.get(row.sourceScopeItemId);
        if (id === undefined) {
          unmatchedScopeItemIds.push(row.sourceScopeItemId);
          continue;
        }
        orderedIds.push(id);
        // Matching on the id proves a row with that id exists; it does not prove it still SAYS the same
        // thing. Compare the content too, or a retry that corrected a quantity gets a 200 while the
        // estimator keeps working from the original number.
        const storedFingerprint = fingerprintByScopeItemId.get(row.sourceScopeItemId) ?? null;
        // A stored row with NO fingerprint predates this check and cannot be compared, so it is left
        // alone rather than reported as drift. That is safe rather than a hole: this route has never
        // shipped, so no such row can exist in production — only in a database written by an earlier
        // commit on this branch, where failing every replay would be pure noise.
        if (storedFingerprint !== null && storedFingerprint !== fingerprintWalkthroughScopeRow(row)) {
          driftedScopeItemIds.push(row.sourceScopeItemId);
        }
      }

      if (unmatchedScopeItemIds.length > 0) {
        // NAMED, and capped: a 1000-row walkthrough that drifted wholesale must not put a thousand ids
        // in an error message, but the sender does need enough of them to find the drift.
        const shown = unmatchedScopeItemIds.slice(0, 10);
        const suffix =
          unmatchedScopeItemIds.length > shown.length
            ? ` (and ${unmatchedScopeItemIds.length - shown.length} more)`
            : "";
        // 409, not 500: the request conflicts with an already-ingested walkthrough's stored state.
        // Retrying it unchanged will never succeed, which is what distinguishes this from a transient
        // failure the sender should back off and repeat.
        throw new AppError(
          409,
          `Walkthrough ${payload.walkthroughId} was already ingested on this deal as document ` +
            `${existing.id}, but ${unmatchedScopeItemIds.length} of the ${payload.rows.length} rows ` +
            `posted have no stored extraction: ${shown.join(", ")}${suffix}. A retry replays the ` +
            `first call's rows and cannot add new ones, so these utterances are not stored and will ` +
            `not become stored by retrying. Either the payload changed between attempts or the ` +
            `extractions were deleted — investigate rather than re-post.`
        );
      }

      if (driftedScopeItemIds.length > 0) {
        const shown = driftedScopeItemIds.slice(0, 10);
        const suffix =
          driftedScopeItemIds.length > shown.length
            ? ` (and ${driftedScopeItemIds.length - shown.length} more)`
            : "";
        // 409 for the same reason as above, and explicitly NOT an update: applying the new content here
        // would let a retry silently rewrite rows an estimator may already have matched, priced and
        // approved. See fingerprintWalkthroughScopeRow for why corrections belong to the export ledger.
        throw new AppError(
          409,
          `Walkthrough ${payload.walkthroughId} was already ingested on this deal as document ` +
            `${existing.id}, and ${driftedScopeItemIds.length} of the ${payload.rows.length} rows ` +
            `posted have the same sourceScopeItemId but different content: ${shown.join(", ")}` +
            `${suffix}. A retry replays what was stored and never rewrites it, so this submission is ` +
            `not a retry — it is a correction, and applying it here would silently change rows an ` +
            `estimator may already have reviewed. Re-export under a new walkthrough id, or land the ` +
            `correction through the export ledger.`
        );
      }

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

    // DERIVED, never accepted. This is the whole security property: the key is a pure function of
    // walkthrough identity, so no wire input can name another deal's object. Both sides compute it —
    // trock-scope uploads the contact sheet to exactly this key before posting.
    const contactSheetR2Key = deriveWalkthroughContactSheetR2Key(
      payload.dealId,
      payload.projectId,
      payload.walkthroughId,
      payload.contactSheetMimeType
    );

    const fileId = await createWalkthroughContactSheetFile({
      tenantDb: tx,
      input: {
        dealId: payload.dealId,
        walkthroughId: payload.walkthroughId,
        siteLabel: payload.siteLabel,
        r2Key: contactSheetR2Key,
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
        storageKey: contactSheetR2Key,
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
