/**
 * Durable, resumable upload queue for glasses walkthrough artifacts (audio, video, stills).
 *
 * A completed walk's files already live under Documents/walkthroughs/<walkId>/ — native writes them
 * there directly (never `tmp`), so unlike the photo queue this module never copies a file into a
 * separate queue directory. Enqueuing a walk persists a JSON MANIFEST that references those files by
 * their existing uris; the manifest — not the files — is what has to survive an app kill/restart, and
 * what has to self-heal a rotated iOS container UUID (see rebaseWalkUris below).
 *
 * See ./upload-core.ts for why this deliberately does NOT reuse ../capture/upload-queue.ts's
 * machinery (enqueue-time compression, `staging`, GPS back-patch) even though the on-disk shape here
 * — crash-safe tmp+bak+rename manifest writes, an async mutex serializing read-modify-write, a
 * module-level `draining` guard, keep-awake during a drain — deliberately borrows its PATTERNS.
 */
import * as FileSystem from "expo-file-system/legacy";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import type { Fetcher } from "../api/endpoints";
import { rebaseDocumentDirectoryUri } from "../capture/doc-dir-uri";
import type { StillSource, Walk } from "./session";
import {
  bumpArtifactAttempts,
  drainableArtifacts,
  isWalkDrainable,
  isWalkFullyUploaded,
  isWalkTerminal,
  markArtifactsUploaded,
  removeQueuedWalk,
  sanitizeWalkOwnerKey,
  toQueuedWalk,
  upsertQueuedWalk,
  type QueuedWalk,
  type QueuedWalkArtifact,
  type WalkArtifactKind,
} from "./upload-core";

export {
  MAX_WALK_UPLOAD_ATTEMPTS,
  drainableArtifacts,
  isArtifactDrainable,
  isArtifactTerminal,
  isArtifactUploaded,
  isWalkDrainable,
  isWalkFullyUploaded,
  isWalkTerminal,
  outstandingArtifacts,
  toQueuedWalk,
  walkArtifactIdempotencyKey,
  type QueuedWalk,
  type QueuedWalkArtifact,
  type WalkArtifactKind,
} from "./upload-core";

const ROOT_DIR = `${FileSystem.documentDirectory ?? ""}walkthrough-uploads/`;
const KEEP_AWAKE_TAG = "trockcam-walkthrough-upload-queue";

function ownerDir(ownerKey: string): string {
  return `${ROOT_DIR}${sanitizeWalkOwnerKey(ownerKey)}/`;
}
function manifestFile(ownerKey: string): string {
  return `${ownerDir(ownerKey)}index.json`;
}

// ── SERVER CONTRACT SEAM ──────────────────────────────────────────────────────────────────────────
// The walkthrough ingress endpoint is being built concurrently (server/) and does not exist yet. This
// is the exact contract this queue is written against — not a real fetch call, not a guessed URL.
// `drainWalkQueue` takes an implementation of `WalkthroughUploadClient` as a parameter; the ONLY thing
// that needs to change once the server lands is providing a real implementation at the call site
// (almost certainly two thin functions in a new src/api/*.ts file, mirroring createUploadUrl /
// confirmUpload in ../api/endpoints.ts — see that file for the shape this deliberately follows).
// Nothing in this module or upload-core.ts needs to change.

export type WalkArtifactUploadUrlRequest = {
  dealId: string;
  projectId: string | null;
  walkId: string;
  kind: WalkArtifactKind;
  /** See QueuedWalkArtifact.idempotencyKey. The server must dedupe confirm-upload on this, exactly
   *  like clientUploadId does for photos (../api/types.ts ConfirmUploadRequest). */
  idempotencyKey: string;
  contentType: string;
  sizeBytes: number;
};

export type WalkArtifactUploadUrlResponse = {
  uploadUrl: string;
  objectKey: string;
  uploadToken: string;
};

export type WalkArtifactConfirmRequest = {
  dealId: string;
  projectId: string | null;
  walkId: string;
  kind: WalkArtifactKind;
  idempotencyKey: string;
  objectKey: string;
  uploadToken: string;
  /** Capture timestamp (epoch ms): a still's own `at`, or the walk's startedAt for audio/video. */
  capturedAt: number;
  /** Present only for a still. */
  source?: StillSource;
};

export type WalkArtifactConfirmResponse = {
  /** Server-assigned id for the stored artifact (e.g. a files/transcript row) — echoed back so a
   *  caller doesn't need a second round trip to learn it. */
  id: string;
};

/** THE SEAM. Everything in this module is written against this interface, never a bare fetch/URL. */
export type WalkthroughUploadClient = {
  requestUploadUrl(f: Fetcher, req: WalkArtifactUploadUrlRequest): Promise<WalkArtifactUploadUrlResponse>;
  confirmArtifactUpload(f: Fetcher, req: WalkArtifactConfirmRequest): Promise<WalkArtifactConfirmResponse>;
};

// ── Manifest read/write (crash-safe: tmp → primary → bak, same shape as ../capture/upload-queue.ts) ─

async function ensureDir(ownerKey: string): Promise<void> {
  const dir = ownerDir(ownerKey);
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
}

async function readManifestFile(file: string): Promise<QueuedWalk[] | null> {
  try {
    const info = await FileSystem.getInfoAsync(file);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(file);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedWalk[]) : null;
  } catch {
    return null;
  }
}

/**
 * Rebase every artifact uri in `walk` onto the LIVE document directory. enqueueWalk froze an ABSOLUTE
 * uri (rooted at documentDirectory) into the manifest; the iOS container UUID in that path rotates
 * across an app update/reinstall/restore, so a queued artifact's baked uri would fail its
 * FileSystem.getInfoAsync/uploadAsync at drain time. This is exactly the exposure
 * ../capture/doc-dir-uri.ts exists to close — see that module's header for the full story.
 */
function rebaseWalkUris(walk: QueuedWalk): QueuedWalk {
  const liveDocDir = FileSystem.documentDirectory;
  let changed = false;
  const artifacts = walk.artifacts.map((a) => {
    const rebased = rebaseDocumentDirectoryUri(a.uri, liveDocDir);
    if (rebased === a.uri) return a;
    changed = true;
    return { ...a, uri: rebased };
  });
  return changed ? { ...walk, artifacts } : walk;
}

async function readManifest(ownerKey: string): Promise<QueuedWalk[]> {
  const file = manifestFile(ownerKey);
  // Prefer a valid .tmp (an interrupted write's newest intended state), then the live manifest, then
  // the .bak from the previous successful write. Empty only when all three are unreadable.
  const raw =
    (await readManifestFile(`${file}.tmp`)) ??
    (await readManifestFile(file)) ??
    (await readManifestFile(`${file}.bak`)) ??
    [];
  return raw.map(rebaseWalkUris);
}

// Crash-safe manifest write: serialize to a temp file first, keep the prior manifest as .bak, then
// atomically rename the temp into place — the live manifest is never observed half-written.
async function writeManifest(ownerKey: string, walks: QueuedWalk[]): Promise<void> {
  await ensureDir(ownerKey);
  const file = manifestFile(ownerKey);
  const tmp = `${file}.tmp`;
  const bak = `${file}.bak`;
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify(walks));
  const current = await FileSystem.getInfoAsync(file);
  if (current.exists) {
    await FileSystem.deleteAsync(bak, { idempotent: true }).catch(() => undefined);
    await FileSystem.copyAsync({ from: file, to: bak }).catch(() => undefined);
    await FileSystem.deleteAsync(file, { idempotent: true });
  }
  await FileSystem.moveAsync({ from: tmp, to: file });
}

// Serializes every manifest read-modify-write (enqueue vs. drain's per-artifact mark/bump) so
// concurrent mutations can't clobber each other. Pure reads (getQueuedWalks) stay lock-free —
// writeManifest is atomic (tmp+move), so a read always sees a whole manifest, never a torn one.
function createMutex(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  const noop = () => undefined;
  return function run<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task, task);
    tail = result.then(noop, noop);
    return result;
  };
}
const withLock = createMutex();

async function mutateManifest(
  ownerKey: string,
  fn: (walks: QueuedWalk[]) => QueuedWalk[],
): Promise<QueuedWalk[]> {
  return withLock(async () => {
    const current = await readManifest(ownerKey);
    const next = fn(current);
    await writeManifest(ownerKey, next);
    return next;
  });
}

// ── Public read API ──────────────────────────────────────────────────────────────────────────────

export async function getQueuedWalks(ownerKey: string): Promise<QueuedWalk[]> {
  return readManifest(ownerKey);
}

/** Count of walks a drain should be scheduled for — used to gate a background-task invocation. */
export async function getSchedulableWalkCount(ownerKey: string): Promise<number> {
  return (await readManifest(ownerKey)).filter(isWalkDrainable).length;
}

/** Count of walks that exhausted every artifact's retries — drives a "failed" banner. */
export async function getFailedWalkCount(ownerKey: string): Promise<number> {
  return (await readManifest(ownerKey)).filter(isWalkTerminal).length;
}

// ── Enqueue ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Enqueue a completed (or failed) walk. Idempotent: calling this twice for the same walkId leaves the
 * existing entry — and any upload progress it has already made — untouched (see upsertQueuedWalk).
 * Returns null if `walk` has no terminal state yet, or produced no artifacts at all (see toQueuedWalk).
 */
export async function enqueueWalk(
  ownerKey: string,
  walkId: string,
  walk: Walk,
  now: number = Date.now(),
): Promise<QueuedWalk | null> {
  const queued = toQueuedWalk(walkId, walk, now);
  if (!queued) return null;
  await mutateManifest(ownerKey, (walks) => upsertQueuedWalk(walks, queued));
  return queued;
}

// ── Drain ────────────────────────────────────────────────────────────────────────────────────────

function contentTypeForArtifact(kind: WalkArtifactKind, uri: string): string {
  const ext = uri.slice(uri.lastIndexOf(".") + 1).toLowerCase();
  if (kind === "still") return ext === "png" ? "image/png" : "image/jpeg";
  if (kind === "video") return ext === "mov" ? "video/quicktime" : "video/mp4";
  return ext === "wav" ? "audio/wav" : "audio/mp4"; // m4a/aac/mp4 default
}

async function uploadArtifact(
  client: WalkthroughUploadClient,
  f: Fetcher,
  walk: QueuedWalk,
  artifact: QueuedWalkArtifact,
): Promise<WalkArtifactConfirmResponse> {
  const info = await FileSystem.getInfoAsync(artifact.uri);
  if (!info.exists) {
    throw new Error(`Walk artifact missing on disk: ${artifact.kind} ${artifact.idempotencyKey}`);
  }
  const contentType = contentTypeForArtifact(artifact.kind, artifact.uri);
  const sizeBytes = typeof info.size === "number" ? info.size : 0;

  const { uploadUrl, objectKey, uploadToken } = await client.requestUploadUrl(f, {
    dealId: walk.dealId,
    projectId: walk.projectId,
    walkId: walk.walkId,
    kind: artifact.kind,
    idempotencyKey: artifact.idempotencyKey,
    contentType,
    sizeBytes,
  });

  const put = await FileSystem.uploadAsync(uploadUrl, artifact.uri, {
    httpMethod: "PUT",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { "Content-Type": contentType },
  });
  if (put.status < 200 || put.status >= 300) {
    throw new Error(`Walk artifact upload to storage failed (R2 returned ${put.status}).`);
  }

  return client.confirmArtifactUpload(f, {
    dealId: walk.dealId,
    projectId: walk.projectId,
    walkId: walk.walkId,
    kind: artifact.kind,
    idempotencyKey: artifact.idempotencyKey,
    objectKey,
    uploadToken,
    capturedAt: artifact.at,
    source: artifact.source,
  });
}

export type WalkDrainSummary = {
  succeeded: number;
  failed: number;
  remainingWalks: number;
  /** idempotencyKey → server-confirmed artifact id, for every artifact THIS drain confirmed. */
  confirmedArtifactIds: Record<string, string>;
};

// A drain must never run twice at once (foreground + background, or a double trigger): a second
// caller would re-upload in-flight artifacts. Module-local guard — both entry points share this
// process, same as ../capture/upload-queue.ts's `draining` flag.
let draining = false;

/**
 * Upload everything currently queued for `ownerKey`. Walks drain oldest-enqueued first; within a
 * walk, audio/video land before stills (drainableArtifacts' order) — the transcript produces the
 * scope line items, the stills are evidence attached to it. Each artifact's outcome is persisted to
 * the manifest IMMEDIATELY (not batched at the end), so an interrupted drain (app suspended, a short
 * background window) resumes at worst the single artifact that was mid-flight. Never throws — returns
 * a summary. Safe to call repeatedly and from a background task once one is wired up (see the header
 * note in this file's report / the module's git history for why that wiring isn't included yet: it
 * depends on `client`, which depends on the server endpoint that doesn't exist yet).
 */
export async function drainWalkQueue(
  ownerKey: string,
  fetcher: Fetcher,
  client: WalkthroughUploadClient,
  opts: { onProgress?: (summary: WalkDrainSummary) => void } = {},
): Promise<WalkDrainSummary> {
  const confirmedArtifactIds: Record<string, string> = {};
  if (draining) {
    return {
      succeeded: 0,
      failed: 0,
      remainingWalks: (await getQueuedWalks(ownerKey)).length,
      confirmedArtifactIds,
    };
  }
  draining = true;
  let keptAwake = false;
  try {
    const walks = await getQueuedWalks(ownerKey);
    if (walks.length === 0) return { succeeded: 0, failed: 0, remainingWalks: 0, confirmedArtifactIds };

    try {
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      keptAwake = true;
    } catch {
      // Keep-awake is best-effort; draining continues without it.
    }

    let succeeded = 0;
    let failed = 0;
    const ordered = [...walks].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    for (const walk of ordered) {
      for (const artifact of drainableArtifacts(walk)) {
        try {
          const confirmed = await uploadArtifact(client, fetcher, walk, artifact);
          confirmedArtifactIds[artifact.idempotencyKey] = confirmed.id;
          // Persist the confirmation BEFORE deleting the local file: a crash between these two steps
          // leaves at worst a harmless orphaned file, never a "confirmed" artifact whose bytes are
          // already gone with no way to re-upload it. Never delete before this write lands.
          await mutateManifest(ownerKey, (current) =>
            current.map((w) =>
              w.walkId === walk.walkId ? markArtifactsUploaded(w, [artifact.idempotencyKey], Date.now()) : w,
            ),
          );
          await FileSystem.deleteAsync(artifact.uri, { idempotent: true }).catch(() => undefined);
          succeeded++;
        } catch {
          await mutateManifest(ownerKey, (current) =>
            current.map((w) =>
              w.walkId === walk.walkId ? bumpArtifactAttempts(w, [artifact.idempotencyKey], Date.now()) : w,
            ),
          );
          failed++;
        }
      }
      // Every artifact's file is already deleted the moment it's confirmed (above); once the whole
      // walk is done there's nothing left to track, so drop its manifest row.
      await mutateManifest(ownerKey, (current) => {
        const fresh = current.find((w) => w.walkId === walk.walkId);
        return fresh && isWalkFullyUploaded(fresh) ? removeQueuedWalk(current, walk.walkId) : current;
      });
    }

    const remainingWalks = (await getQueuedWalks(ownerKey)).length;
    const summary = { succeeded, failed, remainingWalks, confirmedArtifactIds };
    opts.onProgress?.(summary);
    return summary;
  } finally {
    if (keptAwake) await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
    draining = false;
  }
}
