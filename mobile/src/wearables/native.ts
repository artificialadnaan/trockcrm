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

type WearablesNativeModule = {
  configure(): Promise<ConfigureResult>;
  capabilities(): Promise<Capabilities>;
  status(): Promise<WearablesStatus>;
  diagnose(): Promise<Diagnosis>;
  checkHfpWithStream(): Promise<HfpStreamCheck>;
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
