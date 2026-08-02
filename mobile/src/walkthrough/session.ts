/**
 * The walk lifecycle, as a pure reducer.
 *
 * Native owns the AVFoundation and DAT sessions; this owns what happened and what was captured.
 * Keeping it pure means the rules that actually matter — a still cannot be recorded after the
 * walk ended, a failure never discards captured evidence — are unit-testable without a device.
 */

export type WalkState =
  | "idle"
  | "starting"
  | "recording"
  | "finalizing"
  | "complete"
  | "failed";

/** Where a still came from. Glasses stills are 1.56 MP; phone stills are far sharper. */
export type StillSource = "glasses" | "phone";

export type WalkStill = {
  uri: string;
  at: number;
  source: StillSource;
};

export type Walk = {
  state: WalkState;
  /** A walk always belongs to a deal. The project is optional — not every deal has one yet. */
  dealId: string;
  projectId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  videoUri: string | null;
  audioUri: string | null;
  stills: WalkStill[];
  error: string | null;
};

export type WalkEvent =
  | { type: "starting" }
  | { type: "started"; at: number; videoUri: string | null }
  | { type: "still"; uri: string; at: number; source: StillSource }
  | { type: "ended"; at: number }
  /**
   * `videoUri` is the AUTHORITATIVE path, and it is why this event carries one at all even
   * though `started` already set it. Native only resolves `endWalk` once `AVAssetWriter` reports
   * `.completed`; before that the file on disk is a truncated `.mp4` that would look like a
   * successful walk to the uploader. Taking the path from here rather than trusting the one
   * captured at start means only a finalised file is ever handed on.
   *
   * `audioUri` is now always null: audio is muxed into the video track, so there is no separate
   * audio artifact. The field stays because a walk that fails before the writer produces a video
   * still needs somewhere for a future audio-only fallback to land.
   */
  | { type: "finalized"; audioUri: string | null; videoUri?: string | null }
  | { type: "failed"; reason: string }
  /**
   * Snaps the walk back to a fresh `idle` for (dealId, projectId), discarding whatever walk —
   * complete, failed, or otherwise — was here before. REFUSED, however, while the walk is ACTIVE
   * (see `isWalkActive`): starting/recording/finalizing means native has a real recording in
   * flight, and native keeps running regardless of what this reducer does — dropping
   * dealId/stills/video here would orphan that session, and the estimator's next "start" would
   * tear it down with nothing captured. So this is the one event allowed to escape TERMINAL
   * absorption, but not the one exception to "never discard an active recording": walk.tsx is a
   * hidden `Tabs.Screen` that never unmounts on navigation, so without SOME escape a walk that
   * finished would sit here forever, its terminal state absorbing every future "starting" event —
   * but that only ever needs to apply once the walk is no longer actually running. Unlike every
   * other event, this is not something native reports — it is dispatched by useWalk.ts when the
   * target a walk would attach to changes (or the screen wants a clean slate), so there is no
   * "spurious/duplicated" case to guard against the way there is for a native callback.
   */
  | { type: "reset"; dealId: string; projectId: string | null };

export function initialWalk(dealId: string, projectId: string | null): Walk {
  return {
    state: "idle",
    dealId,
    projectId,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    videoUri: null,
    audioUri: null,
    stills: [],
    error: null,
  };
}

/** Stills are only meaningful while the walk is actually running. Gates whether a NEW capture may
 *  be REQUESTED — see `canAcceptStill` for whether an already-in-flight one may still land. */
export function canCapture(walk: Walk): boolean {
  return walk.state === "recording";
}

/**
 * Whether a still EVENT may still attach to this walk. Wider than `canCapture` on purpose: a still
 * requested just before "end walk" is asynchronous (`capturePhoto` on the glasses, `onStill` here),
 * so it can resolve after the reducer has already moved to "finalizing". Native keeps its photo
 * listener alive through finalization and writes the JPEG to disk either way — refusing the event
 * here would not stop the capture, it would only orphan the file (present on disk, absent from the
 * manifest). Excludes the terminal states deliberately: a still arriving after "complete"/"failed"
 * has genuinely nowhere to go — the walk has already been handed to the uploader.
 */
export function canAcceptStill(walk: Walk): boolean {
  return walk.state === "recording" || walk.state === "finalizing";
}

/**
 * True while native has a real recording session in flight: asked to start, actively capturing,
 * or waiting on `AVAssetWriter` to finish. A walk in any of these states represents a site visit
 * physically happening RIGHT NOW — nothing may silently discard it (see the "reset" case of
 * `WalkEvent` and its use in `reduceWalk`/`useWalk.ts`'s `reset()`), because native does not stop
 * just because this reducer's state does, and a discarded walk here becomes an orphaned native
 * session the next "start" tears down with nothing to show for it.
 */
export function isWalkActive(state: WalkState): boolean {
  return state === "starting" || state === "recording" || state === "finalizing";
}

export function artifactCount(walk: Walk): number {
  return walk.stills.length;
}

/**
 * Hard cap the server enforces on a completed walk's total artifact count
 * (glasses-walkthrough-service.ts's `MAX_GLASSES_WALKTHROUGH_ARTIFACTS_PER_WALK`). Mirrored here
 * rather than imported — the mobile app has no shared package with the server — so if the server's
 * cap ever moves, this needs updating with it. Every walk that reaches "recording" always carries a
 * video artifact, so in practice this caps how many STILLS can be captured, not the raw number.
 */
export const MAX_WALK_ARTIFACTS = 200;

/**
 * Whether ONE MORE still could be captured right now without the walk's eventual completion
 * payload — video, plus audio if that dead-but-modeled path is ever revived, plus every still —
 * exceeding MAX_WALK_ARTIFACTS. Layered on top of `canCapture` (the state gate): this is the COUNT
 * gate, and it is what the capture control itself should check before requesting a new still, so
 * the walk never accumulates more than the server will accept at completion.
 *
 * `reserved` additionally counts capture requests already ACCEPTED by native but not yet
 * delivered as a `still` event — `walk.stills` only reflects DELIVERED stills, but
 * `Recorder.captureStill()` resolves the moment the request is accepted, well before the photo
 * itself arrives on its own async event. This reducer has no way to know about an outstanding
 * request on its own (native carries no id to correlate a request to its eventual event, so
 * there is nothing for a "requested" event to even look like) — useWalk.ts tracks that count and
 * passes it in, so two capture requests issued back-to-back still can't both pass a check that
 * only ever looked at what had already landed.
 */
export function canCaptureMore(walk: Walk, reserved = 0): boolean {
  if (!canCapture(walk)) return false;
  const projected =
    walk.stills.length + reserved + 1 /* the still being requested */ +
    (walk.videoUri ? 1 : 0) +
    (walk.audioUri ? 1 : 0);
  return projected <= MAX_WALK_ARTIFACTS;
}

/** Terminal states absorb every further event, so a late native callback cannot revive a walk.
 *  A "reset" event is the sole exception — see WalkEvent's `reset` case. */
const TERMINAL: ReadonlySet<WalkState> = new Set<WalkState>(["complete", "failed"]);

export function reduceWalk(walk: Walk, event: WalkEvent): Walk {
  if (event.type === "reset") {
    // Never discard an ACTIVE recording (isWalkActive) — see WalkEvent's "reset" doc. Refusing is
    // a genuine no-op: the walk keeps running, still attached to the deal it actually started
    // against, until it reaches a non-active state on its own.
    return isWalkActive(walk.state) ? walk : initialWalk(event.dealId, event.projectId);
  }
  if (TERMINAL.has(walk.state)) return walk;

  switch (event.type) {
    case "starting":
      return walk.state === "idle" ? { ...walk, state: "starting" } : walk;

    case "started":
      // Only accepted from "starting": a "started" that arrives without the app having
      // initiated one is a spurious or duplicated native event. Accepting it would put an
      // untouched walk into "recording" with no directory, no recorder, and no audio route.
      return walk.state === "starting"
        ? { ...walk, state: "recording", startedAt: event.at, videoUri: event.videoUri }
        : walk;

    case "still":
      // Guarded rather than trusted: the native photo publisher is asynchronous, so a still
      // requested just before "end walk" can land after it. canAcceptStill (not canCapture) is
      // deliberate here — see its doc comment for why "finalizing" still accepts one.
      return canAcceptStill(walk)
        ? {
            ...walk,
            stills: [...walk.stills, { uri: event.uri, at: event.at, source: event.source }],
          }
        : walk;

    case "ended":
      return walk.state === "recording"
        ? { ...walk, state: "finalizing", endedAt: event.at }
        : walk;

    case "finalized":
      return walk.state === "finalizing"
        ? {
            ...walk,
            state: "complete",
            audioUri: event.audioUri,
            // Only overwrite when the event actually carries one, so a caller that omits it
            // keeps whatever `started` recorded rather than having it silently nulled.
            videoUri: event.videoUri !== undefined ? event.videoUri : walk.videoUri,
            durationMs:
              walk.startedAt !== null && walk.endedAt !== null
                ? walk.endedAt - walk.startedAt
                : null,
          }
        : walk;

    case "failed":
      // Everything captured so far is kept. A walk is a site visit that physically happened;
      // its stills cannot be re-taken from a desk, so a failure must never be a delete.
      return { ...walk, state: "failed", error: event.reason };
  }
}
