import {
  describeHfpStreamCheck,
  describePhoneCameraCheck,
  type HfpStreamCheck,
  type PhoneCameraCheck,
  type RouteSnapshot,
} from "../step0-verdicts";

const hfp: RouteSnapshot = {
  portType: "BluetoothHFP",
  portName: "RB Meta 014K",
  sampleRate: 16000,
  isBluetoothHFP: true,
};

const narrowbandHfp: RouteSnapshot = { ...hfp, sampleRate: 8000 };

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

// A clean run: frames flowed, the shutter completed. Individual tests override just the fields
// they care about, so each test's intent stays visible instead of drowning in boilerplate.
const cleanStreamCheck: HfpStreamCheck = {
  beforeStreamStart: hfp,
  afterStreamStart: hfp,
  framesDelivered: 42,
  firstFrameSeconds: 2.3,
};

const cleanCameraCheck: PhoneCameraCheck = {
  before: hfp,
  during: hfp,
  duringCapture: hfp,
  after: hfp,
  capturePhotoSucceeded: true,
  capturePhotoTimedOut: false,
  capturePhotoError: null,
  capturePreventedAudioSessionReconfiguration: true,
};

describe("describeHfpStreamCheck", () => {
  it("passes when HFP is up before the stream, survives it, and frames were delivered", () => {
    const result = describeHfpStreamCheck(cleanStreamCheck);
    expect(result.outcome).toBe("pass");
    expect(result.summary).toContain("survived");
  });

  it("fails when the stream takes the route away", () => {
    const result = describeHfpStreamCheck({ ...cleanStreamCheck, afterStreamStart: builtIn });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("iPhone Microphone");
  });

  it("fails when the route is lost entirely", () => {
    const result = describeHfpStreamCheck({ ...cleanStreamCheck, afterStreamStart: none });
    expect(result.outcome).toBe("fail");
  });

  // A run where HFP never came up says nothing about the STREAM's effect on it, so it must not
  // be reported as either a pass or a failure of the thing being tested.
  it("is inconclusive when HFP never came up at all", () => {
    const result = describeHfpStreamCheck({
      ...cleanStreamCheck,
      beforeStreamStart: builtIn,
      afterStreamStart: builtIn,
    });
    expect(result.outcome).toBe("inconclusive");
    expect(result.summary).toContain("never");
  });

  it("reports a sample-rate downgrade as a failure even when the port stays HFP", () => {
    const result = describeHfpStreamCheck({ ...cleanStreamCheck, afterStreamStart: narrowbandHfp });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("8000");
  });

  // If the pairing never reached wideband, before and after read the same narrowband rate.
  // The summary must not claim a drop occurred, and must not blame the DAT stream for a
  // limitation that predates it.
  it("fails without claiming a drop when the route was narrowband before the stream too", () => {
    const result = describeHfpStreamCheck({
      ...cleanStreamCheck,
      beforeStreamStart: narrowbandHfp,
      afterStreamStart: narrowbandHfp,
    });
    expect(result.outcome).toBe("fail");
    expect(result.summary).not.toContain("dropped");
    expect(result.summary).toContain("8000");
  });

  // THE new bug: a stalled stream (addStream()/start() called, but no video frame ever decoded)
  // leaves the route trivially undisturbed. Before frame counting, that undisturbed reading was
  // reported as "pass" — a stream that never ran was indistinguishable from one that ran clean.
  // Zero frames must never resolve to pass, because the run proves nothing about the question
  // this rung asks.
  it("is inconclusive when the stream delivers zero frames, even with an undisturbed route", () => {
    const result = describeHfpStreamCheck({
      ...cleanStreamCheck,
      framesDelivered: 0,
      firstFrameSeconds: null,
    });
    expect(result.outcome).toBe("inconclusive");
    expect(result.summary).toContain("delivered no frames");
    expect(result.summary).toContain("says nothing");
  });

  // The zero-frames branch is placed LAST, immediately before the "pass" return — not first.
  // A route that was genuinely lost, or genuinely degraded, is real observed evidence regardless
  // of whether any frame was ever decoded (the OS-level route negotiation can be disturbed by
  // addStream()/start() even if decoding never produces a frame). Collapsing that real evidence
  // into "inconclusive" just because frames == 0 would throw away a true fail and understate the
  // problem — these two tests pin the ordering down.
  it("still fails on route loss even when the stream delivered zero frames", () => {
    const result = describeHfpStreamCheck({
      ...cleanStreamCheck,
      afterStreamStart: builtIn,
      framesDelivered: 0,
      firstFrameSeconds: null,
    });
    expect(result.outcome).toBe("fail");
  });

  it("still fails on a rate downgrade even when the stream delivered zero frames", () => {
    const result = describeHfpStreamCheck({
      ...cleanStreamCheck,
      afterStreamStart: narrowbandHfp,
      framesDelivered: 0,
      firstFrameSeconds: null,
    });
    expect(result.outcome).toBe("fail");
  });
});

describe("describePhoneCameraCheck", () => {
  it("passes when the route is untouched throughout, including the shutter", () => {
    const result = describePhoneCameraCheck(cleanCameraCheck);
    expect(result.outcome).toBe("pass");
  });

  // A payload from a native build predating the flag omits the field entirely. That is the case
  // the enumeration below cannot reach (it only varies true/false), and it is the one that
  // actually happens: an old app on a phone, run against this JS.
  it("is inconclusive when the payload does not report the audio-session flag at all", () => {
    const { capturePreventedAudioSessionReconfiguration: _omitted, ...withoutFlag } =
      cleanCameraCheck;
    const result = describePhoneCameraCheck(withoutFlag);
    expect(result.outcome).toBe("inconclusive");
    expect(result.summary).toContain("automaticallyConfiguresApplicationAudioSession");
  });

  // The gate must not be readable as "only a pass needs attribution". A route that was visibly
  // destroyed while AVFoundation was free to re-pick the mic still names no cause, so reporting
  // it as a fail would push the design onto the fallback for a reason nobody established.
  it("is inconclusive rather than fail when the route is lost but the flag was not set", () => {
    const result = describePhoneCameraCheck({
      ...cleanCameraCheck,
      capturePreventedAudioSessionReconfiguration: false,
      during: builtIn,
      duringCapture: builtIn,
      after: builtIn,
    });
    expect(result.outcome).toBe("inconclusive");
  });

  it("names the flag as the reason the shipped configuration matters, in the pass summary", () => {
    const result = describePhoneCameraCheck(cleanCameraCheck);
    expect(result.outcome).toBe("pass");
    expect(result.summary).toContain("automaticallyConfiguresApplicationAudioSession = false");
  });

  it("fails when the camera takes the route and it does not come back", () => {
    const result = describePhoneCameraCheck({
      ...cleanCameraCheck,
      during: builtIn,
      duringCapture: builtIn,
      after: builtIn,
    });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("did not recover");
  });

  // Recovering is still a failure for a walkthrough: audio dropped for the duration of the
  // photo, which is exactly the evidence the estimator was narrating.
  it("fails when the route drops and recovers", () => {
    const result = describePhoneCameraCheck({
      ...cleanCameraCheck,
      during: builtIn,
      duringCapture: builtIn,
      after: hfp,
    });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("recovered");
  });

  it("is inconclusive when HFP never came up at all", () => {
    const result = describePhoneCameraCheck({
      ...cleanCameraCheck,
      before: builtIn,
      during: builtIn,
      duringCapture: builtIn,
      after: builtIn,
    });
    expect(result.outcome).toBe("inconclusive");
  });

  // A Bluetooth renegotiation on stopRunning() teardown can drop the route only after the
  // camera closes, even though it survived the camera being open (preview AND shutter). This is
  // exactly why the check takes four snapshots instead of two — collapsing it to a pass would be
  // a false green.
  it("fails when the route survives the camera being open but is lost once it closes", () => {
    const result = describePhoneCameraCheck({ ...cleanCameraCheck, after: builtIn });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("lost once it closed");
  });

  it("fails when the port stays HFP after the camera closes but the rate is narrowband", () => {
    const result = describePhoneCameraCheck({ ...cleanCameraCheck, after: narrowbandHfp });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("8000");
  });

  // The rate can collapse to narrowband for exactly the window the photo was open, on the same
  // HFP port, then recover. The "recovered" branch's own principle — a mid-check gap is still
  // the evidence being tested for — applies identically to a rate dip as to a port dip.
  it("fails when the rate drops during the photo on the same port and recovers after", () => {
    const result = describePhoneCameraCheck({
      ...cleanCameraCheck,
      during: narrowbandHfp,
      duringCapture: narrowbandHfp,
    });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("8000");
  });

  // A narrowband baseline makes the rate dimension unmeasurable: this run cannot say whether the
  // camera degrades the rate, since the pairing was already narrowband before the camera opened.
  it("is inconclusive when the baseline itself was already narrowband", () => {
    const result = describePhoneCameraCheck({
      ...cleanCameraCheck,
      before: narrowbandHfp,
      during: narrowbandHfp,
      duringCapture: narrowbandHfp,
      after: narrowbandHfp,
    });
    expect(result.outcome).toBe("inconclusive");
  });

  // The baseline-narrowband inconclusive fires on `before` alone — not because during/duringCapture
  // /after also happen to be narrowband. A pairing that never proved it can do wideband is
  // unmeasurable even if this particular run reads clean throughout.
  it("is inconclusive on a narrowband baseline even when the rest of the run reads wideband", () => {
    const result = describePhoneCameraCheck({ ...cleanCameraCheck, before: narrowbandHfp });
    expect(result.outcome).toBe("inconclusive");
  });

  // A genuine route loss is conclusive regardless of what rate the baseline started at — it must
  // not be masked by the narrowband-baseline inconclusive check.
  it("still fails on route loss even when the baseline was narrowband", () => {
    const result = describePhoneCameraCheck({
      ...cleanCameraCheck,
      before: narrowbandHfp,
      during: builtIn,
      duringCapture: builtIn,
      after: builtIn,
    });
    expect(result.outcome).toBe("fail");
  });

  // A route lost entirely during the photo and recovered only to a narrowband rate afterward is
  // not a real recovery. The summary must not claim "recovered" for a still-degraded result.
  it("does not claim recovery when the route is lost during and comes back narrowband", () => {
    const result = describePhoneCameraCheck({
      ...cleanCameraCheck,
      during: builtIn,
      duringCapture: builtIn,
      after: narrowbandHfp,
    });
    expect(result.outcome).toBe("fail");
    expect(result.summary).not.toContain("recovered");
    expect(result.summary).toContain("8000");
  });

  // The route can be present but narrowband during the photo, then lost entirely once the camera
  // closes. The summary should surface the degraded rate rather than implying it was fine.
  it("surfaces the degraded during-rate when the route is then lost after the camera closes", () => {
    const result = describePhoneCameraCheck({
      ...cleanCameraCheck,
      during: narrowbandHfp,
      duringCapture: narrowbandHfp,
      after: builtIn,
    });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("8000");
    expect(result.summary).toContain("lost once it closed");
  });

  // If the rate drops during the photo and never comes back — still narrowband afterward too —
  // the summary must say so plainly rather than reusing "recovered" wording.
  it("reports no recovery when the rate is narrowband both during and after", () => {
    const afterNarrow: RouteSnapshot = { ...hfp, sampleRate: 9000 };
    const result = describePhoneCameraCheck({
      ...cleanCameraCheck,
      during: narrowbandHfp,
      duringCapture: narrowbandHfp,
      after: afterNarrow,
    });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("never recovered");
  });

  // --- The shutter-specific branches: duringCapture must carry the same rigor as during. ---

  // THE new bug: the old rung opened the capture session and never fired the shutter, so it only
  // proved "opening the camera is safe" — a different, weaker claim than "taking a still is
  // safe". If the shutter never completed (error or timeout), no route reading can answer the
  // real question, and the check must say so instead of passing on a technicality.
  it("is inconclusive when the shutter times out, even with an otherwise clean route", () => {
    const result = describePhoneCameraCheck({
      ...cleanCameraCheck,
      capturePhotoSucceeded: false,
      capturePreventedAudioSessionReconfiguration: true,
      capturePhotoTimedOut: true,
      capturePhotoError: null,
    });
    expect(result.outcome).toBe("inconclusive");
    expect(result.summary).toContain("timed out");
  });

  it("is inconclusive when the shutter errors, even with an otherwise clean route", () => {
    const result = describePhoneCameraCheck({
      ...cleanCameraCheck,
      capturePhotoSucceeded: false,
      capturePreventedAudioSessionReconfiguration: true,
      capturePhotoTimedOut: false,
      capturePhotoError: "AVFoundation error -11800",
    });
    expect(result.outcome).toBe("inconclusive");
    expect(result.summary).toContain("AVFoundation error -11800");
  });

  it("never reports pass when the shutter did not succeed", () => {
    const result = describePhoneCameraCheck({
      ...cleanCameraCheck,
      capturePhotoSucceeded: false,
      capturePreventedAudioSessionReconfiguration: true,
      capturePhotoTimedOut: true,
      capturePhotoError: null,
    });
    expect(result.outcome).not.toBe("pass");
  });

  // The preview (during) can read perfectly clean while the shutter itself (duringCapture) takes
  // the route and it comes back afterward. This is the specific false green duringCapture exists
  // to catch: `during` alone would have reported "pass" here.
  it("fails when the shutter itself takes the route and it recovers afterward", () => {
    const result = describePhoneCameraCheck({ ...cleanCameraCheck, duringCapture: builtIn });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("shutter");
    expect(result.summary).toContain("recovered");
  });

  it("fails when the shutter itself takes the route and it does not recover", () => {
    const result = describePhoneCameraCheck({
      ...cleanCameraCheck,
      duringCapture: builtIn,
      after: builtIn,
    });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("shutter");
    expect(result.summary).toContain("did not recover");
  });

  // Same as above but for the rate rather than the port: the shutter narrows the route to
  // narrowband on the SAME port, and it recovers by `after`. `during` and `after` both read
  // wideband, so only examining those two would report "pass" — duringCapture's own rate has to
  // be checked with the same rigor as during's.
  it("fails when the rate narrows specifically during the shutter and recovers after", () => {
    const result = describePhoneCameraCheck({ ...cleanCameraCheck, duringCapture: narrowbandHfp });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("shutter");
    expect(result.summary).toContain("8000");
  });

  it("passes only when duringCapture is also wideband HFP, not just during and after", () => {
    // during dips instead of duringCapture — still a real disturbance, still must not pass, even
    // though duringCapture (the shutter) itself was clean.
    const result = describePhoneCameraCheck({ ...cleanCameraCheck, during: narrowbandHfp });
    expect(result.outcome).toBe("fail");
  });
});

// ---------------------------------------------------------------------------------------------
// State-space enumeration
//
// Review previously found six false-green paths in this file: cases that reported "pass" while
// the input didn't support it. Hand-picked examples are not enough to rule out a seventh — this
// exhaustively crosses every RouteSnapshot slot over {HFP-wideband, HFP-narrowband, non-HFP} with
// the new flags, and asserts the one invariant that must never break: "pass" is returned only
// when every input actually supports "pass". Everything else (why a given combination is "fail"
// vs "inconclusive") is covered by the named tests above; this net is purely about false greens.
// ---------------------------------------------------------------------------------------------

type PortLevel = "wideband" | "narrowband" | "none";

const LEVELS: Record<PortLevel, RouteSnapshot> = {
  wideband: hfp,
  narrowband: narrowbandHfp,
  none: builtIn,
};

const ALL_LEVELS = Object.keys(LEVELS) as PortLevel[];

describe("describeHfpStreamCheck — state-space enumeration", () => {
  for (const beforeLevel of ALL_LEVELS) {
    for (const afterLevel of ALL_LEVELS) {
      for (const framesDelivered of [0, 7]) {
        const label = `before=${beforeLevel} after=${afterLevel} frames=${framesDelivered}`;
        it(`never overstates pass — ${label}`, () => {
          const check: HfpStreamCheck = {
            beforeStreamStart: LEVELS[beforeLevel],
            afterStreamStart: LEVELS[afterLevel],
            framesDelivered,
            firstFrameSeconds: framesDelivered > 0 ? 2.0 : null,
          };
          const result = describeHfpStreamCheck(check);

          // Note: unlike describePhoneCameraCheck, this check has no "baseline was narrowband"
          // gate — pre-existing, out of scope here. `after` wideband with frames flowing is a
          // legitimate pass regardless of `before`'s rate: the claim is "the route is usable
          // right now", not "the stream improved on the baseline".
          const supportsPass =
            beforeLevel !== "none" && afterLevel === "wideband" && framesDelivered > 0;

          if (!supportsPass) {
            expect(result.outcome).not.toBe("pass");
          } else {
            expect(result.outcome).toBe("pass");
          }

          // before non-HFP is always the most fundamental precondition failure: never pass or
          // fail, only inconclusive, regardless of every other input.
          if (beforeLevel === "none") {
            expect(result.outcome).toBe("inconclusive");
          }
        });
      }
    }
  }
});

describe("describePhoneCameraCheck — state-space enumeration", () => {
  for (const beforeLevel of ALL_LEVELS) {
    for (const duringLevel of ALL_LEVELS) {
      for (const duringCaptureLevel of ALL_LEVELS) {
        for (const afterLevel of ALL_LEVELS) {
          for (const capturePhotoSucceeded of [true, false]) {
          for (const preventedReconfig of [true, false]) {
            const label =
              `before=${beforeLevel} during=${duringLevel} duringCapture=${duringCaptureLevel} ` +
              `after=${afterLevel} captured=${capturePhotoSucceeded} ` +
              `noAutoAudioCfg=${preventedReconfig}`;
            it(`never overstates pass — ${label}`, () => {
              const check: PhoneCameraCheck = {
                before: LEVELS[beforeLevel],
                during: LEVELS[duringLevel],
                duringCapture: LEVELS[duringCaptureLevel],
                after: LEVELS[afterLevel],
                capturePhotoSucceeded,
                capturePhotoTimedOut: !capturePhotoSucceeded,
                capturePhotoError: null,
                capturePreventedAudioSessionReconfiguration: preventedReconfig,
              };
              const result = describePhoneCameraCheck(check);

              const supportsPass =
                beforeLevel === "wideband" &&
                duringLevel === "wideband" &&
                duringCaptureLevel === "wideband" &&
                afterLevel === "wideband" &&
                capturePhotoSucceeded &&
                preventedReconfig;

              if (!supportsPass) {
                expect(result.outcome).not.toBe("pass");
              } else {
                expect(result.outcome).toBe("pass");
              }

              // Two preconditions are each independently sufficient to force inconclusive,
              // regardless of what every other snapshot says: HFP never being up in the first
              // place, and the shutter never actually completing.
              if (beforeLevel === "none") {
                expect(result.outcome).toBe("inconclusive");
              } else if (!capturePhotoSucceeded) {
                expect(result.outcome).toBe("inconclusive");
              } else if (!preventedReconfig) {
                // A route reading taken while AVFoundation could re-pick the microphone names no
                // cause, so it cannot support a fail either — not just a pass.
                expect(result.outcome).toBe("inconclusive");
              }
            });
          }
          }
        }
      }
    }
  }
});
