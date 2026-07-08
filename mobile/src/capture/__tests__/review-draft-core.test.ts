import {
  addManifestItem,
  patchManifestCaption,
  patchManifestMetadata,
  removeManifestItems,
  type StagedDraftItem,
} from "../review-draft-core";

function item(over: Partial<StagedDraftItem> & { key: string }): StagedDraftItem {
  return {
    clientUploadId: `cu-${over.key}`,
    uri: `file://draft/${over.key}.jpg`,
    metadata: { takenAt: "t" },
    caption: "",
    ctx: { target: { dealId: "d1" }, category: null, tags: [] },
    ...over,
  };
}

describe("review-draft-core: addManifestItem (append, idempotent on clientUploadId)", () => {
  it("appends a new item, preserving order", () => {
    const out = addManifestItem([item({ key: "a" })], item({ key: "b" }));
    expect(out.map((i) => i.key)).toEqual(["a", "b"]);
  });

  it("does NOT duplicate an item whose clientUploadId is already present (same reference)", () => {
    const existing = [item({ key: "a" })];
    const out = addManifestItem(existing, item({ key: "a" }));
    expect(out).toBe(existing);
    expect(out.map((i) => i.key)).toEqual(["a"]);
  });

  it("does not mutate the input array", () => {
    const existing = [item({ key: "a" })];
    addManifestItem(existing, item({ key: "b" }));
    expect(existing.map((i) => i.key)).toEqual(["a"]);
  });
});

describe("review-draft-core: removeManifestItems (drops only matching clientUploadIds)", () => {
  it("drops the given clientUploadIds and keeps the rest in order", () => {
    const items = [item({ key: "a" }), item({ key: "b" }), item({ key: "c" })];
    expect(removeManifestItems(items, ["cu-b"]).map((i) => i.key)).toEqual(["a", "c"]);
    expect(removeManifestItems(items, ["cu-a", "cu-c"]).map((i) => i.key)).toEqual(["b"]);
  });

  it("is a no-op when no clientUploadId matches", () => {
    const items = [item({ key: "a" })];
    expect(removeManifestItems(items, ["cu-missing"]).map((i) => i.key)).toEqual(["a"]);
  });

  // The bug the identity switch fixes: two items can share a session `key` (the per-process sp-N counter
  // restarts at sp-1 each mount, so a recovered prior-process orphan and a fresh photo collide). Removing by
  // clientUploadId must drop ONLY the targeted one — a key-scoped delete would wipe both, destroying the live
  // photo's durable copy.
  it("drops ONLY the targeted item when two share a session key but differ by clientUploadId", () => {
    const orphan = item({ key: "sp-1", clientUploadId: "cu-orphan" });
    const fresh = item({ key: "sp-1", clientUploadId: "cu-fresh" });
    const out = removeManifestItems([orphan, fresh], ["cu-orphan"]);
    expect(out.map((i) => i.clientUploadId)).toEqual(["cu-fresh"]);
  });
});

describe("review-draft-core: patchManifestCaption (sets caption on the matching clientUploadId only)", () => {
  it("sets the caption on the matching clientUploadId and reports changed", () => {
    const { items, changed } = patchManifestCaption([item({ key: "a" })], "cu-a", "north wall");
    expect(changed).toBe(true);
    expect(items[0].caption).toBe("north wall");
  });

  it("patches only the matching clientUploadId, leaving siblings untouched", () => {
    const { items, changed } = patchManifestCaption(
      [item({ key: "a", caption: "keep" }), item({ key: "b" })],
      "cu-b",
      "only b",
    );
    expect(changed).toBe(true);
    expect(items[0].caption).toBe("keep");
    expect(items[1].caption).toBe("only b");
  });

  it("patches ONLY the targeted item when two share a session key but differ by clientUploadId", () => {
    const orphan = item({ key: "sp-1", clientUploadId: "cu-orphan", caption: "orphan" });
    const fresh = item({ key: "sp-1", clientUploadId: "cu-fresh" });
    const { items } = patchManifestCaption([orphan, fresh], "cu-fresh", "north wall");
    expect(items.find((i) => i.clientUploadId === "cu-orphan")!.caption).toBe("orphan");
    expect(items.find((i) => i.clientUploadId === "cu-fresh")!.caption).toBe("north wall");
  });

  it("is a no-op (same reference) when the caption is unchanged", () => {
    const existing = [item({ key: "a", caption: "same" })];
    const { items, changed } = patchManifestCaption(existing, "cu-a", "same");
    expect(changed).toBe(false);
    expect(items).toBe(existing);
  });

  it("is a no-op (same reference) when the clientUploadId is absent", () => {
    const existing = [item({ key: "a" })];
    const { items, changed } = patchManifestCaption(existing, "cu-missing", "x");
    expect(changed).toBe(false);
    expect(items).toBe(existing);
  });
});

describe("review-draft-core: patchManifestMetadata (late GPS fix onto a coordless batch draft shot)", () => {
  it("fills coords + addressSource on the matching clientUploadId, preserving takenAt", () => {
    const { items, changed } = patchManifestMetadata(
      [item({ key: "a", metadata: { takenAt: "t" } })],
      "cu-a",
      { latitude: 32.7, longitude: -96.8, addressSource: "live_gps" },
    );
    expect(changed).toBe(true);
    expect(items[0].metadata).toEqual({ takenAt: "t", latitude: 32.7, longitude: -96.8, addressSource: "live_gps" });
  });

  it("does NOT overwrite an item that already has coordinates (EXIF shot)", () => {
    const existing = [item({ key: "a", metadata: { takenAt: "t", latitude: 1, longitude: 2, addressSource: "exif" } })];
    const { items, changed } = patchManifestMetadata(existing, "cu-a", { latitude: 9, longitude: 9, addressSource: "live_gps" });
    expect(changed).toBe(false);
    expect(items).toBe(existing);
  });

  it("is a no-op (same reference) when the clientUploadId is absent", () => {
    const existing = [item({ key: "a", metadata: { takenAt: "t" } })];
    const { items, changed } = patchManifestMetadata(existing, "cu-missing", { latitude: 1, longitude: 2 });
    expect(changed).toBe(false);
    expect(items).toBe(existing);
  });

  it("patches ONLY the targeted item when two share a session key but differ by clientUploadId", () => {
    const orphan = item({ key: "sp-1", clientUploadId: "cu-orphan", metadata: { takenAt: "t" } });
    const fresh = item({ key: "sp-1", clientUploadId: "cu-fresh", metadata: { takenAt: "t" } });
    const { items } = patchManifestMetadata([orphan, fresh], "cu-fresh", { latitude: 5, longitude: 6, addressSource: "live_gps" });
    expect(items.find((i) => i.clientUploadId === "cu-orphan")!.metadata.latitude).toBeUndefined();
    expect(items.find((i) => i.clientUploadId === "cu-fresh")!.metadata.latitude).toBe(5);
  });
});
