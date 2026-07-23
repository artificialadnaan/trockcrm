import * as FileSystem from "expo-file-system/legacy";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import type { Fetcher } from "../api/endpoints";
import { runConcurrentUploads, uploadCapture, UploadCancelledError, type CaptureUploadInput } from "./upload";
import { compressForEnqueue } from "./compress";
import {
  UPLOAD_CONCURRENCY,
  COMPRESS_CONCURRENCY,
  applyGpsPatch,
  bumpAttempts,
  collectEnqueueResults,
  createAsyncMutex,
  createBoundedRunner,
  dedupeQueue,
  isDrainable,
  isSchedulable,
  isTerminal,
  partitionResults,
  removeIds,
  sanitizeOwnerKey,
  selectOrphanFiles,
  selectUploadFetcher,
  type QueuedUpload,
} from "./upload-queue-core";
import { isDurableStoreUri, reconstructDurablePhotoUri } from "./doc-dir-uri";

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

export type DrainSummary = {
  succeeded: number;
  failed: number;
  remaining: number;
  /**
   * Map of clientUploadId → confirmed server file id for every photo this drain successfully confirmed. Lets a
   * caller that needs the real file id (e.g. the corrective-action response, which links evidence by file id)
   * read it straight from the drain instead of re-uploading each photo a second time. Only covers photos
   * confirmed in THIS drain — a photo confirmed by an earlier drain has already left the queue.
   */
  confirmedFileIds: Record<string, string>;
};

// Serialize every index READ-MODIFY-WRITE for this process. enqueue / removeQueuedUploads / drain-commit
// each read a snapshot then write it back; run concurrently (remove-a-photo racing a submit's enqueue) they
// would clobber each other. Each mutation below reads AND writes inside this lock, so writes never race.
// Pure READS (getQueuedUploads/getQueuedCount/getFailedCount) stay lock-free — writeQueue is atomic
// (tmp+move), so a read always sees a whole index, never a torn one.
const withQueueLock = createAsyncMutex();

// One shared runner bounds the expensive POST-PERSIST compression work — the decode/encode plus staging the
// compressed copy — across ALL (fire-and-forget) enqueueUploads calls. It does NOT wrap the initial durable
// copy + index write: per-photo capture doesn't await onCapture, so a burst can fire >COMPRESS_CONCURRENCY
// concurrent enqueues, and if the durable copy sat BEHIND this bounded slot, the 4th+ capture would wait in
// memory (its camera-cache uri never copied/indexed) — an app kill during that wait loses it permanently
// (worse when camera-roll backup is off/unavailable). So we persist the original FIRST (unbounded, cheap:
// one copyAsync + a locked index write), THEN bound only the heavy compression. The full-res originals held
// on disk between persist and compression are the durable record we WANT; the bound caps concurrent DECODES
// (the memory/CPU spike), not the durable working set. (The per-id claim under the lock is likewise
// UNBOUNDED so a burst can't starve claiming.)
const runCompression = createBoundedRunner(COMPRESS_CONCURRENCY);

// Because enqueue copies the file OUTSIDE the lock, a removeQueuedUploads can run while a photo is still
// copying (before it's in the index). `enqueueing` maps an id currently mid-enqueue → that enqueue's
// COMPLETION promise (registered under the lock); a concurrent cancel tombstones the id in
// `cancelledMidEnqueue`, and enqueue drops the item instead of appending it. The promise lets a DUPLICATE
// enqueue of the same id (e.g. a double-tapped Retry) AWAIT the in-flight one's durability instead of
// resolving early — otherwise the caller could delete the review-draft while the first worker still needs it.
const enqueueing = new Map<string, Promise<QueuedUpload | null>>();
const cancelledMidEnqueue = new Set<string>();
// A discard removes queue rows first, then waits for any worker that had already selected one of those ids.
// Without this small registry, confirm-upload could still be in flight while the server cleanup runs, land
// just after cleanup returns, and recreate the exact orphan the discard path is designed to prevent.
const activeUploadPromises = new Map<string, Promise<unknown>>();

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

// Rebase each queued item's uri onto the LIVE owner directory. enqueueUploads froze an ABSOLUTE uri
// (rooted at documentDirectory) into the index; the iOS container UUID in that path rotates across an app
// update/reinstall/restore, so a queued photo's baked uri would fail its FileSystem.copyAsync at drain time.
// Durable copies are named deterministically (`<ownerDir>/<clientUploadId><ext>`), so rebuild the current
// path from the live ownerDir + clientUploadId. Non-durable/legacy uris are left untouched.
function rebaseQueuedUris(ownerKey: string, items: QueuedUpload[]): QueuedUpload[] {
  const dir = ownerDir(ownerKey);
  return items.map((item) => {
    if (!isDurableStoreUri(item.uri, FileSystem.documentDirectory)) return item;
    const rebased = reconstructDurablePhotoUri(item.uri, dir, item.clientUploadId);
    return rebased === item.uri ? item : { ...item, uri: rebased };
  });
}

async function readQueue(ownerKey: string): Promise<QueuedUpload[]> {
  const file = indexFile(ownerKey);
  // A leftover .tmp only exists when a write was interrupted before its final rename — and it holds the
  // NEWEST intended state (written in full before the rename). So prefer a VALID .tmp first (readIndexFile
  // returns null for a partial/corrupt one, in which case we fall through). This covers the window where
  // .tmp is the only complete copy (first write, or after the primary was cleared for the rename). Then the
  // live index, then the .bak from the previous successful write. Empty only when ALL are unreadable.
  const temp = await readIndexFile(`${file}.tmp`);
  if (temp !== null) return rebaseQueuedUris(ownerKey, temp);
  const primary = await readIndexFile(file);
  if (primary !== null) return rebaseQueuedUris(ownerKey, primary);
  const backup = await readIndexFile(`${file}.bak`);
  return backup ? rebaseQueuedUris(ownerKey, backup) : [];
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

/** Count of still-DRAINABLE items (excludes terminal/failed AND transient mid-enqueue staging rows) — drives
 *  the "waiting" banner. NOT the scheduling gate: a lone staging row is 0 here but still needs a drain (see
 *  getSchedulableCount), so a drain-decision must key on THAT, not this. */
export async function getQueuedCount(ownerKey: string): Promise<number> {
  return (await readQueue(ownerKey)).filter(isDrainable).length;
}

/** Count of items a drain should be SCHEDULED for: drainable now OR a mid-enqueue `staging` row that
 *  reconciliation (inside drainUploadQueue) will unstick. Used ONLY by the "should we kick a drain?" gates —
 *  a lone interrupted capture (a staging row with no live worker) is 0 by getQueuedCount but >0 here, so the
 *  drain that reconciles + ships it actually runs instead of the row staying hidden indefinitely. */
export async function getSchedulableCount(ownerKey: string): Promise<number> {
  return (await readQueue(ownerKey)).filter(isSchedulable).length;
}

/** Count of TERMINAL items that exhausted their retries — drives the "failed" banner. Keys on isTerminal, not
 *  `!isDrainable`, so a transient mid-enqueue `staging` row is never miscounted as failed. */
export async function getFailedCount(ownerKey: string): Promise<number> {
  return (await readQueue(ownerKey)).filter(isTerminal).length;
}

/** Discard the terminal/failed items (and their files) — the UI's "Dismiss failed" action. Only TERMINAL
 *  rows are removed; a `staging` row (still enqueuing) is left alone so its in-flight worker isn't rug-pulled. */
export async function clearFailedUploads(ownerKey: string): Promise<void> {
  await withQueueLock(async () => {
    const current = await readQueue(ownerKey);
    const failed = current.filter(isTerminal);
    if (failed.length === 0) return;
    await writeQueue(ownerKey, current.filter((item) => !isTerminal(item)));
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
 * Cancel queued ids and wait for already-started workers to settle. A worker still waiting in a selected
 * chunk will observe the missing queue row in `shouldConfirm` and cannot create a gallery record; a worker
 * whose confirm was already in flight is awaited so the caller's subsequent server reconciliation sees it.
 */
export async function removeQueuedUploadsAndWait(ownerKey: string, clientUploadIds: string[]): Promise<void> {
  await removeQueuedUploads(ownerKey, clientUploadIds);
  const ids = new Set(clientUploadIds);
  const active = [...activeUploadPromises.entries()]
    .filter(([id]) => ids.has(id))
    .map(([, promise]) => promise);
  if (active.length > 0) await Promise.allSettled(active);
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
 * Copy each capture into durable storage and persist it to the index. Items run CONCURRENTLY (compression is
 * bounded by the shared runner), but the index is rewritten AFTER EACH item is copied (not once at the end):
 * if the app is killed mid-enqueue, every photo already copied is recoverable from the index instead of being
 * orphaned and lost. Ids already durably queued (e.g. a scorecard retry) are skipped rather than re-copied.
 * Returns the newly queued items (skipped ids are omitted).
 */
export async function enqueueUploads(
  ownerKey: string,
  inputs: CaptureUploadInput[],
): Promise<QueuedUpload[]> {
  if (inputs.length === 0) return [];
  await ensureDir(ownerKey);
  const dir = ownerDir(ownerKey);
  // Snapshot the ids ALREADY durably queued. A scorecard retry re-enqueues every newPhoto under its
  // capture-stamped (stable) clientUploadId, and dedupeQueue keeps the OLD row on conflict — so without this,
  // enqueueOne would still compress + copyAsync-OVERWRITE the durable file of a row that survives unchanged,
  // stranding a legacy row's `compressed` flag / stale sizeBytes (→ a needless second lossy encode at drain)
  // and burning a full-res compression per retry. We skip those ids entirely below. Same-batch / concurrent
  // duplicates are caught by the in-flight `enqueueing` set; the persist-time dedupeQueue is the last backstop.
  const alreadyQueued = await withQueueLock(
    async () => new Set((await readQueue(ownerKey)).map((q) => q.clientUploadId)),
  );
  // Process items CONCURRENTLY. The compression bottleneck is capped by runCompression
  // (COMPRESS_CONCURRENCY) ACROSS the whole batch, so a multi-photo submit (e.g. a scorecard) no longer pays
  // the SUM of every compression before the drain can start — it pays roughly ceil(N / COMPRESS_CONCURRENCY)
  // waves. Each item still persists INDIVIDUALLY (its index write under the lock, after its own copy), so a
  // kill mid-enqueue still leaves every already-indexed photo recoverable.
  const enqueueOne = async (input: CaptureUploadInput): Promise<QueuedUpload | null> => {
    const id = input.clientUploadId;
    // Claim / attach under the lock. THREE outcomes:
    //  - SKIP: the id is already DURABLY queued (a prior batch) → nothing to do; the caller may safely drop its
    //    review-draft, since the queue already owns the photo.
    //  - AWAIT: another caller is MID-enqueue for this id (in-flight, NOT yet durable). We must NOT report
    //    success early — retryFailedShots (capture.tsx) deletes the review-draft on any resolution, and doing so
    //    while the first worker is still reading the file loses the photo if that worker then fails. So mirror
    //    the in-flight enqueue's promise: resolve only once it's durable, reject if it fails.
    //  - OWN: we're the first → register our completion promise so a concurrent duplicate can await it.
    let settleOwn!: (v: QueuedUpload | null) => void;
    let failOwn!: (e: unknown) => void;
    const own = new Promise<QueuedUpload | null>((res, rej) => {
      settleOwn = res;
      failOwn = rej;
    });
    own.catch(() => {}); // no unhandled-rejection if this enqueue fails and no duplicate ever attaches
    // The locked section returns a NON-promise tag. Returning the in-flight PROMISE here would make
    // withQueueLock assimilate it — the mutex would stay held until that enqueue settles, but the OWNING enqueue
    // needs the SAME mutex to persist + release, so both would deadlock. Await the promise AFTER the lock.
    const decision = await withQueueLock(async () => {
      if (alreadyQueued.has(id)) return { kind: "skip" as const };
      const inflight = enqueueing.get(id);
      if (inflight) return { kind: "await" as const, inflight };
      enqueueing.set(id, own);
      return { kind: "own" as const };
    });
    if (decision.kind === "skip") return null;
    if (decision.kind === "await") return decision.inflight; // await the in-flight enqueue OUTSIDE the mutex

    // We OWN this id. Run the actual enqueue; whatever happens, settle `own` for any awaiter AND release the id
    // (copy + compress run OUTSIDE the lock — both are slow and must not block removeQueuedUploads / the drain).
    let result: QueuedUpload | null = null;
    let error: unknown;
    try {
      // Persist the ORIGINAL into the durable queue BEFORE the slow compression, then stage the compressed bytes
      // to a SEPARATE durable path and switch the row only once that file is COMPLETE — the original is
      // preserved until then, so a torn write (app kill / disk full) mid-compressed-copy can never leave the row
      // pointing at a damaged file. streamPhoto (per-photo capture) doesn't await onCapture and has no other
      // durable copy, so compressing first would lose the photo on a mid-compress kill. The `compressed` flag
      // (NOT the extension) tells the drain whether it still needs to compress.
      const origPath = `${dir}${id}.orig`;
      const jpgPath = `${dir}${id}.jpg`;
      // CRITICAL: the durable copy + index write happen UNBOUNDED (before acquiring a compression slot). A burst
      // of per-photo captures can fire >COMPRESS_CONCURRENCY concurrent enqueues; if this copy waited behind the
      // bounded compression queue, the camera-cache uri of the 4th+ capture would sit uncopied/unindexed, and an
      // app kill during that wait would lose it forever. Persisting first makes every captured photo recoverable
      // the instant it's enqueued; only the heavy DECODE is bounded (runCompression) below.
      await FileSystem.copyAsync({ from: input.uri, to: origPath });
      // `staging: true` keeps this durable row NON-DRAINABLE (isDrainable) until compression finishes: the
      // original is recoverable on a kill, but the drain won't pick it up and spin a SECOND compression
      // concurrent with this one (which would push in-flight encodes past COMPRESS_CONCURRENCY → the jank/OOM
      // path). Cleared on the compressed-file switch, and on the fallback path below.
      const original: QueuedUpload = { ...input, uri: origPath, sizeBytes: 0, compressed: false, staging: true, enqueuedAt: Date.now(), attempts: 0 };
      // Persist under the lock — if a cancel arrived WHILE copying, drop the item (delete the copy) instead of
      // appending removed evidence.
      const cancelledAtPersist = await withQueueLock(async () => {
        if (cancelledMidEnqueue.delete(id)) return true;
        await writeQueue(ownerKey, dedupeQueue(await readQueue(ownerKey), [original]));
        return false;
      });
      if (cancelledAtPersist) {
        await FileSystem.deleteAsync(origPath, { idempotent: true }).catch(() => undefined);
        result = null;
      } else {
        // Bound ONLY the post-persist compression work. If a burst has all slots busy, the durable original is
        // ALREADY on disk + indexed (as a `staging` row), so a kill while this waits still leaves the photo
        // recoverable — reconciliation unsticks it to `staging:false` and the drain re-compresses it at upload.
        result = await runCompression(async () => {
          // Compress the durable original into a SEPARATE file; the original row stays valid until the switch.
          const { sourceUri, sizeBytes } = await compressForEnqueue(origPath, input.width, input.height);
          const producedJpeg = sourceUri !== origPath; // a fresh compressed temp, vs the fallback returning origPath
          let stagedJpg = false;
          if (producedJpeg) {
            try {
              await FileSystem.copyAsync({ from: sourceUri, to: jpgPath }); // SEPARATE path — original untouched
              stagedJpg = true;
            } catch {
              // Staging the compressed file failed (e.g. disk pressure) — discard the partial; keep the original.
              await FileSystem.deleteAsync(jpgPath, { idempotent: true }).catch(() => undefined);
            } finally {
              await FileSystem.deleteAsync(sourceUri, { idempotent: true }).catch(() => undefined);
            }
          }
          if (stagedJpg) {
            // Switch the row to the COMPLETE compressed file (only if still queued), then remove the original.
            // Clearing `staging` here makes the now-compressed row drainable.
            const switched = await withQueueLock(async () => {
              if (cancelledMidEnqueue.has(id)) return false;
              const q = await readQueue(ownerKey);
              const i = q.findIndex((it) => it.clientUploadId === id);
              if (i < 0) return false;
              q[i] = { ...q[i], uri: jpgPath, compressed: true, sizeBytes, staging: false };
              await writeQueue(ownerKey, q);
              return true;
            });
            if (switched) {
              await FileSystem.deleteAsync(origPath, { idempotent: true }).catch(() => undefined); // no longer referenced
              return { ...original, uri: jpgPath, compressed: true, sizeBytes, staging: false };
            }
            // Removed/cancelled during staging — clean up BOTH files.
            await FileSystem.deleteAsync(jpgPath, { idempotent: true }).catch(() => undefined);
            await FileSystem.deleteAsync(origPath, { idempotent: true }).catch(() => undefined);
            return null;
          }
          // Compression fell back (or staging failed) — the durable original stays (compressed:false); the drain
          // compresses it at upload. Clear `staging` so the row becomes drainable (only if still queued + not
          // cancelled), then hand back the drainable row.
          const clearedOriginal: QueuedUpload = { ...original, staging: false };
          await withQueueLock(async () => {
            if (cancelledMidEnqueue.has(id)) return;
            const q = await readQueue(ownerKey);
            const i = q.findIndex((it) => it.clientUploadId === id);
            if (i < 0) return;
            q[i] = { ...q[i], staging: false };
            await writeQueue(ownerKey, q);
          });
          return clearedOriginal;
        });
      }
    } catch (e) {
      error = e;
    }
    // Release the id (only if it's still OUR promise) and settle it for any awaiting duplicate — the id stays
    // in-flight until HERE (after the durable persist), so a duplicate awaits real durability.
    await withQueueLock(async () => {
      if (enqueueing.get(id) === own) enqueueing.delete(id);
      cancelledMidEnqueue.delete(id); // clear any lingering tombstone on every exit path
    });
    if (error !== undefined) {
      failOwn(error);
      throw error;
    }
    settleOwn(result);
    return result;
  };

  // allSettled (not all): WAIT for every worker to finish before propagating a copy failure, so none is still
  // writing a dest file / the queue index when the scorecard screen catches the rejection and re-enables
  // submit (an immediate retry would otherwise overlap the same files). A copy failure still aborts the whole
  // batch — collectEnqueueResults rethrows the first rejection after all have settled.
  const settled = await Promise.allSettled(inputs.map((input) => enqueueOne(input)));
  return collectEnqueueResults(settled);
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

/**
 * Self-heal the owner's storage before a drain. Two leaks an interrupted enqueue can leave behind:
 *
 *  1. STUCK STAGING ROWS — a row persisted `staging: true` whose enqueue then died (app killed mid-compress, or
 *     a rare lock-write throw) with no live enqueue owning it. It would sit non-drainable forever. We clear
 *     `staging` on any indexed row NOT currently mid-enqueue, so the original drains (and gets re-compressed at
 *     upload) instead of stranding.
 *  2. ORPHANED STAGING FILES — a `<id>.orig` / `<id>.jpg` on disk that no live index row references (killed
 *     mid-copy before the row switch, or left as the pre-switch sibling). The normal cleanup only deletes
 *     `item.uri`, so these leak. We delete every staging file not referenced by the (post-unstick) index.
 *
 * Runs under the queue lock so it can't race a concurrent enqueue's persist/switch. Best-effort throughout —
 * a directory-list or delete failure never blocks the drain.
 */
async function reconcileOwnerStorage(ownerKey: string): Promise<void> {
  await withQueueLock(async () => {
    const queue = await readQueue(ownerKey);
    // Unstick any staging row whose enqueue is no longer in flight (nothing left to complete the switch).
    let changed = false;
    const unstuck = queue.map((item) => {
      if (item.staging === true && !enqueueing.has(item.clientUploadId)) {
        changed = true;
        return { ...item, staging: false };
      }
      return item;
    });
    if (changed) await writeQueue(ownerKey, unstuck);

    // Reclaim staging files no live row references. Skip ids still mid-enqueue: their in-flight worker owns
    // both `<id>.orig` and `<id>.jpg` and hasn't finished the switch, so neither is an orphan yet.
    let names: string[];
    try {
      names = await FileSystem.readDirectoryAsync(ownerDir(ownerKey));
    } catch {
      return; // dir missing / unreadable — nothing to reclaim
    }
    const inflight = enqueueing;
    const candidates = names.filter((name) => {
      const id = name.slice(0, name.lastIndexOf("."));
      return !inflight.has(id);
    });
    const orphans = selectOrphanFiles(candidates, unstuck);
    await Promise.all(
      orphans.map((name) =>
        FileSystem.deleteAsync(`${ownerDir(ownerKey)}${name}`, { idempotent: true }).catch(() => undefined),
      ),
    );
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
    /** Normal-session fetcher used only by explicitly scorecard-scoped submitted-edit evidence. */
    targetFetcher?: Fetcher;
  } = {},
): Promise<DrainSummary> {
  if (draining) return { succeeded: 0, failed: 0, remaining: await getQueuedCount(ownerKey), confirmedFileIds: {} };
  draining = true;
  let keptAwake = false;
  const confirmedFileIds: Record<string, string> = {};
  try {
    // Self-heal interrupted enqueues (stuck staging rows + orphaned staging files) before planning, so a kill
    // mid-enqueue neither strands a photo nor leaks disk. Best-effort — never blocks the drain.
    await reconcileOwnerStorage(ownerKey).catch(() => undefined);
    // Plan the drainable id order UNDER THE LOCK so the snapshot is consistent with any cancellation that
    // has already completed (terminal/failed items are left for the UI to surface + discard, never re-PUT).
    const planned = await withQueueLock(async () => {
      const queue = await readQueue(ownerKey);
      return { ids: queue.filter(isDrainable).map((item) => item.clientUploadId), total: queue.length };
    });
    const plannedIds = planned.ids;
    // Nothing drainable, but report the ACTUAL queue size as `remaining` — terminal/failed items still sit
    // in the queue (surfaced/dismissed via the UI), so hardcoding 0 would hide them from the caller.
    if (plannedIds.length === 0) return { succeeded: 0, failed: 0, remaining: planned.total, confirmedFileIds };

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
      const results = await runConcurrentUploads(chunk, UPLOAD_CONCURRENCY, (item) => {
        // Re-check right before the confirm step: if the item was cancelled while this chunk was uploading
        // (user pulled a photo off the card), skip confirm so the removed evidence never links to the deal.
        const promise = uploadCapture(
          selectUploadFetcher(item, fetcher, opts.targetFetcher),
          item,
          { shouldConfirm: () => queueHasClientUploadId(ownerKey, item.clientUploadId) },
        );
        activeUploadPromises.set(item.clientUploadId, promise);
        void promise.finally(() => {
          if (activeUploadPromises.get(item.clientUploadId) === promise) {
            activeUploadPromises.delete(item.clientUploadId);
          }
        }).catch(() => undefined);
        return promise;
      });
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
      // Record each confirmed photo's server file id (keyed by clientUploadId) so a caller that needs it can
      // read it from the summary instead of re-uploading. uploadCapture resolves to the FieldPhoto; a
      // fulfilled result therefore carries `{ id }`.
      liveChunk.forEach((item, i) => {
        const r = liveResults[i];
        if (r && r.status === "fulfilled") {
          const fileId = (r.value as { id?: unknown } | undefined)?.id;
          if (typeof fileId === "string") confirmedFileIds[item.clientUploadId] = fileId;
        }
      });
      await removeQueuedItems(ownerKey, succeededIds);
      await recordFailedAttempts(ownerKey, failedIds);
      succeeded += succeededIds.length;
      failed += failedIds.length;
    }

    const remaining = await getQueuedCount(ownerKey);
    const summary = { succeeded, failed, remaining, confirmedFileIds };
    opts.onProgress?.(summary);
    return summary;
  } finally {
    if (keptAwake) await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
    draining = false;
  }
}
