/**
 * Binds the pure walk reducer (session.ts) to the native recorder (native.ts).
 *
 * All lifecycle rules live here — when a "starting" dispatch is required, what a walk id has to
 * look like, that a still request accepted by native is not the same as a still having been
 * taken — so the screen that eventually calls this hook only renders state and wires up buttons.
 * No JSX here on purpose: this file should be testable without mounting anything visual.
 */
import { useCallback, useEffect, useReducer, useState } from "react";
import { artifactCount, canCapture, initialWalk, reduceWalk, type Walk } from "./session";
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
  start: () => Promise<void>;
  capture: () => Promise<void>;
  end: () => Promise<void>;
  stillCount: number;
  bridgeAvailable: boolean;
};

export function useWalk(dealId: string, projectId: string | null): UseWalkResult {
  const [walk, dispatch] = useReducer(reduceWalk, undefined, () => initialWalk(dealId, projectId));
  const [error, setError] = useState<string | null>(null);

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
    if (!canCapture(walk)) return;
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
    start,
    capture,
    end,
    stillCount: artifactCount(walk),
    bridgeAvailable: isAvailable,
  };
}
