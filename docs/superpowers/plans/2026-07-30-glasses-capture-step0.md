# Glasses Capture — Step 0 De-risk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the two silent-failure questions that gate the glasses-capture design in
`docs/superpowers/specs/2026-07-30-glasses-capture-design.md`, with measurements rather than
assumptions.

**Architecture:** Two new diagnostic rungs on the existing `dev-wearables` ladder. Native Swift
performs each sequence and reports **raw audio-route snapshots**; all verdict logic lives in
TypeScript as pure functions so it is unit-testable. The native layer never decides whether a
check passed — it only reports what the route was at each stage.

**Tech Stack:** Swift (`WearablesBridge`, in-app-target via `withWearablesDat`), `MWDATCore` /
`MWDATCamera` 0.8.0, `AVFoundation`, React Native legacy bridge (`RCT_EXTERN_MODULE`),
TypeScript, Jest (`jest-expo`).

---

## The two questions

1. **Does the HFP microphone route survive a DAT camera stream started in the documented order?**
   Never verified. The 2026-07-30 audio measurement ran while `startStream` was failing, so no
   stream existed (`streamWasRunningFirst: false`). If this fails, the video track and its
   muxing come out of the design and capture falls back to audio + stills.
2. **Does opening the phone camera for a still tear down the HFP route?** The design requires
   phone stills during a glasses walk, and both share one `AVAudioSession`.

Meta's documented sequence (`wearables.developer.meta.com`, DAT microphones and speakers):

```
1. addStream()                    ← stream created, NOT started
2. configure HFP, wait for route stabilization
3. stream.start()
```

---

## File Structure

| File | Responsibility |
| --- | --- |
| `mobile/src/wearables/step0-verdicts.ts` | **Create.** Pure functions turning raw route snapshots into verdicts. No React, no native imports |
| `mobile/src/wearables/__tests__/step0-verdicts.test.ts` | **Create.** Unit tests for the above |
| `mobile/plugins/wearables-native/WearablesBridge.swift` | **Modify.** Two new `@objc` methods + one shared route-snapshot helper |
| `mobile/plugins/wearables-native/WearablesBridge.m` | **Modify.** Register both methods |
| `mobile/src/wearables/native.ts` | **Modify.** Types and wrappers for both methods |
| `mobile/app/(app)/dev-wearables.tsx` | **Modify.** Rungs 9 and 10 |

Verdict logic is deliberately separated from `native.ts`: `native.ts` is a thin untestable bridge
wrapper, while `step0-verdicts.ts` is pure and carries the reasoning worth testing.

---

## Task 1: Verdict functions (pure TypeScript)

> **IMPLEMENTED — and the code below is the SKETCH, not the shipped version.**
> Commits `b12907bc7` → `04f1e98c6` → `dd2e5e43a`. Final: 19 tests, not 9.
>
> Two review rounds plus an implementer self-audit found **four** false-green paths in the
> sketch below. Do not re-apply it. Read `src/wearables/step0-verdicts.ts` instead.
>
> What the sketch got wrong, recorded because each is easy to reintroduce:
> 1. `describePhoneCameraCheck` never checked `after.isBluetoothHFP` alone, so a route lost
>    *after* the camera closed (Bluetooth renegotiation on teardown — the reason the check takes
>    three snapshots) returned `pass` while naming the built-in mic as the safe route.
> 2. Its pass branch never compared `after.sampleRate` to `WIDEBAND_HZ`, printing `8000 Hz`
>    beside the word "safe".
> 3. It never read `during.sampleRate` at all, so a rate that collapsed for exactly the window
>    the photo was open and recovered reported `pass` — despite the sibling branch already
>    encoding that a *recovering* dropout is still a failure.
> 4. The "recovered" wording claimed recovery unconditionally, including when `after` was itself
>    narrowband.
>
> Also added: `before.sampleRate < WIDEBAND_HZ` → `inconclusive`, because a narrowband baseline
> makes the rate question unmeasurable. It sits *after* the port-loss checks so a genuine route
> loss still fails rather than being masked by a bad baseline.
>
> The shipped `describePhoneCameraCheck` returns `pass` for exactly one of 27
> `(before, during, after)` combinations. That is the intended shape: this module's job is
> refusing to report a green it did not measure.

**Files:**
- Create: `mobile/src/wearables/step0-verdicts.ts`
- Test: `mobile/src/wearables/__tests__/step0-verdicts.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `mobile/src/wearables/__tests__/step0-verdicts.test.ts`:

```ts
import {
  describeHfpStreamCheck,
  describePhoneCameraCheck,
  type RouteSnapshot,
} from "../step0-verdicts";

const hfp: RouteSnapshot = {
  portType: "BluetoothHFP",
  portName: "RB Meta 014K",
  sampleRate: 16000,
  isBluetoothHFP: true,
};

const builtIn: RouteSnapshot = {
  portType: "MicrophoneBuiltIn",
  portName: "iPhone Microphone",
  sampleRate: 48000,
  isBluetoothHFP: false,
};

const none: RouteSnapshot = {
  portType: "none",
  portName: "none",
  sampleRate: 0,
  isBluetoothHFP: false,
};

describe("describeHfpStreamCheck", () => {
  it("passes when HFP is up before the stream and survives it", () => {
    const result = describeHfpStreamCheck({ beforeStreamStart: hfp, afterStreamStart: hfp });
    expect(result.outcome).toBe("pass");
    expect(result.summary).toContain("survived");
  });

  it("fails when the stream takes the route away", () => {
    const result = describeHfpStreamCheck({ beforeStreamStart: hfp, afterStreamStart: builtIn });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("iPhone Microphone");
  });

  it("fails when the route is lost entirely", () => {
    const result = describeHfpStreamCheck({ beforeStreamStart: hfp, afterStreamStart: none });
    expect(result.outcome).toBe("fail");
  });

  // A run where HFP never came up says nothing about the STREAM's effect on it, so it must not
  // be reported as either a pass or a failure of the thing being tested.
  it("is inconclusive when HFP never came up at all", () => {
    const result = describeHfpStreamCheck({ beforeStreamStart: builtIn, afterStreamStart: builtIn });
    expect(result.outcome).toBe("inconclusive");
    expect(result.summary).toContain("never");
  });

  it("reports a sample-rate downgrade as a failure even when the port stays HFP", () => {
    const narrowband: RouteSnapshot = { ...hfp, sampleRate: 8000 };
    const result = describeHfpStreamCheck({ beforeStreamStart: hfp, afterStreamStart: narrowband });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("8000");
  });
});

describe("describePhoneCameraCheck", () => {
  it("passes when the route is untouched throughout", () => {
    const result = describePhoneCameraCheck({ before: hfp, during: hfp, after: hfp });
    expect(result.outcome).toBe("pass");
  });

  it("fails when the camera takes the route and it does not come back", () => {
    const result = describePhoneCameraCheck({ before: hfp, during: builtIn, after: builtIn });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("did not recover");
  });

  // Recovering is still a failure for a walkthrough: audio dropped for the duration of the
  // photo, which is exactly the evidence the estimator was narrating.
  it("fails when the route drops and recovers", () => {
    const result = describePhoneCameraCheck({ before: hfp, during: builtIn, after: hfp });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("recovered");
  });

  it("is inconclusive when HFP never came up at all", () => {
    const result = describePhoneCameraCheck({ before: builtIn, during: builtIn, after: builtIn });
    expect(result.outcome).toBe("inconclusive");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd mobile && npx jest src/wearables/__tests__/step0-verdicts.test.ts
```

Expected: FAIL — `Cannot find module '../step0-verdicts'`.

- [ ] **Step 3: Write the implementation**

Create `mobile/src/wearables/step0-verdicts.ts`:

```ts
/**
 * Verdicts for the Step 0 de-risk rungs.
 *
 * The native side reports raw route snapshots and decides nothing. All judgement lives here,
 * where it is pure and testable — the native bridge is not reachable from Jest, and the
 * reasoning is the part worth pinning down.
 */

export type RouteSnapshot = {
  portType: string;
  portName: string;
  sampleRate: number;
  isBluetoothHFP: boolean;
};

export type Outcome = "pass" | "fail" | "inconclusive";

export type Verdict = {
  outcome: Outcome;
  summary: string;
};

/** Wideband is what the ASR stage consumes; 8 kHz narrowband measurably hurts transcription. */
const WIDEBAND_HZ = 16_000;

export type HfpStreamCheck = {
  beforeStreamStart: RouteSnapshot;
  afterStreamStart: RouteSnapshot;
};

export function describeHfpStreamCheck(check: HfpStreamCheck): Verdict {
  const { beforeStreamStart: before, afterStreamStart: after } = check;

  if (!before.isBluetoothHFP) {
    return {
      outcome: "inconclusive",
      summary:
        `HFP never came up — the input was ${before.portName} before the stream even started. ` +
        `This says nothing about whether a DAT stream disturbs the route. Connect the glasses ` +
        `and retry.`,
    };
  }

  if (!after.isBluetoothHFP) {
    return {
      outcome: "fail",
      summary:
        `The DAT stream took the audio route. HFP was up (${before.portName}) before ` +
        `stream.start(), and the input became ${after.portName} after. Video and glasses audio ` +
        `cannot run together — fall back to audio + stills.`,
    };
  }

  if (after.sampleRate < WIDEBAND_HZ) {
    return {
      outcome: "fail",
      summary:
        `The route stayed HFP but dropped to ${after.sampleRate} Hz after stream.start() ` +
        `(was ${before.sampleRate} Hz). Below ${WIDEBAND_HZ} Hz the ASR stage measurably ` +
        `degrades, so this is not usable for a walkthrough.`,
    };
  }

  return {
    outcome: "pass",
    summary:
      `HFP survived the DAT stream at ${after.sampleRate} Hz on ${after.portName}. ` +
      `Video + audio + stills is viable; build the design as written.`,
  };
}

export type PhoneCameraCheck = {
  before: RouteSnapshot;
  during: RouteSnapshot;
  after: RouteSnapshot;
};

export function describePhoneCameraCheck(check: PhoneCameraCheck): Verdict {
  const { before, during, after } = check;

  if (!before.isBluetoothHFP) {
    return {
      outcome: "inconclusive",
      summary:
        `HFP never came up — the input was ${before.portName} before the camera opened. ` +
        `Connect the glasses and retry.`,
    };
  }

  if (!during.isBluetoothHFP && !after.isBluetoothHFP) {
    return {
      outcome: "fail",
      summary:
        `Opening the phone camera took the audio route and it did not recover — the input is ` +
        `still ${after.portName}. A phone still would end glasses audio for the rest of the walk.`,
    };
  }

  if (!during.isBluetoothHFP) {
    return {
      outcome: "fail",
      summary:
        `The phone camera took the audio route and it recovered afterwards, but audio dropped ` +
        `to ${during.portName} while the camera was open. That gap is exactly the narration the ` +
        `still was documenting, so it still has to be prevented.`,
    };
  }

  return {
    outcome: "pass",
    summary:
      `The phone camera did not disturb the HFP route (${after.portName}, ` +
      `${after.sampleRate} Hz). Phone stills during a glasses walk are safe.`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd mobile && npx jest src/wearables/__tests__/step0-verdicts.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/wearables/step0-verdicts.ts mobile/src/wearables/__tests__/step0-verdicts.test.ts
git commit -m "test(mobile): verdicts for the Step 0 audio-route checks"
```

---

## Task 2: Native — shared route snapshot helper

**Files:**
- Modify: `mobile/plugins/wearables-native/WearablesBridge.swift`

- [ ] **Step 1: Add the helper**

Add inside `final class WearablesBridge`, immediately after the existing
`private static func describe(_ error: Error) -> String` method:

```swift
  /// One audio-route reading, reported raw. Whether a reading is good or bad is decided in JS
  /// (`step0-verdicts.ts`), because that is the part that can be unit-tested.
  private static func routeSnapshot(_ session: AVAudioSession) -> [String: Any] {
    let input = session.currentRoute.inputs.first
    return [
      "portType": input?.portType.rawValue ?? "none",
      "portName": input?.portName ?? "none",
      "sampleRate": session.sampleRate,
      "isBluetoothHFP": input?.portType == .bluetoothHFP,
    ]
  }

  /// Bring up the HFP microphone route and wait for it to stabilize. Meta's guidance is explicit
  /// that the route "needs time to stabilize"; reading it immediately reports the built-in mic.
  private static func activateHfpAndSettle() async throws -> AVAudioSession {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothHFP])
    try session.setActive(true)
    let deadline = Date().addingTimeInterval(3)
    while !session.currentRoute.inputs.contains(where: { $0.portType == .bluetoothHFP }),
          Date() < deadline {
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    return session
  }
```

- [ ] **Step 2: Verify it compiles**

```bash
cd mobile && npx expo prebuild -p ios >/dev/null 2>&1 && \
  xcodebuild -workspace ios/TRockCam.xcworkspace -scheme TRockCam -configuration Debug \
  -destination generic/platform=iOS -allowProvisioningUpdates build 2>&1 \
  | grep -E "WearablesBridge.swift:[0-9]+:[0-9]+: (warning|error)|BUILD SUCCEEDED|BUILD FAILED"
```

Expected: `** BUILD SUCCEEDED **` with no `WearablesBridge.swift` warnings or errors.

- [ ] **Step 3: Commit**

```bash
git add mobile/plugins/wearables-native/WearablesBridge.swift
git commit -m "feat(mobile): route-snapshot helper for the Step 0 checks"
```

---

## Task 3: Native — rung 9, HFP under a DAT stream

> **IMPLEMENTED — one value below is SUPERSEDED. Do not re-apply verbatim.**
> Commit `56a9deeb9`, hardened in `9f3ef4549`.
>
> The code below reads the route `3_000_000_000` ns after `stream.start()`. Shipped code uses
> **`4_000_000_000`**. Measured first-frame latency on this hardware is 2.2–2.5s, so 3s left only
> a ~20% margin. Reading early would produce a spurious FAIL on a measurement that gates the
> whole capture architecture — wrongly pushing the design onto the audio-plus-stills fallback.

**Files:**
- Modify: `mobile/plugins/wearables-native/WearablesBridge.swift`
- Modify: `mobile/plugins/wearables-native/WearablesBridge.m`

- [ ] **Step 1: Add the method**

Add to `WearablesBridge.swift`, after the `diagnose` method:

```swift
  // MARK: - 9. Step 0 check: does HFP survive a DAT stream?

  /// Runs Meta's documented sequence exactly — addStream(), THEN configure HFP and let the route
  /// settle, THEN stream.start() — and reports the route either side of the start. The old code
  /// called addStream() and stream.start() back to back, which leaves no window for HFP at all.
  @objc(checkHfpWithStream:rejecter:)
  func checkHfpWithStream(_ resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard Self.configured else {
      reject("wearables_not_configured", "Call configure() first", nil)
      return
    }
    teardown()

    Task {
      let audio = AVAudioSession.sharedInstance()
      do {
        let sdk = Wearables.shared
        let selector = AutoDeviceSelector(wearables: sdk)
        var deadline = Date().addingTimeInterval(8)
        while selector.activeDevice == nil, Date() < deadline {
          try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard selector.activeDevice != nil else {
          reject("wearables_no_active_device", "No active device after 8s. Run rung 4b.", nil)
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
          teardown()
          reject("wearables_session_not_started", "Stalled in \(stalled) after 10s", nil)
          return
        }

        // Meta step 1: the stream exists but is NOT started.
        guard let newStream = try created.addStream() else {
          teardown()
          reject("wearables_stream_nil", "addStream() returned nil", nil)
          return
        }
        stream = newStream

        // Meta step 2: HFP comes up while the stream is still stopped.
        _ = try await Self.activateHfpAndSettle()
        let before = Self.routeSnapshot(audio)

        // Meta step 3: only now.
        newStream.start()
        // Three seconds is well past the 2.2-2.5s first-frame latency measured on this
        // hardware, so the route is read after frames are genuinely flowing.
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        let after = Self.routeSnapshot(audio)

        teardown()
        try? audio.setActive(false, options: .notifyOthersOnDeactivation)

        resolve(["beforeStreamStart": before, "afterStreamStart": after])
      } catch {
        teardown()
        try? audio.setActive(false, options: .notifyOthersOnDeactivation)
        reject("wearables_hfp_stream_check_failed",
               "checkHfpWithStream failed: \(Self.describe(error))", error)
      }
    }
  }
```

- [ ] **Step 2: Register it**

In `mobile/plugins/wearables-native/WearablesBridge.m`, add after the `diagnose` line:

```objc
RCT_EXTERN_METHOD(checkHfpWithStream : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)
```

- [ ] **Step 3: Verify it compiles**

```bash
cd mobile && npx expo prebuild -p ios >/dev/null 2>&1 && \
  xcodebuild -workspace ios/TRockCam.xcworkspace -scheme TRockCam -configuration Debug \
  -destination generic/platform=iOS -allowProvisioningUpdates build 2>&1 \
  | grep -E "WearablesBridge.swift:[0-9]+:[0-9]+: (warning|error)|BUILD SUCCEEDED|BUILD FAILED"
```

Expected: `** BUILD SUCCEEDED **`, no warnings in `WearablesBridge.swift`.

- [ ] **Step 4: Commit**

```bash
git add mobile/plugins/wearables-native/WearablesBridge.swift mobile/plugins/wearables-native/WearablesBridge.m
git commit -m "feat(mobile): rung 9 — does HFP survive a DAT stream"
```

---

## Task 4: Native — rung 10, phone camera during HFP

> **IMPLEMENTED — one value below is SUPERSEDED. Do not re-apply verbatim.**
> Commit `9f3ef4549`, fixed in `aa81b64bf`.
>
> The code below reads the `after` snapshot a fixed `1_000_000_000` ns after `stopRunning()`.
> Shipped code **polls up to 3s** for the HFP route to return, mirroring `activateHfpAndSettle`.
> A route lost on teardown can take a moment to renegotiate, and this file already budgets 3s for
> exactly that elsewhere — so a fixed 1s read can catch the route mid-transition and report a
> recovery failure that never happened. Polling does not mask a genuine loss: if HFP never comes
> back, the deadline expires and whatever the route actually is gets reported.
>
> The `during` read stays a fixed 2s deliberately. It samples the window while the camera is
> open; polling there would change what is measured rather than stabilise it.

**Files:**
- Modify: `mobile/plugins/wearables-native/WearablesBridge.swift`
- Modify: `mobile/plugins/wearables-native/WearablesBridge.m`

- [ ] **Step 1: Add the method**

Add to `WearablesBridge.swift` after `checkHfpWithStream`:

```swift
  // MARK: - 10. Step 0 check: does the phone camera disturb the HFP route?

  /// The design needs phone stills DURING a glasses walk, and both share one AVAudioSession.
  /// The capture session here is deliberately photo-output only with NO audio input — that is
  /// the configuration the real feature must use, so this tests the actual proposed code path
  /// rather than a worst case nobody would ship.
  @objc(checkPhoneCameraDuringHfp:rejecter:)
  func checkPhoneCameraDuringHfp(_ resolve: @escaping RCTPromiseResolveBlock,
                                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    Task {
      let audio = AVAudioSession.sharedInstance()
      do {
        _ = try await Self.activateHfpAndSettle()
        let before = Self.routeSnapshot(audio)

        let capture = AVCaptureSession()
        capture.sessionPreset = .photo
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else {
          try? audio.setActive(false, options: .notifyOthersOnDeactivation)
          reject("wearables_no_camera", "No video capture device available", nil)
          return
        }
        capture.beginConfiguration()
        if capture.canAddInput(input) { capture.addInput(input) }
        let photo = AVCapturePhotoOutput()
        if capture.canAddOutput(photo) { capture.addOutput(photo) }
        capture.commitConfiguration()

        capture.startRunning()
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        let during = Self.routeSnapshot(audio)

        capture.stopRunning()
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        let after = Self.routeSnapshot(audio)

        try? audio.setActive(false, options: .notifyOthersOnDeactivation)
        resolve(["before": before, "during": during, "after": after])
      } catch {
        try? audio.setActive(false, options: .notifyOthersOnDeactivation)
        reject("wearables_phone_camera_check_failed",
               "checkPhoneCameraDuringHfp failed: \(Self.describe(error))", error)
      }
    }
  }
```

- [ ] **Step 2: Register it**

In `mobile/plugins/wearables-native/WearablesBridge.m`, add after the `checkHfpWithStream` line:

```objc
RCT_EXTERN_METHOD(checkPhoneCameraDuringHfp : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)
```

- [ ] **Step 3: Verify it compiles**

```bash
cd mobile && npx expo prebuild -p ios >/dev/null 2>&1 && \
  xcodebuild -workspace ios/TRockCam.xcworkspace -scheme TRockCam -configuration Debug \
  -destination generic/platform=iOS -allowProvisioningUpdates build 2>&1 \
  | grep -E "WearablesBridge.swift:[0-9]+:[0-9]+: (warning|error)|BUILD SUCCEEDED|BUILD FAILED"
```

Expected: `** BUILD SUCCEEDED **`, no warnings in `WearablesBridge.swift`.

- [ ] **Step 4: Commit**

```bash
git add mobile/plugins/wearables-native/WearablesBridge.swift mobile/plugins/wearables-native/WearablesBridge.m
git commit -m "feat(mobile): rung 10 — does the phone camera disturb the HFP route"
```

---

## Task 5: TypeScript wrappers

**Files:**
- Modify: `mobile/src/wearables/native.ts`

- [ ] **Step 1: Add the types and wrappers**

In `mobile/src/wearables/native.ts`, add this import at the top, after the `react-native` import:

```ts
import type { HfpStreamCheck, PhoneCameraCheck } from "./step0-verdicts";
```

Add to the `WearablesNativeModule` type, after the `diagnose(): Promise<Diagnosis>;` line:

```ts
  checkHfpWithStream(): Promise<HfpStreamCheck>;
  checkPhoneCameraDuringHfp(): Promise<PhoneCameraCheck>;
```

Add to the exported `Wearables` object, after the `diagnose:` line:

```ts
  checkHfpWithStream: () => require_().checkHfpWithStream(),
  checkPhoneCameraDuringHfp: () => require_().checkPhoneCameraDuringHfp(),
```

- [ ] **Step 2: Verify typecheck passes**

```bash
cd mobile && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "wearables" || echo "wearables: CLEAN"
```

Expected: `wearables: CLEAN`. (Five pre-existing errors in
`app/(app)/scorecards/corrective-action/[id].tsx` are unrelated and must remain the only ones.)

- [ ] **Step 3: Commit**

```bash
git add mobile/src/wearables/native.ts
git commit -m "feat(mobile): typed wrappers for the Step 0 checks"
```

---

## Task 6: Wire rungs 9 and 10 into the diagnostic

**Files:**
- Modify: `mobile/app/(app)/dev-wearables.tsx`

- [ ] **Step 1: Add the imports**

Add to the existing import from `../../src/wearables/native`:

```ts
import {
  Wearables,
  isAvailable,
  onPhoto,
  type PhotoMeasurement,
} from "../../src/wearables/native";
import {
  describeHfpStreamCheck,
  describePhoneCameraCheck,
} from "../../src/wearables/step0-verdicts";
```

- [ ] **Step 2: Add the rungs**

In the `rungs` array, after the `stop` entry, add:

```ts
    {
      key: "hfpWithStream",
      label: "9  Step 0 — HFP under a DAT stream",
      run: async () => {
        const check = await Wearables.checkHfpWithStream();
        const verdict = describeHfpStreamCheck(check);
        return { verdict: verdict.outcome.toUpperCase(), summary: verdict.summary, ...check };
      },
      measurement: true,
    },
    {
      key: "phoneCamera",
      label: "10 Step 0 — phone camera during HFP",
      run: async () => {
        const check = await Wearables.checkPhoneCameraDuringHfp();
        const verdict = describePhoneCameraCheck(check);
        return { verdict: verdict.outcome.toUpperCase(), summary: verdict.summary, ...check };
      },
      measurement: true,
    },
```

- [ ] **Step 3: Verify typecheck and tests pass**

```bash
cd mobile && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "dev-wearables|wearables" || echo "CLEAN"
cd mobile && npm test
```

Expected: `CLEAN`, and `Test Suites: 52 passed`, `Tests: 633 passed` (624 existing + 9 new).

- [ ] **Step 4: Commit**

```bash
git add "mobile/app/(app)/dev-wearables.tsx"
git commit -m "feat(mobile): rungs 9 and 10 on the diagnostic ladder"
```

---

## Task 7: Hardware verification

No code. This is where the plan produces its actual output, and nothing below can be inferred
from a green test run.

**Preconditions:** iPhone in Developer Mode and connected; glasses powered, worn, paired over
Bluetooth **and** registered to the DAT SDK (rung 4 shows `deviceCount: 1`).

- [ ] **Step 1: Build and install**

```bash
cd mobile && npx expo run:ios --device 00008150-000A10512608401C
```

- [ ] **Step 2: Run the prerequisite rungs**

On device: Profile → Wearables diagnostic → run **1**, then **4b**.
Expected: rung 4b reports `linkState: connected`, `compatibility: compatible`,
`cameraPermission: granted`.

- [ ] **Step 3: Run rung 9 and record the result**

Expected shape:

```json
{
  "verdict": "PASS",
  "summary": "HFP survived the DAT stream at 16000 Hz on RB Meta 014K...",
  "beforeStreamStart": { "portType": "BluetoothHFP", "sampleRate": 16000, ... },
  "afterStreamStart":  { "portType": "BluetoothHFP", "sampleRate": 16000, ... }
}
```

- **PASS** → the design in the spec proceeds unchanged.
- **FAIL** → video and glasses audio cannot coexist. Capture falls back to audio + stills, and
  the `AVAssetWriter` muxing work is removed from the design before it is written.
- **INCONCLUSIVE** → the glasses were not on HFP to begin with; reconnect and rerun. Do not
  record an inconclusive run as either answer.

- [ ] **Step 4: Run rung 10 and record the result**

- **PASS** → phone stills during a walk are safe as designed.
- **FAIL** → the walk screen must suspend glasses audio around a phone still, or phone stills
  move out of the walk entirely. Either is a spec change, not an implementation detail.

- [ ] **Step 5: Write both results into the spec and the handoff**

Update `docs/superpowers/specs/2026-07-30-glasses-capture-design.md` — replace the "Step 0" section
with the measured outcomes — and add the same two numbers to
`~/Developer/trock-scope/docs/HANDOFF.md`.

```bash
git add docs/superpowers/specs/2026-07-30-glasses-capture-design.md
git commit -m "docs(mobile): Step 0 results — HFP under stream, phone camera during HFP"
```

---

## Definition of done

- [x] Unit tests pass — **19** new (not the 9 planned; review rounds added 10), suite at **643**
- [x] `BUILD SUCCEEDED` with no warnings in `WearablesBridge.swift`
- [x] Typecheck clean for every touched file (5 pre-existing errors in
      `scorecards/corrective-action/[id].tsx` remain the only ones, and are unrelated)
- [x] Rungs 9 and 10 **run on hardware** 2026-07-30 — **both PASS**, `BluetoothHFP` at 16000 Hz
      on every snapshot
- [x] The spec's Step 0 section states measured outcomes, not open questions

## What happens next

Once both verdicts are recorded, the remaining subsystems get their own plans, in this order:

1. `WalkthroughRecorder` + session state machine (shape depends on rung 9)
2. UI — Profile pairing, capture-mode selector, walk screen (phone-still handling depends on rung 10)
3. Upload-queue integration
4. trockcrm receive-and-forward to trock-scope
