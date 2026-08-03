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
    // Ranged base64 reads are real API surface here, not decoration: upload.ts walks an mp4's
    // top-level box chain 16 bytes at a time to decide whether AVAssetWriter ever finalized the
    // container, and it must never pull a multi-GB video into memory to answer that. Modelled
    // byte-per-char — every fixture that goes through this path is built with String.fromCharCode,
    // so slicing chars IS slicing bytes.
    readAsStringAsync: async (
      p: string,
      options?: { encoding?: string; position?: number; length?: number },
    ) => {
      if (!store.has(p)) throw new Error(`ENOENT ${p}`);
      const raw = store.get(p)!;
      if (options?.encoding !== "base64") return raw;
      const from = options.position ?? 0;
      const to = options.length === undefined ? undefined : from + options.length;
      return Buffer.from(raw.slice(from, to), "binary").toString("base64");
    },
    writeAsStringAsync: async (p: string, data: string) => {
      store.set(p, data);
    },
    // Recursive for a DIRECTORY path, like the real one: `deleteAsync` on a directory removes it
    // and everything beneath it in a single call. Modelled here because the cleanup path now
    // deletes the walk DIRECTORY, not just the artifact uris the manifest happens to list, and a
    // mock that only removed the exact key would let a test pass while the real leak survived.
    // The failure injection is recursive for the same reason it is on-device: a directory whose
    // child cannot be removed cannot itself be removed either, so a `failDeletes` entry rejects
    // both its own delete and its parent's.
    deleteAsync: async (p: string) => {
      if (failDeletes.has(p)) throw new Error(`EBUSY ${p}`);
      const prefix = `${norm(p)}/`;
      for (const f of failDeletes) if (f.startsWith(prefix)) throw new Error(`EBUSY ${f}`);
      store.delete(p);
      sizes.delete(p);
      dirs.delete(p);
      dirs.delete(norm(p));
      for (const key of [...store.keys()]) {
        if (key.startsWith(prefix)) {
          store.delete(key);
          sizes.delete(key);
        }
      }
      for (const d of [...dirs]) if (norm(d).startsWith(prefix)) dirs.delete(d);
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
import { ApiError } from "../../api/client";
import { initialWalk, reduceWalk, type Walk } from "../session";
import {
  MAX_DRAIN_PASSES,
  claimWalkDirForOwner,
  drainWalkQueue,
  enqueueRecoveredWalk,
  enqueueWalk,
  findRecoverableWalks,
  forgetRecoverableWalksAtStartup,
  forgetRecoveredWalk,
  getFailedWalkCount,
  getQueuedWalks,
  getRecoverableWalkCount,
  getRecoverableWalksFromStartup,
  getSchedulableWalkCount,
  retryFailedWalks,
  scanRecoverableWalksAtStartup,
  subscribeRecoverableWalksFromStartup,
  type RecoveredWalk,
  type WalkArtifactUploadUrlResponse,
  type WalkCompletionResponse,
  type WalkQueueMeta,
  type WalkthroughUploadClient,
} from "../upload";
import { sanitizeWalkOwnerKey } from "../upload-core";
import { noteWalkStarted, noteWalkTeardown } from "../walk-teardown";

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
/** A SECOND signed-in identity on the same device — a different manifest namespace entirely, which
 *  is the whole point wherever it appears below: nothing one owner's drain does can move the
 *  other's queue. */
const OWNER_2 = "user-2:office-b";
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

// ── walk.mp4 fixtures: a container the writer FINISHED, and one it did not ─────────────────────────
//
// The difference is one box. AVAssetWriter creates walk.mp4 at startWriting and appends samples into
// `mdat` as they arrive; the `moov` index — without which nothing can play the file — is written only
// by finishWriting. So a walk killed mid-recording leaves a file that EXISTS, is large, and has no
// moov. "There is a walk.mp4 on disk" and "there is a recording" are therefore different facts, and
// these fixtures are what lets the suite state them apart.

/** One top-level box: 32-bit size, 4-char type, zero-filled payload. */
function mp4Box(type: string, payloadBytes: number): string {
  const size = 8 + payloadBytes;
  const header = String.fromCharCode((size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff);
  return `${header}${type}${"\0".repeat(payloadBytes)}`;
}

/** The 64-bit form (`size` field == 1, real length in the 8 bytes after the type) — what a real
 *  walk's `mdat` uses once the media outgrows 4 GiB, and a shape the box walk has to understand or
 *  it would reject every long recording as unfinalized. */
function mp4Box64(type: string, payloadBytes: number): string {
  const size = 16 + payloadBytes;
  return `${String.fromCharCode(0, 0, 0, 1)}${type}${String.fromCharCode(0, 0, 0, 0, (size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff)}${"\0".repeat(payloadBytes)}`;
}

/** walk.mp4 as `endWalk` leaves one it finished: the moov is there, after the media. */
const FINALIZED_MP4 = mp4Box("ftyp", 24) + mp4Box("mdat", 4096) + mp4Box("moov", 512);
/** walk.mp4 as an app kill leaves one: header and media, and no moov anywhere. */
const UNFINALIZED_MP4 = mp4Box("ftyp", 24) + mp4Box("mdat", 4096);

/**
 * Stamp a walk directory with the account that recorded it, exactly as `claimWalkDirForOwner` does
 * on device. Split out so a test can seed a walk belonging to somebody ELSE, or deliberately seed
 * one with no marker at all.
 */
function seedWalkOwner(walkId: string, owner: string = OWNER): void {
  fs.__store.set(`${DOC}walkthroughs/${walkId}/owner`, sanitizeWalkOwnerKey(owner));
}

/** The walkId a `${DOC}walkthroughs/<walkId>/...` uri belongs to. */
function walkIdFromUri(uri: string): string {
  return uri.slice(`${DOC}walkthroughs/`.length).split("/")[0]!;
}

/**
 * Seed one walk directory's `walk.mp4` with real container bytes, sized from those bytes — and its
 * owner marker, because on device the marker is written BEFORE native creates the directory, so a
 * walk.mp4 that exists without one is a state no real recording can reach. Seeding the video alone
 * would model a device that cannot exist and quietly make every recovery test a test of the
 * unowned-directory path. Tests that want an unowned or foreign-owned directory say so explicitly
 * (see the ownership describe below).
 */
function seedVideoFile(uri: string, bytes: string = FINALIZED_MP4): void {
  fs.__store.set(uri, bytes);
  fs.__sizes.set(uri, bytes.length);
  seedWalkOwner(walkIdFromUri(uri));
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
  it("treats an ALREADY_FILED presign refusal as a completed PUT, not a failure", async () => {
    // The server refuses to re-presign an artifact it has already filed: the R2 key is deterministic, so
    // a second PUT would silently replace the bytes behind a record whose size, checksum and derived
    // scope all describe the OLD content. For this queue that refusal is SUCCESS reported as an error.
    //
    // Without the branch under test, the artifact burns all five PUT attempts and the walk lands on the
    // failed-walk card telling the estimator their site visit did not send — for a walk the server is
    // holding in full. Matched on the error CODE, not the 409: the completion route also answers 409 for
    // a genuine cross-deal conflict, which must still fail.
    const walk = completedWalk();
    seedFiles([VIDEO_URI, PHOTO_URI]);
    await enqueueWalk(OWNER, "walk-1", walk, META, 1000);

    const client = stubClient({
      requestUploadUrl: jest.fn(async (_f, _dealId, req) => {
        if (req.kind === "video") {
          throw new ApiError(
            "Artifact walk-1:video is already filed against this deal.",
            409,
            "GLASSES_WALKTHROUGH_ARTIFACT_ALREADY_FILED",
          );
        }
        return { uploadUrl: "https://upload.test/x", r2Key: `k-${req.kind}`, expiresIn: 900 };
      }),
    });

    const summary = await drainWalkQueue(OWNER, fetcher, client);

    // The walk completes and is pruned — not retried, not failed.
    expect(summary.completed).toBe(1);
    expect(await getQueuedWalks(OWNER)).toHaveLength(0);
    // And the completion call still names the video, because the server has it.
    const completeArgs = (client.completeWalk as jest.Mock).mock.calls[0]![2] as { artifacts: { kind: string }[] };
    expect(completeArgs.artifacts.map((a) => a.kind).sort()).toEqual(["photo", "video"]);
  });


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

  /** Let every already-resolved promise in the in-memory FS chain run to completion. Needed because
   *  a drain started for the WAITING owner is deliberately detached (the finishing drain must not
   *  wait on someone else's multi-GB upload before resolving), so there is no promise to await. */
  async function settle(ticks = 20): Promise<void> {
    for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // Coalescing into the RUNNING drain only works for that drain's own owner: it re-reads one
  // manifest, and a different signed-in identity has a different one. Recording nothing for the
  // other owner therefore dropped their request outright — and the new shell has already spent its
  // one mount trigger, so nothing else was going to ask again until a foreground transition or an
  // opportunistic background window.
  it("starts the OTHER owner's drain once the lock frees, instead of dropping a request it can't serve", async () => {
    seedFiles([VIDEO_URI, PHOTO_URI, VIDEO_URI_2, PHOTO_URI_2]);
    await enqueueWalk(OWNER, "walk-1", completedWalk(), META, 1000);
    // The second user's own walk, queued under their own manifest by an earlier session.
    await enqueueWalk(OWNER_2, "walk-2", completedWalk({ video: VIDEO_URI_2, photo: PHOTO_URI_2 }), META, 2000);

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
    await firstPutReached.promise; // owner 1 is parked inside a multi-GB PUT

    // Owner 2 signs in; their shell's mount effect asks for a drain. It cannot run now, and the
    // running drain cannot serve it.
    const deferredRequest = await drainWalkQueue(OWNER_2, fetcher, client);
    expect(deferredRequest.puts).toBe(0);
    expect(deferredRequest.remainingWalks).toBe(1);

    releaseFirstPut.resolve();
    await firstDrain;
    await settle();

    // The load-bearing assertion: owner 2's queue was actually emptied, by a drain nobody asked for
    // a second time.
    expect(await getQueuedWalks(OWNER_2)).toEqual([]);
    expect(fs.__store.has(VIDEO_URI_2)).toBe(false);
    expect(fs.__store.has(PHOTO_URI_2)).toBe(false);
    expect((client.completeWalk as jest.Mock).mock.calls.map((c) => c[2].walkId)).toEqual([
      "walk-1",
      "walk-2",
    ]);
    // Owner 1's drain is unaffected — the follow-up runs AFTER it released the lock, never inside it.
    expect(await getQueuedWalks(OWNER)).toEqual([]);
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

// A walk whose FINALIZATION failed after stills were already captured. toQueuedWalk deliberately
// queues only the stills and excludes the provisional walk.mp4 (a "failed" walk's videoUri is never
// a finalised file), so the manifest's artifact list is a STRICT SUBSET of what native left on
// disk — the one shape where "delete the artifacts" and "delete the recording" are different
// instructions.
describe("cleanup of a walk whose manifest lists fewer files than are on disk", () => {
  // The exact name native writes (WalkthroughRecorder.swift's `dir.appendingPathComponent`), not
  // the `video.mp4` the rest of this file uses: classifyWalkDirFileNames only recognises `walk.mp4`,
  // and the whole point here is what the NEXT startup scan sees.
  const PARTIAL_VIDEO_URI = `${DOC}walkthroughs/walk-1/walk.mp4`;

  function failedAfterStillWalk(): Walk {
    const started = reduceWalk(reduceWalk(initialWalk("deal-1", "proj-7"), { type: "starting" }), {
      type: "started",
      at: 1000,
      videoUri: PARTIAL_VIDEO_URI,
    });
    const withStill = reduceWalk(started, {
      type: "still",
      uri: PHOTO_URI,
      at: 2000,
      source: "glasses",
    });
    const ended = reduceWalk(withStill, { type: "ended", at: 5000 });
    return reduceWalk(ended, { type: "failed", reason: "finishWriting failed" });
  }

  it("removes the whole walk directory, so the abandoned walk.mp4 is not rediscovered as a recoverable recording at the next startup", async () => {
    seedFiles([PHOTO_URI, PARTIAL_VIDEO_URI]);
    await enqueueWalk(OWNER, "walk-1", failedAfterStillWalk(), META, 1000);
    // Precondition, not decoration: the mp4 really is absent from the manifest, which is what makes
    // an artifact-list-driven cleanup leave it behind.
    expect((await getQueuedWalks(OWNER))[0]!.artifacts.map((a) => a.kind)).toEqual(["photo"]);

    const summary = await drainWalkQueue(OWNER, fetcher, stubClient());
    expect(summary.completed).toBe(1);
    expect(await getQueuedWalks(OWNER)).toEqual([]);

    // The leak: with the entry gone, nothing in the manifest can ever account for this file again,
    // and the startup scan reports its directory as a NEW unqueued recording on every launch,
    // forever — a walk the server has in fact already accepted.
    expect(fs.__store.has(PARTIAL_VIDEO_URI)).toBe(false);
    expect(await findRecoverableWalks(OWNER)).toEqual([]);
  });

  // The directory delete must obey the same rule as the artifact deletes: a rejection means media is
  // still on the phone, so the entry stays and a later drain tries again.
  it("keeps the entry when the directory itself cannot be removed", async () => {
    seedFiles([PHOTO_URI, PARTIAL_VIDEO_URI]);
    await enqueueWalk(OWNER, "walk-1", failedAfterStillWalk(), META, 1000);
    fs.__failDeletes.add(PARTIAL_VIDEO_URI); // the undeletable file is one the manifest never lists

    const first = await drainWalkQueue(OWNER, fetcher, stubClient());
    expect(first.completed).toBe(0);
    expect((await getQueuedWalks(OWNER))[0]!.completedAt).toBeDefined(); // never re-completed

    fs.__failDeletes.delete(PARTIAL_VIDEO_URI);
    const second = await drainWalkQueue(OWNER, fetcher, stubClient());
    expect(second.completed).toBe(1);
    expect(fs.__store.has(PARTIAL_VIDEO_URI)).toBe(false);
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
    seedVideoFile(`${orphanDir}walk.mp4`);
    fs.__store.set(`${orphanDir}still-002.jpg`, "b");
    fs.__store.set(`${orphanDir}still-001.jpg`, "a");

    const recovered = await findRecoverableWalks(OWNER);
    expect(recovered).toEqual([
      {
        walkId: "walk-orphan",
        videoUri: `${orphanDir}walk.mp4`,
        stillUris: [`${orphanDir}still-001.jpg`, `${orphanDir}still-002.jpg`],
        unfinishedVideo: false,
        // Unknown here, and reported as unknown: this mock stores no mtimes for these files.
        recordedAtMs: null,
        captureSpanMs: null,
      },
    ]);
    expect(await getRecoverableWalkCount(OWNER)).toBe(1);
  });

  // The estimator has to pick which job an orphan belongs to, and the ONLY evidence on disk that
  // narrows that down is when the bytes were written. Without it the choice is blind — and a walk
  // filed against the wrong project is worse than one left unfiled, because nothing catches it
  // until a scope comes back describing the wrong building.
  it("reports the walk's own recorded time and capture span, read from the files' timestamps", async () => {
    const orphanDir = `${DOC}walkthroughs/walk-orphan/`;
    seedVideoFile(`${orphanDir}walk.mp4`);
    fs.__mtimes.set(`${orphanDir}walk.mp4`, 1_700_000_720); // epoch SECONDS, as expo-file-system reports
    fs.__store.set(`${orphanDir}still-001.jpg`, "a");
    fs.__mtimes.set(`${orphanDir}still-001.jpg`, 1_700_000_000);

    const [recovered] = await findRecoverableWalks(OWNER);
    // The LAST byte written across the directory — for a killed app that is when capture stopped.
    expect(recovered!.recordedAtMs).toBe(1_700_000_720_000); // seconds → ms
    // First write to last write: a lower bound on how long the walk ran, never a fabricated duration.
    expect(recovered!.captureSpanMs).toBe(720_000);
  });

  it("reports both as unknown rather than substituting `now` when the platform has no timestamps", async () => {
    seedVideoFile(`${DOC}walkthroughs/walk-orphan/walk.mp4`);
    const [recovered] = await findRecoverableWalks(OWNER);
    // "Recorded just now" for a walk that happened two days ago would send the estimator to the
    // wrong job — the same class of harm as guessing the deal outright.
    expect(recovered!.recordedAtMs).toBeNull();
    expect(recovered!.captureSpanMs).toBeNull();
  });

  it("reports no span when a single file carries the only timestamp — one instant is not a duration", async () => {
    const orphanDir = `${DOC}walkthroughs/walk-orphan/`;
    seedVideoFile(`${orphanDir}walk.mp4`);
    fs.__mtimes.set(`${orphanDir}walk.mp4`, 1_700_000_720);

    const [recovered] = await findRecoverableWalks(OWNER);
    expect(recovered!.recordedAtMs).toBe(1_700_000_720_000);
    expect(recovered!.captureSpanMs).toBeNull();
  });

  it("excludes a directory whose walkId is already tracked in the manifest, even though its files are still on disk", async () => {
    const walk = completedWalk();
    seedFiles([VIDEO_URI, PHOTO_URI]); // walk-1's directory has real files too
    await enqueueWalk(OWNER, "walk-1", walk, META, 1000);
    seedVideoFile(`${DOC}walkthroughs/walk-orphan/walk.mp4`);

    const recovered = await findRecoverableWalks(OWNER);
    expect(recovered.map((r) => r.walkId)).toEqual(["walk-orphan"]); // walk-1 excluded; it's already tracked
  });

  // ── Round-8 FINDING 2 (P1): an orphan for one owner can be another owner's live upload ─────────
  //
  // Documents/walkthroughs/ is written by native, which has no concept of the signed-in user+office
  // this queue namespaces manifests by. The scan compared it against the CURRENT owner's manifest
  // only, so after an account or active-office switch every walk the previous identity had queued —
  // including one mid-drain — read as recoverable to the new one. Filing it then enqueued the same
  // on-disk uris under a SECOND manifest, and whichever drain finished first deleted the walk
  // directory out from under the other: one owner's completion call left pointing at bytes that are
  // gone, on a phone where those bytes were the only copy.
  //
  // The asymmetry is structural and cannot be wished away, so the reconciliation runs the other
  // direction: a directory is an orphan only when NO manifest on this device claims it.
  it("does not report a walk another signed-in owner already has queued", async () => {
    const dir = `${DOC}walkthroughs/walk-1/`;
    seedVideoFile(`${dir}walk.mp4`);
    await enqueueWalk(OWNER, "walk-1", completedWalk({ video: `${dir}walk.mp4`, photo: PHOTO_URI }), META, 1000);

    // The new identity's own manifest is empty, which is exactly why the directory looked orphaned.
    expect(await getQueuedWalks(OWNER_2)).toEqual([]);
    expect(await findRecoverableWalks(OWNER_2)).toEqual([]);
    expect(await getRecoverableWalkCount(OWNER_2)).toBe(0);
  });

  it("does not let a second owner file a walk the first owner is still draining", async () => {
    const dir = `${DOC}walkthroughs/walk-1/`;
    seedVideoFile(`${dir}walk.mp4`);
    fs.__store.set(`${dir}still-001.jpg`, "a");
    fs.__sizes.set(`${dir}still-001.jpg`, 512);
    await enqueueWalk(OWNER, "walk-1", completedWalk({ video: `${dir}walk.mp4`, photo: `${dir}still-001.jpg` }), META, 1000);
    // Owner 1's drain gets its bytes up but not its completion, so the walk stays queued with real
    // progress on it — the window where a second owner filing the same files does the most damage.
    await drainWalkQueue(OWNER, fetcher, stubClient({ completeWalk: jest.fn(async () => { throw new Error("500"); }) }));

    expect(await findRecoverableWalks(OWNER_2)).toEqual([]);
    // Owner 1 still owns it, alone, with its upload progress intact.
    expect(await getQueuedWalks(OWNER_2)).toEqual([]);
    expect((await getQueuedWalks(OWNER))[0]!.artifacts.every((a) => a.putAt !== undefined)).toBe(true);
  });

  // The case recovery EXISTS for, and the one a cross-owner exclusion must not swallow: sign-out
  // leaves a finalized walk with no manifest entry under ANY owner, because the enqueue effect died
  // with the shell before it ever ran. Nobody claims it, so it is still the same user's to recover.
  it("still recovers a walk that sign-out orphaned, for the same user signing back in", async () => {
    seedVideoFile(`${DOC}walkthroughs/walk-at-signout/walk.mp4`);
    await enqueueWalk(OWNER, "walk-earlier", completedWalk(), META, 1000); // an unrelated, claimed walk

    const recovered = await findRecoverableWalks(OWNER);
    expect(recovered.map((r) => r.walkId)).toEqual(["walk-at-signout"]);
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

  // ── Round-8 FINDING 1 (P1): a walk.mp4 that exists is not a walk.mp4 that plays ─────────────────
  //
  // AVAssetWriter creates the file at startWriting, so the crash this whole path exists to survive —
  // an app kill DURING recording — leaves a walk.mp4 that is present, large, and missing the moov
  // atom finishWriting would have appended. toQueuedWalk is strict about exactly this (a video
  // artifact is only ever built from `walk.state === "complete"`, the one state native reaches by
  // confirming the writer hit .completed), and the recovery scan bypassed that judgement entirely:
  // presence of the filename WAS the test. So recovery could hand the office a file that will not
  // open, arriving as a successfully-filed site visit — the exact outcome WalkthroughRecorder's
  // finalize path rejects rather than resolves for, and the reason it rejects.
  describe("a walk.mp4 the writer never finalized", () => {
    const orphanDir = `${DOC}walkthroughs/walk-orphan/`;

    it("is not offered as a recording, while the stills beside it are still recovered in full", async () => {
      seedVideoFile(`${orphanDir}walk.mp4`, UNFINALIZED_MP4);
      fs.__store.set(`${orphanDir}still-001.jpg`, "a");
      fs.__store.set(`${orphanDir}still-002.jpg`, "b");

      const [recovered] = await findRecoverableWalks(OWNER);

      expect(recovered!.videoUri).toBeNull();
      // Reported, not merely dropped: the card has to be able to say the video is unusable rather
      // than claim there was never one, which is a different (and false) statement about a walk the
      // estimator remembers recording.
      expect(recovered!.unfinishedVideo).toBe(true);
      // The photos are the load-bearing half. A site visit cannot be re-taken from a desk, so
      // discarding real evidence along with the bad video would turn one loss into two.
      expect(recovered!.stillUris).toEqual([`${orphanDir}still-001.jpg`, `${orphanDir}still-002.jpg`]);
    });

    it("still dates the walk from the unusable file's own timestamp — the kill moment is evidence", async () => {
      seedVideoFile(`${orphanDir}walk.mp4`, UNFINALIZED_MP4);
      fs.__mtimes.set(`${orphanDir}walk.mp4`, 1_700_000_720); // epoch SECONDS
      fs.__store.set(`${orphanDir}still-001.jpg`, "a");
      fs.__mtimes.set(`${orphanDir}still-001.jpg`, 1_700_000_000);

      const [recovered] = await findRecoverableWalks(OWNER);
      // The last byte written to a killed recording IS when capture stopped, and it is the only clue
      // on disk to WHICH job this was. Refusing to upload the file is not a reason to forget when it
      // was written.
      expect(recovered!.recordedAtMs).toBe(1_700_000_720_000);
      expect(recovered!.captureSpanMs).toBe(720_000);
    });

    it("is not offered at all when it is the only thing in the directory", async () => {
      seedVideoFile(`${orphanDir}walk.mp4`, UNFINALIZED_MP4);
      // Nothing here can be filed, so a row for it could only ever offer the estimator a project
      // picker that ends in an empty upload. Same rule as a directory that classifies to nothing.
      expect(await findRecoverableWalks(OWNER)).toEqual([]);
      expect(await getRecoverableWalkCount(OWNER)).toBe(0);
    });

    it("is not offered when the writer created the file and never wrote a sample into it", async () => {
      seedVideoFile(`${orphanDir}walk.mp4`, "");
      fs.__store.set(`${orphanDir}still-001.jpg`, "a");

      const [recovered] = await findRecoverableWalks(OWNER);
      // Size is a weak signal in general — a killed ten-minute recording is enormous and still
      // unplayable — but an empty file is decided by size alone and never needs a read.
      expect(recovered!.videoUri).toBeNull();
      expect(recovered!.unfinishedVideo).toBe(true);
    });

    it("does not mistake a long recording's 64-bit mdat for a truncated container", async () => {
      // Once the media outgrows what a 32-bit box length can address, `mdat` switches to the
      // largesize form. A box walk that could not read that would reject every long walk on the
      // phone — the ones that matter most — as unfinalized.
      seedVideoFile(`${orphanDir}walk.mp4`, mp4Box("ftyp", 24) + mp4Box64("mdat", 4096) + mp4Box("moov", 512));

      const [recovered] = await findRecoverableWalks(OWNER);
      expect(recovered!.videoUri).toBe(`${orphanDir}walk.mp4`);
      expect(recovered!.unfinishedVideo).toBe(false);
    });

    it("is not offered when the media box claims more bytes than the file actually holds", async () => {
      // The shape a kill leaves most often: the writer had already stamped an mdat length it never
      // got to fill. Following it walks straight past the end of the file, which is precisely the
      // proof that nothing follows the media — no moov, no playable video.
      seedVideoFile(`${orphanDir}walk.mp4`, (mp4Box("ftyp", 24) + mp4Box("mdat", 4096)).slice(0, 1000));
      fs.__store.set(`${orphanDir}still-001.jpg`, "a");

      const [recovered] = await findRecoverableWalks(OWNER);
      expect(recovered!.videoUri).toBeNull();
      expect(recovered!.unfinishedVideo).toBe(true);
    });

    it("is not offered when the moov box claims more bytes than the file actually holds", async () => {
      // The exact window this whole check exists for. AVAssetWriter writes a box's HEADER before its
      // body, so a kill DURING finishWriting leaves a moov that announces itself and then stops —
      // and a scan that answered on the header alone would call that file finalized and hand the
      // office a video that opens to nothing, which is worse than reporting no video at all.
      seedVideoFile(`${orphanDir}walk.mp4`, FINALIZED_MP4.slice(0, FINALIZED_MP4.length - 400));
      fs.__store.set(`${orphanDir}still-001.jpg`, "a");

      const [recovered] = await findRecoverableWalks(OWNER);
      expect(recovered!.videoUri).toBeNull();
      expect(recovered!.unfinishedVideo).toBe(true);
    });

    it("files only the stills when the estimator picks a project for it", async () => {
      seedVideoFile(`${orphanDir}walk.mp4`, UNFINALIZED_MP4);
      fs.__store.set(`${orphanDir}still-001.jpg`, "a");
      fs.__sizes.set(`${orphanDir}still-001.jpg`, 512);

      const [recovered] = await findRecoverableWalks(OWNER);
      const queued = await enqueueRecoveredWalk(OWNER, recovered!, "deal-99", null, META, 5000);

      // The whole harm in one assertion: an unplayable file must never reach the completion call,
      // where it becomes a `files` row the office opens expecting a site walk.
      expect(queued!.artifacts.map((a) => a.kind)).toEqual(["photo"]);
      const summary = await drainWalkQueue(OWNER, fetcher, stubClient());
      expect(summary.completed).toBe(1);
      // Cleanup still takes the whole directory, so the unusable file does not resurface as a fresh
      // orphan on every launch for the rest of the phone's life.
      expect(fs.__store.has(`${orphanDir}walk.mp4`)).toBe(false);
    });
  });

  // ── Round-9 FINDING 2 (P1): the scan races a teardown this same process is still running ───────
  //
  // Every other case here is a directory nobody is touching — an app kill writes nothing more, so
  // reading it once and freezing the verdict is honest. Sign-out is the one interruption that leaves
  // this process alive: useWalk's unmount fires Recorder.endWalk() DETACHED (the hook and its screen
  // are already gone, so there is nothing left to await it), and native finalizes on a background
  // Task afterwards. Sign back in before that lands — seconds, on the same device — and the new
  // shell's scan reads walk.mp4 before its moov exists and records "unfinished" for a recording that
  // was about to be perfectly valid. The snapshot is deliberately taken once per shell lifecycle, so
  // that wrong answer is the answer for the whole session.
  describe("a walk whose native teardown is still running", () => {
    it("waits it out rather than freezing a verdict on a file mid-finishWriting", async () => {
      const dir = `${DOC}walkthroughs/walk-signout/`;
      seedVideoFile(`${dir}walk.mp4`, UNFINALIZED_MP4); // the moov has not been appended yet
      fs.__store.set(`${dir}still-001.jpg`, "a");

      let finishWriting!: () => void;
      const teardown = new Promise<void>((resolve) => {
        finishWriting = () => {
          seedVideoFile(`${dir}walk.mp4`, FINALIZED_MP4); // what native was in the middle of doing
          resolve();
        };
      });
      noteWalkTeardown("walk-signout", teardown);

      const scan = findRecoverableWalks(OWNER);
      // Late enough that a scan which did not wait has already read the file and answered.
      const landing = setTimeout(finishWriting, 20);
      const [recovered] = await scan;
      clearTimeout(landing);

      expect(recovered!.videoUri).toBe(`${dir}walk.mp4`);
      expect(recovered!.unfinishedVideo).toBe(false);
    });

    it("leaves a directory out of the answer entirely when the teardown never finishes", async () => {
      // The bounded wait has to end somewhere, and what it must NOT do at the end is guess. Both
      // halves of this directory are still unsettled — native's awaitPendingStills can drop another
      // still-NNN.jpg into it seconds after the last video byte — so there is no field the scan
      // could fill in honestly. Omitting it costs one session's visibility; the files are untouched
      // and the next launch, with nothing in flight, classifies them correctly.
      jest.useFakeTimers();
      const dir = `${DOC}walkthroughs/walk-wedged/`;
      seedVideoFile(`${dir}walk.mp4`, UNFINALIZED_MP4);
      fs.__store.set(`${dir}still-001.jpg`, "a");
      let release!: () => void;
      noteWalkTeardown(
        "walk-wedged",
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      try {
        const scan = findRecoverableWalks(OWNER);
        await jest.advanceTimersByTimeAsync(120_000);
        expect(await scan).toEqual([]);
      } finally {
        release(); // never leave a pending claim behind for the rest of the file
        jest.useRealTimers();
        await Promise.resolve();
      }
    });
  });

  // ── Round-10 FINDING 1 (P1): the teardown wait let a LIVE walk into the answer ──────────────────
  //
  // The wait above is right and stays, but it happens while the authenticated shell is already on
  // screen and usable — up to fifteen seconds of it. Start a walk in that window and the resumed
  // scan meets a directory with no manifest entry (an active walk is not enqueued until terminal)
  // and no teardown claim (it is starting, not ending), and calls the recording under the
  // estimator's nose an orphan. That is the exact false positive the scan-once-at-mount rule exists
  // to prevent, arrived at the long way round: the answer no longer describes the moment the caller
  // guaranteed, because the scan outlived it.
  //
  // And the row is not just a label. Filing one from Profile uploads what it can see, completes, and
  // cleanup deletes the walk DIRECTORY — so the snapshot's frozen answer is a live grenade: a walk
  // still being recorded gets its video and its remaining stills deleted while the estimator walks
  // the site. That is why the walk being recorded is excluded at BOTH ends (here, and at the filing
  // itself, below): a snapshot held for a whole shell lifecycle cannot be the last word on whether
  // its rows are still true.
  describe("a walk that starts while the scan is running", () => {
    it("leaves the live recording out, and still reports the orphan it was called for", async () => {
      const orphan = `${DOC}walkthroughs/walk-old/`;
      seedVideoFile(`${orphan}walk.mp4`); // left by a previous launch — a real orphan
      const live = `${DOC}walkthroughs/walk-live/`;

      let finishTeardown!: () => void;
      noteWalkTeardown(
        "walk-signout",
        new Promise<void>((resolve) => {
          finishTeardown = () => resolve();
        }),
      );

      const scan = findRecoverableWalks(OWNER);
      await Promise.resolve(); // the scan is now parked on the teardown wait
      // The estimator taps Start and captures a still. native creates walkthroughs/<walkId>/ during
      // startWalk, which is why the id is claimed BEFORE the call rather than when it resolves.
      noteWalkStarted("walk-live");
      seedVideoFile(`${live}walk.mp4`, UNFINALIZED_MP4);
      fs.__store.set(`${live}still-001.jpg`, "a");
      finishTeardown();

      expect((await scan).map((w) => w.walkId)).toEqual(["walk-old"]);
      // The recorder slot is process-global, so hand it back before the next case scans against a
      // walk this one left recording.
      noteWalkTeardown("walk-live", Promise.resolve());
    });

    // A walk already recording when the scan is CALLED, not one that starts during it. Not reachable
    // from today's shell (the effect that scans runs once per authenticated mount, and every walk
    // screen lives under it), but the scan's precondition is a fact about its caller and this is the
    // one function that pays for it being wrong — with the estimator's live recording.
    it("leaves out a walk native is already recording when it is called", async () => {
      const dir = `${DOC}walkthroughs/walk-in-progress/`;
      seedVideoFile(`${dir}walk.mp4`, UNFINALIZED_MP4);
      fs.__store.set(`${dir}still-001.jpg`, "a");
      noteWalkStarted("walk-in-progress");

      expect(await findRecoverableWalks(OWNER)).toEqual([]);
      noteWalkTeardown("walk-in-progress", Promise.resolve());
    });

    // The other end, and the one that decides whether this is a fix or a smaller window: the snapshot
    // is frozen for a whole shell lifecycle, so a row can be acted on long after it stopped being
    // true. Filing is what deletes — upload, complete, then remove the whole walk directory — so the
    // refusal has to live at the filing itself, not only at the scan that produced the row.
    it("refuses to FILE a walk native is recording, so a stale row cannot delete a live site visit", async () => {
      const dir = `${DOC}walkthroughs/walk-in-progress-2/`;
      const still = `${dir}still-001.jpg`;
      seedFiles([still]);
      noteWalkStarted("walk-in-progress-2");
      const stale: RecoveredWalk = {
        walkId: "walk-in-progress-2",
        videoUri: null, // the video is not finalized yet — it is still being written
        stillUris: [still],
        unfinishedVideo: true,
        recordedAtMs: null,
        captureSpanMs: null,
      };

      await expect(enqueueRecoveredWalk(OWNER, stale, "deal-1", null, META)).rejects.toThrow(
        /still recording/,
      );
      // Nothing queued means nothing to drain, and therefore nothing that deletes the directory.
      expect(await getQueuedWalks(OWNER)).toEqual([]);
      noteWalkTeardown("walk-in-progress-2", Promise.resolve());
    });

    // GUARD (passes before the fix too, which excluded nothing at all): "recording" ends where the
    // teardown registry begins. An endWalk issued for the walk hands the directory over to the wait
    // above, so a walk this process started is recoverable again the moment native is let go of —
    // otherwise a wedged teardown would keep it off the recovery card even after the budget that
    // exists to bound exactly that gave up on it.
    it("reports the same walk once an endWalk has been issued for it", async () => {
      const dir = `${DOC}walkthroughs/walk-was-live/`;
      seedVideoFile(`${dir}walk.mp4`);
      noteWalkStarted("walk-was-live");
      noteWalkTeardown("walk-was-live", Promise.resolve());

      expect((await findRecoverableWalks(OWNER)).map((w) => w.walkId)).toEqual(["walk-was-live"]);
    });
  });
});

// The snapshot the recovery card reads. It is taken once per authenticated-shell lifecycle, NOT
// once per process: the scan is only trustworthy while nothing could be recording, and entering the
// shell is exactly that moment. Caching it for the whole process instead is what these cover — a
// second sign-in in the same process (the app was never killed, so a module variable survives it)
// would keep serving the first sign-in's answer, and a walk finalized on the way out of the
// previous session — which useWalk's unmount does precisely so it can be recovered at the next
// login — stayed invisible until the process itself restarted.
describe("scanRecoverableWalksAtStartup across shell lifecycles", () => {
  beforeEach(() => {
    forgetRecoverableWalksAtStartup();
  });

  it("rescans after the shell tears down, so a same-process re-login sees what sign-out left behind", async () => {
    await scanRecoverableWalksAtStartup(OWNER);
    expect(getRecoverableWalksFromStartup()).toEqual([]);

    // Sign-out. useWalk's unmount stops native, which finalizes the in-progress recording into
    // Documents/walkthroughs/<walkId>/ — files with no manifest entry, i.e. exactly what the next
    // login's scan exists to find.
    seedVideoFile(`${DOC}walkthroughs/walk-at-signout/walk.mp4`);
    forgetRecoverableWalksAtStartup();

    await scanRecoverableWalksAtStartup(OWNER);
    expect(getRecoverableWalksFromStartup().map((w) => w.walkId)).toEqual(["walk-at-signout"]);
  });

  it("rescans for a different owner — a snapshot taken under another identity is not an answer for this one", async () => {
    await scanRecoverableWalksAtStartup(OWNER);
    expect(getRecoverableWalksFromStartup()).toEqual([]);

    // An account switch, with an orphan on disk that the first owner's scan predates — and one
    // OWNER_2 actually recorded, or ownership would (correctly) withhold it regardless of caching.
    // Serving the cached answer would hide it from the person now signed in, and each owner's
    // manifest is a different namespace, so the previous scan is not an answer that transfers.
    seedVideoFile(`${DOC}walkthroughs/walk-orphan/walk.mp4`);
    seedWalkOwner("walk-orphan", OWNER_2);

    await scanRecoverableWalksAtStartup(OWNER_2);
    expect(getRecoverableWalksFromStartup().map((w) => w.walkId)).toEqual(["walk-orphan"]);
  });

  // ── Ownership: a recording belongs to the account that made it ──────────────────────────────────
  //
  // The manifest cannot answer this and never could. A walk interrupted by sign-out is deliberately
  // never enqueued, so it has no entry under ANY owner — the exact case recovery exists for. Reading
  // "absent from every manifest" as "unowned" meant that on a shared device the next estimator to
  // sign in was offered the previous one's site footage, with a project picker attached, and could
  // file it against any deal they could select. Nothing on disk contradicted them.
  it("does not offer one account's recording to another account that signs in on the same device", async () => {
    seedVideoFile(`${DOC}walkthroughs/walk-of-owner-1/walk.mp4`);
    seedWalkOwner("walk-of-owner-1", OWNER);

    // OWNER_2 signs in on the shared phone. The directory is in no manifest — not theirs, not
    // OWNER's — which is precisely the shape that used to read as "free to claim".
    expect(await findRecoverableWalks(OWNER_2)).toEqual([]);
    expect(await getRecoverableWalkCount(OWNER_2)).toBe(0);

    // ...and it is still recoverable by the account that actually recorded it.
    expect((await findRecoverableWalks(OWNER)).map((w) => w.walkId)).toEqual(["walk-of-owner-1"]);
  });

  it("offers an unattributable recording to nobody rather than to whoever is signed in", async () => {
    // No owner marker at all: a directory from a build that predates markers, or a process killed
    // between native creating the directory and the marker landing. There is no evidence of who
    // recorded it, and the only account available to guess in favour of is whoever happens to be
    // here now — which is the exposure, not a recovery. The bytes are untouched either way: this
    // scan only ever declines to LIST them, so a build that knows better can still surface them,
    // whereas footage filed under the wrong account cannot be recalled.
    fs.__store.set(`${DOC}walkthroughs/walk-unmarked/walk.mp4`, FINALIZED_MP4);
    fs.__sizes.set(`${DOC}walkthroughs/walk-unmarked/walk.mp4`, FINALIZED_MP4.length);

    expect(await findRecoverableWalks(OWNER)).toEqual([]);
    expect(await findRecoverableWalks(OWNER_2)).toEqual([]);
    // The recording itself is untouched — declining to offer it is not deleting it.
    expect(fs.__store.has(`${DOC}walkthroughs/walk-unmarked/walk.mp4`)).toBe(true);
  });

  it("stamps the owner before the recorder is asked for anything, so a kill mid-start still attributes", async () => {
    // claimWalkDirForOwner runs BEFORE Recorder.startWalk (see useWalk), so by the time native can
    // create or write a single byte the marker is already on disk. Asserting the marker exists
    // independently of any artifact is asserting exactly that ordering: there is no window in which
    // a directory holds a recording but no owner.
    await claimWalkDirForOwner(OWNER, "walk-just-started");
    expect(fs.__store.get(`${DOC}walkthroughs/walk-just-started/owner`)).toBe(sanitizeWalkOwnerKey(OWNER));

    // A claim with no artifacts yet is not offered as a recoverable walk — there is nothing to file.
    expect(await findRecoverableWalks(OWNER)).toEqual([]);
  });

  it("keeps the snapshot for repeat calls within one lifecycle — the scan stays a once-per-shell cost", async () => {
    seedVideoFile(`${DOC}walkthroughs/walk-orphan/walk.mp4`);
    await scanRecoverableWalksAtStartup(OWNER);
    const first = getRecoverableWalksFromStartup();

    // A second call for the SAME owner must not re-walk the filesystem: the answer is only
    // trustworthy as of shell entry, and re-taking it later is how a LIVE recording gets reported
    // as an orphan (it has no manifest entry either until it goes terminal).
    seedVideoFile(`${DOC}walkthroughs/walk-recording-now/walk.mp4`, UNFINALIZED_MP4);
    await scanRecoverableWalksAtStartup(OWNER);
    expect(getRecoverableWalksFromStartup()).toBe(first); // identity: nothing re-scanned, nothing republished
  });

  it("drops the snapshot when the shell tears down, so nothing renders an answer the module no longer holds", async () => {
    seedVideoFile(`${DOC}walkthroughs/walk-orphan/walk.mp4`);
    await scanRecoverableWalksAtStartup(OWNER);
    expect(getRecoverableWalksFromStartup()).toHaveLength(1);

    forgetRecoverableWalksAtStartup();
    expect(getRecoverableWalksFromStartup()).toEqual([]);
  });
});

describe("enqueueRecoveredWalk", () => {
  const orphanDir = `${DOC}walkthroughs/walk-orphan/`;

  it("files a recovered walk under the caller-supplied deal, and it then drains exactly like any other walk", async () => {
    seedVideoFile(`${orphanDir}walk.mp4`);
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
    seedVideoFile(`${orphanDir}walk.mp4`);
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
    seedWalkOwner("walk-orphan"); // stills-only walk: no seedVideoFile to stamp it
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

// The other half of enqueueRecoveredWalk: once a recovered walk HAS a manifest entry it is no
// longer an orphan, but the recovery snapshot is deliberately frozen for the whole shell lifecycle
// (re-scanning mid-session reports a LIVE recording as orphaned). Without a way to retire one entry
// from that snapshot the recovery card would keep offering a walk it has already filed — and every
// re-file is a fresh chance to pick a DIFFERENT project for a walk the queue already owns.
describe("forgetRecoveredWalk", () => {
  beforeEach(() => {
    forgetRecoverableWalksAtStartup();
  });

  it("retires one filed walk from the snapshot and publishes, leaving the others alone", async () => {
    seedVideoFile(`${DOC}walkthroughs/walk-a/walk.mp4`);
    seedVideoFile(`${DOC}walkthroughs/walk-b/walk.mp4`);
    await scanRecoverableWalksAtStartup(OWNER);
    const notified = jest.fn();
    const unsubscribe = subscribeRecoverableWalksFromStartup(notified);

    forgetRecoveredWalk(OWNER, "walk-a");

    expect(getRecoverableWalksFromStartup().map((w) => w.walkId)).toEqual(["walk-b"]);
    // Published, or the card renders the retired row until something unrelated rerenders it.
    expect(notified).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("never re-scans — a walk recording RIGHT NOW must not be swept into the snapshot", async () => {
    seedVideoFile(`${DOC}walkthroughs/walk-a/walk.mp4`);
    await scanRecoverableWalksAtStartup(OWNER);
    // Started after the snapshot was taken: it has no manifest entry either, so a re-scan would
    // report the live walk as recoverable and offer to file a recording still being written.
    seedVideoFile(`${DOC}walkthroughs/walk-recording-now/walk.mp4`, UNFINALIZED_MP4);

    forgetRecoveredWalk(OWNER, "walk-a");

    expect(getRecoverableWalksFromStartup()).toEqual([]);
  });

  it("is a no-op for an owner the snapshot was not taken against", async () => {
    seedVideoFile(`${DOC}walkthroughs/walk-a/walk.mp4`);
    await scanRecoverableWalksAtStartup(OWNER);
    const notified = jest.fn();
    const unsubscribe = subscribeRecoverableWalksFromStartup(notified);

    // OWNER_2's manifest is a different namespace; their filing says nothing about OWNER's orphans.
    forgetRecoveredWalk(OWNER_2, "walk-a");

    expect(getRecoverableWalksFromStartup().map((w) => w.walkId)).toEqual(["walk-a"]);
    expect(notified).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("does not publish for a walkId the snapshot never held", async () => {
    seedVideoFile(`${DOC}walkthroughs/walk-a/walk.mp4`);
    await scanRecoverableWalksAtStartup(OWNER);
    const notified = jest.fn();
    const unsubscribe = subscribeRecoverableWalksFromStartup(notified);

    forgetRecoveredWalk(OWNER, "walk-never-seen");

    expect(notified).not.toHaveBeenCalled();
    unsubscribe();
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
