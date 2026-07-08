import {
  applyGpsToPending,
  appendPhotoCaption,
  buildCaptureUploadInput,
  effectiveCaption,
  reconcileUploadGps,
  removePhoto,
  setPhotoCaption,
  type SessionPhoto,
} from "../session-photo";

describe("effectiveCaption (per-photo only — blank means NO description)", () => {
  it("uses the per-photo caption when set", () => {
    expect(effectiveCaption("caption A")).toBe("caption A");
  });

  it("trims the per-photo caption", () => {
    expect(effectiveCaption("  A  ")).toBe("A");
  });

  it("returns null when the caption is blank — there is NO shared/batch fallback", () => {
    expect(effectiveCaption("")).toBeNull();
    expect(effectiveCaption("   ")).toBeNull();
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

// THE core correctness of per-photo captions: the note a crew set for a shot must ride
// with THAT shot and never bleed onto another, all the way to the upload payload — and a
// blank note stays blank (null), never filled in from a sibling. This is the single
// mapping upload() uses for every photo (import multi-select AND camera batch).
describe("buildCaptureUploadInput (per-photo note attaches to the RIGHT photo, no batch bleed)", () => {
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
    sessionGps: null,
    gpsSession: null,
    ...over,
  });

  it("keeps each photo's own caption + uri together; a blank caption becomes null (no description)", () => {
    const a = photo({ key: "sp-1", uri: "file://A.jpg", caption: "cracked flashing, NE corner" });
    const b = photo({ key: "sp-2", uri: "file://B.jpg", caption: "" });

    const inA = buildCaptureUploadInput(a, ctx());
    const inB = buildCaptureUploadInput(b, ctx());

    expect(inA).toMatchObject({ uri: "file://A.jpg", caption: "cracked flashing, NE corner" });
    expect(inB.uri).toBe("file://B.jpg");
    expect(inB.caption).toBeNull();
    // Target/category/tags thread through unchanged on every photo.
    expect(inA).toMatchObject({ target: { dealId: "d1" }, category: "Roof", tags: ["north"] });
  });

  it("maps a whole batch positionally — a blank note is NOT filled from a sibling (no applied-to-all)", () => {
    const photos = [
      photo({ uri: "0", caption: "zero" }),
      photo({ uri: "1", caption: "" }),
      photo({ uri: "2", caption: "two" }),
    ];
    const inputs = photos.map((p) => buildCaptureUploadInput(p, ctx()));
    expect(inputs.map((i) => i.uri)).toEqual(["0", "1", "2"]);
    expect(inputs.map((i) => i.caption)).toEqual(["zero", null, "two"]);
  });

  it("emits null caption when the photo is blank", () => {
    expect(buildCaptureUploadInput(photo({ caption: "  " }), ctx()).caption).toBeNull();
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

// The review-tray reducers are where a caption edit could accidentally bleed onto a sibling (the
// apply-to-all bug). capture.tsx's setReviewCaption/appendReviewCaption/removeReviewPhoto delegate to
// these, so proving independence HERE covers the multi-photo review step for BOTH import and camera batch.
describe("review-tray caption reducers (per-photo edit — the note NEVER bleeds to a sibling)", () => {
  const photo = (key: string, caption = ""): SessionPhoto => ({
    key,
    clientUploadId: `cu-${key}`,
    uri: `file://${key}.jpg`,
    metadata: { takenAt: "t" },
    caption,
  });

  it("setPhotoCaption edits ONLY the keyed photo; blank siblings stay blank, pre-set siblings unchanged", () => {
    const photos = [photo("sp-1"), photo("sp-2"), photo("sp-3", "kept")];
    const out = setPhotoCaption(photos, "sp-2", "north wall");
    expect(out.map((p) => [p.key, p.caption])).toEqual([
      ["sp-1", ""],
      ["sp-2", "north wall"],
      ["sp-3", "kept"],
    ]);
  });

  it("setPhotoCaption is a no-op for a key not in the set (never invents/mislabels a photo)", () => {
    const photos = [photo("sp-1", "a")];
    expect(setPhotoCaption(photos, "nope", "x")).toEqual(photos);
  });

  it("appendPhotoCaption concatenates on the SAME photo (voice), space-joined; empty base → just text; sibling untouched", () => {
    const photos = [photo("sp-1", "leak"), photo("sp-2")];
    const out = appendPhotoCaption(photos, "sp-1", "at the valley");
    expect(out[0].caption).toBe("leak at the valley");
    expect(out[1].caption).toBe("");
    expect(appendPhotoCaption(photos, "sp-2", "first")[1].caption).toBe("first");
  });

  it("removePhoto drops only the keyed photo", () => {
    const photos = [photo("sp-1"), photo("sp-2"), photo("sp-3")];
    expect(removePhoto(photos, "sp-2").map((p) => p.key)).toEqual(["sp-1", "sp-3"]);
  });
});
