import { initialWalk, reduceWalk, type Walk } from "../session";
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_WALK_COMPLETION_ATTEMPTS,
  MAX_WALK_UPLOAD_ATTEMPTS,
  bumpArtifactAttempts,
  bumpCompletionAttempts,
  classifyWalkDirFileNames,
  drainableArtifacts,
  isArtifactDrainable,
  isArtifactPut,
  isArtifactTerminal,
  isCompletionTerminal,
  isWalkCompleted,
  isWalkDrainable,
  isWalkFullyPut,
  isWalkTerminal,
  markArtifactPut,
  markWalkCompleted,
  needsCleanup,
  needsCompletion,
  outstandingArtifacts,
  removeQueuedWalk,
  resetTerminalWalkForRetry,
  sanitizeWalkOwnerKey,
  selectOrphanedWalkDirs,
  toQueuedWalk,
  toRecoveredQueuedWalk,
  upsertQueuedWalk,
  walkArtifactIdempotencyKey,
  type QueuedWalk,
  type WalkQueueMeta,
} from "../upload-core";

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

const META: WalkQueueMeta = { title: "Front elevation walkthrough", siteLabel: "123 Main St" };

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
  // Audio is muxed into the video now (session.ts) — a completed walk carries a null audioUri.
  return reduceWalk(ended, { type: "finalized", audioUri: null });
}

function failedWalk(stillCount = 1): Walk {
  const withCaptures = withStills(started, stillCount);
  return reduceWalk(withCaptures, { type: "failed", reason: "glasses disconnected" });
}

// ── toQueuedWalk ─────────────────────────────────────────────────────────────────────────────────

describe("toQueuedWalk", () => {
  it("enqueues every artifact of a completed walk: video + every photo (no audio when native produced no narration file)", () => {
    const walk = completedWalk(2);
    expect(walk.audioUri).toBeNull();
    const queued = toQueuedWalk("walk-1", walk, META, 9999)!;
    expect(queued).not.toBeNull();
    expect(queued.walkId).toBe("walk-1");
    expect(queued.dealId).toBe("deal-1");
    expect(queued.projectId).toBe("proj-7");
    expect(queued.title).toBe(META.title);
    expect(queued.siteLabel).toBe(META.siteLabel);
    expect(queued.completionAttempts).toBe(0);
    expect(queued.artifacts).toHaveLength(3); // video + 2 photos
    expect(queued.artifacts.map((a) => a.kind).sort()).toEqual(["photo", "photo", "video"]);
    // Every artifact starts fresh: zero attempts, not put, no completion.
    expect(queued.artifacts.every((a) => a.attempts === 0 && a.putAt === undefined)).toBe(true);
    expect(queued.completedAt).toBeUndefined();
  });

  // narration.m4a: the phone microphone native records independently of the video writer, so an
  // engine iOS stops mid-walk (2026-09-02: 3.8 minutes of narration lost across two walks) costs the
  // muxed track and not the narration the scope is written from.
  it("queues narration.m4a as an audio artifact when native produced one", () => {
    const walk: Walk = reduceWalk(reduceWalk(withStills(started, 1), { type: "ended", at: 5000 }), {
      type: "finalized",
      audioUri: "file:///docs/walkthroughs/walk-1/narration.m4a",
    });
    const queued = toQueuedWalk("walk-1", walk, META, 9999)!;
    expect(queued.artifacts.map((a) => a.kind).sort()).toEqual(["audio", "photo", "video"]);
    const audio = queued.artifacts.find((a) => a.kind === "audio")!;
    expect(audio.uri).toBe("file:///docs/walkthroughs/walk-1/narration.m4a");
    expect(audio.idempotencyKey).toBe(walkArtifactIdempotencyKey("walk-1", "audio"));
    // Drained with the video, ahead of the photos: the narration is what the scope is written from.
    expect(audio.order).toBe(queued.artifacts.find((a) => a.kind === "video")!.order);
    expect(audio.at).toBe(walk.startedAt);
  });

  it("carries the capture census onto the queue entry, and leaves the key OFF when there is none", () => {
    const census = {
      walkMs: 4000,
      video: { framesReceived: 120, framesAppended: 120, framesDropped: 0, secondsSinceLastFrameArrived: 0.03 },
      audio: {
        buffersReceived: 190,
        buffersAppended: 190,
        buffersDropped: 0,
        longestDropRun: 0,
        secondsAppended: 4.05,
        engineRestarts: 0,
        standaloneSecondsRecorded: 4.1,
        events: [],
      },
    };
    const ended = reduceWalk(started, { type: "ended", at: 5000 });
    const measured = reduceWalk(ended, {
      type: "finalized",
      audioUri: null,
      captureCensus: { video: census.video, audio: census.audio },
    });
    expect(toQueuedWalk("walk-1", measured, META, 9999)!.captureCensus).toEqual(census);
    // Absent, not null — a manifest entry written before the census existed looks exactly like this,
    // and the completion call omits the field rather than sending null.
    expect("captureCensus" in toQueuedWalk("walk-1", completedWalk(1), META, 9999)!).toBe(false);
  });

  it("carries the photo's own source and capture time, not the walk's", () => {
    const walk = completedWalk(2);
    const queued = toQueuedWalk("walk-1", walk, META, 9999)!;
    const photos = queued.artifacts.filter((a) => a.kind === "photo");
    expect(photos[0]!.source).toBe("glasses");
    expect(photos[0]!.at).toBe(2000);
    expect(photos[1]!.source).toBe("phone");
    expect(photos[1]!.at).toBe(2001);
  });

  it("returns null for a walk still in progress — nothing durable to queue yet", () => {
    expect(toQueuedWalk("walk-1", started, META, 9999)).toBeNull();
    expect(toQueuedWalk("walk-1", initialWalk("deal-1", null), META, 9999)).toBeNull();
  });

  it("a failed walk enqueues its stills but NOT a video artifact (Fix 1): videoUri survives `failed` as the PROVISIONAL uri from `started`, never a confirmed finalized file", () => {
    const walk = failedWalk(3);
    expect(walk.audioUri).toBeNull();
    // The reducer's "failed" case never clears videoUri — it is still holding whatever `started`
    // recorded, exactly the trap toQueuedWalk must not fall into.
    expect(walk.videoUri).not.toBeNull();
    const queued = toQueuedWalk("walk-1", walk, META, 9999)!;
    expect(queued).not.toBeNull();
    const kinds = queued.artifacts.map((a) => a.kind).sort();
    expect(kinds).toEqual(["photo", "photo", "photo"]); // video dropped; every still still filed
  });

  it("queues video ONLY when finalization actually succeeded — identical starting videoUri, different outcome by state alone", () => {
    // A walk that fails (mid-recording, or because native's finalize() rejected — the failure latch
    // from a recent native fix, which calls cancelWriting() rather than handing back a truncated
    // file): videoUri is still the provisional one, so no video artifact should be queued, but its
    // perfectly-good stills must still be filed.
    const failed = failedWalk(2);
    const queuedFromFailed = toQueuedWalk("walk-1", failed, META, 9999)!;
    expect(queuedFromFailed.artifacts.some((a) => a.kind === "video")).toBe(false);
    expect(queuedFromFailed.artifacts.every((a) => a.kind === "photo")).toBe(true);
    expect(queuedFromFailed.artifacts).toHaveLength(2);

    // Same walk up to the same point, but THIS one actually finalizes — video IS queued.
    const completed = reduceWalk(reduceWalk(withStills(started, 2), { type: "ended", at: 5000 }), {
      type: "finalized",
      audioUri: null,
    });
    const queuedFromCompleted = toQueuedWalk("walk-1", completed, META, 9999)!;
    expect(queuedFromCompleted.artifacts.some((a) => a.kind === "video")).toBe(true);
    expect(queuedFromCompleted.artifacts).toHaveLength(3); // video + 2 photos
  });

  it("a failed walk that captured NOTHING but a provisional videoUri (glasses died before any still) still returns null — video alone is never enough to enqueue", () => {
    // started already carries a videoUri; a walk that fails immediately after, with zero stills,
    // must not turn into a lone (untrustworthy) video artifact.
    const failed = reduceWalk(started, { type: "failed", reason: "glasses disconnected" });
    expect(failed.videoUri).not.toBeNull();
    expect(failed.stills).toHaveLength(0);
    expect(toQueuedWalk("walk-1", failed, META, 9999)).toBeNull();
  });

  // A finalize failure is exactly when the standalone narration matters, and exactly when it is most
  // easily lost: the walk is filed with its stills and `finishWalkCleanup` then deletes the whole
  // directory. Native names the closed file on the rejection, the reducer keeps it, and it is queued
  // here — the ONE artifact a failed walk may carry besides its photos. The video is still refused.
  it("queues a failed walk's narration.m4a, and still refuses its untrustworthy video", () => {
    const failed = reduceWalk(withStills(started, 1), {
      type: "failed",
      reason: "endWalk failed to finalize walk.mp4",
      audioUri: "file:///docs/walkthroughs/walk-1/narration.m4a",
    });
    const queued = toQueuedWalk("walk-1", failed, META, 9999)!;
    expect(queued).not.toBeNull();
    const audio = queued.artifacts.find((a) => a.kind === "audio")!;
    expect(audio.uri).toBe("file:///docs/walkthroughs/walk-1/narration.m4a");
    expect(queued.artifacts.some((a) => a.kind === "video")).toBe(false);
    expect(queued.artifacts.filter((a) => a.kind === "photo")).toHaveLength(1);
  });

  it("returns null for a terminal walk that captured nothing at all", () => {
    // Fails immediately from "starting", before "started" ever lands a videoUri.
    const neverStarted = reduceWalk(initialWalk("deal-1", null), { type: "starting" });
    const failed = reduceWalk(neverStarted, { type: "failed", reason: "no glasses paired" });
    expect(failed.videoUri).toBeNull();
    expect(failed.stills).toHaveLength(0);
    expect(toQueuedWalk("walk-1", failed, META, 9999)).toBeNull();
  });

  it("is idempotent in the keys it derives: calling it twice for the same walk produces identical idempotencyKeys", () => {
    const walk = completedWalk(2);
    const a = toQueuedWalk("walk-1", walk, META, 1)!;
    const b = toQueuedWalk("walk-1", walk, META, 2)!; // different `now` — keys must not depend on it
    expect(a.artifacts.map((x) => x.idempotencyKey).sort()).toEqual(
      b.artifacts.map((x) => x.idempotencyKey).sort(),
    );
  });
});

// ── walkArtifactIdempotencyKey ──────────────────────────────────────────────────────────────────

describe("walkArtifactIdempotencyKey", () => {
  it("derives distinct keys per walk, per kind, and per photo index", () => {
    expect(walkArtifactIdempotencyKey("w1", "audio")).not.toBe(walkArtifactIdempotencyKey("w1", "video"));
    expect(walkArtifactIdempotencyKey("w1", "photo", 0)).not.toBe(walkArtifactIdempotencyKey("w1", "photo", 1));
    expect(walkArtifactIdempotencyKey("w1", "audio")).not.toBe(walkArtifactIdempotencyKey("w2", "audio"));
  });

  it("never exceeds the server's files.client_upload_id budget, even for a pathologically long walkId", () => {
    const longWalkId = `walk-${"x".repeat(200)}`;
    const key = walkArtifactIdempotencyKey(longWalkId, "photo", 12);
    expect(key.length).toBeLessThanOrEqual(MAX_IDEMPOTENCY_KEY_LENGTH);
  });

  it("folds an over-budget key deterministically — the same inputs always fold to the same output", () => {
    const longWalkId = `walk-${"y".repeat(200)}`;
    const a = walkArtifactIdempotencyKey(longWalkId, "video");
    const b = walkArtifactIdempotencyKey(longWalkId, "video");
    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(MAX_IDEMPOTENCY_KEY_LENGTH);
  });

  it("a realistic walkId (newWalkId()'s shape) fits comfortably under budget unfolded", () => {
    // newWalkId() in useWalk.ts: `walk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const realistic = `walk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const key = walkArtifactIdempotencyKey(realistic, "photo", 999);
    expect(key.length).toBeLessThanOrEqual(MAX_IDEMPOTENCY_KEY_LENGTH);
    expect(key).toBe(`${realistic}:photo:999`); // short enough that it's never actually folded
  });
});

// ── artifact-level: isArtifactPut / isArtifactDrainable / isArtifactTerminal ────────────────────

function artifact(
  overrides: Partial<QueuedWalk["artifacts"][number]> = {},
): QueuedWalk["artifacts"][number] {
  return {
    idempotencyKey: "walk-1:photo:0",
    kind: "photo",
    uri: "file:///docs/walkthroughs/walk-1/still-0.jpg",
    at: 2000,
    order: 1,
    attempts: 0,
    ...overrides,
  };
}

function queuedWalk(overrides: Partial<QueuedWalk> = {}): QueuedWalk {
  return {
    walkId: "walk-1",
    dealId: "deal-1",
    projectId: "proj-7",
    title: META.title,
    siteLabel: META.siteLabel,
    startedAt: 1000,
    endedAt: 5000,
    durationMs: 4000,
    enqueuedAt: 9999,
    artifacts: [],
    completionAttempts: 0,
    ...overrides,
  };
}

describe("artifact-level isArtifactPut / isArtifactDrainable / isArtifactTerminal", () => {
  it("implement the PUT retry cap", () => {
    expect(isArtifactPut(artifact())).toBe(false);
    expect(isArtifactPut(artifact({ putAt: 1234 }))).toBe(true);

    expect(isArtifactDrainable(artifact({ attempts: 0 }))).toBe(true);
    expect(isArtifactDrainable(artifact({ attempts: MAX_WALK_UPLOAD_ATTEMPTS - 1 }))).toBe(true);
    expect(isArtifactDrainable(artifact({ attempts: MAX_WALK_UPLOAD_ATTEMPTS }))).toBe(false);
    expect(isArtifactTerminal(artifact({ attempts: MAX_WALK_UPLOAD_ATTEMPTS }))).toBe(true);

    // A put artifact is never terminal or drainable, no matter its attempt count.
    const put = artifact({ attempts: MAX_WALK_UPLOAD_ATTEMPTS, putAt: 1 });
    expect(isArtifactTerminal(put)).toBe(false);
    expect(isArtifactDrainable(put)).toBe(false);
  });

  it("bumpArtifactAttempts increments only the named artifacts within one walk and stamps lastTriedAt", () => {
    const walk = queuedWalk({
      artifacts: [artifact({ idempotencyKey: "a" }), artifact({ idempotencyKey: "b", attempts: 2 })],
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

  it("markArtifactPut stamps putAt and sizeBytes only on the named artifact", () => {
    const walk = queuedWalk({
      artifacts: [artifact({ idempotencyKey: "a" }), artifact({ idempotencyKey: "b" })],
    });
    const done = markArtifactPut(walk, "a", 4096, 7777);
    expect(done.artifacts[0]).toMatchObject({ idempotencyKey: "a", putAt: 7777, sizeBytes: 4096 });
    expect(done.artifacts[1]!.putAt).toBeUndefined();
    expect(done.artifacts[1]!.sizeBytes).toBeUndefined();
  });
});

// ── resuming a partially-uploaded walk ───────────────────────────────────────────────────────────

describe("resuming a partially-uploaded walk", () => {
  it("outstandingArtifacts excludes only what has already been PUT to R2", () => {
    const walk = queuedWalk({
      artifacts: [
        artifact({ idempotencyKey: "video", kind: "video", order: 0, putAt: 111 }), // done
        artifact({ idempotencyKey: "photo-0", kind: "photo", order: 1 }), // still pending
      ],
    });
    expect(outstandingArtifacts(walk).map((a) => a.idempotencyKey)).toEqual(["photo-0"]);
  });

  it("a resumed drain retries only outstanding artifacts, never a re-PUT of an already-confirmed one", () => {
    const walk = queuedWalk({
      artifacts: [
        artifact({ idempotencyKey: "video", kind: "video", order: 0, putAt: 111 }),
        artifact({ idempotencyKey: "photo-0", kind: "photo", order: 1, attempts: 1 }),
      ],
    });
    expect(drainableArtifacts(walk).map((a) => a.idempotencyKey)).toEqual(["photo-0"]);
  });

  it("a walk whose only outstanding artifact went terminal still reports it as outstanding (but not drainable)", () => {
    const walk = queuedWalk({
      artifacts: [
        artifact({ idempotencyKey: "video", kind: "video", order: 0, putAt: 111 }),
        artifact({ idempotencyKey: "photo-0", kind: "photo", order: 1, attempts: MAX_WALK_UPLOAD_ATTEMPTS }),
      ],
    });
    expect(outstandingArtifacts(walk).map((a) => a.idempotencyKey)).toEqual(["photo-0"]);
    expect(drainableArtifacts(walk)).toEqual([]); // terminal — a drain must not retry it
  });
});

// ── drain ordering: audio/video before photos ────────────────────────────────────────────────────

describe("drainableArtifacts ordering", () => {
  it("always drains audio/video before any photo, regardless of insertion order", () => {
    const walk = queuedWalk({
      artifacts: [
        artifact({ idempotencyKey: "photo-1", kind: "photo", order: 1, at: 100 }),
        artifact({ idempotencyKey: "photo-0", kind: "photo", order: 1, at: 50 }),
        artifact({ idempotencyKey: "video", kind: "video", order: 0, at: 9999 }), // later `at`, still first
        artifact({ idempotencyKey: "audio", kind: "audio", order: 0, at: 1 }),
      ],
    });
    const order = drainableArtifacts(walk).map((a) => a.idempotencyKey);
    expect(order).toEqual(["audio", "video", "photo-0", "photo-1"]);
  });
});

// ── the two-phase walk lifecycle: put → (all put) → completion ─────────────────────────────────

describe("isWalkFullyPut / needsCompletion / isWalkCompleted", () => {
  it("isWalkFullyPut is true only when every artifact is put, and never for an empty walk", () => {
    expect(isWalkFullyPut(queuedWalk({ artifacts: [] }))).toBe(false);
    expect(
      isWalkFullyPut(queuedWalk({ artifacts: [artifact({ putAt: 1 }), artifact({ idempotencyKey: "b" })] })),
    ).toBe(false);
    expect(
      isWalkFullyPut(
        queuedWalk({ artifacts: [artifact({ putAt: 1 }), artifact({ idempotencyKey: "b", putAt: 2 })] }),
      ),
    ).toBe(true);
  });

  it("needsCompletion is true exactly when fully put, not yet completed, and completion hasn't gone terminal", () => {
    const notFullyPut = queuedWalk({ artifacts: [artifact()] });
    expect(needsCompletion(notFullyPut)).toBe(false);

    const fullyPut = queuedWalk({ artifacts: [artifact({ putAt: 1 })] });
    expect(needsCompletion(fullyPut)).toBe(true);

    const alreadyCompleted = queuedWalk({ artifacts: [artifact({ putAt: 1 })], completedAt: 999 });
    expect(needsCompletion(alreadyCompleted)).toBe(false);
    expect(isWalkCompleted(alreadyCompleted)).toBe(true);

    const completionExhausted = queuedWalk({
      artifacts: [artifact({ putAt: 1 })],
      completionAttempts: MAX_WALK_COMPLETION_ATTEMPTS,
    });
    expect(needsCompletion(completionExhausted)).toBe(false);
    expect(isCompletionTerminal(completionExhausted)).toBe(true);
  });

  it("markWalkCompleted stamps completedAt; bumpCompletionAttempts increments the completion-only counter", () => {
    const walk = queuedWalk({ artifacts: [artifact({ putAt: 1 })] });
    const bumped = bumpCompletionAttempts(walk, 4242);
    expect(bumped.completionAttempts).toBe(1);
    expect(bumped.completionLastTriedAt).toBe(4242);
    // Bumping completion attempts never touches artifact-level attempts.
    expect(bumped.artifacts[0]!.attempts).toBe(0);

    const completed = markWalkCompleted(bumped, 5000);
    expect(completed.completedAt).toBe(5000);
    expect(isWalkCompleted(completed)).toBe(true);
  });
});

describe("isWalkDrainable / isWalkTerminal", () => {
  it("a walk with outstanding, retryable artifacts is drainable and not terminal", () => {
    const walk = queuedWalk({ artifacts: [artifact({ attempts: 1 })] });
    expect(isWalkDrainable(walk)).toBe(true);
    expect(isWalkTerminal(walk)).toBe(false);
  });

  it("a fully-put walk awaiting its first completion attempt is drainable (needs completion) and not terminal", () => {
    const walk = queuedWalk({ artifacts: [artifact({ putAt: 1 })] });
    expect(isWalkDrainable(walk)).toBe(true);
    expect(isWalkTerminal(walk)).toBe(false);
  });

  it("a completed walk that's STILL in the manifest is drainable for cleanup (Fix 2), and never terminal", () => {
    // Any QueuedWalk you can observe with completedAt set IS, by construction, still present in the
    // manifest — a walk whose cleanup (file deletes + manifest removal) already finished is removed
    // entirely (removeQueuedWalk) and can never be observed like this again. So this object
    // represents a walk stranded between markWalkCompleted and the cleanup that's supposed to follow
    // it — see needsCleanup. Before Fix 2, isWalkDrainable excluded it here, which meant nothing —
    // not getSchedulableWalkCount, not any future drain — would ever revisit it again.
    const walk = queuedWalk({ artifacts: [artifact({ putAt: 1 })], completedAt: 1 });
    expect(needsCleanup(walk)).toBe(true);
    expect(isWalkDrainable(walk)).toBe(true); // a drain must revisit it to finish cleanup
    expect(isWalkTerminal(walk)).toBe(false); // cleanup-pending is not a failure state
  });

  it("needsCleanup is false for every walk that still has real PUT/completion work outstanding", () => {
    expect(needsCleanup(queuedWalk({ artifacts: [artifact({ attempts: 1 })] }))).toBe(false);
    expect(needsCleanup(queuedWalk({ artifacts: [artifact({ putAt: 1 })] }))).toBe(false); // needs completion, not cleanup
  });

  it("one permanently-failed artifact dooms the WHOLE walk — no partial completion", () => {
    // A second, still-healthy artifact exists, but completion needs ALL artifacts, so nothing it does
    // can ever unlock completion once its sibling is terminal.
    const walk = queuedWalk({
      artifacts: [
        artifact({ idempotencyKey: "a", attempts: MAX_WALK_UPLOAD_ATTEMPTS }), // terminal
        artifact({ idempotencyKey: "b", attempts: 0 }), // otherwise perfectly retryable
      ],
    });
    expect(isWalkDrainable(walk)).toBe(false); // no point continuing to drain "b"
    expect(isWalkTerminal(walk)).toBe(true);
  });

  it("a fully-put walk whose completion call keeps failing goes terminal once exhausted, not before", () => {
    const walk = queuedWalk({
      artifacts: [artifact({ putAt: 1 })],
      completionAttempts: MAX_WALK_COMPLETION_ATTEMPTS - 1,
    });
    expect(isWalkDrainable(walk)).toBe(true); // one retry left
    expect(isWalkTerminal(walk)).toBe(false);

    const exhausted = queuedWalk({
      artifacts: [artifact({ putAt: 1 })],
      completionAttempts: MAX_WALK_COMPLETION_ATTEMPTS,
    });
    expect(isWalkDrainable(exhausted)).toBe(false);
    expect(isWalkTerminal(exhausted)).toBe(true);
  });

  it("an empty walk is neither drainable nor terminal (toQueuedWalk never produces one, but keep the aggregate honest)", () => {
    const walk = queuedWalk({ artifacts: [] });
    expect(isWalkDrainable(walk)).toBe(false);
    expect(isWalkTerminal(walk)).toBe(false);
  });
});

// ── resetTerminalWalkForRetry (the Fix 2 retry escape hatch) ───────────────────────────────────────

describe("resetTerminalWalkForRetry", () => {
  it("is a no-op for a walk that isn't terminal — returns the SAME reference", () => {
    const walk = queuedWalk({ artifacts: [artifact({ attempts: 1 })] });
    expect(isWalkTerminal(walk)).toBe(false);
    expect(resetTerminalWalkForRetry(walk)).toBe(walk);
  });

  it("resets a permanently-failed artifact's attempts to 0, making the walk drainable again", () => {
    const walk = queuedWalk({
      artifacts: [
        artifact({ idempotencyKey: "video", kind: "video", order: 0, putAt: 111 }),
        artifact({
          idempotencyKey: "photo-0",
          kind: "photo",
          order: 1,
          attempts: MAX_WALK_UPLOAD_ATTEMPTS,
        }),
      ],
    });
    expect(isWalkTerminal(walk)).toBe(true);

    const reset = resetTerminalWalkForRetry(walk);
    expect(isWalkTerminal(reset)).toBe(false);
    expect(isWalkDrainable(reset)).toBe(true);
    // The already-confirmed video artifact is untouched — never re-uploaded.
    expect(reset.artifacts[0]).toMatchObject({ idempotencyKey: "video", putAt: 111 });
    expect(reset.artifacts[1]).toMatchObject({ idempotencyKey: "photo-0", attempts: 0 });
    expect(reset.artifacts[1]!.putAt).toBeUndefined();
  });

  it("resets a permanently-failed completion call's attempt counter, leaving artifacts (already all put) untouched", () => {
    const walk = queuedWalk({
      artifacts: [artifact({ putAt: 1, sizeBytes: 4096 })],
      completionAttempts: MAX_WALK_COMPLETION_ATTEMPTS,
    });
    expect(isWalkTerminal(walk)).toBe(true);

    const reset = resetTerminalWalkForRetry(walk);
    expect(isWalkTerminal(reset)).toBe(false);
    expect(needsCompletion(reset)).toBe(true);
    expect(reset.completionAttempts).toBe(0);
    expect(reset.artifacts[0]).toMatchObject({ putAt: 1, sizeBytes: 4096 });
  });

  it("never touches a walk that's actually completed (not terminal by definition)", () => {
    const walk = queuedWalk({ artifacts: [artifact({ putAt: 1 })], completedAt: 999 });
    expect(resetTerminalWalkForRetry(walk)).toBe(walk);
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
      artifacts: [artifact({ idempotencyKey: "video", kind: "video", putAt: 111, attempts: 0 })],
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

// ── Fix 3: recovering Documents/walkthroughs/<walkId>/ directories with no manifest entry ──────────

describe("classifyWalkDirFileNames", () => {
  it("recognizes walk.mp4 as video and still-NNN.jpg files, sorted into capture order", () => {
    const result = classifyWalkDirFileNames(["still-002.jpg", "walk.mp4", "still-001.jpg"]);
    expect(result.videoFileName).toBe("walk.mp4");
    expect(result.stillFileNames).toEqual(["still-001.jpg", "still-002.jpg"]);
  });

  it("reports no video when walk.mp4 is absent — e.g. killed before the writer ever finalized", () => {
    const result = classifyWalkDirFileNames(["still-001.jpg"]);
    expect(result.videoFileName).toBeNull();
    expect(result.stillFileNames).toEqual(["still-001.jpg"]);
  });

  it("recognizes narration.m4a as the walk's standalone audio", () => {
    const result = classifyWalkDirFileNames(["narration.m4a", "walk.mp4"]);
    expect(result.audioFileName).toBe("narration.m4a");
    expect(result.videoFileName).toBe("walk.mp4");
  });

  it("ignores anything that isn't one of native's three known artifact shapes", () => {
    const result = classifyWalkDirFileNames([
      ".DS_Store",
      "notes.txt",
      "still-abc.jpg",
      "walk.mov",
      "narration.wav",
      "owner",
    ]);
    expect(result.videoFileName).toBeNull();
    expect(result.audioFileName).toBeNull();
    expect(result.stillFileNames).toEqual([]);
  });

  it("returns empty classification for an empty directory (nothing to recover, not a leak)", () => {
    expect(classifyWalkDirFileNames([])).toEqual({
      videoFileName: null,
      audioFileName: null,
      stillFileNames: [],
    });
  });
});

describe("selectOrphanedWalkDirs", () => {
  it("returns directory names with no manifest entry", () => {
    expect(selectOrphanedWalkDirs(["walk-1", "walk-2", "walk-3"], ["walk-2"])).toEqual(["walk-1", "walk-3"]);
  });

  it("is empty when every directory is already tracked", () => {
    expect(selectOrphanedWalkDirs(["walk-1"], ["walk-1"])).toEqual([]);
  });

  it("is empty when there are no directories at all", () => {
    expect(selectOrphanedWalkDirs([], ["walk-1"])).toEqual([]);
  });
});

describe("toRecoveredQueuedWalk", () => {
  it("builds video + photo artifacts straight from raw files, using each file's OWN timestamp, never `now`", () => {
    const queued = toRecoveredQueuedWalk(
      "walk-9",
      "deal-42",
      "proj-1",
      {
        videoUri: "file:///docs/walkthroughs/walk-9/walk.mp4",
        videoAt: 5000,
        stills: [
          { uri: "file:///docs/walkthroughs/walk-9/still-001.jpg", at: 5100 },
          { uri: "file:///docs/walkthroughs/walk-9/still-002.jpg", at: 5200 },
        ],
      },
      META,
      9_999_999, // `now` (the recovery moment) — must NOT leak into any artifact's `at`
    )!;
    expect(queued).not.toBeNull();
    expect(queued.dealId).toBe("deal-42");
    expect(queued.projectId).toBe("proj-1");
    // Genuinely unknown — never fabricated. There is no reducer history for a recovered walk.
    expect(queued.startedAt).toBeNull();
    expect(queued.endedAt).toBeNull();
    expect(queued.durationMs).toBeNull();
    expect(queued.completedAt).toBeUndefined();
    expect(queued.artifacts.map((a) => a.kind).sort()).toEqual(["photo", "photo", "video"]);
    const video = queued.artifacts.find((a) => a.kind === "video")!;
    expect(video.at).toBe(5000);
    const photos = queued.artifacts.filter((a) => a.kind === "photo").sort((a, b) => a.at - b.at);
    expect(photos.map((p) => p.at)).toEqual([5100, 5200]);
    expect(queued.artifacts.every((a) => a.attempts === 0 && a.putAt === undefined)).toBe(true);
  });

  it("falls back to `now` for the video's `at` only when the caller couldn't supply a real timestamp", () => {
    const queued = toRecoveredQueuedWalk(
      "walk-9",
      "deal-42",
      null,
      { videoUri: "file:///x/walk.mp4", stills: [] },
      META,
      9999,
    )!;
    expect(queued.artifacts[0]!.at).toBe(9999);
  });

  it("returns null when there is neither a video nor any stills to recover", () => {
    expect(
      toRecoveredQueuedWalk("walk-9", "deal-42", null, { videoUri: null, stills: [] }, META, 9999),
    ).toBeNull();
  });

  it("derives the SAME idempotency keys a normal (non-recovered) enqueue would, so the server's dedupe still applies", () => {
    const queued = toRecoveredQueuedWalk(
      "walk-9",
      "deal-42",
      null,
      { videoUri: "file:///x/walk.mp4", stills: [{ uri: "file:///x/still-001.jpg", at: 1 }] },
      META,
      9999,
    )!;
    expect(queued.artifacts.map((a) => a.idempotencyKey).sort()).toEqual(
      [walkArtifactIdempotencyKey("walk-9", "video"), walkArtifactIdempotencyKey("walk-9", "photo", 0)].sort(),
    );
  });
});

describe("toRecoveredQueuedWalk: narration.m4a", () => {
  it("files a recovered narration as an audio artifact with its own timestamp, and alone is enough to file", () => {
    const queued = toRecoveredQueuedWalk(
      "walk-9",
      "deal-42",
      null,
      {
        videoUri: null,
        audioUri: "file:///docs/walkthroughs/walk-9/narration.m4a",
        audioAt: 7000,
        stills: [],
      },
      META,
      9_999_999,
    )!;
    expect(queued).not.toBeNull();
    expect(queued.artifacts.map((a) => a.kind)).toEqual(["audio"]);
    expect(queued.artifacts[0]!.at).toBe(7000);
    expect(queued.artifacts[0]!.idempotencyKey).toBe(walkArtifactIdempotencyKey("walk-9", "audio"));
    // A recovered walk has no reducer history, so it has no census to file either.
    expect("captureCensus" in queued).toBe(false);
  });

  it("omits the audio artifact when the caller reports none, without disturbing the rest", () => {
    const queued = toRecoveredQueuedWalk(
      "walk-9",
      "deal-42",
      null,
      { videoUri: "file:///docs/walkthroughs/walk-9/walk.mp4", videoAt: 5000, audioUri: null, stills: [] },
      META,
      9_999_999,
    )!;
    expect(queued.artifacts.map((a) => a.kind)).toEqual(["video"]);
  });
});
