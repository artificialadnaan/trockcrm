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
  projects,
} from "@trock-crm/shared/schema";
import type {
  WalkthroughIngressPayload,
  WalkthroughIngressResult,
  WalkthroughScopeRow,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
// The Files subsystem's OWN size ceiling, reused rather than re-declared — see the
// contactSheetBytes check in `validateWalkthroughIngressPayload`. `file-constants.ts` is the
// dependency-free half of that module (r2-client.ts already imports from it), so this does not pull
// the S3 client or the files service onto this pure-database module's import path.
import { MAX_FILE_SIZE_BYTES } from "../files/file-constants.js";
import { canonicalizeTradeScopeKey, resolvePricingScopeFromExtraction } from "./pricing-service.js";

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
 * REQUIRES CANONICAL IDS — `canonicalizeWalkthroughIngressId` output, which the validator applies
 * once. This is string concatenation, so it is CASE-SENSITIVE where the `uuid` columns these ids are
 * compared against are not; feed it a raw wire spelling and two retries naming the same deal in
 * different hex case take two different locks. See `canonicalizeWalkthroughIngressId` for why that was
 * a P1 rather than a cosmetic inconsistency. Deliberately does NOT canonicalize its own arguments:
 * one canonicalization point is the property being enforced, and a defensive `.toLowerCase()` here
 * would hide a use site that skipped the validator instead of exposing it.
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

/** The namespace prefix on every walkthrough `content_hash`. See `walkthroughContentHash`. */
export const WALKTHROUGH_CONTENT_HASH_PREFIX = "walkthrough:";

/**
 * The `estimate_source_documents.content_hash` a walkthrough is stored under — NAMESPACED, so it cannot
 * collide with an ordinary upload's.
 *
 * `content_hash` is one column with unrelated meanings per producer: an ordinary estimate upload stores
 * the file's R2 KEY there (routes.ts hands `createEstimateSourceDocument` `contentHash:
 * uploadedFile.r2Key`), a walkthrough stores its export id. This ingress's own lookup already excluded a
 * foreign document with `documentType = 'walkthrough'`, so WE were safe — but the collision runs the
 * OTHER WAY TOO, and that direction was left open:
 *
 *   `createEstimateSourceDocument` (document-service.ts:104-130) dedupes on
 *   (dealId, projectId, contentHash) with NO documentType predicate. So if a walkthrough id ever equalled
 *   an ordinary upload's content hash on the same deal and project, that later upload would match THIS
 *   completed walkthrough document, return it, and — because the early return happens before the enqueue
 *   — SKIP ITS OCR ENQUEUE ENTIRELY. The upload is accepted and silently never parsed: no failed job, no
 *   error, just a plan set that produces no extractions.
 *
 * Prefixing is a ONE-SIDED fix and is chosen deliberately over adding a predicate to
 * `createEstimateSourceDocument`: that function is a shared code path with several callers, and changing
 * what it considers a duplicate is a far larger blast radius than making this producer's keys
 * unmistakable. A prefixed hash cannot equal an R2 key that starts with a deal id or an `estimate/`
 * prefix, so the two namespaces are now disjoint by construction rather than by predicate.
 *
 * The column is unbounded `text` (estimate-source-documents.ts:33), so the prefix costs no width bound.
 * EVERY read and write of a walkthrough's content hash goes through this function — the write in
 * `createWalkthroughSourceDocument` and the idempotency lookup in `ingestWalkthrough` — because the
 * stored form IS the idempotency key: one side unprefixed would make every retry miss and build a second
 * chain.
 */
export function walkthroughContentHash(walkthroughId: string): string {
  return `${WALKTHROUGH_CONTENT_HASH_PREFIX}${walkthroughId}`;
}

/**
 * The quantity band a walkthrough quantity can survive ALL THE WAY to a promoted estimate.
 *
 * NOT the band of the column this module inserts into, and that distinction is the whole point.
 * `estimate_extractions.quantity` is `numeric(14,3)` (estimate-extractions.ts:37) and would take
 * eleven integer digits, but the promotion chain NARROWS: extraction ->
 * `estimate_pricing_recommendations.recommended_quantity`, `numeric(14,3)`
 * (estimate-pricing-recommendations.ts:57, written at recommendation-persistence-service.ts:101) ->
 * `estimate_line_items.quantity`, which is `numeric(12,3)` (estimate-line-items.ts:22) — NINE integer
 * digits. The NARROWEST column in the chain governs the ingress bound, not the insert target.
 *
 * WHY THAT IS NOT TIDINESS. A quantity between the two limits — 10^9 to 10^11 — was accepted here,
 * priced, reviewed, and APPROVED by an estimator, and only then raised `numeric field overflow`
 * (22003) at `createLineItem` (deals/estimate-service.ts:194) as promotion tried to write it. That is
 * the worst possible place to discover it: after a human signed off on the row, in a code path the
 * sender is no longer watching. Refused at the door instead.
 *
 *   MAX — Postgres refuses a value that ROUNDS to an absolute value >= 10^9 with a 22003. Verified on
 *   PGlite 17.5 against a real `numeric(12,3)`: 999999999.999 stores exactly, 1000000000 and
 *   999999999.9996 (which rounds UP past the limit) both raise 22003, and 999999999.9994 rounds DOWN
 *   and is accepted. The bound below is therefore very slightly conservative — it also refuses the
 *   sliver between 999999999.999 and the true rounding threshold — which is the harmless direction,
 *   and no walkthrough reaches nine integer digits anyway.
 *
 *   MIN — and this is the dangerous one, because it SUCCEEDS. Scale 3 makes Postgres ROUND, not
 *   reject: verified against real Postgres 16.14, 0.0001 and 0.0004 both store as exactly 0.000. So a
 *   payload this module explicitly refuses at `quantity <= 0` can walk straight back in as 0.0001 and
 *   land in the table as a zero — the very value the guard above exists to keep out, arrived at
 *   silently. (0.0005 rounds UP to 0.001 and would survive; the bound is set at the column's smallest
 *   representable value, 0.001, rather than at the exact collapse threshold, because "the column
 *   stores three decimals" is a rule a sender can act on and "below 0.0005 you become zero" is not.)
 *   Scale is 3 at every step of the chain, so unlike the max the min is the same wherever it is
 *   measured — narrowing changed the precision, not the scale.
 */
export const MAX_WALKTHROUGH_QUANTITY = 999999999.999;
export const MIN_WALKTHROUGH_QUANTITY = 0.001;

/**
 * The longest `unit` the chain can carry.
 *
 * `estimate_extractions.unit` is `varchar(50)` (estimate-extractions.ts:38), and `unit` arrived here as
 * an arbitrary string — so a longer value raised `value too long for type character varying(50)`
 * (22001) from inside the ingress transaction and returned a 500, contradicting the
 * 400-before-any-write contract the rest of this validator establishes.
 *
 * 50 is the width at EVERY step of the promotion chain — extraction `varchar(50)` ->
 * `estimate_pricing_recommendations.recommended_unit` `varchar(50)`
 * (estimate-pricing-recommendations.ts:58, written from the extraction's unit at
 * recommendation-persistence-service.ts:102) -> `estimate_line_items.unit` `varchar(50)`
 * (estimate-line-items.ts:23). So unlike `quantity` and `divisionHint` there is NO narrower downstream
 * column here and this bound does not need re-auditing. Recorded explicitly so nobody has to re-derive
 * it to find that out.
 */
export const MAX_WALKTHROUGH_UNIT_CHARS = 50;

/**
 * The longest `divisionHint` that can survive promotion.
 *
 * `estimate_extractions.division_hint` is unbounded `text` (estimate-extractions.ts:39), so ingress
 * alone would accept any length — but divisionHint is not merely stored. It BECOMES THE SECTION NAME of
 * the promoted estimate, and `estimate_sections.name` is `varchar(255) NOT NULL` (estimate-sections.ts).
 * Traced through the code rather than inferred from the column names:
 * `loadApprovedRecommendationsForRun` selects it under that alias (draft-estimate-service.ts:96,
 * `sectionName: estimateExtractions.divisionHint`) -> `getPricingRowSectionName` passes it through
 * `normalizeScopeLabel`, which only trims (workbench-service.ts:63-67, :90-95) ->
 * `groupRecommendationsIntoSections` groups on it (draft-estimate-service.ts:143) ->
 * `getOrCreateEstimateSection` (:159) -> `createSection` (deals/estimate-service.ts:99) INSERTs it.
 *
 * And the lookup does not catch it first: `getOrCreateEstimateSection` asks whether a section of that
 * name already exists, but a `varchar(255) = $1` comparison against a 256-character parameter simply
 * MISSES rather than erroring (verified on PGlite 17.5: 0 rows, no error). So an over-long hint sails
 * past the existence check and dies on the INSERT with a 22001 — the same failure moment as `rawLabel`
 * and an over-wide `quantity`, i.e. after an estimator has already approved the row.
 *
 * Only trimming happens between here and that INSERT, and trimming can only shorten, so 255 measured
 * at ingress is still 255 measured at the column.
 */
export const MAX_WALKTHROUGH_DIVISION_HINT_CHARS = 255;

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
 * and unit, the division hint, the trade, the location, the transcript quote, and the evidence triple.
 *
 * WHY `evidenceText` IS IN AND `confidence` IS OUT — the one exclusion here, and the contrast is the
 * reason both belong in this docblock rather than looking like an oversight:
 *
 *   `evidenceText` IS THE EVIDENCE. It is the transcript quote the row is grounded in, and promotion
 *   copies it into `estimate_line_items.notes` (draft-estimate-service.ts:95), so it is read by the
 *   estimator deciding whether the row means what it claims. A retry that corrects only the quote — a
 *   re-transcription, a fixed diarization boundary — was matching the fingerprint, reporting a
 *   successful replay, and leaving the STALE text in place to be promoted later. Same silent-divergence
 *   shape as the corrected quantity above, one field over.
 *
 *   `confidence` IS NOT. It is the model's score for the same utterance, not a claim about what was
 *   said: a re-scored 0.87 -> 0.42 on byte-identical content is the model changing its mind, and
 *   failing a retry over it would be pure noise. Nothing downstream reads it as content — it has no
 *   line-item column at all.
 *
 * The distinction, stated once: a field is IN when a change to it means the utterance was described
 * differently, and OUT when a change to it means the same utterance was judged differently.
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
    row.evidenceText,
    row.evidence.clipId,
    row.evidence.timelineMs,
    row.evidence.frameKey,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** What a stored walkthrough's contact-sheet `files` row says about the ARTIFACT, read back on replay
 *  and compared with the incoming envelope. Named separately from the payload so the comparison below
 *  reads as "stored vs posted" rather than as two similar objects. */
export interface StoredWalkthroughContactSheet {
  mimeType: string;
  fileSizeBytes: number;
  takenAt: Date | null;
  displayName: string;
  r2Key: string;
}

/**
 * The ENVELOPE half of the replay drift check — everything the row fingerprint above does not cover.
 *
 * WHY IT EXISTS. `fingerprintWalkthroughScopeRow` compares what each row SAYS; the replay path validated
 * those and returned the original chain while ignoring the payload's envelope entirely:
 * `contactSheetMimeType`, `contactSheetBytes`, `capturedAt` and `siteLabel` were never looked at. A
 * submission could therefore change the ARTIFACT and still be reported as a successful retry.
 *
 * THE MIME CASE IS THE DAMAGING ONE, and it is worth spelling out because it is not merely a stale
 * column. `files.r2_key` is DERIVED from the mime type (`deriveWalkthroughContactSheetR2Key` —
 * ".../contact-sheet.jpg" vs ".../contact-sheet.pdf"), and the trock-scope contract is that the sender
 * uploads the sheet to exactly that key BEFORE it posts. So a corrected mime type means the corrected
 * contact sheet was uploaded to a NEW key, while the replayed response still points at the old one: the
 * request succeeds, the sender believes the correction landed, and the estimator opens the superseded
 * artifact (or a 404, if the old object was replaced). Silent, and identical in shape to the row-level
 * drift R7 already refuses — one level up.
 *
 * WHY THESE FOUR AND NOT `confidence`. The reasoning in `fingerprintWalkthroughScopeRow` is unchanged
 * and this check does not weaken it: `confidence` is the model's judgement of the same utterance, so a
 * re-score on identical content is the model changing its mind and failing a retry over it would be
 * noise. Envelope fields are not judgements — they describe the artifact itself (what it is, how big it
 * is, when it was captured, what site it shows). A change to one of them means a different artifact is
 * being announced, which is exactly the "IN" side of that docblock's rule.
 *
 * COMPARED AGAINST THE STORED `files` ROW rather than against a stored fingerprint of the envelope,
 * because a fingerprint can only say "something changed" and the sender needs to be told WHICH field —
 * the same courtesy the row-level check extends by naming scope item ids.
 *
 * Two deliberate looseness decisions, both stated so they are not mistaken for oversights:
 *   • `capturedAt` is compared as an INSTANT, not as a string. Two spellings of one moment
 *     ("…T14:05:00Z" and "…T14:05:00.000Z") describe the same capture and must not 409 — `files.taken_at`
 *     is `timestamptz`, so the stored value is the instant and the string form is not recoverable anyway.
 *   • `siteLabel` is compared through `buildWalkthroughContactSheetDisplayName`, i.e. as the composed
 *     `files.display_name` the writer actually stored. That couples this check to that builder: if the
 *     fixed prefix is ever edited, already-stored rows compare unequal and their replays start
 *     409ing. The bound `MAX_WALKTHROUGH_SITE_LABEL_CHARS` is derived from the same builder, so the
 *     coupling already exists in this module — but a prefix change now needs a data migration, not just
 *     a re-measure.
 */
export function detectWalkthroughEnvelopeDrift(
  stored: StoredWalkthroughContactSheet,
  payload: WalkthroughIngressPayload
): string[] {
  const drifted: string[] = [];

  if (stored.mimeType !== payload.contactSheetMimeType) {
    // The derived key is named in full, because "the mime type changed" understates it: the object the
    // sender uploaded and the object this document points at are two different keys.
    const wouldBeKey = deriveWalkthroughContactSheetR2Key(
      payload.dealId,
      payload.projectId,
      payload.walkthroughId,
      payload.contactSheetMimeType
    );
    drifted.push(
      `contactSheetMimeType (stored "${stored.mimeType}", posted "${payload.contactSheetMimeType}") — ` +
        `the contact sheet's R2 key is DERIVED from its mime type, so the posted sheet was uploaded to ` +
        `"${wouldBeKey}" while this document still points at "${stored.r2Key}"`
    );
  }

  if (Number(stored.fileSizeBytes) !== payload.contactSheetBytes) {
    drifted.push(
      `contactSheetBytes (stored ${Number(stored.fileSizeBytes)}, posted ${payload.contactSheetBytes})`
    );
  }

  const expectedDisplayName = buildWalkthroughContactSheetDisplayName(payload.siteLabel);
  if (stored.displayName !== expectedDisplayName) {
    drifted.push(
      `siteLabel (stored contact sheet is named "${stored.displayName}", posted "${payload.siteLabel}" ` +
        `would name it "${expectedDisplayName}")`
    );
  }

  // A stored row with no `taken_at` cannot be compared, so it is left alone rather than reported as
  // drift — the same treatment a stored row with no `contentFingerprint` gets, and for the same reason:
  // this module always writes one, so a null can only come from a row it did not write.
  if (stored.takenAt !== null) {
    const storedAt = stored.takenAt.getTime();
    const postedAt = new Date(payload.capturedAt).getTime();
    if (storedAt !== postedAt) {
      drifted.push(
        `capturedAt (stored ${stored.takenAt.toISOString()}, posted ${payload.capturedAt})`
      );
    }
  }

  return drifted;
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

/**
 * The object-storage operations this ingress needs, INJECTED by the caller.
 *
 * WHY A PORT RATHER THAN AN IMPORT. Every other note in this module says it does not pull the S3 client
 * onto its import path (see `getCrmFileBucket`, and the `file-constants.ts` note at the top) — that is
 * still true, and injecting is what keeps it true now that the seam has to touch storage. It is also the
 * pattern the neighbouring `createEstimateSourceDocument` already uses for `enqueueEstimateDocumentOcr`.
 *
 * REQUIRED, NOT OPTIONAL, and this is the load-bearing part of the design. An optional port defaulting
 * to "skip verification" is exactly how a guard becomes decorative: every caller that forgot it would
 * still get a 201. Making it required means the compiler names any new caller that has not decided.
 *
 * ── PARITY AUDIT AGAINST `confirmUpload` ─────────────────────────────────────────────────────────────
 *
 * This module is a PARALLEL file-creation path, and it has been repaired one skipped `confirmUpload`
 * invariant at a time (the mime whitelist, the leading-dot `fileExtension`, the bucket, the size
 * ceiling, and now these two). So the whole of `confirmUpload` (files/service.ts:773-860) was walked
 * once and recorded here, to stop the next reviewer finding a fifth omission:
 *
 *   HEAD-verify the object, Content-Type and Content-Length  → `head` below (was missing).
 *   thumbnail, image then PDF fallback                       → `generate*Thumbnail` below (was missing).
 *   leading-dot `fileExtension`                              → EXTENSION_BY_MIME.
 *   `r2Bucket` from R2_BUCKET_NAME with the same default     → getCrmFileBucket.
 *   size ceiling                                             → MAX_FILE_SIZE_BYTES in the validator.
 *   `takenAt` from the caller                                 → `capturedAt`, calendar-validated.
 *   `isActive: true`, `version` default                       → set / defaulted.
 *   photo address + EXIF geocoding (`category === "photo"`)   → N/A: this row is `category: "estimate"`.
 *   `clientUploadId` dedupe, its partial unique index, and
 *     the losing-writer `deleteObject` cleanup               → N/A: idempotency here is the walkthrough
 *                                                              id triple, and no clientUploadId is set.
 *   submitted-scorecard edit binding, pending-upload token    → N/A: no token flow; there is no
 *                                                              browser-issued presign to consume.
 * Nothing else in `confirmUpload` writes to or validates a `files` row.
 */
export interface WalkthroughContactSheetStore {
  /** `isR2Configured()`. Mirrors `confirmUpload`'s own gate: with no object store configured (local dev,
   *  CI) the verification below is skipped rather than failing every ingress. Same posture as the rest of
   *  the CRM — deliberately not stricter here, so the seam behaves the way the Files subsystem does. */
  isConfigured: () => boolean;
  /** `headObject(r2Key)` — the object's Content-Type/Content-Length, or null when it is absent. */
  head: (r2Key: string) => Promise<{ contentType?: string; contentLength?: number } | null>;
  /** `generateAndStoreThumbnail(r2Key, mimeType)` — best-effort, returns the stored key or null. */
  generateImageThumbnail: (r2Key: string, mimeType: string) => Promise<string | null>;
  /** `generateAndStorePdfThumbnail(r2Key, mimeType)` — the PDF arm of the same fallback chain. */
  generatePdfThumbnail: (r2Key: string, mimeType: string) => Promise<string | null>;
}

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
    /**
     * R25. The small JPEG the file LIST renders, or null when one could not be produced.
     *
     * Not optional, so a caller has to have thought about it. Left null, `resolveFileThumbnailUrl`
     * (files/service.ts:1574-1580) falls through to `isThumbnailableImage(mimeType) && r2Key` and
     * presigns THE ORIGINAL as the list image — so opening a deal's file list downloads the entire
     * contact sheet to draw one tile. (An `application/pdf` sheet fails that predicate and gets a type
     * badge instead, which is why this only ever bit the jpeg case.)
     *
     * DERIVED SERVER-SIDE by the Files subsystem's own `deriveThumbnailKey`, never accepted from the
     * wire — the confused-deputy read primitive `deriveWalkthroughContactSheetR2Key` exists to prevent
     * applies to this key exactly as much as to the main one.
     */
    thumbnailR2Key: string | null;
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

/** `files.display_name` and `files.system_filename` are both `varchar(500)` (files.ts:42-43). Both are
 *  COMPOSED here out of payload fields, so the payload fields have to be bounded to what is left of 500
 *  after the composition — which is what the two builders below exist to make precise. */
const FILES_NAME_COLUMN_CHARS = 500;

/**
 * The contact sheet's human-facing `files.display_name`.
 *
 * A named builder rather than an inline template because the PREFIX is what makes
 * `MAX_WALKTHROUGH_SITE_LABEL_CHARS` correct, and that bound is computed by measuring this function's
 * own output for an empty label. Editing the prefix therefore moves the bound with it, instead of
 * silently invalidating a hand-counted number.
 */
export function buildWalkthroughContactSheetDisplayName(siteLabel: string): string {
  return `Walkthrough evidence — ${siteLabel}`;
}

/**
 * The contact sheet's `files.system_filename`, and by the same argument the basis of
 * `MAX_WALKTHROUGH_ID_CHARS`.
 */
export function buildWalkthroughContactSheetSystemFilename(
  walkthroughId: string,
  mimeType: ContactSheetMimeType
): string {
  // The extension already carries its dot, so this concatenates rather than re-inserting one.
  return `walkthrough-${walkthroughId}${EXTENSION_BY_MIME[mimeType]}`;
}

/**
 * The longest `siteLabel` that fits the column it is composed into.
 *
 * `siteLabel` reaches two columns: `estimate_source_documents.filename`, unbounded `text`, and
 * `files.display_name`, `varchar(500)` — so the file row governs. Unlike `quantity`, `unit` and
 * `divisionHint` the failure here is NOT post-approval: `createWalkthroughContactSheetFile` is the
 * FIRST write of the ingress transaction, so an over-long label was a 22001 and a 500 response rather
 * than the 400 naming the field that this validator promises.
 *
 * DERIVED from the builder above rather than written as a literal, so the prefix and the bound cannot
 * drift apart.
 */
export const MAX_WALKTHROUGH_SITE_LABEL_CHARS =
  FILES_NAME_COLUMN_CHARS - buildWalkthroughContactSheetDisplayName("").length;

/**
 * The longest `walkthroughId` the chain can carry.
 *
 * Deliberately NOT validated as a UUID — it reaches `estimate_source_documents.content_hash` (prefixed,
 * via `walkthroughContentHash`), which is unbounded `text`, and the contract with trock-scope is an
 * opaque export id rather than a Postgres uuid. The prefix costs nothing against a `text` column, so
 * this bound is still governed by `files.system_filename` as derived below. It IS
 * still canonicalized (lowercased) by the validator, and that is a deliberate choice rather than a
 * consequence of the UUID one: `content_hash` being `text` means Postgres compares it case-SENSITIVELY,
 * so unlike `dealId` this id was already consistent across the lookup, the lock and the r2 key, and
 * there was no divergence to close. It is folded into `canonicalizeWalkthroughIngressId` anyway so the
 * ingress has exactly ONE canonical spelling per request — the alternative was a retry that re-cased
 * its own export id silently ingesting a SECOND complete chain, which is the same estimator-facing
 * outcome as the case bug in `dealId`, just arrived at legitimately. The cost is that two genuinely
 * distinct case-differing export ids (a base64-ish id, never a uuid) would now collide — and collide as
 * a LOUD 409 from the drift check, not as a silent merge.
 *
 * The id is COMPOSED into two bounded columns: `files.system_filename` `varchar(500)` and `files.r2_key`
 * `varchar(1000)` (files.ts:43, :48). `system_filename` is the tighter of the two by a wide margin —
 * the derived r2 key spends only 105 characters on its fixed segments and its two UUIDs, leaving ~895 —
 * so bounding to `system_filename` covers both. That relationship is asserted in the runtime suite
 * rather than trusted to this comment.
 *
 * Measured against the LONGEST accepted extension, so the bound holds for every mime type rather than
 * for whichever one happened to be measured.
 */
export const MAX_WALKTHROUGH_ID_CHARS =
  FILES_NAME_COLUMN_CHARS -
  Math.max(
    ...WALKTHROUGH_CONTACT_SHEET_MIME_TYPES.map(
      (mimeType) => buildWalkthroughContactSheetSystemFilename("", mimeType).length
    )
  );

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
 * Deriving it does: `walkthroughId` is the same value the document's `contentHash` is built from
 * (`walkthroughContentHash`), so the key is bound to walkthrough identity and there is no input from
 * which a caller could name
 * another deal's object. The path is the CONTRACT with trock-scope — the exporter uploads the contact
 * sheet to exactly this key before it posts — so both sides compute it rather than exchange it.
 *
 * REQUIRES CANONICAL IDS, exactly as `walkthroughIngressLockKey` does and for the same reason: this is
 * string interpolation over values that Postgres compares case-insensitively, so an uncanonicalized
 * `dealId` derives a DIFFERENT key for the same deal — which is what made `files.r2_key`'s unique index
 * stop being a backstop. The validator canonicalizes once; this function does not re-do it, so a use
 * site that bypassed the validator shows up as a bug rather than being silently absorbed. Because both
 * sides of the contract compute this path, "canonical (lowercase) ids" is part of the contract too.
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
  // Both names come from the shared builders, which are ALSO what MAX_WALKTHROUGH_SITE_LABEL_CHARS and
  // MAX_WALKTHROUGH_ID_CHARS are measured from — so the string written here and the length the
  // validator enforces can never disagree.
  const systemFilename = buildWalkthroughContactSheetSystemFilename(
    input.walkthroughId,
    input.mimeType
  );

  const [row] = await tenantDb
    .insert(files)
    .values({
      dealId: input.dealId,
      // FILE_CATEGORIES has no "estimating" member; "estimate" is the estimating-path category and
      // adding an enum value would require a migration. See shared/src/types/enums.ts.
      category: "estimate",
      displayName: buildWalkthroughContactSheetDisplayName(input.siteLabel),
      systemFilename,
      originalFilename: systemFilename,
      mimeType: input.mimeType,
      fileSizeBytes: input.bytes,
      fileExtension: extension,
      r2Key: input.r2Key,
      // R25. Without it the file list presigns the ORIGINAL as its tile image — see the field's docblock.
      thumbnailR2Key: input.thumbnailR2Key,
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
      // Deliberate: the walkthrough id, NAMESPACED, is the content hash — so a re-ingest of the same
      // walkthrough is recognizable on the same (dealId, projectId, contentHash) triple
      // document-service.ts:104-130 dedupes against. `ingestWalkthrough` reads exactly that triple
      // before it writes anything, and replays the existing chain instead of building a second one.
      //
      // The `walkthrough:` prefix is not decoration: `createEstimateSourceDocument` dedupes ordinary
      // uploads on that triple with NO documentType predicate, so an unprefixed id colliding with an
      // upload's content hash would make that upload "find" this document and skip its OCR enqueue. See
      // `walkthroughContentHash` — which is also what the lookup reads, because the stored form is the
      // idempotency key.
      //
      // This helper itself performs no dedupe check and the column carries no unique constraint, so
      // calling IT twice directly still writes two documents — the guard lives one level up.
      contentHash: walkthroughContentHash(input.walkthroughId),
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
 *
 * ── WIDTH AUDIT: the fields written below that need NO ingress bound, and why ────────────────────────
 *
 * The rule this module follows is that an ingress bound matches the NARROWEST column anywhere in the
 * promotion chain (extraction -> pricing recommendation -> line item), not the column being inserted
 * into — because a chain that narrows turns an accepted value into a 22003/22001 at `createLineItem`,
 * i.e. after an estimator has approved the row. `quantity` (numeric(12,3) downstream), `rawLabel`
 * (varchar(500) downstream) and `divisionHint` (varchar(255) downstream) are all bounded for that
 * reason, and `unit` because varchar(50) is the width everywhere. The REST were traced the same way and
 * are genuinely unbounded end to end. Recorded so the next reviewer does not have to re-derive it:
 *
 *   normalizedLabel — `text` here; promoted only into `normalizedIntent` (`text`),
 *     `sourceRowIdentity` (`text`) and an option's `optionLabel` (`text`). It never reaches a bounded
 *     column: `optionLabel` falls back to it only when `rawLabel` is null
 *     (worker/src/jobs/estimate-generation.ts:379), which ingress makes impossible. Worth knowing that
 *     `.toLowerCase()` can LENGTHEN a string in Unicode (U+0130 lowercases to two code points), so this
 *     is not simply "<= rawLabel's bound" — it is safe because the target is unbounded, not because the
 *     length is preserved.
 *   evidenceText — `text` here, promoted into `estimate_line_items.notes`, also `text`
 *     (draft-estimate-service.ts:95 -> estimate-line-items.ts:26), and copied into `evidenceJson`.
 *     Unbounded at every step.
 *   confidence — `numeric(5,2)` here and `numeric(5,2)` on the recommendation
 *     (estimate-pricing-recommendations.ts:67); no line-item column at all. Already constrained to
 *     0..1 by the validator, which is far inside the column, so no width bound is needed.
 *   locationLabel, trade, evidence.clipId, evidence.frameKey — written into `jsonb`
 *     (`metadataJson` / `evidenceBboxJson`), which has no width. None is read back out as a typed
 *     column: `trade` becomes `metadataJson.tradeHint` and then an in-memory `pricingScopeKey` compared
 *     with `===` against market rules (market-rate-service.ts:84); `locationLabel`, `clipId` and
 *     `frameKey` have no reader outside this module at all.
 *   every other metadataJson value — `activeArtifact` (a boolean),
 *     `sourceParseRunId`, `sourceWalkthroughId`, `contentFingerprint`, `extractionProvider`,
 *     `extractionMethod`, `pricingScopeType`, `pricingScopeKey` (all server-derived, none caller-
 *     controlled), and `sourceScopeItemId`, which IS caller-controlled but is only ever read back via
 *     `->>` into a JS Map and error messages — never into a typed column.
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
      // The walkthrough already KNOWS the trade, so it is handed over as `tradeHint` rather than
      // left to be re-guessed. Without it the resolver falls through to text inference
      // (pricing-service.ts:222), which scans rawLabel against a 19-member hardcoded set — and a
      // roofing row reading "Replace rotted carpentry at eave" would price as carpentry.
      // Precedence note: the tradeHint branch (pricing-service.ts:212-220) returns BEFORE the
      // divisionHint branch (:231-236), so the authoritative trade wins over divisionHint.
      //
      // PASSED UNCONDITIONALLY, and an earlier revision of this line was wrong to do otherwise. It
      // gated the hint on `isKnownTradeScopeKey(row.trade)` — membership of `tradeScopeHints`
      // (pricing-service.ts:116) — on the theory that a key matching no rule would be worse than no
      // key. But that set is the TEXT-INFERENCE VOCABULARY: 19 roofing-heavy terms with no flooring,
      // millwork, tile or ACT in it. `estimate_market_adjustment_rules.scope_key` is a varchar(120)
      // that permits ARBITRARY keys, so a tenant with a configured `flooring` rule had the hint
      // filtered out, the resolver fell back to division or inferred-prose scope, and
      // `market-rate-service.ts:84`'s `===` never selected the rule they configured — the exact
      // divergence handing over the trade exists to prevent, reintroduced by the guard against it.
      //
      // A key that matches no rule needs no help from us: market-rate lookup falls through to the
      // general adjustment on its own, which is its documented job. Filtering here bought nothing and
      // coupled this ingress to a hardcoded list in a service it does not own — so trock-scope's
      // pricing basis would have shifted whenever that list was edited.
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

/**
 * The 8-4-4-4-12 hex shape Postgres's `uuid` input parser accepts (canonical, unbraced form — which is
 * the only form anything in this codebase emits).
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * THE SINGLE CANONICALIZATION POINT for every identifier this module derives a key from.
 *
 * WHY IT HAS TO EXIST, and why it was a P1 rather than tidiness. Postgres compares `uuid` columns by
 * their 128-bit VALUE, so `A1B2…` and `a1b2…` are the SAME deal row. JavaScript string concatenation
 * compares bytes, so they are two different strings. Three of this module's protections are strings
 * built by concatenation from those ids:
 *
 *   • the advisory lock key (`walkthrough-ingress:${dealId}:${walkthroughId}`),
 *   • the derived R2 key (`walkthroughs/${dealId}/${projectId}/${walkthroughId}/…`), which is what
 *     `files.r2_key`'s UNIQUE index sees,
 *   • …while the idempotency lookup compares `deal_id`/`project_id` as `uuid` and therefore does not
 *     care about case at all.
 *
 * So two overlapping retries spelling one deal id in different hex case RESOLVED TO THE SAME DEAL,
 * took DIFFERENT advisory locks (no serialization), and derived DIFFERENT r2 keys (no unique-index
 * backstop) — both passed the idempotency lookup and both built a complete chain. That defeats BOTH
 * protections this branch added, simultaneously, and neither would have logged anything: the estimator
 * simply sees every scope row twice.
 *
 * WHY HERE AND NOWHERE ELSE. Canonicalizing at each use site would be four `.toLowerCase()` calls that
 * are individually correct and collectively worthless — the property that matters is that every
 * derivation sees ONE form, and that is only checkable if there is one place it is established.
 * Everything downstream (lock key, r2 key, idempotency lookup, `content_hash`, the row fingerprint,
 * the project-ownership comparison) reads the validator's output, so canonical-in means canonical
 * everywhere by construction.
 *
 * LOWERCASE specifically, because that is the form Postgres itself emits for a `uuid` column — so a
 * value read BACK out of the database (e.g. `projects.source_deal_id` in the ownership check below)
 * compares equal to a canonicalized payload id with `===`, without a second canonicalization.
 */
export function canonicalizeWalkthroughIngressId(value: string): string {
  return value.toLowerCase();
}

/**
 * A real UUID, canonicalized.
 *
 * `dealId` lands on `files.deal_id`, `estimate_source_documents.deal_id` and
 * `estimate_extractions.deal_id` — all `uuid` — AND is interpolated into both derived string keys. It
 * is validated here rather than left to the route for two reasons that only became true with the
 * canonicalization above: lowercasing is a sound canonical form only for hex (for an arbitrary string
 * it is a lossy transform, so validating the shape is what MAKES the canonicalization safe), and a
 * dealId that is not a uuid at all previously reached `getDealById` as a uuid comparison and surfaced
 * as a 500 from a validator whose whole contract is a 400 naming the field.
 */
function requireUuid(value: unknown, field: string): string {
  const str = canonicalizeWalkthroughIngressId(requireNonEmptyString(value, field));
  if (!UUID_PATTERN.test(str)) {
    throw new AppError(
      400,
      `${field} must be a UUID (received "${str}"). It is compared against a uuid column, where a ` +
        `non-UUID string is a 22P02 rather than a miss.`
    );
  }
  return str;
}

/**
 * Optional, and a real UUID if present — canonicalized, as above.
 *
 * `projectId` lands on `estimate_source_documents.project_id`, a `uuid` column, and it is read there by
 * the idempotency lookup BEFORE anything is written. A non-empty non-UUID string ("proj-1", a slug, a
 * name) therefore reached Postgres as a uuid comparison and raised 22P02 — a 500 out of the middle of
 * the transaction, in a validator whose whole contract is a 400 before the first write. Checked here
 * for the same reason the quantity bounds are.
 *
 * Canonicalized for CONSISTENCY, and it is worth being exact that this is weaker than `dealId`'s case:
 * `projectId` is a segment of the derived r2 key, but a case-only difference in it cannot double a chain
 * the way `dealId`'s can. The idempotency lookup compares `project_id` as a `uuid`, so a re-cased retry
 * still FINDS the stored document and replays without deriving a key at all. What canonicalizing buys
 * is that the key stored on the `files` row is the same key both sides of the trock-scope contract
 * compute — rather than whichever spelling happened to arrive first. Defence in depth, named as such.
 */
function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requireUuid(value, field);
}

/**
 * An ISO-8601 date-time WITH an explicit UTC designator or offset.
 *
 * The offset is required, not optional, and that is deliberate: `new Date("2026-07-29T14:05:00")` — no
 * Z, no offset — is parsed as LOCAL time, so the instant recorded on `files.taken_at` would depend on
 * the server's timezone. A string with no offset does not name an instant at all, which makes
 * "round-trips to the instant the string names" meaningless for it.
 *
 * The component groups are deliberately loose (`\d{2}`, not `0[1-9]|1[0-2]`): the calendar check below
 * is what decides validity, and encoding month/day ranges in a regex is where "31 April" gets accepted
 * by a pattern that looks rigorous.
 */
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * A timestamp that names a date THAT EXISTS.
 *
 * `Number.isNaN(new Date(value).getTime())` — the whole check this replaces — passes for
 * `2026-02-30T00:00:00Z`, because JavaScript SILENTLY NORMALIZES an impossible day: February 30 becomes
 * March 2, April 31 becomes May 1. `files.taken_at` then records a capture instant up to two days from
 * the one the sender named, and every chronological view of the deal's evidence (everything orders on
 * COALESCE(taken_at, created_at), files/service.ts:2031) misorders it — which is the exact problem
 * storing `taken_at` structurally was meant to solve. Nothing later notices: the value is a perfectly
 * valid timestamp, just not the right one.
 *
 * Verified rather than assumed, on this Node: `2026-02-30T00:00:00Z` and `2026-04-31T00:00:00Z` both
 * parse WITHOUT NaN and both shift; `2026-13-01T00:00:00Z`, `2026-07-32T00:00:00Z` and
 * `2026-07-29T25:00:00Z` are NaN and so were already refused. Only the silent-shift family was open,
 * and it is the family that cannot be detected by parsing alone.
 *
 * CHECKED BY ROUND-TRIP ON THE STRING'S OWN CALENDAR COMPONENTS, not on the parsed instant. Building a
 * UTC date from (year, month, day) and asking whether it still names that day is what exposes the
 * normalization — and it has to be the string's components rather than the instant's, because a
 * legitimate offset timestamp names a different UTC day on purpose ("2026-07-29T23:00:00-05:00" is
 * 2026-07-30 in UTC and must be accepted).
 *
 * The calendar check runs BEFORE the parse check so an out-of-range month gets the calendar message
 * rather than a generic "unparseable" — the two overlap for month/day and only the calendar check
 * covers the silent-shift cases.
 */
function requireCalendarTimestamp(value: unknown, field: string): string {
  const str = requireNonEmptyString(value, field);

  const match = ISO_TIMESTAMP_PATTERN.exec(str);
  if (!match) {
    throw new AppError(
      400,
      `${field} must be an ISO-8601 timestamp with an explicit UTC designator or offset ` +
        `(e.g. "2026-07-29T14:05:00Z"), received "${str}". Without an offset the string names a local ` +
        `wall-clock time rather than an instant, and files.taken_at would record whatever the server's ` +
        `timezone made of it.`
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new AppError(
      400,
      `${field} "${str}" names a date that does not exist. JavaScript normalizes an impossible day ` +
        `instead of rejecting it (February 30 becomes March 2, April 31 becomes May 1), so this would ` +
        `have been stored on files.taken_at as ${roundTrip.toISOString().slice(0, 10)} and the deal's ` +
        `evidence would sort as though the walkthrough happened on a different day.`
    );
  }

  if (Number.isNaN(new Date(str).getTime())) {
    throw new AppError(
      400,
      `${field} "${str}" is not a parseable timestamp (the calendar date exists, so the time-of-day or ` +
        `offset is out of range).`
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
  // Both ends of the PROMOTABLE band — see MAX_WALKTHROUGH_QUANTITY / MIN_WALKTHROUGH_QUANTITY. Checked
  // here so an unpromotable quantity is a 400 naming the row, not a 22003 after an estimator approved it
  // (the max) or a silent zero in the table (the min).
  if (quantity > MAX_WALKTHROUGH_QUANTITY) {
    throw new AppError(
      400,
      `${at}.quantity ${quantity} exceeds the largest quantity a promoted estimate can hold ` +
        `(${MAX_WALKTHROUGH_QUANTITY}). estimate_extractions.quantity is numeric(14,3) and would ` +
        `accept it, but promotion copies it into estimate_line_items.quantity, which is numeric(12,3) ` +
        `— so a value rounding to 10^9 or more would be priced and APPROVED here and only then fail ` +
        `promotion with a numeric overflow. Refused at ingress instead.`
    );
  }
  if (quantity < MIN_WALKTHROUGH_QUANTITY) {
    throw new AppError(
      400,
      `${at}.quantity ${quantity} is smaller than the smallest quantity these columns can represent ` +
        `(${MIN_WALKTHROUGH_QUANTITY}). Every quantity column in the chain has three decimal places, ` +
        `so Postgres would ROUND this and store it as 0.000, turning a quantity this contract requires ` +
        `to be greater than zero into exactly the zero it forbids.`
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

  // Bounded to varchar(50) — see MAX_WALKTHROUGH_UNIT_CHARS. This is the ONE field where the insert
  // target's width and the narrowest downstream width agree, so 50 is the answer whichever way it is
  // measured.
  const unit = optionalString(row.unit, `${at}.unit`);
  if (unit !== null && unit.length > MAX_WALKTHROUGH_UNIT_CHARS) {
    throw new AppError(
      400,
      `${at}.unit is ${unit.length} characters, over the ${MAX_WALKTHROUGH_UNIT_CHARS}-character ` +
        `limit. estimate_extractions.unit is varchar(${MAX_WALKTHROUGH_UNIT_CHARS}), so a longer value ` +
        `is a 22001 from the middle of the ingress transaction rather than the 400 naming the field ` +
        `that this endpoint promises. recommended_unit and estimate_line_items.unit are ` +
        `varchar(${MAX_WALKTHROUGH_UNIT_CHARS}) as well, so no narrower downstream column applies.`
    );
  }

  // Bounded to the SECTION NAME column, not to division_hint's own unbounded text — see
  // MAX_WALKTHROUGH_DIVISION_HINT_CHARS for the traced path from here to estimate_sections.name.
  const divisionHint = optionalString(row.divisionHint, `${at}.divisionHint`);
  if (divisionHint !== null && divisionHint.length > MAX_WALKTHROUGH_DIVISION_HINT_CHARS) {
    throw new AppError(
      400,
      `${at}.divisionHint is ${divisionHint.length} characters, over the ` +
        `${MAX_WALKTHROUGH_DIVISION_HINT_CHARS}-character limit. estimate_extractions.division_hint is ` +
        `unbounded text and would accept it, but promotion turns divisionHint into the estimate's ` +
        `SECTION NAME and estimate_sections.name is varchar(${MAX_WALKTHROUGH_DIVISION_HINT_CHARS}) — ` +
        `so a longer hint would be accepted here, approved by an estimator, and only then fail ` +
        `promotion at createSection with a 22001. Refused at ingress instead.`
    );
  }

  return {
    sourceScopeItemId: scopeItemId,
    rawLabel,
    trade,
    divisionHint,
    quantity,
    unit,
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
  // THE FILES SUBSYSTEM'S OWN CEILING, imported rather than restated.
  //
  // `contactSheetBytes` lands on `files.file_size_bytes` (bigint NOT NULL) — the same column every
  // ordinary upload goes through `validateFileSize` (files/service.ts:401) to reach. That function is
  // module-private, so the ceiling it enforces is reused instead: `MAX_FILE_SIZE_BYTES`
  // (files/file-constants.ts:7), the exported constant `validateFileSize` itself reads. Both limits
  // therefore move together — if the Files subsystem raises or lowers 200 MB, this seam follows without
  // anyone remembering it exists. A local `const MAX_CONTACT_SHEET_BYTES` would have been the bug this
  // check is meant to prevent, one abstraction up.
  //
  // Two failures were open without it. A walkthrough announcing a contact sheet larger than the CRM
  // accepts anywhere else got a `files` row the ordinary upload path would have refused with a 413; and
  // a nonsense value past signed-bigint range (Number.MAX_SAFE_INTEGER passes `Number.isInteger`) was a
  // 22003 from the FIRST write of the ingress transaction — a 500, in a validator that promises a 400
  // before anything is written. 413 rather than 400 to match `validateFileSize`'s own answer for the
  // same condition: one column, one limit, one status code.
  if (contactSheetBytes > MAX_FILE_SIZE_BYTES) {
    throw new AppError(
      413,
      `contactSheetBytes ${contactSheetBytes} exceeds the ${MAX_FILE_SIZE_BYTES}-byte limit the Files ` +
        `subsystem enforces on every other upload (MAX_FILE_SIZE_BYTES, files/file-constants.ts — the ` +
        `same ceiling validateFileSize applies). It lands on files.file_size_bytes, so a larger value ` +
        `would be a file the CRM refuses to accept by any other door, and a value past bigint range ` +
        `would be a numeric overflow on the first write of the ingress transaction.`
    );
  }

  // BUCKET, not just key. `buildFileDownloadUrlFromRecord` presigns against the CRM's configured
  // bucket and ignores `files.r2_bucket` (see getCrmFileBucket above), so recording a foreign bucket
  // produces a download link to an object that is not there — an estimator clicking the evidence gets
  // a 404 with nothing to explain it. A cross-bucket COPY is still out of scope for this seam — and note
  // that the older version of this comment said the seam "performs no object I/O at all", which stopped
  // being true when R23 added the HEAD verification and R25 the thumbnail render. What it does now is
  // READ from the CRM's own bucket (`getBucket()`, the only bucket `headObject`/`getObjectBuffer` reach);
  // it still cannot fetch from a foreign one. So the contact sheet has to be uploaded into the CRM's
  // bucket before it is announced, and a payload that says otherwise is refused loudly here.
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

  // R24. STRICTLY, on the calendar — a "parseable" timestamp is not the same as a real date. See
  // `requireCalendarTimestamp`: `2026-02-30T00:00:00Z` parses fine and silently becomes March 2 on
  // `files.taken_at`.
  const capturedAt = requireCalendarTimestamp(raw.capturedAt, "capturedAt");

  // Bounded because both of these are COMPOSED into varchar(500) columns on the `files` row — the very
  // first write of the ingress transaction — rather than merely stored in text. See
  // MAX_WALKTHROUGH_ID_CHARS / MAX_WALKTHROUGH_SITE_LABEL_CHARS, both derived from the builders that do
  // the composing.
  // CANONICALIZED BEFORE IT IS MEASURED, in that order and not the other. `toLowerCase()` can
  // LENGTHEN a string in Unicode (U+0130 lowercases to two code points), so a bound checked on the raw
  // value would not be a bound on the value actually written into files.system_filename.
  const walkthroughId = canonicalizeWalkthroughIngressId(
    requireNonEmptyString(raw.walkthroughId, "walkthroughId")
  );
  if (walkthroughId.length > MAX_WALKTHROUGH_ID_CHARS) {
    throw new AppError(
      400,
      `walkthroughId is ${walkthroughId.length} characters, over the ${MAX_WALKTHROUGH_ID_CHARS}-` +
        `character limit. It is composed into files.system_filename, a varchar(` +
        `${FILES_NAME_COLUMN_CHARS}), so a longer id is a 22001 on the first write of the ingress ` +
        `transaction rather than the 400 naming the field that this endpoint promises.`
    );
  }

  const siteLabel = requireNonEmptyString(raw.siteLabel, "siteLabel");
  if (siteLabel.length > MAX_WALKTHROUGH_SITE_LABEL_CHARS) {
    throw new AppError(
      400,
      `siteLabel is ${siteLabel.length} characters, over the ${MAX_WALKTHROUGH_SITE_LABEL_CHARS}-` +
        `character limit. It is composed into files.display_name, a varchar(` +
        `${FILES_NAME_COLUMN_CHARS}), alongside a fixed prefix — so a longer label is a 22001 on the ` +
        `first write of the ingress transaction rather than the 400 naming the field that this ` +
        `endpoint promises.`
    );
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
    // Canonicalized above, before its length was measured.
    walkthroughId,
    // Canonical, and a real UUID. See `canonicalizeWalkthroughIngressId`: this value is interpolated
    // into the advisory-lock key and the derived r2 key (case-SENSITIVE string building) while also
    // being compared as a `uuid` (case-INSENSITIVE), and the disagreement between those two defeated
    // both the lock and the unique index.
    dealId: requireUuid(raw.dealId, "dealId"),
    // Optional, never blank, canonical, and a real UUID: it lands on (and is compared against) a uuid
    // column, where "" and "proj-1" are both a 22P02 rather than a null or a miss — and it is a segment
    // of the derived r2 key, so it carries the same case-divergence hazard as `dealId`.
    projectId: optionalUuid(raw.projectId, "projectId"),
    // NO contactSheetR2Key. Whatever the body carried under that name is dropped on the floor here —
    // the key is derived from `walkthroughId` in `ingestWalkthrough`. See
    // `deriveWalkthroughContactSheetR2Key` for why accepting one is a read primitive rather than a
    // convenience. Returning the canonical shape (rather than spreading `raw`) is what makes that
    // dropping structural: an unknown wire field cannot reach a column by accident.
    contactSheetBucket,
    contactSheetBytes,
    contactSheetMimeType: contactSheetMimeType as ContactSheetMimeType,
    siteLabel,
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
  contactSheetStore,
}: {
  tenantDb: TenantDb;
  payload: WalkthroughIngressPayload;
  /** R23/R25. Object storage, injected — see `WalkthroughContactSheetStore` for why it is a required
   *  port rather than an import or an optional dependency. */
  contactSheetStore: WalkthroughContactSheetStore;
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

    // PROJECT AUTHORIZATION, and it belongs HERE rather than in the validator because it is a database
    // question, not a shape question.
    //
    // `estimate_source_documents.project_id` and `estimate_extractions.project_id` carry NO foreign key
    // (see the schema — both are bare `uuid`), so a syntactically valid projectId that does not exist,
    // or that belongs to a DIFFERENT deal, was accepted and written. The route authorizes the DEAL
    // (`getDealById`, deals/routes.ts) and nothing authorized the project, so the payload could aim a
    // walkthrough's rows at another deal's project id while remaining perfectly well-formed.
    //
    // WHY IT MATTERS MORE THAN A STRAY COLUMN VALUE: `projectId` PARTICIPATES IN IDEMPOTENCY. The
    // lookup below keys on (dealId, projectId, contentHash, documentType), so a wrong project is not a
    // typo that can be fixed by re-posting — the corrected post is a different key, misses the stored
    // document, and builds a SECOND complete chain. Meanwhile the workbench loads extractions by DEAL
    // alone (workbench-service.ts), so the estimator sees both copies of every utterance with nothing
    // to distinguish them. One bad field, two chains, and no way back without a human deleting rows.
    //
    // MIRRORS THE ROUTE'S OWN DEAL PATTERN: `getDealById` resolves the deal and a miss is a 404 "Deal
    // not found". A project that does not exist gets the same shape (404 naming it); a project that
    // exists but belongs elsewhere is a 400, because the request is not asking for something absent —
    // it is asking for something it may not have, and the distinction is worth keeping in the status
    // code. Neither leaks anything: the caller already knows the id it sent.
    //
    // `projects.source_deal_id` IS the deal association (projects.ts:20, a real FK to deals.id), and it
    // is compared with `===` against `payload.dealId` — sound only because both are canonical lowercase:
    // Postgres renders a `uuid` column lowercase, and the validator canonicalizes the payload id. See
    // `canonicalizeWalkthroughIngressId`.
    //
    // `FOR SHARE` — A ROW LOCK, and an earlier revision of this comment claimed the transaction alone
    // was enough. It is not, and that claim was the more dangerous half of the bug: it told the next
    // reader a hazard was handled.
    //
    // THE RACE. `upsertProjectMirror` (projects/service.ts:393-412) RE-PARENTS an existing project on
    // every Procore sync — `ON CONFLICT (procore_project_id) DO UPDATE SET source_deal_id =
    // COALESCE(EXCLUDED.source_deal_id, …)`. Without a row lock, a plain SELECT reads the OLD owning
    // deal, that UPDATE commits, and this transaction then writes documents and extractions against a
    // project that now belongs to somebody else. Nothing else stops it: the advisory lock above is keyed
    // on (dealId, walkthroughId) and binds only other walkthrough ingresses — the projects table is not
    // in its key space at all — and neither `estimate_source_documents.project_id` nor
    // `estimate_extractions.project_id` carries an FK that would notice.
    //
    // WHY `FOR SHARE` AND NOT `FOR KEY SHARE`. VERIFIED rather than reasoned from the mode names, on
    // real Postgres 16.14 with two genuinely concurrent connections: session A holds the lock, session B
    // runs the re-parent UPDATE with `lock_timeout`, and the question is whether B blocks.
    //   • no lock clause  → UPDATE proceeds immediately. The race, reproduced.
    //   • `FOR KEY SHARE` → UPDATE proceeds immediately. `source_deal_id` is a NON-KEY column, and
    //     permitting exactly that update is what KEY SHARE is FOR. It reads like a lock and isn't one
    //     here.
    //   • `FOR SHARE`     → UPDATE blocks (55P03 on lock_timeout, row unchanged). What we need.
    //   • `FOR UPDATE`    → blocks too, but it is stronger than the property requires: it would also
    //     block another walkthrough ingress that merely READS the same project, serializing two
    //     unrelated deals' work. `FOR SHARE` lockers do not conflict with each other.
    // The lock is held until this transaction ends, so the ownership answer is still true at the moment
    // the writes below depend on it.
    if (payload.projectId !== null) {
      const [project] = await tx
        .select({ sourceDealId: projects.sourceDealId })
        .from(projects)
        .where(eq(projects.id, payload.projectId))
        .limit(1)
        .for("share");

      if (!project) {
        throw new AppError(
          404,
          `Project ${payload.projectId} does not exist. estimate_source_documents.project_id carries no ` +
            `foreign key, so an unknown project would have been written rather than refused — and ` +
            `because projectId is part of this walkthrough's idempotency key, correcting it later would ` +
            `build a second chain instead of amending this one.`
        );
      }

      if (project.sourceDealId !== payload.dealId) {
        throw new AppError(
          400,
          `Project ${payload.projectId} belongs to deal ${project.sourceDealId ?? "no deal"}, not to ` +
            `deal ${payload.dealId}. The route authorizes the DEAL; the project has to be one of that ` +
            `deal's own or the walkthrough's rows would be filed under a project the caller was never ` +
            `authorized for. Post it against the owning deal, or omit projectId for a deal-level ` +
            `walkthrough.`
        );
      }
    }

    // IDEMPOTENCY. A lost response is indistinguishable from a lost request, so trock-scope retries —
    // and a retry must not double the deal's estimating rows. `contentHash` carries the NAMESPACED
    // walkthrough id, so (dealId, projectId, contentHash) identifies THIS walkthrough on THIS deal: the
    // same triple document-service.ts:104-130 dedupes parsed uploads against. Found means the first call
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
          // NAMESPACED, and it has to be the SAME spelling the writer stored — this comparison IS the
          // idempotency key, so an unprefixed read against a prefixed write would miss every retry and
          // build a second chain. See `walkthroughContentHash` for why the prefix exists (the collision
          // runs both ways, and `createEstimateSourceDocument` has no documentType predicate to protect
          // ITS side).
          eq(estimateSourceDocuments.contentHash, walkthroughContentHash(payload.walkthroughId)),
          // DOCUMENT TYPE, not just the hash — kept even though the prefix now makes the two namespaces
          // disjoint, because it is what protects THIS side of the collision and it is free. `contentHash`
          // means different things to different producers: an ordinary upload stores the file's R2 KEY
          // there (routes.ts, the createEstimateSourceDocument call passes `contentHash:
          // uploadedFile.r2Key`), while a walkthrough stores its namespaced export id. Without this
          // predicate a walkthrough hash that happened to equal some existing document's content hash on
          // the same deal would make this lookup "find" that FOREIGN document and replay it — handing
          // trock-scope a 200, a plan set's document id, and whatever extraction ids that document owns,
          // while the walkthrough's own scope was never written at all.
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

      // R21. THE ENVELOPE, checked BEFORE the rows. A submission that announces a different contact
      // sheet is not describing this document's artifact at all, so there is no point reconciling its
      // rows against it — and the field most likely to have changed (the mime type) is the one that
      // re-derives the R2 key, which is what makes the old response actively misleading. See
      // `detectWalkthroughEnvelopeDrift`.
      //
      // Read from the `files` row rather than from `estimate_source_documents`, because the file row is
      // the artifact record: it carries the mime type, the byte count, the capture instant and the
      // derived key as separate columns, where the document's `filename` mashes the site label and the
      // timestamp into one string that cannot name which of them moved.
      const [storedSheet] = await tx
        .select({
          mimeType: files.mimeType,
          fileSizeBytes: files.fileSizeBytes,
          takenAt: files.takenAt,
          displayName: files.displayName,
          r2Key: files.r2Key,
        })
        .from(files)
        .where(eq(files.id, existing.fileId));

      // `estimate_source_documents.file_id` is NOT NULL with an FK to `files`, so this row exists. The
      // guard is here so a hypothetical absence degrades to "cannot compare" rather than to a TypeError
      // in the middle of a replay.
      if (storedSheet) {
        const envelopeDrift = detectWalkthroughEnvelopeDrift(storedSheet, payload);
        if (envelopeDrift.length > 0) {
          // Same 409 and the same reasoning as the row-level drift below: a retry replays what was
          // stored and never rewrites it, so a submission describing a different artifact is a
          // correction wearing a retry's clothes.
          throw new AppError(
            409,
            `Walkthrough ${payload.walkthroughId} was already ingested on this deal as document ` +
              `${existing.id}, and this submission describes a different contact sheet: ` +
              `${envelopeDrift.join("; ")}. A retry replays what was stored and never rewrites it, so ` +
              `this submission is not a retry — it is a correction, and returning the stored chain ` +
              `would report success while leaving this deal pointing at the superseded artifact. ` +
              `Re-export under a new walkthrough id, or land the correction through the export ledger.`
          );
        }
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

    // R23. THE OBJECT HAS TO ACTUALLY BE THERE, verified before the first write.
    //
    // The contract with trock-scope is that the sender uploads the contact sheet to the derived key
    // BEFORE it posts — and until now nothing checked. A pre-upload that failed, is still in flight, or
    // stored a different Content-Type or Content-Length than the payload declares produced a complete
    // chain and a 201, and because retries REPLAY that chain there was no later attempt that fixed it.
    // The estimator opens the evidence and gets a 404 with nothing to explain it.
    //
    // The same three checks `confirmUpload` (files/service.ts:773-785) makes, in the same order, with the
    // same 400: one condition, one status code. The two `!= null` guards are its guards too — R2 may not
    // report either header, and an absent header is not a mismatch.
    //
    // INSIDE the transaction, which is a real cost stated plainly: the advisory lock and a database
    // connection are held across a HEAD round-trip and a bounded thumbnail render. It buys the ordering
    // that matters — verification happens after the idempotency lookup has established this is a FRESH
    // ingest, so a RETRY still replays without needing the object to still exist, and it happens before
    // the first write, so a failed verification writes nothing. Verifying before the transaction would
    // either re-verify on every retry or move the check to where the answer can go stale.
    if (contactSheetStore.isConfigured()) {
      const head = await contactSheetStore.head(contactSheetR2Key);
      if (!head) {
        throw new AppError(
          400,
          `Contact sheet for walkthrough ${payload.walkthroughId} is not in object storage at its ` +
            `derived key "${contactSheetR2Key}". The key is derived from (dealId, projectId, ` +
            `walkthroughId, contactSheetMimeType) and both sides of this contract compute it, so upload ` +
            `the contact sheet to exactly that key and re-post. Nothing was written.`
        );
      }
      if (head.contentType != null && head.contentType !== payload.contactSheetMimeType) {
        throw new AppError(
          400,
          `Contact sheet at "${contactSheetR2Key}" has Content-Type "${head.contentType}", but this ` +
            `walkthrough declares contactSheetMimeType "${payload.contactSheetMimeType}". The mime type ` +
            `also decides the key's extension, so a disagreement here means the object at this key is ` +
            `not the artifact being announced. Nothing was written.`
        );
      }
      if (head.contentLength != null && head.contentLength !== payload.contactSheetBytes) {
        throw new AppError(
          400,
          `Contact sheet at "${contactSheetR2Key}" has Content-Length ${head.contentLength}, but this ` +
            `walkthrough declares contactSheetBytes ${payload.contactSheetBytes}. ` +
            `files.file_size_bytes is what every download and quota reads, so the two have to agree. ` +
            `Nothing was written.`
        );
      }
    }

    // R25. The list thumbnail, produced by the Files subsystem's OWN helpers rather than by a second
    // derived key the sender would have to upload.
    //
    // A FALLBACK CHAIN, not a branch on the mime type: each helper self-gates
    // (`isThumbnailableImage` / `isPdfThumbnailable`) and returns null when the type is not its own, so
    // this composition does not have to be kept in sync with WALKTHROUGH_CONTACT_SHEET_MIME_TYPES.
    // Exactly what `confirmUpload` (files/service.ts:801-804) does.
    //
    // BEST-EFFORT, matching that same posture: both helpers are time-bounded and neither throws, so a
    // slow or undecodable sheet yields null and the list falls back to today's behaviour instead of
    // failing an ingest over a tile. The object was just verified present, so the fetch has something to
    // read.
    let thumbnailR2Key = await contactSheetStore.generateImageThumbnail(
      contactSheetR2Key,
      payload.contactSheetMimeType
    );
    if (thumbnailR2Key === null) {
      thumbnailR2Key = await contactSheetStore.generatePdfThumbnail(
        contactSheetR2Key,
        payload.contactSheetMimeType
      );
    }

    const fileId = await createWalkthroughContactSheetFile({
      tenantDb: tx,
      input: {
        dealId: payload.dealId,
        walkthroughId: payload.walkthroughId,
        siteLabel: payload.siteLabel,
        r2Key: contactSheetR2Key,
        thumbnailR2Key,
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
