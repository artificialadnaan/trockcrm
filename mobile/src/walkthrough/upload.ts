/**
 * Durable, resumable upload queue for glasses walkthrough artifacts (video with muxed audio, plus N
 * photos).
 *
 * A completed walk's files already live under Documents/walkthroughs/<walkId>/ — native writes them
 * there directly (never `tmp`), so unlike the photo queue this module never copies a file into a
 * separate queue directory. Enqueuing a walk persists a JSON MANIFEST that references those files by
 * their existing uris; the manifest — not the files — is what has to survive an app kill/restart, and
 * what has to self-heal a rotated iOS container UUID (see rebaseWalkUris below).
 *
 * TWO-PHASE drain, mirroring the server's two-step contract:
 *   1. Per artifact: request a presigned R2 URL and PUT the bytes. Safe to repeat UNTIL the walk is
 *      filed — the server derives the object key deterministically from (walkId, idempotencyKey), so a
 *      re-PUT overwrites the same object rather than forking a duplicate. Once the artifact HAS been
 *      filed the server refuses to re-presign it (ALREADY_FILED), precisely because that same
 *      determinism would otherwise let a later PUT replace the bytes behind a finished record.
 *   2. Once per walk, ONLY after every artifact has been PUT: call completion, which atomically writes
 *      every `files` row and enqueues forwarding. Local files are deleted ONLY after this call
 *      succeeds — see upload-core.ts's module header for why "bytes are in R2" and "the server filed
 *      the walk" are tracked as two separate, durable facts (putAt vs. completedAt).
 *
 * See ./upload-core.ts for why this deliberately does NOT reuse ../capture/upload-queue.ts's
 * machinery (enqueue-time compression, `staging`, GPS back-patch) even though the on-disk shape here
 * — crash-safe tmp+bak+rename manifest writes, an async mutex serializing read-modify-write, a
 * module-level `draining` guard, keep-awake during a drain — deliberately borrows its PATTERNS.
 */
import * as FileSystem from "expo-file-system/legacy";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import type { Fetcher } from "../api/endpoints";
import { ApiError } from "../api/client";
import { rebaseDocumentDirectoryUri } from "../capture/doc-dir-uri";
import type { Walk } from "./session";
import {
  MIN_FINALIZED_MP4_BYTES,
  MP4_BOX_HEADER_BYTES,
  WALK_OWNER_FILE_NAME,
  bumpArtifactAttempts,
  bumpCompletionAttempts,
  classifyWalkDirFileNames,
  drainableArtifacts,
  isWalkDrainable,
  isWalkOwnedBy,
  isWalkTerminal,
  markArtifactPut,
  markWalkCompleted,
  needsCleanup,
  needsCompletion,
  readMp4BoxHeader,
  removeQueuedWalk,
  resetTerminalWalkForRetry,
  sanitizeWalkOwnerKey,
  selectOrphanedWalkDirs,
  toQueuedWalk,
  toRecoveredQueuedWalk,
  upsertQueuedWalk,
  walkOwnerFileContents,
  type QueuedWalk,
  type QueuedWalkArtifact,
  type WalkArtifactKind,
  type WalkQueueMeta,
} from "./upload-core";
import {
  settleWalkTeardowns,
  walkBeingRecorded,
  walkTeardownsInFlight,
  watchWalkStarts,
} from "./walk-teardown";

export {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_WALK_COMPLETION_ATTEMPTS,
  MAX_WALK_UPLOAD_ATTEMPTS,
  classifyWalkDirFileNames,
  drainableArtifacts,
  isArtifactDrainable,
  isArtifactPut,
  isArtifactTerminal,
  isCompletionTerminal,
  isWalkCompleted,
  isWalkDrainable,
  isWalkFullyPut,
  isWalkTerminal,
  needsCleanup,
  needsCompletion,
  outstandingArtifacts,
  resetTerminalWalkForRetry,
  selectOrphanedWalkDirs,
  toQueuedWalk,
  toRecoveredQueuedWalk,
  walkArtifactIdempotencyKey,
  type ClassifiedWalkDirFiles,
  type QueuedWalk,
  type QueuedWalkArtifact,
  type RecoveredWalkArtifactFiles,
  type WalkArtifactKind,
  type WalkQueueMeta,
} from "./upload-core";

const ROOT_DIR = `${FileSystem.documentDirectory ?? ""}walkthrough-uploads/`;
const KEEP_AWAKE_TAG = "trockcam-walkthrough-upload-queue";

/** Where native actually writes walk artifacts (WalkthroughRecorder.swift's `makeWalkDirectory`) —
 *  NOT owner-scoped, unlike ROOT_DIR above: native has no concept of the signed-in-user+office
 *  identity this queue namespaces by. That asymmetry is permanent (native has no session to scope
 *  by), so recovery reconciles it explicitly rather than assuming a directory belongs to whoever
 *  happens to be signed in — see claimedWalkIds. */
const WALKTHROUGHS_DIR = `${FileSystem.documentDirectory ?? ""}walkthroughs/`;

function ownerDir(ownerKey: string): string {
  return `${ROOT_DIR}${sanitizeWalkOwnerKey(ownerKey)}/`;
}
function manifestFile(ownerKey: string): string {
  return `${ownerDir(ownerKey)}index.json`;
}
function walkDirUri(walkId: string): string {
  return `${WALKTHROUGHS_DIR}${walkId}/`;
}
function walkOwnerMarkerFile(walkId: string): string {
  return `${walkDirUri(walkId)}${WALK_OWNER_FILE_NAME}`;
}

/**
 * Stamp `walkthroughs/<walkId>/` with the account starting this walk, BEFORE native records anything.
 *
 * The ordering is the entire point. Native creates the directory inside `startWalk`, so a marker
 * written after that call returns leaves a window — an app kill inside it produces a recording no
 * account can be shown to own. Writing first closes it: `WalkthroughRecorder.makeWalkDirectory` uses
 * `createDirectory(withIntermediateDirectories: true)`, which succeeds on a directory that already
 * exists, so pre-creating here leaves native's own call a no-op rather than a conflict.
 *
 * A start that then FAILS leaves a directory holding only this marker. That is deliberately not
 * cleaned up here: the scan skips any directory that classifies to no video and no stills, so an
 * empty claim is invisible rather than offered as a walk holding nothing, and deleting on the
 * failure path would mean this function's error handling could destroy a directory a RETRY had
 * already legitimately re-claimed.
 */
export async function claimWalkDirForOwner(ownerKey: string, walkId: string): Promise<void> {
  await FileSystem.makeDirectoryAsync(walkDirUri(walkId), { intermediates: true });
  await FileSystem.writeAsStringAsync(walkOwnerMarkerFile(walkId), walkOwnerFileContents(ownerKey));
}

/** The marker's contents, or null when it cannot be read for ANY reason — absent, unreadable, or a
 *  directory that predates markers. `isWalkOwnedBy` treats null as "not yours", so the failure
 *  direction here is toward showing an estimator nothing rather than showing them someone else's
 *  walk. */
async function readWalkOwnerMarker(walkId: string): Promise<string | null> {
  try {
    return await FileSystem.readAsStringAsync(walkOwnerMarkerFile(walkId));
  } catch {
    return null;
  }
}

// ── SERVER CONTRACT SEAM ──────────────────────────────────────────────────────────────────────────
// The walkthrough ingress endpoint (server/, worker/) is real as of commit e901547bc. This is the
// exact contract this queue is written against — not a bare fetch call, not a guessed URL.
// `drainWalkQueue` takes an implementation of `WalkthroughUploadClient` as a parameter; the ONLY
// thing that needs to change to go live is providing a real implementation at the call site
// (two thin functions mirroring createUploadUrl/confirmUpload in ../api/endpoints.ts). Nothing in
// this module or upload-core.ts needs to change.
//
//   Step 1 (per artifact) — POST /api/field/projects/:dealId/glasses-walkthroughs/artifacts/upload-url
//   Step 2 (once per walk, after every artifact is PUT) — POST /api/field/projects/:dealId/glasses-walkthroughs
//
// /field, not /deals: this app signs in through `/auth/field-login`, and the server rejects that token
// class on every CRM route by design. Addressed at /deals every walk 401'd and the app read it as a dead
// session, so one stuck walk locked the crew out entirely.

export type WalkArtifactUploadUrlRequest = {
  walkId: string;
  idempotencyKey: string;
  kind: WalkArtifactKind;
  mimeType: string;
  fileSizeBytes: number;
};

export type WalkArtifactUploadUrlResponse = {
  uploadUrl: string;
  r2Key: string;
  expiresIn: number;
};

export type WalkCompletionArtifact = {
  idempotencyKey: string;
  kind: WalkArtifactKind;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  /** Epoch ms — QueuedWalkArtifact.at. */
  capturedAtMs: number;
};

export type WalkCompletionRequest = {
  walkId: string;
  title: string;
  siteLabel: string;
  projectId: string | null;
  /** ISO-8601 — converted from QueuedWalk.startedAt (epoch ms). */
  capturedAt: string;
  artifacts: WalkCompletionArtifact[];
};

export type WalkCompletionResponse = {
  walkId: string;
  /** Opaque to the client — the created `files` rows. Not consumed here. */
  files: unknown[];
  forwarding: { status: string; jobId: string | null };
};

/** THE SEAM. Everything in this module is written against this interface, never a bare fetch/URL.
 *  `dealId` is a separate parameter (not a body field) because it's the URL path segment on both
 *  real endpoints, not part of either request body. */
export type WalkthroughUploadClient = {
  requestUploadUrl(
    f: Fetcher,
    dealId: string,
    req: WalkArtifactUploadUrlRequest,
  ): Promise<WalkArtifactUploadUrlResponse>;
  completeWalk(f: Fetcher, dealId: string, req: WalkCompletionRequest): Promise<WalkCompletionResponse>;
};

// ── Manifest read/write (crash-safe: tmp → primary → bak, same shape as ../capture/upload-queue.ts) ─

async function ensureDir(ownerKey: string): Promise<void> {
  const dir = ownerDir(ownerKey);
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
}

async function readManifestFile(file: string): Promise<QueuedWalk[] | null> {
  try {
    const info = await FileSystem.getInfoAsync(file);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(file);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedWalk[]) : null;
  } catch {
    return null;
  }
}

/**
 * Rebase every artifact uri in `walk` onto the LIVE document directory. enqueueWalk froze an ABSOLUTE
 * uri (rooted at documentDirectory) into the manifest; the iOS container UUID in that path rotates
 * across an app update/reinstall/restore, so a queued artifact's baked uri would fail its
 * FileSystem.getInfoAsync/uploadAsync at drain time. This is exactly the exposure
 * ../capture/doc-dir-uri.ts exists to close — see that module's header for the full story.
 */
function rebaseWalkUris(walk: QueuedWalk): QueuedWalk {
  const liveDocDir = FileSystem.documentDirectory;
  let changed = false;
  const artifacts = walk.artifacts.map((a) => {
    const rebased = rebaseDocumentDirectoryUri(a.uri, liveDocDir);
    if (rebased === a.uri) return a;
    changed = true;
    return { ...a, uri: rebased };
  });
  return changed ? { ...walk, artifacts } : walk;
}

async function readManifest(ownerKey: string): Promise<QueuedWalk[]> {
  const file = manifestFile(ownerKey);
  // Prefer a valid .tmp (an interrupted write's newest intended state), then the live manifest, then
  // the .bak from the previous successful write. Empty only when all three are unreadable.
  const raw =
    (await readManifestFile(`${file}.tmp`)) ??
    (await readManifestFile(file)) ??
    (await readManifestFile(`${file}.bak`)) ??
    [];
  return raw.map(rebaseWalkUris);
}

// Crash-safe manifest write: serialize to a temp file first, keep the prior manifest as .bak, then
// atomically rename the temp into place — the live manifest is never observed half-written.
async function writeManifest(ownerKey: string, walks: QueuedWalk[]): Promise<void> {
  await ensureDir(ownerKey);
  const file = manifestFile(ownerKey);
  const tmp = `${file}.tmp`;
  const bak = `${file}.bak`;
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify(walks));
  const current = await FileSystem.getInfoAsync(file);
  if (current.exists) {
    await FileSystem.deleteAsync(bak, { idempotent: true }).catch(() => undefined);
    await FileSystem.copyAsync({ from: file, to: bak }).catch(() => undefined);
    await FileSystem.deleteAsync(file, { idempotent: true });
  }
  await FileSystem.moveAsync({ from: tmp, to: file });
}

// Serializes every manifest read-modify-write (enqueue vs. drain's per-artifact/per-walk mutations)
// so concurrent mutations can't clobber each other. Pure reads (getQueuedWalks) stay lock-free —
// writeManifest is atomic (tmp+move), so a read always sees a whole manifest, never a torn one.
function createMutex(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  const noop = () => undefined;
  return function run<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task, task);
    tail = result.then(noop, noop);
    return result;
  };
}
const withLock = createMutex();

/**
 * Notified after every manifest WRITE — the "something in the queue changed" signal.
 *
 * Load-bearing for the same reason startupScanListeners is, one screen over. Everything derived from
 * the manifest (getFailedWalkCount, getSchedulableWalkCount, getQueuedWalks) is an async READ of a
 * file this module owns; nothing about calling one of them tells React to call it again. A drain runs
 * detached from any screen — it is kicked off by the walk screen, the shell, the background task, or
 * Profile's own retry, and it outlives all of them — so the moment a walk exhausts its last retry is
 * a moment no component is in a position to notice. Profile's failed-walk card read the count once
 * per focus and then stayed however it was, which meant a walk going terminal while the estimator was
 * ALREADY sitting on Profile produced no card at all until they navigated away and back.
 *
 * Deliberately carries NO payload and NO owner: a subscriber re-reads whatever it actually cares
 * about, for whatever owner it is signed in as. A mutation for a DIFFERENT owner therefore costs a
 * subscriber one redundant manifest read, which is the right trade against the alternative of
 * routing owner identity through every mutation site.
 */
const walkQueueListeners = new Set<() => void>();

/** Subscribe to any manifest write; returns its own unsubscribe. See walkQueueListeners. */
export function subscribeWalkQueue(listener: () => void): () => void {
  walkQueueListeners.add(listener);
  return () => {
    walkQueueListeners.delete(listener);
  };
}

function notifyWalkQueueListeners(): void {
  // Iterate a copy — a React unsubscribe fired from within a listener would otherwise mutate the Set
  // mid-iteration (same reason as notifyStartupScanListeners).
  for (const listener of [...walkQueueListeners]) listener();
}

async function mutateManifest(
  ownerKey: string,
  fn: (walks: QueuedWalk[]) => QueuedWalk[],
): Promise<QueuedWalk[]> {
  const next = await withLock(async () => {
    const current = await readManifest(ownerKey);
    const updated = fn(current);
    await writeManifest(ownerKey, updated);
    return updated;
  });
  // Strictly OUTSIDE the lock. A listener is free to read the manifest (that is the whole point of
  // being told), and `withLock` is not reentrant — notifying from inside it would deadlock the queue
  // on the first subscriber that did the obvious thing.
  notifyWalkQueueListeners();
  return next;
}

// ── Public read API ──────────────────────────────────────────────────────────────────────────────

export async function getQueuedWalks(ownerKey: string): Promise<QueuedWalk[]> {
  return readManifest(ownerKey);
}

/** Count of walks a drain should be scheduled for — used to gate a background-task invocation. */
export async function getSchedulableWalkCount(ownerKey: string): Promise<number> {
  return (await readManifest(ownerKey)).filter(isWalkDrainable).length;
}

/** Count of walks that exhausted every retry available to them — drives a "failed" banner. */
export async function getFailedWalkCount(ownerKey: string): Promise<number> {
  return (await readManifest(ownerKey)).filter(isWalkTerminal).length;
}

/**
 * The retry path for whatever getFailedWalkCount is counting: resets every currently-TERMINAL
 * walk's retry counters (see resetTerminalWalkForRetry — never touches bytes already confirmed in
 * R2, never touches an actually-completed walk) so the NEXT drainWalkQueue call picks them back up
 * from wherever they left off. Does not itself drain — a caller (the retry UI) is expected to call
 * drainWalkQueue right after, same as enqueueWalk's caller does. Returns the number of walks reset,
 * so the UI can confirm something actually happened.
 */
export async function retryFailedWalks(ownerKey: string): Promise<number> {
  let resetCount = 0;
  await mutateManifest(ownerKey, (walks) =>
    walks.map((w) => {
      if (!isWalkTerminal(w)) return w;
      resetCount++;
      return resetTerminalWalkForRetry(w);
    }),
  );
  return resetCount;
}

// ── Enqueue ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Enqueue a completed (or failed) walk. Idempotent: calling this twice for the same walkId leaves the
 * existing entry — and any upload progress it has already made — untouched (see upsertQueuedWalk).
 * Returns null if `walk` has no terminal state yet, or produced no artifacts at all (see toQueuedWalk).
 */
export async function enqueueWalk(
  ownerKey: string,
  walkId: string,
  walk: Walk,
  meta: WalkQueueMeta,
  now: number = Date.now(),
): Promise<QueuedWalk | null> {
  const queued = toQueuedWalk(walkId, walk, meta, now);
  if (!queued) return null;
  await mutateManifest(ownerKey, (walks) => upsertQueuedWalk(walks, queued));
  return queued;
}

// ── Recovery (Fix 3): Documents/walkthroughs/ directories with no manifest entry ───────────────────
//
// See upload-core.ts's module note above classifyWalkDirFileNames for why nothing in THIS module may
// queue an orphan on its own: the server requires a dealId, and nothing on disk says which deal a
// recovered walk belongs to. The loop is closed one level up, by a caller that is allowed to ask a
// human — app/(app)/profile.tsx's RecoverableWalksCard, which puts the app's own project picker in
// front of the estimator and then calls enqueueRecoveredWalk with their answer.

export type RecoveredWalk = {
  walkId: string;
  /**
   * The walk's video — non-null ONLY when the container on disk is one AVAssetWriter actually
   * finished (see isFinalizedMp4). A `walk.mp4` the writer never closed is reported as no video at
   * all, because that is what it is: an unplayable file that would reach the office as a successful
   * site visit. This is the same judgement toQueuedWalk makes on the normal path.
   *
   * Stable for the life of a snapshot, which is why enqueueRecoveredWalk trusts it rather than
   * re-checking: native only ever writes into a walk directory while that walk is recording, and a
   * recording walk gets a fresh walkId, so nothing can turn an orphan's bytes back into a valid
   * container after the scan ran.
   */
  videoUri: string | null;
  /** In capture order. */
  stillUris: string[];
  /**
   * A `walk.mp4` was on disk and was REJECTED — the writer never finalized it. Distinct from
   * `videoUri === null` alone, which the caller cannot otherwise tell apart from a walk that only
   * ever took photos. The card needs the difference: "no video" to someone who remembers recording
   * one is its own falsehood, and every part of this surface is built to omit rather than misstate.
   */
  unfinishedVideo: boolean;
  /**
   * The LATEST file write across the directory, epoch ms — for the kill this recovery exists to
   * survive, that is the moment capture stopped. Null when the platform reports no timestamp at all.
   *
   * Carried because it is the only evidence on disk that narrows down WHICH job an orphan is, and
   * the caller has to make exactly that call. Null rather than `now` for the same reason
   * toRecoveredQueuedWalk leaves startedAt null: "recorded just now" for a two-day-old walk would
   * point the estimator at the wrong site, which is the very harm this whole path is careful about.
   */
  recordedAtMs: number | null;
  /**
   * First write to last write, in ms — a LOWER BOUND on how long the walk ran, never a duration.
   * Null when fewer than two files carry timestamps, or when they all landed in the same instant:
   * one instant is not a span, and padding it out would be a fabricated number.
   */
  captureSpanMs: number | null;
};

/** How long the scan will wait on a native teardown this process still has running before giving up
 *  on it (see ./walk-teardown.ts). Sized against what endWalk actually does: finalize the writer,
 *  plus awaitPendingStills' own 5-second ceiling on a photo still in transit. Fifteen seconds is
 *  several times the realistic worst case and still short enough that a wedged native call cannot
 *  keep the recovery card — the only surface these files can be saved from — off the screen. */
const WALK_TEARDOWN_SETTLE_MS = 15_000;

/**
 * Scan Documents/walkthroughs/ for artifact directories with no entry in `ownerKey`'s manifest — the
 * crash window Fix 3 closes: an app kill during recording, or after native finalizes but before
 * useWalk.ts's terminal-enqueue effect ever calls enqueueWalk, leaves files on disk that nothing else
 * will ever look for. Read-only: never deletes, never mutates the manifest, never uploads anything.
 * Best-effort — a directory that fails to list is skipped rather than failing the whole scan.
 *
 * Compared against EVERY manifest on this device, not just `ownerKey`'s — see claimedWalkIds. The
 * directory tree native writes is owner-blind while this queue is owner-scoped, and reconciling only
 * against the current owner meant an account or active-office switch turned the previous identity's
 * queued (even mid-drain) walks into "recoverable" ones for the new identity.
 *
 * ONLY safe to call when no walk could legitimately be recording right now in this process (e.g. app
 * cold start, before useWalk.ts mounts). A directory for a walk that's ACTIVELY being recorded has no
 * manifest entry yet EITHER — it isn't enqueued until it reaches a terminal state — so calling this
 * mid-recording would false-positive the live walk as "recoverable."
 *
 * "Nothing is recording" is NOT "nothing is being written", and the gap between them is a sign-out.
 * useWalk's unmount fires Recorder.endWalk() detached, so signing out mid-walk and back in seconds
 * later puts a new shell's scan against a directory native has not finished with — walk.mp4 with no
 * moov yet, and awaitPendingStills still able to add a still-NNN.jpg. Reading it then and freezing
 * "unfinished video" into the session's snapshot mislabels a recording that was about to be valid,
 * which on this path is unrecoverable in the only sense that matters: nobody re-walks a site because
 * an app said the video was broken. So the teardown is waited out first, and any walk still being
 * torn down when the budget runs out is left OUT of the answer rather than described wrongly.
 *
 * That wait is what makes the caller's precondition insufficient on its own. It runs while the
 * authenticated shell is already on screen and usable — up to fifteen seconds of it — so "nothing
 * could be recording when this was called" stopped implying "nothing could be recording while this
 * ran". A walk started in that window has no manifest entry (not enqueued until terminal) and no
 * teardown claim (it is starting, not ending), which is the precise shape this function reports as
 * an orphan: the live recording, offered to be filed a second time. And a row here is not just a
 * label — filing one uploads what it has and cleanup then deletes the walk DIRECTORY, so a live walk
 * in this answer is a site visit this app destroys while the estimator is still walking it.
 *
 * So starts are WATCHED for the whole call and dropped from the answer at the end — the one moment
 * that can account for a start at any await in between, without assuming anything about when
 * native's directory appears relative to the JS call — and whatever native was already recording at
 * entry is dropped with them. Not gated the other way round (a Start button that refuses for up to
 * fifteen seconds while this settles) because the estimator is standing on the roof by then, and a
 * wedged teardown must never be able to take a site visit away; the wait was bounded for that exact
 * reason. `enqueueRecoveredWalk` refuses a recording walk as well — a snapshot is frozen for a whole
 * shell lifecycle, so the last word on "is this still true" cannot be a check made at scan time.
 */
export async function findRecoverableWalks(ownerKey: string): Promise<RecoveredWalk[]> {
  // Seeded, not just watched: `watchWalkStarts` only hears walks that begin from here on, and the
  // caller's own precondition ("nothing can be recording at shell mount") is a fact about the
  // CALLER. A directory native is writing into right now is out of this answer on its own account.
  const recordingAtEntry = walkBeingRecorded();
  const liveWalkIds: string[] = recordingAtEntry === null ? [] : [recordingAtEntry];
  const stopWatchingStarts = watchWalkStarts((walkId) => liveWalkIds.push(walkId));
  try {
    return await scanForOrphanedWalkDirs(ownerKey, liveWalkIds);
  } finally {
    // Unsubscribed on the throwing path too, or a failed scan leaves a listener pushing into an
    // array nobody will ever read for the rest of the process.
    stopWatchingStarts();
  }
}

/** The scan itself. Split out only so the watch above is a plain try/finally around ONE expression —
 *  the exclusion is read at the end (see the caller), and a `return` buried in this body would be the
 *  easy way to lose it. */
async function scanForOrphanedWalkDirs(
  ownerKey: string,
  liveWalkIds: readonly string[],
): Promise<RecoveredWalk[]> {
  await settleWalkTeardowns(WALK_TEARDOWN_SETTLE_MS);
  // Read after the wait: whatever is still here outlasted the budget, and its directory is the one
  // thing on disk this function cannot make a truthful statement about.
  const stillTearingDown = new Set(walkTeardownsInFlight());
  const knownWalkIds = await claimedWalkIds(ownerKey);
  let dirNames: string[];
  try {
    dirNames = await FileSystem.readDirectoryAsync(WALKTHROUGHS_DIR);
  } catch {
    return []; // no walkthroughs directory at all — nothing has ever been recorded on this device
  }

  const recovered: RecoveredWalk[] = [];
  for (const walkId of selectOrphanedWalkDirs(dirNames, knownWalkIds)) {
    // Declining to classify, not hiding it. Every field this function would fill — the video's
    // verdict, the still list, the recorded time — is still moving, so a row for it would be a
    // guess dressed as a reading, cached for the whole shell lifecycle. The bytes are untouched and
    // unclaimed, so the next launch (where nothing is in flight) describes them correctly.
    if (stillTearingDown.has(walkId)) continue;
    // Whose walk is this? Asked BEFORE any of the reads below, because the answer is the one that
    // can disqualify the directory outright, and asking it late would mean statting another
    // estimator's files to build a row we then discard.
    //
    // The manifest cannot answer this. A walk interrupted by sign-out is never enqueued, so it has
    // no entry under ANY owner — which is exactly the case this scan exists for, and exactly the
    // case where "absent from every manifest" was being read as "belongs to whoever is signed in
    // now". On a shared device that handed the next estimator the previous one's site footage, with
    // a project picker attached.
    if (!isWalkOwnedBy(await readWalkOwnerMarker(walkId), ownerKey)) continue;
    let fileNames: string[];
    try {
      fileNames = await FileSystem.readDirectoryAsync(walkDirUri(walkId));
    } catch {
      continue; // not actually a directory, or unreadable — skip rather than abort the whole scan
    }
    const { videoFileName, stillFileNames } = classifyWalkDirFileNames(fileNames);
    if (!videoFileName && stillFileNames.length === 0) continue; // e.g. an empty dir from a walk
    // that failed before native ever produced anything — nothing to recover, not a leak.
    const dir = walkDirUri(walkId);
    const videoOnDisk = videoFileName ? `${dir}${videoFileName}` : null;
    const stillUris = stillFileNames.map((name) => `${dir}${name}`);
    // The file being THERE is not the file being a recording — see upload-core.ts's note above
    // readMp4BoxHeader. A kill during recording leaves a walk.mp4 with no moov atom, and offering it
    // as a video hands the office something that will not open, filed as a successful site visit.
    const videoUri = videoOnDisk !== null && (await isFinalizedMp4(videoOnDisk)) ? videoOnDisk : null;
    // Only the video was unusable, so there is nothing left to file. Same rule as a directory that
    // classifies to nothing: a row here could only lead the estimator through a project picker to an
    // empty upload. The bytes stay on disk untouched — this function never deletes.
    if (videoUri === null && stillUris.length === 0) continue;
    // One extra stat per artifact, paid only for directories that ARE orphans (normally none), so a
    // caller can tell the estimator when this walk happened. It is deliberately NOT reused as the
    // artifacts' capturedAt: enqueueRecoveredWalk re-stats at enqueue time, which is both fresher
    // and per-file, whereas these two are a display summary of the walk as a whole.
    //
    // A REJECTED video still contributes its timestamp. Declining to upload the file is not a reason
    // to forget when it was written, and for a killed recording that last write IS the moment capture
    // stopped — the single strongest clue the estimator has to which job this was.
    const times = (await Promise.all([videoOnDisk, ...stillUris].map(fileTimestampMsOrNull))).filter(
      (t): t is number => t !== null,
    );
    const span = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
    recovered.push({
      walkId,
      videoUri,
      stillUris,
      unfinishedVideo: videoOnDisk !== null && videoUri === null,
      recordedAtMs: times.length > 0 ? Math.max(...times) : null,
      captureSpanMs: span > 0 ? span : null,
    });
  }
  // Read once, here, rather than skipped inside the loop: a walk can start at ANY await above — the
  // teardown wait, the manifest reads, the box-chain reads of some other directory — and only the
  // end of the scan is after all of them. Every field of a row for a walk that is recording right now
  // is a reading of a file still being written, cached for the whole shell lifecycle, and the action
  // attached to that row deletes the directory it describes. The bytes are untouched, so the next
  // shell lifecycle — with that walk long since queued, or genuinely orphaned — describes them
  // correctly. Same declining-to-classify rule as a teardown that outlasts the budget, for the same
  // reason.
  return recovered.filter((walk) => !liveWalkIds.includes(walk.walkId));
}

/**
 * Every walkId ANY manifest on this device claims, not just `ownerKey`'s.
 *
 * The asymmetry this exists to reconcile is structural, not an oversight to be tidied away: native
 * writes Documents/walkthroughs/<walkId>/ with no notion of who is signed in (it has no user, no
 * office, no session), while this queue namespaces manifests per owner precisely so one identity's
 * uploads can never be moved by another's. Neither side can adopt the other's model — so the two
 * facts are reconciled here, at the one place that has to compare them.
 *
 * Reconciled in this direction because of what the two mistakes cost. Under-claiming reports a
 * directory the PREVIOUS owner still has queued as recoverable to the new one; filing it then writes
 * the same on-disk uris into a second manifest, and the first drain to finish deletes the walk
 * directory (cleanup removes the directory, not just the artifacts it listed) out from under the
 * other — whose completion call then points at bytes that no longer exist anywhere, on the one device
 * that had them. Over-claiming, by contrast, costs a walk that stays invisible in someone else's
 * queue and drains from there anyway.
 *
 * It does NOT close the window recovery exists for: a walk orphaned by sign-out or an app kill has no
 * manifest entry under ANY owner — the enqueue effect died with the shell before it ever ran — so
 * nobody claims it and the same user still finds it at their next login.
 *
 * Other owners' manifests are read RAW: only walkIds are wanted, and a walkId is not a path, so none
 * of readManifest's container-UUID rebasing applies. Each is read through the same tmp → primary →
 * bak preference as its owner's own reader, or a manifest caught mid-write would read as empty and
 * un-claim every walk in it. Best-effort throughout: a directory that cannot be listed leaves this
 * owner's own manifest as the answer, which is where it started.
 */
async function claimedWalkIds(ownerKey: string): Promise<string[]> {
  const ids = (await readManifest(ownerKey)).map((w) => w.walkId);
  let ownerDirNames: string[];
  try {
    ownerDirNames = await FileSystem.readDirectoryAsync(ROOT_DIR);
  } catch {
    return ids; // nothing has ever been queued on this device beyond (possibly) this owner
  }
  const ownDirName = sanitizeWalkOwnerKey(ownerKey);
  for (const dirName of ownerDirNames) {
    if (dirName === ownDirName) continue; // already read above, through the rebasing reader
    const file = `${ROOT_DIR}${dirName}/index.json`;
    const walks =
      (await readManifestFile(`${file}.tmp`)) ??
      (await readManifestFile(file)) ??
      (await readManifestFile(`${file}.bak`)) ??
      [];
    // Shape-checked because this is the one place the module reads a file it did not write in this
    // owner's namespace: readManifestFile only guarantees an array, and a corrupt entry must cost a
    // skipped claim rather than an undefined swept into the exclusion set (where it would match
    // nothing and read as a scan failure).
    for (const walk of walks) if (typeof walk?.walkId === "string") ids.push(walk.walkId);
  }
  return ids;
}

/** Ceiling on how many top-level boxes the scan will follow, so a corrupt file with an eight-byte
 *  box repeated forever cannot spin the startup scan. A real finalized walk has a handful. */
const MAX_MP4_BOX_SCAN = 32;

/**
 * Whether `uri` is an MP4 whose writer actually FINISHED it — i.e. whether the `moov` atom
 * `AVAssetWriter.finishWriting` appends is present. See upload-core.ts's note above readMp4BoxHeader
 * for why the file merely existing proves nothing.
 *
 * Walks the top-level box chain instead of reading the file: a walk video is hundreds of megabytes
 * and the answer lives in a handful of 16-byte headers (`ftyp`, `mdat`, then `moov`), so this is a
 * few ranged reads regardless of how long the recording is. `mdat` is skipped by its declared length,
 * never scanned. Any read failure, malformed header, or length that runs past the end of the file
 * ends the walk as "not finalized" — every one of those means the chain cannot be followed to a moov,
 * which is the same thing. A moov the file does not actually CONTAIN is the same thing too; see the
 * fit check inside the loop, which is what makes the answer a statement about the file rather than
 * about one header in it.
 */
async function isFinalizedMp4(uri: string): Promise<boolean> {
  let fileSize: number;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return false;
    fileSize = typeof info.size === "number" ? info.size : 0;
  } catch {
    return false;
  }
  // The decisive size case, and the only one: the writer created the file and never wrote a sample.
  if (fileSize < MIN_FINALIZED_MP4_BYTES) return false;

  let offset = 0;
  for (let box = 0; box < MAX_MP4_BOX_SCAN; box++) {
    if (offset + 8 > fileSize) return false; // ran off the end without ever reaching a moov
    let header: Uint8Array;
    try {
      header = decodeBase64Bytes(
        await FileSystem.readAsStringAsync(uri, {
          encoding: "base64",
          position: offset,
          length: MP4_BOX_HEADER_BYTES,
        }),
      );
    } catch {
      return false;
    }
    const parsed = readMp4BoxHeader(header);
    if (parsed === null) return false;
    // A declared box has to FIT INSIDE the file, and that is checked before the type is trusted for
    // anything — most of all for the moov. AVAssetWriter writes a box's header before its body, so a
    // kill during finishWriting — the precise window this function exists to detect — leaves a moov
    // that announces a size the file never received. Answering on the header alone declared that file
    // finalized and offered the office a video that opens to nothing, which is the one outcome worse
    // than reporting no video at all: it arrives looking like a successful site visit.
    //
    // Applied to every box rather than just the moov, because a chain that does not fit inside its own
    // file is not a container anyone can follow. An `mdat` whose length was stamped before the samples
    // arrived walks the offset past EOF; the loop's own guard caught that one iteration later, but only
    // by accident of the next read, and "the box before it lied about its size" is the same verdict.
    if (offset + parsed.size > fileSize) return false;
    if (parsed.type === "moov") return true;
    offset += parsed.size;
  }
  return false;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Self-contained base64 → bytes, the same reason ../auth/session.ts carries its own: no atob in
 *  Hermes to depend on, and behaviour identical across Hermes, jest and tsc. Only ever fed the
 *  16-byte box headers above, so it is not a general-purpose decoder — anything outside the alphabet
 *  is skipped rather than raising (expo encodes with `.endLineWithLineFeed`, so a longer read would
 *  carry newlines), and the caller reads a short result as "not finalized". */
function decodeBase64Bytes(b64: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of b64) {
    if (ch === "=") break;
    const idx = B64_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Convenience count for a caller that only needs to drive a badge/banner — see findRecoverableWalks
 *  for what it's counting and its cold-start-only caveat. */
export async function getRecoverableWalkCount(ownerKey: string): Promise<number> {
  return (await findRecoverableWalks(ownerKey)).length;
}

/**
 * The scan, taken once per AUTHENTICATED-SHELL LIFECYCLE and remembered for the rest of it.
 *
 * `findRecoverableWalks` is only meaningful before any walk could be recording — an ACTIVE walk has
 * no manifest entry either (it is not enqueued until terminal), so scanning mid-recording reports
 * the live walk as orphaned. `walk.tsx` is a hidden `Tabs.Screen` that never unmounts, so a screen
 * that scanned on focus would hit exactly that case the moment someone opened Profile mid-walk.
 * Entering the authenticated shell — which every walk screen mounts UNDER, and therefore after — is
 * the window where the answer is trustworthy. Everything until that shell goes away reads this
 * snapshot rather than re-scanning.
 *
 * "After the walk screen unmounted" is not the same as "after native stopped writing", and on a
 * sign-out/sign-in it is seconds short of it — findRecoverableWalks closes that half itself rather
 * than the shell trying to time its mount, since the shell has no way to know.
 *
 * Once per shell, NOT once per process, and the difference is the whole point of `scannedOwnerKey`
 * and `forgetRecoverableWalksAtStartup` below. A module variable outlives sign-out: the process is
 * still running, so a second sign-in on the same device kept being served the FIRST session's
 * answer. That silently defeated useWalk's unmount finalize, which exists precisely so a walk
 * interrupted by sign-out is discoverable at the next login — the directory it left behind never
 * appeared until the app itself was killed and relaunched. A snapshot is also only an answer for
 * the owner it was computed against: it excludes walks tracked in THAT owner's manifest, so serving
 * it to a different signed-in identity both hides their orphans and claims walks that are not
 * theirs to see.
 */
let recoverableAtStartup: RecoveredWalk[] | null = null;
/** Which owner `recoverableAtStartup` was computed for. Null whenever the snapshot is. */
let scannedOwnerKey: string | null = null;
/** Bumped on every teardown, so a scan the teardown overtook cannot publish afterwards: the scan is
 *  async, and a shell that unmounts mid-scan would otherwise get the departing owner's result
 *  installed as the incoming one's snapshot — the exact staleness the teardown just cleared. */
let scanLifecycle = 0;

/**
 * Notified the moment the startup scan resolves.
 *
 * Load-bearing, not a convenience: the scan is async and is kicked off by the authenticated shell's
 * mount effect, so a screen that renders in that same tick (a cold launch straight onto Profile, or
 * a deep link into it) reads the snapshot BEFORE it exists. Completing the scan used to only assign
 * the module variable above — no React state, no event — so nothing told that screen to look again;
 * its recovery card stayed hidden until some unrelated parent rerender happened to sweep it back in,
 * which is not something a caller can rely on and left real, unqueued recordings invisible.
 */
const startupScanListeners = new Set<() => void>();

/**
 * Subscribe to any change in the snapshot — a scan resolving, or a lifecycle teardown clearing it;
 * returns its own unsubscribe. Shaped for React's useSyncExternalStore paired with
 * getRecoverableWalksFromStartup as the snapshot — see app/(app)/profile.tsx's RecoverableWalksCard.
 */
export function subscribeRecoverableWalksFromStartup(listener: () => void): () => void {
  startupScanListeners.add(listener);
  return () => {
    startupScanListeners.delete(listener);
  };
}

function notifyStartupScanListeners(): void {
  // Iterate a copy: a React unsubscribe fired from within a listener would otherwise mutate the Set
  // mid-iteration.
  for (const listener of [...startupScanListeners]) listener();
}

/** Called once per authenticated-shell lifecycle, from that shell's mount effect. Best-effort;
 *  never throws. Repeat calls for the SAME owner within one lifecycle are free — and deliberately
 *  do not re-scan, since by then a walk may well be recording. */
export async function scanRecoverableWalksAtStartup(ownerKey: string): Promise<void> {
  if (recoverableAtStartup !== null && scannedOwnerKey === ownerKey) return;
  const lifecycle = scanLifecycle;
  try {
    const found = await findRecoverableWalks(ownerKey);
    if (lifecycle !== scanLifecycle) return; // the shell that asked is already gone
    recoverableAtStartup = found;
    scannedOwnerKey = ownerKey;
    notifyStartupScanListeners();
  } catch {
    // A failed scan must never block launch. Left null so the next lifecycle can retry rather than
    // caching an empty result that would hide real orphans for the rest of the session.
  }
}

/**
 * Drop the snapshot, so the next `scanRecoverableWalksAtStartup` genuinely scans. Called from the
 * authenticated shell's teardown — sign-out, or the shell unmounting — which is the one moment that
 * is BOTH "this answer is now stale" and "nothing can be recording" (a walk screen only exists
 * under that shell). Doing it at teardown rather than at the next mount is what keeps the invariant
 * above intact: the module never has to decide mid-session whether a re-scan is safe.
 *
 * Notifies too, so a component still mounted against the previous snapshot drops back to empty
 * instead of rendering a result the module no longer holds.
 */
export function forgetRecoverableWalksAtStartup(): void {
  scanLifecycle++;
  recoverableAtStartup = null;
  scannedOwnerKey = null;
  notifyStartupScanListeners();
}

/**
 * Retire ONE walk from the snapshot, because it is no longer an orphan — the caller just filed it
 * with enqueueRecoveredWalk, so it now has a manifest entry and drains like any other walk.
 *
 * Necessary precisely BECAUSE the snapshot is frozen for the whole shell lifecycle. Re-scanning to
 * notice the change is the one thing this module must not do mid-session: a walk recording right now
 * has no manifest entry either, so a re-scan would report the live recording as recoverable and
 * offer to file a video still being written. So the snapshot is edited in place instead — the only
 * fact that changed is one this process itself caused, and it is applied without touching disk.
 *
 * Without it the recovery card would keep offering a walk it has already filed. That is not just a
 * stale row: enqueueRecoveredWalk is idempotent per walkId, so a second filing under a DIFFERENT
 * deal would appear to succeed while silently doing nothing — the estimator would be told their
 * correction landed when the walk is still on its way to the first project they picked.
 *
 * Scoped to `ownerKey` for the same reason the snapshot itself is: a filing by one signed-in
 * identity says nothing about another's orphans, and their manifests are different namespaces.
 * Publishes only on a real change, so a repeat call (a double-tap that lost the race) costs a
 * no-op rather than a rerender.
 */
export function forgetRecoveredWalk(ownerKey: string, walkId: string): void {
  if (recoverableAtStartup === null || scannedOwnerKey !== ownerKey) return;
  const next = recoverableAtStartup.filter((w) => w.walkId !== walkId);
  if (next.length === recoverableAtStartup.length) return;
  recoverableAtStartup = next;
  notifyStartupScanListeners();
}

/** The one empty result, never re-created. This getter is used as a useSyncExternalStore snapshot,
 *  and React compares snapshots by IDENTITY — returning a fresh `[]` on each call would make every
 *  render look like a store change and spin the subscriber forever ("The result of getSnapshot
 *  should be cached to avoid an infinite loop"). */
const NO_RECOVERABLE_WALKS: RecoveredWalk[] = [];

/**
 * What the startup scan found, or an empty list if it never ran or failed. Safe to call at any time
 * — it reads the snapshot rather than re-scanning, so it cannot mistake a live walk for an orphan.
 * Pair it with subscribeRecoverableWalksFromStartup in a component, or a caller that reads it before
 * the scan resolves will never learn the answer changed.
 */
export function getRecoverableWalksFromStartup(): RecoveredWalk[] {
  return recoverableAtStartup ?? NO_RECOVERABLE_WALKS;
}

/** A file's own last-modified time in epoch ms, or null when the platform reports none (or the uri
 *  is absent — accepted so a walk with no video can be summarised in one pass). expo-file-system
 *  reports `modificationTime` in SECONDS, not ms. */
async function fileTimestampMsOrNull(uri: string | null): Promise<number | null> {
  if (!uri) return null;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && typeof info.modificationTime === "number"
      ? Math.round(info.modificationTime * 1000)
      : null;
  } catch {
    return null;
  }
}

/** A file's own last-modified time in epoch ms, or `fallback` if it can't be read — see
 *  toRecoveredQueuedWalk's doc comment (upload-core.ts) for why a recovered artifact's captured-at
 *  should be the file's own timestamp, not the moment recovery happened, whenever the platform can
 *  report one. */
async function fileTimestampMs(uri: string, fallback: number): Promise<number> {
  return (await fileTimestampMsOrNull(uri)) ?? fallback;
}

/**
 * File a recovered walk under a deal the CALLER resolved out-of-band — this module never guesses one
 * (see findRecoverableWalks / upload-core.ts's module note). Idempotent the same way enqueueWalk is
 * (upsertQueuedWalk): calling this twice for the same walkId leaves the first call's progress
 * untouched. Once enqueued, a recovered walk drains exactly like any other QueuedWalk — nothing
 * downstream of the manifest needs to know it was recovered rather than freshly captured. Returns
 * null if the directory turned out to have neither a video nor any stills by the time this ran (e.g.
 * it raced a concurrent cleanup).
 *
 * THROWS for a walk native is recording right now, and that refusal is the point at which this stops
 * being a bookkeeping function. Its input is a row from a snapshot deliberately frozen for a whole
 * shell lifecycle (see scanRecoverableWalksAtStartup), so "this was an orphan" is a statement about
 * a moment that has already passed. Acting on a stale one is destructive, not merely wrong: the
 * queued walk uploads the stills it can see, the completion call succeeds, and cleanup then removes
 * the walk DIRECTORY — walk.mp4 and every still still to come with it — out from under a writer that
 * is still appending to them. The scan will not produce such a row (it excludes live walks at both
 * ends), and this is the guarantee that does not depend on the scan having been right.
 */
export async function enqueueRecoveredWalk(
  ownerKey: string,
  recovered: RecoveredWalk,
  dealId: string,
  projectId: string | null,
  meta: WalkQueueMeta,
  now: number = Date.now(),
): Promise<QueuedWalk | null> {
  if (walkBeingRecorded() === recovered.walkId) {
    // Loud rather than a silent null: the caller's null branch means "the files are gone" and leaves
    // the row in place, which is the right handling for a race with cleanup and the wrong handling
    // for this. Profile renders this text, and the estimator is the one person who can end the walk.
    throw new Error("That walk is still recording — end it before filing it.");
  }
  const [videoAt, stills] = await Promise.all([
    recovered.videoUri ? fileTimestampMs(recovered.videoUri, now) : Promise.resolve(undefined),
    Promise.all(recovered.stillUris.map(async (uri) => ({ uri, at: await fileTimestampMs(uri, now) }))),
  ]);
  const queued = toRecoveredQueuedWalk(
    recovered.walkId,
    dealId,
    projectId,
    { videoUri: recovered.videoUri, videoAt, stills },
    meta,
    now,
  );
  if (!queued) return null;
  await mutateManifest(ownerKey, (walks) => upsertQueuedWalk(walks, queued));
  return queued;
}

// ── Drain ────────────────────────────────────────────────────────────────────────────────────────

function contentTypeForArtifact(kind: WalkArtifactKind, uri: string): string {
  const ext = uri.slice(uri.lastIndexOf(".") + 1).toLowerCase();
  if (kind === "photo") return ext === "png" ? "image/png" : "image/jpeg";
  if (kind === "video") return ext === "mov" ? "video/quicktime" : "video/mp4";
  return ext === "wav" ? "audio/wav" : "audio/mp4"; // m4a/aac/mp4 default
}

function filenameFromUri(uri: string): string {
  const withoutQuery = uri.split(/[?#]/)[0]!;
  const idx = withoutQuery.lastIndexOf("/");
  return idx >= 0 ? withoutQuery.slice(idx + 1) : withoutQuery;
}

/** Step 1: request a presigned URL and PUT one artifact's bytes. Returns the size that was actually
 *  uploaded (for markArtifactPut / the later completion payload). Throws on any failure — the caller
 *  bumps the artifact's attempt count and moves on. */
/**
 * Whether a presign refusal means "the server already has this artifact", rather than a real failure.
 *
 * Matched on the server's error CODE, not its status or message: a 409 alone is too broad (the
 * completion route uses one for a genuine cross-deal conflict, which must still fail), and message text
 * is not a contract. The code is.
 */
function isAlreadyFiledError(err: unknown): boolean {
  return err instanceof ApiError && err.code === "GLASSES_WALKTHROUGH_ARTIFACT_ALREADY_FILED";
}

async function putArtifactBytes(
  client: WalkthroughUploadClient,
  f: Fetcher,
  walk: QueuedWalk,
  artifact: QueuedWalkArtifact,
): Promise<number> {
  const info = await FileSystem.getInfoAsync(artifact.uri);
  if (!info.exists) {
    throw new Error(`Walk artifact missing on disk: ${artifact.kind} ${artifact.idempotencyKey}`);
  }
  const mimeType = contentTypeForArtifact(artifact.kind, artifact.uri);
  const fileSizeBytes = typeof info.size === "number" ? info.size : 0;

  let uploadUrl: string;
  try {
    ({ uploadUrl } = await client.requestUploadUrl(f, walk.dealId, {
      walkId: walk.walkId,
      idempotencyKey: artifact.idempotencyKey,
      kind: artifact.kind,
      mimeType,
      fileSizeBytes,
    }));
  } catch (err) {
    // ALREADY_FILED is success that arrived as an error. The server refuses to re-presign an artifact
    // it has already filed, because the R2 key is deterministic and a second PUT would silently replace
    // the bytes behind a record whose size, checksum and derived scope all describe the OLD content.
    //
    // For this queue that refusal means the work is DONE, not failed. Without this branch the artifact
    // burns all five PUT attempts and the walk lands on the failed-walk card telling the estimator their
    // site visit did not send — for a walk the server is holding in full. Treat it as put and move on;
    // the completion call is idempotent per artifact and reconciles the rest.
    if (isAlreadyFiledError(err)) return fileSizeBytes;
    throw err;
  }

  const put = await FileSystem.uploadAsync(uploadUrl, artifact.uri, {
    httpMethod: "PUT",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { "Content-Type": mimeType },
  });
  if (put.status < 200 || put.status >= 300) {
    throw new Error(`Walk artifact upload to storage failed (R2 returned ${put.status}).`);
  }
  return fileSizeBytes;
}

/** Step 2: the ONE completion call for a fully-put walk. Sizes/filenames come from the artifact
 *  records as they were AT PUT TIME (QueuedWalkArtifact.sizeBytes), not a fresh re-stat — that's
 *  exactly what was actually uploaded, and it doesn't require the file to still exist unchanged. */
async function callCompletion(
  client: WalkthroughUploadClient,
  f: Fetcher,
  walk: QueuedWalk,
): Promise<WalkCompletionResponse> {
  return client.completeWalk(f, walk.dealId, {
    walkId: walk.walkId,
    title: walk.title,
    siteLabel: walk.siteLabel,
    projectId: walk.projectId,
    capturedAt: new Date(walk.startedAt ?? Date.now()).toISOString(),
    artifacts: walk.artifacts.map((a) => ({
      idempotencyKey: a.idempotencyKey,
      kind: a.kind,
      originalFilename: filenameFromUri(a.uri),
      mimeType: contentTypeForArtifact(a.kind, a.uri),
      fileSizeBytes: a.sizeBytes ?? 0,
      capturedAtMs: a.at,
    })),
  });
}

/**
 * Delete `walk`'s local media, then remove its manifest entry — the ONLY two steps that may run once
 * completedAt is set (see the module header / needsCleanup's doc comment in upload-core.ts).
 * Idempotent in both halves: deleteAsync({idempotent:true}) tolerates a file a partially-finished
 * PRIOR cleanup attempt already removed, and removeQueuedWalk no-ops if the entry is somehow already
 * gone. Shared by drainWalkQueue's normal post-completion cleanup and its Fix 2 cleanup-only branch
 * (a walk found already completedAt-stamped on entry) so both paths behave identically.
 *
 * "Local media" is the walk's whole DIRECTORY, not just the uris its manifest entry happens to list,
 * and the difference is a real leak rather than tidiness. `toQueuedWalk` deliberately excludes a
 * FAILED walk's provisional walk.mp4 — finalization never completed, so that file is not a video
 * anyone should upload — while still queuing every still that was captured before the failure. The
 * manifest's artifact list is then a strict subset of what native wrote, and an artifact-driven
 * cleanup leaves the partial mp4 sitting in `Documents/walkthroughs/<walkId>/` with its manifest
 * entry now deleted. Nothing can ever account for it again: findRecoverableWalks reports exactly
 * "directory with no manifest entry," so that abandoned file resurfaces on Profile as a NEW
 * unqueued recording at every launch, forever, for a walk the server already accepted.
 *
 * The directory delete is held to the same standard as the file deletes for the same reason: on-device
 * a directory whose contents cannot be removed cannot be removed either, so a rejection here means
 * media is still on the phone and the entry must stay for a later drain to retry.
 *
 * Returns whether the cleanup actually FINISHED, and deliberately keeps the manifest entry when it
 * did not. `idempotent: true` already resolves for a path that isn't there, so a rejection here is
 * never "already deleted" — it is a real I/O failure with a (potentially multi-GB) file still on the
 * phone. This used to swallow that with `.catch(() => undefined)` and prune the entry anyway, which
 * converted a transient failure into a permanent leak: needsCleanup can only ever see walks still IN
 * the manifest, so once the entry was gone no drain — foreground or background — could ever retry
 * the delete, and the leftover Documents/walkthroughs/<walkId>/ directory would then read to
 * findRecoverableWalks as an ORPHAN, i.e. a walk that never uploaded, when the server had in fact
 * already filed it. Keeping the entry costs a few hundred bytes of manifest and one retry per drain;
 * dropping it costs the whole recording. There is no attempt cap on this on purpose: a walk whose
 * bytes the server already has is worth retrying indefinitely, and every retry is idempotent.
 */
async function finishWalkCleanup(ownerKey: string, walk: QueuedWalk): Promise<boolean> {
  // Artifacts first, then the directory — not concurrently. An artifact uri is not guaranteed to sit
  // under this walk's directory (rebaseWalkUris rewrites container UUIDs, and a recovered walk is
  // enqueued from paths the caller supplied), so the per-uri deletes are what actually guarantees
  // every file the manifest promised to remove is gone; the directory sweep is what catches the
  // files the manifest never knew about.
  const fileDeletions = await Promise.allSettled(
    walk.artifacts.map((a) => FileSystem.deleteAsync(a.uri, { idempotent: true })),
  );
  const dirDeletion = await Promise.allSettled([
    FileSystem.deleteAsync(walkDirUri(walk.walkId), { idempotent: true }),
  ]);
  const deletions = [...fileDeletions, ...dirDeletion];
  if (deletions.some((d) => d.status === "rejected")) return false;
  await mutateManifest(ownerKey, (current) => removeQueuedWalk(current, walk.walkId));
  return true;
}

export type WalkDrainSummary = {
  /** Artifacts whose bytes were successfully PUT to R2 this drain. */
  puts: number;
  putFailures: number;
  /** Walks removed from the queue this drain because the server has accepted them and local cleanup
   *  (file deletes + manifest removal) finished — either the completion call succeeded THIS drain, or
   *  (Fix 2) the walk was already completedAt-stamped on entry and this drain only finished the
   *  cleanup an earlier, interrupted run left undone. A walk whose completion succeeded but whose
   *  local deletes then failed is NOT counted: it is still queued and its media is still on the
   *  phone, so reporting it as completed would be a lie the caller can't check (see
   *  finishWalkCleanup). */
  completed: number;
  completionFailures: number;
  remainingWalks: number;
};

// A drain must never run twice at once (foreground + background, or a double trigger): a second
// caller would re-PUT/re-complete in-flight work. Module-local guard — both entry points share this
// process, same as ../capture/upload-queue.ts's `draining` flag.
let draining = false;
/** Which owner the in-flight drain belongs to — see drainWalkQueue's coalescing branch for why a
 *  pending request is only meaningful for that same owner. Null whenever `draining` is false. */
let activeDrainOwnerKey: string | null = null;
/** Set when a drain was requested for the ACTIVE owner while that drain was already running. The
 *  running drain serves it with a follow-up pass rather than dropping it (see drainWalkQueue). */
let drainRequested = false;

/** Everything needed to run a drain for an owner OTHER than the active one, once the lock frees.
 *  Captured because that owner's drain cannot borrow the running one's arguments: the fetcher
 *  carries their token and office, and the client is theirs to supply. */
type PendingDrain = {
  fetcher: Fetcher;
  client: WalkthroughUploadClient;
  opts: { onProgress?: (summary: WalkDrainSummary) => void };
};
/**
 * Drains requested for other owners while one was running, keyed by owner so repeats collapse.
 *
 * A follow-up PASS can only ever serve the running drain's own owner — it re-reads one manifest.
 * The other owner's request used to be dropped on exactly that reasoning, and the reasoning was
 * half right: re-running this drain does nothing for them, but nothing else was going to ask again
 * either. Their shell spends its mount trigger once (see (app)/_layout.tsx), so a sign-in that
 * lands while the previous user's multi-GB upload is still running left the new owner's queue
 * untouched until a foreground transition or an opportunistic background window iOS may not grant
 * for hours.
 */
const pendingOwnerDrains = new Map<string, PendingDrain>();

/** Start ONE waiting owner's drain, if any, now that the lock is free. Detached on purpose: the
 *  drain that just finished must not have its promise held open by an unrelated owner's multi-GB
 *  upload. Whatever this starts runs the same release path when IT finishes, so a third owner
 *  queued behind this one is picked up in turn rather than needing its own scheduler. */
function startPendingOwnerDrain(): void {
  const next = pendingOwnerDrains.entries().next();
  if (next.done) return;
  const [ownerKey, pending] = next.value;
  // Deleted BEFORE starting: the drain we are about to start clears `draining` in its own finally
  // and calls back here, and an entry left in place would restart the same owner forever.
  pendingOwnerDrains.delete(ownerKey);
  void drainWalkQueue(ownerKey, pending.fetcher, pending.client, pending.opts).catch(() => undefined);
}

/** Total passes ONE drainWalkQueue call may make, the first included. A cap, not a target: passes 2+
 *  only happen when something re-requested a drain mid-pass, and in the normal case (a walk enqueued
 *  during a long upload) exactly one follow-up pass is needed. It exists so a caller that re-triggers
 *  a drain from its own progress/completion handling can't hold this loop — and the keep-awake lock
 *  it owns — open forever. Nothing is lost at the cap: the manifest is durable, so whatever is still
 *  queued is picked up by the next drain (foreground resume, enqueue, or the background task). */
export const MAX_DRAIN_PASSES = 4;

/**
 * Upload everything currently queued for `ownerKey`. Walks drain oldest-enqueued first; within a
 * walk, every artifact is PUT (audio/video before photos — drainableArtifacts' order) before the
 * walk's ONE completion call is even attempted. A local file is deleted ONLY after that walk's
 * completion call has succeeded — never after an individual PUT, no matter how many artifacts show
 * putAt. Each step's outcome is persisted to the manifest IMMEDIATELY (not batched), so an
 * interrupted drain (app suspended, a short background window, or an outright crash) resumes at
 * worst the single PUT or completion call that was mid-flight; the resumed drain never re-attempts a
 * PUT already recorded as putAt, and it always re-attempts completion if completedAt was never
 * recorded — see upload-core.ts's module header for why that asymmetry is deliberate. Symmetrically
 * (Fix 2): if completedAt WAS recorded but the walk is still here, that means only the cleanup that's
 * supposed to follow it (deleting local files, then removing the manifest entry) never finished — the
 * resumed drain finishes exactly that, and never re-attempts completion itself. See needsCleanup /
 * isWalkDrainable in upload-core.ts. Never throws — returns a summary.
 *
 * ONE drain runs at a time, but a request that arrives while one is running is COALESCED, not
 * dropped: each pass (runDrainPass) works from a snapshot taken at its own entry, so a walk enqueued
 * mid-drain can only ever be picked up by a LATER pass. Without that follow-up, finishing a second
 * walk while the first was still uploading left it queued with nothing scheduled to send it — the
 * background task is explicitly opportunistic (see upload-background-task.ts), so "later" could mean
 * hours. The returned summary covers every pass this call made, and MAX_DRAIN_PASSES bounds them.
 * A request from a DIFFERENT owner cannot be coalesced into those passes at all — every pass reads
 * the ACTIVE owner's manifest — so it is parked and started as its own drain the moment the lock
 * frees. Either way its caller gets an immediate summary; what changed is that the work happens.
 */
export async function drainWalkQueue(
  ownerKey: string,
  fetcher: Fetcher,
  client: WalkthroughUploadClient,
  opts: { onProgress?: (summary: WalkDrainSummary) => void } = {},
): Promise<WalkDrainSummary> {
  if (draining) {
    // Record the request instead of silently dropping it. The running drain fixed its `ordered`
    // snapshot when it entered runDrainPass, so a walk enqueued a moment ago is invisible to it —
    // and this early return means nothing else was scheduling one either. A second walk finished
    // back-to-back with a long (multi-GB) upload therefore sat untouched until an opportunistic
    // background window iOS may not grant for hours, with the app in the foreground and a drain
    // running the whole time.
    //
    // A follow-up pass only serves the ACTIVE owner — it re-reads that owner's manifest and nothing
    // else. A different signed-in identity is therefore parked instead, arguments and all, and run
    // as its own drain the moment the lock frees (see startPendingOwnerDrain); returning early
    // without recording it is how the second user on a shared device ended up with a queue nothing
    // was scheduled to send.
    if (ownerKey === activeDrainOwnerKey) drainRequested = true;
    else pendingOwnerDrains.set(ownerKey, { fetcher, client, opts });
    return {
      puts: 0,
      putFailures: 0,
      completed: 0,
      completionFailures: 0,
      remainingWalks: (await getQueuedWalks(ownerKey)).length,
    };
  }
  draining = true;
  activeDrainOwnerKey = ownerKey;
  let keptAwake = false;
  // Activated lazily and at most once, so a pass with nothing to do never takes the lock, and a
  // multi-pass drain holds it continuously rather than dropping it between passes.
  const keepAwake = async (): Promise<void> => {
    if (keptAwake) return;
    try {
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      keptAwake = true;
    } catch {
      // Keep-awake is best-effort; draining continues without it.
    }
  };
  try {
    const total: WalkDrainSummary = {
      puts: 0,
      putFailures: 0,
      completed: 0,
      completionFailures: 0,
      remainingWalks: 0,
    };
    for (let pass = 1; pass <= MAX_DRAIN_PASSES; pass++) {
      // Cleared BEFORE the pass, never after: a request that lands WHILE this pass runs must
      // survive to the loop check below, and one that landed during the previous pass has just been
      // served by this one re-reading the manifest.
      drainRequested = false;
      const summary = await runDrainPass(ownerKey, fetcher, client, keepAwake);
      total.puts += summary.puts;
      total.putFailures += summary.putFailures;
      total.completed += summary.completed;
      total.completionFailures += summary.completionFailures;
      total.remainingWalks = summary.remainingWalks;
      // Cumulative, so a caller is never told "1 walk completed" by a call that shipped two.
      opts.onProgress?.({ ...total });
      if (!drainRequested) break;
    }
    return total;
  } finally {
    // Keep-awake is released, and only then is the lock dropped — the same strict nesting the
    // single-pass version had, so no second drain can start while this one is still winding down.
    if (keptAwake) await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
    activeDrainOwnerKey = null;
    draining = false;
    // Strictly after the lock is dropped, or the drain this hands off to would see `draining` and
    // park itself right back in the same map.
    startPendingOwnerDrain();
  }
}

/**
 * ONE pass over the queue as it stands right now. The `ordered` snapshot is fixed at entry — which
 * is exactly why drainWalkQueue may run this more than once (see its coalescing loop): a walk
 * enqueued after this point cannot be picked up by the pass already in progress.
 */
async function runDrainPass(
  ownerKey: string,
  fetcher: Fetcher,
  client: WalkthroughUploadClient,
  keepAwake: () => Promise<void>,
): Promise<WalkDrainSummary> {
  const walks = await getQueuedWalks(ownerKey);
  const ordered = walks.filter(isWalkDrainable).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  if (ordered.length === 0) {
    return { puts: 0, putFailures: 0, completed: 0, completionFailures: 0, remainingWalks: walks.length };
  }

  await keepAwake();

  let puts = 0;
  let putFailures = 0;
  let completed = 0;
  let completionFailures = 0;

  for (const walk of ordered) {
    // A walk that reaches here with needsCleanup(walk) true is stranded mid-cleanup: the server
    // already accepted it (a prior, interrupted drain got as far as markWalkCompleted below) but
    // the deletes + manifest removal that are supposed to follow never finished — most likely the
    // app was suspended or killed in that exact window, or a delete failed outright (see
    // finishWalkCleanup). There is no PUT or completion work left to do (both already succeeded);
    // finish exactly the cleanup, idempotently, and move on. Before Fix 2, isWalkDrainable excluded
    // every completed walk, so `ordered` would never have contained this walk at all — it would sit
    // here, files and all, forever.
    if (needsCleanup(walk)) {
      // Only counted once the cleanup genuinely finished — otherwise the walk is still queued with
      // its media still on the phone, and the next drain gets another go at it.
      if (await finishWalkCleanup(ownerKey, walk)) completed++;
      continue;
    }

    // Phase 1: PUT every currently-drainable artifact's bytes.
    for (const artifact of drainableArtifacts(walk)) {
      try {
        const sizeBytes = await putArtifactBytes(client, fetcher, walk, artifact);
        await mutateManifest(ownerKey, (current) =>
          current.map((w) =>
            w.walkId === walk.walkId ? markArtifactPut(w, artifact.idempotencyKey, sizeBytes, Date.now()) : w,
          ),
        );
        puts++;
      } catch {
        await mutateManifest(ownerKey, (current) =>
          current.map((w) =>
            w.walkId === walk.walkId ? bumpArtifactAttempts(w, [artifact.idempotencyKey], Date.now()) : w,
          ),
        );
        putFailures++;
      }
    }

    // Phase 2: the walk's ONE completion call, only once every artifact is confirmed in R2.
    // Re-read first — phase 1 above may have just changed this walk's state, and a walk that was
    // ALREADY fully-put on entry (a prior drain PUT everything but never completed) never entered
    // the phase-1 loop at all (drainableArtifacts would be empty), so this is the only place its
    // completion gets attempted.
    const fresh = (await readManifest(ownerKey)).find((w) => w.walkId === walk.walkId);
    if (fresh && needsCompletion(fresh)) {
      try {
        await callCompletion(client, fetcher, fresh);
        // Persist completedAt BEFORE deleting anything: a crash between these two steps leaves a
        // walk stranded with completedAt set and its local files still on disk — needsCleanup
        // recognizes exactly that state, and isWalkDrainable (Fix 2) guarantees a FUTURE drain
        // revisits it and runs the cleanup-only branch above. (An earlier version of this comment
        // claimed "a future drain would try to re-complete" it — that was never true: completion
        // already succeeded, isWalkDrainable used to EXCLUDE completed walks entirely, and nothing
        // else ever scanned for them, so a walk stranded here stayed stranded — local files and
        // all — forever.) The one failure mode this ordering still exists to prevent is the
        // opposite: files deleted with no server record of them ever having existed.
        await mutateManifest(ownerKey, (current) =>
          current.map((w) => (w.walkId === walk.walkId ? markWalkCompleted(w, Date.now()) : w)),
        );
        // A cleanup that couldn't finish lands this walk in exactly the stranded state the branch
        // at the top of this loop exists to resolve, so it is left queued rather than counted.
        if (await finishWalkCleanup(ownerKey, fresh)) completed++;
      } catch {
        await mutateManifest(ownerKey, (current) =>
          current.map((w) => (w.walkId === walk.walkId ? bumpCompletionAttempts(w, Date.now()) : w)),
        );
        completionFailures++;
      }
    }
  }

  const remainingWalks = (await getQueuedWalks(ownerKey)).length;
  return { puts, putFailures, completed, completionFailures, remainingWalks };
}
