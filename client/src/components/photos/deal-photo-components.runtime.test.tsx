import { describe, expect, it } from "vitest";
import {
  PHOTO_CATEGORIES,
  displayPhotoCategory,
  matchesPhotoFilters,
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
});
