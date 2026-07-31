/**
 * Typed access to the native walkthrough recorder.
 *
 * Thin by design: no interpretation, no lifecycle. The lifecycle lives in `session.ts` where it
 * is a pure reducer and therefore testable without a device — the same split that let review
 * find six real bugs in the Step 0 verdict logic that no device test would have caught.
 */
import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import type { StillSource } from "./session";

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
  audioUri: string;
  inputPortName: string;
  negotiatedSampleRate: number;
};

export type StillEvent = {
  uri: string;
  bytes: number;
  source: StillSource;
};

export type WalkEnded = {
  audioUri: string | null;
  stills: number;
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

export const Recorder = {
  startWalk: (walkId: string) => require_().startWalk(walkId),
  captureStill: () => require_().captureStill(),
  endWalk: () => require_().endWalk(),
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
