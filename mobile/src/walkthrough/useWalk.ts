/**
 * Binds the pure walk reducer (session.ts) to the native recorder (native.ts).
 *
 * All lifecycle rules live here — when a "starting" dispatch is required, what a walk id has to
 * look like, that a still request accepted by native is not the same as a still having been
 * taken — so the screen that eventually calls this hook only renders state and wires up buttons.
 * No JSX here on purpose: this file should be testable without mounting anything visual.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import * as FileSystem from "expo-file-system/legacy";
import { errorMessage } from "../lib/error-message";
import {
  artifactCount,
  assessWalkVideoSize,
  canCapture,
  canCaptureMore,
  initialWalk,
  isWalkActive,
  reduceWalk,
  WALK_VIDEO_SIZE_POLL_MS,
  type Walk,
  type WalkCaptureCensusInput,
  type WalkVideoSizeVerdict,
} from "./session";
import {
  isAvailable,
  onAudioLevel,
  onAudioStalled,
  onRecorderError,
  onStill,
  Recorder,
  type WalkEnded,
} from "./native";
// The SDK bridge, not the recorder bridge — two different native modules. This is the only consumer
// of the error the root layout retains when its launch-time `configure()` fails.
import { getStartupConfigureError } from "../wearables/native";

/**
 * A filesystem-safe walk id. Native creates `Documents/walkthroughs/<id>/`, so this must be safe
 * as a directory component: lowercase alphanumerics and hyphens only, no separators. No uuid dep
 * is bundled — same tradeoff as `newClientUploadId` in capture/upload-queue-core.ts.
 */
function newWalkId(): string {
  return `walk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Is this native rejection the "SDK was never configured" one?
 *
 * Read from `err.code` FIRST, because that is where it actually lives. `WalkthroughRecorder.swift`
 * calls `reject("walk_not_configured", "Wearables SDK is not configured. …", nil)`, and React Native
 * puts the first argument on `err.code` and the second on `err.message`. The previous version of this
 * check tested `/not_configured/i` against the MESSAGE — which in production reads "Wearables SDK is
 * not configured", with spaces — so it never matched, and the retained startup cause this whole path
 * exists to surface was still dropped.
 *
 * Its test passed anyway, because the test built `new Error("walk_not_configured")` and put the CODE
 * where the message goes. That fixture could not have failed for the right reason, which is the only
 * thing a regression test is for.
 *
 * The message is still matched as a fallback, spaces or underscores, so a future native change that
 * moves the string around does not silently take this path out again.
 */
function isNotConfiguredRejection(err: unknown, nativeMessage: string): boolean {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof code === "string" && /not[_ ]configured/i.test(code)) return true;
  return /not[_ ]configured/i.test(nativeMessage);
}

/**
 * The census in the shape the server files, or null when native did not report the whole of it.
 *
 * All-or-nothing on purpose, and the `audio` object is the gate. It was added to a census that had
 * already shipped, so a dev client can resolve every top-level counter and no `audio` — and the
 * pinned contract has no way to say "audio unmeasured" short of zeros, which for narration are the
 * worst numbers in the range (the same trap `audioCensus` below guards with its typeof). The four
 * video fields are checked for the same reason: a census is a record, and a record with holes
 * filled in by `?? 0` is a fabricated one.
 */
function captureCensusFrom(census: WalkEnded["census"]): WalkCaptureCensusInput | null {
  if (!census || !census.audio) return null;
  const video = {
    framesReceived: census.videoFramesReceived,
    framesAppended: census.videoFramesAppended,
    framesDropped: census.videoFramesDropped,
    secondsSinceLastFrameArrived: census.secondsSinceLastFrameArrived,
  };
  if (!Object.values(video).every((value) => typeof value === "number")) return null;
  const { audio } = census;
  return {
    video,
    audio: {
      buffersReceived: audio.buffersReceived,
      buffersAppended: audio.buffersAppended,
      buffersDropped: audio.buffersDropped,
      longestDropRun: audio.longestDropRun,
      secondsAppended: audio.secondsAppended,
      engineRestarts: audio.engineRestarts,
      standaloneSecondsRecorded: audio.standaloneSecondsRecorded,
      events: Array.isArray(audio.events) ? audio.events : [],
    },
  };
}

/** `walk.mp4`'s size on disk right now, or null when it cannot be read for ANY reason — no path yet,
 *  a file the platform reports no size for, a stat that threw. Null is what `assessWalkVideoSize`
 *  treats as "unmeasured, therefore fine": see its doc for why that direction is not negotiable. */
async function readRecordingBytes(uri: string): Promise<number | null> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && typeof info.size === "number" ? info.size : null;
  } catch {
    return null;
  }
}

export type UseWalkResult = {
  walk: Walk;
  /** The most recent native/recorder error, verbatim. Independent of `walk.error`, which only
   *  reflects a fatal ("failed") transition — this also carries non-fatal surfaced problems,
   *  such as a still request native didn't accept. */
  error: string | null;
  /**
   * The id `start()` minted for the current/most-recent walk, or null before a walk has ever
   * started. `Walk` (session.ts) deliberately carries no id of its own — native mints the
   * directory name, so this is the one place it is known — so a caller that needs to enqueue a
   * completed/failed walk (the upload queue's `enqueueWalk(ownerKey, walkId, walk, meta)`) reads
   * it from here rather than re-deriving or threading a second id through.
   */
  walkId: string | null;
  start: () => Promise<void>;
  capture: () => Promise<void>;
  end: () => Promise<void>;
  /**
   * Snap the walk back to a fresh `idle` for the CURRENT (dealId, projectId), discarding whatever
   * walk — complete, failed, or otherwise — was held before. See WalkEvent's `reset` case for why
   * this exists at all: walk.tsx is a hidden `Tabs.Screen` that never unmounts, so nothing else
   * would ever get this hook out of a terminal state. Callers should only invoke this when
   * `walk.state` is already terminal (complete/failed) — and even if a caller doesn't, this is a
   * no-op while the walk is ACTIVE (session.ts's isWalkActive), not just a documented convention:
   * resetting an active walk would silently discard an in-progress site visit.
   */
  reset: () => void;
  stillCount: number;
  bridgeAvailable: boolean;
  /** Whether `capture()` will actually request a still right now — false while not recording,
   *  once the walk (delivered stills + requests already accepted by native but not yet delivered)
   *  is already at MAX_WALK_ARTIFACTS (session.ts's canCaptureMore). Drives the CAPTURE control's
   *  disabled state. */
  captureEnabled: boolean;
  /** True exactly when the walk IS recording but capturing again would exceed the server's
   *  artifact cap — distinct from merely "not recording," so the screen can explain WHY the
   *  (still-recording) control just went dark instead of leaving a silently disabled button. */
  atCaptureLimit: boolean;
  /**
   * Where the RECORDING's own file stands against the server's per-artifact byte ceiling, measured
   * from `walk.mp4` on disk while it is being written (session.ts's `assessWalkVideoSize`).
   *
   * "ok" whenever the walk is not recording, and whenever the file cannot be measured — the screen
   * should read this as "nothing to say", never as an assurance.
   */
  videoSize: WalkVideoSizeVerdict;
  /**
   * True when THIS hook ended the walk because the recording reached the bound, rather than the
   * estimator ending it. Survives into the terminal state on purpose: a walk that stopped on its own
   * with nothing said is indistinguishable from one ended by a mis-tap, and the difference decides
   * whether the estimator starts a second walk to finish the site.
   */
  stoppedAtSizeLimit: boolean;
};

/**
 * `ownerKey` is the signed-in identity the recording is stamped with at start — nullable because
 * `useWalkQueueSession` resolves it asynchronously and this screen can render for a frame before it
 * lands. A null key REFUSES the start rather than recording anyway: an unstamped directory is one no
 * account can be shown to own later, and the recovery scan's only safe reading of that is to offer
 * it to nobody. Refusing up front costs a retriable error message; recording anyway costs the walk.
 */
export function useWalk(dealId: string, projectId: string | null, ownerKey: string | null): UseWalkResult {
  const [walk, dispatch] = useReducer(reduceWalk, undefined, () => initialWalk(dealId, projectId));
  const [error, setError] = useState<string | null>(null);
  const [walkId, setWalkId] = useState<string | null>(null);

  // Capture requests native has ACCEPTED but not yet resolved into a `still` event (delivered) or
  // a `walkthrough:error` (failed to write) — see canCaptureMore's `reserved` doc for why
  // `walk.stills` alone isn't enough to gate a new request. A ref, not just the mirrored state
  // below: two taps can both call `capture()` before either's state update would have committed,
  // so the guard inside `capture()` itself must read something that updates SYNCHRONOUSLY, in the
  // same tick, or both taps see the same stale count exactly like the bug this replaces.
  // `inFlightCount` mirrors the ref into render so captureEnabled/atCaptureLimit — and therefore
  // the CAPTURE button's disabled state — reflect it too; it's allowed to lag the ref by a render,
  // since the ref alone already guarantees capture() itself can never be tricked into exceeding
  // the cap.
  const inFlightRef = useRef(0);
  const [inFlightCount, setInFlightCount] = useState(0);
  const adjustInFlight = useCallback((delta: number) => {
    inFlightRef.current = Math.max(0, inFlightRef.current + delta);
    setInFlightCount(inFlightRef.current);
  }, []);
  // Return the count to zero, unconditionally — a reservation belongs to a WALK, not to this hook.
  //
  // A request native accepts but never resolves (no `walkthrough:still`, no `walkthrough:error`)
  // holds its reservation for good: nothing correlates a request to an outcome, so there is no
  // release this hook could safely make on its own while the walk is still running. Surviving that
  // within one walk is the accepted cost of the cap being correct. Carrying it into the NEXT walk is
  // not: reset() cleared the reducer state and the walkId but left this count alone, so every later
  // walk on the same mounted screen started one slot short of the server's artifact cap — and each
  // stalled request compounded it, until CAPTURE went dark early with nothing on screen able to
  // explain why. Called from BOTH reset paths and from start(), which is exactly where native zeroes
  // its own `stillsInFlightStorage` (WalkthroughRecorder.swift's claimWalkSlot) — the two counters
  // are halves of one fact and must not be reset on different schedules.
  const clearInFlight = useCallback(() => {
    inFlightRef.current = 0;
    setInFlightCount(0);
  }, []);

  // `walk.mp4`'s size on disk, re-read while recording — null until the first reading lands, and
  // whenever it cannot be taken. See the size-watch effect below the callbacks for why this is
  // measured rather than estimated from a bitrate.
  const [videoBytes, setVideoBytes] = useState<number | null>(null);
  const [stoppedAtSizeLimit, setStoppedAtSizeLimit] = useState(false);
  // Whether the auto-stop below has already fired for THIS walk. `end()` has its own in-flight
  // guard, so a second call would be a no-op anyway — this is about not re-announcing it: the effect
  // re-runs on every render until React commits "finalizing", and `stoppedAtSizeLimit` is state that
  // cannot be read back in the same tick it is set.
  const stoppingForSizeRef = useRef(false);
  /** Forget the previous walk's measurements. Cleared on exactly the paths clearInFlight is, and for
   *  the same reason: a reading belongs to a WALK, and carrying one into the next would start it
   *  already "nearLimit" — or, worse, stop it before a byte was written. */
  const clearSizeWatch = useCallback(() => {
    setVideoBytes(null);
    setStoppedAtSizeLimit(false);
    stoppingForSizeRef.current = false;
  }, []);

  // Read ONLY by the unmount cleanup below, which fires after the last render and therefore cannot
  // close over `walk` — an effect with `walk` in its deps would tear the recorder down on every
  // state change instead of on unmount, which is the opposite of the fix.
  const walkStateRef = useRef(walk.state);
  walkStateRef.current = walk.state;

  // The in-flight `Recorder.startWalk()` promise, or null. Two readers, and they want it for
  // different reasons:
  //
  //   - The unmount cleanup below: a walk still in "starting" has no writer yet, so an endWalk()
  //     issued right now finalises nothing and tears down nothing — and then the start it raced
  //     goes on to open the DAT stream and the microphone with no JS left alive to ever close them.
  //   - `start()` itself, as a SYNCHRONOUS admission guard. `walk.state` cannot serve there: the
  //     "starting" dispatch is committed by React on a later tick, so two taps inside one tick both
  //     read `idle` and the reducer's own idle-only guard never sees the first one. A ref assigned
  //     in the same tick as the native call is the only thing the second tap can observe in time.
  const startInFlightRef = useRef<Promise<unknown> | null>(null);

  // The in-flight `Recorder.endWalk()` promise, or null — `end()`'s synchronous admission guard, the
  // exact counterpart of startInFlightRef above. Deliberately a SEPARATE ref rather than one shared
  // "native is busy" flag: the unmount cleanup below has to distinguish the two (it waits out a
  // pending START and then ends the walk, but must never issue a second end while one is already
  // finalising), and a single flag would collapse two different obligations into one.
  const endInFlightRef = useRef<Promise<unknown> | null>(null);

  const reset = useCallback(() => {
    // Mirrors reduceWalk's own guard (session.ts's isWalkActive): callers are documented to only
    // invoke this once walk.state is terminal, but refusing here too — rather than trusting every
    // future caller to honor that convention — means a misuse can never discard an in-progress
    // recording. Needed on top of the reducer's own refusal because `error`/`walkId` are separate
    // React state the reducer has no say over; without this they'd still get wiped even though the
    // dispatch below would have been a no-op.
    if (isWalkActive(walk.state)) return;
    dispatch({ type: "reset", dealId, projectId });
    setError(null);
    setWalkId(null);
    clearInFlight();
    clearSizeWatch();
  }, [dealId, projectId, walk.state, clearInFlight, clearSizeWatch]);

  // Auto-reset whenever the TARGET a walk would attach to changes — belt-and-suspenders alongside
  // walk.tsx's own focus-triggered reset() call: a caller that re-renders this hook against a
  // DIFFERENT deal must never keep the previous deal's dealId/videoUri/stills sitting in `walk`,
  // even if a focus transition never fires (walk.tsx is a hidden Tabs.Screen — a route param
  // change can land here without ever blurring/refocusing it).
  //
  // A useEffect, deliberately NOT the render-phase "adjusting state when a prop changes" idiom
  // this used before switching deals mid-recording was found to destroy the recording (see
  // reduceWalk's "reset" guard, session.ts's isWalkActive): that guard alone isn't enough if the
  // DISPATCH itself still happens during render. A walk that reaches "complete" in the very
  // render where this effect would notice the identity mismatch must still be visibly committed
  // at least once — walk.tsx's own terminal-enqueue effect depends on `walk`, and if this reset
  // fired synchronously during render, React would collapse straight from "finalizing" to freshly
  // "idle" without ever committing "complete" in between, so the finished walk would never reach
  // the upload queue. Running this in an effect (which fires AFTER the commit that produced
  // "complete") guarantees every sibling effect keyed off `walk` sees the terminal state first.
  //
  // Also guarded here — not just relying on the reducer's no-op — against an ACTIVE walk for the
  // same reason `reset()` above is: `error`/`walkId` are outside the reducer's control, and an
  // in-flight walk's id must not be wiped out from under a recording that is still running.
  useEffect(() => {
    if (walk.dealId === dealId && walk.projectId === projectId) return;
    if (isWalkActive(walk.state)) return;
    dispatch({ type: "reset", dealId, projectId });
    setError(null);
    setWalkId(null);
    clearInFlight();
    clearSizeWatch();
  }, [walk, dealId, projectId, clearInFlight, clearSizeWatch]);

  useEffect(() => {
    const offStill = onStill((still) => {
      // This request's reservation is now a DELIVERED still — release it before it lands in
      // `walk.stills`, so the two always move together from the button's point of view.
      adjustInFlight(-1);
      dispatch({ type: "still", uri: still.uri, at: Date.now(), source: still.source });
    });
    // Errors that happen between calls — e.g. a still that failed to write to disk after
    // capture was already accepted. Surfaced independently of the reducer: the walk itself may
    // still be perfectly fine.
    const offError = onRecorderError((e) => {
      // No `walkthrough:still` will ever follow for whichever request just failed — release its
      // reservation too, or every failed-after-accepted capture would permanently wedge the
      // button one slot short of the real cap. Native carries no id to say WHICH request this
      // was; releasing one generically (clamped at zero by adjustInFlight) assumes it was the
      // oldest outstanding one, which is the same "no correlation" limitation `still` events
      // already have against `walk.stills`.
      adjustInFlight(-1);
      setError(e.message);
    });
    // The two live microphone signals. Dispatched straight into the reducer, which is where the
    // "only while recording" rule lives (a level landing during "finalizing" must not touch a walk
    // that has stopped) — this hook adds nothing but the plumbing.
    const offAudioLevel = onAudioLevel((e) => {
      dispatch({ type: "audioLevel", rms: e.rms });
    });
    const offAudioStalled = onAudioStalled((e) => {
      dispatch({ type: "audioStalled", attempt: e.attempt, restarted: e.restarted, sinceMs: e.sinceMs });
    });
    return () => {
      offStill();
      offError();
      offAudioLevel();
      offAudioStalled();
    };
  }, [adjustInFlight]);

  // Stop the NATIVE recorder if this hook goes away mid-walk. Removing the JS listeners above is
  // not enough and never was: native is a singleton with its own lifetime, so an unmount that only
  // unsubscribes leaves the DAT video stream, the phone microphone, and AVAssetWriter all running
  // with nothing left in JS that knows the walkId. The real path is Profile → sign out during a
  // recording: `app/(app)/_layout.tsx`'s authenticated tab tree unmounts, this hook's reducer state
  // and walk identity are lost, the microphone stays held away from every other app, and the next
  // login can start a SECOND walk against the same singleton — which tears down the first with
  // nothing to show for it.
  //
  // Empty deps so this fires on unmount ONLY; both facts it needs are read through refs for that
  // reason. State is read at teardown time, not captured at mount.
  //
  // Deliberately NOT enqueuing on the way out. At sign-out `ownerKey` is already gone, so there is
  // no manifest to write into — and no need. Finalising is enough: native leaves
  // `Documents/walkthroughs/<walkId>/walk.mp4` and `still-NNN.jpg` on disk, which is exactly what
  // upload.ts's `findRecoverableWalks` (via classifyWalkDirFileNames) scans for at the next login,
  // and it surfaces them on Profile for a human to attach a dealId to. Leaving the files is the
  // designed handoff, not a leak.
  useEffect(() => {
    return () => {
      // Two checks for one fact — "an end is already under way" — because neither covers the whole
      // of it, and the gap between them is where a sign-out lands.
      //
      // The REF is the only thing that can see an end issued in the tick this unmount happens in:
      // `end()` assigns it and dispatches "ended" synchronously, but React commits "finalizing" on a
      // later tick, so walkStateRef below still reads "recording" and would wave the teardown
      // through — two Tasks then removing the same audio tap and finalising the same AVAssetWriter,
      // at the one moment in the walk when the file is not yet closed.
      //
      // The STATE check is still load-bearing on the other side of the call: `end()`'s finally
      // clears the ref before React commits "complete"/"failed", so a walk that is genuinely still
      // "finalizing" as far as any render is concerned has a null ref for that window.
      //
      // Both mean the same thing here: do nothing. The in-flight endWalk is unaffected by this
      // unmount and native's own teardown runs to completion regardless.
      if (endInFlightRef.current) return;
      const state = walkStateRef.current;
      if (!isWalkActive(state)) return;
      if (state === "finalizing") return;
      const pendingStart = startInFlightRef.current;
      void (async () => {
        try {
          // Wait out a start that hasn't landed yet (see startInFlightRef). A rejected start has
          // already torn itself down natively, so falling through to endWalk() is harmless there.
          if (pendingStart) await pendingStart;
        } catch {
          // Deliberately swallowed — see above.
        }
        try {
          await Recorder.endWalk();
        } catch {
          // Nowhere to report to: this hook, its error state, and the screen rendering it are all
          // gone. The point of the call is the native-side release, and a rejection here means
          // native had nothing left to release anyway.
        }
      })();
    };
  }, []);

  const start = useCallback(async () => {
    // Both guards run BEFORE the dispatch and before native, and both read refs rather than state,
    // because the whole defect is that state is not observable yet.
    //
    // Native is a singleton: one `session`, one `stream`, one `walkDirectory`, one AVAssetWriter.
    // A second `startWalk()` does not queue behind the first, it overwrites it — so the first
    // walk's directory and writer are orphaned while its DAT stream and microphone keep running,
    // and the estimator is recording a walk that no longer has anywhere to land.
    //
    //   - startInFlightRef covers the tick-level race: two taps before React commits "starting".
    //     Assigned synchronously alongside the native call below, so the second tap sees it.
    //   - walkStateRef covers the rest of the walk. The ref above is cleared the moment the first
    //     start RESOLVES, but the singleton is busiest after that — a start issued while a walk is
    //     recording would tear down a live site visit to build a new one. Reads the ref, not
    //     `walk.state`, so this callback keeps its empty dependency list and stable identity.
    if (startInFlightRef.current) return;
    if (isWalkActive(walkStateRef.current)) return;
    // Past the guards, no walk owns the recorder, so nothing can legitimately be outstanding —
    // anything still counted here is a previous walk's ghost that no reset happened to clear (a
    // terminal walk can be started over without one: `isWalkActive` is false for complete/failed).
    // Zeroed at the same instant native does it, for the same reason. See clearInFlight.
    clearInFlight();
    // The previous walk's file size belongs to the previous walk — see clearSizeWatch.
    clearSizeWatch();
    dispatch({ type: "starting" });
    const id = newWalkId();
    // Set BEFORE the native call resolves: even a walk that fails at startWalk() is "that" id (it's
    // what was passed to native, which may already have created the directory) — and a caller that
    // reads walkId off a "failed" state relies on it being populated by the time that state lands.
    setWalkId(id);
    // The native call lives INSIDE the try, not above it. A bridge method that throws SYNCHRONOUSLY
    // — a missing native module, an argument the bridge rejects before returning a promise — would
    // otherwise escape past the catch entirely: `failed` would never be dispatched, the walk would
    // sit in "starting" forever, and because the finally never ran either, startInFlightRef would
    // stay set and refuse every subsequent start. A permanent wedge from one synchronous throw.
    let pending: Promise<{ videoUri: string | null }> | null = null;
    try {
      // Refused rather than recorded unowned: `Recorder.startWalk` stamps the walk's directory with
      // this identity before native writes a byte, and a walk with no identity to stamp is one the
      // recovery scan can only ever offer to nobody. Costing a retriable message here is strictly
      // better than costing the walk later.
      if (!ownerKey) {
        throw new Error("Not signed in yet — wait a moment and tap Start again.");
      }
      pending = Recorder.startWalk(id, ownerKey);
      startInFlightRef.current = pending;
      const started = await pending;
      // Record the path native reports rather than null. It is not playable yet — the writer
      // finalises in endWalk — but holding it means a walk that FAILS mid-recording still knows
      // where its partial file is, and a partial walk is still a site visit that happened.
      dispatch({ type: "started", at: Date.now(), videoUri: started.videoUri });
    } catch (err) {
      // Verbatim: native's rejection message (e.g. `walk_no_hfp`) names the input it would
      // otherwise have recorded from. That text IS the instruction — replacing it with
      // something generic would throw away the one piece of information that explains the
      // failure.
      //
      // With ONE exception, and it is the reason `setStartupConfigureError` exists at all.
      // `walk_not_configured` is native saying the SDK was never configured; it does not know why,
      // because the failure happened in the root layout's `configure()` at launch, on a screen the
      // estimator may never have opened. Until now nothing read that retained error — the setter
      // had no matching getter call anywhere in the app — so the estimator got a generic refusal
      // while the real cause (a credential, an SDK init failure) sat in a module variable one
      // import away. Native's text still leads, because it names the state; the cause is appended,
      // because it names the fix.
      const nativeMessage = errorMessage(err);
      const startupCause = getStartupConfigureError();
      const message =
        startupCause && isNotConfiguredRejection(err, nativeMessage)
          ? `${nativeMessage} — ${errorMessage(startupCause)}`
          : nativeMessage;
      setError(message);
      dispatch({ type: "failed", reason: message });
    } finally {
      // Only clear OUR promise: a hypothetical second start racing this one would have already
      // replaced the ref, and blanking it here would leave the unmount cleanup below with nothing
      // to wait on for the start that's actually in flight.
      //
      // `pending` is null when startWalk threw synchronously — nothing was ever assigned to the ref
      // on that path, so there is nothing of ours to clear, and the `=== pending` comparison must
      // not be allowed to match a ref that a racing start legitimately left at null.
      if (pending !== null && startInFlightRef.current === pending) startInFlightRef.current = null;
    }
  }, [clearInFlight, clearSizeWatch, ownerKey]);

  const capture = useCallback(async () => {
    // canCaptureMore, not canCapture: also refuses once capturing would push the walk past the
    // server's artifact cap. The screen disables the control at that point too — this is the
    // defensive backstop, not the primary UX (see walk.tsx's captureEnabled/atCaptureLimit).
    //
    // inFlightRef.current (not inFlightCount) is what's passed in: captureStill() resolves the
    // moment native ACCEPTS the request, well before the photo itself is delivered on its own
    // event, so two taps close enough together can both reach this check before either's photo
    // has landed in `walk.stills`. Reading the REF — updated synchronously, not through a
    // re-render — is what stops the second tap from seeing the same stale count the first one
    // did: two calls to `capture()` back-to-back share this exact closure (no re-render happens
    // between them), so only a synchronous read closes the race.
    if (!canCaptureMore(walk, inFlightRef.current)) return;
    // Reserve the slot BEFORE issuing the request, not after it resolves — the request is
    // in flight from the moment it's issued, and reserving only after resolution would leave
    // the exact same gap open for two taps landing in the same tick.
    adjustInFlight(1);
    try {
      const { requested } = await Recorder.captureStill();
      if (!requested) {
        // `requested: false` means no `walkthrough:still` event will EVER follow for this call —
        // it is not "pending," it is a failed capture. Release the reservation immediately, or
        // this button would sit one slot short of its real cap for the rest of the walk. Leaving
        // the failure itself silent would let the user walk away from the site believing a still
        // was taken when nothing was recorded.
        adjustInFlight(-1);
        setError("The camera did not accept the capture request — no photo was taken. Try again.");
      }
      // requested: true stays reserved — released later by either the `still` event (delivered)
      // or a `walkthrough:error` (native reports it failed to write). There is no third outcome.
    } catch (err) {
      // The call to native itself never resolved into an accept/reject at all — release the
      // reservation for the same reason as the requested:false branch above.
      adjustInFlight(-1);
      const message = errorMessage(err);
      setError(message);
      dispatch({ type: "failed", reason: message });
    }
  }, [walk, adjustInFlight]);

  const end = useCallback(async () => {
    // The same synchronous admission guard `start()` has, for the same reason and against the same
    // control surface: two taps inside one tick. `walk.state` cannot serve — the "ended" dispatch
    // below is committed by React on a later tick, so the second tap reads "recording" and the
    // reducer's own recording-only guard never sees the first one.
    //
    // What the second call reaches is not a queue. Native launches an INDEPENDENT Task per
    // `endWalk()` (WalkthroughRecorder.swift), so two of them concurrently remove the same audio
    // tap, call finishWriting() on the same AVAssetWriter, and tear down the same singleton — at
    // the one moment in the walk when the file is not yet closed and every still is already on
    // disk. A ref assigned in the same tick as the native call is the only thing the second tap can
    // observe in time.
    if (endInFlightRef.current) return;
    dispatch({ type: "ended", at: Date.now() });
    // Kept for the finally below rather than read back off the ref, on the same rule start() uses:
    // only ever clear OUR OWN promise, and never mistake a synchronous throw (nothing assigned) for
    // a ref some other call legitimately left null.
    let pending: ReturnType<typeof Recorder.endWalk> | null = null;
    try {
      pending = Recorder.endWalk();
      endInFlightRef.current = pending;
      const result = await pending;
      // Diagnostic, deliberately unconditional while the video track is still cutting short.
      // A finished .mp4 cannot say whether frames stopped arriving or the writer refused them,
      // and that distinction decides whether the bug is ours or the glasses'.
      console.log("[walk census]", JSON.stringify(result.census ?? "none"));
      // audioUri is narration.m4a — the phone microphone recorded on its own, independent of the
      // video writer — when native produced one, and null when it could not (or on a dev client
      // older than the file, where the key is absent). Null is not a failure: the walk still has
      // its muxed track, and a walk failed over a missing extra would upload no video at all.
      // videoUri comes from here rather than from `started` because native only resolves once
      // AVAssetWriter reports .completed — so this path, unlike that one, is a finalised file.
      //
      // The census is FORWARDED, not merely logged. A walk whose glasses died ten minutes in
      // reaches here indistinguishable from a healthy one: no append was attempted after the
      // stream went quiet, so the writer-failure latch never tripped and AVAssetWriter finished
      // .completed with a valid file. Logging that and dispatching "finalized" regardless — which
      // is what this did — is what let a five-second recording upload as a twenty-minute site
      // visit. session.ts's reducer owns the verdict (it is the only place the wall clock lives)
      // and records it as `walk.videoCoverage`; the walk still completes, because a short video is
      // still evidence and the stills were never in question.
      dispatch({
        type: "finalized",
        audioUri: typeof result.audioUri === "string" && result.audioUri.length > 0 ? result.audioUri : null,
        videoUri: result.videoUri,
        // The whole record, for the server, gated on the pinned shape being complete — see
        // captureCensusFrom for why a partial census is filed as none rather than as zeros.
        captureCensus: captureCensusFrom(result.census),
        videoCensus: result.census
          ? {
              secondsSinceLastFrameArrived: result.census.secondsSinceLastFrameArrived,
              videoFramesAppended: result.census.videoFramesAppended,
            }
          : null,
        // The narration half of the same silence, and the more expensive one: when the writer
        // refuses phone-mic buffers it drops them without counting anything and without latching,
        // so the video track stays healthy and the walk finishes .completed holding a fraction of
        // the speech that scope extraction is supposed to read.
        //
        // The typeof check is the trap, not ceremony. `audioSecondsAppended` was added to a census
        // that already shipped, so a dev client can return every other counter and not this one;
        // the type says `number | undefined` for exactly that reason. Collapsing that to zero with
        // a `?? 0` would report NO NARRATION for every walk recorded by that build — zero is the
        // worst value in this range, the exact inverse of the video sentinel's `-1` reading as the
        // healthiest. Unmeasured must stay null, which session.ts then leaves as "unknown".
        audioCensus:
          result.census && typeof result.census.audioSecondsAppended === "number"
            ? { audioSecondsAppended: result.census.audioSecondsAppended }
            : null,
      });
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      dispatch({ type: "failed", reason: message });
    } finally {
      // Released whichever way the call settled. A rejected endWalk leaves the walk terminal-failed,
      // and the estimator's next action is a NEW walk on this same mounted screen — a guard left
      // latched here would refuse to end that one too, which is the failure this guard exists to
      // prevent, one walk later.
      if (pending !== null && endInFlightRef.current === pending) endInFlightRef.current = null;
    }
  }, []);

  // ── The recording's own size, against the ceiling the server presigns under ──────────────────────
  //
  // Nothing in this app bounds a walk's duration, and nothing bounds the glasses' output bitrate
  // either, so a long enough recording produces a `walk.mp4` bigger than the 2 GiB the server accepts
  // per artifact (session.ts's MAX_WALK_ARTIFACT_BYTES). Past that point the file is unfilable and
  // stays unfilable: every presign is refused on the size, the queue burns all five PUT attempts, and
  // — because completion needs EVERY artifact — the stills from the same site visit go down with it.
  // Retrying cannot change a file's size, and the walk's manifest entry keeps orphan recovery from
  // offering a stills-only salvage. So the LAST moment the outcome is still open is right here, while
  // the recording is running.
  //
  // MEASURED, never estimated. A bitrate guess would be wrong in both directions — too high stops
  // walks that were never in danger, too low is the same bug with extra steps — and the file itself
  // is one stat away.
  //
  // Re-read on an interval rather than once, and keyed on `walk.videoUri` so a walk native reported
  // no path for is simply never measured (assessWalkVideoSize reads null as "nothing to say").
  //
  // KNOWN LIMIT, stated rather than papered over: a JS interval does not run while iOS has the app
  // suspended. Native keeps writing, so a walk left recording with the app backgrounded can cross the
  // bound unobserved and be over it by the time this resumes. The walk screen holds keep-awake for
  // the whole recording precisely so that is not the normal shape of a walk, and upload.ts's
  // unfilable-artifact handling is what catches whatever gets past here — this bound is the cheap,
  // in-time answer, not the only one.
  useEffect(() => {
    if (walk.state !== "recording") return;
    const uri = walk.videoUri;
    if (!uri) return;
    let cancelled = false;
    const measure = async () => {
      const bytes = await readRecordingBytes(uri);
      // A reading that lands after the walk ended (or after this effect was torn down) belongs to
      // nothing — dropping it keeps the previous walk's last size from becoming the next one's first.
      if (!cancelled) setVideoBytes(bytes);
    };
    void measure();
    const id = setInterval(() => void measure(), WALK_VIDEO_SIZE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [walk.state, walk.videoUri]);

  // The bound itself. Ending the walk here is NOT the loss it looks like: `end()` is the ordinary
  // path, so AVAssetWriter finalises and what has been recorded so far is a real, uploadable file —
  // and the estimator can start another walk on the same job straight away. Letting it run past the
  // ceiling is the loss, and it takes the whole video rather than the excess.
  //
  // Deliberately NOT a "failed" walk and not an error: nothing went wrong. `stoppedAtSizeLimit` is
  // what the screen reads to say so, because a recording that stopped on its own with nothing said
  // is indistinguishable from one ended by a mis-tap — and the difference is whether anyone goes back
  // and records the rest of the site.
  useEffect(() => {
    if (walk.state !== "recording") return;
    if (stoppingForSizeRef.current) return;
    if (assessWalkVideoSize(videoBytes) !== "atLimit") return;
    stoppingForSizeRef.current = true;
    setStoppedAtSizeLimit(true);
    void end();
  }, [walk.state, videoBytes, end]);

  return {
    walk,
    error,
    walkId,
    start,
    capture,
    end,
    reset,
    stillCount: artifactCount(walk),
    bridgeAvailable: isAvailable,
    captureEnabled: canCaptureMore(walk, inFlightCount),
    atCaptureLimit: canCapture(walk) && !canCaptureMore(walk, inFlightCount),
    // Only while RECORDING: the verdict is about a file still being written, and reporting a stale
    // one against a finished walk would put a warning on a screen where nothing can act on it.
    videoSize: walk.state === "recording" ? assessWalkVideoSize(videoBytes) : "ok",
    stoppedAtSizeLimit,
  };
}
