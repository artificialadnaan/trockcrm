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
//     column width). No namespacing prefix: the existing producers (field photos, scorecard edit
//     evidence) do not prefix theirs either, and a client-generated key colliding by ACCIDENT across
//     producers is cryptographically negligible when the client follows the same convention (a fresh
//     UUID per artifact) documented in this module's report to the mobile team.
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { files, jobQueue } from "@trock-crm/shared/schema";
import type { FileCategory } from "@trock-crm/shared/types";
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

/** `files.client_upload_id` is `varchar(64)` (migration 0170) — the idempotency key's hard ceiling. */
export const MAX_GLASSES_WALKTHROUGH_IDEMPOTENCY_KEY_CHARS = 64;
export const MAX_GLASSES_WALKTHROUGH_ARTIFACTS_PER_WALK = 200;
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
  presignUpload: (
    r2Key: string,
    mimeType: string,
    fileSizeBytes: number
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
 */
export function deriveGlassesWalkthroughArtifactR2Key(
  officeSlug: string,
  dealId: string,
  walkId: string,
  idempotencyKey: string,
  extension: string
): string {
  const safeIdempotencyKey = encodeURIComponent(idempotencyKey);
  const safeWalkId = encodeURIComponent(walkId);
  return `${officeSlug}/deals/${dealId}/glasses-walkthroughs/${safeWalkId}/${safeIdempotencyKey}.${extension}`;
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
 */
export async function requestGlassesWalkthroughArtifactUploadUrl(args: {
  officeSlug: string;
  input: GlassesWalkthroughArtifactUploadUrlInput;
  artifactStore: GlassesWalkthroughArtifactStore;
}): Promise<GlassesWalkthroughArtifactUploadUrlResult> {
  const media = GLASSES_WALKTHROUGH_ACCEPTED_MEDIA[args.input.mimeType];
  const r2Key = deriveGlassesWalkthroughArtifactR2Key(
    args.officeSlug,
    args.input.dealId,
    args.input.walkId,
    args.input.idempotencyKey,
    media.extension
  );

  if (!args.artifactStore.isConfigured()) {
    // Dev/CI fallback, same posture as `generateMockUploadUrl` in r2-client.ts: a fake URL the caller
    // will never actually PUT bytes to, but a deterministic key so the completion endpoint's flow can
    // still be exercised end-to-end when R2 is not configured.
    return { uploadUrl: `mock://glasses-walkthrough/${r2Key}`, r2Key, expiresIn: 1800 };
  }

  const { uploadUrl, expiresIn } = await args.artifactStore.presignUpload(r2Key, args.input.mimeType, args.input.fileSizeBytes);
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
  | { status: "already_queued"; jobId: number };

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
 *     (files/service.ts) exactly, including the concurrent-race case it also handles.
 *   - PER WALK: retrying the WHOLE completion call (e.g. the mobile app never saw the first response)
 *     must not enqueue a SECOND forward job — TROCK Scope's `POST /walkthroughs` has no idempotency key
 *     of its own (see the report's TROCK Scope follow-up), so two jobs for one walk would create two
 *     walkthroughs there. Guarded by looking for a live (non-dead) `job_queue` row for this `walkId`
 *     before inserting a new one. This is a best-effort, non-transactional check (a concurrent duplicate
 *     completion call can race past it) — the same class of accepted residual as
 *     `rfp-bidboard-create.ts`'s own dealId-scoped dedupe reasoning: a rare duplicate FORWARD ATTEMPT is
 *     a wasted retry the worker's own per-walkthrough checkpoint (see the worker job) mostly absorbs, not
 *     silent data loss.
 *
 * Independence from forwarding: this function's own success/failure is determined ENTIRELY by the
 * `files` writes and the enqueue — never by whether TROCK Scope is reachable, because it never calls
 * TROCK Scope. That is what "if TROCK Scope is down, the crew's copy must still succeed" means at this
 * layer: forwarding literally cannot run synchronously with this call.
 */
export async function ingestGlassesWalkthrough(
  tenantDb: TenantDb,
  input: IngestGlassesWalkthroughInput,
  deps: { artifactStore: GlassesWalkthroughArtifactStore }
): Promise<IngestGlassesWalkthroughResult> {
  const bucket = getGlassesWalkthroughFileBucket();
  const fileResults: GlassesWalkthroughFileResult[] = [];
  // `input.capturedAt` is validated ISO-8601 by validateGlassesWalkthroughCompleteInput, so this is a
  // real epoch millis value, not NaN.
  const capturedAtBaseMs = new Date(input.capturedAt).getTime();

  for (const artifact of input.artifacts) {
    // Re-validated here (not just trusted from the route's earlier validation) — this module does not
    // trust its caller wholesale, matching the return path's own "the receiver does not trust the
    // sender" posture (walkthrough-ingress-service.ts), and this function is exported for direct/test
    // use, not only reachable through the route.
    const media = GLASSES_WALKTHROUGH_ACCEPTED_MEDIA[artifact.mimeType];
    if (!media || media.kind !== artifact.kind) {
      throw new AppError(400, `Artifact ${artifact.idempotencyKey} has an unsupported mimeType/kind pair.`);
    }

    const r2Key = deriveGlassesWalkthroughArtifactR2Key(
      input.officeSlug,
      input.dealId,
      input.walkId,
      artifact.idempotencyKey,
      media.extension
    );

    if (deps.artifactStore.isConfigured()) {
      let head: { contentType?: string; contentLength?: number } | null;
      try {
        head = await deps.artifactStore.head(r2Key);
      } catch {
        // R33: a throw means WE COULD NOT CHECK, not that the object is absent — retryable, never a 400.
        throw new AppError(
          503,
          `Could not verify artifact ${artifact.idempotencyKey}; object storage is unavailable. Retry.`
        );
      }
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

    const category: FileCategory = media.kind === "photo" ? "photo" : "other";
    const fileExtension = `.${media.extension}`;

    const inserted = await tenantDb
      .insert(files)
      .values({
        category,
        subcategory: GLASSES_WALKTHROUGH_SUBCATEGORY,
        folderPath: GLASSES_WALKTHROUGH_FOLDER_PATH,
        tags: [GLASSES_WALKTHROUGH_TAG, input.walkId],
        displayName: artifact.originalFilename,
        systemFilename: `glasses-walk-${artifact.idempotencyKey}${fileExtension}`,
        originalFilename: artifact.originalFilename,
        mimeType: artifact.mimeType,
        fileSizeBytes: artifact.fileSizeBytes,
        fileExtension,
        r2Key,
        r2Bucket: bucket,
        dealId: input.dealId,
        description: input.siteLabel ? `Glasses walkthrough — ${input.siteLabel}` : "Glasses walkthrough",
        uploadedBy: input.userId,
        clientUploadId: artifact.idempotencyKey,
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
      })
      // Mirrors confirmUpload (files/service.ts): a concurrent retry for the same idempotency key can
      // race past this insert too — let the partial unique index arbitrate rather than throw a 23505
      // into this request's transaction.
      .onConflictDoNothing({ target: files.clientUploadId, where: isNotNull(files.clientUploadId) })
      .returning();

    let fileRow = inserted[0];
    let created = true;
    if (!fileRow) {
      created = false;
      const existing = await tenantDb
        .select()
        .from(files)
        .where(eq(files.clientUploadId, artifact.idempotencyKey))
        .limit(1);
      fileRow = existing[0];
      if (!fileRow) {
        throw new AppError(409, `Artifact ${artifact.idempotencyKey} could not be filed. Please retry.`);
      }
      // A reused idempotency key pointed at a DIFFERENT deal is not a legitimate retry — refuse rather
      // than silently associating this walk's artifact list with someone else's file.
      if (fileRow.dealId !== input.dealId) {
        throw new AppError(
          409,
          `Artifact idempotency key ${artifact.idempotencyKey} is already associated with a different deal.`
        );
      }
    }

    fileResults.push({
      fileId: fileRow.id,
      idempotencyKey: artifact.idempotencyKey,
      kind: media.kind,
      r2Key: fileRow.r2Key,
      displayName: fileRow.displayName,
      created,
    });
  }

  const existingJob = await tenantDb
    .select({ id: jobQueue.id })
    .from(jobQueue)
    .where(
      and(
        eq(jobQueue.jobType, GLASSES_WALKTHROUGH_FORWARD_JOB),
        sql`${jobQueue.payload} ->> 'walkId' = ${input.walkId}`,
        sql`${jobQueue.status} <> 'dead'`
      )
    )
    .limit(1);

  if (existingJob[0]) {
    return {
      walkId: input.walkId,
      files: fileResults,
      forwarding: { status: "already_queued", jobId: Number(existingJob[0].id) },
    };
  }

  const jobPayload = {
    walkId: input.walkId,
    dealId: input.dealId,
    projectId: input.projectId,
    title: input.title,
    siteLabel: input.siteLabel,
    capturedAt: input.capturedAt,
    capturedByUserId: input.userId,
    officeSlug: input.officeSlug,
    artifacts: fileResults.map((fileResult, index) => ({
      fileId: fileResult.fileId,
      idempotencyKey: fileResult.idempotencyKey,
      kind: fileResult.kind,
      r2Key: fileResult.r2Key,
      mimeType: input.artifacts[index]!.mimeType,
      originalFilename: input.artifacts[index]!.originalFilename,
      fileSizeBytes: input.artifacts[index]!.fileSizeBytes,
      capturedAtMs: input.artifacts[index]!.capturedAtMs,
    })),
  };

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
    .returning({ id: jobQueue.id });

  const jobId = Number(jobRows[0]?.id);
  return { walkId: input.walkId, files: fileResults, forwarding: { status: "queued", jobId } };
}

/** Test/UUID-shape helper exported for the mobile-contract report and validation tests; not applied as
 *  a hard requirement on idempotencyKey (see the module docblock — the existing producers don't either),
 *  but useful for callers that want to sanity-check their own key generation. */
export function looksLikeUuid(value: string): boolean {
  return UUID_LIKE.test(value);
}
