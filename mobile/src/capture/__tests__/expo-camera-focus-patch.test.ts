import fs from "node:fs";
import path from "node:path";

describe("pinned expo-camera point-focus patch", () => {
  const patchPath = path.join(process.cwd(), "patches", "expo-camera+17.0.10.patch");
  const patch = fs.readFileSync(patchPath, "utf8");

  it("keeps the JS ref method typed and safe on older native binaries", () => {
    expect(patch).toContain("focusAtPoint(point: Point): Promise<boolean>");
    expect(patch).toContain("typeof camera?.focusAtPoint !== 'function'");
    expect(patch).toContain("return camera.focusAtPoint(point.x, point.y)");
    expect(patch).toContain("return false;");
  });

  it("converts view coordinates through the preview layer before AF/AE metering", () => {
    expect(patch).toContain("previewLayer.captureDevicePointConverted(fromLayerPoint: viewPoint)");
    expect(patch).toContain("device.isFocusPointOfInterestSupported");
    expect(patch).toContain("device.focusPointOfInterest = point");
    expect(patch).toContain("device.exposurePointOfInterest = point");
  });

  it("reports unsupported or failed native focus instead of faking success", () => {
    expect(patch).toContain("continuation.resume(returning: false)");
    expect(patch).toContain("device.isFocusModeSupported(.continuousAutoFocus)");
  });
});
