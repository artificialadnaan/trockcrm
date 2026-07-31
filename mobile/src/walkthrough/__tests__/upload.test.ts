// Integration coverage for the effectful walk-upload queue: manifest persistence, container-UUID
// rebasing on read, and the drain's confirm-before-delete ordering. Mocks only the leaf native deps
// (expo-file-system, expo-keep-awake) so the REAL manifest read/write/drain logic in upload.ts runs
// against an in-memory FS, same approach as ../../capture/__tests__/upload-queue-rebase.test.ts.
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
  type WalkArtifactConfirmResponse,
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

function completedWalk(): Walk {
  const started = reduceWalk(reduceWalk(initialWalk("deal-1", "proj-7"), { type: "starting" }), {
    type: "started",
    at: 1000,
    videoUri: `${DOC}walkthroughs/walk-1/video.mp4`,
  });
  const withStill = reduceWalk(started, {
    type: "still",
    uri: `${DOC}walkthroughs/walk-1/still-0.jpg`,
    at: 2000,
    source: "glasses",
  });
  const ended = reduceWalk(withStill, { type: "ended", at: 5000 });
  return reduceWalk(ended, { type: "finalized", audioUri: `${DOC}walkthroughs/walk-1/audio.m4a` });
}

const AUDIO_URI = `${DOC}walkthroughs/walk-1/audio.m4a`;
const VIDEO_URI = `${DOC}walkthroughs/walk-1/video.mp4`;
const STILL_URI = `${DOC}walkthroughs/walk-1/still-0.jpg`;

/** Seed the in-memory FS so `FileSystem.getInfoAsync` reports each artifact file as present. */
function seedFiles(uris: string[]): void {
  for (const uri of uris) {
    fs.__store.set(uri, "bytes");
    fs.__sizes.set(uri, 1024);
  }
}

function stubClient(overrides: Partial<WalkthroughUploadClient> = {}): WalkthroughUploadClient {
  let counter = 0;
  return {
    requestUploadUrl: jest.fn(async () => ({
      uploadUrl: "https://upload.test/artifact",
      objectKey: `office_atlanta/artifact-${counter++}`,
      uploadToken: "token-1",
    })),
    confirmArtifactUpload: jest.fn(async (): Promise<WalkArtifactConfirmResponse> => ({ id: `server-${counter}` })),
    ...overrides,
  };
}

const fetcher = jest.fn() as never;

describe("enqueueWalk / getQueuedWalks", () => {
  it("persists a completed walk's artifacts and they're readable back", async () => {
    const walk = completedWalk();
    const queued = await enqueueWalk(OWNER, "walk-1", walk, 1000);
    expect(queued).not.toBeNull();

    const stored = await getQueuedWalks(OWNER);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.artifacts).toHaveLength(3); // audio + video + 1 still
  });

  it("is idempotent: enqueuing the same walkId twice keeps the first entry", async () => {
    const walk = completedWalk();
    await enqueueWalk(OWNER, "walk-1", walk, 1000);
    await enqueueWalk(OWNER, "walk-1", walk, 2000); // second call, different `now`
    const stored = await getQueuedWalks(OWNER);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.enqueuedAt).toBe(1000); // the FIRST enqueue wins
  });

  it("scopes storage per owner — two owners' manifests never collide", async () => {
    await enqueueWalk("owner-a", "walk-1", completedWalk(), 1000);
    await enqueueWalk("owner-b", "walk-2", completedWalk(), 1000);
    expect((await getQueuedWalks("owner-a")).map((w) => w.walkId)).toEqual(["walk-1"]);
    expect((await getQueuedWalks("owner-b")).map((w) => w.walkId)).toEqual(["walk-2"]);
  });

  it("rebases a stored artifact's uri onto the live document directory (heals a rotated container)", async () => {
    // Simulate a manifest written under an OLD container UUID (an app update/reinstall rotated it).
    const stale = {
      walkId: "walk-1",
      dealId: "deal-1",
      projectId: null,
      startedAt: 1000,
      endedAt: 5000,
      durationMs: 4000,
      enqueuedAt: 1000,
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
    await enqueueWalk(OWNER, "walk-1", completedWalk(), 1000);
    const [walk] = await getQueuedWalks(OWNER);
    expect(walk!.artifacts.map((a) => a.uri).sort()).toEqual([AUDIO_URI, STILL_URI, VIDEO_URI].sort());
  });
});

describe("drainWalkQueue", () => {
  it("uploads media before stills, confirms, deletes the local file, and prunes the completed walk", async () => {
    const walk = completedWalk();
    seedFiles([AUDIO_URI, VIDEO_URI, STILL_URI]);
    await enqueueWalk(OWNER, "walk-1", walk, 1000);

    const kindsSeen: string[] = [];
    const client = stubClient({
      requestUploadUrl: jest.fn(async (_f, req) => {
        kindsSeen.push(req.kind);
        return { uploadUrl: "https://upload.test/x", objectKey: `k-${req.kind}`, uploadToken: "t" };
      }),
    });

    const summary = await drainWalkQueue(OWNER, fetcher, client);

    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.remainingWalks).toBe(0);
    expect(Object.keys(summary.confirmedArtifactIds)).toHaveLength(3);
    // Audio + video (order 0) both precede the still (order 1).
    expect(kindsSeen.slice(0, 2).sort()).toEqual(["audio", "video"]);
    expect(kindsSeen[2]).toBe("still");

    // Every local file is gone, and the whole walk is pruned from the manifest.
    expect(fs.__store.has(AUDIO_URI)).toBe(false);
    expect(fs.__store.has(VIDEO_URI)).toBe(false);
    expect(fs.__store.has(STILL_URI)).toBe(false);
    expect(await getQueuedWalks(OWNER)).toEqual([]);
  });

  it("never deletes the local file when the server PUT fails, and bumps the attempt count for retry", async () => {
    const walk = completedWalk();
    seedFiles([AUDIO_URI, VIDEO_URI, STILL_URI]);
    await enqueueWalk(OWNER, "walk-1", walk, 1000);

    uploadAsyncMock.mockResolvedValue({ status: 500 }); // R2 PUT fails for every artifact
    const client = stubClient();

    const summary = await drainWalkQueue(OWNER, fetcher, client);

    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(3);
    // The rule that matters: a local artifact is NEVER deleted until the server confirms it.
    expect(fs.__store.has(AUDIO_URI)).toBe(true);
    expect(fs.__store.has(VIDEO_URI)).toBe(true);
    expect(fs.__store.has(STILL_URI)).toBe(true);
    // confirmArtifactUpload must never be reached when the PUT itself failed.
    expect(client.confirmArtifactUpload).not.toHaveBeenCalled();

    const [remaining] = await getQueuedWalks(OWNER);
    expect(remaining!.artifacts.every((a) => a.attempts === 1)).toBe(true);
    expect(remaining!.artifacts.every((a) => a.uploadedAt === undefined)).toBe(true);
  });

  it("a resumed drain (some artifacts already confirmed) only re-sends what's outstanding", async () => {
    const walk = completedWalk();
    seedFiles([AUDIO_URI, VIDEO_URI, STILL_URI]);
    await enqueueWalk(OWNER, "walk-1", walk, 1000);

    // First drain succeeds for audio + video (both order 0, drained first) but fails the still.
    uploadAsyncMock.mockResolvedValueOnce({ status: 200 });
    uploadAsyncMock.mockResolvedValueOnce({ status: 200 });
    uploadAsyncMock.mockResolvedValueOnce({ status: 500 }); // the still fails
    const client = stubClient();
    const first = await drainWalkQueue(OWNER, fetcher, client);
    expect(first.succeeded).toBe(2);
    expect(first.failed).toBe(1);
    expect(first.remainingWalks).toBe(1); // the walk stays queued — the still is still outstanding

    // Confirm the audio/video files were already cleaned up, but the still's was not.
    expect(fs.__store.has(AUDIO_URI)).toBe(false);
    expect(fs.__store.has(VIDEO_URI)).toBe(false);
    expect(fs.__store.has(STILL_URI)).toBe(true);

    // Second drain: only the still is drainable now; a fresh client call count proves audio/video
    // are never re-sent.
    uploadAsyncMock.mockResolvedValue({ status: 200 });
    const requestCallsBefore = (client.requestUploadUrl as jest.Mock).mock.calls.length;
    const second = await drainWalkQueue(OWNER, fetcher, client);
    expect(second.succeeded).toBe(1);
    expect(second.remainingWalks).toBe(0);
    expect((client.requestUploadUrl as jest.Mock).mock.calls.length).toBe(requestCallsBefore + 1);
    expect((client.requestUploadUrl as jest.Mock).mock.calls[requestCallsBefore]![1].kind).toBe("still");
  });

  it("reports an empty summary and touches nothing when the queue is empty", async () => {
    const client = stubClient();
    const summary = await drainWalkQueue(OWNER, fetcher, client);
    expect(summary).toEqual({ succeeded: 0, failed: 0, remainingWalks: 0, confirmedArtifactIds: {} });
    expect(client.requestUploadUrl).not.toHaveBeenCalled();
  });
});

describe("getSchedulableWalkCount / getFailedWalkCount", () => {
  it("counts drainable walks as schedulable, and reports 0 failed while retries remain", async () => {
    await enqueueWalk(OWNER, "walk-1", completedWalk(), 1000);
    expect(await getSchedulableWalkCount(OWNER)).toBe(1);
    expect(await getFailedWalkCount(OWNER)).toBe(0);
  });
});
