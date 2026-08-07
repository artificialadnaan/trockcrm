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

  // If the pairing never reached wideband, before and after read the same narrowband rate.
  // The summary must not claim a drop occurred, and must not blame the DAT stream for a
  // limitation that predates it.
  it("fails without claiming a drop when the route was narrowband before the stream too", () => {
    const narrowband: RouteSnapshot = { ...hfp, sampleRate: 8000 };
    const result = describeHfpStreamCheck({
      beforeStreamStart: narrowband,
      afterStreamStart: narrowband,
    });
    expect(result.outcome).toBe("fail");
    expect(result.summary).not.toContain("dropped");
    expect(result.summary).toContain("8000");
  });
});

describe("describePhoneCameraCheck", () => {
  // THE SHUTTER GATES THE VERDICT. Three healthy route snapshots around a capture that never
  // completed say only that nothing happened — and "nothing happened" reaching the pass branch is
  // exactly the false PASS that taking a real photo was added to remove. The native side reports the
  // outcome; discarding it made the verdict look better sourced than it was.
  it("is INCONCLUSIVE when the shutter never completed, however healthy the route looks", () => {
    const result = describePhoneCameraCheck({
      before: hfp,
      during: hfp,
      after: hfp,
      photoCaptured: false,
      photoError: "none",
    });
    expect(result.outcome).toBe("inconclusive");
    expect(result.summary).toContain("never completed");
  });

  it("is INCONCLUSIVE and names the error when the capture failed", () => {
    const result = describePhoneCameraCheck({
      before: hfp,
      during: hfp,
      after: hfp,
      photoCaptured: false,
      photoError: "AVFoundationErrorDomain -11800",
    });
    expect(result.outcome).toBe("inconclusive");
    expect(result.summary).toContain("AVFoundationErrorDomain -11800");
  });

  it("is INCONCLUSIVE for a payload with no capture outcome at all", () => {
    // An older native build. Absent evidence is not evidence of success — the alternative would read a
    // missing field as a pass, which is how a stale app silently validates a design.
    const result = describePhoneCameraCheck({ before: hfp, during: hfp, after: hfp });
    expect(result.outcome).toBe("inconclusive");
    expect(result.summary).toContain("did not report a capture outcome");
  });

  it("passes when the route is untouched throughout", () => {
    const result = describePhoneCameraCheck({ before: hfp, during: hfp, after: hfp, photoCaptured: true, narrationStarted: true, narrationSurvivedShutter: true });
    expect(result.outcome).toBe("pass");
  });

  it("fails when the camera takes the route and it does not come back", () => {
    const result = describePhoneCameraCheck({ before: hfp, during: builtIn, after: builtIn, photoCaptured: true, narrationStarted: true, narrationSurvivedShutter: true });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("did not recover");
  });

  // Recovering is still a failure for a walkthrough: audio dropped for the duration of the
  // photo, which is exactly the evidence the estimator was narrating.
  it("fails when the route drops and recovers", () => {
    const result = describePhoneCameraCheck({ before: hfp, during: builtIn, after: hfp, photoCaptured: true, narrationStarted: true, narrationSurvivedShutter: true });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("recovered");
  });

  it("is inconclusive when HFP never came up at all", () => {
    const result = describePhoneCameraCheck({ before: builtIn, during: builtIn, after: builtIn, photoCaptured: true, narrationStarted: true, narrationSurvivedShutter: true });
    expect(result.outcome).toBe("inconclusive");
  });

  // A Bluetooth renegotiation on stopRunning() teardown can drop the route only after the
  // camera closes, even though it survived the camera being open. This is exactly why the
  // check takes three snapshots instead of two — collapsing it to a pass would be a false
  // green.
  it("fails when the route survives the camera being open but is lost once it closes", () => {
    const result = describePhoneCameraCheck({ before: hfp, during: hfp, after: builtIn, photoCaptured: true, narrationStarted: true, narrationSurvivedShutter: true });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("lost once it closed");
  });

  it("fails when the port stays HFP after the camera closes but the rate is narrowband", () => {
    const narrowband: RouteSnapshot = { ...hfp, sampleRate: 8000 };
    const result = describePhoneCameraCheck({ before: hfp, during: hfp, after: narrowband, photoCaptured: true, narrationStarted: true, narrationSurvivedShutter: true });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("8000");
  });

  // The rate can collapse to narrowband for exactly the window the photo was open, on the same
  // HFP port, then recover. The "recovered" branch's own principle — a mid-check gap is still
  // the evidence being tested for — applies identically to a rate dip as to a port dip.
  it("fails when the rate drops during the photo on the same port and recovers after", () => {
    const narrowband: RouteSnapshot = { ...hfp, sampleRate: 8000 };
    const result = describePhoneCameraCheck({ before: hfp, during: narrowband, after: hfp, photoCaptured: true, narrationStarted: true, narrationSurvivedShutter: true });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("8000");
  });

  // A narrowband baseline makes the rate dimension unmeasurable: this run cannot say whether the
  // camera degrades the rate, since the pairing was already narrowband before the camera opened.
  it("is inconclusive when the baseline itself was already narrowband", () => {
    const narrowband: RouteSnapshot = { ...hfp, sampleRate: 8000 };
    const result = describePhoneCameraCheck({
      before: narrowband,
      during: narrowband,
      after: narrowband,
    });
    expect(result.outcome).toBe("inconclusive");
  });

  // The baseline-narrowband inconclusive fires on `before` alone — not because during/after also
  // happen to be narrowband. A pairing that never proved it can do wideband is unmeasurable even
  // if this particular run reads clean throughout.
  it("is inconclusive on a narrowband baseline even when during and after read wideband", () => {
    const narrowband: RouteSnapshot = { ...hfp, sampleRate: 8000 };
    const result = describePhoneCameraCheck({ before: narrowband, during: hfp, after: hfp, photoCaptured: true, narrationStarted: true, narrationSurvivedShutter: true });
    expect(result.outcome).toBe("inconclusive");
  });

  // A genuine route loss is conclusive regardless of what rate the baseline started at — it must
  // not be masked by the narrowband-baseline inconclusive check.
  it("still fails on route loss even when the baseline was narrowband", () => {
    const narrowband: RouteSnapshot = { ...hfp, sampleRate: 8000 };
    const result = describePhoneCameraCheck({ before: narrowband, during: builtIn, after: builtIn, photoCaptured: true, narrationStarted: true, narrationSurvivedShutter: true });
    expect(result.outcome).toBe("fail");
  });

  // A route lost entirely during the photo and recovered only to a narrowband rate afterward is
  // not a real recovery. The summary must not claim "recovered" for a still-degraded result.
  it("does not claim recovery when the route is lost during and comes back narrowband", () => {
    const narrowbandAfter: RouteSnapshot = { ...hfp, sampleRate: 8000 };
    const result = describePhoneCameraCheck({ before: hfp, during: builtIn, after: narrowbandAfter, photoCaptured: true, narrationStarted: true, narrationSurvivedShutter: true });
    expect(result.outcome).toBe("fail");
    expect(result.summary).not.toContain("recovered");
    expect(result.summary).toContain("8000");
  });

  // The route can be present but narrowband during the photo, then lost entirely once the camera
  // closes. The summary should surface during's degraded rate rather than implying it was fine.
  it("surfaces the degraded during-rate when the route is then lost after the camera closes", () => {
    const narrowbandDuring: RouteSnapshot = { ...hfp, sampleRate: 8000 };
    const result = describePhoneCameraCheck({ before: hfp, during: narrowbandDuring, after: builtIn, photoCaptured: true, narrationStarted: true, narrationSurvivedShutter: true });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("8000");
    expect(result.summary).toContain("lost once it closed");
  });

  // If the rate drops during the photo and never comes back — still narrowband afterward too —
  // the summary must say so plainly rather than reusing "recovered" wording.
  it("reports no recovery when the rate is narrowband both during and after", () => {
    const duringNarrow: RouteSnapshot = { ...hfp, sampleRate: 8000 };
    const afterNarrow: RouteSnapshot = { ...hfp, sampleRate: 9000 };
    const result = describePhoneCameraCheck({ before: hfp, during: duringNarrow, after: afterNarrow, photoCaptured: true, narrationStarted: true, narrationSurvivedShutter: true });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("never recovered");
  });
});
