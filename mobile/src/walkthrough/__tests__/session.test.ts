import {
  initialWalk,
  reduceWalk,
  canCapture,
  artifactCount,
  type Walk,
} from "../session";

const started: Walk = reduceWalk(initialWalk("deal-1", "proj-7"), {
  type: "started",
  at: 1000,
  videoUri: "file:///docs/walk/video.mp4",
});

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

  // A still that arrives after the walk ended has nowhere to belong. Silently keeping it would
  // attach evidence to a finished walk that was already handed to the uploader.
  it("ignores a still that arrives after the walk ended", () => {
    const ended = reduceWalk(started, { type: "ended", at: 5000 });
    const late = reduceWalk(ended, {
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
});

describe("canCapture", () => {
  it("is true only while recording", () => {
    expect(canCapture(initialWalk("d", null))).toBe(false);
    expect(canCapture(reduceWalk(initialWalk("d", null), { type: "starting" }))).toBe(false);
    expect(canCapture(started)).toBe(true);
    expect(canCapture(reduceWalk(started, { type: "ended", at: 5000 }))).toBe(false);
  });
});
