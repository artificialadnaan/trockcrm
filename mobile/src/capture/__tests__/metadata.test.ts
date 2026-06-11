import { extractExifMetadata } from "../metadata";

describe("extractExifMetadata", () => {
  it("reads iOS decimal-degree GPS and applies the ref sign", () => {
    const m = extractExifMetadata({
      GPSLatitude: 32.7,
      GPSLatitudeRef: "N",
      GPSLongitude: 96.8,
      GPSLongitudeRef: "W",
    });
    expect(m.latitude).toBeCloseTo(32.7, 5);
    expect(m.longitude).toBeCloseTo(-96.8, 5);
    expect(m.addressSource).toBe("exif");
  });

  it("parses degrees/minutes/seconds array GPS (would previously be dropped as NaN)", () => {
    const m = extractExifMetadata({
      GPSLatitude: [32, 47, 0],
      GPSLatitudeRef: "N",
      GPSLongitude: [96, 48, 0],
      GPSLongitudeRef: "W",
    });
    expect(m.latitude).toBeCloseTo(32 + 47 / 60, 4);
    expect(m.longitude).toBeCloseTo(-(96 + 48 / 60), 4);
    expect(m.addressSource).toBe("exif");
  });

  it("parses rational-pair DMS GPS and negates S/keeps E", () => {
    const m = extractExifMetadata({
      GPSLatitude: [[32, 1], [47, 1], [30, 1]],
      GPSLatitudeRef: "S",
      GPSLongitude: [[96, 1], [0, 1], [0, 1]],
      GPSLongitudeRef: "E",
    });
    expect(m.latitude).toBeCloseTo(-(32 + 47 / 60 + 30 / 3600), 4);
    expect(m.longitude).toBeCloseTo(96, 4);
  });

  it("returns no coords + no source when GPS is missing, but parses takenAt", () => {
    const m = extractExifMetadata({ DateTimeOriginal: "2026:03:10 14:05:09" });
    expect(m.latitude).toBeUndefined();
    expect(m.longitude).toBeUndefined();
    expect(m.addressSource).toBeUndefined();
    expect(m.takenAt).toBeDefined();
  });

  it("returns empty for null/undefined exif", () => {
    expect(extractExifMetadata(null)).toEqual({});
    expect(extractExifMetadata(undefined)).toEqual({});
  });
});
