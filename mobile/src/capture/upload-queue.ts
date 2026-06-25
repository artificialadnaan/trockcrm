import * as FileSystem from "expo-file-system/legacy";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import type { Fetcher } from "../api/endpoints";
import { runConcurrentUploads, uploadCapture, type CaptureUploadInput } from "./upload";
import {
  UPLOAD_CONCURRENCY,
  dedupeQueue,
  partitionResults,
  removeIds,
  sanitizeOwnerKey,
  type QueuedUpload,
} from "./upload-queue-core";

export { UPLOAD_CONCURRENCY, dedupeQueue, newClientUploadId, partitionResults, removeIds, sanitizeOwnerKey, type QueuedUpload } from "./upload-queue-core";

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

// ── Disk-backed index + file lifecycle ─────────────────────────────────────────

async function ensureDir(ownerKey: string): Promise<void> {
  const dir = ownerDir(ownerKey);
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
}

async function readQueue(ownerKey: string): Promise<QueuedUpload[]> {
  try {
    const file = indexFile(ownerKey);
    const info = await FileSystem.getInfoAsync(file);
    if (!info.exists) return [];
    const raw = await FileSystem.readAsStringAsync(file);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedUpload[]) : [];
  } catch {
    // A corrupt/unreadable index must never crash capture — treat as empty.
    return [];
  }
}

async function writeQueue(ownerKey: string, items: QueuedUpload[]): Promise<void> {
  await ensureDir(ownerKey);
  await FileSystem.writeAsStringAsync(indexFile(ownerKey), JSON.stringify(items));
}

async function deleteQueuedFiles(items: QueuedUpload[]): Promise<void> {
  await Promise.all(
    items.map((item) => FileSystem.deleteAsync(item.uri, { idempotent: true }).catch(() => undefined)),
  );
}

export async function getQueuedUploads(ownerKey: string): Promise<QueuedUpload[]> {
  return readQueue(ownerKey);
}

export async function getQueuedCount(ownerKey: string): Promise<number> {
  return (await readQueue(ownerKey)).length;
}

/**
 * Copy each capture into durable storage and persist it to the index. The index is rewritten AFTER EACH
 * item is copied (not once at the end): if the app is killed mid-enqueue, every photo already copied is
 * recoverable from the index instead of being orphaned and lost. Returns the queued items.
 */
export async function enqueueUploads(ownerKey: string, inputs: CaptureUploadInput[]): Promise<QueuedUpload[]> {
  if (inputs.length === 0) return [];
  await ensureDir(ownerKey);
  const dir = ownerDir(ownerKey);
  const queued: QueuedUpload[] = [];
  let current = await readQueue(ownerKey);
  for (const input of inputs) {
    const ext = input.uri.includes(".") ? input.uri.slice(input.uri.lastIndexOf(".")) : ".jpg";
    const dest = `${dir}${input.clientUploadId}${ext}`;
    await FileSystem.copyAsync({ from: input.uri, to: dest });
    const item: QueuedUpload = { ...input, uri: dest, enqueuedAt: Date.now() };
    // Persist immediately so a crash right after this copy still recovers the item on next launch.
    current = dedupeQueue(current, [item]);
    await writeQueue(ownerKey, current);
    queued.push(item);
  }
  return queued;
}

/** Remove items (and their files) from the persisted index — used after a successful upload. */
async function removeQueuedItems(ownerKey: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const current = await readQueue(ownerKey);
  const toDelete = current.filter((item) => ids.includes(item.clientUploadId));
  await writeQueue(ownerKey, removeIds(current, ids));
  await deleteQueuedFiles(toDelete);
}

export async function clearUploadQueue(ownerKey: string): Promise<void> {
  const current = await readQueue(ownerKey);
  await deleteQueuedFiles(current);
  await writeQueue(ownerKey, []);
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
  opts: { onProgress?: (summary: DrainSummary) => void } = {},
): Promise<DrainSummary> {
  if (draining) return { succeeded: 0, failed: 0, remaining: await getQueuedCount(ownerKey) };
  draining = true;
  let keptAwake = false;
  try {
    const items = await readQueue(ownerKey);
    if (items.length === 0) return { succeeded: 0, failed: 0, remaining: 0 };

    try {
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      keptAwake = true;
    } catch {
      // Keep-awake is best-effort; draining continues without it.
    }

    // Drain in persisted chunks: after each chunk, remove its successes from the index. So an interrupt
    // (app suspended / short iOS window) re-uploads at MOST one chunk's worth next time, instead of the
    // whole snapshot — already-confirmed photos aren't re-compressed and re-PUT just to be deduped.
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < items.length; i += DRAIN_CHUNK) {
      const chunk = items.slice(i, i + DRAIN_CHUNK);
      const results = await runConcurrentUploads(chunk, UPLOAD_CONCURRENCY, (item) => uploadCapture(fetcher, item));
      const { succeededIds, failedIds } = partitionResults(chunk, results);
      await removeQueuedItems(ownerKey, succeededIds);
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
