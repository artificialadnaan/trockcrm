/**
 * Binds the pure walk reducer (session.ts) to the native recorder (native.ts).
 *
 * All lifecycle rules live here — when a "starting" dispatch is required, what a walk id has to
 * look like, that a still request accepted by native is not the same as a still having been
 * taken — so the screen that eventually calls this hook only renders state and wires up buttons.
 * No JSX here on purpose: this file should be testable without mounting anything visual.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  artifactCount,
  canCapture,
  canCaptureMore,
  initialWalk,
  isWalkActive,
  reduceWalk,
  type Walk,
} from "./session";
import { isAvailable, onRecorderError, onStill, Recorder } from "./native";

/**
 * A filesystem-safe walk id. Native creates `Documents/walkthroughs/<id>/`, so this must be safe
 * as a directory component: lowercase alphanumerics and hyphens only, no separators. No uuid dep
 * is bundled — same tradeoff as `newClientUploadId` in capture/upload-queue-core.ts.
 */
function newWalkId(): string {
  return `walk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
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
};

export function useWalk(dealId: string, projectId: string | null): UseWalkResult {
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
  }, [dealId, projectId, walk.state]);

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
  }, [walk, dealId, projectId]);

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
    return () => {
      offStill();
      offError();
    };
  }, [adjustInFlight]);

  const start = useCallback(async () => {
    dispatch({ type: "starting" });
    const id = newWalkId();
    // Set BEFORE the native call resolves: even a walk that fails at startWalk() is "that" id (it's
    // what was passed to native, which may already have created the directory) — and a caller that
    // reads walkId off a "failed" state relies on it being populated by the time that state lands.
    setWalkId(id);
    try {
      const started = await Recorder.startWalk(id);
      // Record the path native reports rather than null. It is not playable yet — the writer
      // finalises in endWalk — but holding it means a walk that FAILS mid-recording still knows
      // where its partial file is, and a partial walk is still a site visit that happened.
      dispatch({ type: "started", at: Date.now(), videoUri: started.videoUri });
    } catch (err) {
      // Verbatim: native's rejection message (e.g. `walk_no_hfp`) names the input it would
      // otherwise have recorded from. That text IS the instruction — replacing it with
      // something generic would throw away the one piece of information that explains the
      // failure.
      const message = errorMessage(err);
      setError(message);
      dispatch({ type: "failed", reason: message });
    }
  }, []);

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
    dispatch({ type: "ended", at: Date.now() });
    try {
      const result = await Recorder.endWalk();
      // Diagnostic, deliberately unconditional while the video track is still cutting short.
      // A finished .mp4 cannot say whether frames stopped arriving or the writer refused them,
      // and that distinction decides whether the bug is ours or the glasses'.
      console.log("[walk census]", JSON.stringify(result.census ?? "none"));
      // audioUri is null by design: audio is a track inside the .mp4, not a separate artifact.
      // videoUri comes from here rather than from `started` because native only resolves once
      // AVAssetWriter reports .completed — so this path, unlike that one, is a finalised file.
      dispatch({ type: "finalized", audioUri: null, videoUri: result.videoUri });
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      dispatch({ type: "failed", reason: message });
    }
  }, []);

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
  };
}
