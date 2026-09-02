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

/**
 * The capture census as it is FILED with the walk — the server's `captureCensus`, pinned field for
 * field. Distinct from the two verdict inputs above, which are the slices this reducer reasons
 * about; this is the whole record, kept so the office can read what the recorder saw on a walk
 * that came back thin (`engineRestarts`, the `events` timeline) rather than only that it did.
 *
 * `walkMs` is this reducer's wall clock (`startedAt` → `endedAt`), the same number every coverage
 * verdict is measured against, so the server's copy of the census agrees with the title it arrives
 * under. Everything else is native's, verbatim.
 */
export type WalkCaptureCensus = {
  walkMs: number;
  video: {
    framesReceived: number;
    framesAppended: number;
    framesDropped: number;
    secondsSinceLastFrameArrived: number;
  };
  audio: {
    buffersReceived: number;
    buffersAppended: number;
    buffersDropped: number;
    longestDropRun: number;
    secondsAppended: number;
    /** Times `WalkAudioCapture` brought the engine back after iOS stopped it. */
    engineRestarts: number;
    /** Seconds narration.m4a holds — the standalone file, independent of the writer. */
    standaloneSecondsRecorded: number;
    /** What happened to the microphone and when, `atMs` from the capture starting. */
    events: Array<{ atMs: number; kind: string }>;
  };
};

/** What the `finalized` event carries for the census: everything but the wall clock, which only
 *  this reducer holds. */
export type WalkCaptureCensusInput = Omit<WalkCaptureCensus, "walkMs">;

/**
 * Native's most recent `walkthrough:audioStalled` report — the microphone has delivered nothing
 * for `sinceMs`, and this is what the watchdog did about it.
 */
export type WalkAudioStall = {
  /** Consecutive watchdog restarts made for this stall, counting the one this report is about. */
  attempt: number;
  /** Whether that restart got the engine running. A running engine is not yet a delivering one —
   *  `Walk.audioAlive` turns back on only when a buffer actually arrives. */
  restarted: boolean;
  /** How long the microphone had been silent when this was reported, ms. */
  sinceMs: number;
};

/**
 * How many consecutive restarts native's watchdog makes before it gives up on a stall and reports
 * so (`WalkAudioCapture.maxWatchdogRestarts`). Mirrored rather than imported, like every other
 * native constant here; if native's cap moves, this moves with it. Past it the screen stops saying
 * "restarting" and says what is actually true: end this walk and start a new one.
 */
export const WALK_AUDIO_RESTART_ATTEMPTS = 3;

/**
 * Whether the watchdog has run out of restarts for the CURRENT stall. Only ever true while
 * `audioAlive` is false: a buffer arriving clears the stall (see the `audioLevel` case of
 * `reduceWalk`), which is the escape — an interruption that ends after the watchdog gave up still
 * brings the microphone back, and the banner must follow it.
 */
export function isAudioRestartExhausted(stall: WalkAudioStall | null): boolean {
  return stall !== null && stall.attempt >= WALK_AUDIO_RESTART_ATTEMPTS && !stall.restarted;
}

/**
 * Map native's RMS reading (0–1, in float-sample units) onto the meter's fill (0–1). Speech at
 * arm's length measures roughly 0.02–0.2 RMS, so drawn linearly the meter would barely move; the
 * square root lifts that range into the middle of the bar, and the gain lets a raised voice reach
 * the end of it. Non-finite and negative readings draw as empty — this is a meter, and a NaN would
 * otherwise become a width nobody can render.
 */
export function meterFractionForRms(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  return Math.min(1, Math.sqrt(rms) * 1.6);
}

export type Walk = {
  state: WalkState;
  /** A walk always belongs to a deal. The project is optional — not every deal has one yet. */
  dealId: string;
  projectId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  videoUri: string | null;
  /**
   * `narration.m4a`, the phone-microphone recording native keeps INDEPENDENTLY of the video
   * writer, set on "finalized" from `endWalk`'s `audioUri`. Null when native could not produce
   * one — the recorder failed to start, or recorded nothing — and on a dev client older than the
   * file. Never a reason to fail the walk: upload-core.ts's `toQueuedWalk` queues it as an audio
   * artifact when present and simply has one artifact fewer when not.
   */
  audioUri: string | null;
  /**
   * Whether phone-microphone audio is still arriving, as native last reported it. True from the
   * start — a build whose native side predates the events never reports either way, and a walk
   * nobody has measured must not open under a "narration stopped" banner — and false from a
   * `walkthrough:audioStalled` until the next `walkthrough:audioLevel` says a buffer landed.
   */
  audioAlive: boolean;
  /** Native's latest microphone level, RMS 0–1 (see `meterFractionForRms`). Zero while stalled. */
  audioLevel: number;
  /** Native's latest stall report, null while the microphone is delivering. See `WalkAudioStall`. */
  audioStall: WalkAudioStall | null;
  /**
   * The census as it will be filed with the walk (`captureCensus` on the completion request), or
   * null when native reported no complete one — a dev client older than the `audio` object. Set
   * once, on "finalized", alongside the two coverage verdicts it is the full record behind.
   */
  captureCensus: WalkCaptureCensus | null;
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
   * `audioUri` is `narration.m4a` — the standalone phone-microphone recording — when native produced
   * one, null when it could not. It USED to be always null, on the reasoning that audio was a track
   * inside the .mp4; two walks on 2026-09-02 then lost 3.8 minutes of narration to an engine iOS
   * stopped and nothing restarted, and the file that does not depend on that engine is the answer.
   * Only ever set from here (never from `failed`): a failed walk's file has not been closed.
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
   *
   * `captureCensus` is the whole record, for the server — see `WalkCaptureCensus`. Also optional,
   * and for the same reason a third time: only a native side that reports the `audio` object can
   * fill the pinned shape, and a partial census must arrive as none rather than as zeros.
   */
  | {
      type: "finalized";
      audioUri: string | null;
      videoUri?: string | null;
      videoCensus?: WalkVideoCensus | null;
      audioCensus?: WalkAudioCensus | null;
      captureCensus?: WalkCaptureCensusInput | null;
    }
  /** Native's ~4/s microphone level while recording. A buffer arrived, so the microphone is alive. */
  | { type: "audioLevel"; rms: number }
  /** Native's watchdog found the microphone silent — see `WalkAudioStall` for the fields. */
  | { type: "audioStalled"; attempt: number; restarted: boolean; sinceMs: number }
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
    audioAlive: true,
    audioLevel: 0,
    audioStall: null,
    captureCensus: null,
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
  // A non-finite tail counts as NO video, matching assessAudioCoverage's own guard. Without it the
  // failure is silent rather than loud: `< 0` is FALSE for NaN, so a NaN tail slips past the
  // sentinel check, `NaN * 1000` propagates through every clamp, and `isVideoTruncated` compares
  // NaN against the tolerance — which is false. The warning would vanish on exactly the walk that
  // could not be measured, instead of misfiring where someone would notice.
  const noVideoAtAll =
    !Number.isFinite(census.secondsSinceLastFrameArrived) ||
    census.videoFramesAppended <= 0 ||
    census.secondsSinceLastFrameArrived < 0;
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
 * Hard cap the server enforces on ONE artifact's bytes (glasses-walkthrough-service.ts's
 * `MAX_GLASSES_WALKTHROUGH_ARTIFACT_BYTES`). Mirrored rather than imported for the same reason
 * MAX_WALK_ARTIFACTS above is — the mobile app shares no package with the server — so if the
 * server's ceiling ever moves, this needs moving with it.
 *
 * It is validated at PRESIGN, not at upload: an artifact over it is refused a URL at all, with a 400
 * that no retry can change. For the stills that is unreachable; for `walk.mp4` it is a real end of
 * the line, because nothing in this app bounds a walk's duration or the glasses' output bitrate.
 */
export const MAX_WALK_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/**
 * How far under the ceiling a recording is stopped.
 *
 * Two things have to fit in here, and both land AFTER the last size this app can read:
 *
 *   - `moov`. AVAssetWriter appends the index in `finishWriting`, so the file grows once more after
 *     the recording stops — a few MB on a long walk, and the one part of the file that is not there
 *     to be measured while it is being written.
 *   - One polling interval of media. The size is read from disk every WALK_VIDEO_SIZE_POLL_MS, so
 *     the bound can be crossed by up to that much before anything notices — about 15 MB at the
 *     ~8 Mbps a 720p30 encode runs at.
 *
 * 64 MiB is several times both together. Erring large costs a few seconds of a recording nobody was
 * going to reach; erring small costs the entire video.
 */
export const WALK_VIDEO_SIZE_HEADROOM_BYTES = 64 * 1024 * 1024;

/** The size at which the walk is ended for it. Below the server's ceiling by the headroom above, so
 *  the FINALISED file — moov and all — still fits. */
export const WALK_VIDEO_STOP_BYTES = MAX_WALK_ARTIFACT_BYTES - WALK_VIDEO_SIZE_HEADROOM_BYTES;

/**
 * The size at which the estimator is TOLD, so the stop is never the first they hear of it.
 *
 * 256 MiB of warning is roughly four to eight minutes at the bitrates these recordings run at —
 * long enough to finish the elevation being walked and end the walk deliberately, which is the whole
 * point of warning rather than only stopping. The number is a margin below the stop, not a fraction
 * of the ceiling: what it buys is TIME, and time does not scale with the cap.
 */
export const WALK_VIDEO_WARN_BYTES = WALK_VIDEO_STOP_BYTES - 256 * 1024 * 1024;

/** How often `walk.mp4` is re-measured while recording. A stat, not a read — the cost is negligible
 *  at any interval, and the only thing shortening it buys is a tighter bound on the overshoot the
 *  headroom above already covers several times over. */
export const WALK_VIDEO_SIZE_POLL_MS = 10_000;

/** Where this recording stands against the server's per-artifact ceiling. */
export type WalkVideoSizeVerdict =
  /** Nothing to say. */
  | "ok"
  /** Close enough that the estimator should be finishing up — still their call. */
  | "nearLimit"
  /** Past the point where a finalised file would still fit. Not their call any more. */
  | "atLimit";

/**
 * Judge a recording's CURRENT size on disk against the bounds above.
 *
 * `null` — and any non-finite or negative reading — is "ok", never "atLimit", and that direction is
 * the important one. An unmeasurable walk is not an oversized walk: a `walk.mp4` native reported no
 * path for, a stat that failed, a platform that returned no size. The same rule the coverage
 * verdicts follow for a census that never arrived, and for a stronger reason here — the action
 * attached to "atLimit" ENDS a site visit, so being unable to read a file must never be what takes
 * one away.
 */
export function assessWalkVideoSize(bytes: number | null): WalkVideoSizeVerdict {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "ok";
  if (bytes >= WALK_VIDEO_STOP_BYTES) return "atLimit";
  return bytes >= WALK_VIDEO_WARN_BYTES ? "nearLimit" : "ok";
}

/**
 * Whether ONE MORE still could be captured right now without the walk's eventual completion
 * payload — video, plus the narration file when native produced one, plus every still —
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
  // The narration file is not known to this reducer until "finalized" (native only resolves its
  // path from endWalk), so it is reserved unconditionally rather than read off `audioUri` — a walk
  // that captured exactly to the cap and then gained an artifact at the end would be refused whole.
  const projected =
    walk.stills.length + reserved + 1 /* the still being requested */ +
    (walk.videoUri ? 1 : 0) +
    1; /* narration.m4a, if native produces one */
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

    case "audioLevel":
      // Only while recording: the meter and the banner are drawn for a live microphone, and a
      // level landing during "finalizing" (the tap is removed a bridge hop after "ended") must not
      // rewrite a walk that has already stopped. A buffer arriving is the ONE fact that ends a
      // stall — not a restart succeeding, which native itself only reports as "the engine
      // started" — so this is where `audioStall` clears and the watchdog's count starts over.
      if (walk.state !== "recording") return walk;
      return {
        ...walk,
        audioAlive: true,
        audioLevel: Number.isFinite(event.rms) ? Math.min(1, Math.max(0, event.rms)) : 0,
        audioStall: null,
      };

    case "audioStalled":
      if (walk.state !== "recording") return walk;
      return {
        ...walk,
        audioAlive: false,
        audioLevel: 0,
        audioStall: { attempt: event.attempt, restarted: event.restarted, sinceMs: event.sinceMs },
      };

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
        // The wall clock is stamped here, once, so the census the server files agrees with the two
        // verdicts below to the millisecond. Same rule as the verdicts for a walk with no clock.
        captureCensus:
          durationMs !== null && event.captureCensus
            ? { walkMs: durationMs, video: event.captureCensus.video, audio: event.captureCensus.audio }
            : null,
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
