import { initialWalk, reduceWalk, type Walk } from "../session";
import {
  MAX_WALK_UPLOAD_ATTEMPTS,
  bumpArtifactAttempts,
  drainableArtifacts,
  isArtifactDrainable,
  isArtifactTerminal,
  isArtifactUploaded,
  isWalkDrainable,
  isWalkFullyUploaded,
  isWalkTerminal,
  markArtifactsUploaded,
  outstandingArtifacts,
  removeQueuedWalk,
  sanitizeWalkOwnerKey,
  toQueuedWalk,
  upsertQueuedWalk,
  walkArtifactIdempotencyKey,
  type QueuedWalk,
} from "../upload-core";

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

const started: Walk = reduceWalk(
  reduceWalk(initialWalk("deal-1", "proj-7"), { type: "starting" }),
  { type: "started", at: 1000, videoUri: "file:///docs/walkthroughs/walk-1/video.mp4" },
);

function withStills(walk: Walk, n: number): Walk {
  let next = walk;
  for (let i = 0; i < n; i++) {
    next = reduceWalk(next, {
      type: "still",
      uri: `file:///docs/walkthroughs/walk-1/still-${i}.jpg`,
      at: 2000 + i,
      source: i % 2 === 0 ? "glasses" : "phone",
    });
  }
  return next;
}

function completedWalk(stillCount = 2): Walk {
  const ended = reduceWalk(withStills(started, stillCount), { type: "ended", at: 5000 });
  return reduceWalk(ended, { type: "finalized", audioUri: "file:///docs/walkthroughs/walk-1/audio.m4a" });
}

function failedWalk(stillCount = 1, opts: { withAudio?: boolean } = {}): Walk {
  const withCaptures = withStills(started, stillCount);
  const failed = reduceWalk(withCaptures, { type: "failed", reason: "glasses disconnected" });
  return opts.withAudio ? { ...failed, audioUri: "file:///docs/walkthroughs/walk-1/audio.m4a" } : failed;
}

// ── toQueuedWalk ─────────────────────────────────────────────────────────────────────────────────

describe("toQueuedWalk", () => {
  it("enqueues every artifact of a completed walk: audio, video, and every still", () => {
    const walk = completedWalk(2);
    const queued = toQueuedWalk("walk-1", walk, 9999)!;
    expect(queued).not.toBeNull();
    expect(queued.walkId).toBe("walk-1");
    expect(queued.dealId).toBe("deal-1");
    expect(queued.projectId).toBe("proj-7");
    expect(queued.artifacts).toHaveLength(4); // audio + video + 2 stills
    expect(queued.artifacts.map((a) => a.kind).sort()).toEqual(["audio", "still", "still", "video"]);
    // Every artifact starts fresh: zero attempts, not uploaded.
    expect(queued.artifacts.every((a) => a.attempts === 0 && a.uploadedAt === undefined)).toBe(true);
  });

  it("carries the still's own source and capture time, not the walk's", () => {
    const walk = completedWalk(2);
    const queued = toQueuedWalk("walk-1", walk, 9999)!;
    const stills = queued.artifacts.filter((a) => a.kind === "still");
    expect(stills[0]!.source).toBe("glasses");
    expect(stills[0]!.at).toBe(2000);
    expect(stills[1]!.source).toBe("phone");
    expect(stills[1]!.at).toBe(2001);
  });

  it("returns null for a walk still in progress — nothing durable to queue yet", () => {
    expect(toQueuedWalk("walk-1", started, 9999)).toBeNull();
    expect(toQueuedWalk("walk-1", initialWalk("deal-1", null), 9999)).toBeNull();
  });

  it("a failed walk with no audio (glasses disconnected before finalizing) still enqueues its stills", () => {
    const walk = failedWalk(3); // failed() never sets audioUri; videoUri is set from "started"
    expect(walk.audioUri).toBeNull();
    const queued = toQueuedWalk("walk-1", walk, 9999)!;
    expect(queued).not.toBeNull();
    const kinds = queued.artifacts.map((a) => a.kind).sort();
    expect(kinds).toEqual(["still", "still", "still", "video"]);
    expect(kinds).not.toContain("audio");
  });

  it("a failed walk that DID finish writing audio before failing keeps it", () => {
    const walk = failedWalk(1, { withAudio: true });
    const queued = toQueuedWalk("walk-1", walk, 9999)!;
    expect(queued.artifacts.map((a) => a.kind).sort()).toEqual(["audio", "still", "video"]);
  });

  it("returns null for a terminal walk that captured nothing at all", () => {
    // Fails immediately from "starting", before "started" ever lands a videoUri.
    const neverStarted = reduceWalk(initialWalk("deal-1", null), { type: "starting" });
    const failed = reduceWalk(neverStarted, { type: "failed", reason: "no glasses paired" });
    expect(failed.videoUri).toBeNull();
    expect(failed.audioUri).toBeNull();
    expect(failed.stills).toHaveLength(0);
    expect(toQueuedWalk("walk-1", failed, 9999)).toBeNull();
  });

  it("is idempotent in the keys it derives: calling it twice for the same walk produces identical idempotencyKeys", () => {
    const walk = completedWalk(2);
    const a = toQueuedWalk("walk-1", walk, 1)!;
    const b = toQueuedWalk("walk-1", walk, 2)!; // different `now` — keys must not depend on it
    expect(a.artifacts.map((x) => x.idempotencyKey).sort()).toEqual(
      b.artifacts.map((x) => x.idempotencyKey).sort(),
    );
  });

  it("derives distinct keys per walk, per kind, and per still index", () => {
    expect(walkArtifactIdempotencyKey("w1", "audio")).not.toBe(walkArtifactIdempotencyKey("w1", "video"));
    expect(walkArtifactIdempotencyKey("w1", "still", 0)).not.toBe(walkArtifactIdempotencyKey("w1", "still", 1));
    expect(walkArtifactIdempotencyKey("w1", "audio")).not.toBe(walkArtifactIdempotencyKey("w2", "audio"));
  });
});

// ── outstanding / drainable / terminal (artifact-level) ─────────────────────────────────────────

function artifact(
  overrides: Partial<QueuedWalk["artifacts"][number]> = {},
): QueuedWalk["artifacts"][number] {
  return {
    idempotencyKey: overrides.idempotencyKey ?? "walk-1:still:0",
    kind: overrides.kind ?? "still",
    uri: overrides.uri ?? "file:///docs/walkthroughs/walk-1/still-0.jpg",
    at: overrides.at ?? 2000,
    order: overrides.order ?? 1,
    attempts: overrides.attempts ?? 0,
    ...overrides,
  };
}

function queuedWalk(overrides: Partial<QueuedWalk> = {}): QueuedWalk {
  return {
    walkId: "walk-1",
    dealId: "deal-1",
    projectId: "proj-7",
    startedAt: 1000,
    endedAt: 5000,
    durationMs: 4000,
    enqueuedAt: 9999,
    artifacts: [],
    ...overrides,
  };
}

describe("artifact-level outstanding / drainable / terminal", () => {
  it("isArtifactUploaded / isArtifactDrainable / isArtifactTerminal implement the retry cap", () => {
    expect(isArtifactUploaded(artifact())).toBe(false);
    expect(isArtifactUploaded(artifact({ uploadedAt: 1234 }))).toBe(true);

    expect(isArtifactDrainable(artifact({ attempts: 0 }))).toBe(true);
    expect(isArtifactDrainable(artifact({ attempts: MAX_WALK_UPLOAD_ATTEMPTS - 1 }))).toBe(true);
    expect(isArtifactDrainable(artifact({ attempts: MAX_WALK_UPLOAD_ATTEMPTS }))).toBe(false);
    expect(isArtifactTerminal(artifact({ attempts: MAX_WALK_UPLOAD_ATTEMPTS }))).toBe(true);

    // An uploaded artifact is never terminal or drainable, no matter its attempt count.
    const uploaded = artifact({ attempts: MAX_WALK_UPLOAD_ATTEMPTS, uploadedAt: 1 });
    expect(isArtifactTerminal(uploaded)).toBe(false);
    expect(isArtifactDrainable(uploaded)).toBe(false);
  });

  it("bumpArtifactAttempts increments only the named artifacts within one walk and stamps lastTriedAt", () => {
    const walk = queuedWalk({
      artifacts: [
        artifact({ idempotencyKey: "a" }),
        artifact({ idempotencyKey: "b", attempts: 2 }),
      ],
    });
    const bumped = bumpArtifactAttempts(walk, ["a"], 5555);
    expect(bumped.artifacts[0]).toMatchObject({ idempotencyKey: "a", attempts: 1, lastTriedAt: 5555 });
    expect(bumped.artifacts[1]).toMatchObject({ idempotencyKey: "b", attempts: 2 }); // untouched
    expect(bumped.artifacts[1]!.lastTriedAt).toBeUndefined();
  });

  it("an artifact goes terminal at exactly MAX_WALK_UPLOAD_ATTEMPTS failed attempts, not before", () => {
    let walk = queuedWalk({ artifacts: [artifact({ idempotencyKey: "a" })] });
    for (let i = 0; i < MAX_WALK_UPLOAD_ATTEMPTS - 1; i++) {
      walk = bumpArtifactAttempts(walk, ["a"], i);
      expect(isArtifactTerminal(walk.artifacts[0]!)).toBe(false);
    }
    walk = bumpArtifactAttempts(walk, ["a"], 999);
    expect(walk.artifacts[0]!.attempts).toBe(MAX_WALK_UPLOAD_ATTEMPTS);
    expect(isArtifactTerminal(walk.artifacts[0]!)).toBe(true);
  });

  it("markArtifactsUploaded stamps uploadedAt only on the named artifacts", () => {
    const walk = queuedWalk({
      artifacts: [artifact({ idempotencyKey: "a" }), artifact({ idempotencyKey: "b" })],
    });
    const done = markArtifactsUploaded(walk, ["a"], 7777);
    expect(done.artifacts[0]).toMatchObject({ idempotencyKey: "a", uploadedAt: 7777 });
    expect(done.artifacts[1]!.uploadedAt).toBeUndefined();
  });
});

// ── resuming a partially-uploaded walk ───────────────────────────────────────────────────────────

describe("resuming a partially-uploaded walk", () => {
  it("outstandingArtifacts excludes only what the server already confirmed", () => {
    const walk = queuedWalk({
      artifacts: [
        artifact({ idempotencyKey: "audio", kind: "audio", order: 0, uploadedAt: 111 }), // done
        artifact({ idempotencyKey: "video", kind: "video", order: 0 }), // still pending
        artifact({ idempotencyKey: "still-0", kind: "still", order: 1 }), // still pending
      ],
    });
    const outstanding = outstandingArtifacts(walk).map((a) => a.idempotencyKey);
    expect(outstanding.sort()).toEqual(["still-0", "video"]);
  });

  it("a resumed drain retries only outstanding artifacts, never a re-send of an already-confirmed one", () => {
    const walk = queuedWalk({
      artifacts: [
        artifact({ idempotencyKey: "audio", kind: "audio", order: 0, uploadedAt: 111 }),
        artifact({ idempotencyKey: "video", kind: "video", order: 0, attempts: 1 }),
        artifact({ idempotencyKey: "still-0", kind: "still", order: 1 }),
      ],
    });
    const toDrain = drainableArtifacts(walk).map((a) => a.idempotencyKey);
    expect(toDrain).toEqual(["video", "still-0"]); // audio (confirmed) is excluded
  });

  it("a walk with everything confirmed but one terminal artifact still reports that artifact as outstanding", () => {
    const walk = queuedWalk({
      artifacts: [
        artifact({ idempotencyKey: "video", kind: "video", order: 0, uploadedAt: 111 }),
        artifact({ idempotencyKey: "still-0", kind: "still", order: 1, attempts: MAX_WALK_UPLOAD_ATTEMPTS }),
      ],
    });
    expect(outstandingArtifacts(walk).map((a) => a.idempotencyKey)).toEqual(["still-0"]);
    expect(drainableArtifacts(walk)).toEqual([]); // terminal — a drain must not retry it
  });
});

// ── drain ordering: audio/video before stills ────────────────────────────────────────────────────

describe("drainableArtifacts ordering", () => {
  it("always drains audio/video before any still, regardless of insertion order", () => {
    const walk = queuedWalk({
      artifacts: [
        artifact({ idempotencyKey: "still-1", kind: "still", order: 1, at: 100 }),
        artifact({ idempotencyKey: "still-0", kind: "still", order: 1, at: 50 }),
        artifact({ idempotencyKey: "video", kind: "video", order: 0, at: 9999 }), // later `at`, still first
        artifact({ idempotencyKey: "audio", kind: "audio", order: 0, at: 1 }),
      ],
    });
    const order = drainableArtifacts(walk).map((a) => a.idempotencyKey);
    // Media (order 0) both precede stills (order 1); within media, earlier `at` first; within
    // stills, earlier capture (`at`) first.
    expect(order).toEqual(["audio", "video", "still-0", "still-1"]);
  });
});

// ── walk-level aggregates ────────────────────────────────────────────────────────────────────────

describe("walk-level aggregates", () => {
  it("isWalkFullyUploaded is true only when every artifact is confirmed, and never for an empty walk", () => {
    expect(isWalkFullyUploaded(queuedWalk({ artifacts: [] }))).toBe(false);
    expect(
      isWalkFullyUploaded(queuedWalk({ artifacts: [artifact({ uploadedAt: 1 }), artifact({ idempotencyKey: "b" })] })),
    ).toBe(false);
    expect(
      isWalkFullyUploaded(
        queuedWalk({ artifacts: [artifact({ uploadedAt: 1 }), artifact({ idempotencyKey: "b", uploadedAt: 2 })] }),
      ),
    ).toBe(true);
  });

  it("isWalkDrainable is true iff at least one artifact is drainable", () => {
    expect(isWalkDrainable(queuedWalk({ artifacts: [artifact({ uploadedAt: 1 })] }))).toBe(false);
    expect(
      isWalkDrainable(queuedWalk({ artifacts: [artifact({ attempts: MAX_WALK_UPLOAD_ATTEMPTS })] })),
    ).toBe(false);
    expect(isWalkDrainable(queuedWalk({ artifacts: [artifact()] }))).toBe(true);
  });

  it("isWalkTerminal is true only when nothing uploaded, nothing drainable, but something was attempted", () => {
    // All confirmed → not terminal (it's done).
    expect(isWalkTerminal(queuedWalk({ artifacts: [artifact({ uploadedAt: 1 })] }))).toBe(false);
    // Still drainable → not terminal yet.
    expect(isWalkTerminal(queuedWalk({ artifacts: [artifact({ attempts: 1 })] }))).toBe(false);
    // Exhausted retries, never uploaded → terminal.
    expect(
      isWalkTerminal(queuedWalk({ artifacts: [artifact({ attempts: MAX_WALK_UPLOAD_ATTEMPTS })] })),
    ).toBe(true);
    // A mix: one confirmed, one exhausted — still terminal (nothing left a drain can do).
    expect(
      isWalkTerminal(
        queuedWalk({
          artifacts: [
            artifact({ idempotencyKey: "a", uploadedAt: 1 }),
            artifact({ idempotencyKey: "b", attempts: MAX_WALK_UPLOAD_ATTEMPTS }),
          ],
        }),
      ),
    ).toBe(true);
    // A mix: one confirmed, one still retryable — not terminal.
    expect(
      isWalkTerminal(
        queuedWalk({
          artifacts: [
            artifact({ idempotencyKey: "a", uploadedAt: 1 }),
            artifact({ idempotencyKey: "b", attempts: 1 }),
          ],
        }),
      ),
    ).toBe(false);
    // Empty walk is never terminal (toQueuedWalk never produces one, but keep the aggregate honest).
    expect(isWalkTerminal(queuedWalk({ artifacts: [] }))).toBe(false);
  });
});

// ── upsert / remove (manifest list operations) ──────────────────────────────────────────────────

describe("upsertQueuedWalk / removeQueuedWalk", () => {
  it("appends a new walk", () => {
    const a = queuedWalk({ walkId: "a" });
    const b = queuedWalk({ walkId: "b" });
    expect(upsertQueuedWalk([a], b).map((w) => w.walkId)).toEqual(["a", "b"]);
  });

  it("never clobbers an already-queued walk's progress with a fresh (all-zero) re-derivation", () => {
    const inProgress = queuedWalk({
      walkId: "walk-1",
      artifacts: [artifact({ idempotencyKey: "video", kind: "video", uploadedAt: 111, attempts: 0 })],
    });
    const freshlyDerived = queuedWalk({
      walkId: "walk-1",
      artifacts: [artifact({ idempotencyKey: "video", kind: "video" })], // as if re-enqueued from scratch
    });
    const result = upsertQueuedWalk([inProgress], freshlyDerived);
    expect(result).toEqual([inProgress]); // untouched — the in-flight progress is preserved
  });

  it("removeQueuedWalk drops only the named walk", () => {
    const a = queuedWalk({ walkId: "a" });
    const b = queuedWalk({ walkId: "b" });
    expect(removeQueuedWalk([a, b], "a").map((w) => w.walkId)).toEqual(["b"]);
  });
});

// ── sanitizeWalkOwnerKey ─────────────────────────────────────────────────────────────────────────

describe("sanitizeWalkOwnerKey", () => {
  it("makes a path-safe segment and never collapses to a shared empty path", () => {
    expect(sanitizeWalkOwnerKey("user-123_ABC")).toBe("user-123_ABC");
    expect(sanitizeWalkOwnerKey("a/b\\c .d")).toBe("a_b_c__d");
    expect(sanitizeWalkOwnerKey("")).toBe("anon");
  });
});
