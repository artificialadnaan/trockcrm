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

  if (!after.isBluetoothHFP) {
    return {
      outcome: "fail",
      summary:
        `The audio route survived the camera being open but was lost once it closed — the ` +
        `input was ${during.portName} during the photo and is now ${after.portName}. A ` +
        `Bluetooth renegotiation on camera teardown would end glasses audio for the rest of the ` +
        `walk, so this still has to be prevented.`,
    };
  }

  if (after.sampleRate < WIDEBAND_HZ) {
    return {
      outcome: "fail",
      summary:
        `The route stayed HFP through the phone camera but is at ${after.sampleRate} Hz ` +
        `afterwards (was ${during.sampleRate} Hz during the photo). Below ${WIDEBAND_HZ} Hz ` +
        `the ASR stage measurably degrades, so this is not usable for a walkthrough.`,
    };
  }

  return {
    outcome: "pass",
    summary:
      `The phone camera did not disturb the HFP route (${after.portName}, ` +
      `${after.sampleRate} Hz). Phone stills during a glasses walk are safe.`,
  };
}
