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
  const norm = (p: string) => p.replace(/\/$/, "");
  return {
    __store: store,
    __sizes: sizes,
    __reset: () => {
      store.clear();
      dirs.clear();
      sizes.clear();
    },
    documentDirectory: "file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/",
    FileSystemUploadType: { BINARY_CONTENT: 0 },
    getInfoAsync: async (p: string) => ({
      exists: store.has(p) || dirs.has(p) || dirs.has(norm(p)),
      size: sizes.get(p),
    }),
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
  drainWalkQueue,
  enqueueWalk,
  getFailedWalkCount,
  getQueuedWalks,
  getSchedulableWalkCount,
  type WalkArtifactUploadUrlResponse,
  type WalkCompletionResponse,
  type WalkQueueMeta,
  type WalkthroughUploadClient,
} from "../upload";

const fs = FileSystem as unknown as {
  __store: Map<string, string>;
  __sizes: Map<string, number>;
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

function completedWalk(): Walk {
  const started = reduceWalk(reduceWalk(initialWalk("deal-1", "proj-7"), { type: "starting" }), {
    type: "started",
    at: 1000,
    videoUri: VIDEO_URI,
  });
  const withStill = reduceWalk(started, {
    type: "still",
    uri: PHOTO_URI,
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

describe("getSchedulableWalkCount / getFailedWalkCount", () => {
  it("counts a drainable walk as schedulable, and reports 0 failed while retries remain", async () => {
    await enqueueWalk(OWNER, "walk-1", completedWalk(), META, 1000);
    expect(await getSchedulableWalkCount(OWNER)).toBe(1);
    expect(await getFailedWalkCount(OWNER)).toBe(0);
  });
});
