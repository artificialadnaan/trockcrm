// Integration coverage for the effectful walk-upload queue: manifest persistence, container-UUID
// rebasing on read, and the two-phase drain (PUT every artifact, then ONE completion call, then
// delete local files). Mocks only the leaf native deps (expo-file-system, expo-keep-awake) so the
// REAL manifest read/write/drain logic in upload.ts runs against an in-memory FS, same approach as
// ../../capture/__tests__/upload-queue-rebase.test.ts.
//
// documentDirectory deliberately mirrors iOS's real shape (…/<container-UUID>/Documents/) rather than
// a flat fake path — rebaseDocumentDirectoryUri splices on the literal "/Documents/" segment, so a
// mock without one would silently no-op the very behavior these tests exist to cover.
jest.mock("expo-file-system/legacy", () => {
  const store = new Map<string, string>();
  const dirs = new Set<string>();
  const sizes = new Map<string, number>();
  const mtimes = new Map<string, number>();
  // Paths whose deleteAsync should REJECT — a genuine I/O error, NOT "the file isn't there".
  // deleteAsync({idempotent:true}) resolves for a missing path, so that distinction is the whole
  // subject of the cleanup tests below; injecting it via shared closure state (rather than
  // jest.spyOn on the imported namespace) is what makes upload.ts see the same function object.
  const failDeletes = new Set<string>();
  const norm = (p: string) => p.replace(/\/$/, "");
  return {
    __store: store,
    __sizes: sizes,
    __mtimes: mtimes,
    __failDeletes: failDeletes,
    __reset: () => {
      store.clear();
      dirs.clear();
      sizes.clear();
      mtimes.clear();
      failDeletes.clear();
    },
    documentDirectory: "file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/",
    FileSystemUploadType: { BINARY_CONTENT: 0 },
    getInfoAsync: async (p: string) => ({
      exists: store.has(p) || dirs.has(p) || dirs.has(norm(p)),
      size: sizes.get(p),
      modificationTime: mtimes.get(p),
    }),
    // Lists the immediate children (files OR sub-"directories", derived from store keys sharing the
    // prefix — this mock has no real directory concept beyond the `dirs` set makeDirectoryAsync
    // populates) of `dirUri`. Never throws — an unknown/empty prefix just yields []; every caller in
    // this module already treats "[]" and "doesn't exist" identically, so the mock doesn't need to
    // distinguish them.
    readDirectoryAsync: async (dirUri: string) => {
      const prefix = dirUri.endsWith("/") ? dirUri : `${dirUri}/`;
      const names = new Set<string>();
      for (const p of store.keys()) {
        if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split("/")[0]!);
      }
      for (const d of dirs) {
        const normed = norm(d);
        if (normed.startsWith(prefix) && normed !== norm(prefix)) {
          names.add(normed.slice(prefix.length).split("/")[0]!);
        }
      }
      return [...names];
    },
    makeDirectoryAsync: async (d: string) => {
      dirs.add(d);
      dirs.add(norm(d));
    },
    readAsStringAsync: async (p: string) => {
      if (!store.has(p)) throw new Error(`ENOENT ${p}`);
      return store.get(p)!;
    },
    writeAsStringAsync: async (p: string, data: string) => {
      store.set(p, data);
    },
    deleteAsync: async (p: string) => {
      if (failDeletes.has(p)) throw new Error(`EBUSY ${p}`);
      store.delete(p);
      sizes.delete(p);
      dirs.delete(p);
      dirs.delete(norm(p));
    },
    moveAsync: async ({ from, to }: { from: string; to: string }) => {
      store.set(to, store.get(from) ?? "");
      store.delete(from);
    },
    copyAsync: async ({ from, to }: { from: string; to: string }) => {
      store.set(to, store.get(from) ?? "");
    },
    uploadAsync: jest.fn(async () => ({ status: 200 })),
  };
});
jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(async () => undefined),
}));

import * as FileSystem from "expo-file-system/legacy";
import { initialWalk, reduceWalk, type Walk } from "../session";
import {
  MAX_DRAIN_PASSES,
  drainWalkQueue,
  enqueueRecoveredWalk,
  enqueueWalk,
  findRecoverableWalks,
  getFailedWalkCount,
  getQueuedWalks,
  getRecoverableWalkCount,
  getSchedulableWalkCount,
  retryFailedWalks,
  type WalkArtifactUploadUrlResponse,
  type WalkCompletionResponse,
  type WalkQueueMeta,
  type WalkthroughUploadClient,
} from "../upload";

const fs = FileSystem as unknown as {
  __store: Map<string, string>;
  __sizes: Map<string, number>;
  __mtimes: Map<string, number>;
  __failDeletes: Set<string>;
  __reset: () => void;
};
const uploadAsyncMock = FileSystem.uploadAsync as jest.Mock;

// The LIVE document directory, matching the mock above — every "current" (non-stale) file path in
// these tests is rooted here, exactly like FileSystem.documentDirectory would be on-device.
const DOC = "file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/";

beforeEach(() => {
  fs.__reset();
  uploadAsyncMock.mockClear();
  uploadAsyncMock.mockResolvedValue({ status: 200 });
});

const OWNER = "user-1:office-a";
const META: WalkQueueMeta = { title: "Front elevation walkthrough", siteLabel: "123 Main St" };

const VIDEO_URI = `${DOC}walkthroughs/walk-1/video.mp4`;
const PHOTO_URI = `${DOC}walkthroughs/walk-1/still-0.jpg`;
// A SECOND walk's artifacts, for the tests that need two walks on disk at once. Distinct paths
// matter: cleanup deletes by uri, so sharing walk-1's files would make walk-2's PUT fail for a
// reason the test isn't about.
const VIDEO_URI_2 = `${DOC}walkthroughs/walk-2/video.mp4`;
const PHOTO_URI_2 = `${DOC}walkthroughs/walk-2/still-0.jpg`;

function completedWalk(uris: { video: string; photo: string } = { video: VIDEO_URI, photo: PHOTO_URI }): Walk {
  const started = reduceWalk(reduceWalk(initialWalk("deal-1", "proj-7"), { type: "starting" }), {
    type: "started",
    at: 1000,
    videoUri: uris.video,
  });
  const withStill = reduceWalk(started, {
    type: "still",
    uri: uris.photo,
    at: 2000,
    source: "glasses",
  });
  const ended = reduceWalk(withStill, { type: "ended", at: 5000 });
  // Audio is muxed into the video (session.ts) — audioUri is always null on a completed walk.
  return reduceWalk(ended, { type: "finalized", audioUri: null });
}

/** Seed the in-memory FS so `FileSystem.getInfoAsync` reports each artifact file as present. */
function seedFiles(uris: string[]): void {
  for (const uri of uris) {
    fs.__store.set(uri, "bytes");
    fs.__sizes.set(uri, 1024);
  }
}

let urlCounter = 0;
function stubClient(overrides: Partial<WalkthroughUploadClient> = {}): WalkthroughUploadClient {
  return {
    requestUploadUrl: jest.fn(
      async (): Promise<WalkArtifactUploadUrlResponse> => ({
        uploadUrl: "https://upload.test/artifact",
        r2Key: `office_atlanta/artifact-${urlCounter++}`,
        expiresIn: 900,
      }),
    ),
    completeWalk: jest.fn(
      async (): Promise<WalkCompletionResponse> => ({
        walkId: "walk-1",
        files: [],
        forwarding: { status: "queued", jobId: "job-1" },
      }),
    ),
    ...overrides,
  };
}

const fetcher = jest.fn() as never;

describe("enqueueWalk / getQueuedWalks", () => {
  it("persists a completed walk's artifacts (video + photo — no separate audio artifact) and they're readable back", async () => {
    const walk = completedWalk();
    const queued = await enqueueWalk(OWNER, "walk-1", walk, META, 1000);
    expect(queued).not.toBeNull();

    const stored = await getQueuedWalks(OWNER);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.title).toBe(META.title);
    expect(stored[0]!.siteLabel).toBe(META.siteLabel);
    expect(stored[0]!.artifacts.map((a) => a.kind).sort()).toEqual(["photo", "video"]);
  });

  it("is idempotent: enqueuing the same walkId twice keeps the first entry", async () => {
    const walk = completedWalk();
    await enqueueWalk(OWNER, "walk-1", walk, META, 1000);
    await enqueueWalk(OWNER, "walk-1", walk, META, 2000); // second call, different `now`
    const stored = await getQueuedWalks(OWNER);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.enqueuedAt).toBe(1000); // the FIRST enqueue wins
  });

  it("scopes storage per owner — two owners' manifests never collide", async () => {
    await enqueueWalk("owner-a", "walk-1", completedWalk(), META, 1000);
    await enqueueWalk("owner-b", "walk-2", completedWalk(), META, 1000);
    expect((await getQueuedWalks("owner-a")).map((w) => w.walkId)).toEqual(["walk-1"]);
    expect((await getQueuedWalks("owner-b")).map((w) => w.walkId)).toEqual(["walk-2"]);
  });

  it("rebases a stored artifact's uri onto the live document directory (heals a rotated container)", async () => {
    // Simulate a manifest written under an OLD container UUID (an app update/reinstall rotated it).
    const stale = {
      walkId: "walk-1",
      dealId: "deal-1",
      projectId: null,
      title: META.title,
      siteLabel: META.siteLabel,
      startedAt: 1000,
      endedAt: 5000,
      durationMs: 4000,
      enqueuedAt: 1000,
      completionAttempts: 0,
      artifacts: [
        {
          idempotencyKey: "walk-1:video",
          kind: "video",
          uri: "file:///var/mobile/Containers/Data/Application/OLD-UUID/Documents/walkthroughs/walk-1/video.mp4",
          at: 1000,
          order: 0,
          attempts: 0,
        },
      ],
    };
    fs.__store.set(`${DOC}walkthrough-uploads/user-1_office-a/index.json`, JSON.stringify([stale]));
    const [walk] = await getQueuedWalks(OWNER);
    expect(walk!.artifacts[0]!.uri).toBe(VIDEO_URI);
  });

  it("leaves a uri already rooted at the live directory unchanged", async () => {
    await enqueueWalk(OWNER, "walk-1", completedWalk(), META, 1000);
    const [walk] = await getQueuedWalks(OWNER);
    expect(walk!.artifacts.map((a) => a.uri).sort()).toEqual([PHOTO_URI, VIDEO_URI].sort());
  });
});

describe("drainWalkQueue", () => {
  it("PUTs media before photos, then calls completion ONCE, then deletes local files and prunes the walk", async () => {
    const walk = completedWalk();
    seedFiles([VIDEO_URI, PHOTO_URI]);
    await enqueueWalk(OWNER, "walk-1", walk, META, 1000);

    const kindsPut: string[] = [];
    const client = stubClient({
      requestUploadUrl: jest.fn(async (_f, _dealId, req) => {
        kindsPut.push(req.kind);
        return { uploadUrl: "https://upload.test/x", r2Key: `k-${req.kind}`, expiresIn: 900 };
      }),
    });

    const summary = await drainWalkQueue(OWNER, fetcher, client);

    expect(summary.puts).toBe(2);
    expect(summary.putFailures).toBe(0);
    expect(summary.completed).toBe(1);
    expect(summary.completionFailures).toBe(0);
    expect(summary.remainingWalks).toBe(0);
    // Video (order 0) precedes the photo (order 1).
    expect(kindsPut).toEqual(["video", "photo"]);
    // Completion is called exactly once for the whole walk, not once per artifact.
    expect(client.completeWalk).toHaveBeenCalledTimes(1);
    const [, dealId, req] = (client.completeWalk as jest.Mock).mock.calls[0];
    expect(dealId).toBe("deal-1");
    expect(req.walkId).toBe("walk-1");
    expect(req.title).toBe(META.title);
    expect(req.siteLabel).toBe(META.siteLabel);
    expect(req.artifacts).toHaveLength(2);
    expect(req.artifacts.map((a: { kind: string }) => a.kind).sort()).toEqual(["photo", "video"]);

    // Every local file is gone, and the whole walk is pruned from the manifest.
    expect(fs.__store.has(VIDEO_URI)).toBe(false);
    expect(fs.__store.has(PHOTO_URI)).toBe(false);
    expect(await getQueuedWalks(OWNER)).toEqual([]);
  });

  it("never deletes a local file when a PUT fails, bumps that artifact's attempts, and never attempts completion", async () => {
    const walk = completedWalk();
    seedFiles([VIDEO_URI, PHOTO_URI]);
    await enqueueWalk(OWNER, "walk-1", walk, META, 1000);

    uploadAsyncMock.mockResolvedValue({ status: 500 }); // R2 PUT fails for every artifact
    const client = stubClient();

    const summary = await drainWalkQueue(OWNER, fetcher, client);

    expect(summary.puts).toBe(0);
    expect(summary.putFailures).toBe(2);
    expect(summary.completed).toBe(0);
    // The rule that matters: a local artifact is NEVER deleted before completion, and completion is
    // never even attempted while artifacts are outstanding.
    expect(fs.__store.has(VIDEO_URI)).toBe(true);
    expect(fs.__store.has(PHOTO_URI)).toBe(true);
    expect(client.completeWalk).not.toHaveBeenCalled();

    const [remaining] = await getQueuedWalks(OWNER);
    expect(remaining!.artifacts.every((a) => a.attempts === 1)).toBe(true);
    expect(remaining!.artifacts.every((a) => a.putAt === undefined)).toBe(true);
  });

  it("a resumed drain (one artifact already PUT) only re-PUTs what's outstanding", async () => {
    const walk = completedWalk();
    seedFiles([VIDEO_URI, PHOTO_URI]);
    await enqueueWalk(OWNER, "walk-1", walk, META, 1000);

    // First drain: the video (order 0, drained first) PUTs fine; the photo fails.
    uploadAsyncMock.mockResolvedValueOnce({ status: 200 });
    uploadAsyncMock.mockResolvedValueOnce({ status: 500 });
    const client = stubClient();
    const first = await drainWalkQueue(OWNER, fetcher, client);
    expect(first.puts).toBe(1);
    expect(first.putFailures).toBe(1);
    expect(first.completed).toBe(0); // not fully put yet — completion never attempted
    expect(client.completeWalk).not.toHaveBeenCalled();
    expect(fs.__store.has(VIDEO_URI)).toBe(true); // still on disk — not yet completed
    expect(fs.__store.has(PHOTO_URI)).toBe(true);

    // Second drain: only the photo is outstanding; a fresh call-count proves the video is never re-PUT.
    uploadAsyncMock.mockResolvedValue({ status: 200 });
    const requestCallsBefore = (client.requestUploadUrl as jest.Mock).mock.calls.length;
    const second = await drainWalkQueue(OWNER, fetcher, client);
    expect(second.puts).toBe(1);
    expect((client.requestUploadUrl as jest.Mock).mock.calls.length).toBe(requestCallsBefore + 1);
    expect((client.requestUploadUrl as jest.Mock).mock.calls[requestCallsBefore]![2].kind).toBe("photo");
    // Now fully put — completion fires and the walk is done.
    expect(second.completed).toBe(1);
    expect(second.remainingWalks).toBe(0);
  });

  // The exact scenario the redesign introduces: every PUT succeeds, but the app "dies" (or the network
  // drops) before the completion call lands. The walk must NOT be treated as finished — its bytes are
  // orphaned in R2 with no `files` row until completion actually succeeds.
  it("crash between the last PUT and completion: bytes are all in R2, but the walk stays queued, un-completed, and its files un-deleted until completion actually succeeds", async () => {
    const walk = completedWalk();
    seedFiles([VIDEO_URI, PHOTO_URI]);
    await enqueueWalk(OWNER, "walk-1", walk, META, 1000);

    // Every PUT succeeds this drain, but completion fails (simulating the crash/network drop right
    // after the last PUT, before the completion call could be confirmed).
    uploadAsyncMock.mockResolvedValue({ status: 200 });
    const client = stubClient({ completeWalk: jest.fn(async () => { throw new Error("network dropped"); }) });

    const first = await drainWalkQueue(OWNER, fetcher, client);
    expect(first.puts).toBe(2);
    expect(first.putFailures).toBe(0);
    expect(first.completed).toBe(0);
    expect(first.completionFailures).toBe(1);
    expect(first.remainingWalks).toBe(1); // the walk is NOT gone — it is not finished

    // Bytes are all "in R2" per our bookkeeping, but the walk must not look done: completedAt unset,
    // and — the load-bearing assertion — the local files are STILL on disk. If they were deleted here,
    // a walk whose completion never landed would have no way to ever be retried, and the bytes sitting
    // in R2 (with no `files` row) would be permanently invisible to the crew.
    const [midCrash] = await getQueuedWalks(OWNER);
    expect(midCrash!.artifacts.every((a) => a.putAt !== undefined)).toBe(true); // "bytes are in R2"
    expect(midCrash!.completedAt).toBeUndefined(); // "the server has NOT accepted this walk"
    expect(midCrash!.completionAttempts).toBe(1);
    expect(fs.__store.has(VIDEO_URI)).toBe(true);
    expect(fs.__store.has(PHOTO_URI)).toBe(true);

    // "Resume" (a later drain — could be the next foreground open or a background task) with a client
    // whose completion now succeeds. Per the redesign: re-PUTting is cheap/safe (deterministic keys),
    // but skipping completion is never acceptable — so what matters most is that completion gets
    // retried, not that we avoid re-sending bytes. Assert the walk resolves correctly either way:
    // completion is attempted, succeeds, and only THEN are files deleted / the walk removed.
    const requestCallsBeforeResume = (client.requestUploadUrl as jest.Mock).mock.calls.length;
    const resumedClient: WalkthroughUploadClient = { ...client, completeWalk: jest.fn(async () => ({
      walkId: "walk-1",
      files: [],
      forwarding: { status: "queued", jobId: "job-2" },
    })) };
    const second = await drainWalkQueue(OWNER, fetcher, resumedClient);

    expect(resumedClient.completeWalk).toHaveBeenCalledTimes(1); // completion WAS retried, not skipped
    expect(second.completed).toBe(1);
    expect(second.remainingWalks).toBe(0);
    // Already-put artifacts are not blindly re-sent (efficiency), but this is secondary to correctness:
    // the real requirement above is that completion always fires when completedAt is unset.
    expect((client.requestUploadUrl as jest.Mock).mock.calls.length).toBe(requestCallsBeforeResume);

    expect(fs.__store.has(VIDEO_URI)).toBe(false);
    expect(fs.__store.has(PHOTO_URI)).toBe(false);
    expect(await getQueuedWalks(OWNER)).toEqual([]);
  });

  it("a walk whose completion call keeps failing goes terminal after MAX_WALK_COMPLETION_ATTEMPTS and stops being drained", async () => {
    const walk = completedWalk();
    seedFiles([VIDEO_URI, PHOTO_URI]);
    await enqueueWalk(OWNER, "walk-1", walk, META, 1000);
    uploadAsyncMock.mockResolvedValue({ status: 200 });
    const client = stubClient({ completeWalk: jest.fn(async () => { throw new Error("500"); }) });

    // Drain repeatedly until completion should be exhausted.
    let summary;
    for (let i = 0; i < 5; i++) {
      summary = await drainWalkQueue(OWNER, fetcher, client);
    }
    expect(summary!.remainingWalks).toBe(1); // terminal walks stay queued for the UI to surface/dismiss
    expect(await getFailedWalkCount(OWNER)).toBe(1);
    expect(await getSchedulableWalkCount(OWNER)).toBe(0);
    // Files are STILL never deleted for a terminal (never-completed) walk.
    expect(fs.__store.has(VIDEO_URI)).toBe(true);
    expect(fs.__store.has(PHOTO_URI)).toBe(true);

    const callsBefore = (client.completeWalk as jest.Mock).mock.calls.length;
    await drainWalkQueue(OWNER, fetcher, client);
    // A terminal walk is no longer drained at all — no further completion attempts.
    expect((client.completeWalk as jest.Mock).mock.calls.length).toBe(callsBefore);
  });

  it("reports an empty summary and touches nothing when the queue is empty", async () => {
    const client = stubClient();
    const summary = await drainWalkQueue(OWNER, fetcher, client);
    expect(summary).toEqual({ puts: 0, putFailures: 0, completed: 0, completionFailures: 0, remainingWalks: 0 });
    expect(client.requestUploadUrl).not.toHaveBeenCalled();
    expect(client.completeWalk).not.toHaveBeenCalled();
  });
});

// A walk enqueued WHILE a drain is already running. The running drain fixed its `ordered` snapshot
// at entry, so it can never see the newcomer; before the coalescing loop, the second
// drainWalkQueue call also returned early without scheduling anything, so a second walk recorded
// back-to-back with a long (multi-GB) first upload sat queued until some opportunistic background
// window iOS might not grant for hours — with the app in the foreground and a drain actively
// running the whole time.
describe("drain requested while a drain is in flight", () => {
  /** A promise plus its resolver — lets a test park the drain INSIDE a network call, which is the
   *  only way to reproduce "a second walk arrives mid-drain" deterministically (no timers). */
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("drains a walk enqueued mid-drain in a follow-up pass instead of leaving it for a background run", async () => {
    seedFiles([VIDEO_URI, PHOTO_URI, VIDEO_URI_2, PHOTO_URI_2]);
    await enqueueWalk(OWNER, "walk-1", completedWalk(), META, 1000);

    const firstPutReached = deferred();
    const releaseFirstPut = deferred();
    let held = false;
    const client = stubClient({
      requestUploadUrl: jest.fn(async (_f, _dealId, req) => {
        if (!held) {
          held = true;
          firstPutReached.resolve();
          await releaseFirstPut.promise;
        }
        return { uploadUrl: "https://upload.test/x", r2Key: `k-${req.idempotencyKey}`, expiresIn: 900 };
      }),
    });

    const firstDrain = drainWalkQueue(OWNER, fetcher, client);
    await firstPutReached.promise; // drain 1 is now parked inside walk-1's first PUT

    // The estimator finishes a second walk while the first is still uploading.
    await enqueueWalk(OWNER, "walk-2", completedWalk({ video: VIDEO_URI_2, photo: PHOTO_URI_2 }), META, 2000);
    const coalesced = await drainWalkQueue(OWNER, fetcher, client);
    // The second call still returns immediately — one drain owns the queue at a time. What it must
    // ALSO do is leave a record that the queue changed under the running drain.
    expect(coalesced.puts).toBe(0);
    expect(coalesced.remainingWalks).toBe(2);

    releaseFirstPut.resolve();
    const summary = await firstDrain;

    // The load-bearing assertion: walk-2 shipped as part of the SAME drain call.
    expect((client.completeWalk as jest.Mock).mock.calls.map((c) => c[2].walkId)).toEqual([
      "walk-1",
      "walk-2",
    ]);
    expect(await getQueuedWalks(OWNER)).toEqual([]);
    expect(await getSchedulableWalkCount(OWNER)).toBe(0);
    expect(fs.__store.has(VIDEO_URI_2)).toBe(false);
    expect(fs.__store.has(PHOTO_URI_2)).toBe(false);
    // The returned summary covers every pass, so a caller can't be told "1 walk completed" when the
    // call actually shipped two.
    expect(summary.puts).toBe(4);
    expect(summary.completed).toBe(2);
    expect(summary.remainingWalks).toBe(0);
  });

  it("bounds the follow-up passes, so a caller that re-requests a drain from every progress callback can't spin forever", async () => {
    seedFiles([VIDEO_URI, PHOTO_URI]);
    await enqueueWalk(OWNER, "walk-1", completedWalk(), META, 1000);

    const client = stubClient();
    let passes = 0;
    const summary = await drainWalkQueue(OWNER, fetcher, client, {
      onProgress: () => {
        passes++;
        // Re-entrant request on EVERY pass — the pathological caller the cap exists for. The guard
        // is synchronous (drainWalkQueue's `draining` check runs before its first await), so this
        // reliably lands a pending request before the loop re-checks.
        void drainWalkQueue(OWNER, fetcher, client);
      },
    });

    // Exactly the cap: proves follow-up passes really happen (an un-coalesced drain would run one
    // pass and stop) AND that they terminate.
    expect(passes).toBe(MAX_DRAIN_PASSES);
    expect(summary.completed).toBe(1); // the extra passes find nothing left to do
    expect(await getQueuedWalks(OWNER)).toEqual([]);
  });
});

// A walk stranded between markWalkCompleted persisting and the cleanup (file deletes + manifest
// removal) that's supposed to follow it never finishing — the app suspended/killed in that exact
// window. Simulated by writing the manifest directly (as the "rebases a stored artifact's uri" test
// above does for a stale container UUID) rather than driving it through a real crash, since nothing
// in this test harness can literally kill the process mid-drain.
const MANIFEST_PATH = `${DOC}walkthrough-uploads/user-1_office-a/index.json`;
function strandedCompletedWalk(overrides: { artifacts?: unknown[] } = {}) {
  return {
    walkId: "walk-1",
    dealId: "deal-1",
    projectId: "proj-7",
    title: META.title,
    siteLabel: META.siteLabel,
    startedAt: 1000,
    endedAt: 5000,
    durationMs: 4000,
    enqueuedAt: 1000,
    completionAttempts: 0,
    completedAt: 4000, // the server ALREADY accepted this walk in a prior, interrupted drain
    artifacts: overrides.artifacts ?? [
      { idempotencyKey: "walk-1:video", kind: "video", uri: VIDEO_URI, at: 1000, order: 0, attempts: 0, putAt: 3000, sizeBytes: 1024 },
      { idempotencyKey: "walk-1:photo:0", kind: "photo", uri: PHOTO_URI, at: 2000, order: 1, attempts: 0, putAt: 3000, sizeBytes: 1024 },
    ],
  };
}

describe("stranded completed-but-uncleaned walks (Fix 2)", () => {
  it("getSchedulableWalkCount counts a stranded walk (the exact bug: it used to be excluded, so nothing would ever schedule a drain to clean it up)", async () => {
    seedFiles([VIDEO_URI, PHOTO_URI]);
    fs.__store.set(MANIFEST_PATH, JSON.stringify([strandedCompletedWalk()]));
    expect(await getSchedulableWalkCount(OWNER)).toBe(1);
  });

  it("a drain finishes the cleanup a prior crash left undone — no PUT, no completion call, files gone, manifest entry gone", async () => {
    seedFiles([VIDEO_URI, PHOTO_URI]); // local files a half-finished cleanup would have left behind
    fs.__store.set(MANIFEST_PATH, JSON.stringify([strandedCompletedWalk()]));

    const client = stubClient();
    const summary = await drainWalkQueue(OWNER, fetcher, client);

    // Both already happened in the (simulated) prior drain — this one must not repeat either.
    expect(client.requestUploadUrl).not.toHaveBeenCalled();
    expect(client.completeWalk).not.toHaveBeenCalled();
    expect(summary.completed).toBe(1);
    expect(summary.remainingWalks).toBe(0);
    // The load-bearing assertions: real filesystem + manifest state, not call counts.
    expect(fs.__store.has(VIDEO_URI)).toBe(false);
    expect(fs.__store.has(PHOTO_URI)).toBe(false);
    expect(await getQueuedWalks(OWNER)).toEqual([]);
  });

  // A delete that genuinely FAILS is not the same as one whose file was already gone, and the
  // difference is the whole ballgame: `idempotent: true` already turns "already gone" into success,
  // so a rejection means the (potentially multi-GB) file is still sitting on the phone. Dropping the
  // manifest entry anyway — what the swallowing catch used to do — was unrecoverable: needsCleanup
  // only ever sees walks still IN the manifest, so no later drain could retry, and the leftover
  // directory would then read to findRecoverableWalks as an orphan, i.e. a walk that never uploaded
  // when it had in fact already been filed server-side.
  it("keeps the completed entry when a local delete genuinely fails, and a later drain finishes the cleanup", async () => {
    const walk = completedWalk();
    seedFiles([VIDEO_URI, PHOTO_URI]);
    await enqueueWalk(OWNER, "walk-1", walk, META, 1000);
    fs.__failDeletes.add(VIDEO_URI); // e.g. the file is momentarily unreadable

    const client = stubClient();
    const first = await drainWalkQueue(OWNER, fetcher, client);

    // Uploading itself all worked — this is purely about the cleanup that follows.
    expect(first.puts).toBe(2);
    expect(client.completeWalk).toHaveBeenCalledTimes(1);
    // Not counted as completed: the walk is still on the queue and its media is still on the phone.
    expect(first.completed).toBe(0);
    expect(first.remainingWalks).toBe(1);

    const [stranded] = await getQueuedWalks(OWNER);
    expect(stranded!.completedAt).toBeDefined(); // the server DID accept it — never re-complete it
    expect(fs.__store.has(VIDEO_URI)).toBe(true); // the undeletable file, still accounted for
    // The whole point of keeping the entry: a future drain is scheduled to try again.
    expect(await getSchedulableWalkCount(OWNER)).toBe(1);

    // Whatever was holding the file clears, and the next drain finishes the job — with no second
    // upload and no second completion call, since both already succeeded.
    fs.__failDeletes.delete(VIDEO_URI);
    const second = await drainWalkQueue(OWNER, fetcher, client);

    expect(second.completed).toBe(1);
    expect(client.requestUploadUrl).toHaveBeenCalledTimes(2); // still just the original two PUTs
    expect(client.completeWalk).toHaveBeenCalledTimes(1);
    expect(fs.__store.has(VIDEO_URI)).toBe(false);
    expect(await getQueuedWalks(OWNER)).toEqual([]);
  });

  it("keeps the entry when the CLEANUP-ONLY branch hits a failing delete too (same rule on the resumed path)", async () => {
    seedFiles([VIDEO_URI, PHOTO_URI]);
    fs.__store.set(MANIFEST_PATH, JSON.stringify([strandedCompletedWalk()]));
    fs.__failDeletes.add(PHOTO_URI);

    const summary = await drainWalkQueue(OWNER, fetcher, stubClient());

    expect(summary.completed).toBe(0);
    expect(summary.remainingWalks).toBe(1);
    expect(fs.__store.has(VIDEO_URI)).toBe(false); // the deletable half still went — cleanup is partial, not all-or-nothing
    expect(fs.__store.has(PHOTO_URI)).toBe(true);
    expect((await getQueuedWalks(OWNER))[0]!.completedAt).toBe(4000);
  });

  it("is idempotent when an EARLIER cleanup attempt already deleted some (not all) of the files before dying again", async () => {
    seedFiles([PHOTO_URI]); // VIDEO_URI already gone — a partially-finished prior cleanup's work
    fs.__store.set(MANIFEST_PATH, JSON.stringify([strandedCompletedWalk()]));

    const summary = await drainWalkQueue(OWNER, fetcher, stubClient());

    expect(summary.completed).toBe(1);
    expect(fs.__store.has(VIDEO_URI)).toBe(false); // still gone — deleteAsync(idempotent) never errors on this
    expect(fs.__store.has(PHOTO_URI)).toBe(false); // now gone too
    expect(await getQueuedWalks(OWNER)).toEqual([]);
  });
});

// ── Fix 3: recovering Documents/walkthroughs/<walkId>/ directories with no manifest entry ──────────

describe("findRecoverableWalks / getRecoverableWalkCount", () => {
  it("returns nothing when the walkthroughs directory has never been written to", async () => {
    expect(await findRecoverableWalks(OWNER)).toEqual([]);
    expect(await getRecoverableWalkCount(OWNER)).toBe(0);
  });

  it("surfaces a directory with real files but no manifest entry, classifying video vs. stills in capture order", async () => {
    const orphanDir = `${DOC}walkthroughs/walk-orphan/`;
    fs.__store.set(`${orphanDir}walk.mp4`, "video-bytes");
    fs.__store.set(`${orphanDir}still-002.jpg`, "b");
    fs.__store.set(`${orphanDir}still-001.jpg`, "a");

    const recovered = await findRecoverableWalks(OWNER);
    expect(recovered).toEqual([
      {
        walkId: "walk-orphan",
        videoUri: `${orphanDir}walk.mp4`,
        stillUris: [`${orphanDir}still-001.jpg`, `${orphanDir}still-002.jpg`],
      },
    ]);
    expect(await getRecoverableWalkCount(OWNER)).toBe(1);
  });

  it("excludes a directory whose walkId is already tracked in the manifest, even though its files are still on disk", async () => {
    const walk = completedWalk();
    seedFiles([VIDEO_URI, PHOTO_URI]); // walk-1's directory has real files too
    await enqueueWalk(OWNER, "walk-1", walk, META, 1000);
    fs.__store.set(`${DOC}walkthroughs/walk-orphan/walk.mp4`, "video-bytes");

    const recovered = await findRecoverableWalks(OWNER);
    expect(recovered.map((r) => r.walkId)).toEqual(["walk-orphan"]); // walk-1 excluded; it's already tracked
  });

  it("skips an orphan directory that classifies to nothing (e.g. a walk that failed before native wrote anything)", async () => {
    fs.__store.set(`${DOC}walkthroughs/walk-empty/.keep`, ""); // a directory-ish entry, no real artifact
    expect(await findRecoverableWalks(OWNER)).toEqual([]);
  });

  it("scanning never mutates the manifest — findRecoverableWalks is read-only", async () => {
    fs.__store.set(`${DOC}walkthroughs/walk-orphan/still-001.jpg`, "a");
    await findRecoverableWalks(OWNER);
    expect(await getQueuedWalks(OWNER)).toEqual([]);
  });
});

describe("enqueueRecoveredWalk", () => {
  const orphanDir = `${DOC}walkthroughs/walk-orphan/`;

  it("files a recovered walk under the caller-supplied deal, and it then drains exactly like any other walk", async () => {
    fs.__store.set(`${orphanDir}walk.mp4`, "video-bytes");
    fs.__sizes.set(`${orphanDir}walk.mp4`, 2048);
    fs.__store.set(`${orphanDir}still-001.jpg`, "a");
    fs.__sizes.set(`${orphanDir}still-001.jpg`, 512);

    const [recovered] = await findRecoverableWalks(OWNER);
    const queued = await enqueueRecoveredWalk(OWNER, recovered!, "deal-99", null, META, 5000);
    expect(queued).not.toBeNull();
    expect(queued!.dealId).toBe("deal-99");
    expect(queued!.walkId).toBe("walk-orphan");
    // Never invented: a recovered walk has no reducer history for these.
    expect(queued!.startedAt).toBeNull();

    const client = stubClient();
    const summary = await drainWalkQueue(OWNER, fetcher, client);

    expect(summary.completed).toBe(1);
    const [, dealId] = (client.completeWalk as jest.Mock).mock.calls[0];
    expect(dealId).toBe("deal-99"); // the CALLER's deal, never invented by this module
    expect(fs.__store.has(`${orphanDir}walk.mp4`)).toBe(false);
    expect(fs.__store.has(`${orphanDir}still-001.jpg`)).toBe(false);
    expect(await getQueuedWalks(OWNER)).toEqual([]);
  });

  it("uses each file's own last-modified time when the platform reports one, not the recovery moment", async () => {
    fs.__store.set(`${orphanDir}walk.mp4`, "video-bytes");
    fs.__sizes.set(`${orphanDir}walk.mp4`, 2048);
    fs.__mtimes.set(`${orphanDir}walk.mp4`, 1_700_000_000); // epoch SECONDS, as expo-file-system reports it
    fs.__store.set(`${orphanDir}still-001.jpg`, "a");
    fs.__sizes.set(`${orphanDir}still-001.jpg`, 512);
    fs.__mtimes.set(`${orphanDir}still-001.jpg`, 1_700_000_050);

    const [recovered] = await findRecoverableWalks(OWNER);
    // `now` is deliberately far from the real mtimes, so a bug that ignores them is unmistakable.
    const queued = await enqueueRecoveredWalk(OWNER, recovered!, "deal-99", null, META, 999_999_999_999);

    const video = queued!.artifacts.find((a) => a.kind === "video")!;
    const photo = queued!.artifacts.find((a) => a.kind === "photo")!;
    expect(video.at).toBe(1_700_000_000_000); // seconds → ms
    expect(photo.at).toBe(1_700_000_050_000);
  });

  it("is idempotent: calling it twice for the same recovered walkId keeps the first attempt's progress", async () => {
    fs.__store.set(`${orphanDir}still-001.jpg`, "a");
    fs.__sizes.set(`${orphanDir}still-001.jpg`, 512);
    const [recovered] = await findRecoverableWalks(OWNER);

    await enqueueRecoveredWalk(OWNER, recovered!, "deal-99", null, META, 1000);
    uploadAsyncMock.mockResolvedValue({ status: 200 });
    // PUT succeeds but completion fails, so the walk stays queued with putAt set — exactly the
    // in-flight progress a clobbering re-enqueue would destroy.
    const failingClient = stubClient({ completeWalk: jest.fn(async () => { throw new Error("500"); }) });
    await drainWalkQueue(OWNER, fetcher, failingClient);

    // A second attempt to enqueue the SAME recovered walk (e.g. a caller re-scanning) must not
    // clobber the upload progress already made.
    await enqueueRecoveredWalk(OWNER, recovered!, "deal-99", null, META, 2000);
    const [stillQueued] = await getQueuedWalks(OWNER);
    expect(stillQueued!.artifacts[0]!.putAt).toBeDefined();
    expect(stillQueued!.completedAt).toBeUndefined();
  });
});

describe("getSchedulableWalkCount / getFailedWalkCount", () => {
  it("counts a drainable walk as schedulable, and reports 0 failed while retries remain", async () => {
    await enqueueWalk(OWNER, "walk-1", completedWalk(), META, 1000);
    expect(await getSchedulableWalkCount(OWNER)).toBe(1);
    expect(await getFailedWalkCount(OWNER)).toBe(0);
  });
});

describe("retryFailedWalks", () => {
  // The end-to-end Fix 2 path: a walk goes terminal (excluded from getSchedulableWalkCount, so
  // the background task will never touch it again — this is the exact bug getFailedWalkCount had
  // no call site to surface), retryFailedWalks resets it, and the NEXT drain actually ships it.
  it("resets a terminal walk so a subsequent drain picks it back up and completes it", async () => {
    const walk = completedWalk();
    seedFiles([VIDEO_URI, PHOTO_URI]);
    await enqueueWalk(OWNER, "walk-1", walk, META, 1000);
    uploadAsyncMock.mockResolvedValue({ status: 200 });
    const failingClient = stubClient({
      completeWalk: jest.fn(async () => {
        throw new Error("500");
      }),
    });

    for (let i = 0; i < 5; i++) {
      await drainWalkQueue(OWNER, fetcher, failingClient);
    }
    expect(await getFailedWalkCount(OWNER)).toBe(1);
    expect(await getSchedulableWalkCount(OWNER)).toBe(0);

    const resetCount = await retryFailedWalks(OWNER);
    expect(resetCount).toBe(1);
    // The walk is drainable again, and files already PUT were never re-uploaded (putAt survives).
    expect(await getFailedWalkCount(OWNER)).toBe(0);
    expect(await getSchedulableWalkCount(OWNER)).toBe(1);

    const workingClient = stubClient(); // completion succeeds this time
    const requestCallsBeforeRetry = (workingClient.requestUploadUrl as jest.Mock).mock.calls.length;
    const summary = await drainWalkQueue(OWNER, fetcher, workingClient);

    expect(summary.completed).toBe(1);
    expect(summary.remainingWalks).toBe(0);
    // Neither artifact was re-PUT — both were already confirmed in R2 before the retry.
    expect((workingClient.requestUploadUrl as jest.Mock).mock.calls.length).toBe(requestCallsBeforeRetry);
    expect(fs.__store.has(VIDEO_URI)).toBe(false);
    expect(fs.__store.has(PHOTO_URI)).toBe(false);
  });

  it("is a no-op when nothing is terminal", async () => {
    await enqueueWalk(OWNER, "walk-1", completedWalk(), META, 1000);
    expect(await retryFailedWalks(OWNER)).toBe(0);
  });
});
