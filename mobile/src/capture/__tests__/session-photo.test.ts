import { effectiveCaption } from "../session-photo";

describe("effectiveCaption (individual overrides batch)", () => {
  it("uses the per-photo caption when set", () => {
    expect(effectiveCaption("caption A", "batch")).toBe("caption A");
  });

  it("falls back to the batch caption when the photo has none", () => {
    expect(effectiveCaption("", "batch caption")).toBe("batch caption");
    expect(effectiveCaption("   ", "batch caption")).toBe("batch caption");
  });

  it("trims, and a per-photo caption overrides the batch even when batch is set", () => {
    expect(effectiveCaption("  A  ", "B")).toBe("A");
  });

  it("returns null when neither is set", () => {
    expect(effectiveCaption("", "")).toBeNull();
    expect(effectiveCaption("  ", "  ")).toBeNull();
  });

  it("models the round-trip scenario: photo A keeps its own, photo B inherits batch", () => {
    const batch = "site walk 6/11";
    const photoA = "cracked flashing, NE corner";
    const photoB = "";
    expect(effectiveCaption(photoA, batch)).toBe("cracked flashing, NE corner");
    expect(effectiveCaption(photoB, batch)).toBe("site walk 6/11");
  });
});
