import { describe, expect, it } from "vitest";
import componentSource from "./forecast-editor.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

describe("ForecastEditor", () => {
  const source = normalize(componentSource);

  it("includes the core forecast controls and save action", () => {
    expect(source).toContain("Save Forecast");
    expect(source).toContain("Confidence %");
    expect(source).toContain("Next Milestone");
    expect(source).toContain("forecastWindow");
    expect(source).toContain("forecastCategory");
  });
});
