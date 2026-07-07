import {
  applyGpsToPending,
  buildCaptureUploadInput,
  effectiveCaption,
  reconcileUploadGps,
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

  it("models a library IMPORT + a CAMERA BATCH: every photo carries ONLY its own caption", () => {
    // Library multi-select import (no cameraSession), mixed captions.
    const imported = [
      photo({ uri: "imp-0", caption: "north wall" }),
      photo({ uri: "imp-1", caption: "" }),
    ];
    // Camera batch (cameraSession set), mixed captions.
    const batch = [
      photo({ uri: "cam-0", caption: "", cameraSession: 3 }),
      photo({ uri: "cam-1", caption: "active leak", cameraSession: 3 }),
    ];
    const captions = [...imported, ...batch].map((p) => buildCaptureUploadInput(p, ctx()).caption);
    // Only the captioned photos carry a description; the blank ones stay null — no bleed either direction.
    expect(captions).toEqual(["north wall", null, null, "active leak"]);
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
