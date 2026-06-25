// Pure queue logic for the resilient upload queue — NO native imports (only a type-only import of
// CaptureUploadInput, erased at runtime), so it is unit-testable in isolation. The native I/O (file copy,
// index read/write, keep-awake, draining) lives in ./upload-queue and composes these.
import type { CaptureUploadInput } from "./upload";

// 5 (up from 3): a touch more throughput for big batches while staying gentle on the API rate limiter.
export const UPLOAD_CONCURRENCY = 5;

export type QueuedUpload = CaptureUploadInput & { enqueuedAt: number };

/** A collision-resistant id for the idempotency key + on-disk filename (no uuid/crypto dep available). */
export function newClientUploadId(): string {
  return `cu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/** Append new items, ignoring any whose clientUploadId is already queued (idempotent enqueue). */
export function dedupeQueue(existing: QueuedUpload[], incoming: QueuedUpload[]): QueuedUpload[] {
  const seen = new Set(existing.map((item) => item.clientUploadId));
  const fresh = incoming.filter((item) => !seen.has(item.clientUploadId));
  return [...existing, ...fresh];
}

/** Drop items whose clientUploadId is in `ids`. */
export function removeIds(queue: QueuedUpload[], ids: Iterable<string>): QueuedUpload[] {
  const drop = new Set(ids);
  return queue.filter((item) => !drop.has(item.clientUploadId));
}

/** Split a settled drain into the ids that uploaded vs the ids that failed (stay queued for retry). */
export function partitionResults(
  items: QueuedUpload[],
  results: Array<PromiseSettledResult<unknown>>,
): { succeededIds: string[]; failedIds: string[] } {
  const succeededIds: string[] = [];
  const failedIds: string[] = [];
  items.forEach((item, i) => {
    if (results[i]?.status === "fulfilled") succeededIds.push(item.clientUploadId);
    else failedIds.push(item.clientUploadId);
  });
  return { succeededIds, failedIds };
}
