/**
 * Which walks THIS PROCESS still has a native teardown running for.
 *
 * One fact, wanted by two modules that must not import each other: `native.ts` is the only place an
 * `endWalk()` is ever issued, and `upload.ts`'s recovery scan is the only place it matters that one
 * is still running. So it lives here, with no imports of its own.
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
