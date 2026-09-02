import {
  assessAudioCoverage,
  assessVideoCoverage,
  initialWalk,
  isAudioRestartExhausted,
  isAudioTruncated,
  isVideoTruncated,
  meterFractionForRms,
  reduceWalk,
  canCapture,
  canAcceptStill,
  canCaptureMore,
  isWalkActive,
  artifactCount,
  assessWalkVideoSize,
  MAX_WALK_ARTIFACT_BYTES,
  MAX_WALK_ARTIFACTS,
  WALK_VIDEO_STOP_BYTES,
  WALK_VIDEO_WARN_BYTES,
  WALK_AUDIO_RESTART_ATTEMPTS,
  WALK_AUDIO_SHORTFALL_TOLERANCE_MS,
  WALK_VIDEO_SHORTFALL_TOLERANCE_MS,
  type Walk,
} from "../session";

const started: Walk = reduceWalk(
  reduceWalk(initialWalk("deal-1", "proj-7"), { type: "starting" }),
  { type: "started", at: 1000, videoUri: "file:///docs/walk/video.mp4" }
);

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

  // capturePhoto() is asynchronous: a still requested just before "end walk" can resolve after
  // the reducer has already moved to "finalizing". Native keeps its photo listener alive through
  // finalization and writes the JPEG to disk regardless — rejecting the event here wouldn't stop
  // the capture, it would only orphan the file (present on disk, absent from the manifest).
  it("accepts a still that arrives while finalizing (native is still draining them)", () => {
    const ended = reduceWalk(started, { type: "ended", at: 5000 });
    expect(ended.state).toBe("finalizing");
    const late = reduceWalk(ended, {
      type: "still",
      uri: "file:///docs/walk/late.jpg",
      at: 6000,
      source: "glasses",
    });
    expect(artifactCount(late)).toBe(1);
    expect(late.stills[0]!.uri).toBe("file:///docs/walk/late.jpg");
  });

  // Once the walk is genuinely TERMINAL — handed to the uploader (complete) or failed — a still
  // has nowhere to go. Unlike "finalizing", native is not draining anything at this point.
  it("ignores a still that arrives after the walk is complete", () => {
    const done = reduceWalk(reduceWalk(started, { type: "ended", at: 5000 }), {
      type: "finalized",
      audioUri: null,
    });
    const late = reduceWalk(done, {
      type: "still",
      uri: "file:///docs/walk/late.jpg",
      at: 6000,
      source: "glasses",
    });
    expect(artifactCount(late)).toBe(0);
  });

  it("ignores a still that arrives after the walk failed", () => {
    const failed = reduceWalk(started, { type: "failed", reason: "boom" });
    const late = reduceWalk(failed, {
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

  it("is inert once failed", () => {
    const failed = reduceWalk(started, { type: "failed", reason: "boom" });
    expect(reduceWalk(failed, { type: "ended", at: 9000 })).toBe(failed);
  });

  // A "started" that arrives without the app having initiated one is a spurious native event.
  // Accepting it would put the walk into "recording" with no directory, no recorder and no
  // audio route — reporting capture that is not happening.
  it("ignores a started event when no walk was initiated", () => {
    const walk = reduceWalk(initialWalk("deal-1", null), {
      type: "started",
      at: 1000,
      videoUri: null,
    });
    expect(walk.state).toBe("idle");
  });

  // The one event allowed to escape TERMINAL absorption. walk.tsx is a hidden Tabs.Screen that
  // never unmounts, so without this a completed/failed walk would sit here forever, its terminal
  // state absorbing every future "starting" event — the second-walk-can-never-start bug.
  it("a reset event snaps a COMPLETE walk back to fresh idle for a new target, discarding everything", () => {
    const withStill = reduceWalk(started, {
      type: "still",
      uri: "file:///s.jpg",
      at: 2000,
      source: "glasses",
    });
    const done = reduceWalk(reduceWalk(withStill, { type: "ended", at: 5000 }), {
      type: "finalized",
      audioUri: null,
    });
    expect(done.state).toBe("complete");

    const reset = reduceWalk(done, { type: "reset", dealId: "deal-2", projectId: "proj-9" });
    expect(reset).toEqual(initialWalk("deal-2", "proj-9"));
  });

  it("a reset event also escapes a FAILED walk, not just complete", () => {
    const failed = reduceWalk(started, { type: "failed", reason: "glasses disconnected" });
    const reset = reduceWalk(failed, { type: "reset", dealId: "deal-2", projectId: null });
    expect(reset).toEqual(initialWalk("deal-2", null));
  });

  // Superseded by isWalkActive's guard below: a reset is refused for ANY active walk, even one
  // whose target (dealId/projectId) hasn't actually changed — see WalkEvent's "reset" doc for why
  // "the same identity" is not a safe case to special-case back in. Kept as a named regression
  // test in its own right, not just folded into the isWalkActive describe block below, because
  // this is the exact case a naive "only refuse when the identity is DIFFERENT" fix would miss.
  it("a reset event on a walk that never reached a terminal state is refused, even for the SAME target", () => {
    const reset = reduceWalk(started, { type: "reset", dealId: "deal-1", projectId: "proj-7" });
    expect(reset).toBe(started);
  });

  // The bug this closes: an identity change (switching deals mid-walk) used to reset
  // UNCONDITIONALLY, discarding an ACTIVE recording — native keeps running regardless of what
  // this reducer does, so the estimator's next "start" would tear down that orphaned native
  // session with nothing captured for it. A reset while starting/recording/finalizing must be a
  // genuine no-op: the walk keeps running, still attached to the deal it actually started
  // against, not the one the reset event was asking to switch to.
  it("refuses to reset a RECORDING walk even when the reset targets a DIFFERENT deal — the walk keeps running under its original one", () => {
    const withStill = reduceWalk(started, {
      type: "still",
      uri: "file:///s.jpg",
      at: 2000,
      source: "glasses",
    });
    const attempted = reduceWalk(withStill, { type: "reset", dealId: "deal-2", projectId: "proj-9" });
    expect(attempted).toBe(withStill); // same reference: a genuine no-op, not just equal-by-value
    expect(attempted.state).toBe("recording");
    expect(attempted.dealId).toBe("deal-1");
    expect(artifactCount(attempted)).toBe(1);
  });

  it("refuses to reset a STARTING walk", () => {
    const starting = reduceWalk(initialWalk("deal-1", null), { type: "starting" });
    const attempted = reduceWalk(starting, { type: "reset", dealId: "deal-2", projectId: null });
    expect(attempted).toBe(starting);
  });

  it("refuses to reset a FINALIZING walk", () => {
    const finalizing = reduceWalk(started, { type: "ended", at: 5000 });
    expect(finalizing.state).toBe("finalizing");
    const attempted = reduceWalk(finalizing, { type: "reset", dealId: "deal-2", projectId: null });
    expect(attempted).toBe(finalizing);
  });
});

describe("isWalkActive", () => {
  it("is true only for starting/recording/finalizing — the states where native has a real recording session in flight", () => {
    expect(isWalkActive(initialWalk("d", null).state)).toBe(false); // idle
    expect(isWalkActive("starting")).toBe(true);
    expect(isWalkActive("recording")).toBe(true);
    expect(isWalkActive("finalizing")).toBe(true);
    expect(isWalkActive("complete")).toBe(false);
    expect(isWalkActive("failed")).toBe(false);
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

describe("canAcceptStill", () => {
  it("is true while recording OR finalizing, unlike canCapture", () => {
    expect(canAcceptStill(started)).toBe(true);
    const finalizing = reduceWalk(started, { type: "ended", at: 5000 });
    expect(finalizing.state).toBe("finalizing");
    expect(canAcceptStill(finalizing)).toBe(true);
    expect(canCapture(finalizing)).toBe(false); // the state gate for NEW requests stays false
  });

  it("is false before recording starts and once the walk is terminal", () => {
    expect(canAcceptStill(initialWalk("d", null))).toBe(false);
    expect(canAcceptStill(reduceWalk(initialWalk("d", null), { type: "starting" }))).toBe(false);
    const done = reduceWalk(reduceWalk(started, { type: "ended", at: 5000 }), {
      type: "finalized",
      audioUri: null,
    });
    expect(canAcceptStill(done)).toBe(false);
    const failed = reduceWalk(started, { type: "failed", reason: "boom" });
    expect(canAcceptStill(failed)).toBe(false);
  });
});

describe("canCaptureMore", () => {
  it("is false whenever canCapture is false, regardless of the artifact count", () => {
    expect(canCaptureMore(initialWalk("d", null))).toBe(false);
    const finalizing = reduceWalk(started, { type: "ended", at: 5000 });
    expect(canCaptureMore(finalizing)).toBe(false);
  });

  // Every walk that reached "recording" always carries a video artifact, and native now writes
  // narration.m4a beside it — which this reducer only learns of at "finalized", so a slot is held
  // for it throughout — so the effective still cap is MAX_WALK_ARTIFACTS - 2. Capturing right up
  // to that boundary must still be allowed; the very next one (which would push the total to
  // MAX_WALK_ARTIFACTS + 1) must not be.
  it("is false exactly when capturing again would push the walk's total artifacts past the server's cap", () => {
    let walk = started;
    for (let i = 0; i < MAX_WALK_ARTIFACTS - 3; i++) {
      walk = reduceWalk(walk, {
        type: "still",
        uri: `file:///s${i}.jpg`,
        at: 1000 + i,
        source: "phone",
      });
    }
    expect(walk.stills.length).toBe(MAX_WALK_ARTIFACTS - 3);
    // One more still fits: stills (MAX-2) + video (1) + narration (1) === MAX_WALK_ARTIFACTS.
    expect(canCaptureMore(walk)).toBe(true);

    const atCap = reduceWalk(walk, {
      type: "still",
      uri: "file:///cap.jpg",
      at: 9999,
      source: "phone",
    });
    expect(atCap.stills.length).toBe(MAX_WALK_ARTIFACTS - 2);
    // Capturing again now would make stills (MAX-1) + video (1) + narration (1) === MAX + 1.
    expect(canCaptureMore(atCap)).toBe(false);
  });

  // `reserved` accounts for capture requests already ACCEPTED by native but not yet delivered as
  // a `still` event — useWalk.ts's in-flight tracker. Without it, a DELIVERED-only count lets two
  // requests issued back-to-back both look safe, because neither photo has landed in
  // `walk.stills` yet when the second one is checked.
  it("also refuses once DELIVERED stills plus `reserved` in-flight requests would push the total past the cap", () => {
    let walk = started;
    for (let i = 0; i < MAX_WALK_ARTIFACTS - 4; i++) {
      walk = reduceWalk(walk, {
        type: "still",
        uri: `file:///s${i}.jpg`,
        at: 1000 + i,
        source: "phone",
      });
    }
    expect(walk.stills.length).toBe(MAX_WALK_ARTIFACTS - 4);
    // Two slots remain (stills + video + narration === MAX_WALK_ARTIFACTS - 2): with nothing in
    // flight, a capture is fine.
    expect(canCaptureMore(walk, 0)).toBe(true);
    // With ONE request already accepted but not yet delivered, one more still fits exactly.
    expect(canCaptureMore(walk, 1)).toBe(true);
    // With TWO already in flight, a third would make stills(MAX-4) + reserved(2) + new(1) +
    // video(1) + narration(1) === MAX_WALK_ARTIFACTS + 1 — over the cap, even though NOT ONE of
    // those two in-flight requests has actually landed in `walk.stills` yet.
    expect(canCaptureMore(walk, 2)).toBe(false);
  });
});

// ── Video coverage (FINDING 1) ────────────────────────────────────────────────────────────────────
//
// The arithmetic lives here rather than in useWalk so it is testable without a bridge, and so the
// one number the whole judgement turns on — WALK_VIDEO_SHORTFALL_TOLERANCE_MS — has exactly one
// definition that both the reducer and the screen read.
describe("assessVideoCoverage", () => {
  const healthy = { secondsSinceLastFrameArrived: 0.033, videoFramesAppended: 36_000 };

  it("reads the quiet tail as the part of the walk with no video", () => {
    const coverage = assessVideoCoverage(20 * 60 * 1000, {
      secondsSinceLastFrameArrived: 1_195,
      videoFramesAppended: 150,
    });
    expect(coverage.walkMs).toBe(20 * 60 * 1000);
    expect(coverage.videoMs).toBe(5_000);
    expect(coverage.shortfallMs).toBe(1_195_000);
  });

  it("reports a healthy walk as fully covered, give or take a frame interval", () => {
    const coverage = assessVideoCoverage(20 * 60 * 1000, healthy);
    expect(coverage.shortfallMs).toBe(33);
    expect(isVideoTruncated(coverage)).toBe(false);
  });

  // native's `-1` means `lastFrameArrivedAt` was never valid — NO frame ever arrived. Arithmetic
  // that treats it as a duration turns the worst possible walk into the best-looking one.
  // A NaN tail is the QUIET failure, not the loud one: `< 0` is false for NaN, so it slips past the
  // sentinel check, propagates through every clamp, and makes isVideoTruncated compare NaN against
  // the tolerance — which is false. The warning would disappear on exactly the walk nobody could
  // measure. assessAudioCoverage already guards its own counter the same way.
  it("treats a non-finite tail as zero coverage rather than letting NaN silence the warning", () => {
    const coverage = assessVideoCoverage(600_000, {
      secondsSinceLastFrameArrived: Number.NaN,
      videoFramesAppended: 900,
    });
    expect(coverage.videoMs).toBe(0);
    expect(coverage.shortfallMs).toBe(600_000);
    expect(isVideoTruncated(coverage)).toBe(true);
  });

  it("treats the -1 'no frame ever arrived' sentinel as zero coverage", () => {
    const coverage = assessVideoCoverage(600_000, {
      secondsSinceLastFrameArrived: -1,
      videoFramesAppended: 0,
    });
    expect(coverage.videoMs).toBe(0);
    expect(coverage.shortfallMs).toBe(600_000);
  });

  // Belt-and-suspenders against a census that says frames were still arriving while the video
  // track holds nothing: the quiet tail alone would call that walk healthy.
  it("treats zero appended frames as zero coverage even when frames were still arriving", () => {
    const coverage = assessVideoCoverage(600_000, {
      secondsSinceLastFrameArrived: 0.02,
      videoFramesAppended: 0,
    });
    expect(coverage.videoMs).toBe(0);
    expect(isVideoTruncated(coverage)).toBe(true);
  });

  // The census is snapshotted a bridge hop AFTER `endedAt` is stamped in JS, so the quiet tail can
  // measure very slightly longer than the walk itself. Coverage must never go negative.
  it("never reports more missing video than there was walk", () => {
    const coverage = assessVideoCoverage(4_000, {
      secondsSinceLastFrameArrived: 4.2,
      videoFramesAppended: 120,
    });
    expect(coverage.shortfallMs).toBe(4_000);
    expect(coverage.videoMs).toBe(0);
  });
});

describe("isVideoTruncated", () => {
  it("is false when coverage was never measured", () => {
    expect(isVideoTruncated(null)).toBe(false);
  });

  it("sits exactly at the tolerance boundary", () => {
    const walkMs = 60_000;
    const at = (shortfallMs: number) => ({
      walkMs,
      videoMs: walkMs - shortfallMs,
      shortfallMs,
    });
    expect(isVideoTruncated(at(WALK_VIDEO_SHORTFALL_TOLERANCE_MS))).toBe(false);
    expect(isVideoTruncated(at(WALK_VIDEO_SHORTFALL_TOLERANCE_MS + 1))).toBe(true);
  });
});

describe("reduceWalk video coverage", () => {
  const ended = reduceWalk(started, { type: "ended", at: 1000 + 20 * 60 * 1000 });

  it("records coverage on the walk when finalized carries a census", () => {
    const done = reduceWalk(ended, {
      type: "finalized",
      audioUri: null,
      videoUri: "file:///docs/walk/walk.mp4",
      videoCensus: { secondsSinceLastFrameArrived: 1_195, videoFramesAppended: 150 },
    });
    // Still COMPLETE, still holding its video: the walk is short, not failed. A "failed" walk does
    // not queue its video at all (upload-core.ts's toQueuedWalk), which would throw away the only
    // footage there is — and the stills were never in question.
    expect(done.state).toBe("complete");
    expect(done.videoUri).toBe("file:///docs/walk/walk.mp4");
    expect(isVideoTruncated(done.videoCoverage)).toBe(true);
    expect(done.videoCoverage!.videoMs).toBe(5_000);
  });

  it("leaves coverage null when finalized carries no census", () => {
    const done = reduceWalk(ended, { type: "finalized", audioUri: null });
    expect(done.state).toBe("complete");
    expect(done.videoCoverage).toBeNull();
  });
});

// ── Audio coverage (round-4 FINDING 2) ────────────────────────────────────────────────────────────
//
// The video half above measures a QUIET TAIL, because a dead glasses transport stops delivering and
// never resumes. Audio fails the other way round: the phone microphone keeps delivering for the
// whole walk and the WRITER refuses buffers, so the gaps are scattered through the middle and a
// tail measurement would read a stalled walk as perfect. What is measured here is therefore the
// audio that was actually WRITTEN, not the silence at the end.
describe("assessAudioCoverage", () => {
  it("reads appended audio as the part of the walk that has narration", () => {
    const coverage = assessAudioCoverage(20 * 60 * 1000, { audioSecondsAppended: 5 });
    expect(coverage.walkMs).toBe(20 * 60 * 1000);
    expect(coverage.audioMs).toBe(5_000);
    expect(coverage.shortfallMs).toBe(1_195_000);
  });

  it("reports a healthy walk as fully covered, give or take a buffer", () => {
    const coverage = assessAudioCoverage(20 * 60 * 1000, { audioSecondsAppended: 1_199.978 });
    expect(coverage.shortfallMs).toBe(22);
    expect(isAudioTruncated(coverage)).toBe(false);
  });

  // The mirror image of the video sentinel trap, and the reason a bare `?? 0` at the bridge would
  // be wrong: for audio, ZERO is the worst value in the range, not the healthiest. A census that
  // genuinely reports zero appended seconds is a walk with no narration at all — the single most
  // expensive outcome here, since the narration IS the input to scope extraction.
  it("treats zero appended audio as zero coverage rather than a rounding artifact", () => {
    const coverage = assessAudioCoverage(600_000, { audioSecondsAppended: 0 });
    expect(coverage.audioMs).toBe(0);
    expect(coverage.shortfallMs).toBe(600_000);
    expect(isAudioTruncated(coverage)).toBe(true);
  });

  // Native starts the microphone tap just BEFORE startWalk resolves (which is when JS stamps
  // startedAt), so a healthy walk legitimately holds marginally more audio than wall clock.
  // Coverage must never go negative, exactly as the video half never reports more missing video
  // than there was walk.
  it("never reports more audio than there was walk", () => {
    const coverage = assessAudioCoverage(4_000, { audioSecondsAppended: 4.2 });
    expect(coverage.audioMs).toBe(4_000);
    expect(coverage.shortfallMs).toBe(0);
  });

  // Belt-and-suspenders: the bridge already refuses to build a census slice out of a missing
  // counter (useWalk.ts), but arithmetic on `undefined` would otherwise produce NaN — which
  // compares false against every threshold and would silently disable the warning entirely.
  it("treats an unusable counter as zero coverage rather than NaN", () => {
    const coverage = assessAudioCoverage(600_000, {
      audioSecondsAppended: undefined as unknown as number,
    });
    expect(coverage.audioMs).toBe(0);
    expect(coverage.shortfallMs).toBe(600_000);
  });

  // THE WALK THIS WHOLE MECHANISM EXISTS FOR. 2026-09-02: the muxed track ended at 47.8s of a 274s
  // walk because iOS stopped the engine — but narration.m4a, which does not depend on that engine,
  // ran the whole way. Reading only the muxed counter would put "Narration is short" on the
  // completion screen and "(audio cut short)" in the title of a walk whose narration is intact and
  // already uploading, and send the estimator back to a site that does not need re-walking.
  it("counts the standalone narration when the muxed track is the half that died", () => {
    const coverage = assessAudioCoverage(274_000, {
      audioSecondsAppended: 47.8,
      standaloneSecondsRecorded: 273.9,
    });
    expect(coverage.audioMs).toBe(273_900);
    expect(coverage.shortfallMs).toBe(100);
    expect(isAudioTruncated(coverage)).toBe(false);
  });

  // The LARGER, never the sum: they are two recordings of the same minutes. Summing them would
  // report a walk as covered twice over and mask a real shortfall — 20s of muxed audio plus 20s of
  // narration is 20s of narration, not 40.
  it("takes the larger of the two recordings rather than adding them", () => {
    const coverage = assessAudioCoverage(600_000, {
      audioSecondsAppended: 20,
      standaloneSecondsRecorded: 20,
    });
    expect(coverage.audioMs).toBe(20_000);
    expect(coverage.shortfallMs).toBe(580_000);
    expect(isAudioTruncated(coverage)).toBe(true);
  });

  // The other direction, which is the ordinary one: the standalone recorder never started, or left
  // nothing worth uploading, so useWalk.ts withholds the counter entirely. The muxed track is then
  // the only measurement there is, and it must still be able to raise the warning.
  it("falls back to the muxed track when no narration file is being filed", () => {
    const coverage = assessAudioCoverage(600_000, { audioSecondsAppended: 12 });
    expect(coverage.audioMs).toBe(12_000);
    expect(isAudioTruncated(coverage)).toBe(true);
  });

  it("ignores a standalone counter that is not a usable number", () => {
    const coverage = assessAudioCoverage(600_000, {
      audioSecondsAppended: 599,
      standaloneSecondsRecorded: Number.NaN,
    });
    expect(coverage.audioMs).toBe(599_000);
    expect(coverage.shortfallMs).toBe(1_000);
  });
});

describe("isAudioTruncated", () => {
  it("is false when coverage was never measured", () => {
    expect(isAudioTruncated(null)).toBe(false);
  });

  it("sits exactly at the tolerance boundary", () => {
    const walkMs = 60_000;
    const at = (shortfallMs: number) => ({
      walkMs,
      audioMs: walkMs - shortfallMs,
      shortfallMs,
    });
    expect(isAudioTruncated(at(WALK_AUDIO_SHORTFALL_TOLERANCE_MS))).toBe(false);
    expect(isAudioTruncated(at(WALK_AUDIO_SHORTFALL_TOLERANCE_MS + 1))).toBe(true);
  });
});

describe("reduceWalk audio coverage", () => {
  const ended = reduceWalk(started, { type: "ended", at: 1000 + 20 * 60 * 1000 });

  it("records audio coverage on the walk when finalized carries an audio census", () => {
    const done = reduceWalk(ended, {
      type: "finalized",
      audioUri: null,
      videoUri: "file:///docs/walk/walk.mp4",
      audioCensus: { audioSecondsAppended: 5 },
    });
    // COMPLETE, and still holding its video: a walk whose narration was truncated is annotated,
    // never downgraded. "failed" would queue no video at all (upload-core.ts's toQueuedWalk), so
    // an audio problem would end up destroying the footage as well as the narration.
    expect(done.state).toBe("complete");
    expect(done.videoUri).toBe("file:///docs/walk/walk.mp4");
    expect(isAudioTruncated(done.audioCoverage)).toBe(true);
    expect(done.audioCoverage!.audioMs).toBe(5_000);
  });

  it("leaves audio coverage null when finalized carries no audio census", () => {
    const done = reduceWalk(ended, { type: "finalized", audioUri: null });
    expect(done.state).toBe("complete");
    expect(done.audioCoverage).toBeNull();
  });

  // The two verdicts are independent measurements of two independent transports: the glasses can
  // die while the phone microphone is perfect, and the writer can stall on audio while every frame
  // lands. Neither may be inferred from the other.
  it("assesses video and audio independently from one finalized event", () => {
    const done = reduceWalk(ended, {
      type: "finalized",
      audioUri: null,
      videoUri: "file:///docs/walk/walk.mp4",
      videoCensus: { secondsSinceLastFrameArrived: 0.03, videoFramesAppended: 36_000 },
      audioCensus: { audioSecondsAppended: 5 },
    });
    expect(isVideoTruncated(done.videoCoverage)).toBe(false);
    expect(isAudioTruncated(done.audioCoverage)).toBe(true);
  });
});

// ── FINDING A (Codex): the recording bound, as arithmetic ─────────────────────────────────────────
//
// The server presigns under a 2 GiB per-artifact ceiling, refuses anything over it with a 400, and a
// 400 on a file's SIZE is the one upload failure no retry can resolve. useWalk.ts is where the walk
// is actually stopped; this is where the numbers that decide when are pinned, because a bound that
// fires late is no bound and a bound that fires early ends site visits that were never at risk.
describe("assessWalkVideoSize", () => {
  it("stops SHORT of the server's ceiling, leaving room for the moov and one more poll", () => {
    // The margin is the whole point: the size read while recording is the file BEFORE
    // AVAssetWriter appends its index in finishWriting, and before the media of the next polling
    // interval. A bound set AT the ceiling would be crossed by the finalise itself.
    expect(WALK_VIDEO_STOP_BYTES).toBeLessThan(MAX_WALK_ARTIFACT_BYTES);
    // …and the warning has to come first, or the stop is the first the estimator hears of it.
    expect(WALK_VIDEO_WARN_BYTES).toBeLessThan(WALK_VIDEO_STOP_BYTES);
  });

  it("says nothing about an ordinary walk", () => {
    expect(assessWalkVideoSize(0)).toBe("ok");
    expect(assessWalkVideoSize(400 * 1024 * 1024)).toBe("ok");
    expect(assessWalkVideoSize(WALK_VIDEO_WARN_BYTES - 1)).toBe("ok");
  });

  it("warns from the warn mark up to the stop mark, and not past it", () => {
    expect(assessWalkVideoSize(WALK_VIDEO_WARN_BYTES)).toBe("nearLimit");
    expect(assessWalkVideoSize(WALK_VIDEO_STOP_BYTES - 1)).toBe("nearLimit");
  });

  it("stops from the stop mark on", () => {
    expect(assessWalkVideoSize(WALK_VIDEO_STOP_BYTES)).toBe("atLimit");
    expect(assessWalkVideoSize(MAX_WALK_ARTIFACT_BYTES)).toBe("atLimit");
    expect(assessWalkVideoSize(8 * 1024 * 1024 * 1024)).toBe("atLimit");
  });

  // The direction that is not negotiable. An unmeasurable walk is not an oversized one — and the
  // action attached to "atLimit" ENDS a site visit, so a reading nobody could take must never be
  // what takes one away. Same rule the coverage verdicts follow for an absent census, with a higher
  // price for getting it backwards.
  it("treats an unreadable size as nothing to say, never as a reason to stop", () => {
    expect(assessWalkVideoSize(null)).toBe("ok");
    expect(assessWalkVideoSize(Number.NaN)).toBe("ok");
    expect(assessWalkVideoSize(Number.POSITIVE_INFINITY)).toBe("ok");
    expect(assessWalkVideoSize(-1)).toBe("ok");
  });
});

// ── The microphone, live: what native's two audio events do to a recording walk ──────────────────
//
// Two walks on 2026-09-02 lost 3.8 minutes of narration to an engine iOS stopped and nothing
// restarted, and the estimator learned of it from the completion screen — after leaving the site.
// These pin the state the walk screen draws the meter and the banner from, and the one rule that
// keeps the banner honest: only a buffer ARRIVING ends a stall, never a restart that merely started
// an engine.
describe("reduceWalk audio liveness", () => {
  it("starts alive and unmeasured, so a build that never reports never opens under a banner", () => {
    expect(started.audioAlive).toBe(true);
    expect(started.audioLevel).toBe(0);
    expect(started.audioStall).toBeNull();
  });

  it("records the level and keeps the microphone alive on audioLevel", () => {
    const live = reduceWalk(started, { type: "audioLevel", rms: 0.12 });
    expect(live.audioAlive).toBe(true);
    expect(live.audioLevel).toBe(0.12);
  });

  it("clamps a level native reports out of range, and draws a non-finite one as silence", () => {
    expect(reduceWalk(started, { type: "audioLevel", rms: 4 }).audioLevel).toBe(1);
    expect(reduceWalk(started, { type: "audioLevel", rms: -1 }).audioLevel).toBe(0);
    expect(reduceWalk(started, { type: "audioLevel", rms: Number.NaN }).audioLevel).toBe(0);
  });

  it("marks the microphone dead on audioStalled, zeroes the meter, and keeps native's report", () => {
    const stalled = reduceWalk(reduceWalk(started, { type: "audioLevel", rms: 0.2 }), {
      type: "audioStalled",
      attempt: 1,
      restarted: true,
      sinceMs: 2100,
    });
    expect(stalled.audioAlive).toBe(false);
    expect(stalled.audioLevel).toBe(0);
    expect(stalled.audioStall).toEqual({ attempt: 1, restarted: true, sinceMs: 2100 });
  });

  // A restart that succeeded is an engine that STARTED, not a microphone that is delivering — the
  // walk screen must keep saying "restarting" until a buffer proves otherwise.
  it("stays stalled after a successful restart until a buffer actually arrives", () => {
    const restarted = reduceWalk(started, {
      type: "audioStalled",
      attempt: 1,
      restarted: true,
      sinceMs: 2100,
    });
    expect(restarted.audioAlive).toBe(false);
    const back = reduceWalk(restarted, { type: "audioLevel", rms: 0.05 });
    expect(back.audioAlive).toBe(true);
    expect(back.audioStall).toBeNull();
  });

  it("ignores both events unless the walk is recording", () => {
    const idle = initialWalk("d", null);
    expect(reduceWalk(idle, { type: "audioStalled", attempt: 1, restarted: false, sinceMs: 5000 })).toBe(idle);
    const finalizing = reduceWalk(started, { type: "ended", at: 5000 });
    expect(reduceWalk(finalizing, { type: "audioLevel", rms: 0.3 })).toBe(finalizing);
    expect(
      reduceWalk(finalizing, { type: "audioStalled", attempt: 1, restarted: false, sinceMs: 5000 }),
    ).toBe(finalizing);
  });
});

describe("isAudioRestartExhausted", () => {
  it("is false while native is still restarting, and while nothing is wrong", () => {
    expect(isAudioRestartExhausted(null)).toBe(false);
    expect(isAudioRestartExhausted({ attempt: 1, restarted: false, sinceMs: 2000 })).toBe(false);
    expect(
      isAudioRestartExhausted({ attempt: WALK_AUDIO_RESTART_ATTEMPTS - 1, restarted: false, sinceMs: 6000 }),
    ).toBe(false);
  });

  // The last restart STARTING an engine is still hope, not failure; the report that follows it
  // with nothing delivered is the one that says so.
  it("is true only once the last allowed restart has been made and reported failed", () => {
    expect(
      isAudioRestartExhausted({ attempt: WALK_AUDIO_RESTART_ATTEMPTS, restarted: true, sinceMs: 6000 }),
    ).toBe(false);
    expect(
      isAudioRestartExhausted({ attempt: WALK_AUDIO_RESTART_ATTEMPTS, restarted: false, sinceMs: 8000 }),
    ).toBe(true);
  });

  // The escape: a buffer arriving from ANY restart — an interruption ending after the watchdog gave
  // up — clears the stall, and the banner with it.
  it("clears with the stall when audio comes back", () => {
    const gaveUp = reduceWalk(started, {
      type: "audioStalled",
      attempt: WALK_AUDIO_RESTART_ATTEMPTS,
      restarted: false,
      sinceMs: 8000,
    });
    expect(isAudioRestartExhausted(gaveUp.audioStall)).toBe(true);
    const back = reduceWalk(gaveUp, { type: "audioLevel", rms: 0.1 });
    expect(isAudioRestartExhausted(back.audioStall)).toBe(false);
  });
});

describe("meterFractionForRms", () => {
  it("draws speech in the middle of the bar and a raised voice at the end of it", () => {
    const quiet = meterFractionForRms(0.02);
    const speech = meterFractionForRms(0.1);
    expect(quiet).toBeGreaterThan(0);
    expect(speech).toBeGreaterThan(quiet);
    expect(speech).toBeGreaterThan(0.3);
    expect(speech).toBeLessThan(0.8);
    expect(meterFractionForRms(0.5)).toBe(1);
  });

  it("draws nothing for silence and for readings that are not numbers", () => {
    expect(meterFractionForRms(0)).toBe(0);
    expect(meterFractionForRms(-0.1)).toBe(0);
    expect(meterFractionForRms(Number.NaN)).toBe(0);
    expect(meterFractionForRms(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

// ── The narration file, and the census the walk is filed with ────────────────────────────────────
describe("reduceWalk finalized: narration and the capture census", () => {
  const ended = reduceWalk(started, { type: "ended", at: 21_000 });
  const CENSUS = {
    video: { framesReceived: 600, framesAppended: 600, framesDropped: 0, secondsSinceLastFrameArrived: 0.03 },
    audio: {
      buffersReceived: 940,
      buffersAppended: 940,
      buffersDropped: 0,
      longestDropRun: 0,
      secondsAppended: 20.05,
      engineRestarts: 1,
      standaloneSecondsRecorded: 20.1,
      events: [
        { atMs: 8000, kind: "configurationChange" },
        { atMs: 8050, kind: "engineRestarted:configurationChange" },
      ],
    },
  };

  it("carries narration.m4a from endWalk as the walk's audioUri", () => {
    const done = reduceWalk(ended, {
      type: "finalized",
      audioUri: "file:///docs/walkthroughs/w1/narration.m4a",
    });
    expect(done.state).toBe("complete");
    expect(done.audioUri).toBe("file:///docs/walkthroughs/w1/narration.m4a");
  });

  it("stamps the walk's own wall clock onto the census it files, and keeps native's record verbatim", () => {
    const done = reduceWalk(ended, { type: "finalized", audioUri: null, captureCensus: CENSUS });
    expect(done.captureCensus).toEqual({ walkMs: 20_000, ...CENSUS });
  });

  it("files no census when native reported none — null, never zeros", () => {
    expect(reduceWalk(ended, { type: "finalized", audioUri: null }).captureCensus).toBeNull();
    expect(
      reduceWalk(ended, { type: "finalized", audioUri: null, captureCensus: null }).captureCensus,
    ).toBeNull();
  });

  // `-1` is native's sentinel for "not one frame ever arrived", and it is the only value in the
  // whole census that is not a measurement. The completion contract pins every counter as a
  // NON-NEGATIVE number and refuses the request with a 400 otherwise — which would strand a walk
  // whose bytes are already in object storage, since a completion that cannot succeed goes terminal
  // and takes the video and every still with it. Translated the way assessVideoCoverage reads it:
  // no frame ever arrived means the whole walk was quiet.
  it("translates the no-frames sentinel into the walk's own length before filing it", () => {
    const done = reduceWalk(ended, {
      type: "finalized",
      audioUri: null,
      captureCensus: {
        ...CENSUS,
        video: { ...CENSUS.video, framesReceived: 0, framesAppended: 0, secondsSinceLastFrameArrived: -1 },
      },
    });
    expect(done.captureCensus?.walkMs).toBe(20_000);
    expect(done.captureCensus?.video.secondsSinceLastFrameArrived).toBe(20);
  });

  it("leaves a real quiet-tail measurement exactly as native reported it", () => {
    const done = reduceWalk(ended, { type: "finalized", audioUri: null, captureCensus: CENSUS });
    expect(done.captureCensus?.video.secondsSinceLastFrameArrived).toBe(0.03);
  });
});
