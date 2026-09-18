import { hasPhotoCoords, mergeLiveGpsIntoExif } from "../metadata";
import type { PhotoMetadata } from "../metadata";

const LIVE: PhotoMetadata = {
  latitude: 32.911,
  longitude: -96.775,
  addressSource: "live_gps",
  // getLiveGps ALWAYS stamps this — it is "now", not the shot's capture time.
  takenAt: "2026-08-17T19:00:00.000Z",
};

describe("hasPhotoCoords", () => {
  it("requires BOTH coordinates — one without the other is not a location", () => {
    expect(hasPhotoCoords({ latitude: 1, longitude: 2 })).toBe(true);
    expect(hasPhotoCoords({ latitude: 1 })).toBe(false);
    expect(hasPhotoCoords({ longitude: 2 })).toBe(false);
    expect(hasPhotoCoords({})).toBe(false);
  });
});

describe("mergeLiveGpsIntoExif", () => {
  it("leaves a shot that already has a fix completely alone", () => {
    const exif: PhotoMetadata = {
      latitude: 1,
      longitude: 2,
      addressSource: "exif",
      takenAt: "2026-08-11T15:00:00.000Z",
    };
    expect(mergeLiveGpsIntoExif(exif, LIVE)).toBe(exif);
  });

  it("NEVER overwrites the capture time with the live fix's clock", () => {
    // The defect this closes. A plain `{...exif, ...live}` replaces the photo's real EXIF timestamp with
    // "now", because getLiveGps always sets takenAt. That is wrong as provenance, and it also drops the
    // photo out of its own report's picker: candidates are filtered on COALESCE(taken_at, created_at)
    // against the 14 days ending on week_of, so a photo restamped to today vanishes from a report filed
    // late. Location-stripped images — anything shared through a messaging app — are the common case.
    const exif: PhotoMetadata = { takenAt: "2026-08-11T15:00:00.000Z" };
    const merged = mergeLiveGpsIntoExif(exif, LIVE);
    expect(merged.takenAt).toBe("2026-08-11T15:00:00.000Z");
    expect(merged.latitude).toBe(32.911);
    expect(merged.longitude).toBe(-96.775);
    expect(merged.addressSource).toBe("live_gps");
  });

  it("fills in a shot with NO coordinates at all", () => {
    const merged = mergeLiveGpsIntoExif({}, LIVE);
    expect(merged).toMatchObject({ latitude: 32.911, longitude: -96.775, addressSource: "live_gps" });
  });

  it("fills in a shot with only ONE coordinate, which is not a usable fix", () => {
    // The gate has to be "both", not "latitude is undefined": a half-populated EXIF block would otherwise
    // keep its useless single coordinate despite the live lookup having already been paid for.
    const merged = mergeLiveGpsIntoExif({ latitude: 1 }, LIVE);
    expect(merged).toMatchObject({ latitude: 32.911, longitude: -96.775 });
  });

  it("returns the shot unchanged when the live lookup failed or returned no fix", () => {
    const exif: PhotoMetadata = { takenAt: "2026-08-11T15:00:00.000Z" };
    expect(mergeLiveGpsIntoExif(exif, null)).toBe(exif);
    expect(mergeLiveGpsIntoExif(exif, { takenAt: "2026-08-17T19:00:00.000Z" })).toBe(exif);
  });

  it("does not invent an addressSource the live fix never claimed", () => {
    const merged = mergeLiveGpsIntoExif({}, { latitude: 1, longitude: 2 });
    expect(merged.addressSource).toBeUndefined();
  });
});
