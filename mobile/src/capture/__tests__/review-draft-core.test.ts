import {
  addManifestItem,
  patchManifestCaption,
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

describe("review-draft-core: removeManifestItems (drops only matching keys)", () => {
  it("drops the given keys and keeps the rest in order", () => {
    const items = [item({ key: "a" }), item({ key: "b" }), item({ key: "c" })];
    expect(removeManifestItems(items, ["b"]).map((i) => i.key)).toEqual(["a", "c"]);
    expect(removeManifestItems(items, ["a", "c"]).map((i) => i.key)).toEqual(["b"]);
  });

  it("is a no-op when no key matches", () => {
    const items = [item({ key: "a" })];
    expect(removeManifestItems(items, ["missing"]).map((i) => i.key)).toEqual(["a"]);
  });
});

describe("review-draft-core: patchManifestCaption (sets caption on the matching key only)", () => {
  it("sets the caption on the matching key and reports changed", () => {
    const { items, changed } = patchManifestCaption([item({ key: "a" })], "a", "north wall");
    expect(changed).toBe(true);
    expect(items[0].caption).toBe("north wall");
  });

  it("patches only the matching key, leaving siblings untouched", () => {
    const { items, changed } = patchManifestCaption(
      [item({ key: "a", caption: "keep" }), item({ key: "b" })],
      "b",
      "only b",
    );
    expect(changed).toBe(true);
    expect(items[0].caption).toBe("keep");
    expect(items[1].caption).toBe("only b");
  });

  it("is a no-op (same reference) when the caption is unchanged", () => {
    const existing = [item({ key: "a", caption: "same" })];
    const { items, changed } = patchManifestCaption(existing, "a", "same");
    expect(changed).toBe(false);
    expect(items).toBe(existing);
  });

  it("is a no-op (same reference) when the key is absent", () => {
    const existing = [item({ key: "a" })];
    const { items, changed } = patchManifestCaption(existing, "missing", "x");
    expect(changed).toBe(false);
    expect(items).toBe(existing);
  });
});
