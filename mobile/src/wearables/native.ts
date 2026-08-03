/**
 * Typed access to the native Meta Wearables bridge.
 *
 * The native side is registered through RCT_EXTERN_MODULE, so a missing method fails at the
 * call site with an unhelpful "is not a function". `isAvailable` lets callers distinguish
 * "this build has no bridge" from "the SDK rejected the call", which are very different
 * problems and look identical otherwise.
 */
import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import type { HfpStreamCheck, PhoneCameraCheck } from "./step0-verdicts";

const native = NativeModules.WearablesBridge as WearablesNativeModule | undefined;

export type ConfigureResult = { configured: boolean; alreadyConfigured: boolean };

export type Capabilities = {
  configured: boolean;
  mockDeviceKitAvailable: boolean;
  metaAppId: string;
  developerMode: boolean;
  appLinkURLScheme: string;
  /**
   * The stream ceiling for each SDK resolution tier, read straight from the SDK rather than
   * inferred from one measured stream — `StreamConfiguration()` defaults to `.medium`, so a
   * single run says nothing about `.high`. This is the number the stills-vs-frames decision
   * (rung 7) actually turns on.
   */
  streamResolutions: StreamResolutions;
};

/**
 * One "WIDTHxHEIGHT" entry per case of the SDK's `StreamingResolution` (MWDATCamera), which is
 * `CaseIterable` over exactly these three — keyed by `String(describing:)` of the case name.
 */
export type StreamResolutions = {
  high: string;
  medium: string;
  low: string;
};

export type WearablesStatus = {
  registrationState: string;
  deviceCount: number;
  devices: string[];
};

export type StreamInfo =
  | { hasFrame: false }
  | {
      hasFrame: true;
      width: number;
      height: number;
      megapixels: number;
      firstFrameSeconds: number;
    };

/** The photo measurement that decides whether stills are worth capturing on their own. */
export type PhotoMeasurement = {
  bytes: number;
  format: string;
  width?: number;
  height?: number;
  megapixels?: number;
  largerThanStreamCeiling?: boolean;
  fileUri: string;
};

/** The audio measurement that decides whether HFP capture is good enough for transcription. */
export type AudioMeasurement = {
  fileUri: string;
  bytes: number;
  negotiatedSampleRate: number;
  wideband: boolean;
  inputPortName: string;
  inputPortType: string;
  isBluetoothInput: boolean;
  streamWasRunningFirst: boolean;
};

/**
 * Why `createSession` reported no eligible device. `noEligibleDevice` collapses several
 * distinct causes into one string; this pulls them back apart.
 */
export type Diagnosis = {
  deviceCount: number;
  devices: Array<{
    name?: string;
    /** `disconnected` here means paired for Bluetooth audio but NOT linked over DAT. */
    linkState?: string;
    /** `deviceUpdateRequired` / `sdkUpdateRequired` leave a device registered but ineligible. */
    compatibility?: string;
    deviceType?: string;
    supportsDisplay?: boolean;
    resolved?: false;
  }>;
  cameraPermission: string;
  activeDeviceImmediate: string;
  activeDeviceAfterWait: string;
  verdict: string;
};

/**
 * How long the glasses keep sending video with NO audio session anywhere.
 *
 * Four real walks each produced 3-8 seconds of video against 23-47 seconds of audio, with the
 * writer accepting every frame it was given — so delivery stopped, it was not refused. This
 * isolates HFP as the cause: if frames sustain here, glasses audio and video cannot run together
 * for a walk, and capture becomes audio + stills.
 */
export type StreamEnduranceMeasurement = {
  secondsObserved: number;
  /** Arrivals per second, so a stall shows as a run of zeros rather than a shrunken total. */
  framesPerSecond: number[];
  totalFrames: number;
  /** How far into the run the LAST frame landed, or -1 if none ever did. */
  secondsToLastFrame: number;
  audioSessionUsed: false;
};

/**
 * Glasses video with the PHONE's microphone instead of the glasses'.
 *
 * Rung 11 showed video sustains a full minute alone and dies at 3-8s under HFP, so the conflict
 * is the Bluetooth profile switch rather than audio recording. Recording on the phone never puts
 * the glasses into hands-free mode — and at 48 kHz it is better audio than HFP's 16 kHz ceiling,
 * provided the phone is in hand rather than a pocket.
 *
 * `inputPortType` is load-bearing: if the route picked the glasses anyway this re-measured HFP
 * and the result means nothing, so native refuses rather than reporting it.
 */
export type PhoneAudioStreamMeasurement = {
  secondsObserved: number;
  framesPerSecond: number[];
  totalFrames: number;
  secondsToLastFrame: number;
  /**
   * The route as it stood when the run FINISHED, not when it started, together with the sample rate
   * read in the same breath. iOS reroutes audio mid-run on its own, and a port named from a reading
   * taken a minute earlier can describe something that stopped being the source seconds in.
   */
  inputPortName: string;
  inputPortType: string;
  negotiatedSampleRate: number;
  /**
   * The route BEFORE the run, which is the one native's up-front guard actually vetted. Differs
   * from `inputPortType` only when iOS switched routes during the measurement — which is exactly
   * the case that voids the result, so it is reported rather than corrected away.
   *
   * Optional because it was added after the measurement shipped: a dev client built before this
   * reports every other field and not this one.
   */
  initialInputPortType?: string;
  audioBytes: number;
  audioFileUri: string;
};

type WearablesNativeModule = {
  configure(): Promise<ConfigureResult>;
  capabilities(): Promise<Capabilities>;
  status(): Promise<WearablesStatus>;
  diagnose(): Promise<Diagnosis>;
  checkHfpWithStream(): Promise<HfpStreamCheck>;
  measureStreamWithoutAudio(seconds: number): Promise<StreamEnduranceMeasurement>;
  measureStreamWithPhoneAudio(seconds: number): Promise<PhoneAudioStreamMeasurement>;
  checkPhoneCameraDuringHfp(): Promise<PhoneCameraCheck>;
  startRegistration(): Promise<{ started: boolean }>;
  handleUrl(url: string): Promise<{ handled: boolean }>;
  requestCameraPermission(): Promise<{ status: string }>;
  startStream(): Promise<{ started: boolean; config: string }>;
  streamInfo(): Promise<StreamInfo>;
  stopStream(): Promise<{ stopped: boolean }>;
  capturePhoto(): Promise<{ requested: boolean }>;
  recordGlassesAudio(seconds: number): Promise<AudioMeasurement>;
};

export const isAvailable = Platform.OS === "ios" && native != null;

/**
 * The error (if any) from the app's one-time startup `Wearables.configure()` call
 * (app/_layout.tsx). That call must never block app launch, so it deliberately swallows its own
 * promise rejection rather than throwing — but silently discarding it left nothing for a walk to
 * report when the REAL cause of a `walk_not_configured` rejection (from
 * `WalkthroughRecorder.startWalk`'s own configured guard) was a launch-time configuration
 * failure (bad Meta credentials, SDK init error), not "no device". A plain module-level variable,
 * rather than React state, so it survives regardless of which screen the user is on when a walk
 * actually starts, without wiring a provider through the whole app for one rarely-needed value.
 */
let startupConfigureError: Error | null = null;

/**
 * Called from the startup effect's `.catch`. Never throws.
 *
 * `null` and `undefined` CLEAR the retained cause rather than storing `Error("null")`. Without that
 * branch the coercion below is a trap: the one caller that wants to say "there is no startup error"
 * — a reset between tests, or a later successful configure — would instead install a cause reading
 * `null`, which then gets appended to the next `walk_not_configured` refusal as though it explained
 * something. A setter whose only clearing input silently stores a lie is worse than one that cannot
 * clear at all.
 */
export function setStartupConfigureError(error: unknown): void {
  if (error === null || error === undefined) {
    startupConfigureError = null;
    return;
  }
  startupConfigureError = error instanceof Error ? error : new Error(String(error));
}

/** The real cause of a failed startup `configure()`, or null if it never failed (or never ran). */
export function getStartupConfigureError(): Error | null {
  return startupConfigureError;
}

function require_(): WearablesNativeModule {
  if (!native) {
    throw new Error(
      "WearablesBridge native module is missing. This build predates the DAT integration — rebuild the dev client."
    );
  }
  return native;
}

export const Wearables = {
  configure: () => require_().configure(),
  capabilities: () => require_().capabilities(),
  status: () => require_().status(),
  diagnose: () => require_().diagnose(),
  checkHfpWithStream: () => require_().checkHfpWithStream(),
  measureStreamWithoutAudio: (seconds: number) => require_().measureStreamWithoutAudio(seconds),
  measureStreamWithPhoneAudio: (seconds: number) => require_().measureStreamWithPhoneAudio(seconds),
  checkPhoneCameraDuringHfp: () => require_().checkPhoneCameraDuringHfp(),
  startRegistration: () => require_().startRegistration(),
  handleUrl: (url: string) => require_().handleUrl(url),
  requestCameraPermission: () => require_().requestCameraPermission(),
  startStream: () => require_().startStream(),
  streamInfo: () => require_().streamInfo(),
  stopStream: () => require_().stopStream(),
  capturePhoto: () => require_().capturePhoto(),
  recordGlassesAudio: (seconds: number) => require_().recordGlassesAudio(seconds),
};

/** Photos arrive asynchronously after capturePhoto() is accepted, never as its return value. */
export function onPhoto(listener: (photo: PhotoMeasurement) => void): () => void {
  if (!native) return () => {};
  const emitter = new NativeEventEmitter(native as never);
  const sub = emitter.addListener("wearables:photo", listener);
  return () => sub.remove();
}
