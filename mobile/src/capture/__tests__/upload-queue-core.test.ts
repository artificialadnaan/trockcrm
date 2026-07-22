import {
  MAX_UPLOAD_ATTEMPTS,
  applyGpsPatch,
  bumpAttempts,
  collectEnqueueResults,
  createAsyncMutex,
  createBoundedRunner,
  dedupeQueue,
  isDrainable,
  isSchedulable,
  isStagingFileName,
  isTerminal,
  newClientUploadId,
  partitionResults,
  removeIds,
  sanitizeOwnerKey,
  selectOrphanFiles,
  selectUploadFetcher,
  shouldRouteUploadByTarget,
  uploadOwnerKey,
  type QueuedUpload,
} from "../upload-queue-core";

// Minimal queued item — only clientUploadId/attempts matter for the pure helpers.
function item(clientUploadId: string, attempts = 0): QueuedUpload {
  return {
    clientUploadId,
    uri: `file://${clientUploadId}.jpg`,
    target: {},
    category: null,
    caption: null,
    tags: [],
    metadata: {},
    enqueuedAt: 0,
    attempts,
  } as QueuedUpload;
}

describe("upload-queue-core", () => {
  it("newClientUploadId returns distinct, prefixed ids", () => {
    const a = newClientUploadId();
    const b = newClientUploadId();
    expect(a).toMatch(/^cu-/);
    expect(a).not.toBe(b);
  });

  it("dedupeQueue appends only ids not already queued", () => {
    const existing = [item("a"), item("b")];
    const incoming = [item("b"), item("c")];
    expect(dedupeQueue(existing, incoming).map((i) => i.clientUploadId)).toEqual(["a", "b", "c"]);
  });

  it("removeIds drops the given ids and keeps the rest", () => {
    const queue = [item("a"), item("b"), item("c")];
    expect(removeIds(queue, ["b"]).map((i) => i.clientUploadId)).toEqual(["a", "c"]);
    expect(removeIds(queue, ["a", "c"]).map((i) => i.clientUploadId)).toEqual(["b"]);
  });

  it("sanitizeOwnerKey makes a path-safe segment and never collapses to a shared empty path", () => {
    expect(sanitizeOwnerKey("user-123_ABC")).toBe("user-123_ABC");
    expect(sanitizeOwnerKey("a/b\\c .d")).toBe("a_b_c__d");
    expect(sanitizeOwnerKey("")).toBe("anon");
  });

  it("uploadOwnerKey scopes by user + office, and is empty without a user", () => {
    expect(uploadOwnerKey("u1", "office-a")).toBe("u1:office-a");
    expect(uploadOwnerKey("u1", null)).toBe("u1:");
    expect(uploadOwnerKey(null, "office-a")).toBe("");
    expect(uploadOwnerKey("u1", "office-a")).not.toBe(uploadOwnerKey("u1", "office-b"));
  });

  it("routes only explicitly marked edit evidence by target", () => {
    expect(shouldRouteUploadByTarget(item("legacy"))).toBe(false);
    expect(shouldRouteUploadByTarget({ ...item("ordinary"), routeByTarget: false })).toBe(false);
    expect(shouldRouteUploadByTarget({ ...item("edit"), routeByTarget: true })).toBe(true);

    const officePinnedFetcher = { name: "office-pinned" };
    const targetFetcher = { name: "target-resolved" };
    expect(selectUploadFetcher(item("legacy"), officePinnedFetcher, targetFetcher)).toBe(officePinnedFetcher);
    expect(
      selectUploadFetcher({ ...item("ordinary"), routeByTarget: false }, officePinnedFetcher, targetFetcher),
    ).toBe(officePinnedFetcher);
    expect(
      selectUploadFetcher({ ...item("edit"), routeByTarget: true }, officePinnedFetcher, targetFetcher),
    ).toBe(targetFetcher);
    expect(selectUploadFetcher({ ...item("edit-offline"), routeByTarget: true }, officePinnedFetcher)).toBe(
      officePinnedFetcher,
    );
  });

  it("isDrainable / bumpAttempts implement the terminal retry cap", () => {
    expect(isDrainable(item("a", 0))).toBe(true);
    expect(isDrainable(item("a", MAX_UPLOAD_ATTEMPTS - 1))).toBe(true);
    expect(isDrainable(item("a", MAX_UPLOAD_ATTEMPTS))).toBe(false);

    const queue = [item("a", 0), item("b", 1)];
    const bumped = bumpAttempts(queue, ["a"], 1234);
    expect(bumped[0]).toMatchObject({ clientUploadId: "a", attempts: 1, lastTriedAt: 1234 });
    expect(bumped[1]).toMatchObject({ clientUploadId: "b", attempts: 1 }); // untouched
  });

  it("isDrainable excludes rows still mid-enqueue-staging (so the drain can't double-compress)", () => {
    // A fresh original persisted before compression finishes is NON-drainable until `staging` is cleared.
    expect(isDrainable({ ...item("a", 0), staging: true })).toBe(false);
    // Cleared / absent staging drains normally (a legacy or committed row has no `staging` field).
    expect(isDrainable({ ...item("a", 0), staging: false })).toBe(true);
    expect(isDrainable(item("a", 0))).toBe(true);
    // Staging never RESURRECTS a terminal row — the retry cap still wins.
    expect(isDrainable({ ...item("a", MAX_UPLOAD_ATTEMPTS), staging: false })).toBe(false);
  });

  it("isTerminal keys the failed count on retries-exhausted, NOT the transient staging state", () => {
    expect(isTerminal(item("a", MAX_UPLOAD_ATTEMPTS))).toBe(true);
    expect(isTerminal(item("a", MAX_UPLOAD_ATTEMPTS - 1))).toBe(false);
    expect(isTerminal(item("a", 0))).toBe(false);
    // A mid-enqueue staging row is non-drainable but NOT terminal — it must never be counted/cleared as failed.
    expect(isTerminal({ ...item("a", 0), staging: true })).toBe(false);
    expect(isDrainable({ ...item("a", 0), staging: true })).toBe(false);
  });

  it("isSchedulable counts drainable AND mid-enqueue staging rows (so a lone staging row still triggers a drain)", () => {
    // Drainable rows are schedulable.
    expect(isSchedulable(item("a", 0))).toBe(true);
    expect(isSchedulable({ ...item("a", 0), staging: false })).toBe(true);
    // A mid-enqueue staging row is NOT drainable, but IS schedulable — the drain's reconciliation unsticks it,
    // so a lone interrupted capture must still schedule a drain (finding 2). This is the key divergence from
    // isDrainable.
    expect(isDrainable({ ...item("a", 0), staging: true })).toBe(false);
    expect(isSchedulable({ ...item("a", 0), staging: true })).toBe(true);
    // A terminal (retries-exhausted) row is neither drainable NOR schedulable — it only surfaces for dismissal.
    expect(isSchedulable(item("a", MAX_UPLOAD_ATTEMPTS))).toBe(false);
    expect(isSchedulable({ ...item("a", MAX_UPLOAD_ATTEMPTS), staging: true })).toBe(false);
  });

  it("isStagingFileName recognizes only queue staging files", () => {
    expect(isStagingFileName("cu-abc.orig")).toBe(true);
    expect(isStagingFileName("cu-abc.jpg")).toBe(true);
    expect(isStagingFileName("index.json")).toBe(false);
    expect(isStagingFileName("index.json.tmp")).toBe(false);
    expect(isStagingFileName("index.json.bak")).toBe(false);
  });

  it("selectOrphanFiles reclaims unreferenced staging files but never the live/index ones", () => {
    // 'a' committed to its .jpg (its .orig sibling is a leftover); 'b' still on .orig (mid-fallback).
    const queue: QueuedUpload[] = [
      { ...item("a"), uri: "file:///queue/o1/a.jpg" },
      { ...item("b"), uri: "file:///queue/o1/b.orig" },
    ];
    const onDisk = [
      "a.jpg", // referenced by 'a' → keep
      "a.orig", // 'a' switched away from it → orphan
      "b.orig", // referenced by 'b' → keep
      "c.jpg", // no row at all (killed mid-copy before the row landed) → orphan
      "index.json", // never a staging file → keep
      "index.json.bak",
    ];
    expect(selectOrphanFiles(onDisk, queue).sort()).toEqual(["a.orig", "c.jpg"]);
  });

  it("selectOrphanFiles keeps everything when every staging file is referenced", () => {
    const queue: QueuedUpload[] = [{ ...item("a"), uri: "file:///queue/o1/a.jpg" }];
    expect(selectOrphanFiles(["a.jpg", "index.json"], queue)).toEqual([]);
  });

  it("partitionResults splits succeeded vs failed by settled status (positional)", () => {
    const items = [item("a"), item("b"), item("c")];
    const results: Array<PromiseSettledResult<unknown>> = [
      { status: "fulfilled", value: 1 },
      { status: "rejected", reason: new Error("x") },
      { status: "fulfilled", value: 3 },
    ];
    expect(partitionResults(items, results)).toEqual({ succeededIds: ["a", "c"], failedIds: ["b"] });
  });

  it("collectEnqueueResults returns queued items in order and drops skipped (null) entries", () => {
    const a = item("a");
    const c = item("c");
    const settled: Array<PromiseSettledResult<QueuedUpload | null>> = [
      { status: "fulfilled", value: a },
      { status: "fulfilled", value: null }, // skipped: already queued
      { status: "fulfilled", value: c },
    ];
    expect(collectEnqueueResults(settled)).toEqual([a, c]);
  });

  it("collectEnqueueResults rethrows the first rejection even when later items succeeded", () => {
    const boom = new Error("copy failed");
    const settled: Array<PromiseSettledResult<QueuedUpload | null>> = [
      { status: "fulfilled", value: item("a") },
      { status: "rejected", reason: boom },
      { status: "fulfilled", value: item("c") },
    ];
    expect(() => collectEnqueueResults(settled)).toThrow(boom);
  });

  it("collectEnqueueResults returns [] for an empty batch", () => {
    expect(collectEnqueueResults([])).toEqual([]);
  });
});

describe("createAsyncMutex", () => {
  it("serializes read-modify-write so concurrent tasks can't clobber a shared snapshot", async () => {
    const run = createAsyncMutex();
    // Shared cell mutated read → await → write. Without serialization both tasks read 0 and write 1.
    let cell = 0;
    const rmw = async () => {
      const snapshot = cell;
      await Promise.resolve(); // yield: lets an interleaving task run if unserialized
      cell = snapshot + 1;
    };
    await Promise.all([run(rmw), run(rmw), run(rmw)]);
    expect(cell).toBe(3);
  });

  it("preserves enqueue order (FIFO)", async () => {
    const run = createAsyncMutex();
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => run(async () => { await Promise.resolve(); order.push(n); })));
    expect(order).toEqual([1, 2, 3]);
  });

  it("a throwing task rejects to its caller but does not wedge the chain", async () => {
    const run = createAsyncMutex();
    await expect(run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // The next task still runs after the failure.
    await expect(run(async () => 42)).resolves.toBe(42);
  });

  it("returns each task's resolved value", async () => {
    const run = createAsyncMutex();
    const [a, b] = await Promise.all([run(async () => "a"), run(async () => "b")]);
    expect([a, b]).toEqual(["a", "b"]);
  });

  describe("applyGpsPatch", () => {
    const coords = { latitude: 32.7, longitude: -96.8, addressSource: "live_gps" as const };

    it("fills coords onto a coordless item and reports changed", () => {
      const { queue, changed } = applyGpsPatch([item("a")], "a", coords);
      expect(changed).toBe(true);
      expect(queue[0].metadata).toMatchObject({ latitude: 32.7, longitude: -96.8, addressSource: "live_gps" });
    });

    it("never overwrites an item that already has coords", () => {
      const existing = [{ ...item("a"), metadata: { latitude: 1, longitude: 2, addressSource: "exif" as const } }];
      const { queue, changed } = applyGpsPatch(existing, "a", coords);
      expect(changed).toBe(false);
      expect(queue).toBe(existing); // same reference — no rewrite
      expect(queue[0].metadata).toMatchObject({ latitude: 1, longitude: 2 });
    });

    it("is a no-op when the id is absent (already uploaded/removed)", () => {
      const existing = [item("a")];
      const { queue, changed } = applyGpsPatch(existing, "missing", coords);
      expect(changed).toBe(false);
      expect(queue).toBe(existing);
    });

    it("patches only the matching id, leaving siblings untouched", () => {
      const { queue, changed } = applyGpsPatch([item("a"), item("b")], "b", coords);
      expect(changed).toBe(true);
      expect(queue[0].metadata).toEqual({});
      expect(queue[1].metadata).toMatchObject({ latitude: 32.7, longitude: -96.8 });
    });
  });

  describe("createBoundedRunner", () => {
    it("runs at most `max` tasks concurrently across calls and drains the rest", async () => {
      const run = createBoundedRunner(2);
      let active = 0;
      let peak = 0;
      const task = () =>
        run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        });
      await Promise.all([task(), task(), task(), task(), task()]);
      expect(peak).toBe(2); // never more than 2 in flight, even with 5 queued
    });

    it("frees a slot even when a task throws", async () => {
      const run = createBoundedRunner(1);
      await expect(run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
      // The slot must be released — a follow-up task still runs.
      await expect(run(async () => "ok")).resolves.toBe("ok");
    });
  });
});
