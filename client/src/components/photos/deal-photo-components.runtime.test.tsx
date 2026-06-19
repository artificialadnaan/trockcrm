import { describe, expect, it } from "vitest";
import {
  PHOTO_CATEGORIES,
  displayPhotoCategory,
  legacyCategoryOptionsInUse,
  matchesPhotoFilters,
  photoFilterCategory,
  type DealPhotoRecord,
  type PhotoFilterState,
} from "./deal-photo-components";

function photo(overrides: Partial<DealPhotoRecord>): DealPhotoRecord {
  return {
    id: "p",
    category: "photo",
    photoCategory: null,
    subcategory: null,
    displayName: "Photo",
    mimeType: "image/jpeg",
    r2Key: "p.jpg",
    externalUrl: null,
    externalThumbnailUrl: null,
    description: null,
    takenAt: "2026-05-04T17:43:00.000Z",
    createdAt: "2026-05-04T18:00:00.000Z",
    uploadedBy: "u1",
    uploaderName: "Uploader",
    uploaderAvatarUrl: null,
    latitude: null,
    longitude: null,
    address: null,
    addressSource: null,
    geocodedAt: null,
    procoreSyncStatus: null,
    deletedAt: null,
    deletedByUserId: null,
    tags: [],
    ...overrides,
  };
}

const baseFilters: PhotoFilterState = {
  categories: [],
  tags: [],
  uploaderIds: [],
  from: "",
  to: "",
  group: "date",
  showDeleted: false,
};

describe("web photo categories", () => {
  it("offers exactly the 6 phase categories for tagging", () => {
    expect(PHOTO_CATEGORIES.map((option) => option.value)).toEqual([
      "estimating",
      "preconstruction",
      "construction",
      "final_completion",
      "punch",
      "issues",
    ]);
    expect(PHOTO_CATEGORIES.map((option) => option.value as string)).not.toContain("before");
  });

  it("labels both new and legacy values so old photos still read correctly", () => {
    expect(displayPhotoCategory(photo({ photoCategory: "construction" }))).toBe("Construction");
    expect(displayPhotoCategory(photo({ photoCategory: "final_completion" }))).toBe("Final Completion");
    expect(displayPhotoCategory(photo({ photoCategory: "site_visit" }))).toBe("Site Visit");
    expect(displayPhotoCategory(photo({ photoCategory: null, subcategory: "Roof Plan" }))).toBe("Roof Plan");
    expect(displayPhotoCategory(photo({ photoCategory: null }))).toBeNull();
  });

  it("does not hide legacy-tagged photos when no category filter is applied", () => {
    const legacy = photo({ photoCategory: "damage" });
    expect(matchesPhotoFilters(legacy, baseFilters)).toBe(true);
  });

  it("keeps legacy-tagged photos reachable via the legacy filter value", () => {
    const legacy = photo({ photoCategory: "site_visit" });
    expect(matchesPhotoFilters(legacy, { ...baseFilters, categories: ["site_visit"] })).toBe(true);
    expect(matchesPhotoFilters(legacy, { ...baseFilters, categories: ["construction"] })).toBe(false);
  });

  it("matches new-category photos through the filter", () => {
    const fresh = photo({ photoCategory: "punch" });
    expect(matchesPhotoFilters(fresh, { ...baseFilters, categories: ["punch"] })).toBe(true);
  });

  it("labels subcategory-backed (web-captured) phase photos via the shared map", () => {
    // Web capture stores the phase on subcategory; should still read titled-case.
    expect(displayPhotoCategory(photo({ photoCategory: null, subcategory: "final_completion" }))).toBe("Final Completion");
  });

  it("derives the filter token from photoCategory, else normalized subcategory, else uncategorized", () => {
    expect(photoFilterCategory(photo({ photoCategory: "construction" }))).toBe("construction");
    expect(photoFilterCategory(photo({ photoCategory: null, subcategory: "Site Visit" }))).toBe("site_visit");
    expect(photoFilterCategory(photo({ photoCategory: null, subcategory: null }))).toBe("uncategorized");
  });

  it("filters a web-captured legacy photo (subcategory) via the normalized chip", () => {
    const webLegacy = photo({ photoCategory: null, subcategory: "Site Visit" });
    expect(matchesPhotoFilters(webLegacy, { ...baseFilters, categories: ["site_visit"] })).toBe(true);
  });
});

describe("legacyCategoryOptionsInUse", () => {
  it("surfaces only the legacy categories present once fully loaded", () => {
    const photos = [photo({ photoCategory: "damage" }), photo({ photoCategory: "construction" })];
    expect(legacyCategoryOptionsInUse(photos, true).map((o) => o.value)).toEqual(["damage"]);
  });

  it("includes subcategory-backed legacy photos (normalized)", () => {
    const photos = [photo({ photoCategory: null, subcategory: "Site Visit" })];
    expect(legacyCategoryOptionsInUse(photos, true).map((o) => o.value)).toEqual(["site_visit"]);
  });

  it("returns no legacy chips for an all-new, fully-loaded deal", () => {
    const photos = [photo({ photoCategory: "punch" }), photo({ photoCategory: null })];
    expect(legacyCategoryOptionsInUse(photos, true)).toEqual([]);
  });

  it("surfaces ALL legacy categories while more pages remain (legacy photos are oldest)", () => {
    // allLoaded=false → can't know which legacy values exist yet; never hide the path to them.
    expect(legacyCategoryOptionsInUse([], false)).toHaveLength(8);
  });
});
