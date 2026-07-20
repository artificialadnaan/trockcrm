// Pure queue logic for the resilient upload queue — NO native imports (only a type-only import of
// CaptureUploadInput, erased at runtime), so it is unit-testable in isolation. The native I/O (file copy,
// index read/write, keep-awake, draining) lives in ./upload-queue and composes these.
import type { CaptureUploadInput } from "./upload";

// 5 (up from 3): a touch more throughput for big batches while staying gentle on the API rate limiter.
export const UPLOAD_CONCURRENCY = 5;

// Cap on concurrent enqueue-time compressions ACROSS all enqueueUploads calls. Per-photo captures fire
// enqueueUploads without awaiting, so a fast burst could otherwise launch unbounded 12MP ImageManipulator
// jobs → memory/CPU spike → camera jank or an app kill. Lower than UPLOAD_CONCURRENCY because decode+encode
// is far heavier than a network PUT, and it runs while the camera preview is live.
export const COMPRESS_CONCURRENCY = 3;

/**
 * A shared bounded runner: at most `max` tasks run concurrently across ALL callers; the rest queue and start
 * as slots free (FIFO). Unlike createAsyncMutex (concurrency 1), this allows `max` in flight. A task that
 * throws still frees its slot. Used for one module-level instance to bound enqueue-time compression.
 */
export function createBoundedRunner(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < max) {
        active++;
        resolve();
      } else {
        waiters.push(resolve); // inherits the slot released to it (active stays at max)
      }
    });
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else active--;
  };
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}

// After this many failed attempts an item is TERMINAL: it stops draining (no more re-compress/re-PUT) and
// surfaces to the UI as "failed" so a permanently-broken capture (revoked access, non-transient 4xx) can't
// retry forever on every resume/foreground/background trigger.
export const MAX_UPLOAD_ATTEMPTS = 5;

export type QueuedUpload = CaptureUploadInput & {
  enqueuedAt: number;
  /** Failed-attempt counter; at MAX_UPLOAD_ATTEMPTS the item is terminal and no longer drained. */
  attempts: number;
  /** Epoch ms of the last drain attempt (for surfacing/debugging). */
  lastTriedAt?: number;
};

/** Drainable = not yet terminal. Legacy items without `attempts` are treated as 0. */
export function isDrainable(item: QueuedUpload): boolean {
  return (item.attempts ?? 0) < MAX_UPLOAD_ATTEMPTS;
}

/** Legacy/unmarked queue items remain office-pinned; only an explicit edit-evidence marker opts out. */
export function shouldRouteUploadByTarget(item: Pick<CaptureUploadInput, "routeByTarget">): boolean {
  return item.routeByTarget === true;
}

/** Select per item so a mixed owner queue never reroutes ordinary/new-draft captures by accident. */
export function selectUploadFetcher<T>(
  item: Pick<CaptureUploadInput, "routeByTarget">,
  officePinnedFetcher: T,
  targetFetcher?: T,
): T {
  return shouldRouteUploadByTarget(item) && targetFetcher !== undefined ? targetFetcher : officePinnedFetcher;
}

/** Bump the attempt counter (and lastTriedAt) for the given ids — used after a failed drain attempt. */
export function bumpAttempts(queue: QueuedUpload[], failedIds: Iterable<string>, now: number): QueuedUpload[] {
  const failed = new Set(failedIds);
  return queue.map((item) =>
    failed.has(item.clientUploadId)
      ? { ...item, attempts: (item.attempts ?? 0) + 1, lastTriedAt: now }
      : item,
  );
}

/**
 * Make an owner id safe for use as a directory name (the queue is namespaced per signed-in user). Falls
 * back to "anon" for an empty key so a missing id can never collapse two users into a shared path.
 */
export function sanitizeOwnerKey(ownerKey: string): string {
  const safe = ownerKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  return safe.length > 0 ? safe : "anon";
}

/**
 * The queue owner identity = user + ACTIVE OFFICE. Uploads are bound to the active office (the fetcher
 * sends x-office-id), so a queue captured under one office must never drain under another. Returns "" when
 * there's no user (caller should skip queueing).
 */
export function uploadOwnerKey(userId: string | null | undefined, officeId: string | null | undefined): string {
  if (!userId) return "";
  return `${userId}:${officeId ?? ""}`;
}

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

/**
 * Fill GPS coordinates onto a still-queued item — ONLY if it's coordless (never overwrites EXIF/existing
 * coords). Used when a camera session's fix lands after a shot was already streamed coordless. Returns
 * whether anything changed so the caller only rewrites the durable index when it did; a no-op (id absent, or
 * already geotagged) returns the original queue reference unchanged.
 */
export function applyGpsPatch(
  queue: QueuedUpload[],
  clientUploadId: string,
  coords: { latitude: number; longitude: number; addressSource?: "exif" | "live_gps" },
): { queue: QueuedUpload[]; changed: boolean } {
  let changed = false;
  const next = queue.map((item) => {
    if (item.clientUploadId !== clientUploadId) return item;
    if (item.metadata?.latitude !== undefined && item.metadata?.longitude !== undefined) return item;
    changed = true;
    return {
      ...item,
      metadata: { ...item.metadata, latitude: coords.latitude, longitude: coords.longitude, addressSource: coords.addressSource },
    };
  });
  return { queue: changed ? next : queue, changed };
}

/**
 * A minimal async mutex. Every task runs only after the previous one SETTLES (resolve OR reject), so
 * read-modify-write sections on a shared resource can't interleave: without it, two callers each read the
 * same on-disk index snapshot and then write, and the later write silently clobbers the earlier one (e.g.
 * removing a photo while a submit enqueues remaining photos). Tasks run in FIFO order; a task that throws
 * rejects to ITS caller but never wedges the chain for the next task.
 */
export function createAsyncMutex(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  const noop = () => undefined;
  return function run<T>(task: () => Promise<T>): Promise<T> {
    // Chain onto the tail as BOTH handlers so `task` runs after the prior settles either way.
    const result = tail.then(task, task);
    // Advance the tail on a swallowed copy so one task's rejection can't break the chain.
    tail = result.then(noop, noop);
    return result;
  };
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

/**
 * Resolve a settled batch of concurrent enqueue attempts. A batch is run with `Promise.allSettled` (not
 * `Promise.all`) so every worker finishes writing before we look at results — no worker is still mutating a
 * dest file / the queue index when the caller regains control. A single copy failure still aborts the whole
 * batch: we rethrow the FIRST rejection (after all have settled). Fulfilled `null`s are skipped items (id
 * already durably queued or claimed by another worker) and are dropped from the returned list.
 */
export function collectEnqueueResults(settled: Array<PromiseSettledResult<QueuedUpload | null>>): QueuedUpload[] {
  const rejected = settled.find((r) => r.status === "rejected");
  if (rejected) throw (rejected as PromiseRejectedResult).reason;
  return settled.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
}
