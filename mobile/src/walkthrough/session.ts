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

/**
 * How much of the walk the finished video actually holds, derived from the census `endWalk` returns.
 *
 * Exists because the ONE failure this recorder cannot survive is also the one that leaves no trace.
 * When the glasses disconnect — or their publisher simply goes quiet — while the phone microphone
 * keeps feeding the writer, nothing fails: no append is attempted, so the writer-failure latch never
 * trips, and `AVAssetWriter` finishes `.completed` with a valid `walk.mp4` holding five seconds of
 * picture against a twenty-minute site visit. Afterwards the file cannot tell that apart from a walk
 * that genuinely lasted five seconds. This is the record of the difference, computed at the only
 * moment it is knowable.
 */
export type WalkVideoCoverage = {
  /** Wall-clock ms the walk itself ran (startedAt → endedAt). */
  walkMs: number;
  /** Estimated ms of that wall clock the video track actually holds. */
  videoMs: number;
  /** `walkMs - videoMs`: how much of the site visit has no picture. Never negative. */
  shortfallMs: number;
};

/**
 * How much of the walk the finished audio track actually holds. The same record as
 * `WalkVideoCoverage`, for the transport that matters more: the spoken narration is the INPUT to
 * scope extraction, so a walk with a hole in its audio is a site visit that has to be repeated even
 * when every frame landed.
 *
 * Measured differently from video, though, because it fails differently. Video dies at the source —
 * the glasses go quiet and never resume — so a quiet TAIL is the whole story. The phone microphone
 * does not go quiet; it keeps delivering for the full walk while `AVAssetWriter` refuses buffers
 * under backpressure, which scatters the losses through the MIDDLE of the recording. A tail
 * measurement would read that walk as perfect. So this counts what was actually written instead.
 */
export type WalkAudioCoverage = {
  /** Wall-clock ms the walk itself ran (startedAt → endedAt). */
  walkMs: number;
  /** Ms of narration actually written to the audio track. */
  audioMs: number;
  /** `walkMs - audioMs`: how much of the site visit has no narration. Never negative. */
  shortfallMs: number;
};

/** The slice of native's `endWalk` census this module reasons about. Deliberately a subset — the
 *  other counters (received/dropped/writerStatus) are diagnostics for a human reading a log, not
 *  inputs to a verdict, and depending on them here would couple the reducer to native's full shape. */
export type WalkVideoCensus = {
  /**
   * Native's `secondsSinceLastFrameArrived` VERBATIM, sentinel included. `WalkVideoWriter.census()`
   * reports `-1` when `lastFrameArrivedAt` was never valid — i.e. not one frame ever arrived. Kept
   * raw rather than pre-normalised at the bridge so the sentinel is handled in exactly one place,
   * with a test on it (`assessVideoCoverage`), instead of being quietly lost in a conversion.
   */
  secondsSinceLastFrameArrived: number;
  /** Frames actually written to the video track. Zero means an empty track no matter what the
   *  quiet-tail number says. */
  videoFramesAppended: number;
};

/**
 * The audio counterpart, and deliberately its own type rather than two more fields on
 * `WalkVideoCensus`: the two verdicts are independent measurements of two independent transports
 * (the glasses' DAT stream and CoreAudio), either of which can be perfect while the other is dead.
 * Merging them would let a caller supply one and silently imply the other.
 */
export type WalkAudioCensus = {
  /**
   * Seconds of phone-microphone audio native actually appended to the writer, summed from the
   * sample buffers themselves (`WalkVideoWriter.audioSecondsAppended`) rather than inferred from a
   * buffer count — buffer size is a tap parameter, and a count would silently change meaning if it
   * were ever retuned.
   *
   * Where video's sentinel trap is that `-1` reads as the HEALTHIEST value in its range, this one's
   * is the mirror image: `0` is the WORST value here, so a census that simply predates this counter
   * must arrive as an absent `WalkAudioCensus` (null), never as a zeroed one. useWalk.ts is where
   * that distinction is enforced, because that is where the raw native payload is still visible.
   */
  audioSecondsAppended: number;
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
  /**
   * Set once, on "finalized", when native reported a census — null otherwise, which means UNKNOWN
   * rather than "fine": a dev client older than the census cannot be interrogated, and a walk nobody
   * could measure must not be presented as a short one (see `isVideoTruncated`).
   *
   * Deliberately NOT a state: a short walk is still `complete`. Downgrading it to `failed` would
   * discard the very evidence it is warning about — upload-core.ts's `toQueuedWalk` queues a video
   * only for a COMPLETE walk — and would also be a lie about the stills, which are unaffected by
   * whatever the video transport did.
   */
  videoCoverage: WalkVideoCoverage | null;
  /**
   * The same contract as `videoCoverage`, for the phone-microphone track: set once on "finalized"
   * when native reported audio counters, null when it did not (UNKNOWN, not "fine"). Also
   * deliberately not a state, and for a stronger reason than video — a walk downgraded to "failed"
   * queues NO video at all (upload-core.ts's `toQueuedWalk`), so failing a walk over its audio
   * would destroy the footage as well as the narration.
   */
  audioCoverage: WalkAudioCoverage | null;
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
   *
   * `videoCensus` is what native measured while the writer was still live. Passed in raw and turned
   * into `Walk.videoCoverage` here, rather than assessed at the bridge, because the verdict needs
   * `startedAt`/`endedAt` — which only this reducer holds — and because keeping the arithmetic pure
   * is what makes the sentinel handling in `assessVideoCoverage` testable without a device. Omitted
   * or null means the walk could not be measured (a dev client older than the census).
   *
   * `audioCensus` is the same arrangement for the phone-microphone track, carried separately rather
   * than folded into `videoCensus` because a dev client can predate the audio counters while still
   * reporting every video one — so "video measured, audio not" is a real state that has to be
   * expressible.
   */
  | {
      type: "finalized";
      audioUri: string | null;
      videoUri?: string | null;
      videoCensus?: WalkVideoCensus | null;
      audioCensus?: WalkAudioCensus | null;
    }
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
    videoCoverage: null,
    audioCoverage: null,
    stills: [],
    error: null,
  };
}

/**
 * How far the video may legitimately trail the end of the walk before the walk counts as truncated.
 *
 * Five seconds, and the number is about hardware latency, not about walks. A healthy stream is
 * `.high` = 720x1280 at 30fps, so the last frame lands ~33ms before the estimator's tap; on top of
 * that sits the glasses' own transport jitter, the RN bridge hop, and the moment native takes to
 * snapshot the census — all sub-second. The writer's own stall detector already gives up at 60
 * consecutive dropped frames (~2s at 30fps), so any walk the writer still believes is alive is by
 * construction under about two seconds of quiet. Five doubles that, leaving room for a Wi-Fi/BT
 * hiccup, and still sits an order of magnitude below the real failure: the measured HFP regression
 * produced 3-8 SECONDS of video on walks of 35-60 seconds, i.e. tens of seconds of shortfall.
 *
 * Absolute rather than a percentage on purpose. What is being measured is end-of-walk latency,
 * which does not scale with walk length — a proportional rule would let a twenty-minute walk lose
 * two full minutes in silence while nagging about a four-second hiccup on a thirty-second one.
 */
export const WALK_VIDEO_SHORTFALL_TOLERANCE_MS = 5_000;

/**
 * Turn one census into a coverage estimate against the walk's own wall clock.
 *
 * The estimate is `walkMs` minus the quiet tail, because frames start arriving at the top of the
 * walk and stop when the source dies — so the seconds since the LAST frame arrived are exactly the
 * seconds with no picture. Two inputs are traps rather than measurements and are handled first:
 *
 *   - `secondsSinceLastFrameArrived === -1` is native's sentinel for "no frame ever arrived", not a
 *     duration. Compared naively it is the healthiest number in the whole range, so the obvious
 *     `quiet > tolerance` check would wave through a video track with nothing in it at all.
 *   - `videoFramesAppended === 0` says the track is empty regardless of what the tail says. In
 *     practice the writer latches and `endWalk` rejects long before this, but a census that claims
 *     frames were still arriving into an empty track must not read as a covered walk.
 *
 * The census is snapshotted a bridge hop AFTER `endedAt` is stamped in JS, so the tail can measure
 * marginally longer than the walk; the shortfall is clamped to `walkMs` so coverage never goes
 * negative and the screen never reports more missing video than there was walk.
 */
export function assessVideoCoverage(walkMs: number, census: WalkVideoCensus): WalkVideoCoverage {
  const walk = Math.max(0, walkMs);
  const noVideoAtAll = census.videoFramesAppended <= 0 || census.secondsSinceLastFrameArrived < 0;
  const quietMs = noVideoAtAll ? walk : census.secondsSinceLastFrameArrived * 1000;
  const shortfallMs = Math.min(walk, Math.max(0, Math.round(quietMs)));
  return { walkMs: walk, videoMs: walk - shortfallMs, shortfallMs };
}

/**
 * Whether this walk's video came up short enough to be worth telling the estimator about. The one
 * place `WALK_VIDEO_SHORTFALL_TOLERANCE_MS` is compared against, so the screen and the upload
 * metadata can never disagree with each other about what "short" means.
 *
 * `null` (never measured) is FALSE, not true: an unverifiable walk is not a short walk, and warning
 * on every walk recorded by a build that cannot report is how a real warning gets ignored.
 */
export function isVideoTruncated(coverage: WalkVideoCoverage | null): boolean {
  return coverage !== null && coverage.shortfallMs > WALK_VIDEO_SHORTFALL_TOLERANCE_MS;
}

/**
 * How much narration a walk may legitimately be missing before it counts as truncated.
 *
 * Five seconds — the same number as the video tolerance, but NOT for the same reason, which is why
 * it is a separate constant rather than a shared one. The video figure covers end-of-walk latency;
 * this one covers two different sources of honest error:
 *
 *   - Clock skew at both ends. Native installs the microphone tap before `startWalk` resolves (which
 *     is when JS stamps `startedAt`) and removes it inside `endWalk` (after `endedAt`), so a healthy
 *     walk holds marginally MORE audio than wall clock, not less. That error is sub-second and, in
 *     the direction that matters here, negative.
 *   - Transient writer backpressure. The tap delivers 1024-frame buffers at 48 kHz — about 21ms
 *     each — so five seconds is roughly 235 consecutive refusals. An encoder that hiccups recovers
 *     inside a handful; one that has refused 235 in a row has stalled, which is the failure this
 *     exists to catch.
 *
 * Absolute rather than proportional for the same reason the video tolerance is, and with the same
 * cost of getting it wrong: a warning that fires on healthy walks is a warning the estimator stops
 * reading, and by then it is the real ones being ignored.
 */
export const WALK_AUDIO_SHORTFALL_TOLERANCE_MS = 5_000;

/**
 * Turn one audio census into a coverage estimate against the walk's own wall clock.
 *
 * Direct, not inferred: `audioSecondsAppended` is what native actually wrote, so the shortfall is
 * simply what the walk clock has and the track does not — and unlike the video estimate, it counts
 * gaps wherever they fall rather than assuming they are all at the end. Two clamps:
 *
 *   - Audio is clamped to `walkMs`, because the tap outlives the walk clock at both ends (see
 *     WALK_AUDIO_SHORTFALL_TOLERANCE_MS) and a walk must never report negative shortfall.
 *   - A non-finite counter is treated as ZERO coverage. useWalk.ts already refuses to build a census
 *     out of a missing counter, so this is a backstop — but the failure it prevents is quiet:
 *     `undefined * 1000` is NaN, NaN compares false against every threshold, and the warning would
 *     disappear rather than misfire.
 */
export function assessAudioCoverage(walkMs: number, census: WalkAudioCensus): WalkAudioCoverage {
  const walk = Math.max(0, walkMs);
  const appendedMs = Number.isFinite(census.audioSecondsAppended)
    ? Math.max(0, census.audioSecondsAppended * 1000)
    : 0;
  const audioMs = Math.min(walk, Math.round(appendedMs));
  return { walkMs: walk, audioMs, shortfallMs: walk - audioMs };
}

/**
 * Whether this walk's narration came up short enough to tell the estimator about. The one place
 * `WALK_AUDIO_SHORTFALL_TOLERANCE_MS` is compared against, so the screen and the upload metadata
 * can never disagree about what "short" means — the same rule `isVideoTruncated` follows.
 *
 * `null` (never measured) is FALSE, not true, for the same reason it is there.
 */
export function isAudioTruncated(coverage: WalkAudioCoverage | null): boolean {
  return coverage !== null && coverage.shortfallMs > WALK_AUDIO_SHORTFALL_TOLERANCE_MS;
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

    case "finalized": {
      if (walk.state !== "finalizing") return walk;
      const durationMs =
        walk.startedAt !== null && walk.endedAt !== null ? walk.endedAt - walk.startedAt : null;
      return {
        ...walk,
        state: "complete",
        audioUri: event.audioUri,
        // Only overwrite when the event actually carries one, so a caller that omits it
        // keeps whatever `started` recorded rather than having it silently nulled.
        videoUri: event.videoUri !== undefined ? event.videoUri : walk.videoUri,
        durationMs,
        // Still "complete" whatever this says — see Walk.videoCoverage for why a short walk is
        // annotated rather than failed. A walk with no wall clock to compare against (no
        // startedAt/endedAt, which "finalizing" makes impossible in practice) is left unmeasured
        // rather than assessed against a fabricated duration.
        videoCoverage:
          durationMs !== null && event.videoCensus
            ? assessVideoCoverage(durationMs, event.videoCensus)
            : null,
        // Assessed independently of the video verdict above, never derived from it: the DAT stream
        // and CoreAudio are separate transports, and the walk this whole mechanism exists for is
        // the one where exactly one of them died.
        audioCoverage:
          durationMs !== null && event.audioCensus
            ? assessAudioCoverage(durationMs, event.audioCensus)
            : null,
      };
    }

    case "failed":
      // Everything captured so far is kept. A walk is a site visit that physically happened;
      // its stills cannot be re-taken from a desk, so a failure must never be a delete.
      return { ...walk, state: "failed", error: event.reason };
  }
}
