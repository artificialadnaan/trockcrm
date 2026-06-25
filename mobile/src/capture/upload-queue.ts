import * as FileSystem from "expo-file-system/legacy";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import type { Fetcher } from "../api/endpoints";
import { runConcurrentUploads, uploadCapture, type CaptureUploadInput } from "./upload";
import {
  UPLOAD_CONCURRENCY,
  dedupeQueue,
  partitionResults,
  removeIds,
  type QueuedUpload,
} from "./upload-queue-core";

export { UPLOAD_CONCURRENCY, dedupeQueue, newClientUploadId, partitionResults, removeIds, type QueuedUpload } from "./upload-queue-core";

/**
 * Durable, resumable upload queue for field photo captures.
 *
 * Photos are copied into the app's document directory and their metadata persisted to a JSON index BEFORE
 * upload, so a captured batch survives the app being backgrounded, killed, or losing connection — it
 * resumes on next launch (or from the background task). Each item carries a stable `clientUploadId`; the
 * server dedupes on it, so re-running an upload that already succeeded (app died after confirm, before we
 * removed it from the index) returns the existing photo instead of creating a duplicate.
 */

const QUEUE_DIR = `${FileSystem.documentDirectory ?? ""}upload-queue/`;
const INDEX_FILE = `${QUEUE_DIR}index.json`;
const KEEP_AWAKE_TAG = "trockcam-upload-queue";

export type DrainSummary = { succeeded: number; failed: number; remaining: number };

// ── Disk-backed index + file lifecycle ─────────────────────────────────────────

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(QUEUE_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(QUEUE_DIR, { intermediates: true });
}

async function readQueue(): Promise<QueuedUpload[]> {
  try {
    const info = await FileSystem.getInfoAsync(INDEX_FILE);
    if (!info.exists) return [];
    const raw = await FileSystem.readAsStringAsync(INDEX_FILE);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedUpload[]) : [];
  } catch {
    // A corrupt/unreadable index must never crash capture — treat as empty.
    return [];
  }
}

async function writeQueue(items: QueuedUpload[]): Promise<void> {
  await ensureDir();
  await FileSystem.writeAsStringAsync(INDEX_FILE, JSON.stringify(items));
}

async function deleteQueuedFiles(items: QueuedUpload[]): Promise<void> {
  await Promise.all(
    items.map((item) => FileSystem.deleteAsync(item.uri, { idempotent: true }).catch(() => undefined)),
  );
}

export async function getQueuedUploads(): Promise<QueuedUpload[]> {
  return readQueue();
}

export async function getQueuedCount(): Promise<number> {
  return (await readQueue()).length;
}

/**
 * Copy each capture into durable storage and append it to the persisted index. Returns the queued items.
 * The caller passes the original capture uri + a clientUploadId; we re-point uri at the stable copy so the
 * upload survives cache eviction.
 */
export async function enqueueUploads(inputs: CaptureUploadInput[]): Promise<QueuedUpload[]> {
  if (inputs.length === 0) return [];
  await ensureDir();
  const queued: QueuedUpload[] = [];
  for (const input of inputs) {
    const ext = input.uri.includes(".") ? input.uri.slice(input.uri.lastIndexOf(".")) : ".jpg";
    const dest = `${QUEUE_DIR}${input.clientUploadId}${ext}`;
    await FileSystem.copyAsync({ from: input.uri, to: dest });
    queued.push({ ...input, uri: dest, enqueuedAt: Date.now() });
  }
  // Re-read + dedupe so a concurrent enqueue isn't clobbered.
  const next = dedupeQueue(await readQueue(), queued);
  await writeQueue(next);
  return queued;
}

/** Remove items (and their files) from the persisted index — used after a successful upload. */
async function removeQueuedItems(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const current = await readQueue();
  const toDelete = current.filter((item) => ids.includes(item.clientUploadId));
  await writeQueue(removeIds(current, ids));
  await deleteQueuedFiles(toDelete);
}

export async function clearUploadQueue(): Promise<void> {
  const current = await readQueue();
  await deleteQueuedFiles(current);
  await writeQueue([]);
}

// A drain must never run twice at once (foreground + background, or a double tap): a second caller would
// re-upload in-flight items. Module-local guard — both entry points share this process.
let draining = false;

/**
 * Upload everything currently queued, with bounded concurrency and the screen kept awake. Succeeded items
 * are removed from the index; failures stay for the next drain/resume. Safe to call repeatedly and from
 * the background task. Never throws — returns a summary.
 */
export async function drainUploadQueue(
  fetcher: Fetcher,
  opts: { onProgress?: (summary: DrainSummary) => void } = {},
): Promise<DrainSummary> {
  if (draining) return { succeeded: 0, failed: 0, remaining: await getQueuedCount() };
  draining = true;
  let keptAwake = false;
  try {
    const items = await readQueue();
    if (items.length === 0) return { succeeded: 0, failed: 0, remaining: 0 };

    try {
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      keptAwake = true;
    } catch {
      // Keep-awake is best-effort; draining continues without it.
    }

    const results = await runConcurrentUploads(items, UPLOAD_CONCURRENCY, (item) => uploadCapture(fetcher, item));
    const { succeededIds, failedIds } = partitionResults(items, results);
    // Single index rewrite (re-reads current state) so items enqueued mid-drain aren't lost. Items that
    // succeeded but aren't removed (e.g. the app died here) re-run next time and dedupe server-side.
    await removeQueuedItems(succeededIds);

    const remaining = await getQueuedCount();
    const summary = { succeeded: succeededIds.length, failed: failedIds.length, remaining };
    opts.onProgress?.(summary);
    return summary;
  } finally {
    if (keptAwake) await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
    draining = false;
  }
}
