import {
  applyGpsToPending,
  buildCaptureUploadInput,
  effectiveCaption,
  reconcileUploadGps,
  type SessionPhoto,
} from "../session-photo";

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
  const photo = (key: string, takenAt: string): SessionPhoto => ({ key, clientUploadId: `cu-${key}`, uri: `u-${key}`, metadata: { takenAt }, caption: "" });
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

describe("reconcileUploadGps (scope the upload fix to the shot's camera session)", () => {
  const fix = { latitude: 32.7, longitude: -96.8, addressSource: "live_gps" as const, takenAt: "x" };
  const shot = (cameraSession: number | undefined, geotagged = false): SessionPhoto => ({
    key: "k",
    clientUploadId: "cu-k",
    uri: "u",
    caption: "",
    cameraSession,
    metadata: geotagged ? { latitude: 1, longitude: 2, takenAt: "t" } : { takenAt: "t" },
  });

  it("geotags a session-1 shot with session-1's fix (keeps its takenAt)", () => {
    expect(reconcileUploadGps(shot(1), fix, 1)).toMatchObject({
      latitude: 32.7,
      longitude: -96.8,
      addressSource: "live_gps",
      takenAt: "t",
    });
  });

  it("does NOT geotag an earlier-session shot with a later session's fix", () => {
    const p = shot(1);
    expect(reconcileUploadGps(p, fix, 2)).toBe(p.metadata); // unchanged
  });

  it("leaves already-geotagged shots and library imports (no cameraSession) untouched", () => {
    const geotagged = shot(1, true);
    expect(reconcileUploadGps(geotagged, fix, 1)).toBe(geotagged.metadata);
    const imported = shot(undefined);
    expect(reconcileUploadGps(imported, fix, 1)).toBe(imported.metadata);
  });

  it("is a no-op when the fix has no coordinates", () => {
    const p = shot(1);
    expect(reconcileUploadGps(p, { takenAt: "x" }, 1)).toBe(p.metadata);
    expect(reconcileUploadGps(p, null, 1)).toBe(p.metadata);
  });
});

// THE core correctness of document-as-you-go: the note a crew dictates for a shot
// must ride with THAT shot and never bleed onto another, all the way to the upload
// payload. This is the single mapping upload() uses for every photo.
describe("buildCaptureUploadInput (per-photo note attaches to the RIGHT photo)", () => {
  const photo = (over: Partial<SessionPhoto>): SessionPhoto => ({
    key: "k",
    clientUploadId: "cu-k",
    uri: "file://x.jpg",
    metadata: { takenAt: "t" },
    caption: "",
    ...over,
  });
  const ctx = (over: Partial<Parameters<typeof buildCaptureUploadInput>[1]> = {}) => ({
    target: { dealId: "d1" },
    category: "Roof",
    tags: ["north"],
    batchCaption: "site walk",
    sessionGps: null,
    gpsSession: null,
    ...over,
  });

  it("keeps each photo's own caption + uri together; un-captioned photos inherit the batch", () => {
    const a = photo({ key: "sp-1", uri: "file://A.jpg", caption: "cracked flashing, NE corner" });
    const b = photo({ key: "sp-2", uri: "file://B.jpg", caption: "" });

    const inA = buildCaptureUploadInput(a, ctx());
    const inB = buildCaptureUploadInput(b, ctx());

    expect(inA).toMatchObject({ uri: "file://A.jpg", caption: "cracked flashing, NE corner" });
    expect(inB).toMatchObject({ uri: "file://B.jpg", caption: "site walk" });
    // Batch metadata threads through unchanged on every photo.
    expect(inA).toMatchObject({ target: { dealId: "d1" }, category: "Roof", tags: ["north"] });
  });

  it("maps a whole batch positionally — note[i] stays with photo[i], no bleed", () => {
    const photos = [
      photo({ uri: "0", caption: "zero" }),
      photo({ uri: "1", caption: "" }),
      photo({ uri: "2", caption: "two" }),
    ];
    const inputs = photos.map((p) => buildCaptureUploadInput(p, ctx({ batchCaption: "fallback" })));
    expect(inputs.map((i) => i.uri)).toEqual(["0", "1", "2"]);
    expect(inputs.map((i) => i.caption)).toEqual(["zero", "fallback", "two"]);
  });

  it("emits null caption when the photo and the batch are both blank", () => {
    expect(buildCaptureUploadInput(photo({ caption: "  " }), ctx({ batchCaption: "" })).caption).toBeNull();
  });

  it("reconciles a resolved session GPS into the matching session's ungeotagged shot", () => {
    const fix = { latitude: 32.7, longitude: -96.8, addressSource: "live_gps" as const, takenAt: "x" };
    const shot = photo({ caption: "c", cameraSession: 2, metadata: { takenAt: "t" } });
    const input = buildCaptureUploadInput(shot, ctx({ sessionGps: fix, gpsSession: 2 }));
    expect(input.metadata).toMatchObject({ latitude: 32.7, longitude: -96.8, takenAt: "t" });
    // ...but a different session's shot is left as-is.
    const other = photo({ caption: "c", cameraSession: 1, metadata: { takenAt: "t" } });
    expect(buildCaptureUploadInput(other, ctx({ sessionGps: fix, gpsSession: 2 })).metadata.latitude).toBeUndefined();
  });
});
