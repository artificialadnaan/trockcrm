// Pure queue logic for the resilient upload queue — NO native imports (only a type-only import of
// CaptureUploadInput, erased at runtime), so it is unit-testable in isolation. The native I/O (file copy,
// index read/write, keep-awake, draining) lives in ./upload-queue and composes these.
import type { CaptureUploadInput } from "./upload";

// 5 (up from 3): a touch more throughput for big batches while staying gentle on the API rate limiter.
export const UPLOAD_CONCURRENCY = 5;

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
  /**
   * HELD = durable but NOT drainable yet. Staged review photos are enqueued at review-open so they survive
   * a crash, but must not upload UNCAPTIONED if a background/foreground drain fires mid-caption — so they're
   * held until the crew taps Done (releaseHeld clears the flag). Absent/false ⇒ a normal drainable item.
   */
  held?: boolean;
};

/**
 * Drainable = not held AND not yet terminal. Legacy items without `attempts` are treated as 0; a held item
 * is skipped by BOTH drain entry points (drainUploadQueue + the background task) until it's released.
 */
export function isDrainable(item: QueuedUpload): boolean {
  return !item.held && isTerminal(item) === false;
}

/**
 * Terminal = exhausted its retries (attempts ≥ cap). Distinct from HELD: a held item is intentionally
 * paused (still eligible once released), NOT a failure — so the "failed" surfaces (getFailedCount /
 * clearFailedUploads) must key on this, never on `!isDrainable`, which would wrongly sweep held rows.
 */
export function isTerminal(item: QueuedUpload): boolean {
  return (item.attempts ?? 0) >= MAX_UPLOAD_ATTEMPTS;
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
 * Patch the caption onto a still-queued item — the DURABLE analogue of editing a caption in the review
 * tray. Used when staged photos are enqueued UNCAPTIONED at review-open and the crew then types a caption:
 * on Done each queued row's caption is patched to the typed value before draining. Sets the caption for the
 * matching id (incl. clearing it to null), and reports whether anything changed so the caller only rewrites
 * the durable index when it did; a no-op (id absent, or caption unchanged) returns the original queue
 * reference unchanged.
 */
export function applyCaptionPatch(
  queue: QueuedUpload[],
  clientUploadId: string,
  caption: string | null,
): { queue: QueuedUpload[]; changed: boolean } {
  let changed = false;
  const next = queue.map((item) => {
    if (item.clientUploadId !== clientUploadId) return item;
    if (item.caption === caption) return item;
    changed = true;
    return { ...item, caption };
  });
  return { queue: changed ? next : queue, changed };
}

/**
 * Clear the HELD flag on the matching ids so they become drainable — the durable analogue of the crew
 * tapping Done in the review tray. Staged photos are enqueued HELD at review-open (durable but paused); on
 * Done their captions are patched, then this releases them so the next drain ships them WITH captions. Only
 * flips a currently-held matching row; reports whether anything changed so the caller rewrites the durable
 * index only when it did, and a no-op (id absent, or already released) returns the original queue reference.
 */
export function releaseHeld(
  queue: QueuedUpload[],
  ids: Iterable<string>,
): { queue: QueuedUpload[]; changed: boolean } {
  const release = new Set(ids);
  let changed = false;
  const next = queue.map((item) => {
    if (!release.has(item.clientUploadId) || !item.held) return item;
    changed = true;
    return { ...item, held: false };
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
