import { describe, expect, it } from "vitest";
import {
  LEGACY_PHOTO_CATEGORIES,
  LEGACY_PHOTO_CATEGORY_ITEMS,
  PHOTO_CATEGORIES,
  PHOTO_CATEGORY_LABELS,
  PHOTO_CATEGORY_OPTION_ITEMS,
  PHOTO_CATEGORY_OPTIONS,
  photoCategoryLabel,
} from "./enums.js";

// Single source of truth for the photo phase taxonomy. The 6 offered categories
// must stay in lockstep with the mobile/web pickers and the photo_category enum.
describe("photo category source of truth", () => {
  it("offers exactly the 6 phase categories, in display order", () => {
    expect(PHOTO_CATEGORY_OPTIONS).toEqual([
      "estimating",
      "preconstruction",
      "construction",
      "final_completion",
      "punch",
      "issues",
    ]);
  });

  it("does not offer any retired legacy category", () => {
    for (const legacy of LEGACY_PHOTO_CATEGORIES) {
      expect(PHOTO_CATEGORY_OPTIONS as readonly string[]).not.toContain(legacy);
    }
  });

  it("keeps every legacy value in the full enum set so existing rows stay valid", () => {
    // PHOTO_CATEGORIES drives the photo_category pgEnum + type. It must contain
    // legacy (never dropped) followed by the 6 new values appended in 0165.
    expect(PHOTO_CATEGORIES).toEqual([
      ...LEGACY_PHOTO_CATEGORIES,
      ...PHOTO_CATEGORY_OPTIONS,
    ]);
    expect(PHOTO_CATEGORIES).toHaveLength(14);
  });

  it("has a label for every value (offered + legacy)", () => {
    for (const value of PHOTO_CATEGORIES) {
      expect(PHOTO_CATEGORY_LABELS[value]).toBeTruthy();
    }
    expect(PHOTO_CATEGORY_LABELS.final_completion).toBe("Final Completion");
  });

  it("builds option items with matching value/label pairs", () => {
    expect(PHOTO_CATEGORY_OPTION_ITEMS).toEqual([
      { value: "estimating", label: "Estimating" },
      { value: "preconstruction", label: "Preconstruction" },
      { value: "construction", label: "Construction" },
      { value: "final_completion", label: "Final Completion" },
      { value: "punch", label: "Punch" },
      { value: "issues", label: "Issues" },
    ]);
    expect(LEGACY_PHOTO_CATEGORY_ITEMS.map((item) => item.value)).toEqual([
      ...LEGACY_PHOTO_CATEGORIES,
    ]);
  });

  it("resolves labels for new, legacy, unknown and empty values", () => {
    expect(photoCategoryLabel("construction")).toBe("Construction");
    expect(photoCategoryLabel("site_visit")).toBe("Site Visit"); // legacy still labels nicely
    expect(photoCategoryLabel("brand_new_value")).toBe("brand new value"); // graceful fallback
    expect(photoCategoryLabel(null)).toBeNull();
    expect(photoCategoryLabel(undefined)).toBeNull();
    expect(photoCategoryLabel("")).toBeNull();
  });
});
