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
jest.mock("../upload", () => {
  const actual = jest.requireActual("../concurrency");
  return {
    runConcurrentUploads: actual.runConcurrentUploads,
    UploadCancelledError: class UploadCancelledError extends Error {},
    uploadCapture: jest.fn(async (_fetcher: unknown, item: { clientUploadId: string }) => {
      mockUploadedOrder.push(item.clientUploadId);
      if (mockGate) await mockGate.promise;
      return { photo: { id: `file-${item.clientUploadId}` } };
    }),
  };
});

import * as FileSystem from "expo-file-system/legacy";
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
});

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
    await Promise.resolve();
    await Promise.resolve();

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
