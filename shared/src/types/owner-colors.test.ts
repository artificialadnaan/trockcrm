import { describe, expect, it } from "vitest";
import {
  OWNER_INITIAL_COLOR_PALETTE,
  getOwnerInitialColor,
} from "./owner-colors.js";

describe("owner initials color utility", () => {
  it("returns the same palette color for the same stable owner key", () => {
    expect(getOwnerInitialColor("user-123")).toEqual(getOwnerInitialColor("user-123"));
  });

  it("normalizes surrounding whitespace and casing for stable owner keys", () => {
    expect(getOwnerInitialColor(" USER-123 ")).toEqual(getOwnerInitialColor("user-123"));
  });

  it("keeps owners with the same initials eligible for different colors by hashing the owner key", () => {
    expect(getOwnerInitialColor("kelly-martin-user-id")).not.toEqual(
      getOwnerInitialColor("kim-morales-user-id")
    );
  });

  it("spreads representative owner keys across the fixed palette", () => {
    const colors = new Set(
      Array.from({ length: 24 }, (_, index) => getOwnerInitialColor(`rep-${index + 1}`).backgroundColor)
    );

    expect(colors.size).toBeGreaterThanOrEqual(Math.ceil(OWNER_INITIAL_COLOR_PALETTE.length / 2));
  });

  it("always returns a swatch from the curated palette", () => {
    const paletteColors = new Set<string>(
      OWNER_INITIAL_COLOR_PALETTE.map((swatch) => swatch.backgroundColor)
    );

    expect(paletteColors.has(getOwnerInitialColor("rep-42").backgroundColor)).toBe(true);
    expect(paletteColors.has(getOwnerInitialColor("").backgroundColor)).toBe(true);
  });
});
