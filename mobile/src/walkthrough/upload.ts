/**
 * Durable, resumable upload queue for glasses walkthrough artifacts (video with muxed audio, plus N
 * photos).
 *
 * A completed walk's files already live under Documents/walkthroughs/<walkId>/ — native writes them
 * there directly (never `tmp`), so unlike the photo queue this module never copies a file into a
 * separate queue directory. Enqueuing a walk persists a JSON MANIFEST that references those files by
 * their existing uris; the manifest — not the files — is what has to survive an app kill/restart, and
 * what has to self-heal a rotated iOS container UUID (see rebaseWalkUris below).
 *
 * TWO-PHASE drain, mirroring the server's two-step contract:
 *   1. Per artifact: request a presigned R2 URL and PUT the bytes. Safe to repeat — the server derives
 *      the object key deterministically from (walkId, idempotencyKey), so re-PUTting the same artifact
 *      overwrites the same object rather than forking a duplicate.
 *   2. Once per walk, ONLY after every artifact has been PUT: call completion, which atomically writes
 *      every `files` row and enqueues forwarding. Local files are deleted ONLY after this call
 *      succeeds — see upload-core.ts's module header for why "bytes are in R2" and "the server filed
 *      the walk" are tracked as two separate, durable facts (putAt vs. completedAt).
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
import type { Walk } from "./session";
import {
  bumpArtifactAttempts,
  bumpCompletionAttempts,
  drainableArtifacts,
  isWalkDrainable,
  isWalkTerminal,
  markArtifactPut,
  markWalkCompleted,
  needsCompletion,
  removeQueuedWalk,
  resetTerminalWalkForRetry,
  sanitizeWalkOwnerKey,
  toQueuedWalk,
  upsertQueuedWalk,
  type QueuedWalk,
  type QueuedWalkArtifact,
  type WalkArtifactKind,
  type WalkQueueMeta,
} from "./upload-core";

export {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_WALK_COMPLETION_ATTEMPTS,
  MAX_WALK_UPLOAD_ATTEMPTS,
  drainableArtifacts,
  isArtifactDrainable,
  isArtifactPut,
  isArtifactTerminal,
  isCompletionTerminal,
  isWalkCompleted,
  isWalkDrainable,
  isWalkFullyPut,
  isWalkTerminal,
  needsCompletion,
  outstandingArtifacts,
  resetTerminalWalkForRetry,
  toQueuedWalk,
  walkArtifactIdempotencyKey,
  type QueuedWalk,
  type QueuedWalkArtifact,
  type WalkArtifactKind,
  type WalkQueueMeta,
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
// The walkthrough ingress endpoint (server/, worker/) is real as of commit e901547bc. This is the
// exact contract this queue is written against — not a bare fetch call, not a guessed URL.
// `drainWalkQueue` takes an implementation of `WalkthroughUploadClient` as a parameter; the ONLY
// thing that needs to change to go live is providing a real implementation at the call site
// (two thin functions mirroring createUploadUrl/confirmUpload in ../api/endpoints.ts). Nothing in
// this module or upload-core.ts needs to change.
//
//   Step 1 (per artifact) — POST /api/deals/:dealId/glasses-walkthroughs/artifacts/upload-url
//   Step 2 (once per walk, after every artifact is PUT) — POST /api/deals/:dealId/glasses-walkthroughs

export type WalkArtifactUploadUrlRequest = {
  walkId: string;
  idempotencyKey: string;
  kind: WalkArtifactKind;
  mimeType: string;
  fileSizeBytes: number;
};

export type WalkArtifactUploadUrlResponse = {
  uploadUrl: string;
  r2Key: string;
  expiresIn: number;
};

export type WalkCompletionArtifact = {
  idempotencyKey: string;
  kind: WalkArtifactKind;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  /** Epoch ms — QueuedWalkArtifact.at. */
  capturedAtMs: number;
};

export type WalkCompletionRequest = {
  walkId: string;
  title: string;
  siteLabel: string;
  projectId: string | null;
  /** ISO-8601 — converted from QueuedWalk.startedAt (epoch ms). */
  capturedAt: string;
  artifacts: WalkCompletionArtifact[];
};

export type WalkCompletionResponse = {
  walkId: string;
  /** Opaque to the client — the created `files` rows. Not consumed here. */
  files: unknown[];
  forwarding: { status: string; jobId: string | null };
};

/** THE SEAM. Everything in this module is written against this interface, never a bare fetch/URL.
 *  `dealId` is a separate parameter (not a body field) because it's the URL path segment on both
 *  real endpoints, not part of either request body. */
export type WalkthroughUploadClient = {
  requestUploadUrl(
    f: Fetcher,
    dealId: string,
    req: WalkArtifactUploadUrlRequest,
  ): Promise<WalkArtifactUploadUrlResponse>;
  completeWalk(f: Fetcher, dealId: string, req: WalkCompletionRequest): Promise<WalkCompletionResponse>;
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

// Serializes every manifest read-modify-write (enqueue vs. drain's per-artifact/per-walk mutations)
// so concurrent mutations can't clobber each other. Pure reads (getQueuedWalks) stay lock-free —
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

/** Count of walks that exhausted every retry available to them — drives a "failed" banner. */
export async function getFailedWalkCount(ownerKey: string): Promise<number> {
  return (await readManifest(ownerKey)).filter(isWalkTerminal).length;
}

/**
 * The retry path for whatever getFailedWalkCount is counting: resets every currently-TERMINAL
 * walk's retry counters (see resetTerminalWalkForRetry — never touches bytes already confirmed in
 * R2, never touches an actually-completed walk) so the NEXT drainWalkQueue call picks them back up
 * from wherever they left off. Does not itself drain — a caller (the retry UI) is expected to call
 * drainWalkQueue right after, same as enqueueWalk's caller does. Returns the number of walks reset,
 * so the UI can confirm something actually happened.
 */
export async function retryFailedWalks(ownerKey: string): Promise<number> {
  let resetCount = 0;
  await mutateManifest(ownerKey, (walks) =>
    walks.map((w) => {
      if (!isWalkTerminal(w)) return w;
      resetCount++;
      return resetTerminalWalkForRetry(w);
    }),
  );
  return resetCount;
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
  meta: WalkQueueMeta,
  now: number = Date.now(),
): Promise<QueuedWalk | null> {
  const queued = toQueuedWalk(walkId, walk, meta, now);
  if (!queued) return null;
  await mutateManifest(ownerKey, (walks) => upsertQueuedWalk(walks, queued));
  return queued;
}

// ── Drain ────────────────────────────────────────────────────────────────────────────────────────

function contentTypeForArtifact(kind: WalkArtifactKind, uri: string): string {
  const ext = uri.slice(uri.lastIndexOf(".") + 1).toLowerCase();
  if (kind === "photo") return ext === "png" ? "image/png" : "image/jpeg";
  if (kind === "video") return ext === "mov" ? "video/quicktime" : "video/mp4";
  return ext === "wav" ? "audio/wav" : "audio/mp4"; // m4a/aac/mp4 default
}

function filenameFromUri(uri: string): string {
  const withoutQuery = uri.split(/[?#]/)[0]!;
  const idx = withoutQuery.lastIndexOf("/");
  return idx >= 0 ? withoutQuery.slice(idx + 1) : withoutQuery;
}

/** Step 1: request a presigned URL and PUT one artifact's bytes. Returns the size that was actually
 *  uploaded (for markArtifactPut / the later completion payload). Throws on any failure — the caller
 *  bumps the artifact's attempt count and moves on. */
async function putArtifactBytes(
  client: WalkthroughUploadClient,
  f: Fetcher,
  walk: QueuedWalk,
  artifact: QueuedWalkArtifact,
): Promise<number> {
  const info = await FileSystem.getInfoAsync(artifact.uri);
  if (!info.exists) {
    throw new Error(`Walk artifact missing on disk: ${artifact.kind} ${artifact.idempotencyKey}`);
  }
  const mimeType = contentTypeForArtifact(artifact.kind, artifact.uri);
  const fileSizeBytes = typeof info.size === "number" ? info.size : 0;

  const { uploadUrl } = await client.requestUploadUrl(f, walk.dealId, {
    walkId: walk.walkId,
    idempotencyKey: artifact.idempotencyKey,
    kind: artifact.kind,
    mimeType,
    fileSizeBytes,
  });

  const put = await FileSystem.uploadAsync(uploadUrl, artifact.uri, {
    httpMethod: "PUT",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { "Content-Type": mimeType },
  });
  if (put.status < 200 || put.status >= 300) {
    throw new Error(`Walk artifact upload to storage failed (R2 returned ${put.status}).`);
  }
  return fileSizeBytes;
}

/** Step 2: the ONE completion call for a fully-put walk. Sizes/filenames come from the artifact
 *  records as they were AT PUT TIME (QueuedWalkArtifact.sizeBytes), not a fresh re-stat — that's
 *  exactly what was actually uploaded, and it doesn't require the file to still exist unchanged. */
async function callCompletion(
  client: WalkthroughUploadClient,
  f: Fetcher,
  walk: QueuedWalk,
): Promise<WalkCompletionResponse> {
  return client.completeWalk(f, walk.dealId, {
    walkId: walk.walkId,
    title: walk.title,
    siteLabel: walk.siteLabel,
    projectId: walk.projectId,
    capturedAt: new Date(walk.startedAt ?? Date.now()).toISOString(),
    artifacts: walk.artifacts.map((a) => ({
      idempotencyKey: a.idempotencyKey,
      kind: a.kind,
      originalFilename: filenameFromUri(a.uri),
      mimeType: contentTypeForArtifact(a.kind, a.uri),
      fileSizeBytes: a.sizeBytes ?? 0,
      capturedAtMs: a.at,
    })),
  });
}

export type WalkDrainSummary = {
  /** Artifacts whose bytes were successfully PUT to R2 this drain. */
  puts: number;
  putFailures: number;
  /** Walks whose completion call succeeded this drain (server accepted, local files deleted). */
  completed: number;
  completionFailures: number;
  remainingWalks: number;
};

// A drain must never run twice at once (foreground + background, or a double trigger): a second
// caller would re-PUT/re-complete in-flight work. Module-local guard — both entry points share this
// process, same as ../capture/upload-queue.ts's `draining` flag.
let draining = false;

/**
 * Upload everything currently queued for `ownerKey`. Walks drain oldest-enqueued first; within a
 * walk, every artifact is PUT (audio/video before photos — drainableArtifacts' order) before the
 * walk's ONE completion call is even attempted. A local file is deleted ONLY after that walk's
 * completion call has succeeded — never after an individual PUT, no matter how many artifacts show
 * putAt. Each step's outcome is persisted to the manifest IMMEDIATELY (not batched), so an
 * interrupted drain (app suspended, a short background window, or an outright crash) resumes at
 * worst the single PUT or completion call that was mid-flight; the resumed drain never re-attempts a
 * PUT already recorded as putAt, and it always re-attempts completion if completedAt was never
 * recorded — see upload-core.ts's module header for why that asymmetry is deliberate. Never throws —
 * returns a summary.
 */
export async function drainWalkQueue(
  ownerKey: string,
  fetcher: Fetcher,
  client: WalkthroughUploadClient,
  opts: { onProgress?: (summary: WalkDrainSummary) => void } = {},
): Promise<WalkDrainSummary> {
  if (draining) {
    return {
      puts: 0,
      putFailures: 0,
      completed: 0,
      completionFailures: 0,
      remainingWalks: (await getQueuedWalks(ownerKey)).length,
    };
  }
  draining = true;
  let keptAwake = false;
  try {
    const walks = await getQueuedWalks(ownerKey);
    const ordered = walks.filter(isWalkDrainable).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    if (ordered.length === 0) {
      return { puts: 0, putFailures: 0, completed: 0, completionFailures: 0, remainingWalks: walks.length };
    }

    try {
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      keptAwake = true;
    } catch {
      // Keep-awake is best-effort; draining continues without it.
    }

    let puts = 0;
    let putFailures = 0;
    let completed = 0;
    let completionFailures = 0;

    for (const walk of ordered) {
      // Phase 1: PUT every currently-drainable artifact's bytes.
      for (const artifact of drainableArtifacts(walk)) {
        try {
          const sizeBytes = await putArtifactBytes(client, fetcher, walk, artifact);
          await mutateManifest(ownerKey, (current) =>
            current.map((w) =>
              w.walkId === walk.walkId ? markArtifactPut(w, artifact.idempotencyKey, sizeBytes, Date.now()) : w,
            ),
          );
          puts++;
        } catch {
          await mutateManifest(ownerKey, (current) =>
            current.map((w) =>
              w.walkId === walk.walkId ? bumpArtifactAttempts(w, [artifact.idempotencyKey], Date.now()) : w,
            ),
          );
          putFailures++;
        }
      }

      // Phase 2: the walk's ONE completion call, only once every artifact is confirmed in R2.
      // Re-read first — phase 1 above may have just changed this walk's state, and a walk that was
      // ALREADY fully-put on entry (a prior drain PUT everything but never completed) never entered
      // the phase-1 loop at all (drainableArtifacts would be empty), so this is the only place its
      // completion gets attempted.
      const fresh = (await readManifest(ownerKey)).find((w) => w.walkId === walk.walkId);
      if (fresh && needsCompletion(fresh)) {
        try {
          await callCompletion(client, fetcher, fresh);
          // Persist completedAt BEFORE deleting anything: a crash between these two steps leaves at
          // worst a walk with local files still on disk that a future drain would try to re-complete
          // (harmless — the server dedupes on idempotencyKey) — never a walk whose files are gone
          // with no server record, which is the failure mode this ordering exists to prevent.
          await mutateManifest(ownerKey, (current) =>
            current.map((w) => (w.walkId === walk.walkId ? markWalkCompleted(w, Date.now()) : w)),
          );
          await Promise.all(
            fresh.artifacts.map((a) => FileSystem.deleteAsync(a.uri, { idempotent: true }).catch(() => undefined)),
          );
          // Every file is gone and the server has the walk — nothing left to track.
          await mutateManifest(ownerKey, (current) => removeQueuedWalk(current, walk.walkId));
          completed++;
        } catch {
          await mutateManifest(ownerKey, (current) =>
            current.map((w) => (w.walkId === walk.walkId ? bumpCompletionAttempts(w, Date.now()) : w)),
          );
          completionFailures++;
        }
      }
    }

    const remainingWalks = (await getQueuedWalks(ownerKey)).length;
    const summary = { puts, putFailures, completed, completionFailures, remainingWalks };
    opts.onProgress?.(summary);
    return summary;
  } finally {
    if (keptAwake) await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
    draining = false;
  }
}
