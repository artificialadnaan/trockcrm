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
    const summary =
      before.sampleRate >= WIDEBAND_HZ
        ? `The route stayed HFP but dropped to ${after.sampleRate} Hz after stream.start() ` +
          `(was ${before.sampleRate} Hz). Below ${WIDEBAND_HZ} Hz the ASR stage measurably ` +
          `degrades, so this is not usable for a walkthrough.`
        : `The route is HFP but negotiated ${after.sampleRate} Hz after stream.start(), and was ` +
          `already sub-wideband before it (${before.sampleRate} Hz) — this pairing never ` +
          `reached wideband HFP, so the DAT stream is not the cause. Below ${WIDEBAND_HZ} Hz ` +
          `the ASR stage measurably degrades, so this is not usable for a walkthrough.`;
    return { outcome: "fail", summary };
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
  /** Whether the shutter actually completed. The native side reports it; see the guard below for why
   *  the route snapshots mean nothing without it. Optional so an older payload is INCONCLUSIVE rather
   *  than silently treated as a success. */
  photoCaptured?: boolean;
  /** The delegate's error, or "none". Reported so a failure can name itself. */
  photoError?: string;
  /** Whether a narration recorder was running across the shutter, and whether it was still running
   *  afterwards. Route health is silent about this: a shutter can stop a recorder while `currentRoute`
   *  stays on HFP throughout, and the walkthrough narrates continuously. */
  narrationStarted?: boolean;
  narrationSurvivedShutter?: boolean;
};

export function describePhoneCameraCheck(check: PhoneCameraCheck): Verdict {
  const { before, during, after, photoCaptured, photoError, narrationStarted, narrationSurvivedShutter } =
    check;

  // NO SHUTTER, NO VERDICT — checked FIRST, before any route reasoning.
  //
  // The native side takes a real photo now precisely because opening the camera is not the operation
  // this rung is about. But three healthy route snapshots around a capture that never completed say
  // only that nothing happened — and "nothing happened" reaching the pass branch is exactly the false
  // PASS that adding the capture was meant to remove. The evidence was being collected and thrown
  // away, which is worse than not collecting it: it makes the verdict look better sourced than it is.
  //
  // INCONCLUSIVE rather than FAIL: a shutter that timed out or errored is a fact about this run, not
  // evidence that phone stills disturb the route. Calling it a failure would push the design onto the
  // fallback for a reason nobody has established.
  if (photoCaptured !== true) {
    const reason =
      photoError && photoError !== "none"
        ? `the capture failed (${photoError})`
        : photoCaptured === false
          ? "the capture never completed within the timeout"
          : "this build's native side did not report a capture outcome";
    return {
      outcome: "inconclusive",
      summary:
        `No still was successfully captured, so the route snapshots prove nothing — ${reason}. ` +
        `Opening the camera is not what this rung tests; the shutter is. Investigate the capture ` +
        `itself before reading anything into the audio route.`,
    };
  }

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
    // The route was lost entirely while the camera was open. Whether "afterward" is a real
    // recovery depends on after's rate too — claiming "recovered" when after is still
    // narrowband would repeat the exact overstatement this module exists to prevent.
    if (after.sampleRate < WIDEBAND_HZ) {
      return {
        outcome: "fail",
        summary:
          `The phone camera took the audio route entirely, and the route that came back is ` +
          `still only ${after.sampleRate} Hz — audio dropped to ${during.portName} while the ` +
          `camera was open and never returned to wideband. That gap is exactly the narration ` +
          `the still was documenting, so it still has to be prevented.`,
      };
    }
    return {
      outcome: "fail",
      summary:
        `The phone camera took the audio route and it recovered afterwards, but audio dropped ` +
        `to ${during.portName} while the camera was open. That gap is exactly the narration the ` +
        `still was documenting, so it still has to be prevented.`,
    };
  }

  if (!after.isBluetoothHFP) {
    return {
      outcome: "fail",
      summary:
        `The audio route stayed HFP while the camera was open (${during.portName}, ` +
        `${during.sampleRate} Hz) but was lost once it closed — the input is now ` +
        `${after.portName}. A Bluetooth renegotiation on camera teardown would end glasses ` +
        `audio for the rest of the walk, so this still has to be prevented.`,
    };
  }

  // Below this point before, during, and after all report the HFP port — the port question is
  // settled. If the baseline itself never reached wideband, though, there is no reliable
  // comparison point for the rate question: reporting a clean pass here would claim the camera
  // doesn't degrade the rate when the run never actually measured that.
  if (before.sampleRate < WIDEBAND_HZ) {
    return {
      outcome: "inconclusive",
      summary:
        `HFP was already narrowband before the camera opened (${before.sampleRate} Hz). The ` +
        `port question is answered — it held through the camera and after — but the rate ` +
        `question is not: there is no wideband baseline to compare against. Reconnect at ` +
        `wideband and retry to check the rate question.`,
    };
  }

  const duringWideband = during.sampleRate >= WIDEBAND_HZ;
  const afterWideband = after.sampleRate >= WIDEBAND_HZ;

  if (!duringWideband && !afterWideband) {
    return {
      outcome: "fail",
      summary:
        `The route stayed HFP throughout, but the rate dropped to ${during.sampleRate} Hz ` +
        `while the camera was open and is still only ${after.sampleRate} Hz afterward — it ` +
        `never recovered to wideband. Below ${WIDEBAND_HZ} Hz the ASR stage measurably ` +
        `degrades, so this is not usable for a walkthrough.`,
    };
  }

  if (!duringWideband) {
    return {
      outcome: "fail",
      summary:
        `The route stayed HFP but the rate dropped to ${during.sampleRate} Hz while the camera ` +
        `was open, then recovered to ${after.sampleRate} Hz afterward. That gap is exactly the ` +
        `narration the still was documenting, so it still has to be prevented.`,
    };
  }

  if (!afterWideband) {
    return {
      outcome: "fail",
      summary:
        `The route stayed HFP through the phone camera but is at ${after.sampleRate} Hz ` +
        `afterwards (was ${during.sampleRate} Hz during the photo). Below ${WIDEBAND_HZ} Hz ` +
        `the ASR stage measurably degrades, so this is not usable for a walkthrough.`,
    };
  }

  // THE ROUTE IS ONLY HALF THE QUESTION. A shutter can stop an active recorder while `currentRoute`
  // stays on HFP the whole way through — AVFoundation reconfigures the capture graph, and the route is
  // not what notices. Every check above would pass on that run while the narration for the moment the
  // photo documents is simply missing, which is the same false PASS as before wearing different
  // clothes.
  if (narrationStarted === true && narrationSurvivedShutter === false) {
    return {
      outcome: "fail",
      summary:
        `The HFP route was untouched (${after.portName}, ${after.sampleRate} Hz) but the SHUTTER ` +
        `STOPPED THE RECORDER — narration was running before the capture and had stopped by the ` +
        `time it finished. Route health did not show this, and it is the narration explaining the ` +
        `photo that is lost. Phone stills during a glasses walk are not safe as designed.`,
    };
  }

  if (narrationStarted !== true) {
    return {
      outcome: "inconclusive",
      summary:
        `The phone camera did not disturb the HFP route (${after.portName}, ` +
        `${after.sampleRate} Hz), but no narration recorder was running across the shutter, so ` +
        `only half the question was measured. A shutter can stop a recorder without touching the ` +
        `route. Re-run on a build that records during the capture before relying on this.`,
    };
  }

  return {
    outcome: "pass",
    summary:
      `The phone camera did not disturb the HFP route (${after.portName}, ` +
      `${after.sampleRate} Hz), and narration kept running across the shutter. Phone stills ` +
      `during a glasses walk are safe.`,
  };
}
