/**
 * Typed access to the native walkthrough recorder.
 *
 * Thin by design: no interpretation, no lifecycle. The lifecycle lives in `session.ts` where it
 * is a pure reducer and therefore testable without a device — the same split that let review
 * find six real bugs in the Step 0 verdict logic that no device test would have caught.
 */
import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import type { StillSource } from "./session";
import { noteWalkStarted, noteWalkTeardown } from "./walk-teardown";

const native = NativeModules.WalkthroughRecorder as WalkthroughNativeModule | undefined;

/**
 * What `startWalk` reports back. `inputPortName` and `negotiatedSampleRate` describe the route
 * that is actually recording — native refuses to start at all unless that route is the glasses,
 * because a walk that quietly records the phone's microphone is a wasted site visit nobody
 * discovers until the scope comes back empty.
 */
export type WalkStarted = {
  walkId: string;
  directory: string;
  /**
   * The `.mp4` being written. Audio is muxed into it rather than living in a separate file —
   * the DAT video stream carries no audio (`audioCodec: nil`), so the HFP microphone is written
   * as a second track against the same clock origin.
   *
   * This path exists from the moment recording starts, but the file is NOT playable until
   * `endWalk` finalises the writer. Use the URI from `endWalk` for anything downstream.
   */
  videoUri: string;
  inputPortName: string;
  negotiatedSampleRate: number;
};

export type StillEvent = {
  uri: string;
  bytes: number;
  source: StillSource;
};

/**
 * Native rejects rather than resolving unless `AVAssetWriter` reached `.completed`, so a
 * `videoUri` here is a finalised file. A truncated `.mp4` that the upload queue then ships would
 * be worse than an outright failure, because it looks like success.
 */
export type WalkEnded = {
  videoUri: string;
  stills: number;
  /**
   * What the writer actually did. `secondsSinceLastFrameArrived` is the one that matters for video:
   * near zero means frames were still arriving and the writer refused them; large means the glasses
   * stopped sending. A finished file cannot distinguish those, which is why this exists.
   *
   * The audio counters answer a different question. The phone microphone never goes quiet, so there
   * is no tail to measure — what can happen is the writer refusing buffers mid-walk, which leaves a
   * healthy video track and a narration full of holes. `audioSecondsAppended` is the only field
   * that shows it.
   *
   * The four audio-side counters are OPTIONAL while `census` itself is not, and that is deliberate
   * rather than sloppy: `census?:` covers a dev client older than the census, but these were added
   * to an already-shipped census, so a build that reports every video counter and none of these is
   * a real intermediate state. Typing them as required would let `audioSecondsAppended` be read as
   * a number when it is `undefined` at runtime — and zero seconds of narration is the WORST value
   * in that range, so the mistake would surface as a warning on every walk from that build.
   */
  census?: {
    videoFramesReceived: number;
    videoFramesAppended: number;
    videoFramesDropped: number;
    audioBuffersAppended: number;
    secondsSinceLastFrameArrived: number;
    writerStatus: number;
    writerError: string;
    failedLatched: boolean;
    audioBuffersReceived?: number;
    audioBuffersDropped?: number;
    /** Seconds of phone-mic audio actually written to the audio track. */
    audioSecondsAppended?: number;
    /** Longest unbroken run of refused audio buffers — separates one sustained stall from
     *  scattered hiccups that happen to add up to the same total. */
    longestAudioDropRun?: number;
  };
};

type WalkthroughNativeModule = {
  startWalk(walkId: string): Promise<WalkStarted>;
  captureStill(): Promise<{ requested: boolean }>;
  endWalk(): Promise<WalkEnded>;
};

export const isAvailable = Platform.OS === "ios" && native != null;

function require_(): WalkthroughNativeModule {
  if (!native) {
    throw new Error(
      "WalkthroughRecorder native module is missing. This build predates the recorder — rebuild the dev client."
    );
  }
  return native;
}

/**
 * The walkId the next `endWalk()` is tearing down — the only state this module keeps, and not a
 * lifecycle: native's recorder is a singleton holding ONE walk slot (claimWalkSlot/teardown in
 * WalkthroughRecorder.swift), so "the last walk started" is not an inference, it is the walk.
 *
 * Kept so `endWalk` can name the directory it is still writing. See ./walk-teardown.ts for who asks
 * and why the answer cannot be read off the files instead.
 */
let startedWalkId: string | null = null;

export const Recorder = {
  startWalk: (walkId: string) => {
    // Before the call, not after it resolves: native creates walkthroughs/<walkId>/ during
    // startWalk, so from this line on the directory is this process's to account for. Announced for
    // the same reason it is remembered — a recovery scan running right now (see walk-teardown.ts)
    // has to hear about this walk before its directory can appear under it.
    startedWalkId = walkId;
    noteWalkStarted(walkId);
    return require_().startWalk(walkId);
  },
  captureStill: () => require_().captureStill(),
  endWalk: () => {
    const teardown = require_().endWalk();
    // Registered at the WRAPPER rather than by the two callers in useWalk that issue teardowns —
    // the detached unmount one and an end() tapped just before sign-out are both races, and a
    // registration a caller can forget fails silently as a walk mislabelled unplayable months later.
    // Nothing to register before a walk has ever started in this process; a stray endWalk there
    // tears down nothing.
    if (startedWalkId !== null) noteWalkTeardown(startedWalkId, teardown);
    return teardown;
  },
};

/**
 * Stills arrive asynchronously after `captureStill()` is accepted, never as its return value.
 * `captureStill` resolves only whether the REQUEST was accepted; a `requested: false` means no
 * event will follow at all, so callers must treat that as a failed capture rather than waiting.
 */
export function onStill(listener: (still: StillEvent) => void): () => void {
  if (!native) return () => {};
  const emitter = new NativeEventEmitter(native as never);
  const sub = emitter.addListener("walkthrough:still", listener);
  return () => sub.remove();
}

/** Errors that happen between calls — a still that could not be written to disk, for example. */
export function onRecorderError(listener: (error: { message: string }) => void): () => void {
  if (!native) return () => {};
  const emitter = new NativeEventEmitter(native as never);
  const sub = emitter.addListener("walkthrough:error", listener);
  return () => sub.remove();
}
