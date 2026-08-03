// Glasses-walkthrough ingress: the OUTBOUND half of the walkthrough seam.
//
// An estimator wearing Meta Ray-Ban glasses walks a job site; the mobile app records audio/video and
// stills and uploads them here. Two things must both happen, and neither may block the other:
//   1. land the artifacts in the deal's project folder (a `files` row per artifact) — this module.
//   2. forward the artifacts to TROCK Scope, which extracts a scope of work from them and, later,
//      posts scope rows BACK through `walkthrough-ingress-service.ts` (the return path, already built).
//
// This module owns (1) only. Forwarding (2) is a SEPARATE, independently-retried concern: it is handed
// off to the job queue (`glasses_walkthrough_forward`, worker/src/jobs/glasses-walkthrough-forward.ts)
// so that TROCK Scope being unreachable can never fail — or even slow down — the crew's copy landing in
// the project folder. See `ingestGlassesWalkthrough` below for how the two are decoupled.
//
// Conventions are lifted from the return path (`walkthrough-ingress-service.ts`) and from the generic
// Files upload flow (`files/service.ts`: `requestUploadUrl` + `confirmUpload`) wherever they apply:
//   - artifacts are NOT posted as request bodies. The mobile app presigns an upload (this module derives
//     the R2 key server-side, exactly as the contact-sheet path does), PUTs bytes directly to R2, then
//     calls the completion endpoint below. Nothing in this codebase proxies large binary uploads through
//     the API process — see MAX_GLASSES_WALKTHROUGH_ARTIFACT_BYTES for why that matters here especially
//     (video/audio clips, not a single photo).
//   - idempotency reuses `files.client_upload_id` (migration 0170) rather than inventing a parallel
//     mechanism: it is already exactly "an idempotency key the mobile client sends per artifact",
//     already has a partial unique index, and `field/routes.ts`'s `parseOptionalClientUploadId` already
//     establishes the validation rule this module mirrors (non-empty string, at most 64 characters — the
//     column width). What this producer does NOT do is store the client's key verbatim, unlike field
//     photos and scorecard edit evidence: those mint a fresh UUID per artifact, whereas this client
//     derives its keys from (walkId, kind) and reuses them across deals by design. See
//     `deriveGlassesWalkthroughClientUploadId` for what that costs and why the stored id is deal-scoped.
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { files, jobQueue, photoAuditLog } from "@trock-crm/shared/schema";
import { DOMAIN_EVENTS, type FileCategory } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export type GlassesWalkthroughArtifactKind = "video" | "audio" | "photo";

/**
 * The job type `ingestGlassesWalkthrough` enqueues onto `job_queue` and the worker registers a handler
 * for (worker/src/jobs/glasses-walkthrough-forward.ts). Exported so both sides — and this module's own
 * idempotent-enqueue lookup — agree on one spelling.
 */
export const GLASSES_WALKTHROUGH_FORWARD_JOB = "glasses_walkthrough_forward";

/** The `files.folder_path` / `files.tags` convention every glasses-walkthrough artifact lands under, so
 *  the project folder groups them predictably without a Files-module schema change. */
export const GLASSES_WALKTHROUGH_FOLDER_PATH = "Glasses Walkthroughs";
export const GLASSES_WALKTHROUGH_SUBCATEGORY = "glasses-walkthrough";
export const GLASSES_WALKTHROUGH_TAG = "glasses-walkthrough";

/**
 * The media this ingress accepts, deliberately kept IN LOCKSTEP with TROCK Scope's own
 * `server/src/ingest/media-types.ts` (`BY_CONTENT_TYPE`). Accepting something TROCK Scope would 415 on
 * forward is a walk that files cleanly here and then silently fails to forward every retry — so the
 * allowlist is copied from that file's set of declared-Content-Type entries (not its filename-sniffing
 * fallback, which trockcrm has no equivalent need for: the mobile app declares its own Content-Type).
 */
interface AcceptedGlassesWalkthroughMedia {
  kind: GlassesWalkthroughArtifactKind;
  extension: string;
}

export const GLASSES_WALKTHROUGH_ACCEPTED_MEDIA: Readonly<Record<string, AcceptedGlassesWalkthroughMedia>> = {
  "video/quicktime": { kind: "video", extension: "mov" },
  "video/mp4": { kind: "video", extension: "mp4" },
  "video/x-m4v": { kind: "video", extension: "m4v" },
  "video/webm": { kind: "video", extension: "webm" },
  "audio/mp4": { kind: "audio", extension: "m4a" },
  "audio/x-m4a": { kind: "audio", extension: "m4a" },
  "audio/mpeg": { kind: "audio", extension: "mp3" },
  "audio/wav": { kind: "audio", extension: "wav" },
  "audio/x-wav": { kind: "audio", extension: "wav" },
  "audio/aac": { kind: "audio", extension: "aac" },
  "image/jpeg": { kind: "photo", extension: "jpg" },
  "image/png": { kind: "photo", extension: "png" },
  "image/heic": { kind: "photo", extension: "heic" },
};

/**
 * A generous per-artifact sanity ceiling, not a load-bearing product limit. TROCK Scope's own multipart
 * plan tops out at 10,000 * 32MiB (~320GB, storage/multipart.ts), so this is trockcrm's own concern —
 * keeping one glasses-walk clip from being an unbounded R2/egress bill. Tune freely; nothing downstream
 * assumes this exact value.
 */
export const MAX_GLASSES_WALKTHROUGH_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/**
 * The ceiling on the key the CLIENT sends. It matches `files.client_upload_id`'s `varchar(64)` (migration
 * 0170) and mobile's own `MAX_IDEMPOTENCY_KEY_LENGTH`, but since the stored id is now a fixed-width digest
 * (`deriveGlassesWalkthroughClientUploadId`) the column is no longer what enforces it — these are. The raw
 * key still reaches `system_filename` (varchar(500)) and `r2_key` (varchar(1000)) verbatim, and an
 * agreed-in-both-directions bound is worth more than the few bytes relaxing it would buy.
 */
export const MAX_GLASSES_WALKTHROUGH_IDEMPOTENCY_KEY_CHARS = 64;

/**
 * The ECMAScript maximum time value (±8.64e15 ms, ~±273,790 years around the epoch). `new Date` of
 * anything beyond it is an Invalid Date, which is why `capturedAtMs` needs a ceiling and not just a
 * finite/non-negative check — see where it is validated for what an Invalid Date does to `files.takenAt`.
 */
export const MAX_GLASSES_WALKTHROUGH_CAPTURED_AT_MS = 8_640_000_000_000_000;
export const MAX_GLASSES_WALKTHROUGH_ARTIFACTS_PER_WALK = 200;

/**
 * How many artifact HEADs may be in flight at once, and how long the whole verification phase may run.
 *
 * Both exist for one reason: `tenantMiddleware` (server/src/middleware/tenant.ts) checks a connection out
 * of the 20-slot pool (`DEFAULT_POOL_MAX`, db.ts) and opens a transaction on it BEFORE any route handler —
 * including this one — is entered. So every millisecond spent waiting on object storage here is a pooled
 * connection held open by a request doing no database work at all. Verifying a 200-artifact walk one
 * blocking round trip at a time is 200 serial RTTs of exactly that, and a black-holed HEAD is unbounded:
 * the S3 client is constructed with no `requestTimeout` (server/src/lib/r2-client.ts), so nothing else in
 * the stack ends the wait. `SET LOCAL statement_timeout` bounds QUERIES, never the gaps between them.
 *
 * The phase deadline is deliberately whole-phase, not per-HEAD: a per-request timeout still multiplies by
 * the batch count and so bounds nothing that matters. Blowing the deadline is a 503 (retryable) for the
 * same R33 reason a HEAD throw is — "we could not check" is never "the object is absent".
 */
export const GLASSES_WALKTHROUGH_VERIFY_CONCURRENCY = 8;
export const GLASSES_WALKTHROUGH_VERIFY_TIMEOUT_MS = 20_000;

/**
 * How long a presigned PUT for one artifact stays usable — five minutes, against the shared
 * `PRESIGNED_URL_EXPIRY_SECONDS` default of thirty.
 *
 * This is not a tuning knob. It is the ONLY dimension of the already-filed refusal in
 * `requestGlassesWalkthroughArtifactUploadUrl` that the server still controls after the response is sent.
 * That refusal is a `files` lookup at MINT time, and a mint-time check binds nothing that outlives the
 * mint: a client may legitimately presign artifact A, upload it, complete the walk — freezing A's row, its
 * declared size, the HEAD that was checked against it and the scope TROCK Scope extracted from it — and
 * then PUT to the URL it was correctly given beforehand. The bytes change; nothing on the row does. No
 * database rule can revoke a signature, so the exposure is exactly however long the signature lives.
 *
 * It cannot be driven to zero without paying somewhere else, and every "somewhere else" is worse:
 *   - a per-presign nonce in the key does not help. Stale mints would address dead keys, but the LAST mint
 *     is by construction the one the completion verifies and files, and its URL is the live one. It also
 *     costs the retry story — the key would have to be recorded and looked up rather than re-derived, and
 *     `deriveGlassesWalkthroughArtifactR2Key`'s determinism is what makes a dropped upload retryable at
 *     all.
 *   - moving the object after completion closes it, and costs a full byte copy of every artifact (up to
 *     2 GiB each, 200 per walk). Done inline it violates this module's own phase rule — the write phase
 *     holds a pinned pool connection and must contain no object-storage await (see
 *     GLASSES_WALKTHROUGH_VERIFY_CONCURRENCY). Done from the queue it does not close anything, it merely
 *     renames the window to "queue latency", which is unbounded and strictly worse than a fixed five
 *     minutes.
 *   - a conditional PUT (`If-None-Match: *`) is the one mechanism that would close it at the storage
 *     layer, and R2 does support it. But a condition on a presigned URL is a SIGNED HEADER, so the client
 *     must send it or every upload fails SignatureDoesNotMatch — the identical trap `Content-Length`
 *     already sprang on this seam (glasses-walkthrough-store.ts). It needs a mobile change to be safe, and
 *     it would ALSO break the dropped-upload retry unless presign first deleted the stale object, since a
 *     PUT whose 200 the client never saw leaves bytes that the retry must be allowed to overwrite.
 *
 * Five minutes rather than five seconds because the failure mode of too-short is real: an expired URL is a
 * 403 the client reads as a failed PUT, which burns one of `MAX_WALK_UPLOAD_ATTEMPTS` (5). The margin
 * covers clock skew between this host and R2's validators plus an app suspended between the presign
 * response and the PUT. It does not need to cover the upload itself — R2 authenticates the PUT when the
 * request arrives, not when its body ends, which is also why the 30-minute default was never covering a
 * 2 GiB transfer either. And the client asks for a URL on the line immediately before it uses it
 * (`putArtifactBytes`, mobile/src/walkthrough/upload.ts), never persisting it across a drain, so the happy
 * path needs milliseconds of this.
 *
 * RESIDUAL, stated plainly so nobody reads this as closed: for up to five minutes after a presign, a
 * caller holding that URL can still replace the bytes behind a `files` row the completion has since
 * frozen. Narrowed 6x, not eliminated.
 */
export const GLASSES_WALKTHROUGH_PRESIGN_EXPIRY_SECONDS = 300;
const MAX_TITLE_CHARS = 300;
const MAX_SITE_LABEL_CHARS = 300;
const MAX_FILENAME_CHARS = 500; // files.original_filename / files.display_name are varchar(500)
const MAX_WALK_ID_CHARS = 100;

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The object-storage port this module verifies pre-uploaded artifacts through and presigns uploads via.
 * Mirrors `WalkthroughContactSheetStore` (walkthrough-ingress-service.ts) — see that interface's
 * comments for the full R33 (null-vs-throw) reasoning, restated briefly on `head` below. Injected rather
 * than imported so this stays a pure-database module and tests can fake it.
 */
export interface GlassesWalkthroughArtifactStore {
  /** `isR2Configured()`. With no object store configured (local dev, CI) verification is skipped,
   *  mirroring `confirmUpload`'s own gate — same posture as the rest of the CRM. */
  isConfigured: () => boolean;
  /** `headObjectStrict(r2Key)`. `null` = genuinely absent (400, sender must upload first). A THROW means
   *  we could not check (network/auth/outage) and must not be read as "absent" — callers map it to a
   *  retryable 503, never a 400. */
  head: (r2Key: string) => Promise<{ contentType?: string; contentLength?: number } | null>;
  /**
   * `generateUploadUrl(r2Key, mimeType, fileSizeBytes, expiresInSeconds)`.
   *
   * `expiresInSeconds` is passed DOWN rather than left to the adapter on purpose: the lifetime of this
   * capability is a record-integrity rule (see GLASSES_WALKTHROUGH_PRESIGN_EXPIRY_SECONDS), and a rule
   * that lives in the production wiring is a rule the service cannot state, cannot test and cannot
   * enforce. The caller checks the answer, because this seam already has one argument the adapter
   * deliberately ignores (`fileSizeBytes`) and a second silently-ignored one would be indistinguishable
   * from a working ceiling.
   */
  presignUpload: (
    r2Key: string,
    mimeType: string,
    fileSizeBytes: number,
    expiresInSeconds: number
  ) => Promise<{ uploadUrl: string; expiresIn: number }>;
}

/**
 * The bucket every CRM download/upload is presigned against. Resolved the same way the other modules
 * that stamp `files.r2_bucket` resolve it (see `getCrmFileBucket` in walkthrough-ingress-service.ts for
 * the fuller rationale) — read directly here rather than imported from that module, so this module does
 * not take a dependency on the (unrelated) estimating-extraction seam for one env lookup.
 */
export function getGlassesWalkthroughFileBucket(): string {
  return process.env.R2_BUCKET_NAME || "trock-crm-files";
}

function assertNonEmptyString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(400, `${field} is required.`);
  }
  if (value.length > maxChars) {
    throw new AppError(400, `${field} must be at most ${maxChars} characters.`);
  }
  return value;
}

function assertOptionalString(value: unknown, field: string, maxChars: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new AppError(400, `${field} must be a string.`);
  }
  if (value.length > maxChars) {
    throw new AppError(400, `${field} must be at most ${maxChars} characters.`);
  }
  return value;
}

function assertIdempotencyKey(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(400, `${field} is required.`);
  }
  if (value.length > MAX_GLASSES_WALKTHROUGH_IDEMPOTENCY_KEY_CHARS) {
    throw new AppError(400, `${field} must be at most ${MAX_GLASSES_WALKTHROUGH_IDEMPOTENCY_KEY_CHARS} characters.`);
  }
  return value;
}

function assertPositiveInteger(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new AppError(400, `${field} must be a positive integer.`);
  }
  if (value > max) {
    throw new AppError(400, `${field} exceeds the maximum of ${max} bytes.`);
  }
  return value;
}

function resolveMedia(mimeType: unknown, kind: unknown, field: string): AcceptedGlassesWalkthroughMedia {
  if (typeof mimeType !== "string") {
    throw new AppError(400, `${field}.mimeType is required.`);
  }
  const media = GLASSES_WALKTHROUGH_ACCEPTED_MEDIA[mimeType.toLowerCase()];
  if (!media) {
    throw new AppError(400, `${field}.mimeType "${mimeType}" is not an accepted glasses-walkthrough media type.`);
  }
  if (kind !== undefined && kind !== media.kind) {
    throw new AppError(
      400,
      `${field}.kind "${String(kind)}" does not match mimeType "${mimeType}" (expected "${media.kind}").`
    );
  }
  return media;
}

/**
 * Deterministic R2 key for one artifact: a FUNCTION of (officeSlug, dealId, walkId, idempotencyKey,
 * extension), never a caller-supplied string — same confused-deputy reasoning as
 * `deriveWalkthroughContactSheetR2Key` (walkthrough-ingress-service.ts). Determinism is also what makes
 * a retried upload-url request idempotent: the same artifact always presigns the same destination, so a
 * retry after a lost response overwrites its own not-yet-confirmed object rather than orphaning a first
 * attempt at a different key.
 *
 * ALL FOUR variable components are percent-encoded, not just the two that arrive from the client body.
 * officeSlug and dealId are server-supplied today (`req.officeSlug`, `req.params.id`), so encoding them is
 * defence in depth rather than a live escape — but a derivation that escapes some components and not
 * others is a trap for the next caller, who cannot tell from the signature which half they are in, and
 * `/` in an unescaped component silently reshapes the key's directory structure. Safe to add after the
 * fact because encodeURIComponent is the identity function over slugs and UUIDs: no key this has ever
 * produced moves, so nothing already in R2 is orphaned.
 */
export function deriveGlassesWalkthroughArtifactR2Key(
  officeSlug: string,
  dealId: string,
  walkId: string,
  idempotencyKey: string,
  extension: string
): string {
  const safeOfficeSlug = encodeURIComponent(officeSlug);
  const safeDealId = encodeURIComponent(dealId);
  const safeWalkId = encodeURIComponent(walkId);
  const safeIdempotencyKey = encodeURIComponent(idempotencyKey);
  return `${safeOfficeSlug}/deals/${safeDealId}/glasses-walkthroughs/${safeWalkId}/${safeIdempotencyKey}.${extension}`;
}

/**
 * What actually goes into `files.client_upload_id` for one artifact: a DEAL-SCOPED digest of the client's
 * key, never the key itself.
 *
 * Mobile derives every artifact key from (walkId, kind[, photoIndex]) and nothing else
 * (`walkArtifactIdempotencyKey`, mobile/src/walkthrough/upload-core.ts), while that column's unique index
 * is TENANT-wide (migration 0170). Those two facts collide on exactly the flows that re-file ONE physical
 * walk under a DIFFERENT deal, both of which are supported: a mis-tagged walk corrected to the right job,
 * and a recovered orphan walk whose deal a human supplies at recovery time (`toRecoveredQueuedWalk` —
 * nothing on disk records the deal, so the first answer can be the wrong one). Stored raw, the second
 * deal's insert loses the conflict, the re-select then finds the FIRST deal's row, and the completion
 * 409s on every retry forever: the evidence is stranded on the wrong job with no way to move it.
 *
 * Digested rather than concatenated because the column is varchar(64) and a dealId (36) + separator + a
 * key (up to 64) does not fit. Truncating a composite to fit would be worse than not scoping at all:
 * mobile's keys differ only in their SUFFIX (`<walkId>:photo:11` vs `<walkId>:photo:12`), so a
 * length-truncated pair silently merges two stills of the same walk into one row and drops one — a
 * missing frame nothing reports, in the one artifact class a human might never count.
 *
 * Nothing is lost to debugging. The raw key stays on the row twice over — `system_filename`
 * (`glasses-walk-<key>.<ext>`) and `r2_key` — and `tags` carries the walkId, so "which artifact is this,
 * and which walk" is still answerable from the row alone. The one column that has to be UNIQUE is simply
 * not the one to answer it from.
 *
 * The client's key is never replaced in the API contract: the completion response echoes what the client
 * sent (`GlassesWalkthroughFileResult.idempotencyKey`), because mobile retires its upload-queue entries by
 * matching on the key it generated — returning the stored form would leave every artifact unacknowledged
 * and re-upload the whole walk on the next drain.
 */
export function deriveGlassesWalkthroughClientUploadId(dealId: string, idempotencyKey: string): string {
  // NUL-separated, not hyphen/colon-separated: both components are free-form client-or-caller text, and any
  // separator that CAN appear inside them makes the pair re-cuttable — ("deal-a", "b:key") and ("deal",
  // "a-b:key") would digest identically, which is the very cross-deal aliasing this function exists to
  // remove. NUL is the one byte neither can contain (Postgres rejects it in `text`/`varchar` outright).
  const digest = createHash("sha256").update(`${dealId}\u0000${idempotencyKey}`).digest("hex");
  // 3 + 61 = 64, the column exactly. The `gw_` prefix also puts these values in a shape no other producer
  // emits (field photos and scorecard evidence send bare UUIDs), so a cross-producer collision is ruled out
  // by construction rather than by probability; 244 retained bits rule out the within-producer one.
  return `gw_${digest.slice(0, 61)}`;
}

// ── Endpoint A: request a presigned upload URL for one artifact ────────────────────────────────────

export interface GlassesWalkthroughArtifactUploadUrlInput {
  dealId: string;
  walkId: string;
  idempotencyKey: string;
  kind: GlassesWalkthroughArtifactKind;
  mimeType: string;
  fileSizeBytes: number;
}

export function validateGlassesWalkthroughArtifactUploadUrlInput(
  raw: Record<string, unknown>
): GlassesWalkthroughArtifactUploadUrlInput {
  const dealId = assertNonEmptyString(raw.dealId, "dealId", 100);
  const walkId = assertNonEmptyString(raw.walkId, "walkId", MAX_WALK_ID_CHARS);
  const idempotencyKey = assertIdempotencyKey(raw.idempotencyKey, "idempotencyKey");
  const fileSizeBytes = assertPositiveInteger(raw.fileSizeBytes, "fileSizeBytes", MAX_GLASSES_WALKTHROUGH_ARTIFACT_BYTES);
  const media = resolveMedia(raw.mimeType, raw.kind, "artifact");

  return {
    dealId,
    walkId,
    idempotencyKey,
    kind: media.kind,
    mimeType: (raw.mimeType as string).toLowerCase(),
    fileSizeBytes,
  };
}

export interface GlassesWalkthroughArtifactUploadUrlResult {
  uploadUrl: string;
  r2Key: string;
  expiresIn: number;
}

/**
 * Deal access is the CALLER'S job (the route asserts it via `getDealById` before this runs — see
 * `deals/routes.ts`), same division of responsibility as every other route in this file.
 *
 * REFUSES, rather than presigning, once the artifact is filed — see the guard below for why that is a
 * record-integrity rule and not an idempotency preference. It is a 409 with a stable `code` rather than a
 * 200 carrying an `alreadyFiled` flag because a success shape whose `uploadUrl` is absent is read as
 * `undefined` by every existing caller (mobile destructures it directly — `const { uploadUrl } = await
 * client.requestUploadUrl(...)`, mobile/src/walkthrough/upload.ts) and by every future one, which turns a
 * deliberate refusal into a type error at the PUT. The client already parses `error.code` into
 * `ApiError.code` (mobile/src/api/client.ts), so the refusal is machine-readable TODAY: mapping this code
 * to "treat the artifact as already PUT and proceed to the completion call" is a one-line change in
 * `putArtifactBytes`, and the completion is idempotent, so that lands the walk correctly. Until that lands,
 * an artifact in this state burns its five PUT attempts and the walk reads as failed on the phone — for a
 * walk the server already holds in full. That is a UI regression in a rare recovery path; the alternative
 * is letting anyone who can reach the deal rewrite filed evidence.
 */
export async function requestGlassesWalkthroughArtifactUploadUrl(args: {
  tenantDb: TenantDb;
  officeSlug: string;
  input: GlassesWalkthroughArtifactUploadUrlInput;
  artifactStore: GlassesWalkthroughArtifactStore;
}): Promise<GlassesWalkthroughArtifactUploadUrlResult> {
  // Guarded, not assumed — same reasoning as `prepareGlassesWalkthroughArtifacts`, which re-validates this
  // identical lookup rather than trusting the validated input it is handed. This function is EXPORTED, so
  // "the route always validates first" is a property of one caller, not of the function. Unguarded, an
  // unaccepted (or merely differently-cased) mimeType read `.extension` off `undefined` — a TypeError the
  // error handler surfaces as a 500 and an alert, where the caller had earned an ordinary 400.
  const media = GLASSES_WALKTHROUGH_ACCEPTED_MEDIA[args.input.mimeType];
  if (!media || media.kind !== args.input.kind) {
    throw new AppError(
      400,
      `artifact.mimeType "${args.input.mimeType}" is not an accepted glasses-walkthrough media type for kind "${args.input.kind}".`
    );
  }
  // Filed bytes are FROZEN. The key below is a pure function of (officeSlug, dealId, walkId,
  // idempotencyKey), which is exactly what makes a dropped upload retryable at the same destination — and
  // exactly what lets this endpoint hand out a second writable URL for a key whose bytes a completion has
  // already turned into a `files` row. A PUT to that URL replaces the object UNDER the record: the row's
  // fileSizeBytes and mimeType, the completion-time HEAD that was checked against them, and the scope TROCK
  // Scope already extracted from the old content all go on describing content that is no longer there, and
  // nothing on the row changes to say so. There is no later check that catches it either — verification
  // runs at completion, which for this artifact has already happened. So the refusal has to be here.
  //
  // Necessary, NOT sufficient, and the gap is worth being precise about rather than trusting this block to
  // have closed it. This runs when the URL is MINTED; the URL outlives it. A client that presigns before
  // completing — the ordinary, correct order — is holding a writable capability for this exact key at the
  // moment the completion freezes the record, and no query here can recall it. What bounds that is
  // GLASSES_WALKTHROUGH_PRESIGN_EXPIRY_SECONDS, which is why that constant is part of this rule and not a
  // performance setting. Read the two together: this refuses NEW capabilities, that expires OLD ones.
  //
  // Keyed on the DEAL-SCOPED stored id, never the raw client key: mobile derives its key from the walk
  // alone, so refusing on the raw key would also refuse the legitimate re-file of one physical walk against
  // a second deal — a different R2 key and a different row (see deriveGlassesWalkthroughClientUploadId, and
  // migration 0212 for what that collision cost the first time). A hit that somehow belongs to another deal
  // is the digest-collision case the completion refuses too; refusing is correct under either reading,
  // since that artifact can never complete against this deal anyway.
  //
  // Deliberately NOT keyed on whether the OBJECT exists in R2. Bytes sitting at the key for a walk no
  // completion has accepted are precisely the dropped-upload state the retry MUST be allowed to overwrite;
  // an object-presence check would break the recovery flow while protecting nothing extra.
  const [alreadyFiled] = await args.tenantDb
    .select({ id: files.id })
    .from(files)
    .where(
      eq(
        files.clientUploadId,
        deriveGlassesWalkthroughClientUploadId(args.input.dealId, args.input.idempotencyKey)
      )
    )
    .limit(1);
  if (alreadyFiled) {
    throw new AppError(
      409,
      `Artifact ${args.input.idempotencyKey} of walk ${args.input.walkId} is already filed against this project. ` +
        `Its stored bytes cannot be replaced; complete the walk instead of re-uploading it.`,
      "GLASSES_WALKTHROUGH_ARTIFACT_ALREADY_FILED"
    );
  }

  const r2Key = deriveGlassesWalkthroughArtifactR2Key(
    args.officeSlug,
    args.input.dealId,
    args.input.walkId,
    args.input.idempotencyKey,
    media.extension
  );

  // Checked AFTER the guard above, never before: the unconfigured branch returns a `mock://` URL nobody can
  // PUT to, but this is a rule about the RECORD, and one that stopped holding whenever R2 happened to be
  // unconfigured would stop holding in exactly the environment where someone is reproducing a walk by hand.
  if (!args.artifactStore.isConfigured()) {
    // Dev/CI fallback, same posture as `generateMockUploadUrl` in r2-client.ts: a fake URL the caller
    // will never actually PUT bytes to, but a deterministic key so the completion endpoint's flow can
    // still be exercised end-to-end when R2 is not configured.
    // Reports the SAME lifetime the configured branch does, not the shared 30-minute default it used to
    // hardcode. Nobody can PUT to a `mock://` URL, so the number is inert here — which is exactly why it
    // has to be right: this is the environment someone reads to learn what the contract is.
    return {
      uploadUrl: `mock://glasses-walkthrough/${r2Key}`,
      r2Key,
      expiresIn: GLASSES_WALKTHROUGH_PRESIGN_EXPIRY_SECONDS,
    };
  }

  const { uploadUrl, expiresIn } = await args.artifactStore.presignUpload(
    r2Key,
    args.input.mimeType,
    args.input.fileSizeBytes,
    GLASSES_WALKTHROUGH_PRESIGN_EXPIRY_SECONDS
  );
  // The ceiling is enforced on the way OUT, not merely requested on the way in. A store that drops the
  // argument returns a longer-lived signature while reporting whatever it likes, and by this point the URL
  // is already signed — there is no shortening it, only declining to pass it on. 500 rather than a 4xx
  // because a store disagreeing with its own port is a wiring defect, not something the caller did; the
  // client's retry then re-presigns, which is the right outcome once the wiring is fixed and no worse
  // than a refusal in the meantime.
  if (expiresIn > GLASSES_WALKTHROUGH_PRESIGN_EXPIRY_SECONDS) {
    throw new AppError(
      500,
      `Refusing to issue an upload URL valid for ${expiresIn}s; glasses-walkthrough uploads are capped at ` +
        `${GLASSES_WALKTHROUGH_PRESIGN_EXPIRY_SECONDS}s because filed bytes must not stay replaceable.`
    );
  }
  return { uploadUrl, r2Key, expiresIn };
}

// ── Endpoint B: complete a walk ─────────────────────────────────────────────────────────────────────

export interface GlassesWalkthroughArtifactInput {
  idempotencyKey: string;
  kind: GlassesWalkthroughArtifactKind;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  /**
   * ABSOLUTE epoch-ms timestamp of when this artifact was captured on the phone — mobile sends
   * `Date.now()` at capture time (`QueuedWalkArtifact.at` / `a.at` in mobile/src/walkthrough/upload-core.ts
   * and upload.ts), NOT an offset from the walk's start. The name reads like an offset; it is not one.
   * Do not add this to another absolute timestamp (e.g. the walk's own `capturedAt`) — see the `takenAt`
   * assignment below, where doing exactly that once shipped a bug that filed every photo decades in the
   * future. Used directly to stamp `files.takenAt`. Otherwise informational only for the TROCK Scope
   * forward — TROCK Scope derives the real clip timeline from the media's own embedded metadata
   * (exif/container), not from a client claim, so it is not sent on to TROCK Scope's API (see
   * worker/src/jobs/glasses-walkthrough-forward.ts's beginClip). Kept in the job payload for the
   * project-folder record and future use.
   */
  capturedAtMs: number | null;
}

export interface IngestGlassesWalkthroughInput {
  dealId: string;
  projectId: string | null;
  walkId: string;
  title: string;
  siteLabel: string | null;
  capturedAt: string;
  userId: string;
  officeSlug: string;
  officeId: string | null;
  artifacts: GlassesWalkthroughArtifactInput[];
}

export function validateGlassesWalkthroughCompleteInput(raw: Record<string, unknown>): IngestGlassesWalkthroughInput {
  const dealId = assertNonEmptyString(raw.dealId, "dealId", 100);
  const walkId = assertNonEmptyString(raw.walkId, "walkId", MAX_WALK_ID_CHARS);
  const title = assertNonEmptyString(raw.title, "title", MAX_TITLE_CHARS);
  const siteLabel = assertOptionalString(raw.siteLabel, "siteLabel", MAX_SITE_LABEL_CHARS);
  const projectId = assertOptionalString(raw.projectId, "projectId", 100);

  if (typeof raw.capturedAt !== "string" || Number.isNaN(Date.parse(raw.capturedAt))) {
    throw new AppError(400, "capturedAt must be an ISO-8601 timestamp.");
  }

  if (!Array.isArray(raw.artifacts) || raw.artifacts.length === 0) {
    throw new AppError(400, "artifacts must be a non-empty array.");
  }
  if (raw.artifacts.length > MAX_GLASSES_WALKTHROUGH_ARTIFACTS_PER_WALK) {
    throw new AppError(400, `artifacts must contain at most ${MAX_GLASSES_WALKTHROUGH_ARTIFACTS_PER_WALK} entries.`);
  }

  const seenKeys = new Set<string>();
  const artifacts: GlassesWalkthroughArtifactInput[] = raw.artifacts.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new AppError(400, `artifacts[${index}] must be an object.`);
    }
    const a = entry as Record<string, unknown>;
    const idempotencyKey = assertIdempotencyKey(a.idempotencyKey, `artifacts[${index}].idempotencyKey`);
    if (seenKeys.has(idempotencyKey)) {
      throw new AppError(400, `artifacts[${index}].idempotencyKey "${idempotencyKey}" is duplicated in this request.`);
    }
    seenKeys.add(idempotencyKey);

    const originalFilename = assertNonEmptyString(a.originalFilename, `artifacts[${index}].originalFilename`, MAX_FILENAME_CHARS);
    const fileSizeBytes = assertPositiveInteger(a.fileSizeBytes, `artifacts[${index}].fileSizeBytes`, MAX_GLASSES_WALKTHROUGH_ARTIFACT_BYTES);
    const media = resolveMedia(a.mimeType, a.kind, `artifacts[${index}]`);

    let capturedAtMs: number | null = null;
    if (a.capturedAtMs !== undefined && a.capturedAtMs !== null) {
      if (typeof a.capturedAtMs !== "number" || !Number.isFinite(a.capturedAtMs) || a.capturedAtMs < 0) {
        throw new AppError(400, `artifacts[${index}].capturedAtMs must be a non-negative number.`);
      }
      // Bounded ABOVE as well, because finite is not the same as representable: 1e300 passes every check
      // on the line above and `new Date(1e300)` is an Invalid Date. This value is written straight to
      // `files.takenAt`, and takenAt is the column every chronological read in the app orders on via
      // COALESCE(taken_at, created_at) — the field gallery, photo-timeline-filters.ts,
      // files/feed-service.ts. An Invalid Date does not fail here; it fails at the INSERT, turning a
      // client's bad number into a 500 on a walk that is otherwise perfectly filable.
      if (a.capturedAtMs > MAX_GLASSES_WALKTHROUGH_CAPTURED_AT_MS) {
        throw new AppError(
          400,
          `artifacts[${index}].capturedAtMs must be at most ${MAX_GLASSES_WALKTHROUGH_CAPTURED_AT_MS} (the maximum representable timestamp).`
        );
      }
      capturedAtMs = a.capturedAtMs;
    }

    return {
      idempotencyKey,
      kind: media.kind,
      originalFilename,
      mimeType: (a.mimeType as string).toLowerCase(),
      fileSizeBytes,
      capturedAtMs,
    };
  });

  return {
    dealId,
    projectId,
    walkId,
    title,
    siteLabel,
    capturedAt: raw.capturedAt as string,
    userId: assertNonEmptyString(raw.userId, "userId", 100),
    officeSlug: assertNonEmptyString(raw.officeSlug, "officeSlug", 100),
    officeId: assertOptionalString(raw.officeId, "officeId", 100),
    artifacts,
  };
}

export interface GlassesWalkthroughFileResult {
  fileId: string;
  idempotencyKey: string;
  kind: GlassesWalkthroughArtifactKind;
  r2Key: string;
  displayName: string;
  created: boolean;
}

export type GlassesWalkthroughForwardingResult =
  | { status: "queued"; jobId: number }
  | { status: "already_queued"; jobId: number }
  /** A live forward job was WIDENED in place to cover artifacts this call filed and it did not carry. */
  | { status: "artifacts_added"; jobId: number }
  /** A FINISHED forward job could not be widened (see `supersedeUnamendableGlassesWalkthroughForwardJob`)
   *  and was dead-lettered, carrying the complete artifact list, for reconciliation. */
  | { status: "superseded_for_reconciliation"; jobId: number }
  /** The forward job is being WORKED right now, so it keeps its claim and its place in the live unique
   *  index. The complete artifact list is recorded beside the one being delivered, and the handler
   *  dead-letters itself carrying the union once it stops. Distinct from `superseded_for_reconciliation`
   *  because the reconciliation has been SCHEDULED here, not performed — the row is still alive. */
  | { status: "reconciliation_pending"; jobId: number };

/**
 * One entry of `job_queue.payload.artifacts` — what the worker iterates to ship a walk to TROCK Scope
 * (`JobPayload.artifacts`, worker/src/jobs/glasses-walkthrough-forward.ts). Named because it is now built
 * in one place and written in three: the enqueue below, the in-place amend, and the supersede.
 */
interface GlassesWalkthroughForwardArtifact {
  fileId: string;
  idempotencyKey: string;
  kind: GlassesWalkthroughArtifactKind;
  r2Key: string;
  mimeType: string;
  originalFilename: string;
  fileSizeBytes: number;
  capturedAtMs: number | null;
}

/** One artifact resolved down to everything the write phase needs, so that phase issues zero object-storage
 *  calls of its own. Built in a pure pass BEFORE verification, which is also what makes the media/kind
 *  re-validation a rejection that happens before any I/O at all rather than partway down the walk. */
interface PreparedGlassesWalkthroughArtifact {
  artifact: GlassesWalkthroughArtifactInput;
  media: AcceptedGlassesWalkthroughMedia;
  r2Key: string;
  /** The DEAL-SCOPED id this artifact is stored and re-found under — NOT `artifact.idempotencyKey`, which
   *  is only what the client called it. Derived once here so the write phase can never key one statement
   *  by the raw value and the next by the scoped one, which would read as a phantom conflict. */
  clientUploadId: string;
}

function prepareGlassesWalkthroughArtifacts(
  input: IngestGlassesWalkthroughInput
): PreparedGlassesWalkthroughArtifact[] {
  return input.artifacts.map((artifact) => {
    // Re-validated here (not just trusted from the route's earlier validation) — this module does not
    // trust its caller wholesale, matching the return path's own "the receiver does not trust the
    // sender" posture (walkthrough-ingress-service.ts), and this function is exported for direct/test
    // use, not only reachable through the route.
    const media = GLASSES_WALKTHROUGH_ACCEPTED_MEDIA[artifact.mimeType];
    if (!media || media.kind !== artifact.kind) {
      throw new AppError(400, `Artifact ${artifact.idempotencyKey} has an unsupported mimeType/kind pair.`);
    }
    return {
      artifact,
      media,
      r2Key: deriveGlassesWalkthroughArtifactR2Key(
        input.officeSlug,
        input.dealId,
        input.walkId,
        artifact.idempotencyKey,
        media.extension
      ),
      clientUploadId: deriveGlassesWalkthroughClientUploadId(input.dealId, artifact.idempotencyKey),
    };
  });
}

/** The three checks `confirmUpload` (files/service.ts) makes, in its order, with its status codes. Throws;
 *  the caller turns a throw into a recorded per-index failure. Both `!= null` guards are its guards too —
 *  R2 may not report either header, and an absent header is not a mismatch. */
async function verifyOneGlassesWalkthroughArtifact(
  prepared: PreparedGlassesWalkthroughArtifact,
  artifactStore: GlassesWalkthroughArtifactStore
): Promise<void> {
  const { artifact, r2Key } = prepared;
  const head = await artifactStore.head(r2Key);
  if (!head) {
    throw new AppError(
      400,
      `Artifact ${artifact.idempotencyKey} was not found at its upload key. Upload it via the ` +
        `artifact upload-url endpoint before completing the walk.`
    );
  }
  if (head.contentType && head.contentType.toLowerCase() !== artifact.mimeType) {
    throw new AppError(
      400,
      `Artifact ${artifact.idempotencyKey}: Content-Type mismatch. Expected "${artifact.mimeType}", got "${head.contentType}".`
    );
  }
  if (head.contentLength != null && head.contentLength !== artifact.fileSizeBytes) {
    throw new AppError(
      400,
      `Artifact ${artifact.idempotencyKey}: Content-Length mismatch. Expected ${artifact.fileSizeBytes} bytes, got ${head.contentLength}.`
    );
  }
}

/**
 * Verifies the WHOLE walk against object storage before the write phase issues its first statement.
 *
 * Two properties this shape buys, both of which the old verify-then-insert-then-verify loop lacked:
 *   - "a failed verification writes nothing" becomes a property of THIS function rather than of the
 *     caller. Interleaved, a walk that failed on artifact 12 had already inserted eleven `files` rows and
 *     depended entirely on the request transaction rolling them back — true through the route today, and
 *     silently false for any other caller (this function is exported).
 *   - the pinned tenant connection is held for one bounded verification window instead of the sum of every
 *     round trip. See GLASSES_WALKTHROUGH_VERIFY_CONCURRENCY for why that matters at all.
 *
 * The reported failure is the LOWEST-INDEXED one, never whichever HEAD happened to answer first: with
 * concurrency a fast failure on artifact 40 can land before a slow one on artifact 2, and an endpoint
 * whose 400 names a different artifact run to run is not debuggable. Dispatch stops as soon as any index
 * fails, so the set examined is exactly the prefix a sequential loop would have reached.
 *
 * The workers are TOTAL — every await inside them is inside a try, so `Promise.all` over them can never
 * reject. That is what makes racing it against the deadline safe: the losing promise cannot become an
 * unhandled rejection after this function has already thrown.
 */
async function verifyGlassesWalkthroughArtifacts(
  prepared: PreparedGlassesWalkthroughArtifact[],
  artifactStore: GlassesWalkthroughArtifactStore,
  timeoutMs: number
): Promise<void> {
  // With no object store configured (local dev, CI) verification is skipped, mirroring `confirmUpload`'s
  // own gate — same posture as the rest of the CRM.
  if (!artifactStore.isConfigured()) return;

  const failures = new Array<AppError | undefined>(prepared.length);
  let stopDispatchingAt = prepared.length;
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < stopDispatchingAt) {
      const index = nextIndex++;
      try {
        await verifyOneGlassesWalkthroughArtifact(prepared[index]!, artifactStore);
      } catch (err) {
        // R33: a throw out of the store means WE COULD NOT CHECK, not that the object is absent —
        // retryable, never a 400. Only the AppErrors raised above are verdicts about the object itself.
        failures[index] =
          err instanceof AppError
            ? err
            : new AppError(
                503,
                `Could not verify artifact ${prepared[index]!.artifact.idempotencyKey}; object storage is unavailable. Retry.`
              );
        stopDispatchingAt = Math.min(stopDispatchingAt, index);
      }
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = await Promise.race([
      Promise.all(
        Array.from({ length: Math.min(GLASSES_WALKTHROUGH_VERIFY_CONCURRENCY, prepared.length) }, () => worker())
      ).then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => {
          // Stop DISPATCHING as well as stop waiting. The already-issued HEADs cannot be aborted (no
          // AbortSignal is threaded through the store interface), but the workers are still sitting in
          // their `while` loops, and each one that settles after this point would otherwise pick up the
          // next index and fire another request into a store that has already proven it is not answering.
          // For a 200-artifact walk that is ~192 further HEADs issued AFTER the caller got its 503 — and
          // since a 503 is retryable, the client's next attempt stacks another round on top, multiplying
          // load during exactly the slowdown this deadline exists to contain.
          stopDispatchingAt = 0;
          resolve(true);
        }, timeoutMs);
        // Never keep the process alive for a verification nobody is waiting on any more.
        timer.unref?.();
      }),
    ]);
    if (timedOut) {
      throw new AppError(
        503,
        `Could not verify this walk's artifacts within ${timeoutMs}ms; object storage is not answering. Retry.`
      );
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  const firstFailure = failures.find((failure) => failure !== undefined);
  if (firstFailure) throw firstFailure;
}

/**
 * What the queue already knows about forwarding THIS walk FOR THIS DEAL, in one scan.
 *
 * Scoped by (walkId, dealId), never walkId alone. walkId is minted on the phone and nothing makes it
 * unique across deals — the same physical walk legitimately gets completed against two deals (a mis-tagged
 * walk corrected and re-sent, two deals sharing one site visit), and a colliding client walkId is not
 * exotic. Keyed on walkId alone, the second deal's completion matches the FIRST deal's job, short-circuits
 * to `already_queued`, and that deal never gets a scope: a 201, a full project folder, and a forward that
 * silently never happened. The same unscoped read also hands deal B a checkpoint (`scopeWalkthroughId`)
 * naming deal A's remote walkthrough, so B's clips would upload into A's walkthrough and B's scope rows
 * would come back attached to the wrong deal.
 *
 * Deliberately one query, not two: the live-row dedupe check and the dead-row checkpoint lookup have the
 * same (job_type, payload->>'walkId', payload->>'dealId') shape, so asking twice would double the cost of
 * the common first-completion path — the very path where the second question always comes back empty.
 * Migration 0211 indexes exactly this predicate.
 * The ORDER BY carries the whole precedence instead:
 *   1. a LIVE row wins outright — forwarding is already scheduled and nothing else matters;
 *   2. otherwise prefer a dead row that carries a SETTLED `scopeWalkthroughId` over one that only carries
 *      the unresolved pre-create marker: a known walkthrough id is strictly better information than "a
 *      create may have happened", and it is the difference between resuming and a human reconciliation;
 *   3. otherwise the newest such row.
 * Dead rows with NEITHER marker are excluded by the WHERE — they prove nothing about TROCK Scope's state,
 * and treating them as evidence would dead-letter walks that are perfectly safe to forward from scratch.
 *
 * `->> 'x' IS NOT NULL` rather than the `?` existence operator: identical here (nothing in this payload is
 * ever a JSON null) and it keeps a `?` out of SQL text that drivers and query loggers like to reinterpret.
 */
interface GlassesWalkthroughForwardJobState {
  jobId: number;
  isLive: boolean;
  /**
   * The row's status VERBATIM, carried for one purpose only: naming it in the dead letter a supersede
   * writes, so the human reading that email knows whether they are reconciling against a forward that was
   * mid-flight or one that had already finished. It is NOT what decides whether the job can be amended —
   * that is decided by the guarded UPDATE itself, because this value is a snapshot the dedicated poller
   * (2s tick, worker/src/index.ts) can invalidate before the next statement runs.
   */
  status: string;
  /**
   * `payload.artifacts` as stored, NOT re-derived from this call's input. An amend has to be a union with
   * whatever is actually on the row (see the live branch of `ingestGlassesWalkthrough`), and re-deriving
   * would silently drop any artifact the row carries that the current completion happens to omit.
   */
  artifacts: GlassesWalkthroughForwardArtifact[];
  scopeWalkthroughId: string | null;
  scopeCreatePendingRef: string | null;
}

async function findGlassesWalkthroughForwardJobState(
  tenantDb: TenantDb,
  walkId: string,
  dealId: string
): Promise<GlassesWalkthroughForwardJobState | null> {
  const rows = await tenantDb
    .select({
      id: jobQueue.id,
      status: jobQueue.status,
      isLive: sql<boolean>`${jobQueue.status} <> 'dead'`,
      // COALESCEd to an empty array rather than trusted: `payload` is jsonb a worker and a human both
      // write to, and `undefined.map` in the union below would turn a hand-edited row into a 500 on a
      // completion that is otherwise perfectly filable.
      artifacts: sql<GlassesWalkthroughForwardArtifact[]>`COALESCE(${jobQueue.payload} -> 'artifacts', '[]'::jsonb)`,
      scopeWalkthroughId: sql<string | null>`${jobQueue.payload} ->> 'scopeWalkthroughId'`,
      scopeCreatePendingRef: sql<string | null>`${jobQueue.payload} ->> 'scopeCreatePendingRef'`,
    })
    .from(jobQueue)
    .where(
      and(
        eq(jobQueue.jobType, GLASSES_WALKTHROUGH_FORWARD_JOB),
        sql`${jobQueue.payload} ->> 'walkId' = ${walkId}`,
        sql`${jobQueue.payload} ->> 'dealId' = ${dealId}`,
        sql`(${jobQueue.status} <> 'dead'
             OR ${jobQueue.payload} ->> 'scopeWalkthroughId' IS NOT NULL
             OR ${jobQueue.payload} ->> 'scopeCreatePendingRef' IS NOT NULL)`
      )
    )
    .orderBy(
      sql`(${jobQueue.status} <> 'dead') DESC`,
      sql`(${jobQueue.payload} ->> 'scopeWalkthroughId') IS NULL`,
      desc(jobQueue.id)
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    jobId: Number(row.id),
    isLive: Boolean(row.isLive),
    status: String(row.status),
    artifacts: Array.isArray(row.artifacts) ? row.artifacts : [],
    scopeWalkthroughId: row.scopeWalkthroughId ?? null,
    scopeCreatePendingRef: row.scopeCreatePendingRef ?? null,
  };
}

/**
 * Widen a forward job's artifact list IN PLACE, and only while nothing can be reading it.
 *
 * `status = 'pending'` is the whole safety argument, and it is a predicate on the STATEMENT, never a
 * decision taken from an earlier SELECT: a pending row is one no delivery owns, so the next claim reads
 * whatever this write leaves. The dedicated poller ticks every 2s (worker/src/index.ts), which is well
 * inside the window between a completion and its retry, so "it was pending a moment ago" is not a fact
 * worth acting on — the row lock is. Under a concurrent claim the two orderings are both safe: the claim's
 * `SELECT ... FOR UPDATE SKIP LOCKED` skips a row this UPDATE already locked (the job simply waits a tick
 * and is then claimed with the full list), and an UPDATE that arrives second blocks on the claim, re-checks
 * its predicate against the committed row, finds 'processing' and matches nothing.
 *
 * Returns whether it landed. A `false` is not an error — it is the caller's signal that this row must be
 * superseded instead, and conflating the two would silently swallow exactly the case that needs a human.
 *
 * `jsonb_set` on the one key rather than a whole-payload rewrite, matching the worker's own checkpoint
 * writes (glasses-walkthrough-forward.ts): the payload also carries `scopeWalkthroughId` /
 * `scopeCreatePendingRef` / `alertSent`, all written by other actors, and a read-modify-write of the whole
 * column here would clobber whichever of them landed between this transaction's snapshot and this write.
 */
async function amendPendingGlassesWalkthroughForwardArtifacts(
  tenantDb: TenantDb,
  jobId: number,
  artifacts: GlassesWalkthroughForwardArtifact[]
): Promise<boolean> {
  const updated = await tenantDb
    .update(jobQueue)
    .set({
      // The union is built HERE, against the row's own current value, and not in the caller from a
      // payload it read a moment ago. Two widening completions for the same walk can overlap — mobile
      // retrying after a response timed out in flight is the likeliest retry there is — and a union
      // computed before the UPDATE is computed from a snapshot. The guarded write serializes them,
      // which is not the same as making them correct: under READ COMMITTED the second UPDATE blocks on
      // the first's lock, then re-evaluates BOTH its predicate and this expression against the row the
      // first COMMITTED. A caller-built list would instead overwrite that committed result with one
      // derived from the pre-first-write payload, so [A,B] becomes [A,C] and the artifact the first
      // call filed never reaches TROCK Scope — while both requests report success.
      //
      // Deduped on idempotencyKey with the EXISTING entry winning (`DISTINCT ON` over the appended
      // list takes the lowest ordinality, and the row's own artifacts are concatenated first). That
      // preserves the verbatim-carry-through rule the caller's comment states: a worker or a
      // reconciling human may have edited an entry, and this call has no better information. WITH
      // ORDINALITY then restores the original order, so the forward's sequence is unchanged and only
      // genuinely new artifacts are appended, at the end.
      payload: sql`jsonb_set(
        ${jobQueue.payload},
        '{artifacts}',
        (
          SELECT COALESCE(jsonb_agg(d.elem ORDER BY d.ord), '[]'::jsonb)
          FROM (
            SELECT DISTINCT ON (t.elem ->> 'idempotencyKey') t.elem, t.ord
            FROM jsonb_array_elements(
              COALESCE(${jobQueue.payload} -> 'artifacts', '[]'::jsonb) || ${JSON.stringify(artifacts)}::jsonb
            ) WITH ORDINALITY AS t(elem, ord)
            ORDER BY t.elem ->> 'idempotencyKey', t.ord
          ) d
        ),
        true
      )`,
    })
    .where(and(eq(jobQueue.id, jobId), eq(jobQueue.status, "pending")))
    .returning({ id: jobQueue.id });
  return updated.length > 0;
}

/**
 * Union two forward artifact lists, deduped on `idempotencyKey`, with `existing` winning and keeping its
 * order. The in-place amend does exactly this in SQL (see above); this is the same rule for the paths that
 * build a payload in JS rather than editing one in place — a dead row's replacement, principally.
 *
 * Existing-wins rather than newest-wins because an entry already on a job may have been edited by a worker
 * or by a human reconciling a dead letter, and a completion retry has no better information than they did.
 */
export function mergeForwardArtifacts(
  existing: readonly GlassesWalkthroughForwardArtifact[],
  incoming: readonly GlassesWalkthroughForwardArtifact[]
): GlassesWalkthroughForwardArtifact[] {
  const merged: GlassesWalkthroughForwardArtifact[] = [];
  const seen = new Set<string>();
  for (const artifact of [...existing, ...incoming]) {
    if (seen.has(artifact.idempotencyKey)) continue;
    seen.add(artifact.idempotencyKey);
    merged.push(artifact);
  }
  return merged;
}

/**
 * The answer for a live forward job whose artifact list CANNOT be amended: record the complete list on it
 * anyway, then dead-letter it so a human is told.
 *
 * ONLY a row whose handler has provably STOPPED may be superseded, which here means `completed`. A
 * `completed` row is never selected by any poller, so an amendment to it would be inert — the artifacts
 * would sit in a payload no worker reads, indistinguishable from being forwarded — and killing it releases
 * nothing that is still in use.
 *
 * `processing` is NOT superseded, and that restriction is the whole point of this split. Marking a claimed
 * row dead does not cancel the handler: it is already iterating the artifact list it read at claim time
 * and keeps uploading. Two things then go wrong at once. The row leaves 0213's live partial unique index
 * immediately, so a concurrent completion retry can insert a REPLACEMENT — and with multiple worker
 * replicas that is two handlers uploading the same walkthrough at the same time, which this seam has no
 * way to reconcile. And the original handler's checkpoint writes match on `(job_type, walkId, dealId)`
 * with no job id, so they would land on that replacement row while it runs. The queue's own terminal
 * writes are guarded `WHERE id = $1 AND status = 'processing' AND attempts = $n`, so killing the row also
 * strands the handler's completion against a predicate that can no longer match. See
 * `recordPendingArtifactsOnRunningForwardJob` for what happens instead.
 *
 * The payload is written BEFORE the row is killed, in one statement, so the row a reconciler opens already
 * carries the complete walk: their whole job is `status = 'pending'`, not reassembling an artifact list by
 * hand from `files`. And because a dead row leaves the live partial unique index (0213), the very next
 * completion retry takes the EXISTING dead-row replacement path — a fresh job with the full list and the
 * inherited TROCK Scope checkpoint. The dead letter is the fallback, not the only way out.
 *
 * Enumerating `completed` rather than excluding `dead` is deliberate, and it is the SAFE direction: a new
 * status added to this queue is by default treated as possibly-running and routed to the pending-artifacts
 * path, which touches no lifecycle state. The previous `<> 'dead'` form did the opposite — it would kill
 * anything unrecognised.
 */
async function supersedeUnamendableGlassesWalkthroughForwardJob(
  tenantDb: TenantDb,
  jobId: number,
  artifacts: GlassesWalkthroughForwardArtifact[],
  lastError: string
): Promise<boolean> {
  const updated = await tenantDb
    .update(jobQueue)
    .set({
      payload: sql`jsonb_set(${jobQueue.payload}, '{artifacts}', ${JSON.stringify(artifacts)}::jsonb, true)`,
      status: "dead",
      lastError,
    })
    // `completed_at` is deliberately NOT cleared. On a superseded `completed` row it is the only remaining
    // evidence that this forward ever ran, and a reconciler who cannot see it re-forwards blind.
    .where(and(eq(jobQueue.id, jobId), eq(jobQueue.status, "completed")))
    .returning({ id: jobQueue.id });
  return updated.length > 0;
}

/**
 * The answer for a forward job that is being WORKED right now: record the complete artifact list beside
 * the one the handler is using, and change nothing else.
 *
 * The barrier — 0213's live partial unique index, and the handler's claim — stays exactly where it is.
 * Nothing can insert a replacement, nothing else can claim the row, the handler's own completion predicate
 * still matches, and its checkpoints still find the row they were written for. The cost is that the new
 * artifacts do not reach TROCK Scope on THIS attempt, which is unavoidable: the handler read its list at
 * claim time and no row write can reach that snapshot.
 *
 * `pendingArtifacts` is a separate key rather than an edit to `artifacts` precisely so the running handler
 * and the reconciliation cannot be confused for one another — `artifacts` remains, verbatim, the list the
 * current attempt is delivering. The handler reads this key back when it finishes and dead-letters itself
 * carrying the union (see worker/src/jobs/glasses-walkthrough-forward.ts), which is the same supersede as
 * above but taken at the one moment it is safe: after the delivery it would have raced has stopped.
 *
 * Excludes the states with their own handling rather than naming `processing`, so an unrecognised status
 * lands HERE — the branch that cannot break anything — instead of on the one that kills rows.
 */
async function recordPendingArtifactsOnRunningForwardJob(
  tenantDb: TenantDb,
  jobId: number,
  artifacts: GlassesWalkthroughForwardArtifact[]
): Promise<boolean> {
  const updated = await tenantDb
    .update(jobQueue)
    .set({
      payload: sql`jsonb_set(${jobQueue.payload}, '{pendingArtifacts}', ${JSON.stringify(artifacts)}::jsonb, true)`,
    })
    .where(
      and(
        eq(jobQueue.id, jobId),
        sql`${jobQueue.status} NOT IN ('pending', 'completed', 'dead')`
      )
    )
    .returning({ id: jobQueue.id });
  return updated.length > 0;
}

/**
 * The `last_error` a supersede leaves, which is the entire content of the alert the dead-letter sweep
 * emails (worker/src/jobs/glasses-walkthrough-forward.ts). Written in the same shape as
 * `buildUnconfirmedCreateDeadLetterMessage` there: what happened, why it stopped rather than guessing, the
 * literal resolution step, and the reassurance that the crew's copy is already safe.
 *
 * TOKEN SAFETY, same rule as that sibling: built only from this walk's own identifiers, never from
 * anything in the environment.
 */
function buildSupersededForwardDeadLetterMessage(args: {
  walkId: string;
  dealId: string;
  jobStatus: string;
  missingKeys: string[];
  scopeWalkthroughId: string | null;
}): string {
  return (
    `Superseded for reconciliation: walk ${args.walkId} (deal ${args.dealId}) was completed again carrying ` +
    `${args.missingKeys.length} artifact(s) this forward never held (${args.missingKeys.join(", ")}). The row ` +
    `was '${args.jobStatus}' when they were filed, so its artifact list could not be widened in flight — a ` +
    `handler reads its payload once, at claim time, and a row that has already finished is never claimed ` +
    `again. Forwarding the incomplete set would have extracted a scope from a partial walk with nothing ` +
    `reporting it, so it stopped instead. This row's payload NOW CARRIES THE COMPLETE ARTIFACT LIST. ` +
    `TO RESOLVE: check what TROCK Scope walkthrough ` +
    `${args.scopeWalkthroughId ? args.scopeWalkthroughId : "(none recorded — nothing was created yet)"} ` +
    `already holds, then set this row's status = 'pending' to forward the whole walk (TROCK Scope's own ` +
    `checksum constraint rejects clip bytes that already landed). A later completion retry from the phone ` +
    `does this automatically. The walk itself is durably filed in the project folder and the crew can ` +
    `already see it.`
  );
}

/**
 * Puts this call's newly-filed STILLS through the post-upload fan-out every other photo in the CRM goes
 * through, and does it in two statements no matter how many stills the walk carried.
 *
 * WHAT THE EVENT ACTUALLY DRIVES, because "emit the event" is not self-justifying. `file.uploaded` has one
 * registered handler (worker/src/jobs/index.ts), whose whole body is inside `if (category === 'photo')`:
 *   - `extractExif` — downloads the object, reads its EXIF, and backfills `taken_at`, `geo_lat`, `geo_lng`.
 *     It also re-buckets `folder_path` by rewriting a trailing `YYYY-MM`, which is inert here: this
 *     module's folder is GLASSES_WALKTHROUGH_FOLDER_PATH, which has no date suffix to rewrite, so the
 *     walk's grouping convention is not disturbed. `taken_at` IS overwritten when the still carries a
 *     DateTimeOriginal — deliberately accepted: the glasses' own capture stamp is at least as good as the
 *     phone's `Date.now()` this module writes, and it is exactly what happens to every field photo.
 *   - a `procore_photo_sync` enqueue, on a deal that is Procore-linked with a photo album, so the still
 *     lands in the project's album alongside the crew's ordinary photos.
 * No thumbnailing, no notification, no feed write — the feed reads `files` directly. Nothing in that list
 * is undesirable for a jobsite still, and nothing else can reach it: without this event a glasses photo is
 * a row that looks right in the table and is invisible to every process that acts when a photo arrives.
 *
 * PHOTOS ONLY, and the clips are not being slighted. A walk's video/audio are `category: 'other'`, so the
 * handler dequeues them, logs, and does nothing — a durable job whose success condition is that it had no
 * effect. Those artifacts already HAVE a durable consumer: `glasses_walkthrough_forward`, the job this
 * module exists to schedule. And the shape of the work a `file.uploaded` consumer does is "fetch the object
 * and read it" (extractExif downloads it; the Procore push downloads it again) — inviting that for objects
 * up to MAX_GLASSES_WALKTHROUGH_ARTIFACT_BYTES buys nothing today and costs a multi-gigabyte pull the day
 * someone widens that gate. Registering a non-photo consumer makes dropping this filter a one-line change.
 *
 * CREATED ROWS ONLY. `created` is the rows the batched insert's `RETURNING` actually produced, so a retry
 * that conflicted on every artifact emits nothing at all. Driving this off the REQUEST instead would re-run
 * EXIF over bytes that have not changed and push the same photo into Procore again on every mobile retry —
 * and mobile retries a whole walk, not the missing part of one.
 *
 * TWO STATEMENTS, NOT TWO PER PHOTO. The ordinary path's `recordUploadedFileSideEffects` (files/
 * upload-workflow.ts) is per file: an audit insert plus a queue insert. Called in a loop here that is 400
 * round trips at the 200-artifact ceiling, inside the transaction `tenantMiddleware` already pinned a
 * pooled connection for — precisely the cost the batched `files` write above exists to avoid, re-added for
 * the one artifact class a walk carries in bulk. So the two writes are rebuilt as multi-row inserts rather
 * than delegated. That duplicates a payload shape this module does not own; the runtime suite pins it by
 * running the real shared producer over a row this one filed and comparing what each enqueued.
 *
 * Errors are NOT swallowed, unlike `logPhotoEvent`'s own try/catch. This runs inside the request's
 * transaction, and a failed statement leaves Postgres refusing every later one in it — "continue anyway"
 * is not on the menu, only "fail this completion". That is the right outcome: completion is retryable and
 * idempotent, so the walk lands on the next attempt with its audit trail intact.
 */
async function recordCreatedGlassesWalkthroughStills(
  tenantDb: TenantDb,
  args: { created: (typeof files.$inferSelect)[]; userId: string; officeId: string | null }
): Promise<void> {
  const stills = args.created.filter((row) => row.category === "photo");
  if (stills.length === 0) return;

  // Read off the ROW rather than hardcoded nulls: these columns are all null for a glasses still today,
  // and writing `null` here would silently stop being true the moment the insert above starts stamping a
  // GPS fix or a photo category onto them.
  await tenantDb.insert(photoAuditLog).values(
    stills.map((row) => ({
      photoId: row.id,
      eventType: "uploaded" as const,
      userId: args.userId,
      ipAddress: null,
      userAgent: null,
      metadata: {
        addressSource: row.addressSource ?? null,
        hasGpsCoordinates: Boolean(row.latitude && row.longitude),
        category: row.photoCategory ?? null,
        sizeBytes: row.fileSizeBytes ?? null,
      },
    }))
  );

  await tenantDb.insert(jobQueue).values(
    stills.map((row) => ({
      jobType: "domain_event",
      payload: {
        eventName: DOMAIN_EVENTS.FILE_UPLOADED,
        fileId: row.id,
        r2Key: row.r2Key,
        mimeType: row.mimeType,
        dealId: row.dealId,
        leadId: row.leadId,
        contactId: row.contactId,
        category: row.category,
        uploadedBy: args.userId,
      },
      // Carried the same way the forward enqueue below carries it — the worker resolves which tenant
      // schema the file lives in from this column, and the payload deliberately does not repeat it.
      officeId: args.officeId,
      status: "pending" as const,
      runAfter: new Date(),
    }))
  );
  // No `eventBus.emitLocal` counterpart to `emitUploadedFileEvent` (files/routes.ts). Nothing subscribes to
  // FILE_UPLOADED in-process, and that call is made AFTER the request commits for a reason — this module
  // never owns the transaction it runs in (`runInOfficeTransaction`, field/routes.ts), so an in-process
  // emit from here would announce a walk a rollback can still erase.
}

export interface IngestGlassesWalkthroughResult {
  walkId: string;
  files: GlassesWalkthroughFileResult[];
  forwarding: GlassesWalkthroughForwardingResult;
}

/**
 * Files the walk against the deal's project folder and hands forwarding off to the job queue.
 *
 * IDEMPOTENT at two levels, matching the two ways a mobile background-upload queue can retry:
 *   - PER ARTIFACT: `files.client_upload_id` (unique, partial index — migration 0170) means re-running
 *     this for an artifact whose idempotency key already produced a row returns THAT row (`created:
 *     false`) instead of a second one. `onConflictDoNothing` + re-select mirrors `confirmUpload`
 *     (files/service.ts) exactly, including the concurrent-race case it also handles. Scoped to the
 *     (`dealId`, key) PAIR, never the key alone, for the same reason the per-walk guard below is scoped
 *     to a pair: mobile's key is a function of the walk and nothing else, so keying the row on it alone
 *     made re-filing a walk against the correct deal permanently impossible — see
 *     `deriveGlassesWalkthroughClientUploadId`.
 *   - PER WALK: retrying the WHOLE completion call (e.g. the mobile app never saw the first response)
 *     must not enqueue a SECOND forward job — TROCK Scope's `POST /walkthroughs` has no idempotency key
 *     of its own (see the report's TROCK Scope follow-up), so two jobs for one walk would create two
 *     walkthroughs there. Guarded by looking for a live (non-dead) `job_queue` row for this (`walkId`,
 *     `dealId`) pair before inserting a new one — the pair, never `walkId` alone, because a phone-minted
 *     walkId is not unique across deals and deduping on it would silently drop the second deal's forward
 *     entirely (see `findGlassesWalkthroughForwardJobState`). That lookup only SHORT-CIRCUITS; under
 *     concurrency it decides nothing, because a SELECT takes no lock and 0211's index is not unique. What
 *     makes two OVERLAPPING completions resolve to ONE job is the partial unique index migration 0213 adds
 *     on (`payload->>'walkId'`, `payload->>'dealId'`) over non-dead rows, which the enqueue's `ON CONFLICT
 *     DO NOTHING` arbitrates against — see the enqueue itself. Treating this as a best-effort check was NOT
 *     the accepted residual `rfp-bidboard-create.ts` documents for its own dedupe: a duplicate here is a
 *     second TROCK Scope walkthrough, a second billed transcription and a second billed Anthropic scope
 *     extraction, and the worker's per-walkthrough checkpoint cannot absorb it because two jobs never share
 *     one.
 *     Not enqueuing a second job is NOT the same as doing nothing, and reading it that way is what let a
 *     widening retry file artifacts the forward never carried. A retry may legitimately name MORE artifacts
 *     than the one that scheduled the forward, so the live branch reconciles the job's artifact list
 *     against what is now filed: widened in place while the row is still `pending`, and superseded (full
 *     list recorded, then dead-lettered for reconciliation) once it is not — see
 *     `amendPendingGlassesWalkthroughForwardArtifacts` and
 *     `supersedeUnamendableGlassesWalkthroughForwardJob` for why those are the only two safe answers.
 *   - ACROSS A DEAD ROW: a walk that dead-lettered IS re-enqueued (a site visit is not repeatable, so a
 *     walk must not be stuck forever), but the replacement INHERITS whatever the dead row learned about
 *     TROCK Scope — see `findGlassesWalkthroughForwardJobState`. The identity that must not be duplicated
 *     is the WALK's, and it outlives any one queue row. A dead row carrying `scopeWalkthroughId` means a
 *     remote walkthrough demonstrably exists; carrying `scopeCreatePendingRef` means one MAY exist and
 *     the worker must not create blind. Enqueuing a blank payload in either case is a second remote
 *     walkthrough, a second billed transcription and a second billed scope extraction, with nothing
 *     anywhere saying so. The dead row is never mutated or revived: the replacement is a new, plainly
 *     visible row (with `checkpointInheritedFromJobId` naming its source), so a human part-way through
 *     the reconciliation the worker's dead letter asks for is never raced by a delayed mobile retry.
 *
 * Independence from forwarding: this function's own success/failure is determined ENTIRELY by the
 * `files` writes and the enqueue — never by whether TROCK Scope is reachable, because it never calls
 * TROCK Scope. That is what "if TROCK Scope is down, the crew's copy must still succeed" means at this
 * layer: forwarding literally cannot run synchronously with this call.
 *
 * PHASE ORDER — pure validation, then ALL object-storage verification, then only database work. The
 * write phase must contain no object-storage await at all; see `verifyGlassesWalkthroughArtifacts` for
 * what that buys and what it costs the connection pool when it is not done that way.
 */
export async function ingestGlassesWalkthrough(
  tenantDb: TenantDb,
  input: IngestGlassesWalkthroughInput,
  deps: { artifactStore: GlassesWalkthroughArtifactStore; objectVerificationTimeoutMs?: number }
): Promise<IngestGlassesWalkthroughResult> {
  const bucket = getGlassesWalkthroughFileBucket();
  // `input.capturedAt` is validated ISO-8601 by validateGlassesWalkthroughCompleteInput, so this is a
  // real epoch millis value, not NaN.
  const capturedAtBaseMs = new Date(input.capturedAt).getTime();

  const prepared = prepareGlassesWalkthroughArtifacts(input);
  await verifyGlassesWalkthroughArtifacts(
    prepared,
    deps.artifactStore,
    deps.objectVerificationTimeoutMs ?? GLASSES_WALKTHROUGH_VERIFY_TIMEOUT_MS
  );

  // ONE multi-row insert for the whole walk, not one statement per artifact.
  //
  // Same concern the verification phase is shaped around, on the other side of the phase boundary:
  // `tenantMiddleware` has pinned a pooled connection and opened a transaction before this handler ran, so
  // every round trip here is pool-slot occupancy. At the 200-artifact ceiling the per-artifact loop was up
  // to 200 sequential INSERTs plus, on a retry, up to 200 more SELECTs — 400 serial round trips inside one
  // held transaction, to write a bounded, fully-known set of rows. Batched it is exactly two statements
  // regardless of walk size.
  //
  // Row order is NOT relied on anywhere below: `returning()` on a conflicting multi-row insert yields only
  // the rows that actually inserted, in no promised order, so results are matched back by
  // `client_upload_id` and the per-artifact bookkeeping is driven by iterating `prepared`.
  const insertValues = prepared.map(({ artifact, media, r2Key, clientUploadId }) => ({
    category: (media.kind === "photo" ? "photo" : "other") as FileCategory,
    subcategory: GLASSES_WALKTHROUGH_SUBCATEGORY,
    folderPath: GLASSES_WALKTHROUGH_FOLDER_PATH,
    tags: [GLASSES_WALKTHROUGH_TAG, input.walkId],
    displayName: artifact.originalFilename,
    systemFilename: `glasses-walk-${artifact.idempotencyKey}.${media.extension}`,
    originalFilename: artifact.originalFilename,
    mimeType: artifact.mimeType,
    fileSizeBytes: artifact.fileSizeBytes,
    fileExtension: `.${media.extension}`,
    r2Key,
    r2Bucket: bucket,
    dealId: input.dealId,
    description: input.siteLabel ? `Glasses walkthrough — ${input.siteLabel}` : "Glasses walkthrough",
    uploadedBy: input.userId,
    // The DEAL-SCOPED id, not the client's raw key — see `deriveGlassesWalkthroughClientUploadId`. The raw
    // key is still on this row in `systemFilename` and `r2Key` above.
    clientUploadId,
    // WHEN this artifact was actually captured on site, not when this request happened to file it —
    // same reasoning as createWalkthroughContactSheetFile (walkthrough-ingress-service.ts): everything
    // that orders/filters files chronologically (field gallery, photo-timeline-filters.ts,
    // files/feed-service.ts) does it on COALESCE(taken_at, created_at). Leaving this null for an
    // offline/background-delayed walk would group and sort glasses stills under the day they finally
    // uploaded rather than the day of the site visit.
    //
    // capturedAtMs is ALREADY an absolute epoch-ms timestamp (mobile's `Date.now()` at capture time —
    // see the type doc above), NOT an offset from the walk's start despite the field name. Use it
    // directly rather than adding it to capturedAtBaseMs: that used to add two absolute epoch values
    // together, roughly doubling the timestamp and filing every real walkthrough photo decades in the
    // future. Fall back to the walk's own capturedAt (capturedAtBaseMs) only when an artifact never
    // reported its own capture time.
    takenAt: new Date(artifact.capturedAtMs ?? capturedAtBaseMs),
  }));

  const inserted = await tenantDb
    .insert(files)
    .values(insertValues)
    // Mirrors confirmUpload (files/service.ts): a concurrent retry for the same idempotency key can
    // race past this insert too — let the partial unique index arbitrate rather than throw a 23505
    // into this request's transaction.
    .onConflictDoNothing({ target: files.clientUploadId, where: isNotNull(files.clientUploadId) })
    .returning();

  // Which artifacts THIS call created, as opposed to which already existed — `created` is per artifact and
  // a partly-landed walk being retried legitimately reports a mix. Deriving it from "did the statement
  // insert anything" would collapse that. Keyed by the STORED id throughout, because that is what the
  // returned rows carry; the client's raw key is reattached only in the response below.
  const createdClientUploadIds = new Set(inserted.map((row) => row.clientUploadId));

  const storedIds = prepared.map(({ clientUploadId }) => clientUploadId);
  // One re-select covering the whole walk, conflicts and inserts alike, so the retry path costs the same
  // single round trip as the first-completion path.
  const rowsByStoredId = new Map(
    (await tenantDb.select().from(files).where(inArray(files.clientUploadId, storedIds))).map((row) => [
      row.clientUploadId,
      row,
    ])
  );

  const fileResults: GlassesWalkthroughFileResult[] = prepared.map(({ artifact, media, clientUploadId }) => {
    const fileRow = rowsByStoredId.get(clientUploadId);
    if (!fileRow) {
      throw new AppError(409, `Artifact ${artifact.idempotencyKey} could not be filed. Please retry.`);
    }
    // Unreachable through this module now that the stored id is deal-scoped — which is the point of
    // keeping it. It fires only if some OTHER producer has written this exact value (ruled out by the
    // `gw_` shape) or on a 244-bit digest collision, and in both cases the row belongs to a different job:
    // relaying its fileId would hand this walk's forward job someone else's evidence, and the forward job
    // cannot tell. Refusing is the only answer that stays correct without knowing which happened.
    if (fileRow.dealId !== input.dealId) {
      throw new AppError(
        409,
        `Artifact idempotency key ${artifact.idempotencyKey} is already associated with a different deal.`
      );
    }
    return {
      fileId: fileRow.id,
      // The key the CLIENT sent, never the stored form: mobile retires its queue entries by matching this
      // against the key it generated (upload.ts's drain loop), so echoing the digest would leave every
      // artifact unacknowledged and re-upload the whole walk on the next drain.
      idempotencyKey: artifact.idempotencyKey,
      kind: media.kind,
      r2Key: fileRow.r2Key,
      displayName: fileRow.displayName,
      created: createdClientUploadIds.has(clientUploadId),
    };
  });

  // The stills join the ordinary photo pipeline HERE, and the position is load-bearing on both sides.
  //
  // AFTER `fileResults`, so a walk about to be refused with a 409 announces nothing it is not going to
  // keep. BEFORE the forward-job dedupe below, because that branch RETURNS EARLY: a retry of a walk whose
  // forward is already queued can still have created new `files` rows on this very call (the partial-
  // landing case the `created` flag exists for), and an emit written past the early return would file
  // those stills and tell nobody — the exact defect being fixed, reintroduced on the retry path only,
  // where it is hardest to notice.
  await recordCreatedGlassesWalkthroughStills(tenantDb, {
    created: inserted,
    userId: input.userId,
    officeId: input.officeId,
  });

  // Keyed by idempotency key, never by array position. `fileResults` and `input.artifacts` line up today
  // only because one loop happens to preserve order; positional lookup silently forwards every artifact
  // under a NEIGHBOUR's mimeType and filename the moment that stops being true, and TROCK Scope has no way
  // to notice — it would transcode a jpeg as audio and blame the bytes. The keys are already unique per
  // walk (the validator rejects duplicates within a request), so they are the correct join.
  const artifactsByKey = new Map(input.artifacts.map((artifact) => [artifact.idempotencyKey, artifact]));

  // Built BEFORE the live-job branch, not after it. The branch below needs exactly this list to decide
  // whether an existing forward covers the walk, and building it twice — once for the amend, once for the
  // enqueue — is how the two copies drift.
  const forwardArtifacts: GlassesWalkthroughForwardArtifact[] = fileResults.map((fileResult) => {
    const artifact = artifactsByKey.get(fileResult.idempotencyKey)!;
    return {
      fileId: fileResult.fileId,
      idempotencyKey: fileResult.idempotencyKey,
      kind: fileResult.kind,
      r2Key: fileResult.r2Key,
      mimeType: artifact.mimeType,
      originalFilename: artifact.originalFilename,
      fileSizeBytes: artifact.fileSizeBytes,
      capturedAtMs: artifact.capturedAtMs,
    };
  });

  const knownJobState = await findGlassesWalkthroughForwardJobState(tenantDb, input.walkId, input.dealId);

  if (knownJobState?.isLive) {
    // A live forward job is not proof the forward covers this walk, and treating it as one is how a walk
    // reaches TROCK Scope short. Mobile completes with whatever it has PUT and retries the whole call
    // later, and the artifact set it sends can GROW between attempts — most plainly when a walk is
    // recovered from its on-disk directory, whose stills the first manifest never listed. The `files` rows
    // for those extras land on the retry; the forward's payload used to stay frozen at the first call's
    // set, so the scope was extracted from a partial walk while the 201, the project folder and the queue
    // all reported a complete one. Nothing downstream can detect a missing clip — TROCK Scope only ever
    // sees what it is handed.
    const carriedKeys = new Set(knownJobState.artifacts.map((artifact) => artifact.idempotencyKey));
    const missing = forwardArtifacts.filter((artifact) => !carriedKeys.has(artifact.idempotencyKey));

    if (missing.length === 0) {
      // The ordinary duplicate: nothing new was filed, so this stays a pure read. Rewriting the payload on
      // every retry would put a write in the path of the most common request there is, against a row a
      // worker may be mid-checkpoint on, to change nothing.
      return {
        walkId: input.walkId,
        files: fileResults,
        forwarding: { status: "already_queued", jobId: knownJobState.jobId },
      };
    }

    // A UNION with what the row already holds, never this call's list written over it. The two are not the
    // same set: a recovered walk's manifest is assembled from a directory scan, not from the queue entry
    // that completed first, so it can legitimately OMIT an artifact the job is already scheduled to
    // forward. Overwriting would delete that clip from the forward — the same silent shortfall this branch
    // exists to close, pointed the other way. Existing entries are carried through VERBATIM, because a
    // worker or a reconciling human may have edited them and this call has no better information.
    const unionArtifacts = [...knownJobState.artifacts, ...missing];

    if (await amendPendingGlassesWalkthroughForwardArtifacts(tenantDb, knownJobState.jobId, unionArtifacts)) {
      return {
        walkId: input.walkId,
        files: fileResults,
        forwarding: { status: "artifacts_added", jobId: knownJobState.jobId },
      };
    }

    // Not pending. Two very different cases hide behind that, and conflating them was the defect: a
    // FINISHED row can be superseded safely because nothing is using it, whereas a row being WORKED
    // right now must keep its claim and its place in the live unique index until its handler stops —
    // otherwise a replacement can be inserted alongside a delivery that is still uploading. Finished
    // first, and the running case falls through to the branch below.
    if (
      await supersedeUnamendableGlassesWalkthroughForwardJob(
        tenantDb,
        knownJobState.jobId,
        unionArtifacts,
        buildSupersededForwardDeadLetterMessage({
          walkId: input.walkId,
          dealId: input.dealId,
          jobStatus: knownJobState.status,
          missingKeys: missing.map((artifact) => artifact.idempotencyKey),
          scopeWalkthroughId: knownJobState.scopeWalkthroughId,
        })
      )
    ) {
      return {
        walkId: input.walkId,
        files: fileResults,
        forwarding: { status: "superseded_for_reconciliation", jobId: knownJobState.jobId },
      };
    }

    // Being worked right now. The list is recorded BESIDE the one the handler is delivering and nothing
    // else is touched — see recordPendingArtifactsOnRunningForwardJob. The handler reads it back when it
    // finishes and dead-letters itself carrying the union, so the reconciliation still happens, at the one
    // moment it cannot race the delivery.
    if (await recordPendingArtifactsOnRunningForwardJob(tenantDb, knownJobState.jobId, unionArtifacts)) {
      return {
        walkId: input.walkId,
        files: fileResults,
        forwarding: { status: "reconciliation_pending", jobId: knownJobState.jobId },
      };
    }

    // No write matched: the row dead-lettered on its own between the lookup and here. That is the
    // replacement path below, not this branch — but re-deriving the inheritance from a second lookup
    // inside this branch would duplicate it, so the caller retries into the ordinary path instead. 503 for
    // the same reason the lost-race case at the end of this function is: the next attempt is expected to
    // succeed, and mobile already treats a failed completion as retryable.
    throw new AppError(
      503,
      `Forwarding for walk ${input.walkId} changed state while this completion was filing its artifacts. Retry.`
    );
  }

  const jobPayload: Record<string, unknown> = {
    walkId: input.walkId,
    dealId: input.dealId,
    projectId: input.projectId,
    title: input.title,
    siteLabel: input.siteLabel,
    capturedAt: input.capturedAt,
    capturedByUserId: input.userId,
    officeSlug: input.officeSlug,
    // The DEAD row's artifacts are inherited too, not just this call's list — the same union the live
    // branch above applies, for the same reason, and leaving it off here was an asymmetry with a real
    // casualty. A recovered manifest is assembled from a directory scan and can legitimately OMIT an
    // artifact the prior job carried; if that job died before the clip landed remotely, a retry
    // carrying [B,C] would replace a dead [A,B,C] payload with [B,C]. The replacement then succeeds,
    // reports success, and never forwards A — indistinguishable from a complete walk everywhere the
    // office looks.
    //
    // Safe to inherit unconditionally: `knownJobState` is only non-null here for a row that is dead
    // (a live one returns from the branch above), and the checkpoint carried forward below is taken
    // from that same row, so the artifacts and the checkpoint always describe one walk.
    artifacts: mergeForwardArtifacts(knownJobState?.artifacts ?? [], forwardArtifacts),
  };

  // Exactly one of the two markers is carried forward, never both — the worker reads `scopeWalkthroughId`
  // first and would silently downgrade an unresolved create into a settled one. A settled id lets the
  // replacement resume straight into clip upload (TROCK Scope's own checksum constraint rejects clip bytes
  // that already landed); an inherited pending marker makes it dead-letter immediately with the same
  // reconciliation instructions the original earned, which is the correct outcome — "a create may have
  // happened" is not information a retry can improve on, and guessing costs a duplicate scope extraction.
  if (knownJobState?.scopeWalkthroughId) {
    jobPayload.scopeWalkthroughId = knownJobState.scopeWalkthroughId;
    jobPayload.checkpointInheritedFromJobId = knownJobState.jobId;
  } else if (knownJobState?.scopeCreatePendingRef) {
    jobPayload.scopeCreatePendingRef = knownJobState.scopeCreatePendingRef;
    jobPayload.checkpointInheritedFromJobId = knownJobState.jobId;
  }

  // The enqueue ARBITRATES; the lookup above only short-circuits.
  //
  // `knownJobState` is a check-then-act guard, and no amount of care makes one safe on its own: the SELECT
  // takes no lock and 0211's index is not unique, so two completions for this pair that OVERLAP — mobile
  // retrying after its first response timed out in flight, the single likeliest retry there is — both read
  // "no live forward" and both reach this line. Before migration 0213 both then inserted: two remote
  // walkthroughs, two transcriptions, two Anthropic scope extractions, all really billed, for one walk,
  // with nothing recording it. `job_queue_glasses_walkthrough_forward_live_uniq` is what actually
  // serialises them — the loser's speculative insertion blocks until the winner commits and then does
  // nothing, so the pair is decided by the table rather than by two racing snapshots of it.
  //
  // The arbiter is UNTARGETED because it cannot be named: the index is on expressions
  // (`payload->>'walkId'`, `payload->>'dealId'`) and drizzle's conflict `target` is typed `IndexColumn =
  // PgColumn`, so an expression index has no expressible form there — unlike the `files` insert above,
  // whose target is a real column. That is safe here only because job_queue's ONLY other unique index is
  // its bigserial primary key, which this insert never supplies a value for and so can never violate. Add
  // another unique index to job_queue and this silently starts swallowing its violations too; at that point
  // this must become a hand-written INSERT ... ON CONFLICT ((payload->>'walkId'), (payload->>'dealId'))
  // WHERE ... DO NOTHING.
  //
  // No advisory lock alongside it: a lock only serialises callers that remember to take it, so it would
  // leave any future enqueue path unprotected while looking like protection, and it constrains nothing
  // about the rows that already exist. The index constrains the table.
  const jobRows = await tenantDb
    .insert(jobQueue)
    .values({
      jobType: GLASSES_WALKTHROUGH_FORWARD_JOB,
      payload: jobPayload,
      officeId: input.officeId,
      status: "pending",
      runAfter: new Date(),
      // Generous relative to the email/webhook jobs elsewhere in this codebase (typically 3-8): a
      // multi-clip multipart forward over real cellular/office network conditions has more independent
      // steps that can transiently fail than a single POST, and re-creating the whole walkthrough after
      // exhausting attempts is exactly the outcome the walkId-scoped checkpoint in the worker job exists
      // to avoid ever needing.
      maxAttempts: 10,
    })
    .onConflictDoNothing()
    .returning({ id: jobQueue.id });

  const enqueuedId = jobRows[0]?.id;
  if (enqueuedId != null) {
    return { walkId: input.walkId, files: fileResults, forwarding: { status: "queued", jobId: Number(enqueuedId) } };
  }

  // Lost the race. Re-read rather than reporting the insert we did not make: `Number(undefined)` is NaN,
  // and a response saying `{"status":"queued","jobId":null}` is indistinguishable from a forward that was
  // never scheduled — for the caller, for the logs, and for anyone later asking why a walk has no scope.
  // The re-read is a fresh statement, so under READ COMMITTED (what runInOfficeTransaction opens — see
  // field/cross-office.ts) it sees the winner the ON CONFLICT just waited for.
  const winner = await findGlassesWalkthroughForwardJobState(tenantDb, input.walkId, input.dealId);
  if (!winner?.isLive) {
    // The row that beat us is gone or already dead — the winning transaction rolled back after its
    // speculative insert, or a sweep killed it in the gap. Nothing was enqueued and nothing is inheritable,
    // so this is retryable, not a walk to report as forwarded. 503 rather than 500: the caller's next
    // attempt is expected to succeed, and mobile already treats a failed completion as retryable.
    throw new AppError(
      503,
      `Could not schedule forwarding for walk ${input.walkId}; a concurrent completion is in flight. Retry.`
    );
  }
  return { walkId: input.walkId, files: fileResults, forwarding: { status: "already_queued", jobId: winner.jobId } };
}

/** Test/UUID-shape helper exported for the mobile-contract report and validation tests; not applied as
 *  a hard requirement on idempotencyKey (see the module docblock — the existing producers don't either),
 *  but useful for callers that want to sanity-check their own key generation. */
export function looksLikeUuid(value: string): boolean {
  return UUID_LIKE.test(value);
}
