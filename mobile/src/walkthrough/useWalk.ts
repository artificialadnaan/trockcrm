/**
 * Binds the pure walk reducer (session.ts) to the native recorder (native.ts).
 *
 * All lifecycle rules live here — when a "starting" dispatch is required, what a walk id has to
 * look like, that a still request accepted by native is not the same as a still having been
 * taken — so the screen that eventually calls this hook only renders state and wires up buttons.
 * No JSX here on purpose: this file should be testable without mounting anything visual.
 */
import { useCallback, useEffect, useReducer, useState } from "react";
import { artifactCount, canCapture, canCaptureMore, initialWalk, reduceWalk, type Walk } from "./session";
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
   * `walk.state` is already terminal (complete/failed) — resetting an active walk would silently
   * discard an in-progress site visit.
   */
  reset: () => void;
  stillCount: number;
  bridgeAvailable: boolean;
  /** Whether `capture()` will actually request a still right now — false while not recording AND
   *  once the walk is already at MAX_WALK_ARTIFACTS (session.ts's canCaptureMore). Drives the
   *  CAPTURE control's disabled state. */
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

  const reset = useCallback(() => {
    dispatch({ type: "reset", dealId, projectId });
    setError(null);
    setWalkId(null);
  }, [dealId, projectId]);

  // Auto-reset whenever the TARGET a walk would attach to changes — belt-and-suspenders alongside
  // walk.tsx's own focus-triggered reset() call: a caller that re-renders this hook against a
  // DIFFERENT deal must never keep the previous deal's dealId/videoUri/stills sitting in `walk`,
  // even if a focus transition never fires. Done during render (React's documented "adjusting
  // state when a prop changes" pattern), not in a useEffect, so a changed identity is never shown
  // — even for one frame — with the OLD walk's state.
  const identity = `${dealId}:${projectId ?? ""}`;
  const [resetIdentity, setResetIdentity] = useState(identity);
  if (resetIdentity !== identity) {
    setResetIdentity(identity);
    dispatch({ type: "reset", dealId, projectId });
    setError(null);
    setWalkId(null);
  }

  useEffect(() => {
    const offStill = onStill((still) => {
      dispatch({ type: "still", uri: still.uri, at: Date.now(), source: still.source });
    });
    // Errors that happen between calls — e.g. a still that failed to write to disk after
    // capture was already accepted. Surfaced independently of the reducer: the walk itself may
    // still be perfectly fine.
    const offError = onRecorderError((e) => {
      setError(e.message);
    });
    return () => {
      offStill();
      offError();
    };
  }, []);

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
    if (!canCaptureMore(walk)) return;
    try {
      const { requested } = await Recorder.captureStill();
      if (!requested) {
        // `requested: false` means no `walkthrough:still` event will EVER follow for this call —
        // it is not "pending," it is a failed capture. Leaving this silent would let the user
        // walk away from the site believing a still was taken when nothing was recorded.
        setError("The camera did not accept the capture request — no photo was taken. Try again.");
      }
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      dispatch({ type: "failed", reason: message });
    }
  }, [walk]);

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
    captureEnabled: canCaptureMore(walk),
    atCaptureLimit: canCapture(walk) && !canCaptureMore(walk),
  };
}
