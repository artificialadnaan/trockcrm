import { applyGpsToPending, effectiveCaption, type SessionPhoto } from "../session-photo";

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

describe("applyGpsToPending (geotag early burst shots when GPS arrives late)", () => {
  const photo = (key: string, takenAt: string): SessionPhoto => ({ key, uri: `u-${key}`, metadata: { takenAt }, caption: "" });
  const fix = { latitude: 32.7, longitude: -96.8, addressSource: "live_gps" as const, takenAt: "later" };

  it("adds the fix's coordinates to pending photos while preserving each shot's own takenAt", () => {
    const photos = [photo("a", "t-a"), photo("b", "t-b")];
    const out = applyGpsToPending(photos, new Set(["a"]), fix);
    expect(out[0].metadata).toMatchObject({ latitude: 32.7, longitude: -96.8, addressSource: "live_gps", takenAt: "t-a" });
    expect(out[1].metadata.latitude).toBeUndefined(); // not pending → untouched
  });

  it("is a no-op when nothing is pending", () => {
    const photos = [photo("a", "t-a")];
    expect(applyGpsToPending(photos, new Set(), fix)).toBe(photos);
  });

  it("is a no-op when the fix has no coordinates", () => {
    const photos = [photo("a", "t-a")];
    expect(applyGpsToPending(photos, new Set(["a"]), { takenAt: "later" })).toBe(photos);
  });
});
