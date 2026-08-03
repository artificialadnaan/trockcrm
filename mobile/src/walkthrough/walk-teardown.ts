/**
 * What THIS PROCESS is doing with native's one recorder slot: which walk it is RECORDING, and which
 * it still has a teardown running for.
 *
 * Two facts, wanted by two modules that must not import each other: `native.ts` is the only place a
 * `startWalk()`/`endWalk()` is ever issued, and `upload.ts`'s recovery path — the scan, and the
 * filing that acts on what it found — is the only place it matters that either is in flight. So they
 * live here, with no imports of their own.
 *
 * The scan's premise is that a `Documents/walkthroughs/<walkId>/` directory it can read is a
 * FINISHED directory — it reads walk.mp4's box chain and decides, once, whether the writer got to
 * append a moov, and that verdict is then frozen into a snapshot for the whole shell lifecycle. The
 * premise holds for the crash the scan exists for (a killed process writes nothing) and fails for
 * the one interruption that leaves this process alive: sign-out. useWalk's unmount fires
 * `Recorder.endWalk()` DETACHED — nothing awaits it, deliberately, because the hook and the screen
 * rendering it are already gone — so a sign-out mid-recording leaves native finalizing on a
 * background Task while JS carries on. Sign back in before it lands and the new shell's scan reads a
 * file whose moov has not been written yet and calls it unfinished, permanently, for a recording
 * that was seconds from being perfectly valid.
 *
 * A timestamp heuristic cannot answer this. `finishWriting` on a long walk has quiet stretches, and
 * `awaitPendingStills` (WalkthroughRecorder.swift) can still drop a still-NNN.jpg into the directory
 * up to five seconds after the last video byte — so "nothing has been written for a moment" is not
 * "nothing more will be". The process that is doing the writing is the one asking the question, and
 * it can simply be told. That is all this is.
 */

/** walkId → the in-flight `endWalk()` for it. At most one entry in practice: native's recorder is a
 *  singleton (one walk slot, claimed and released), so two teardowns cannot overlap. A Map rather
 *  than a single slot anyway, because the scan asks about a SPECIFIC directory and a stale single
 *  slot would answer for the wrong one. */
const inFlight = new Map<string, Promise<unknown>>();

/** Whoever is currently in the middle of a question that a new walk would invalidate. Empty almost
 *  always: nothing subscribes except a recovery scan while it runs. */
const startWatchers = new Set<(walkId: string) => void>();

/** The walk native is holding its one recorder slot for, or null. Handed over to `inFlight` above the
 *  moment an `endWalk` is issued for it, so the two never describe the same walk at once and the
 *  question "is anything writing into this directory" always has exactly one owner. */
let recordingWalkId: string | null = null;

/**
 * Which walk is being RECORDED right now — the fact that has to be true before a directory can be
 * treated as abandoned.
 *
 * The scan is one caller; the other is `enqueueRecoveredWalk`, and that one is why this is a live
 * question rather than something the scan could settle on its own. Recovery's snapshot is frozen for
 * a whole shell lifecycle by design, so "it was an orphan when we looked" is a claim that can go
 * stale — and acting on a stale one is not a mislabelled row. Filing a walk uploads what it has,
 * calls completion, and cleanup then deletes the walk DIRECTORY, video and all. Do that to a walk
 * that is still recording and the app destroys a site visit while the estimator is walking it.
 *
 * Left set for a walk native failed WITHOUT an endWalk (a `capture()` that threw takes the walk
 * terminal in JS while the recorder keeps running), which is not a bug here: native really is still
 * writing, and that is exactly what this answers. The narrow cost is the reverse — a walk native
 * tore down internally with no endWalk stays "recording" to this module until the process dies, and
 * its directory stays out of recovery for that long. That trade is deliberate and one-sided: the
 * price is one session of visibility for files that are still on disk, against deleting a recording
 * that cannot be repeated.
 */
export function walkBeingRecorded(): string | null {
  return recordingWalkId;
}

/**
 * Watch for walks STARTING, until the returned unsubscribe is called. Every watcher hears every
 * `startWalk` issued in between, in order.
 *
 * `walkBeingRecorded()` above answers the same question for ONE INSTANT; this answers it for a SPAN,
 * which is what the recovery scan actually needs. That scan makes a dozen awaits — a bounded wait on
 * a teardown, manifest reads, ranged reads of every candidate container — and its answer is then
 * cached for the whole shell lifecycle, so a walk begun anywhere inside it is a walk the frozen
 * answer would go on describing as abandoned.
 *
 * A subscription rather than a log this module keeps, because the only thing that ever asks is a
 * scan asking about ITSELF: a remembered list would grow for the life of the process, or need a cap
 * that quietly drops part of the answer, and neither buys anything a listener does not.
 *
 * A copy is iterated on notify, so a watcher unsubscribing from inside its own callback (a scan
 * that finishes on the same tick) cannot mutate the Set mid-iteration.
 */
export function watchWalkStarts(onStart: (walkId: string) => void): () => void {
  startWatchers.add(onStart);
  return () => {
    startWatchers.delete(onStart);
  };
}

/**
 * Claim the recorder slot for `walkId` and tell anyone watching. Called BEFORE `startWalk` is issued,
 * not after it resolves — native creates `walkthroughs/<walkId>/` inside that call, so the window
 * between the two is one where the directory can already exist while nothing has claimed it. That
 * window is exactly what a scan reading the tree at the same moment would mistake for an orphan.
 */
export function noteWalkStarted(walkId: string): void {
  recordingWalkId = walkId;
  for (const watcher of [...startWatchers]) watcher(walkId);
}

/**
 * Record that `walkId`'s directory is still being written by native, until `teardown` settles.
 *
 * Settles, not resolves: `endWalk` REJECTS when the writer failed to finalize, and native has torn
 * down and released the directory by then either way (its `teardown(...)` runs before the promise
 * is answered). A rejection means the walk cannot be vouched for, which is exactly the verdict the
 * scan should then be free to reach on its own.
 *
 * The identity check before deleting matters if a second teardown for the same walkId is ever
 * registered: the first one settling must not clear a claim it no longer owns.
 */
export function noteWalkTeardown(walkId: string, teardown: Promise<unknown>): void {
  // The handoff: from this line the teardown registry is the one that speaks for this directory.
  // Leaving it marked "recording" as well would mean a wedged endWalk (the case the budget below
  // exists for) kept the walk out of recovery even after the budget gave up on it — the answer would
  // never come back, on the one surface that can save those files.
  if (recordingWalkId === walkId) recordingWalkId = null;
  inFlight.set(walkId, teardown);
  const clear = () => {
    if (inFlight.get(walkId) === teardown) inFlight.delete(walkId);
  };
  // Handles the rejection as a side effect, which is the point: `endWalk`'s own caller may or may
  // not attach a catch (the unmount path deliberately does), and this must never be what turns a
  // finalize failure into an unhandled rejection.
  void teardown.then(clear, clear);
}

/** The walkIds still being written, in registration order. Read AFTER `settleWalkTeardowns` — what
 *  is left is what outlasted the budget. */
export function walkTeardownsInFlight(): string[] {
  return [...inFlight.keys()];
}

/**
 * Wait for every in-flight teardown, or `budgetMs`, whichever comes first. Returns nothing: the
 * caller reads `walkTeardownsInFlight()` afterwards to see what did NOT finish, because that is a
 * per-walk answer and this is a whole-process wait.
 *
 * Bounded because an unbounded wait puts a wedged native call in front of the recovery card
 * forever, and the card is the only surface that can save these files. Bounded rather than skipped
 * because the ordinary case is a teardown that lands in well under a second and a scan that then
 * tells the truth about it.
 */
export async function settleWalkTeardowns(budgetMs: number): Promise<void> {
  if (inFlight.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  try {
    // allSettled, so one teardown rejecting does not cut the wait short for the others.
    await Promise.race([Promise.allSettled([...inFlight.values()]), budget]);
  } finally {
    // Cleared on the settled path too, or the pending timer keeps the JS runtime's timer queue (and
    // a Jest run) alive for the rest of the budget with nothing left to do.
    if (timer !== undefined) clearTimeout(timer);
  }
}
