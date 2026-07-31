/**
 * Pure logic for the walk-artifact upload queue — NO native imports, so it is unit-testable in
 * isolation. Mirrors the split in ../capture/upload-queue-core.ts: this file owns the RULES (what's
 * outstanding, when something is terminal, what order things drain in, idempotency); ./upload.ts
 * owns the I/O (manifest read/write, the actual PUT, deleting a local file once confirmed).
 *
 * DELIBERATELY NOT the photo queue's shape. ../capture/upload-queue-core.ts's QueuedUpload models a
 * stream of individually-compressed camera captures: enqueue-time compression, a `staging` flag that
 * guards against double-encoding, GPS back-patching onto shots taken before a fix resolved. A walk's
 * artifacts are a fixed, small set of large files (~14 MB audio/video + N stills) produced once by a
 * dedicated recorder — there is no compression pass to stage, and no GPS fix to patch in after the
 * fact. Forcing that machinery through here would be reuse that looks free and isn't. What IS worth
 * borrowing — durable storage, a persisted index, attempt counting with a terminal cap, and (in
 * ./upload.ts) the container-UUID rebasing from ../capture/doc-dir-uri.ts — is borrowed deliberately,
 * as a parallel implementation, not a shared code path.
 */
import type { StillSource, Walk } from "./session";

export type WalkArtifactKind = "audio" | "video" | "still";

// Drain order: audio/video before stills. The transcript is what produces scope line items; the
// stills are evidence attached to it. Lower sorts first — see drainableArtifacts.
const ORDER_MEDIA = 0;
const ORDER_STILL = 1;

export type QueuedWalkArtifact = {
  /**
   * Stable idempotency key sent to the server on confirm. Derived deterministically from
   * (walkId, kind[, stillIndex]) — never random — so re-deriving it (a second enqueue attempt for a
   * walk that's already queued, or a retried upload of the same artifact) always reproduces the SAME
   * key. The server must dedupe confirm-upload on this: a background drain retries failed items, and
   * the same bytes can legitimately be PUT twice before a confirm lands.
   */
  idempotencyKey: string;
  kind: WalkArtifactKind;
  /** Durable local file uri. Already lives under Documents/walkthroughs/<walkId>/ — native writes it
   *  there directly, so (unlike the photo queue) this module never copies the file, only references it. */
  uri: string;
  /** Capture timestamp: a still's own `at`, or the walk's `startedAt` for audio/video. */
  at: number;
  /** Only set for a still. */
  source?: StillSource;
  order: number;
  /** Failed-attempt counter; at MAX_WALK_UPLOAD_ATTEMPTS the artifact is terminal. */
  attempts: number;
  /** Epoch ms of the last drain attempt (for surfacing/debugging). */
  lastTriedAt?: number;
  /** Set once the SERVER has confirmed this artifact. Until then, the local file must never be
   *  deleted — a walk is a site visit that cannot be re-taken from a desk. */
  uploadedAt?: number;
};

export type QueuedWalk = {
  walkId: string;
  dealId: string;
  projectId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  enqueuedAt: number;
  artifacts: QueuedWalkArtifact[];
};

/** After this many failed attempts a single artifact is TERMINAL: the drain stops retrying it and it
 *  surfaces to the UI as failed. Same cap as the photo queue's MAX_UPLOAD_ATTEMPTS. */
export const MAX_WALK_UPLOAD_ATTEMPTS = 5;

/** Deterministic per-artifact idempotency key. `stillIndex` is required (and only meaningful) for
 *  kind "still" — a walk's stills array is frozen once it reaches a terminal state (session.ts), so
 *  the index is stable for the lifetime of the queue entry. */
export function walkArtifactIdempotencyKey(
  walkId: string,
  kind: WalkArtifactKind,
  stillIndex?: number,
): string {
  return kind === "still" ? `${walkId}:still:${stillIndex}` : `${walkId}:${kind}`;
}

/**
 * Turn a completed (or failed) Walk into a queue entry. `walkId` is passed explicitly because
 * session.ts's `Walk` doesn't carry its own id (native mints it before the walk starts) — the caller
 * that already has it (e.g. useWalk's start()) must supply it.
 *
 * Returns null when there is nothing to enqueue:
 *  - the walk hasn't reached a terminal state yet (nothing is durably finalized while recording), or
 *  - it reached a terminal state but produced zero artifacts (e.g. failed before anything was
 *    captured) — queuing an empty entry would sit in the manifest forever, never drainable and never
 *    completable.
 *
 * A FAILED walk enqueues exactly like a complete one, and with exactly the artifacts it actually has:
 * session.ts's reducer deliberately keeps every still captured before the failure, and a failure
 * never discards an audioUri/videoUri that DID finish writing. This function must never filter
 * artifacts by walk.state — doing so would silently drop evidence from a failed walk, which is
 * exactly the bug this module exists to prevent.
 */
export function toQueuedWalk(walkId: string, walk: Walk, now: number): QueuedWalk | null {
  if (walk.state !== "complete" && walk.state !== "failed") return null;

  const artifacts: QueuedWalkArtifact[] = [];
  if (walk.audioUri) {
    artifacts.push({
      idempotencyKey: walkArtifactIdempotencyKey(walkId, "audio"),
      kind: "audio",
      uri: walk.audioUri,
      at: walk.startedAt ?? now,
      order: ORDER_MEDIA,
      attempts: 0,
    });
  }
  if (walk.videoUri) {
    artifacts.push({
      idempotencyKey: walkArtifactIdempotencyKey(walkId, "video"),
      kind: "video",
      uri: walk.videoUri,
      at: walk.startedAt ?? now,
      order: ORDER_MEDIA,
      attempts: 0,
    });
  }
  walk.stills.forEach((still, index) => {
    artifacts.push({
      idempotencyKey: walkArtifactIdempotencyKey(walkId, "still", index),
      kind: "still",
      uri: still.uri,
      at: still.at,
      source: still.source,
      order: ORDER_STILL,
      attempts: 0,
    });
  });

  if (artifacts.length === 0) return null;

  return {
    walkId,
    dealId: walk.dealId,
    projectId: walk.projectId,
    startedAt: walk.startedAt,
    endedAt: walk.endedAt,
    durationMs: walk.durationMs,
    enqueuedAt: now,
    artifacts,
  };
}

export function isArtifactUploaded(a: QueuedWalkArtifact): boolean {
  return a.uploadedAt !== undefined;
}

/** TERMINAL = not uploaded AND out of retries. Mirrors upload-queue-core's isTerminal. */
export function isArtifactTerminal(a: QueuedWalkArtifact): boolean {
  return !isArtifactUploaded(a) && a.attempts >= MAX_WALK_UPLOAD_ATTEMPTS;
}

/** DRAINABLE = worth attempting right now: not already uploaded, not yet terminal. */
export function isArtifactDrainable(a: QueuedWalkArtifact): boolean {
  return !isArtifactUploaded(a) && !isArtifactTerminal(a);
}

/** Every artifact not yet confirmed by the server — what a partially-uploaded walk still owes,
 *  regardless of whether it's still retryable or has already gone terminal. This is the answer to
 *  "what does a resumed walk still need to upload?" */
export function outstandingArtifacts(walk: QueuedWalk): QueuedWalkArtifact[] {
  return walk.artifacts.filter((a) => !isArtifactUploaded(a));
}

/** Outstanding artifacts a drain should actually attempt right now, in drain order: audio/video
 *  before stills (`order`), earliest capture first within a kind (`at`), idempotencyKey as a final
 *  stable tie-break so ordering is deterministic across runs. */
export function drainableArtifacts(walk: QueuedWalk): QueuedWalkArtifact[] {
  return walk.artifacts
    .filter(isArtifactDrainable)
    .sort((a, b) => a.order - b.order || a.at - b.at || a.idempotencyKey.localeCompare(b.idempotencyKey));
}

/** A walk with at least one artifact, every one of which is confirmed. */
export function isWalkFullyUploaded(walk: QueuedWalk): boolean {
  return walk.artifacts.length > 0 && walk.artifacts.every(isArtifactUploaded);
}

/** A walk a drain would still act on: it has at least one drainable artifact. */
export function isWalkDrainable(walk: QueuedWalk): boolean {
  return walk.artifacts.some(isArtifactDrainable);
}

/** Every outstanding artifact has exhausted its retries and the walk never fully uploaded — nothing
 *  left for a drain to do, but the walk did not finish. Surfaces to the UI as "failed", the walk-level
 *  analogue of the photo queue's getFailedCount. */
export function isWalkTerminal(walk: QueuedWalk): boolean {
  return walk.artifacts.length > 0 && !isWalkFullyUploaded(walk) && !isWalkDrainable(walk);
}

/**
 * Add a completed walk to a persisted list. Idempotent like the photo queue's dedupeQueue: if a walk
 * with this walkId is already queued, the existing entry — and any upload progress (attempts,
 * uploadedAt) it has already made — is kept, never clobbered by a freshly-derived (all-zero) entry.
 */
export function upsertQueuedWalk(existing: QueuedWalk[], incoming: QueuedWalk): QueuedWalk[] {
  if (existing.some((w) => w.walkId === incoming.walkId)) return existing;
  return [...existing, incoming];
}

export function removeQueuedWalk(walks: QueuedWalk[], walkId: string): QueuedWalk[] {
  return walks.filter((w) => w.walkId !== walkId);
}

/** Bump the attempt counter (+ lastTriedAt) on specific artifacts within one walk — used after a
 *  failed drain attempt on those artifacts. Artifacts not named in `idempotencyKeys`, and every other
 *  walk in the list, are returned unchanged. */
export function bumpArtifactAttempts(
  walk: QueuedWalk,
  idempotencyKeys: Iterable<string>,
  now: number,
): QueuedWalk {
  const failed = new Set(idempotencyKeys);
  return {
    ...walk,
    artifacts: walk.artifacts.map((a) =>
      failed.has(a.idempotencyKey) ? { ...a, attempts: a.attempts + 1, lastTriedAt: now } : a,
    ),
  };
}

/** Mark specific artifacts within one walk as server-confirmed. Callers (./upload.ts) must persist
 *  this BEFORE deleting the corresponding local file — never the other way around, so a crash between
 *  the two steps leaves at worst a harmless orphaned file, never a confirmed-but-still-queued artifact
 *  whose bytes are already gone. */
export function markArtifactsUploaded(
  walk: QueuedWalk,
  idempotencyKeys: Iterable<string>,
  now: number,
): QueuedWalk {
  const done = new Set(idempotencyKeys);
  return {
    ...walk,
    artifacts: walk.artifacts.map((a) => (done.has(a.idempotencyKey) ? { ...a, uploadedAt: now } : a)),
  };
}

/** Owner-namespace directory-name sanitizer, kept local rather than importing the photo queue's
 *  identical helper (../capture/upload-queue-core.ts's sanitizeOwnerKey) — see the module header for
 *  why this queue is a deliberate parallel implementation, not a shared one. Falls back to "anon" for
 *  an empty key so a missing id can never collapse two owners into one shared path. */
export function sanitizeWalkOwnerKey(ownerKey: string): string {
  const safe = ownerKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  return safe.length > 0 ? safe : "anon";
}
