import {
  initialWalk,
  reduceWalk,
  canCapture,
  canAcceptStill,
  canCaptureMore,
  artifactCount,
  MAX_WALK_ARTIFACTS,
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

  // Resetting is not gated on being terminal — the SAME target (deal unchanged) resetting an
  // active walk is a caller decision (useWalk.reset()'s doc comment says this should only be
  // called on a terminal walk), not something the pure reducer itself refuses.
  it("a reset event also works on a walk that never reached a terminal state", () => {
    const reset = reduceWalk(started, { type: "reset", dealId: "deal-1", projectId: "proj-7" });
    expect(reset).toEqual(initialWalk("deal-1", "proj-7"));
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
});
