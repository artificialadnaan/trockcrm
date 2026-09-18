/**
 * End-to-end coverage for the REAL drainUploadQueue, against an in-memory FS (same harness shape as
 * upload-queue-rebase.test.ts, which explains why the leaf native modules are stubbed).
 *
 * Two behaviours that only exist once the drain runs from more than one place:
 *
 *   1. ORDER — the newest captures ship first. planDrainOrder is unit-tested on its own; this proves the
 *      drain actually plans through it rather than walking the stored index order.
 *   2. CONCURRENCY — a second caller arriving mid-drain gets `alreadyDraining: true` rather than a summary
 *      that merely looks like a stall. capture.tsx arms a 30s offline backoff on
 *      `succeeded === 0 && remaining > 0`, so without that flag the authenticated shell's foreground
 *      resume would silently freeze the Capture screen's own draining for half a minute.
 */
jest.mock("expo-file-system/legacy", () => {
  const store = new Map<string, string>();
  const dirs = new Set<string>();
  const norm = (p: string) => p.replace(/\/$/, "");
  return {
    __store: store,
    __reset: () => { store.clear(); dirs.clear(); },
    documentDirectory: "file:///doc/",
    getInfoAsync: async (p: string) => ({ exists: store.has(p) || dirs.has(p) || dirs.has(norm(p)) }),
    makeDirectoryAsync: async (d: string) => { dirs.add(d); dirs.add(norm(d)); },
    readDirectoryAsync: async () => [],
    readAsStringAsync: async (p: string) => { if (!store.has(p)) throw new Error(`ENOENT ${p}`); return store.get(p)!; },
    writeAsStringAsync: async (p: string, data: string) => { store.set(p, data); },
    deleteAsync: async (p: string) => { store.delete(p); dirs.delete(p); dirs.delete(norm(p)); },
    moveAsync: async ({ from, to }: { from: string; to: string }) => { store.set(to, store.get(from) ?? ""); store.delete(from); },
    copyAsync: async ({ from, to }: { from: string; to: string }) => { store.set(to, store.get(from) ?? ""); },
  };
});
// Both must return promises: the drain awaits activate and calls .catch() on deactivate.
jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(async () => undefined),
}));

/** Records the order photos were handed to the uploader, and lets a test hold one upload open. */
const mockUploadedOrder: string[] = [];
let mockGate: { promise: Promise<void>; release: () => void } | null = null;
/** When set, every upload attempt rejects with it — used to drive the auth-pause path. */
let mockRejectWith: unknown = null;
/** queueDepth reported to the server per photo — the backlog telemetry. */
const mockReportedDepths: Array<{ id: string; depth: number | undefined }> = [];
jest.mock("../upload", () => {
  const actual = jest.requireActual("../concurrency");
  return {
    runConcurrentUploads: actual.runConcurrentUploads,
    UploadCancelledError: class UploadCancelledError extends Error {},
    uploadCapture: jest.fn(async (
      _fetcher: unknown,
      item: { clientUploadId: string },
      opts?: { queueDepth?: number },
    ) => {
      mockUploadedOrder.push(item.clientUploadId);
      mockReportedDepths.push({ id: item.clientUploadId, depth: opts?.queueDepth });
      if (mockGate) await mockGate.promise;
      if (mockRejectWith) throw mockRejectWith;
      return { photo: { id: `file-${item.clientUploadId}` } };
    }),
  };
});

import * as FileSystem from "expo-file-system/legacy";
import { ApiError } from "../../api/client";
import { drainUploadQueue, getQueuedUploads } from "../upload-queue";

const fs = FileSystem as unknown as { __store: Map<string, string>; __reset: () => void };
const OWNER = "user-1:office-a";
const fetcher = (async () => ({})) as never;

/** Write the queue index directly: enqueueUploads would also compress, which is not what is under test. */
function seedQueue(items: Array<{ id: string; enqueuedAt: number }>) {
  // Must match upload-queue.ts's ownerDir(): `${documentDirectory}upload-queue/${sanitizeOwnerKey(k)}/`.
  const dir = `file:///doc/upload-queue/${OWNER.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  fs.__store.set(
    `${dir}/index.json`,
    JSON.stringify(
      items.map(({ id, enqueuedAt }) => ({
        clientUploadId: id,
        uri: `${dir}/${id}.jpg`,
        target: { dealId: "deal-1" },
        category: null,
        caption: null,
        tags: [],
        metadata: {},
        enqueuedAt,
        attempts: 0,
      })),
    ),
  );
  for (const { id } of items) fs.__store.set(`${dir}/${id}.jpg`, "bytes");
}

beforeEach(() => {
  fs.__reset();
  mockUploadedOrder.length = 0;
  mockGate = null;
  mockRejectWith = null;
  mockReportedDepths.length = 0;
});

/**
 * Wait until the drain has actually STARTED uploading, which is the only reliable proof that it has
 * already taken its plan snapshot.
 *
 * Counting microtask ticks does not work and quietly destroys the test: the drain awaits
 * reconcileOwnerStorage and a locked index read before it plans, so a couple of `await Promise.resolve()`
 * can land BEFORE the snapshot — in which case a photo "added mid-drain" is simply included in pass 1 and
 * the test passes without any coalescing happening at all. (Confirmed: with tick-counting, deleting the
 * coalescing line left all tests green.) uploadCapture records into mockUploadedOrder on entry, so a
 * non-empty order means the plan is fixed.
 */
async function waitForUploadToStart(): Promise<void> {
  for (let i = 0; i < 500 && mockUploadedOrder.length === 0; i += 1) {
    await new Promise<void>((r) => setImmediate(r));
  }
  if (mockUploadedOrder.length === 0) throw new Error("drain never started uploading");
}

/** The queue index as it stands on disk — attempts is what the retry-budget assertions read. */
async function queueRows(): Promise<Array<{ clientUploadId: string; attempts: number }>> {
  return (await getQueuedUploads(OWNER)) as unknown as Array<{ clientUploadId: string; attempts: number }>;
}

describe("drainUploadQueue ordering", () => {
  it("ships the newest captures first, not the stored index order", async () => {
    // Stored oldest-first, which is how dedupeQueue appends them.
    seedQueue([
      { id: "yesterday-a", enqueuedAt: 1_000 },
      { id: "yesterday-b", enqueuedAt: 2_000 },
      { id: "today-a", enqueuedAt: 9_000 },
      { id: "today-b", enqueuedAt: 9_100 },
    ]);

    const summary = await drainUploadQueue(OWNER, fetcher);

    expect(summary.alreadyDraining).toBeUndefined();
    expect(summary.succeeded).toBe(4);
    // Today's work leads. (With 4 items and a backlog share of 4, the 4th slot is the backlog pick.)
    expect(mockUploadedOrder[0]).toBe("today-b");
    expect(mockUploadedOrder[1]).toBe("today-a");
    // Every photo still ships — reordering must not drop the backlog.
    expect([...mockUploadedOrder].sort()).toEqual(["today-a", "today-b", "yesterday-a", "yesterday-b"]);
    expect(await getQueuedUploads(OWNER)).toHaveLength(0);
  });
});

describe("drainUploadQueue concurrency", () => {
  it("reports alreadyDraining to a second caller instead of a summary that looks like a stall", async () => {
    seedQueue([{ id: "p1", enqueuedAt: 1 }, { id: "p2", enqueuedAt: 2 }]);
    let release!: () => void;
    mockGate = { promise: new Promise<void>((r) => { release = () => r(); }), release: () => release() };

    // First drain starts and parks inside uploadCapture, holding the module drain lock.
    const first = drainUploadQueue(OWNER, fetcher);
    await waitForUploadToStart();

    // This is the shell's foreground resume landing while the Capture screen's drain is in flight.
    const second = await drainUploadQueue(OWNER, fetcher);
    expect(second.alreadyDraining).toBe(true);
    expect(second.succeeded).toBe(0);
    // It still reports the real outstanding count, so a caller can show an honest number.
    expect(second.remaining).toBeGreaterThan(0);

    mockGate.release();
    const firstSummary = await first;
    // The parked drain owned the work and finished it; the second call took nothing away from it.
    expect(firstSummary.alreadyDraining).toBeUndefined();
    expect(firstSummary.succeeded).toBe(2);
    // And no photo was uploaded twice by the overlapping calls.
    expect(mockUploadedOrder).toHaveLength(2);
    expect(new Set(mockUploadedOrder).size).toBe(2);
  });
});

describe("drainUploadQueue coalescing", () => {
  it("serves a photo enqueued DURING a drain via a follow-up pass", async () => {
    // The exact race the shell's foreground resume created: a drain is already running (its plan fixed)
    // when the crew takes one more shot. Under a single-pass drain that shot was invisible to the
    // incumbent and its own caller was told "already draining", so it sat queued until some later
    // trigger fired.
    seedQueue([{ id: "in-flight", enqueuedAt: 1 }]);
    let release!: () => void;
    mockGate = { promise: new Promise<void>((r) => { release = () => r(); }), release: () => release() };

    const first = drainUploadQueue(OWNER, fetcher);
    // Must be past the plan snapshot before the new photo appears, or pass 1 would simply include it and
    // the test would prove nothing. See waitForUploadToStart.
    await waitForUploadToStart();
    expect(mockUploadedOrder).toEqual(["in-flight"]);

    // A new capture lands: it goes into the index, and its drain request is coalesced.
    seedQueue([{ id: "in-flight", enqueuedAt: 1 }, { id: "captured-mid-drain", enqueuedAt: 5 }]);
    const second = await drainUploadQueue(OWNER, fetcher);
    expect(second.alreadyDraining).toBe(true);

    mockGate.release();
    const summary = await first;

    // The incumbent picked it up on a second pass rather than leaving it for later.
    expect(mockUploadedOrder).toContain("captured-mid-drain");
    expect(summary.succeeded).toBe(2);
    expect(await queueRows()).toHaveLength(0);
  });

  it("does not coalesce a request for a DIFFERENT owner, whose index a follow-up pass never reads", async () => {
    seedQueue([{ id: "p1", enqueuedAt: 1 }]);
    let release!: () => void;
    mockGate = { promise: new Promise<void>((r) => { release = () => r(); }), release: () => release() };

    const first = drainUploadQueue(OWNER, fetcher);
    await waitForUploadToStart();
    const other = await drainUploadQueue("someone-else:office-b", fetcher);
    expect(other.alreadyDraining).toBe(true);

    mockGate.release();
    await first;
    // Only this owner's photo was touched — a follow-up pass must never drain a namespace it was not for.
    expect(mockUploadedOrder).toEqual(["p1"]);
  });
});

describe("drainUploadQueue auth failures", () => {
  it("pauses WITHOUT spending the retry budget when a request comes back 401", async () => {
    seedQueue([{ id: "a", enqueuedAt: 1 }, { id: "b", enqueuedAt: 2 }, { id: "c", enqueuedAt: 3 }]);
    mockRejectWith = new ApiError("Unauthorized", 401);

    const summary = await drainUploadQueue(OWNER, fetcher);

    expect(summary.authPaused).toBe(true);
    expect(summary.succeeded).toBe(0);
    // THE assertion. The shell drains on every foreground and its fetcher deliberately cannot sign the
    // user out, so if a 401 counted as a failed attempt then five foregrounds under a stale token would
    // take every queued photo terminal (attempts >= MAX_UPLOAD_ATTEMPTS) and drop it out of isDrainable
    // for good — real photos, permanently unsendable, offered only a Dismiss button.
    for (const row of await queueRows()) expect(row.attempts).toBe(0);
    expect(summary.failed).toBe(0);
    // Nothing was removed either: every photo is still there to retry once the token is good.
    expect(await queueRows()).toHaveLength(3);
  });

  it("still counts an ordinary upload failure against the retry budget", async () => {
    seedQueue([{ id: "a", enqueuedAt: 1 }]);
    mockRejectWith = new ApiError("Upload to storage failed (R2 returned 500).", 500);

    const summary = await drainUploadQueue(OWNER, fetcher);

    expect(summary.authPaused).toBeUndefined();
    expect(summary.failed).toBe(1);
    const [row] = await queueRows();
    expect(row.attempts).toBe(1);
  });
});

describe("drainUploadQueue follow-up passes", () => {
  it("does NOT re-attempt a photo this drain already tried, so one drain cannot burn the retry budget", async () => {
    // Offline device, crew still shooting. Pass 1 fails everything; a capture lands mid-drain, which
    // coalesces a follow-up pass. If that pass re-planned the failures too, MAX_DRAIN_PASSES rounds
    // would spend up to 4 of each photo's 5 attempts inside a SINGLE call — invisible to the Capture
    // screen's 30s offline backoff, which cannot see inside one drain — and take recoverable photos
    // terminal and Dismiss-only.
    //
    // The gate is what makes this a follow-up pass rather than two back-to-back drains. Without it the
    // first drain simply finishes before the second call arrives, each gets its own attempted-set, and
    // the test passes while proving nothing (observed: 5 uploads for 3 photos).
    seedQueue([{ id: "a", enqueuedAt: 1 }, { id: "b", enqueuedAt: 2 }]);
    mockRejectWith = new ApiError("R2 unreachable", 0);
    let release!: () => void;
    mockGate = { promise: new Promise<void>((r) => { release = () => r(); }), release: () => release() };

    const first = drainUploadQueue(OWNER, fetcher);
    await waitForUploadToStart();
    seedQueue([
      { id: "a", enqueuedAt: 1 },
      { id: "b", enqueuedAt: 2 },
      { id: "captured-mid-drain", enqueuedAt: 9 },
    ]);
    const second = await drainUploadQueue(OWNER, fetcher);
    expect(second.alreadyDraining).toBe(true); // genuinely coalesced, not a separate drain

    mockGate.release();
    await first;

    // Every photo was handed to the uploader at most ONCE by this drain, however many passes it ran.
    const counts = mockUploadedOrder.reduce<Record<string, number>>((acc, id) => {
      acc[id] = (acc[id] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ a: 1, b: 1, "captured-mid-drain": 1 });
    for (const row of await queueRows()) expect(row.attempts).toBe(1);
  });

  it("reports queue depth per PASS, not cumulative totals minus a pass-local plan", async () => {
    // The bug this pins: `succeeded` is cumulative across coalesced passes while the plan is pass-local,
    // so after a big first pass a follow-up pass computed max(0, small - big) = 0 for every photo. The
    // audit row is written once, at creation, so that zero would be permanent — and precisely for the
    // captures arriving during a long drain, which is exactly what the telemetry exists to reveal.
    // Gated for the same reason as the test above: only a real follow-up pass can exhibit it.
    seedQueue([{ id: "a", enqueuedAt: 1 }, { id: "b", enqueuedAt: 2 }, { id: "c", enqueuedAt: 3 }]);
    let release!: () => void;
    mockGate = { promise: new Promise<void>((r) => { release = () => r(); }), release: () => release() };

    const first = drainUploadQueue(OWNER, fetcher);
    await waitForUploadToStart();
    seedQueue([
      { id: "a", enqueuedAt: 1 },
      { id: "b", enqueuedAt: 2 },
      { id: "c", enqueuedAt: 3 },
      { id: "late-1", enqueuedAt: 9 },
      { id: "late-2", enqueuedAt: 10 },
    ]);
    const second = await drainUploadQueue(OWNER, fetcher);
    expect(second.alreadyDraining).toBe(true);

    mockGate.release();
    await first;

    const late = mockReportedDepths.filter((d) => d.id.startsWith("late-"));
    expect(late).toHaveLength(2);
    // Non-zero: these two were a backlog of two in their own pass. Under the cumulative-vs-pass-local
    // arithmetic this reported 0, permanently, for exactly the captures the telemetry exists to reveal.
    for (const entry of late) expect(entry.depth).toBeGreaterThan(0);
  });

  it("reports the deals it shipped for, including ones only a follow-up pass touched", async () => {
    seedQueue([{ id: "a", enqueuedAt: 1 }]);
    const summary = await drainUploadQueue(OWNER, fetcher);
    // seedQueue targets deal-1 for every row.
    expect(summary.shippedDealIds).toEqual(["deal-1"]);
  });

  it("reports no shipped deals when nothing succeeded", async () => {
    seedQueue([{ id: "a", enqueuedAt: 1 }]);
    mockRejectWith = new ApiError("boom", 500);
    const summary = await drainUploadQueue(OWNER, fetcher);
    expect(summary.shippedDealIds).toEqual([]);
  });
});
