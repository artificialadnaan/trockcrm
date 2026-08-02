/**
 * Pure logic for the walk-artifact upload queue — NO native imports, so it is unit-testable in
 * isolation. Mirrors the split in ../capture/upload-queue-core.ts: this file owns the RULES (what's
 * outstanding, when something is terminal, what order things drain in, idempotency); ./upload.ts
 * owns the I/O (manifest read/write, the actual PUT, the completion call, deleting a local file once
 * the server has accepted the whole walk).
 *
 * DELIBERATELY NOT the photo queue's shape. ../capture/upload-queue-core.ts's QueuedUpload models a
 * stream of individually-compressed camera captures: enqueue-time compression, a `staging` flag that
 * guards against double-encoding, GPS back-patching onto shots taken before a fix resolved. A walk's
 * artifacts are a fixed, small set of large files (~14 MB video with muxed audio + N stills) produced
 * once by a dedicated recorder — there is no compression pass to stage, and no GPS fix to patch in
 * after the fact.
 *
 * TWO-PHASE, not one-shot, unlike the photo queue. The server (glasses-walkthroughs-service) takes
 * every artifact's BYTES first (one presigned PUT per artifact, server-derived deterministic key —
 * safe to re-PUT the same artifact any number of times), then a SINGLE completion call that writes
 * every `files` row and enqueues forwarding in one transaction. That means "this artifact's bytes are
 * in R2" and "the server has filed this walk" are genuinely different facts, and this module tracks
 * them as different facts: QueuedWalkArtifact.putAt is the first, QueuedWalk.completedAt is the
 * second. A local file may ONLY be deleted after completedAt is set — never after an individual PUT.
 * See ./upload.ts's drainWalkQueue for why: a crash between the last PUT and the completion call
 * would otherwise leave bytes in R2 with no `files` row pointing at them and no local copy to retry
 * from — invisible to the crew, never forwarded, unrecoverable.
 */
import type { StillSource, Walk } from "./session";

export type WalkArtifactKind = "audio" | "video" | "photo";

// Drain order: audio/video before photos. The transcript is what produces scope line items; the
// photos are evidence attached to it. Lower sorts first — see drainableArtifacts.
const ORDER_MEDIA = 0;
const ORDER_PHOTO = 1;

/** Hard cap the server enforces on `files.client_upload_id` (a partial unique index — this IS the
 *  dedupe mechanism). Exceeding it wouldn't error at write time; it would silently stop deduping,
 *  which is worse. walkArtifactIdempotencyKey guards this explicitly rather than trusting that
 *  newWalkId()'s current shape stays short forever. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 64;

/** Dependency-free, deterministic 32-bit string hash (FNV-1a). The ONLY property that matters here is
 *  that the same input always produces the same output — used solely to fold an idempotency key back
 *  under the server's column budget while keeping it stable across retries/resumes. Not a security or
 *  collision-resistance primitive. */
function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Fold an over-budget key down to size, deterministically, keeping the kind/index suffix (the part a
 *  human debugging this would actually want to recognize) and hashing the rest. */
function truncateIdempotencyKey(key: string): string {
  const suffix = key.slice(key.lastIndexOf(":"));
  const hashed = `wh-${stableHash(key)}${suffix}`;
  return hashed.length <= MAX_IDEMPOTENCY_KEY_LENGTH ? hashed : hashed.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
}

export type QueuedWalkArtifact = {
  /**
   * Stable idempotency key sent to the server as `idempotencyKey` (stored server-side as
   * `files.client_upload_id`). Derived deterministically from (walkId, kind[, photoIndex]) — never
   * random — so re-deriving it always reproduces the SAME key, and it never exceeds
   * MAX_IDEMPOTENCY_KEY_LENGTH (see walkArtifactIdempotencyKey).
   */
  idempotencyKey: string;
  kind: WalkArtifactKind;
  /** Durable local file uri. Already lives under Documents/walkthroughs/<walkId>/ — native writes it
   *  there directly, so (unlike the photo queue) this module never copies the file, only references it. */
  uri: string;
  /** Capture timestamp (epoch ms), sent to the server as `capturedAtMs`: a photo's own `at`, or the
   *  walk's `startedAt` for audio/video. */
  at: number;
  /** Only set for a photo. */
  source?: StillSource;
  order: number;
  /** Failed-attempt counter for the PUT step; at MAX_WALK_UPLOAD_ATTEMPTS the artifact is terminal. */
  attempts: number;
  /** Epoch ms of the last PUT attempt (for surfacing/debugging). */
  lastTriedAt?: number;
  /**
   * Set once this artifact's bytes were successfully PUT to R2. This is NOT server acceptance — only
   * QueuedWalk.completedAt means the server has filed the walk. Until completedAt is set, the local
   * file must never be deleted, even if every artifact individually shows putAt.
   */
  putAt?: number;
  /** Byte size as it was actually PUT, captured at PUT time (not re-stat'd later) so the completion
   *  payload's fileSizeBytes reflects exactly what was uploaded. Undefined until putAt is set. */
  sizeBytes?: number;
};

export type QueuedWalk = {
  walkId: string;
  dealId: string;
  projectId: string | null;
  /** Short human label for the walk. Not derivable from `Walk` — supplied by the caller (the UI layer
   *  has whatever the user entered, or a generated default); this module never invents one. */
  title: string;
  /** Human-readable site/project label for display alongside the walk server-side. Same story as
   *  `title` — this module doesn't have deal/project display data, only ids. */
  siteLabel: string;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  enqueuedAt: number;
  artifacts: QueuedWalkArtifact[];
  /** Failed-attempt counter for the WALK-LEVEL completion call — distinct from any single artifact's
   *  PUT attempts, so a permanently-rejected completion has its own terminal cap. */
  completionAttempts: number;
  completionLastTriedAt?: number;
  /** Set once the completion call succeeded: the server has written every `files` row for this walk
   *  and enqueued forwarding, in one transaction. Until this is set the walk is NOT finished, no
   *  matter how many of its artifacts show putAt. */
  completedAt?: number;
};

/** After this many failed PUT attempts a single artifact is TERMINAL: the drain stops retrying it.
 *  Since completion requires EVERY artifact to be put, one terminal artifact makes the whole walk
 *  terminal too (see isWalkTerminal) — there is no partial completion. */
export const MAX_WALK_UPLOAD_ATTEMPTS = 5;

/** After this many failed completion-call attempts (all artifacts already PUT, but the server keeps
 *  rejecting/erroring on the completion call itself) the walk is TERMINAL. */
export const MAX_WALK_COMPLETION_ATTEMPTS = 5;

/** Deterministic per-artifact idempotency key, capped at MAX_IDEMPOTENCY_KEY_LENGTH. `photoIndex` is
 *  required (and only meaningful) for kind "photo" — a walk's stills array is frozen once it reaches
 *  a terminal state (session.ts), so the index is stable for the lifetime of the queue entry. */
export function walkArtifactIdempotencyKey(
  walkId: string,
  kind: WalkArtifactKind,
  photoIndex?: number,
): string {
  const key = kind === "photo" ? `${walkId}:photo:${photoIndex}` : `${walkId}:${kind}`;
  return key.length <= MAX_IDEMPOTENCY_KEY_LENGTH ? key : truncateIdempotencyKey(key);
}

export type WalkQueueMeta = {
  title: string;
  siteLabel: string;
};

/**
 * Turn a completed (or failed) Walk into a queue entry. `walkId` is passed explicitly because
 * session.ts's `Walk` doesn't carry its own id (native mints it before the walk starts) — the caller
 * that already has it (e.g. useWalk's start()) must supply it, along with `meta` (title/siteLabel),
 * which this module has no way to derive truthfully from ids alone.
 *
 * Returns null when there is nothing to enqueue:
 *  - the walk hasn't reached a terminal state yet (nothing is durably finalized while recording), or
 *  - it reached a terminal state but produced zero artifacts (e.g. failed before anything was
 *    captured) — queuing an empty entry would sit in the manifest forever, never drainable and never
 *    completable.
 *
 * A FAILED walk enqueues exactly like a complete one, and with exactly the artifacts it actually has:
 * session.ts's reducer deliberately keeps every still captured before the failure, and a failure
 * never discards a videoUri that DID finish writing. This function must never filter artifacts by
 * walk.state — doing so would silently drop evidence from a failed walk, which is exactly the bug
 * this module exists to prevent.
 *
 * `audioUri` is currently always null (audio is muxed into the video track — see session.ts), so the
 * "audio" branch below is dead in practice today. It stays for the documented future fallback path
 * (a walk that fails before the muxed video finalizes may one day land an audio-only file), and
 * because kind:"audio" is a value the server contract already accepts.
 */
export function toQueuedWalk(
  walkId: string,
  walk: Walk,
  meta: WalkQueueMeta,
  now: number,
): QueuedWalk | null {
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
      idempotencyKey: walkArtifactIdempotencyKey(walkId, "photo", index),
      kind: "photo",
      uri: still.uri,
      at: still.at,
      source: still.source,
      order: ORDER_PHOTO,
      attempts: 0,
    });
  });

  if (artifacts.length === 0) return null;

  return {
    walkId,
    dealId: walk.dealId,
    projectId: walk.projectId,
    title: meta.title,
    siteLabel: meta.siteLabel,
    startedAt: walk.startedAt,
    endedAt: walk.endedAt,
    durationMs: walk.durationMs,
    enqueuedAt: now,
    artifacts,
    completionAttempts: 0,
  };
}

// ── Artifact-level: has this artifact's bytes made it to R2? ───────────────────────────────────────

export function isArtifactPut(a: QueuedWalkArtifact): boolean {
  return a.putAt !== undefined;
}

/** TERMINAL = not put AND out of PUT retries. */
export function isArtifactTerminal(a: QueuedWalkArtifact): boolean {
  return !isArtifactPut(a) && a.attempts >= MAX_WALK_UPLOAD_ATTEMPTS;
}

/** DRAINABLE = worth PUTting right now: not already put, not yet terminal. */
export function isArtifactDrainable(a: QueuedWalkArtifact): boolean {
  return !isArtifactPut(a) && !isArtifactTerminal(a);
}

/** Every artifact whose bytes are not yet confirmed in R2 — what a partially-uploaded walk still owes
 *  at the PUT step, regardless of retryability. */
export function outstandingArtifacts(walk: QueuedWalk): QueuedWalkArtifact[] {
  return walk.artifacts.filter((a) => !isArtifactPut(a));
}

/** Outstanding artifacts a drain should actually PUT right now, in drain order: audio/video before
 *  photos (`order`), earliest capture first within a kind (`at`), idempotencyKey as a final stable
 *  tie-break so ordering is deterministic across runs. */
export function drainableArtifacts(walk: QueuedWalk): QueuedWalkArtifact[] {
  return walk.artifacts
    .filter(isArtifactDrainable)
    .sort((a, b) => a.order - b.order || a.at - b.at || a.idempotencyKey.localeCompare(b.idempotencyKey));
}

// ── Walk-level: has the server accepted the whole walk? ─────────────────────────────────────────────

/** A walk with at least one artifact, every one of which has its bytes in R2. This is NOT "done" —
 *  see isWalkCompleted. */
export function isWalkFullyPut(walk: QueuedWalk): boolean {
  return walk.artifacts.length > 0 && walk.artifacts.every(isArtifactPut);
}

/** The server has accepted the whole walk (every `files` row written, forwarding enqueued). Only at
 *  this point may local files be deleted. */
export function isWalkCompleted(walk: QueuedWalk): boolean {
  return walk.completedAt !== undefined;
}

/** TERMINAL for the completion step specifically: every artifact is put, but the completion call has
 *  exhausted its own retry cap. */
export function isCompletionTerminal(walk: QueuedWalk): boolean {
  return !isWalkCompleted(walk) && walk.completionAttempts >= MAX_WALK_COMPLETION_ATTEMPTS;
}

/** True exactly when a drain should attempt the completion call: every artifact is in R2, the server
 *  hasn't accepted the walk yet, and completion itself hasn't gone terminal. */
export function needsCompletion(walk: QueuedWalk): boolean {
  return isWalkFullyPut(walk) && !isWalkCompleted(walk) && !isCompletionTerminal(walk);
}

/**
 * A walk a drain should still act on. Note the short-circuit on any terminal artifact: because
 * completion requires EVERY artifact to be put, a single permanently-failed artifact means this walk
 * can never reach isWalkFullyPut — continuing to drain its other (still-retryable) artifacts would be
 * pure waste, since nothing they do can ever unlock completion. See isWalkTerminal, its mirror image.
 */
export function isWalkDrainable(walk: QueuedWalk): boolean {
  if (isWalkCompleted(walk)) return false;
  if (walk.artifacts.some(isArtifactTerminal)) return false;
  if (walk.artifacts.some(isArtifactDrainable)) return true;
  return needsCompletion(walk);
}

/** Nothing left for a drain to do, and the walk never completed — either an artifact permanently
 *  failed its PUT (which dooms the whole walk, since completion needs all of them), or completion
 *  itself permanently failed after every artifact succeeded. Surfaces to the UI as "failed". */
export function isWalkTerminal(walk: QueuedWalk): boolean {
  if (walk.artifacts.length === 0 || isWalkCompleted(walk)) return false;
  if (walk.artifacts.some(isArtifactTerminal)) return true;
  return isWalkFullyPut(walk) && isCompletionTerminal(walk);
}

/**
 * The retry escape hatch for a TERMINAL walk: resets only the retry COUNTERS that made it
 * terminal, so the next drain treats it as fresh again. Never touches `putAt`/`sizeBytes`
 * (already-confirmed bytes in R2 must never be re-uploaded) or `completedAt` (a walk that's
 * actually done is not terminal in the first place — see isWalkTerminal). A no-op (returns the
 * SAME walk reference) for a walk that isn't terminal, so a caller can map this over an entire
 * manifest unconditionally without first filtering.
 *
 * This is what makes getFailedWalkCount's count actionable: without it, a terminal walk would sit
 * in the manifest forever (isWalkDrainable excludes it, by design — see that function's header) with
 * no way back in.
 */
export function resetTerminalWalkForRetry(walk: QueuedWalk): QueuedWalk {
  if (!isWalkTerminal(walk)) return walk;
  return {
    ...walk,
    artifacts: walk.artifacts.map((a) => (isArtifactTerminal(a) ? { ...a, attempts: 0 } : a)),
    completionAttempts: isCompletionTerminal(walk) ? 0 : walk.completionAttempts,
  };
}

/**
 * Add a completed walk to a persisted list. Idempotent like the photo queue's dedupeQueue: if a walk
 * with this walkId is already queued, the existing entry — and any upload progress (attempts, putAt,
 * completedAt) it has already made — is kept, never clobbered by a freshly-derived (all-zero) entry.
 */
export function upsertQueuedWalk(existing: QueuedWalk[], incoming: QueuedWalk): QueuedWalk[] {
  if (existing.some((w) => w.walkId === incoming.walkId)) return existing;
  return [...existing, incoming];
}

export function removeQueuedWalk(walks: QueuedWalk[], walkId: string): QueuedWalk[] {
  return walks.filter((w) => w.walkId !== walkId);
}

/** Bump the PUT-attempt counter (+ lastTriedAt) on specific artifacts within one walk — used after a
 *  failed PUT attempt on those artifacts. Artifacts not named in `idempotencyKeys`, and every other
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

/** Mark ONE artifact's bytes as successfully PUT to R2, recording the size that was actually
 *  uploaded. Callers (./upload.ts) must persist this before ever considering completion, and
 *  completion itself before ever deleting the local file — never skip a step. */
export function markArtifactPut(
  walk: QueuedWalk,
  idempotencyKey: string,
  sizeBytes: number,
  now: number,
): QueuedWalk {
  return {
    ...walk,
    artifacts: walk.artifacts.map((a) =>
      a.idempotencyKey === idempotencyKey ? { ...a, putAt: now, sizeBytes } : a,
    ),
  };
}

/** Bump the completion-call attempt counter — used after a failed completion call on a fully-put walk. */
export function bumpCompletionAttempts(walk: QueuedWalk, now: number): QueuedWalk {
  return { ...walk, completionAttempts: walk.completionAttempts + 1, completionLastTriedAt: now };
}

/** Mark the walk as server-accepted. This is the ONLY signal that authorizes deleting local files —
 *  see the module header for why bytes-in-R2 alone is not enough. */
export function markWalkCompleted(walk: QueuedWalk, now: number): QueuedWalk {
  return { ...walk, completedAt: now };
}

/** Owner-namespace directory-name sanitizer, kept local rather than importing the photo queue's
 *  identical helper (../capture/upload-queue-core.ts's sanitizeOwnerKey) — see the module header for
 *  why this queue is a deliberate parallel implementation, not a shared one. Falls back to "anon" for
 *  an empty key so a missing id can never collapse two owners into one shared path. */
export function sanitizeWalkOwnerKey(ownerKey: string): string {
  const safe = ownerKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  return safe.length > 0 ? safe : "anon";
}
