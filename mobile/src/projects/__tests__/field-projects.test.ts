import {
  categoryLabel,
  filterPhotos,
  groupPhotos,
  relativeDate,
  tagsOf,
  uploadersOf,
  type FieldPhoto,
} from "../field-projects";

function photo(overrides: Partial<FieldPhoto>): FieldPhoto {
  return {
    id: "p",
    category: "photo",
    photoCategory: null,
    subcategory: null,
    displayName: "x.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 1,
    fileExtension: "jpg",
    dealId: "d",
    leadId: null,
    description: null,
    tags: [],
    takenAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    uploadedBy: "u1",
    uploaderName: "Alice",
    uploaderAvatarUrl: null,
    latitude: null,
    longitude: null,
    address: null,
    addressSource: null,
    geocodedAt: null,
    procoreSyncStatus: null,
    deletedAt: null,
    imageUrl: null,
    ...overrides,
  };
}

describe("field-projects", () => {
  it("categoryLabel maps known values and falls back gracefully", () => {
    expect(categoryLabel("before")).toBe("Before");
    expect(categoryLabel("site_visit")).toBe("Site Visit");
    expect(categoryLabel(null)).toBe("Uncategorized");
    expect(categoryLabel("weird_value")).toBe("weird value");
  });

  it("groups photos by category", () => {
    const photos = [
      photo({ id: "a", photoCategory: "before" }),
      photo({ id: "b", photoCategory: "after" }),
      photo({ id: "c", photoCategory: "before" }),
    ];
    const byLabel = Object.fromEntries(groupPhotos(photos, "category").map((g) => [g.label, g.photos.length]));
    expect(byLabel["Before"]).toBe(2);
    expect(byLabel["After"]).toBe(1);
  });

  it("groups photos by uploader", () => {
    const photos = [
      photo({ id: "a", uploadedBy: "u1", uploaderName: "Alice" }),
      photo({ id: "b", uploadedBy: "u2", uploaderName: "Bob" }),
    ];
    expect(groupPhotos(photos, "uploader")).toHaveLength(2);
  });

  it("filters by category, tag (case-insensitive), and uploader", () => {
    const photos = [
      photo({ id: "a", photoCategory: "before", tags: ["roof"], uploadedBy: "u1" }),
      photo({ id: "b", photoCategory: "after", tags: ["wall"], uploadedBy: "u2" }),
    ];
    const ids = (f: Parameters<typeof filterPhotos>[1]) => filterPhotos(photos, f).map((p) => p.id);
    expect(ids({ categories: ["before"], tags: [], uploaderIds: [], from: "", to: "" })).toEqual(["a"]);
    expect(ids({ categories: [], tags: ["WALL"], uploaderIds: [], from: "", to: "" })).toEqual(["b"]);
    expect(ids({ categories: [], tags: [], uploaderIds: ["u2"], from: "", to: "" })).toEqual(["b"]);
  });

  it("filters by date range on the takenAt/createdAt day", () => {
    const photos = [
      photo({ id: "a", takenAt: "2026-03-01T12:00:00.000Z" }),
      photo({ id: "b", takenAt: "2026-03-10T12:00:00.000Z" }),
    ];
    const ids = (f: Parameters<typeof filterPhotos>[1]) => filterPhotos(photos, f).map((p) => p.id);
    expect(ids({ categories: [], tags: [], uploaderIds: [], from: "2026-03-05", to: "" })).toEqual(["b"]);
    expect(ids({ categories: [], tags: [], uploaderIds: [], from: "", to: "2026-03-05" })).toEqual(["a"]);
  });

  it("derives distinct sorted tags and distinct uploaders", () => {
    const photos = [
      photo({ tags: ["a", "b"], uploadedBy: "u1", uploaderName: "Alice" }),
      photo({ tags: ["b", "c"], uploadedBy: "u1", uploaderName: "Alice" }),
    ];
    expect(tagsOf(photos)).toEqual(["a", "b", "c"]);
    expect(uploadersOf(photos)).toEqual([{ id: "u1", name: "Alice" }]);
  });

  it("relativeDate handles null and today", () => {
    expect(relativeDate(null)).toBe("no recent activity");
    expect(relativeDate(new Date().toISOString())).toBe("today");
  });
});
