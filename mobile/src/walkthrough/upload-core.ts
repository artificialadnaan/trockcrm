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
import { MAX_WALK_ARTIFACT_BYTES, type StillSource, type Walk } from "./session";
import { withWalkTitleNote } from "./walk-meta";

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
 * A FAILED walk enqueues like a complete one for its STILLS: session.ts's reducer deliberately keeps
 * every still captured before the failure — a site visit that physically happened cannot be re-taken
 * from a desk, and dropping them here would silently discard evidence. This function must never
 * filter STILLS by walk.state.
 *
 * VIDEO is different, and deliberately NOT symmetric with stills: `walk.videoUri` is set by the
 * `started` event and is only a PROVISIONAL path — native itself only resolves `endWalk` (the
 * `finalized` event) once `AVAssetWriter` reaches `.completed` (see WalkEvent's doc comment in
 * session.ts). The reducer's `failed` case never clears `videoUri`, so a walk that fails mid-recording
 * or whose finalize() call rejects (native cancels the writer and rejects rather than handing back a
 * truncated file — see WalkthroughRecorder.swift's `finalize()`) still carries that same provisional
 * uri into the "failed" state, pointing at a file that is missing, truncated, or was never written at
 * all. Queuing it as a video artifact would forward that as if it were a real recording: its PUTs
 * fail repeatedly, the whole walk goes terminal (isWalkTerminal — one terminal artifact dooms
 * completion for every artifact in the walk), and the perfectly-good stills alongside it never get
 * filed either. So a video artifact is only ever built from `walk.state === "complete"`, the ONE
 * state the reducer only reaches via a `finalized` event — i.e., a file native itself confirmed.
 *
 * `audioUri` needs no equivalent guard: the reducer only ever sets it from `finalized` too (never
 * from `failed`), so it is already null on every failed walk today. It is currently always null in
 * practice (audio is muxed into the video track — see session.ts), so the "audio" branch below is
 * dead code today. It stays for the documented future fallback path (a walk that fails before the
 * muxed video finalizes may one day land an audio-only file), and because kind:"audio" is a value the
 * server contract already accepts.
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
  // ONLY a successful finalization ("complete") produced a confirmed, finalized video file — see
  // this function's doc comment above for why a "failed" walk's videoUri must never be trusted here,
  // even though it's frequently non-null.
  if (walk.state === "complete" && walk.videoUri) {
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
 * True when the server has already accepted this walk (isWalkCompleted) but it is STILL present in
 * the manifest — which can only mean the cleanup that's supposed to follow completion (deleting every
 * local artifact, then removeQueuedWalk) started but never finished, most likely because the app was
 * suspended or killed in the window drainWalkQueue leaves between persisting completedAt and running
 * those steps. This is not a hypothetical: a walk whose cleanup DID finish is removed from the
 * manifest entirely, so it can never again be observed as a QueuedWalk with completedAt set — every
 * walk this function sees IS, by construction, stranded mid-cleanup. See isWalkDrainable and
 * drainWalkQueue's cleanup-only branch for how that gets finished, idempotently, on the next drain.
 */
export function needsCleanup(walk: QueuedWalk): boolean {
  return isWalkCompleted(walk);
}

/**
 * A walk a drain should still act on. Note the short-circuit on any terminal artifact: because
 * completion requires EVERY artifact to be put, a single permanently-failed artifact means this walk
 * can never reach isWalkFullyPut — continuing to drain its other (still-retryable) artifacts would be
 * pure waste, since nothing they do can ever unlock completion. See isWalkTerminal, its mirror image.
 *
 * A walk that STILL needs cleanup (needsCleanup) is drainable too, ahead of every other check: the
 * server already accepted it, so there is no PUT or completion work left, only finishing the local
 * file deletes + manifest removal a prior crash left undone. Excluding it here (the original bug —
 * see needsCleanup's doc comment) meant nothing would EVER revisit it: getSchedulableWalkCount keys
 * on this function, so a stranded walk would never even be scheduled for another drain, let alone
 * cleaned up — a potentially-gigabyte leak of local media plus a manifest entry that outlives every
 * future run.
 */
export function isWalkDrainable(walk: QueuedWalk): boolean {
  if (needsCleanup(walk)) return true;
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

// ── An artifact this device can never file ────────────────────────────────────────────────────────
//
// The server presigns under a per-artifact byte ceiling (session.ts's MAX_WALK_ARTIFACT_BYTES) and
// refuses anything over it with a 400. Every other upload failure this queue models is worth
// retrying — a dropped connection, a 500, an expired signature — because the next attempt can go
// differently. This one cannot: the input to the refusal is the file's own size, and nothing on the
// phone can change it. Five attempts produce the same 400 five times.
//
// What made that expensive is that completion needs EVERY artifact, so one permanently-refused video
// took the STILLS from the same site visit down with it (isWalkTerminal), and the manifest entry
// then kept orphan recovery from offering a stills-only salvage. useWalk.ts's recording bound stops
// this build producing such a file at all; these two functions are for the ones that already exist —
// a walk queued by an earlier build, or an orphan directory recovered from one.

/** Whether the server will refuse to presign this artifact on its SIZE alone, whatever else is true
 *  of it. Strictly greater-than: the server's check is `> ceiling`, and a mirror that disagreed at
 *  the boundary would drop a file the server would have taken. */
export function isArtifactTooLargeToFile(sizeBytes: number): boolean {
  return sizeBytes > MAX_WALK_ARTIFACT_BYTES;
}

/**
 * Remove ONE unfilable artifact so the rest of the walk can still be filed, and record in the title
 * that it did not come.
 *
 * REFUSES to remove the last one, and that refusal is the difference between a fix and a silent
 * leak. A walk with zero artifacts is never fully-put, never completable, never terminal and
 * therefore never drainable — `isWalkDrainable` would stop returning it, `isWalkTerminal` would not
 * count it, and it would sit in the manifest with its files on disk, invisible to every surface, for
 * good. A walk whose only artifact cannot be sent has genuinely failed and must be seen to fail; the
 * caller handles that case (see upload.ts's drain) rather than this function inventing an outcome.
 *
 * The title note is the only channel that travels with the walk. By the time a drain discovers this,
 * the estimator is long gone from the site — they were told at RECORDING time, which is the only
 * moment they could have acted — and the office is the party left who can do anything with the fact
 * that a walk arrived without its video.
 *
 * The dropped file is NOT preserved: `finishWalkCleanup` deletes the walk's whole directory once the
 * server has filed it. That is deliberate and already the established treatment of a file this queue
 * refuses to upload — see toQueuedWalk, which excludes a failed walk's provisional walk.mp4, and
 * finishWalkCleanup's own header on why leaving such a file behind resurfaces it as a phantom orphan
 * at every launch, forever, for a walk the server already accepted.
 *
 * Returns the SAME reference when nothing was dropped, so a caller can tell the two outcomes apart
 * without re-deriving them.
 */
export function dropUnfilableArtifact(walk: QueuedWalk, idempotencyKey: string): QueuedWalk {
  const artifact = walk.artifacts.find((a) => a.idempotencyKey === idempotencyKey);
  if (!artifact) return walk;
  const remaining = walk.artifacts.filter((a) => a.idempotencyKey !== idempotencyKey);
  if (remaining.length === 0) return walk;
  return {
    ...walk,
    artifacts: remaining,
    title: withWalkTitleNote(walk.title, `(${artifact.kind} too large to send)`),
  };
}

/**
 * Spend an artifact's remaining PUT attempts at once — for a refusal that is already known to be
 * permanent, so the walk reaches the failed-walk card on THIS drain instead of four drains later.
 *
 * Not a shortcut for ordinary failures: those get their five attempts precisely because the next one
 * can go differently. Here the input is a fact about the file, so the four extra passes would re-read
 * the same size, reach the same verdict, and tell the estimator nothing they could not have been told
 * immediately — while the walk sat in the queue looking like it was still being tried.
 */
export function exhaustArtifactAttempts(
  walk: QueuedWalk,
  idempotencyKey: string,
  now: number,
): QueuedWalk {
  return {
    ...walk,
    artifacts: walk.artifacts.map((a) =>
      a.idempotencyKey === idempotencyKey
        ? { ...a, attempts: MAX_WALK_UPLOAD_ATTEMPTS, lastTriedAt: now }
        : a,
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

/** Written into `walkthroughs/<walkId>/` at START, before native is asked to record anything.
 *
 *  The manifest cannot answer "whose walk is this" for the case that matters. A walk interrupted by
 *  sign-out is deliberately never enqueued, so it has no manifest entry under ANY owner — that is
 *  the whole shape of the recovery path. Every consumer of that fact so far read it as "unowned",
 *  which on a shared device means the NEXT account to sign in is offered the previous estimator's
 *  site footage and can file it under any deal it can pick. Nothing about the directory says
 *  otherwise, because native has no signed-in identity to name.
 *
 *  So identity is written next to the bytes, at the one moment it is known and before any bytes
 *  exist. Not in the manifest: the manifest is the thing that is absent exactly when this is needed.
 *
 *  The name has no extension on purpose — `classifyWalkDirFileNames` recognises only `walk.mp4` and
 *  the still pattern and silently ignores everything else, so this can never be mistaken for an
 *  artifact, and it is removed with the directory by the ordinary cleanup delete. */
export const WALK_OWNER_FILE_NAME = "owner";

/** The marker's contents: the SANITIZED key, so it compares equal to the owner directory name the
 *  manifest already lives under and cannot carry a raw address into a file on disk. */
export function walkOwnerFileContents(ownerKey: string): string {
  return sanitizeWalkOwnerKey(ownerKey);
}

/**
 * Does this recording belong to `ownerKey`?
 *
 * `null` means the marker could not be read — either the directory predates this marker, or the
 * process died between native creating the directory and the marker landing. **Both answer false.**
 * An unattributable recording is not offered to anybody: the alternative is guessing, and the only
 * account available to guess in favour of is whoever happens to be signed in now, which is the
 * exposure this exists to prevent. The bytes are never deleted by that refusal — this module's scan
 * only ever declines to LIST them — so a wrongly-orphaned recording is recoverable by a build that
 * knows better, whereas footage filed under the wrong account is not recallable at all.
 */
export function isWalkOwnedBy(markerContents: string | null, ownerKey: string): boolean {
  if (markerContents === null) return false;
  return markerContents.trim() === sanitizeWalkOwnerKey(ownerKey);
}

// ── Recovery: Documents/walkthroughs/<walkId>/ directories with no manifest entry ─────────────────
//
// An app kill during recording, or after native finalizes but before useWalk.ts's terminal-enqueue
// effect ever runs `enqueueWalk`, leaves a walk's files sitting on disk with nothing in the manifest
// pointing at them: reducer state and the walkId are gone, so the normal toQueuedWalk path (which
// needs a `Walk`) can never run for them. Nothing else scans that directory.
//
// This is the walkthrough queue's analogue of the photo queue's selectOrphanFiles
// (../capture/upload-queue-core.ts), but the recovery it can offer is fundamentally narrower. The
// photo queue's orphans (`<id>.orig` / `<id>.jpg` siblings) are REDUNDANT copies of content a live
// index row already fully describes — safe to just delete. A walkthrough orphan is the OPPOSITE: it
// is the ONLY copy, and the manifest entry that would have described it — dealId, title, siteLabel,
// startedAt — is exactly what's missing and NOT recoverable from disk. The server requires a dealId
// (it's the URL path segment for both the upload-url and completion endpoints); nothing on disk says
// which deal a recovered walk belongs to, and inventing one would risk filing evidence against the
// wrong job, which is worse than the leak this exists to close. So this module can only ever tell a
// caller a directory's files EXIST — never queue them itself. See ./upload.ts's
// findRecoverableWalks/enqueueRecoveredWalk for the read/write split this implies: scanning is
// automatic, but attaching a dealId is a decision only a human (via whatever UI a caller builds) can
// make.

/** The video file native always writes — see WalkthroughRecorder.swift's `makeWalkDirectory` /
 *  `dir.appendingPathComponent("walk.mp4")`. One fixed name, unlike stills. */
const RECOVERED_VIDEO_FILE_NAME = "walk.mp4";

/** Stills are named `still-NNN.jpg`, zero-padded to 3 digits (WalkthroughRecorder.swift's
 *  `deliverStill`: `String(format: "still-%03d.jpg", stillIndex)`). Lexicographic sort on that fixed
 *  width IS numeric sort, up to 999 stills — comfortably above MAX_WALK_ARTIFACTS (200) — so sorting
 *  filenames recovers capture order without needing a per-file timestamp for ordering. */
const RECOVERED_STILL_FILE_PATTERN = /^still-\d+\.jpg$/;

export type ClassifiedWalkDirFiles = {
  /** Non-null iff RECOVERED_VIDEO_FILE_NAME is among the directory's entries. */
  videoFileName: string | null;
  /** In capture order (see RECOVERED_STILL_FILE_PATTERN's doc comment) — NOT raw directory-listing
   *  order, which FileSystem.readDirectoryAsync makes no guarantee about. */
  stillFileNames: string[];
};

/**
 * Sort one Documents/walkthroughs/<walkId>/ directory's raw entries into what this module recognizes
 * as walk artifacts. Anything else (there shouldn't be — native writes nothing but these two shapes —
 * but a stray .DS_Store or a future native change is not this function's problem to interpret) is
 * silently ignored rather than surfaced as a mystery artifact.
 */
export function classifyWalkDirFileNames(fileNames: string[]): ClassifiedWalkDirFiles {
  return {
    videoFileName: fileNames.includes(RECOVERED_VIDEO_FILE_NAME) ? RECOVERED_VIDEO_FILE_NAME : null,
    stillFileNames: fileNames.filter((name) => RECOVERED_STILL_FILE_PATTERN.test(name)).sort(),
  };
}

/**
 * Directory names under Documents/walkthroughs/ that no manifest accounts for.
 *
 * `knownWalkIds` must be every walkId in EVERY manifest on the device, in ANY state (queued,
 * mid-drain, terminal, even completed-awaiting-cleanup — see needsCleanup): each of those already has
 * an owner and a dealId, and only a directory with no manifest entry at all is a Fix-3 orphan. Every
 * manifest and not just the caller's, because Documents/walkthroughs/ is written by native, which has
 * no signed-in identity to scope by — passing one owner's walkIds here reports the OTHER owner's
 * live uploads as orphans. See ./upload.ts's claimedWalkIds for the full asymmetry.
 */
export function selectOrphanedWalkDirs(dirNames: string[], knownWalkIds: Iterable<string>): string[] {
  const known = new Set(knownWalkIds);
  return dirNames.filter((name) => !known.has(name));
}

// ── Is the walk.mp4 on disk a RECORDING, or just a file with that name? ───────────────────────────
//
// These are different questions, and the recovery scan used to conflate them. AVAssetWriter creates
// walk.mp4 at `startWriting` and appends samples into `mdat` as they arrive; the `moov` atom — the
// index without which no player can open the file — is written only by `finishWriting`. So the crash
// this whole recovery path exists to survive, an app kill DURING recording, leaves a walk.mp4 that
// exists, is large, and cannot be played.
//
// toQueuedWalk already refuses that file on the normal path, and for exactly this reason: it builds a
// video artifact only from `walk.state === "complete"`, the one state the reducer reaches via a
// `finalized` event, i.e. a writer native itself confirmed hit `.completed`. Recovery has no reducer
// state to consult, so it has to ask the container the same question directly. Presence of the moov
// atom IS that question — it is the byte-level record of `finishWriting` having run.
//
// WalkthroughRecorder.swift's finalize path rejects rather than resolves for a truncated walk.mp4,
// with the note that shipping one "is worse than a failure here — it looks like success." Recovery
// is the one path that could still do it.

/** Bytes to read at a box offset: 8 for the 32-bit header, 16 when `size == 1` puts a 64-bit length
 *  in the next 8. Reading a fixed 16 keeps the scan to one read per box either way. */
export const MP4_BOX_HEADER_BYTES = 16;

/** Below this a file cannot hold even one box header, so it cannot hold a moov — the AVAssetWriter
 *  created it and nothing was ever written. That is the ONLY size judgement made here: a byte
 *  threshold in kilobytes would be a guess in both directions, discarding a short but perfectly
 *  finalized walk while still passing a killed ten-minute recording, which is enormous and unplayable. */
export const MIN_FINALIZED_MP4_BYTES = MP4_BOX_HEADER_BYTES;

/**
 * Read one top-level MP4 box header. `size` is the WHOLE box including its header — what a caller
 * adds to the current offset to reach the next box.
 *
 * Returns null wherever the chain cannot be followed any further, which the caller must read as "no
 * moov": a short buffer, a `size` under the header it claims to include, or the `size == 0` form
 * (meaning "this box runs to end of file" — nothing can follow it, so a moov cannot). Guessing past
 * any of those would mean guessing whether an unplayable file is playable.
 */
export function readMp4BoxHeader(bytes: Uint8Array): { type: string; size: number } | null {
  if (bytes.length < 8) return null;
  const type = String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!);
  const size32 = readUint32BE(bytes, 0);
  if (size32 !== 1) return size32 >= 8 ? { type, size: size32 } : null;
  // The 64-bit form, which every walk long enough to matter uses for its `mdat`. Composed from two
  // 32-bit halves because a single `<<` in JS is a 32-bit operation and would silently wrap.
  if (bytes.length < 16) return null;
  const size = readUint32BE(bytes, 8) * 0x1_0000_0000 + readUint32BE(bytes, 12);
  return size >= 16 && Number.isSafeInteger(size) ? { type, size } : null;
}

function readUint32BE(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
}

export type RecoveredWalkArtifactFiles = {
  videoUri: string | null;
  /** Video's own capture timestamp, epoch ms — see toRecoveredQueuedWalk for why this should be the
   *  file's own timestamp, not the moment recovery ran. Ignored when videoUri is null. */
  videoAt?: number;
  /** In capture order (see classifyWalkDirFileNames). Empty if none were taken. */
  stills: Array<{ uri: string; at: number }>;
};

/**
 * Build the artifact list for a recovered walk directly from what's on disk. No `Walk` object exists
 * for a recovered walk — session.ts's reducer state is gone; that IS the premise of Fix 3 — so this
 * cannot reuse toQueuedWalk, which requires one.
 *
 * `at` for each artifact comes from the caller-supplied file timestamps (see ./upload.ts's
 * findRecoverableWalks/enqueueRecoveredWalk, which read each file's own last-modified time), NOT
 * `now`: defaulting every recovered artifact's capturedAtMs to the recovery moment would misrepresent
 * evidence that may be hours or days old, only if the caller genuinely could not read one.
 *
 * `dealId`/`projectId`/`title`/`siteLabel` are NOT derivable from disk at all (see the module note
 * above `classifyWalkDirFileNames`) and MUST come from the caller — who, unlike this module, is
 * allowed to ask a human which deal this belongs to. This function never guesses.
 *
 * Returns null under the same "nothing to enqueue" rule as toQueuedWalk: no video AND no stills.
 */
export function toRecoveredQueuedWalk(
  walkId: string,
  dealId: string,
  projectId: string | null,
  files: RecoveredWalkArtifactFiles,
  meta: WalkQueueMeta,
  now: number,
): QueuedWalk | null {
  const artifacts: QueuedWalkArtifact[] = [];
  if (files.videoUri) {
    artifacts.push({
      idempotencyKey: walkArtifactIdempotencyKey(walkId, "video"),
      kind: "video",
      uri: files.videoUri,
      at: files.videoAt ?? now,
      order: ORDER_MEDIA,
      attempts: 0,
    });
  }
  files.stills.forEach((still, index) => {
    artifacts.push({
      idempotencyKey: walkArtifactIdempotencyKey(walkId, "photo", index),
      kind: "photo",
      uri: still.uri,
      at: still.at,
      order: ORDER_PHOTO,
      attempts: 0,
    });
  });

  if (artifacts.length === 0) return null;

  return {
    walkId,
    dealId,
    projectId,
    title: meta.title,
    siteLabel: meta.siteLabel,
    // Genuinely unknown — never fabricated. A recovered walk has no reducer history, so there is no
    // truthful startedAt/endedAt/durationMs to report; null says exactly that, rather than a made-up
    // number that would misrepresent the walk's actual timeline.
    startedAt: null,
    endedAt: null,
    durationMs: null,
    enqueuedAt: now,
    artifacts,
    completionAttempts: 0,
  };
}
