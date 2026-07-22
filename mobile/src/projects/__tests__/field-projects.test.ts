import {
  categoryLabel,
  correctiveAffordance,
  filterPhotos,
  formatDistanceMiles,
  groupPhotos,
  isProjectOffOffice,
  LEGACY_PHOTO_CATEGORIES,
  partitionProjectSections,
  PHOTO_CATEGORIES,
  projectNumberLabel,
  relativeDate,
  selectNearbySource,
  tagsOf,
  toDayString,
  uploadersOf,
  type FieldPhoto,
  type FieldProject,
} from "../field-projects";

function fieldProject(id: string, overrides: Partial<FieldProject> = {}): FieldProject {
  return {
    id,
    dealNumber: id,
    projectNumber: id,
    name: id,
    propertyName: null,
    propertyAddress: null,
    stage: "Active",
    lastActivityAt: null,
    photoCount: 0,
    starred: false,
    officeId: "office-1",
    officeSlug: "dfw",
    ...overrides,
  };
}

describe("formatDistanceMiles", () => {
  it("returns null for missing/non-finite distances (non-nearby rows render nothing)", () => {
    expect(formatDistanceMiles(null)).toBeNull();
    expect(formatDistanceMiles(undefined)).toBeNull();
    expect(formatDistanceMiles(NaN)).toBeNull();
    expect(formatDistanceMiles(Infinity)).toBeNull();
  });
  it("shows one decimal under 10 miles", () => {
    expect(formatDistanceMiles(0)).toBe("0.0 mi");
    expect(formatDistanceMiles(2.34)).toBe("2.3 mi");
  });
  it("rounds to whole miles at/above 10", () => {
    expect(formatDistanceMiles(10)).toBe("10 mi");
    expect(formatDistanceMiles(12.6)).toBe("13 mi");
    expect(formatDistanceMiles(412.4)).toBe("412 mi");
  });
});

describe("partitionProjectSections", () => {
  it("removes a nearby project from both starred and all (nearby wins)", () => {
    const result = partitionProjectSections(
      [fieldProject("a")],
      [fieldProject("a"), fieldProject("b")],
      [fieldProject("a"), fieldProject("b"), fieldProject("c")],
    );
    expect(result.nearby.map((p) => p.id)).toEqual(["a"]);
    expect(result.starred.map((p) => p.id)).toEqual(["b"]); // "a" dropped (it's nearby)
    expect(result.all.map((p) => p.id)).toEqual(["c"]); // "a" + "b" dropped
    expect(result.hasSections).toBe(true);
  });

  it("removes a starred project from all (starred wins over all)", () => {
    const result = partitionProjectSections([], [fieldProject("b")], [fieldProject("b"), fieldProject("c")]);
    expect(result.starred.map((p) => p.id)).toEqual(["b"]);
    expect(result.all.map((p) => p.id)).toEqual(["c"]);
    expect(result.hasSections).toBe(true);
  });

  it("hasSections is false when there's no nearby or visible starred", () => {
    const result = partitionProjectSections([], [], [fieldProject("a"), fieldProject("b")]);
    expect(result.hasSections).toBe(false);
    expect(result.all.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("nearby alone still counts as a section even if it consumed the only starred project", () => {
    const result = partitionProjectSections([fieldProject("a")], [fieldProject("a")], [fieldProject("a")]);
    expect(result.nearby.map((p) => p.id)).toEqual(["a"]);
    expect(result.starred).toEqual([]);
    expect(result.all).toEqual([]);
    expect(result.hasSections).toBe(true);
  });
});

describe("selectNearbySource", () => {
  const projects = [fieldProject("a"), fieldProject("b"), fieldProject("c")];

  it("returns the ranked projects when fresh and complete", () => {
    expect(
      selectNearbySource({ searching: false, isError: false, projects, degradedOffices: [] }).map((p) => p.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("suppresses Nearby while searching", () => {
    expect(selectNearbySource({ searching: true, isError: false, projects, degradedOffices: [] })).toEqual([]);
  });

  it("suppresses Nearby when any office was degraded", () => {
    expect(selectNearbySource({ searching: false, isError: false, projects, degradedOffices: ["atl"] })).toEqual([]);
  });

  it("suppresses stale data on a failed refetch (isError, data retained)", () => {
    // React Query keeps prior `projects` (degradedOffices empty) when a refetch errors — must still hide.
    expect(selectNearbySource({ searching: false, isError: true, projects, degradedOffices: [] })).toEqual([]);
  });

  it("returns [] when there is no data yet", () => {
    expect(selectNearbySource({ searching: false, isError: false })).toEqual([]);
  });
});

describe("projectNumberLabel", () => {
  it("prefixes a present project number with '#'", () => {
    expect(projectNumberLabel("DFW-1-09026-af")).toBe("#DFW-1-09026-af");
    expect(projectNumberLabel("  ATL-4-16326-ab  ")).toBe("#ATL-4-16326-ab");
  });

  it("shows 'Project pending' when there is no number (server never sends the HubSpot id here)", () => {
    expect(projectNumberLabel(null)).toBe("Project pending");
    expect(projectNumberLabel(undefined)).toBe("Project pending");
    expect(projectNumberLabel("")).toBe("Project pending");
    expect(projectNumberLabel("   ")).toBe("Project pending");
  });
});

describe("isProjectOffOffice", () => {
  it("is false (writable) when the project's office matches the writable office", () => {
    expect(isProjectOffOffice({ officeId: "office-1" }, "office-1")).toBe(false);
  });
  it("is true (view-only) when the project belongs to a different office", () => {
    expect(isProjectOffOffice({ officeId: "office-2" }, "office-1")).toBe(true);
  });
  it("is true (view-only, fail-safe) when the writable office can't be resolved", () => {
    expect(isProjectOffOffice({ officeId: "office-1" }, null)).toBe(true);
    expect(isProjectOffOffice({ officeId: "office-1" }, undefined)).toBe(true);
  });
});

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
  it("offers exactly the 6 phase pills (mirror of shared PHOTO_CATEGORY_OPTIONS)", () => {
    expect(PHOTO_CATEGORIES.map((c) => c.value)).toEqual([
      "estimating",
      "preconstruction",
      "construction",
      "final_completion",
      "punch",
      "issues",
    ]);
    // No retired value is offered for capture.
    const offered = new Set(PHOTO_CATEGORIES.map((c) => c.value as string));
    for (const legacy of LEGACY_PHOTO_CATEGORIES) {
      expect(offered.has(legacy.value)).toBe(false);
    }
  });

  it("categoryLabel maps new + legacy values and falls back gracefully", () => {
    expect(categoryLabel("construction")).toBe("Construction");
    expect(categoryLabel("final_completion")).toBe("Final Completion");
    expect(categoryLabel("before")).toBe("Before"); // legacy still labels nicely
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

// Crash-proofing the photo filters (P0: "the filter button kicks me out of the app"). The filter code runs
// with NO error boundary historically, so any throw here was an app-killing crash. These pin that malformed
// data — non-string tags, an invalid timestamp — degrades gracefully instead of throwing.
describe("filter crash-proofing", () => {
  it("tagsOf ignores null / non-string / empty tags (no localeCompare crash, no invalid React child)", () => {
    const photos = [
      photo({ tags: ["Floor 1", null as any, "", 3 as any, "Elevation"] }),
      photo({ tags: ["Floor 1"] }),
    ];
    expect(tagsOf(photos)).toEqual(["Elevation", "Floor 1"]);
  });

  it("tagsOf tolerates a non-ARRAY tags container (bare string, object, null) without iterating it", () => {
    const photos = [
      photo({ tags: "floor,elevation" as any }), // a string would otherwise yield 1-char "tags" via for..of
      photo({ tags: { 0: "floor" } as any }), // a non-iterable object would otherwise throw in for..of
      photo({ tags: null as any }),
      photo({ tags: ["Real Tag"] }),
    ];
    const run = () => tagsOf(photos);
    expect(run).not.toThrow();
    expect(run()).toEqual(["Real Tag"]); // only the genuine array of strings contributes
  });

  it("filterPhotos by tag does not throw when a photo carries non-string tags, and still matches by string", () => {
    const photos = [
      photo({ id: "a", tags: ["Floor 1", null as any] }),
      photo({ id: "b", tags: ["Elevation"] }),
    ];
    const run = () => filterPhotos(photos, { categories: [], tags: ["floor 1"], uploaderIds: [], from: "", to: "" });
    expect(run).not.toThrow();
    expect(run().map((p) => p.id)).toEqual(["a"]);
  });

  it("groupPhotos by date does not throw on a missing/invalid timestamp (falls into an Unknown date bucket)", () => {
    const photos = [
      photo({ id: "good", takenAt: "2026-01-02T00:00:00.000Z" }),
      photo({ id: "bad", takenAt: "not-a-date", createdAt: "also-bad" }),
    ];
    const run = () => groupPhotos(photos, "date");
    expect(run).not.toThrow();
    expect(run().some((g) => g.label === "Unknown date")).toBe(true);
  });

  it("toDayString tolerates null / invalid values without throwing", () => {
    expect(toDayString("2026-07-22T03:00:00.000Z")).toBe("2026-07-22");
    expect(toDayString(null)).toBe("");
    expect(toDayString("not-a-date")).toBe("");
  });
});

describe("correctiveAffordance", () => {
  it("makes the open-card prompt TAPPABLE only when the viewer can respond", () => {
    expect(correctiveAffordance("corrective_action_open", true)).toBe("open_tappable");
    // An unassigned rep/field_contractor would 403 at the responder endpoint → read-only status, no route.
    expect(correctiveAffordance("corrective_action_open", false)).toBe("open_status");
  });

  it("makes the closed-card Resolved badge TAPPABLE only when the viewer can respond", () => {
    expect(correctiveAffordance("corrective_action_closed", true)).toBe("closed_tappable");
    expect(correctiveAffordance("corrective_action_closed", false)).toBe("closed_status");
  });

  it("returns none for a card without a corrective action, regardless of canRespond", () => {
    expect(correctiveAffordance("submitted", true)).toBe("none");
    expect(correctiveAffordance(undefined, true)).toBe("none");
    expect(correctiveAffordance("submitted", false)).toBe("none");
  });
});
