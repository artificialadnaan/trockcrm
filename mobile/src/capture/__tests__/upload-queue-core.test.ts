import {
  MAX_UPLOAD_ATTEMPTS,
  applyGpsPatch,
  bumpAttempts,
  createAsyncMutex,
  dedupeQueue,
  isDrainable,
  newClientUploadId,
  partitionResults,
  removeIds,
  sanitizeOwnerKey,
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

  it("isDrainable / bumpAttempts implement the terminal retry cap", () => {
    expect(isDrainable(item("a", 0))).toBe(true);
    expect(isDrainable(item("a", MAX_UPLOAD_ATTEMPTS - 1))).toBe(true);
    expect(isDrainable(item("a", MAX_UPLOAD_ATTEMPTS))).toBe(false);

    const queue = [item("a", 0), item("b", 1)];
    const bumped = bumpAttempts(queue, ["a"], 1234);
    expect(bumped[0]).toMatchObject({ clientUploadId: "a", attempts: 1, lastTriedAt: 1234 });
    expect(bumped[1]).toMatchObject({ clientUploadId: "b", attempts: 1 }); // untouched
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
});
