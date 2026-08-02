import {
  assessVideoCoverage,
  initialWalk,
  isVideoTruncated,
  reduceWalk,
  canCapture,
  canAcceptStill,
  canCaptureMore,
  isWalkActive,
  artifactCount,
  MAX_WALK_ARTIFACTS,
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

  // Every walk that reached "recording" always carries a video artifact, so the effective still
  // cap is MAX_WALK_ARTIFACTS - 1. Capturing right up to that boundary must still be allowed;
  // the very next one (which would push the total to MAX_WALK_ARTIFACTS + 1) must not be.
  it("is false exactly when capturing again would push the walk's total artifacts past the server's cap", () => {
    let walk = started;
    for (let i = 0; i < MAX_WALK_ARTIFACTS - 2; i++) {
      walk = reduceWalk(walk, {
        type: "still",
        uri: `file:///s${i}.jpg`,
        at: 1000 + i,
        source: "phone",
      });
    }
    expect(walk.stills.length).toBe(MAX_WALK_ARTIFACTS - 2);
    // One more still fits: stills (MAX-1) + video (1) === MAX_WALK_ARTIFACTS.
    expect(canCaptureMore(walk)).toBe(true);

    const atCap = reduceWalk(walk, {
      type: "still",
      uri: "file:///cap.jpg",
      at: 9999,
      source: "phone",
    });
    expect(atCap.stills.length).toBe(MAX_WALK_ARTIFACTS - 1);
    // Capturing again now would make stills (MAX) + video (1) === MAX_WALK_ARTIFACTS + 1.
    expect(canCaptureMore(atCap)).toBe(false);
  });

  // `reserved` accounts for capture requests already ACCEPTED by native but not yet delivered as
  // a `still` event — useWalk.ts's in-flight tracker. Without it, a DELIVERED-only count lets two
  // requests issued back-to-back both look safe, because neither photo has landed in
  // `walk.stills` yet when the second one is checked.
  it("also refuses once DELIVERED stills plus `reserved` in-flight requests would push the total past the cap", () => {
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
    // Two slots remain (stills + video === MAX_WALK_ARTIFACTS - 2): with nothing in flight, a
    // capture is fine.
    expect(canCaptureMore(walk, 0)).toBe(true);
    // With ONE request already accepted but not yet delivered, one more still fits exactly.
    expect(canCaptureMore(walk, 1)).toBe(true);
    // With TWO already in flight, a third would make stills(MAX-3) + reserved(2) + new(1) +
    // video(1) === MAX_WALK_ARTIFACTS + 1 — over the cap, even though NOT ONE of those two
    // in-flight requests has actually landed in `walk.stills` yet.
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
