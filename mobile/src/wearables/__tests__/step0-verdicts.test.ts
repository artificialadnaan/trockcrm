import {
  describeHfpStreamCheck,
  describePhoneCameraCheck,
  describeStreamEndurance,
  type HfpStreamCheck,
  type PhoneCameraCheck,
  type RouteSnapshot,
  type StreamEnduranceCheck,
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

// ---------------------------------------------------------------------------------------------
// Rung 11 — endurance WITHOUT audio
//
// The premise is the measurement: "no audio session was anywhere". Native used to assert that with
// a hard-coded `false` — a statement about its own source, not about the run — while the dev screen
// leaves every other RUN button live throughout the 60-second window, so another rung activating
// HFP was one tap away the whole time. Now it reports what it observed, and the two conclusions
// this rung can otherwise reach point in OPPOSITE directions ("HFP is the difference" /
// "HFP is not the cause"), so a run with audio in force must reach neither.
// ---------------------------------------------------------------------------------------------

const sustainedRun: StreamEnduranceCheck = {
  secondsObserved: 60,
  totalFrames: 1_780,
  secondsToLastFrame: 59.4,
  audioSessionUsed: false,
};

const diedRun: StreamEnduranceCheck = {
  secondsObserved: 60,
  totalFrames: 152,
  secondsToLastFrame: 5.2,
  audioSessionUsed: false,
};

const noFramesRun: StreamEnduranceCheck = {
  secondsObserved: 60,
  totalFrames: 0,
  secondsToLastFrame: -1,
  audioSessionUsed: false,
};

describe("describeStreamEndurance", () => {
  it("reports SUSTAINED when frames ran to the end of a genuinely audio-free window", () => {
    const result = describeStreamEndurance(sustainedRun);
    expect(result).toContain("SUSTAINED for the full 60s");
    expect(result).toContain("HFP is the difference");
  });

  it("reports STOPPED, with the second it died, when delivery ended early", () => {
    const result = describeStreamEndurance(diedRun);
    expect(result).toContain("STOPPED at 5.2s of 60s");
    expect(result).toContain("HFP is not the cause");
  });

  it("says nothing about endurance when the stream never delivered a frame", () => {
    expect(describeStreamEndurance(noFramesRun)).toContain("NO FRAMES AT ALL");
  });

  // The one this module was changed for. A 60s run that sustained is the result that concludes
  // "HFP is the difference, capture becomes audio + stills" — the sentence the capture design is
  // built on. If HFP was actually up for that run, it is not evidence of anything.
  it("refuses to conclude anything when an audio session was in force, however the frames went", () => {
    const sustained = describeStreamEndurance({ ...sustainedRun, audioSessionUsed: true });
    expect(sustained).toContain("INCONCLUSIVE");
    expect(sustained).not.toContain("SUSTAINED");
    expect(sustained).not.toContain("HFP is the difference");

    const died = describeStreamEndurance({ ...diedRun, audioSessionUsed: true });
    expect(died).toContain("INCONCLUSIVE");
    expect(died).not.toContain("STOPPED");
    expect(died).not.toContain("HFP is not the cause");

    const noFrames = describeStreamEndurance({ ...noFramesRun, audioSessionUsed: true });
    expect(noFrames).toContain("INCONCLUSIVE");
    expect(noFrames).not.toContain("NO FRAMES AT ALL");
  });

  // GREPTILE, on 61d2b76e0. The native side derived `audioSessionUsed` from an end-of-window owner
  // LEVEL, and a level cannot see a share that was taken and given back inside the window: rung 8
  // records for ten seconds inside this rung's sixty, so the count is back to zero by the time it is
  // read. The run reports itself audio-free and resolves a definitive SUSTAINED — off a window that
  // had HFP up for a sixth of its length. That verdict picks the walkthrough capture architecture.
  //
  // Native now spans the window with three readings. This re-derives from those components rather
  // than trusting the summary boolean, because NOTHING compiles that Swift — not CI, not locally —
  // so a wrong `audioSessionUsed` ships unnoticed, and it already has twice (first a hard-coded
  // `false`, then the level). This assertion is the only check on it that runs anywhere.
  it("refuses to conclude when a share was taken and RELEASED inside the window", () => {
    // Exactly Greptile's case: both edges read zero, and only the edge counter saw it.
    const contaminated = describeStreamEndurance({
      ...sustainedRun,
      audioSessionUsed: false, // what the old level-based native would have reported
      audioOwnersAtStart: 0,
      audioOwnersAtEnd: 0,
      audioActivationsDuringWindow: 1,
    });
    expect(contaminated).toContain("INCONCLUSIVE");
    expect(contaminated).not.toContain("SUSTAINED");
    expect(contaminated).not.toContain("HFP is the difference");
  });

  it("refuses to conclude when a share was already held as the window OPENED", () => {
    // The other blind spot of an end-only read: an owner that lets go partway through.
    const contaminated = describeStreamEndurance({
      ...diedRun,
      audioSessionUsed: false,
      audioOwnersAtStart: 1,
      audioOwnersAtEnd: 0,
      audioActivationsDuringWindow: 0,
    });
    expect(contaminated).toContain("INCONCLUSIVE");
    expect(contaminated).not.toContain("STOPPED");
  });

  it("still concludes when every component reading says the window was genuinely clean", () => {
    // The guard must not swallow the real result — a reported ZERO is a measurement, not an absence.
    const clean = describeStreamEndurance({
      ...sustainedRun,
      audioSessionUsed: false,
      audioOwnersAtStart: 0,
      audioOwnersAtEnd: 0,
      audioActivationsDuringWindow: 0,
    });
    expect(clean).toContain("SUSTAINED");
    expect(clean).not.toContain("INCONCLUSIVE");
  });

  // A dev client built before native measured this reports every other field and not that one.
  // Absent is "not observed", which must not manufacture an inconclusive any more than the old
  // hard-coded `false` should have manufactured a pass.
  it("reads an absent audio reading as unobserved rather than as a session being in force", () => {
    const { audioSessionUsed: _omitted, ...withoutReading } = sustainedRun;
    expect(describeStreamEndurance(withoutReading)).toContain("SUSTAINED for the full 60s");
  });

  it("does not treat a false audio reading as an audio session", () => {
    expect(describeStreamEndurance({ ...diedRun, audioSessionUsed: false })).toContain("STOPPED");
  });
});

describe("describeStreamEndurance — state-space enumeration", () => {
  // `expected` is WRITTEN DOWN per shape, not recomputed from `secondsObserved - 3`. Deriving it
  // from the same expression the function uses would make every row agree with whatever the
  // function does — widening the tolerance to 30s passed a first draft of this table unchanged.
  // The two rows either side of 57.0 are here for exactly that: they pin the boundary itself.
  const FRAME_SHAPES: Array<{ label: string; frames: number; last: number; expected: string }> = [
    { label: "sustained", frames: 1_780, last: 59.4, expected: "HFP is the difference" },
    { label: "died-early", frames: 152, last: 5.2, expected: "HFP is not the cause" },
    { label: "last-frame-exactly-at-3s-short", frames: 900, last: 57, expected: "HFP is the difference" },
    { label: "last-frame-a-tenth-past-3s-short", frames: 890, last: 56.9, expected: "HFP is not the cause" },
    { label: "no-frames", frames: 0, last: -1, expected: "NO FRAMES AT ALL" },
  ];
  const AUDIO_READINGS: Array<{ label: string; value: boolean | undefined }> = [
    { label: "audio-in-force", value: true },
    { label: "audio-clear", value: false },
    { label: "audio-unobserved", value: undefined },
  ];

  for (const shape of FRAME_SHAPES) {
    for (const audio of AUDIO_READINGS) {
      it(`never claims an HFP conclusion it cannot support — ${shape.label} ${audio.label}`, () => {
        const check: StreamEnduranceCheck = {
          secondsObserved: 60,
          totalFrames: shape.frames,
          secondsToLastFrame: shape.last,
          ...(audio.value === undefined ? {} : { audioSessionUsed: audio.value }),
        };
        const result = describeStreamEndurance(check);

        // Both HFP conclusions are claims about a window with no audio session in it. Neither may
        // be reached from a run that had one — and this is the assertion, not the INCONCLUSIVE
        // string, because the string is cosmetic and these two sentences are what get acted on.
        if (audio.value === true) {
          expect(result).not.toContain("HFP is the difference");
          expect(result).not.toContain("HFP is not the cause");
          expect(result).toContain("INCONCLUSIVE");
        } else {
          expect(result).not.toContain("INCONCLUSIVE");
          // Frame counts still decide, unchanged by this gate.
          expect(result).toContain(shape.expected);
        }
      });
    }
  }
});
