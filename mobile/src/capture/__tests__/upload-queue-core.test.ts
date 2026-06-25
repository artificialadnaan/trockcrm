import {
  dedupeQueue,
  newClientUploadId,
  partitionResults,
  removeIds,
  type QueuedUpload,
} from "../upload-queue-core";

// Minimal queued item — only clientUploadId matters for the pure helpers.
function item(clientUploadId: string): QueuedUpload {
  return {
    clientUploadId,
    uri: `file://${clientUploadId}.jpg`,
    target: {},
    category: null,
    caption: null,
    tags: [],
    metadata: {},
    enqueuedAt: 0,
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
