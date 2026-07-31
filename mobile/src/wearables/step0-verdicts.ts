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
  /**
   * Frames observed during the post-`stream.start()` window. A stalled stream — addStream() and
   * start() called, but no video frame ever decoded — leaves nothing to disturb the route WITH,
   * so it reads identically to a stream that ran cleanly and truly didn't disturb it. Zero here
   * means the run cannot speak to the question this rung asks.
   */
  framesDelivered: number;
  /**
   * Seconds from `stream.start()` to the first frame. `null` when `framesDelivered` is 0 —
   * Swift sends `NSNull()` when no frame ever arrived.
   */
  firstFrameSeconds: number | null;
};

export function describeHfpStreamCheck(check: HfpStreamCheck): Verdict {
  const { beforeStreamStart: before, afterStreamStart: after, framesDelivered } = check;

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

  // The port held and the rate is wideband — but an undisturbed route proves nothing if the
  // stream itself never got going. This is placed last, immediately before the only remaining
  // return is "pass": a genuine route loss or rate drop above is real, observed evidence
  // regardless of frame count (something touched the mic even if no frame was ever decoded from
  // it), so those branches must still win over this one. Only the path that is about to become
  // "pass" needs gating — that is the specific false green frame counting was added to close.
  if (framesDelivered === 0) {
    return {
      outcome: "inconclusive",
      summary:
        `The stream delivered no frames in the observation window. No video meaningfully ran, ` +
        `so the route reading afterward (${after.portName}, ${after.sampleRate} Hz) says ` +
        `nothing about the route's ability to survive a DAT stream — a stalled stream and a ` +
        `clean one look identical here. Retry until frames are actually delivered.`,
    };
  }

  return {
    outcome: "pass",
    summary:
      `HFP survived the DAT stream at ${after.sampleRate} Hz on ${after.portName}, across ` +
      `${framesDelivered} delivered frame${framesDelivered === 1 ? "" : "s"}. Video + audio + ` +
      `stills is viable; build the design as written.`,
  };
}

export type PhoneCameraCheck = {
  before: RouteSnapshot;
  /** Route sampled ~2s into the preview, before the shutter fires. */
  during: RouteSnapshot;
  /** Route sampled while/just after the shutter fired — the point most likely to disturb the
   *  route, and the entire reason this field exists: `during` alone only proves the preview is
   *  safe, not that taking a still is. */
  duringCapture: RouteSnapshot;
  after: RouteSnapshot;
  /** False (including the timeout case) means the shutter never actually completed — see
   *  describePhoneCameraCheck for why that makes every route reading unusable as evidence. */
  capturePhotoSucceeded: boolean;
  capturePhotoTimedOut: boolean;
  capturePhotoError: string | null;
};

export function describePhoneCameraCheck(check: PhoneCameraCheck): Verdict {
  const {
    before,
    during,
    duringCapture,
    after,
    capturePhotoSucceeded,
    capturePhotoTimedOut,
    capturePhotoError,
  } = check;

  if (!before.isBluetoothHFP) {
    return {
      outcome: "inconclusive",
      summary:
        `HFP never came up — the input was ${before.portName} before the camera opened. ` +
        `Connect the glasses and retry.`,
    };
  }

  // Opening the camera and letting the preview run is not the claim this rung makes anymore —
  // taking a still is, because the shutter is where a route disturbance would most plausibly
  // happen. If the shutter itself never completed, none of the readings below can speak to that
  // claim no matter how clean they look, so this has to win over every branch that follows: a
  // failed or timed-out capture with a coincidentally undisturbed route must not report "pass"
  // for a claim the run never actually tested.
  if (!capturePhotoSucceeded) {
    const reason = capturePhotoTimedOut
      ? "the shutter timed out before AVCapturePhotoOutput finished"
      : `the shutter failed (${capturePhotoError ?? "unknown error"})`;
    return {
      outcome: "inconclusive",
      summary:
        `The camera opened but ${reason} — the shutter never completed, so this run cannot say ` +
        `whether taking a still disturbs the HFP route. Opening the camera is not the claim ` +
        `that matters; the shutter is. Retry.`,
    };
  }

  // From here the shutter genuinely fired. `during` is the pre-shutter preview reading;
  // `duringCapture` is the shutter itself. Either one losing the port counts as "the camera
  // disturbed the route" — duringCapture is named specifically when IT is the point of loss,
  // since a preview that read clean while the shutter itself dropped the route is exactly the
  // false green this field was added to close.
  const duringLost = !during.isBluetoothHFP;
  const captureLost = !duringCapture.isBluetoothHFP;
  const portLostWhileCameraOpen = duringLost || captureLost;
  const disturbedAt = captureLost ? duringCapture : during;
  const disturbedDuringShutterSpecifically = captureLost && !duringLost;

  if (portLostWhileCameraOpen && !after.isBluetoothHFP) {
    return {
      outcome: "fail",
      summary: disturbedDuringShutterSpecifically
        ? `Firing the shutter took the audio route and it did not recover — the input is still ` +
          `${after.portName}. A phone still would end glasses audio for the rest of the walk.`
        : `Opening the phone camera took the audio route and it did not recover — the input is ` +
          `still ${after.portName}. A phone still would end glasses audio for the rest of the walk.`,
    };
  }

  if (portLostWhileCameraOpen) {
    // The route was lost at some point while the camera was open and came back by `after`.
    // Whether "afterward" is a real recovery depends on after's rate too — claiming "recovered"
    // when after is still narrowband would repeat the exact overstatement this module exists to
    // prevent.
    const whereLost = disturbedDuringShutterSpecifically ? "while the shutter fired" : "while the camera was open";
    if (after.sampleRate < WIDEBAND_HZ) {
      return {
        outcome: "fail",
        summary:
          `The phone camera took the audio route, and the route that came back is still only ` +
          `${after.sampleRate} Hz — audio dropped to ${disturbedAt.portName} ${whereLost} and ` +
          `never returned to wideband. That gap is exactly the narration the still was ` +
          `documenting, so it still has to be prevented.`,
      };
    }
    return {
      outcome: "fail",
      summary:
        `The phone camera took the audio route and it recovered afterwards, but audio dropped ` +
        `to ${disturbedAt.portName} ${whereLost}. That gap is exactly the narration the still ` +
        `was documenting, so it still has to be prevented.`,
    };
  }

  if (!after.isBluetoothHFP) {
    return {
      outcome: "fail",
      summary:
        `The audio route stayed HFP through the preview and the shutter (${duringCapture.portName}, ` +
        `${duringCapture.sampleRate} Hz) but was lost once it closed — the input is now ` +
        `${after.portName}. A Bluetooth renegotiation on camera teardown would end glasses ` +
        `audio for the rest of the walk, so this still has to be prevented.`,
    };
  }

  // Below this point before, during, duringCapture, and after all report the HFP port — the
  // port question is settled for the whole camera lifecycle, shutter included. If the baseline
  // itself never reached wideband, though, there is no reliable comparison point for the rate
  // question: reporting a clean pass here would claim the shutter doesn't degrade the rate when
  // the run never actually measured that.
  if (before.sampleRate < WIDEBAND_HZ) {
    return {
      outcome: "inconclusive",
      summary:
        `HFP was already narrowband before the camera opened (${before.sampleRate} Hz). The ` +
        `port question is answered — it held through the shutter and after — but the rate ` +
        `question is not: there is no wideband baseline to compare against. Reconnect at ` +
        `wideband and retry to check the rate question.`,
    };
  }

  const duringWideband = during.sampleRate >= WIDEBAND_HZ;
  const captureWideband = duringCapture.sampleRate >= WIDEBAND_HZ;
  const afterWideband = after.sampleRate >= WIDEBAND_HZ;
  // Both the preview and the shutter reading have to be wideband for the "camera open" period to
  // count as clean. Same naming preference as the port check above: point at duringCapture's
  // rate specifically when IT is the one that dropped, since a shutter-specific narrowband dip —
  // not a preview dip — is the case this field exists to catch.
  const openWideband = duringWideband && captureWideband;
  const worstDuringSnapshot = !captureWideband ? duringCapture : during;
  const whereNarrow = !captureWideband ? "during the shutter" : "while the camera was open";

  if (!openWideband && !afterWideband) {
    return {
      outcome: "fail",
      summary:
        `The route stayed HFP throughout, but the rate dropped to ` +
        `${worstDuringSnapshot.sampleRate} Hz ${whereNarrow} and is still only ` +
        `${after.sampleRate} Hz afterward — it never recovered to wideband. Below ` +
        `${WIDEBAND_HZ} Hz the ASR stage measurably degrades, so this is not usable for a ` +
        `walkthrough.`,
    };
  }

  if (!openWideband) {
    return {
      outcome: "fail",
      summary:
        `The route stayed HFP but the rate dropped to ${worstDuringSnapshot.sampleRate} Hz ` +
        `${whereNarrow}, then recovered to ${after.sampleRate} Hz afterward. That gap is ` +
        `exactly the narration the still was documenting, so it still has to be prevented.`,
    };
  }

  if (!afterWideband) {
    return {
      outcome: "fail",
      summary:
        `The route stayed HFP through the phone camera and the shutter but is at ` +
        `${after.sampleRate} Hz afterwards (was ${duringCapture.sampleRate} Hz during the ` +
        `photo). Below ${WIDEBAND_HZ} Hz the ASR stage measurably degrades, so this is not ` +
        `usable for a walkthrough.`,
    };
  }

  return {
    outcome: "pass",
    summary:
      `The shutter did not disturb the HFP route (${duringCapture.portName}, ` +
      `${duringCapture.sampleRate} Hz), and it held afterward too (${after.portName}, ` +
      `${after.sampleRate} Hz). Phone stills during a glasses walk are safe.`,
  };
}
