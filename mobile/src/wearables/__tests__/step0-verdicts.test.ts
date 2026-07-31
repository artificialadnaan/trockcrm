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

  // A Bluetooth renegotiation on stopRunning() teardown can drop the route only after the
  // camera closes, even though it survived the camera being open. This is exactly why the
  // check takes three snapshots instead of two — collapsing it to a pass would be a false
  // green.
  it("fails when the route survives the camera being open but is lost once it closes", () => {
    const result = describePhoneCameraCheck({ before: hfp, during: hfp, after: builtIn });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("lost once it closed");
  });

  it("fails when the port stays HFP after the camera closes but the rate is narrowband", () => {
    const narrowband: RouteSnapshot = { ...hfp, sampleRate: 8000 };
    const result = describePhoneCameraCheck({ before: hfp, during: hfp, after: narrowband });
    expect(result.outcome).toBe("fail");
    expect(result.summary).toContain("8000");
  });
});
