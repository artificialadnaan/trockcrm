# Glasses Capture Phase 1 — Recorder + Session State Machine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A walk can be started, capture stills, and be ended, producing durable artifacts on disk with a lifecycle the UI can drive. No UI and no upload yet — those are Phases 2 and 3.

**Architecture:** A pure TypeScript state machine owns the walk lifecycle and artifact bookkeeping and is fully unit-tested. A native `WalkthroughRecorder` owns the AVFoundation and DAT session lifecycle and reports raw events. The two meet at a thin typed bridge, mirroring the split already used for the Step 0 rungs, where native measures and TypeScript judges.

**Tech Stack:** Swift (`WearablesBridge`, in-app-target via `withWearablesDat`), `MWDATCore`/`MWDATCamera` 0.8.0, `AVFoundation` (`AVAudioEngine`, `AVAssetWriter`), React Native legacy bridge, TypeScript, Jest (`jest-expo`).

---

## What Step 0 established, and what it binds us to

Measured on hardware 2026-07-30, both PASS:

- HFP survives a DAT camera stream — route held `BluetoothHFP` at 16000 Hz either side of `stream.start()`
- The phone camera does not disturb the route — `before`/`during`/`after` all `BluetoothHFP` at 16000 Hz

**That second result is conditional.** It was measured with a capture session configured **photo-output only, with no audio input**. Any future phone-camera code that adds an audio input invalidates it. Phase 2 must use the same shape.

**The start-of-walk order is not negotiable.** Meta's guidance says HFP must be fully configured before a camera stream starts or the audio route fails silently:

```
1. createSession(AutoDeviceSelector) → session.start() → wait for .started
2. addStream()                       ← stream created, NOT started
3. AVAudioSession .playAndRecord + [.allowBluetoothHFP] → setActive(true)
4. poll currentRoute.inputs for .bluetoothHFP     ← stabilization
5. stream.start()                    ← only now
6. AVAssetWriter begins
```

Seven defects fixed on 2026-07-30 were all the same mistake: reading SDK or iOS state on the line after asking for it. **Assume anything arriving via a publisher, a route change, or a session transition is not ready yet, and wait for it explicitly.** `checkHfpWithStream` in `WearablesBridge.swift` is a working reference for steps 1–5.

## Facts about the media

- Stills are `1080×1440` display / `1440×1080` stored + EXIF rotation, ~320 KB JPEG. **Consumers must honour EXIF orientation.**
- The DAT stream reports `audioCodec: nil` — **the video stream carries no audio.** The `.mp4`'s audio track comes entirely from the HFP recorder, so the two clocks must be reconciled against one session start time.
- `.high` stream resolution is 720×1280. `StreamConfiguration()` defaults to `.medium` (504×896), so the config must be passed explicitly.

## File structure

| File | Responsibility |
| --- | --- |
| `mobile/src/walkthrough/session.ts` | **Create.** Pure state machine + artifact bookkeeping. No React, no native, no I/O |
| `mobile/src/walkthrough/__tests__/session.test.ts` | **Create.** Unit tests |
| `mobile/src/walkthrough/native.ts` | **Create.** Typed bridge wrapper for the recorder. Thin, no logic |
| `mobile/plugins/wearables-native/WalkthroughRecorder.swift` | **Create.** Native recorder, separate file from `WearablesBridge` |
| `mobile/plugins/wearables-native/WalkthroughRecorder.m` | **Create.** RN registration |
| `mobile/plugins/withWearablesDat.js` | **Modify.** Add the two new files to `BRIDGE_FILES` so prebuild copies them |

`WalkthroughRecorder` is a **new file**, not more methods on `WearablesBridge`. That file is already ~700 lines and owns the diagnostic ladder; the recorder is a different responsibility with its own lifecycle.

---

## Task 1: Walk session state machine

**Files:**
- Create: `mobile/src/walkthrough/session.ts`
- Test: `mobile/src/walkthrough/__tests__/session.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import {
  initialWalk,
  reduceWalk,
  canCapture,
  artifactCount,
  type Walk,
} from "../session";

const started: Walk = reduceWalk(initialWalk("deal-1", "proj-7"), {
  type: "started",
  at: 1000,
  videoUri: "file:///docs/walk/video.mp4",
});

describe("initialWalk", () => {
  it("starts idle with no artifacts and remembers what it is attached to", () => {
    const walk = initialWalk("deal-1", "proj-7");
    expect(walk.state).toBe("idle");
    expect(walk.dealId).toBe("deal-1");
    expect(walk.projectId).toBe("proj-7");
    expect(artifactCount(walk)).toBe(0);
  });

  it("allows a walk with no project, since a deal is the only hard requirement", () => {
    expect(initialWalk("deal-1", null).projectId).toBeNull();
  });
});

describe("reduceWalk", () => {
  it("moves idle → starting → recording", () => {
    const walk = reduceWalk(initialWalk("deal-1", null), { type: "starting" });
    expect(walk.state).toBe("starting");
    expect(
      reduceWalk(walk, { type: "started", at: 1000, videoUri: "file:///v.mp4" }).state
    ).toBe("recording");
  });

  it("records stills only while recording", () => {
    const withStill = reduceWalk(started, {
      type: "still",
      uri: "file:///docs/walk/still-1.jpg",
      at: 2000,
      source: "glasses",
    });
    expect(artifactCount(withStill)).toBe(1);
    expect(withStill.stills[0]!.source).toBe("glasses");
  });

  // A still that arrives after the walk ended has nowhere to belong. Silently keeping it would
  // attach evidence to a finished walk that was already handed to the uploader.
  it("ignores a still that arrives after the walk ended", () => {
    const ended = reduceWalk(started, { type: "ended", at: 5000 });
    const late = reduceWalk(ended, {
      type: "still",
      uri: "file:///docs/walk/late.jpg",
      at: 6000,
      source: "glasses",
    });
    expect(artifactCount(late)).toBe(0);
  });

  it("moves recording → finalizing → complete and keeps the artifacts", () => {
    const withStill = reduceWalk(started, {
      type: "still",
      uri: "file:///s.jpg",
      at: 2000,
      source: "phone",
    });
    const ended = reduceWalk(withStill, { type: "ended", at: 5000 });
    expect(ended.state).toBe("finalizing");
    const done = reduceWalk(ended, { type: "finalized", audioUri: "file:///a.m4a" });
    expect(done.state).toBe("complete");
    expect(artifactCount(done)).toBe(1);
    expect(done.audioUri).toBe("file:///a.m4a");
  });

  it("records the elapsed duration on completion", () => {
    const ended = reduceWalk(started, { type: "ended", at: 5000 });
    expect(reduceWalk(ended, { type: "finalized", audioUri: null }).durationMs).toBe(4000);
  });

  // A failure must never discard what was already captured — a partial walk is still a site
  // visit that happened, and the stills are not reproducible.
  it("keeps captured artifacts when the walk fails", () => {
    const withStill = reduceWalk(started, {
      type: "still",
      uri: "file:///s.jpg",
      at: 2000,
      source: "glasses",
    });
    const failed = reduceWalk(withStill, { type: "failed", reason: "glasses disconnected" });
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("glasses disconnected");
    expect(artifactCount(failed)).toBe(1);
    expect(failed.videoUri).toBe("file:///docs/walk/video.mp4");
  });

  it("is inert once complete", () => {
    const done = reduceWalk(reduceWalk(started, { type: "ended", at: 5000 }), {
      type: "finalized",
      audioUri: null,
    });
    expect(reduceWalk(done, { type: "starting" })).toBe(done);
  });
});

describe("canCapture", () => {
  it("is true only while recording", () => {
    expect(canCapture(initialWalk("d", null))).toBe(false);
    expect(canCapture(reduceWalk(initialWalk("d", null), { type: "starting" }))).toBe(false);
    expect(canCapture(started)).toBe(true);
    expect(canCapture(reduceWalk(started, { type: "ended", at: 5000 }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd mobile && npx jest src/walkthrough/__tests__/session.test.ts
```
Expected: FAIL — `Cannot find module '../session'`.

- [ ] **Step 3: Write the implementation**

Create `mobile/src/walkthrough/session.ts`:

```ts
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
  | { type: "finalized"; audioUri: string | null }
  | { type: "failed"; reason: string };

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

/** Stills are only meaningful while the walk is actually running. */
export function canCapture(walk: Walk): boolean {
  return walk.state === "recording";
}

export function artifactCount(walk: Walk): number {
  return walk.stills.length;
}

/** Terminal states absorb every further event, so a late native callback cannot revive a walk. */
const TERMINAL: ReadonlySet<WalkState> = new Set<WalkState>(["complete", "failed"]);

export function reduceWalk(walk: Walk, event: WalkEvent): Walk {
  if (TERMINAL.has(walk.state)) return walk;

  switch (event.type) {
    case "starting":
      return walk.state === "idle" ? { ...walk, state: "starting" } : walk;

    case "started":
      return walk.state === "starting"
        ? { ...walk, state: "recording", startedAt: event.at, videoUri: event.videoUri }
        : walk;

    case "still":
      // Guarded rather than trusted: the native photo publisher is asynchronous, so a still
      // requested just before "end walk" can land after it. Attaching it to a walk already
      // handed to the uploader would be evidence in a place nothing will look.
      return canCapture(walk)
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd mobile && npx jest src/walkthrough/__tests__/session.test.ts
```
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/walkthrough/session.ts mobile/src/walkthrough/__tests__/session.test.ts
git commit -m "feat(mobile): walk session state machine"
```

---

## Task 2: Register the new native files with the config plugin

**Files:**
- Modify: `mobile/plugins/withWearablesDat.js`

The plugin copies bridge sources into the Xcode target on every prebuild. New Swift files are invisible to the build until they are listed here — a step that fails silently, since the app compiles fine without them and the module simply does not exist at the JS call site.

- [ ] **Step 1: Add the files**

In `mobile/plugins/withWearablesDat.js`, change:

```js
const BRIDGE_FILES = ["WearablesBridge.swift", "WearablesBridge.m"];
```

to:

```js
const BRIDGE_FILES = [
  "WearablesBridge.swift",
  "WearablesBridge.m",
  "WalkthroughRecorder.swift",
  "WalkthroughRecorder.m",
];
```

- [ ] **Step 2: Commit** (the build is verified in Task 3, once the files exist)

```bash
git add mobile/plugins/withWearablesDat.js
git commit -m "chore(mobile): copy the walkthrough recorder into the app target"
```

---

## Task 3: Native recorder — lifecycle, audio, and stills

**Files:**
- Create: `mobile/plugins/wearables-native/WalkthroughRecorder.swift`
- Create: `mobile/plugins/wearables-native/WalkthroughRecorder.m`

Video muxing is deliberately **not** in this task. This produces a working walk that records HFP audio and captures stills; Task 4 adds the video track. Splitting them means the hard part fails on its own rather than taking the lifecycle down with it.

- [ ] **Step 1: Create the Swift file**

```swift
/*
 * Records a walkthrough: HFP audio from the glasses, plus stills on demand.
 *
 * Separate from WearablesBridge deliberately. That file owns the diagnostic ladder and is
 * already large; this owns a session with a lifetime, and mixing the two would put a
 * long-running recording next to one-shot measurements in the same object.
 *
 * The start sequence is Meta's documented order and is NOT rearrangeable: the stream is created
 * but not started, HFP is brought up and allowed to settle, and only then does the stream start.
 * Starting the stream first makes the audio route fail silently.
 */
import AVFoundation
import Foundation
import MWDATCamera
import MWDATCore
import React

@objc(WalkthroughRecorder)
final class WalkthroughRecorder: RCTEventEmitter {
  private var session: DeviceSession?
  private var stream: MWDATCamera.Stream?
  private var photoToken: AnyListenerToken?
  private var recorder: AVAudioRecorder?
  private var hasListeners = false
  private var walkDirectory: URL?
  private var stillIndex = 0

  override static func requiresMainQueueSetup() -> Bool { true }
  override func supportedEvents() -> [String] { ["walkthrough:still", "walkthrough:error"] }
  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  private static func describe(_ error: Error) -> String {
    if let dat = error as? DatError { return dat.description }
    return error.localizedDescription
  }

  /// Artifacts live in the DOCUMENTS directory, never tmp. iOS purges tmp, and a walk whose
  /// stills vanish before the upload queue drains is a site visit that has to be repeated.
  private static func makeWalkDirectory(_ walkId: String) throws -> URL {
    let docs = try FileManager.default.url(
      for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let dir = docs.appendingPathComponent("walkthroughs/\(walkId)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  // MARK: - Start

  @objc(startWalk:resolver:rejecter:)
  func startWalk(_ walkId: String,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    Task {
      let audio = AVAudioSession.sharedInstance()
      do {
        let dir = try Self.makeWalkDirectory(walkId)
        walkDirectory = dir
        stillIndex = 0

        let sdk = Wearables.shared
        let selector = AutoDeviceSelector(wearables: sdk)
        var deadline = Date().addingTimeInterval(8)
        while selector.activeDevice == nil, Date() < deadline {
          try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard selector.activeDevice != nil else {
          reject("walk_no_device", "No eligible glasses after 8s", nil)
          return
        }

        let created = try sdk.createSession(deviceSelector: selector)
        session = created
        try created.start()
        deadline = Date().addingTimeInterval(10)
        while created.state != .started, Date() < deadline {
          try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard created.state == .started else {
          let stalled = created.state.description
          await teardown()
          reject("walk_session_not_started", "Session stalled in \(stalled)", nil)
          return
        }

        // Meta step: stream created, NOT started.
        guard let newStream = try created.addStream(
          config: StreamConfiguration(videoCodec: .raw, resolution: .high, frameRate: 30)
        ) else {
          await teardown()
          reject("walk_stream_nil", "addStream() returned nil", nil)
          return
        }
        stream = newStream

        photoToken = newStream.photoDataPublisher.listen { [weak self] (photo: PhotoData) in
          self?.deliverStill(photo)
        }

        // Meta step: HFP up and settled while the stream is still stopped.
        try audio.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothHFP])
        try audio.setActive(true)
        let routeDeadline = Date().addingTimeInterval(3)
        while !audio.currentRoute.inputs.contains(where: { $0.portType == .bluetoothHFP }),
              Date() < routeDeadline {
          try? await Task.sleep(nanoseconds: 100_000_000)
        }
        let input = audio.currentRoute.inputs.first
        guard input?.portType == .bluetoothHFP else {
          // Refuse rather than record silently. A walk with no glasses audio is a wasted site
          // visit, and the estimator will not discover it until the scope comes back empty.
          await teardown()
          reject(
            "walk_no_hfp",
            "Audio would record from \(input?.portName ?? "an unknown input"), not the glasses. "
              + "Connect them over Bluetooth and start again.",
            nil
          )
          return
        }

        let audioUrl = dir.appendingPathComponent("audio.m4a")
        let rec = try AVAudioRecorder(url: audioUrl, settings: [
          AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
          AVSampleRateKey: 16_000.0,
          AVNumberOfChannelsKey: 1,
        ])
        rec.record()
        recorder = rec

        // Meta step: only now.
        newStream.start()

        resolve([
          "walkId": walkId,
          "directory": dir.absoluteString,
          "audioUri": audioUrl.absoluteString,
          "inputPortName": input?.portName ?? "none",
          "negotiatedSampleRate": audio.sampleRate,
        ])
      } catch {
        await teardown()
        reject("walk_start_failed", "startWalk failed: \(Self.describe(error))", error)
      }
    }
  }

  // MARK: - Capture

  @objc(captureStill:rejecter:)
  func captureStill(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let stream else {
      reject("walk_not_recording", "No walk is running", nil)
      return
    }
    // Fire-and-forget by design: capturePhoto only reports that the request was ACCEPTED. The
    // image arrives later on photoDataPublisher and is emitted as a walkthrough:still event.
    resolve(["requested": stream.capturePhoto(format: .jpeg)])
  }

  private func deliverStill(_ photo: PhotoData) {
    guard let dir = walkDirectory else { return }
    stillIndex += 1
    let url = dir.appendingPathComponent(String(format: "still-%03d.jpg", stillIndex))
    do {
      try photo.data.write(to: url)
    } catch {
      if hasListeners {
        sendEvent(withName: "walkthrough:error",
                  body: ["message": "Could not save still: \(Self.describe(error))"])
      }
      return
    }
    if hasListeners {
      sendEvent(withName: "walkthrough:still",
                body: ["uri": url.absoluteString, "bytes": photo.data.count, "source": "glasses"])
    }
  }

  // MARK: - End

  @objc(endWalk:rejecter:)
  func endWalk(_ resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
    Task {
      let audioUri = recorder?.url.absoluteString
      await teardown()
      resolve(["audioUri": audioUri as Any, "stills": stillIndex])
    }
  }

  /// Stop everything and hand the glasses back. HFP and A2DP are mutually exclusive, so an audio
  /// session left active pins the glasses in HFP and every other app's playback through them
  /// stays 8 kHz mono.
  private func teardown() async {
    recorder?.stop()
    recorder = nil
    stream?.stop()
    session?.stop()
    photoToken = nil
    stream = nil
    session = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}
```

- [ ] **Step 2: Create the registration file**

`mobile/plugins/wearables-native/WalkthroughRecorder.m`:

```objc
/*
 * React Native registration for WalkthroughRecorder. Each signature must match the @objc
 * selector on the Swift side exactly, or the method silently does not exist at the JS call site.
 */
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE (WalkthroughRecorder, RCTEventEmitter)

RCT_EXTERN_METHOD(startWalk : (NSString *)walkId resolver : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(captureStill : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(endWalk : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)

@end
```

- [ ] **Step 3: Verify it compiles**

```bash
cd mobile && npx expo prebuild -p ios >/dev/null 2>&1 && \
  xcodebuild -workspace ios/TRockCam.xcworkspace -scheme TRockCam -configuration Debug \
  -destination generic/platform=iOS -allowProvisioningUpdates build 2>&1 \
  | grep -E "WalkthroughRecorder.swift:[0-9]+:[0-9]+: (warning|error)|BUILD SUCCEEDED|BUILD FAILED"
```

Expected: `** BUILD SUCCEEDED **` with no `WalkthroughRecorder.swift` warnings or errors.

Also confirm the copy happened — a missing entry in `BRIDGE_FILES` fails silently:
```bash
ls -la ios/TRockCam/WalkthroughRecorder.swift ios/TRockCam/WalkthroughRecorder.m
```

- [ ] **Step 4: Commit**

```bash
git checkout -- mobile/package.json 2>/dev/null || true
git add mobile/plugins/wearables-native/WalkthroughRecorder.swift mobile/plugins/wearables-native/WalkthroughRecorder.m
git commit -m "feat(mobile): native walkthrough recorder — audio and stills"
```

---

## Task 4: Typed bridge wrapper

**Files:**
- Create: `mobile/src/walkthrough/native.ts`

- [ ] **Step 1: Write it**

```ts
/**
 * Typed access to the native walkthrough recorder.
 *
 * Thin by design: no interpretation, no lifecycle. The lifecycle lives in `session.ts` where it
 * is unit-testable, and this only moves values across the bridge.
 */
import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import type { StillSource } from "./session";

const native = NativeModules.WalkthroughRecorder as WalkthroughNativeModule | undefined;

export type WalkStarted = {
  walkId: string;
  directory: string;
  audioUri: string;
  /** The route actually recording. startWalk refuses unless this is the glasses. */
  inputPortName: string;
  negotiatedSampleRate: number;
};

export type StillEvent = {
  uri: string;
  bytes: number;
  source: StillSource;
};

type WalkthroughNativeModule = {
  startWalk(walkId: string): Promise<WalkStarted>;
  captureStill(): Promise<{ requested: boolean }>;
  endWalk(): Promise<{ audioUri: string | null; stills: number }>;
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

/** Stills arrive asynchronously after captureStill() is accepted, never as its return value. */
export function onStill(listener: (still: StillEvent) => void): () => void {
  if (!native) return () => {};
  const emitter = new NativeEventEmitter(native as never);
  const sub = emitter.addListener("walkthrough:still", listener);
  return () => sub.remove();
}

export function onRecorderError(listener: (error: { message: string }) => void): () => void {
  if (!native) return () => {};
  const emitter = new NativeEventEmitter(native as never);
  const sub = emitter.addListener("walkthrough:error", listener);
  return () => sub.remove();
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd mobile && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "walkthrough" || echo "walkthrough: CLEAN"
```
Expected: `walkthrough: CLEAN`.

- [ ] **Step 3: Commit**

```bash
git add mobile/src/walkthrough/native.ts
git commit -m "feat(mobile): typed wrapper for the walkthrough recorder"
```

---

## Definition of done

- [ ] 11 new unit tests pass; full suite green
- [ ] `BUILD SUCCEEDED` with no warnings in `WalkthroughRecorder.swift`
- [ ] `ios/TRockCam/WalkthroughRecorder.swift` and `.m` exist after prebuild
- [ ] Typecheck clean for every touched file

## What this deliberately does NOT do

- **No video track.** The `.mp4` muxing is Phase 1b — `AVAssetWriter` fed from `videoFramePublisher` plus the HFP audio, with both clocks reconciled against one session start. Split out so the lifecycle lands first.
- **No UI** — Phase 2.
- **No upload** — Phase 3.
- **No server work** — Phase 4.

## Hardware verification this needs, which no test can replace

Every defect found on 2026-07-30 was invisible to a passing test suite. Before Phase 1 is trusted:

1. Start a walk with glasses connected → resolves, reports `inputPortName` as the glasses
2. Start a walk with glasses **disconnected** → rejects with `walk_no_hfp`, records nothing
3. Capture several stills → files land in `Documents/walkthroughs/<id>/` and events fire
4. End the walk → audio file exists, non-trivial size, glasses return to A2DP
