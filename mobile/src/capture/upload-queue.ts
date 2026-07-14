import * as FileSystem from "expo-file-system/legacy";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import type { Fetcher } from "../api/endpoints";
import { runConcurrentUploads, uploadCapture, UploadCancelledError, type CaptureUploadInput } from "./upload";
import {
  UPLOAD_CONCURRENCY,
  applyGpsPatch,
  bumpAttempts,
  createAsyncMutex,
  dedupeQueue,
  isDrainable,
  partitionResults,
  removeIds,
  sanitizeOwnerKey,
  selectUploadFetcher,
  type QueuedUpload,
} from "./upload-queue-core";

export { MAX_UPLOAD_ATTEMPTS, UPLOAD_CONCURRENCY, dedupeQueue, newClientUploadId, partitionResults, removeIds, sanitizeOwnerKey, uploadOwnerKey, type QueuedUpload } from "./upload-queue-core";

/**
 * Durable, resumable upload queue for field photo captures.
 *
 * Photos are copied into the app's document directory and their metadata persisted to a JSON index BEFORE
 * upload, so a captured batch survives the app being backgrounded, killed, or losing connection — it
 * resumes on next launch (or from the background task). Each item carries a stable `clientUploadId`; the
 * server dedupes on it, so re-running an upload that already succeeded (app died after confirm, before we
 * removed it from the index) returns the existing photo instead of creating a duplicate.
 *
 * The queue is SCOPED PER OWNER (signed-in user id): every entry point takes an `ownerKey`, and items live
 * under `upload-queue/<ownerKey>/`. This prevents one user's queued photos from draining under the next
 * user who signs in on the same device — a cross-account disclosure the old global queue allowed.
 */

const ROOT_DIR = `${FileSystem.documentDirectory ?? ""}upload-queue/`;
const KEEP_AWAKE_TAG = "trockcam-upload-queue";
// Persist progress every this-many uploads so an interrupted drain re-runs at most one chunk on resume.
const DRAIN_CHUNK = 10;

function ownerDir(ownerKey: string): string {
  return `${ROOT_DIR}${sanitizeOwnerKey(ownerKey)}/`;
}
function indexFile(ownerKey: string): string {
  return `${ownerDir(ownerKey)}index.json`;
}

export type DrainSummary = { succeeded: number; failed: number; remaining: number };

// Serialize every index READ-MODIFY-WRITE for this process. enqueue / removeQueuedUploads / drain-commit
// each read a snapshot then write it back; run concurrently (remove-a-photo racing a submit's enqueue) they
// would clobber each other. Each mutation below reads AND writes inside this lock, so writes never race.
// Pure READS (getQueuedUploads/getQueuedCount/getFailedCount) stay lock-free — writeQueue is atomic
// (tmp+move), so a read always sees a whole index, never a torn one.
const withQueueLock = createAsyncMutex();

// Because enqueue copies the file OUTSIDE the lock, a removeQueuedUploads can run while a photo is still
// copying (before it's in the index). `enqueueing` holds ids currently mid-copy (registered under the
// lock); a concurrent cancel tombstones them in `cancelledMidEnqueue`, and enqueue drops the item instead
// of appending it. Both sets are consumed by the enqueue write → bounded, no leak.
const enqueueing = new Set<string>();
const cancelledMidEnqueue = new Set<string>();

// ── Disk-backed index + file lifecycle ─────────────────────────────────────────

async function ensureDir(ownerKey: string): Promise<void> {
  const dir = ownerDir(ownerKey);
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
}

// Read+parse one index file, or null if it's missing / truncated / unparseable.
async function readIndexFile(file: string): Promise<QueuedUpload[] | null> {
  try {
    const info = await FileSystem.getInfoAsync(file);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(file);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedUpload[]) : null;
  } catch {
    return null;
  }
}

async function readQueue(ownerKey: string): Promise<QueuedUpload[]> {
  const file = indexFile(ownerKey);
  // A leftover .tmp only exists when a write was interrupted before its final rename — and it holds the
  // NEWEST intended state (written in full before the rename). So prefer a VALID .tmp first (readIndexFile
  // returns null for a partial/corrupt one, in which case we fall through). This covers the window where
  // .tmp is the only complete copy (first write, or after the primary was cleared for the rename). Then the
  // live index, then the .bak from the previous successful write. Empty only when ALL are unreadable.
  const temp = await readIndexFile(`${file}.tmp`);
  if (temp !== null) return temp;
  const primary = await readIndexFile(file);
  if (primary !== null) return primary;
  const backup = await readIndexFile(`${file}.bak`);
  return backup ?? [];
}

// Crash-safe index write: serialize to a temp file FIRST (so the live index is never observed
// half-written), keep the prior index as .bak, then atomically rename the temp into place.
async function writeQueue(ownerKey: string, items: QueuedUpload[]): Promise<void> {
  await ensureDir(ownerKey);
  const file = indexFile(ownerKey);
  const tmp = `${file}.tmp`;
  const bak = `${file}.bak`;
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify(items));
  const current = await FileSystem.getInfoAsync(file);
  if (current.exists) {
    // Preserve a recoverable backup, then clear the slot so the rename can't fail on an existing dest.
    await FileSystem.deleteAsync(bak, { idempotent: true }).catch(() => undefined);
    await FileSystem.copyAsync({ from: file, to: bak }).catch(() => undefined);
    await FileSystem.deleteAsync(file, { idempotent: true });
  }
  await FileSystem.moveAsync({ from: tmp, to: file });
}

async function deleteQueuedFiles(items: QueuedUpload[]): Promise<void> {
  await Promise.all(
    items.map((item) => FileSystem.deleteAsync(item.uri, { idempotent: true }).catch(() => undefined)),
  );
}

export async function getQueuedUploads(ownerKey: string): Promise<QueuedUpload[]> {
  return readQueue(ownerKey);
}

/** True iff the id is still present in the queue — the drain's pre-confirm cancellation check. */
async function queueHasClientUploadId(ownerKey: string, clientUploadId: string): Promise<boolean> {
  return (await readQueue(ownerKey)).some((item) => item.clientUploadId === clientUploadId);
}

/** Count of still-DRAINABLE items (excludes terminal/failed) — drives the "waiting" banner + resume. */
export async function getQueuedCount(ownerKey: string): Promise<number> {
  return (await readQueue(ownerKey)).filter(isDrainable).length;
}

/** Count of TERMINAL items that exhausted their retries — drives the "failed" banner. */
export async function getFailedCount(ownerKey: string): Promise<number> {
  return (await readQueue(ownerKey)).filter((item) => !isDrainable(item)).length;
}

/** Discard the terminal/failed items (and their files) — the UI's "Dismiss failed" action. */
export async function clearFailedUploads(ownerKey: string): Promise<void> {
  await withQueueLock(async () => {
    const current = await readQueue(ownerKey);
    const failed = current.filter((item) => !isDrainable(item));
    if (failed.length === 0) return;
    await writeQueue(ownerKey, current.filter(isDrainable));
    await deleteQueuedFiles(failed);
  });
}

/**
 * Cancel specific queued uploads by clientUploadId (and delete their copied files). Used when scorecard
 * evidence is removed from a draft after a prior offline submit already enqueued it — otherwise a later
 * drain would still upload a photo that's no longer part of the card.
 */
export async function removeQueuedUploads(ownerKey: string, clientUploadIds: string[]): Promise<void> {
  if (clientUploadIds.length === 0) return;
  const ids = new Set(clientUploadIds);
  await withQueueLock(async () => {
    const current = await readQueue(ownerKey);
    const toRemove = current.filter((item) => ids.has(item.clientUploadId));
    // Tombstone any requested id whose enqueue copy is IN FLIGHT (not yet in the index) so the pending
    // write drops it instead of resurrecting removed evidence.
    for (const id of ids) if (enqueueing.has(id)) cancelledMidEnqueue.add(id);
    if (toRemove.length === 0) return;
    await writeQueue(ownerKey, current.filter((item) => !ids.has(item.clientUploadId)));
    await deleteQueuedFiles(toRemove);
  });
}

/**
 * Best-effort: stamp GPS coordinates onto a still-queued item — the DURABLE analogue of the old in-memory
 * back-patch. Used when a camera session's GPS fix lands after shots were already streamed coordless (so a
 * shot can be persisted immediately, before the fix, without losing geotags). Only fills a coordinate-LESS
 * item (never overwrites EXIF/existing coords) and is a no-op if the item has already uploaded/left the
 * queue. Returns true iff an item was patched.
 */
export async function patchQueuedMetadata(
  ownerKey: string,
  clientUploadId: string,
  coords: { latitude: number; longitude: number; addressSource?: "exif" | "live_gps" },
): Promise<boolean> {
  return withQueueLock(async () => {
    const { queue, changed } = applyGpsPatch(await readQueue(ownerKey), clientUploadId, coords);
    if (changed) await writeQueue(ownerKey, queue);
    return changed;
  });
}

/**
 * Copy each capture into durable storage and persist it to the index. The index is rewritten AFTER EACH
 * item is copied (not once at the end): if the app is killed mid-enqueue, every photo already copied is
 * recoverable from the index instead of being orphaned and lost. Returns the queued items.
 */
export async function enqueueUploads(
  ownerKey: string,
  inputs: CaptureUploadInput[],
): Promise<QueuedUpload[]> {
  if (inputs.length === 0) return [];
  await ensureDir(ownerKey);
  const dir = ownerDir(ownerKey);
  const queued: QueuedUpload[] = [];
  for (const input of inputs) {
    const id = input.clientUploadId;
    const ext = input.uri.includes(".") ? input.uri.slice(input.uri.lastIndexOf(".")) : ".jpg";
    const dest = `${dir}${id}${ext}`;
    // Register as in-flight under the lock, then copy OUTSIDE the lock — a large photo's copy is slow and
    // must not block removeQueuedUploads / drain re-selection during a big batch.
    await withQueueLock(async () => {
      enqueueing.add(id);
    });
    try {
      await FileSystem.copyAsync({ from: input.uri, to: dest });
    } catch (err) {
      // Copy failed — clear the in-flight marker (+ any tombstone) so `enqueueing` can't leak the id, then
      // rethrow (a copy failure still aborts the batch, as before).
      await withQueueLock(async () => {
        enqueueing.delete(id);
        cancelledMidEnqueue.delete(id);
      });
      throw err;
    }
    const item: QueuedUpload = { ...input, uri: dest, enqueuedAt: Date.now(), attempts: 0 };
    // Persist under the lock — but if a cancel arrived WHILE copying, drop the item (delete the copy)
    // instead of appending removed evidence. A crash right after the copy still recovers via the index.
    const cancelled = await withQueueLock(async () => {
      enqueueing.delete(id);
      if (cancelledMidEnqueue.delete(id)) return true;
      await writeQueue(ownerKey, dedupeQueue(await readQueue(ownerKey), [item]));
      return false;
    });
    if (cancelled) {
      await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => undefined);
      continue;
    }
    queued.push(item);
  }
  return queued;
}

/** Remove items (and their files) from the persisted index — used after a successful upload. */
async function removeQueuedItems(ownerKey: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await withQueueLock(async () => {
    const current = await readQueue(ownerKey);
    const toDelete = current.filter((item) => ids.includes(item.clientUploadId));
    await writeQueue(ownerKey, removeIds(current, ids));
    await deleteQueuedFiles(toDelete);
  });
}

/** Increment the failed-attempt counter for the given ids — moves them toward the terminal cap. */
async function recordFailedAttempts(ownerKey: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await withQueueLock(async () => {
    const current = await readQueue(ownerKey);
    await writeQueue(ownerKey, bumpAttempts(current, ids, Date.now()));
  });
}

export async function clearUploadQueue(ownerKey: string): Promise<void> {
  await withQueueLock(async () => {
    const current = await readQueue(ownerKey);
    await deleteQueuedFiles(current);
    await writeQueue(ownerKey, []);
  });
}

// A drain must never run twice at once (foreground + background, or a double tap): a second caller would
// re-upload in-flight items. Module-local guard — both entry points share this process.
let draining = false;

/**
 * Upload everything currently queued for `ownerKey`, with bounded concurrency and the screen kept awake.
 * Succeeded items are removed from the index; failures stay for the next drain/resume. Safe to call
 * repeatedly and from the background task. Never throws — returns a summary.
 */
export async function drainUploadQueue(
  ownerKey: string,
  fetcher: Fetcher,
  opts: {
    onProgress?: (summary: DrainSummary) => void;
    /** Headerless/target-resolving fetcher used only by explicitly marked scorecard-edit evidence. */
    targetFetcher?: Fetcher;
  } = {},
): Promise<DrainSummary> {
  if (draining) return { succeeded: 0, failed: 0, remaining: await getQueuedCount(ownerKey) };
  draining = true;
  let keptAwake = false;
  try {
    // Plan the drainable id order UNDER THE LOCK so the snapshot is consistent with any cancellation that
    // has already completed (terminal/failed items are left for the UI to surface + discard, never re-PUT).
    const planned = await withQueueLock(async () => {
      const queue = await readQueue(ownerKey);
      return { ids: queue.filter(isDrainable).map((item) => item.clientUploadId), total: queue.length };
    });
    const plannedIds = planned.ids;
    // Nothing drainable, but report the ACTUAL queue size as `remaining` — terminal/failed items still sit
    // in the queue (surfaced/dismissed via the UI), so hardcoding 0 would hide them from the caller.
    if (plannedIds.length === 0) return { succeeded: 0, failed: 0, remaining: planned.total };

    try {
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      keptAwake = true;
    } catch {
      // Keep-awake is best-effort; draining continues without it.
    }

    // Drain in persisted chunks: after each chunk, remove its successes from the index and bump the
    // attempt counter on failures. So an interrupt (app suspended / short iOS window) re-uploads at MOST
    // one chunk's worth next time, and a permanently-failing item climbs toward the terminal cap instead
    // of retrying forever.
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < plannedIds.length; i += DRAIN_CHUNK) {
      const chunkIds = plannedIds.slice(i, i + DRAIN_CHUNK);
      // Re-select the items STILL queued + drainable right now, under the lock: a removeQueuedUploads that
      // landed since the plan (user pulled a photo off the card) cancels it — so we never upload evidence
      // the user just removed, and never touch a file another mutation deleted.
      const chunk = await withQueueLock(async () => {
        const byId = new Map((await readQueue(ownerKey)).map((item) => [item.clientUploadId, item]));
        return chunkIds
          .map((id) => byId.get(id))
          .filter((item): item is QueuedUpload => !!item && isDrainable(item));
      });
      if (chunk.length === 0) continue;
      const results = await runConcurrentUploads(chunk, UPLOAD_CONCURRENCY, (item) =>
        // Re-check right before the confirm step: if the item was cancelled while this chunk was uploading
        // (user pulled a photo off the card), skip confirm so the removed evidence never links to the deal.
        uploadCapture(
          selectUploadFetcher(item, fetcher, opts.targetFetcher),
          item,
          { shouldConfirm: () => queueHasClientUploadId(ownerKey, item.clientUploadId) },
        ),
      );
      // A cancelled upload (photo removed mid-flight → confirm skipped) is neither a success nor a failure:
      // it was intentionally dropped + already removed from the index, so exclude it from
      // partitionResults/recordFailedAttempts rather than counting it as failed or bumping its attempts.
      const liveChunk: QueuedUpload[] = [];
      const liveResults: PromiseSettledResult<unknown>[] = [];
      chunk.forEach((item, i) => {
        const r = results[i];
        if (r && r.status === "rejected" && r.reason instanceof UploadCancelledError) return;
        liveChunk.push(item);
        liveResults.push(r);
      });
      const { succeededIds, failedIds } = partitionResults(liveChunk, liveResults);
      await removeQueuedItems(ownerKey, succeededIds);
      await recordFailedAttempts(ownerKey, failedIds);
      succeeded += succeededIds.length;
      failed += failedIds.length;
    }

    const remaining = await getQueuedCount(ownerKey);
    const summary = { succeeded, failed, remaining };
    opts.onProgress?.(summary);
    return summary;
  } finally {
    if (keptAwake) await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
    draining = false;
  }
}
