import {
  categoryLabel,
  captureTargetDisplayName,
  correctiveAffordance,
  decodeChangeOrderParam,
  encodeChangeOrderParam,
  filterPhotos,
  formatDealDisplayName,
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
    expect(toDayString(null)).toBe("");
    expect(toDayString("not-a-date")).toBe("");
  });

  // Built from local components and asserted in local terms, so it holds in any CI timezone.
  // A UTC-based implementation fails this wherever the offset is negative.
  it("toDayString returns the LOCAL day, so grouping matches the heading beside it", () => {
    // 9pm on the 31st in Dallas is 02:00 UTC on the 1st. Keying on the UTC day split one
    // evening's photos into a second group rendering the same "Friday, July 31st" heading,
    // and dropped them out of a "31st" date filter.
    const evening = new Date(2026, 6, 31, 21, 0, 0);
    expect(toDayString(evening.toISOString())).toBe("2026-07-31");

    const morning = new Date(2026, 6, 31, 9, 0, 0);
    expect(toDayString(morning.toISOString())).toBe(toDayString(evening.toISOString()));
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

  it("REGRESSION: maps the awaiting-approval card to a visible, non-tappable status", () => {
    // Between open and closed since the approval gate. Falling through to "none" removed every corrective
    // indicator while the card sat in the approver's queue, so the project screen looked as though the
    // workflow had simply ended. Never tappable — there is nothing for the responder to do until it returns.
    expect(correctiveAffordance("corrective_action_submitted", true)).toBe("awaiting_status");
    expect(correctiveAffordance("corrective_action_submitted", false)).toBe("awaiting_status");
  });
});

// This helper is a deliberate MIRROR of shared/src/types/deal-display-name.ts (the Expo bundle cannot
// import @trock-crm/shared). These cases are the same contract that suite asserts — keep them in step.
describe("formatDealDisplayName", () => {
  it("moves the generated change-order suffix to the front", () => {
    expect(formatDealDisplayName("Tides Park Lane — Change Order 1")).toBe("Change Order 1 — Tides Park Lane");
    expect(formatDealDisplayName("Tides Park Lane — Change Order 12")).toBe("Change Order 12 — Tides Park Lane");
  });

  it("keeps em-dashes belonging to the parent's own name — only the LAST segment is ours", () => {
    expect(formatDealDisplayName("Tides — Phase 2 — Change Order 3")).toBe("Change Order 3 — Tides — Phase 2");
  });

  it("tolerates surrounding whitespace and a suffix-only name", () => {
    expect(formatDealDisplayName("Tides   —   Change Order 4   ")).toBe("Change Order 4 — Tides");
    expect(formatDealDisplayName(" — Change Order 1")).toBe("Change Order 1");
  });

  it("REGRESSION: still moves the child's label when the PARENT's own name is prefix-shaped", () => {
    // A deal a human named "Change Order 7 — Lobby" gets a child stored with BOTH parts. An earlier
    // "does this already look formatted?" prefix guard fired on it and returned it unchanged, stranding
    // the child's real "Change Order 1" at the end — the very truncation this helper exists to prevent.
    expect(formatDealDisplayName("Change Order 7 — Lobby — Change Order 1"))
      .toBe("Change Order 1 — Change Order 7 — Lobby");
    expect(formatDealDisplayName("A — Change Order 1 — Change Order 2"))
      .toBe("Change Order 2 — Change Order 1 — A");
    // A human-typed prefix-shaped name with NO generated suffix is still left alone.
    expect(formatDealDisplayName("Change Order 5 — Lobby")).toBe("Change Order 5 — Lobby");
  });

  it("REGRESSION: refuses a rejoin that would re-create a trailing suffix (would oscillate)", () => {
    // Both of these peel to a candidate that itself ends in a generated suffix, so formatting them would
    // flip between two spellings forever. Returned exactly as stored instead — trivially a fixed point.
    expect(formatDealDisplayName(" — Change Order 1 — Change Order 2")).toBe(" — Change Order 1 — Change Order 2");
    expect(formatDealDisplayName("Change Order 1 — Change Order 2")).toBe("Change Order 1 — Change Order 2");
  });

  it("leaves an ordinal the generator can never emit (zero / zero-padded)", () => {
    // nextChildOrdinal() is `COUNT(*)::int + 1` — always a positive, unpadded decimal.
    expect(formatDealDisplayName("Tides — Change Order 0")).toBe("Tides — Change Order 0");
    expect(formatDealDisplayName("Tides — Change Order 01")).toBe("Tides — Change Order 01");
  });

  it("POST-CONDITION: a formatted name never ends in a generated suffix, over composed shapes", () => {
    // Generated, not hand-picked — choosing the inputs myself is what let an oscillation through before.
    const suffix = /\s*—\s*Change Order\s+[1-9]\d*\s*$/;
    const bases = ["", "   ", "Tides", "Tides — Phase 2", "Change Order 1", "Change Order 7 — Lobby"];
    const padding: Array<[string, string]> = [["", ""], ["   ", ""], ["", "   "], ["  ", "  "]];
    const violations: string[] = [];
    for (const base of bases) {
      for (let depth = 0; depth <= 3; depth += 1) {
        let composed = base;
        for (let n = 1; n <= depth; n += 1) composed += ` — Change Order ${n}`;
        for (const [lead, trail] of padding) {
          const input = `${lead}${composed}${trail}`;
          const once = formatDealDisplayName(input);
          if (once !== input && suffix.test(once)) violations.push(input);
          else if (formatDealDisplayName(once) !== once) violations.push(input);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("is idempotent for EVERY case above — applying twice equals applying once", () => {
    // Structural, not guarded: the output never ends in a generated suffix, so there is nothing left to
    // move on a second pass. Asserted over the whole set rather than a hand-picked input.
    const inputs = [
      "Tides Park Lane — Change Order 1", "Tides Park Lane — Change Order 12",
      "Tides — Phase 2 — Change Order 3", "Tides   —   Change Order 4   ", " — Change Order 1",
      "Change Order 7 — Lobby — Change Order 1", "A — Change Order 1 — Change Order 2",
      "Change Order 5 — Lobby", "Change Order 1", "Change Order 1 — Tides Park Lane",
      "Tides Park Lane", "Change Order Backlog Review", "Tides — Change Order 1 Addendum",
      "Tides - Change Order 1", "Tides — Change Order", "Tides — change order 1", "", "   ",
    ];
    for (const input of inputs) {
      const once = formatDealDisplayName(input);
      expect(formatDealDisplayName(once)).toBe(once);
    }
  });

  it("leaves every other name byte for byte", () => {
    expect(formatDealDisplayName("Tides Park Lane")).toBe("Tides Park Lane");
    // "Change Order" mid-string is not the generated suffix.
    expect(formatDealDisplayName("Change Order Backlog Review")).toBe("Change Order Backlog Review");
    expect(formatDealDisplayName("Tides — Change Order 1 Addendum")).toBe("Tides — Change Order 1 Addendum");
    // A hyphen/en-dash separator, a missing ordinal, or the wrong casing is a name someone typed.
    expect(formatDealDisplayName("Tides - Change Order 1")).toBe("Tides - Change Order 1");
    expect(formatDealDisplayName("Tides — Change Order")).toBe("Tides — Change Order");
    expect(formatDealDisplayName("Tides — change order 1")).toBe("Tides — change order 1");
  });

  it("handles empty and nullish without throwing", () => {
    expect(formatDealDisplayName("")).toBe("");
    expect(formatDealDisplayName("   ")).toBe("   ");
    expect(formatDealDisplayName(null)).toBeNull();
    expect(formatDealDisplayName(undefined)).toBeUndefined();
  });
});

describe("change-order router params — unknown must never become an assertion", () => {
  // `false` is AUTHORITATIVE downstream, so encoding an UNKNOWN flag as anything that decodes to `false`
  // is worse than sending nothing. This is the bug that shipped twice: `toStr(undefined)` produced "",
  // and `"" === "1"` is false — an unknown silently became "definitely not a change order".
  it("round-trips a known flag in both directions", () => {
    expect(decodeChangeOrderParam(encodeChangeOrderParam(true))).toBe(true);
    expect(decodeChangeOrderParam(encodeChangeOrderParam(false))).toBe(false);
    expect(encodeChangeOrderParam(true)).toBe("1");
    expect(encodeChangeOrderParam(false)).toBe("0");
  });

  it("encodes UNKNOWN as undefined so the caller omits the key entirely", () => {
    expect(encodeChangeOrderParam(undefined)).toBeUndefined();
    expect(encodeChangeOrderParam(null)).toBeUndefined();
  });

  it("decodes anything that is not exactly 1/0 as UNKNOWN, never false", () => {
    for (const value of [undefined, "", "  ", "true", "false", "2", "undefined", ["1"]] as const) {
      expect(decodeChangeOrderParam(value as string | string[] | undefined)).toBeUndefined();
    }
  });

  it("REGRESSION: an unknown flag survives a full emit -> decode round trip as unknown", () => {
    // projects/[id] -> capture was doing toStr(undefined) === "" -> decoded false.
    expect(decodeChangeOrderParam(encodeChangeOrderParam(undefined))).toBeUndefined();
  });
});

describe("formatDealDisplayName — the is_change_order flag outranks the name", () => {
  // `deals.is_change_order` is the AUTHORITY. createDeal stores a hand-typed name verbatim with the flag
  // false, so syntax alone cannot tell a human's "Lobby — Change Order 1" from a generated child.
  it("false NEVER rewrites, even on a perfect generated suffix", () => {
    expect(formatDealDisplayName("Lobby — Change Order 1", false)).toBe("Lobby — Change Order 1");
    expect(formatDealDisplayName("Tides Park Lane — Change Order 2", false)).toBe("Tides Park Lane — Change Order 2");
  });

  it("true peels, and undefined/null fall back to syntax", () => {
    expect(formatDealDisplayName("Tides Park Lane — Change Order 2", true)).toBe("Change Order 2 — Tides Park Lane");
    expect(formatDealDisplayName("Tides Park Lane — Change Order 2", undefined)).toBe("Change Order 2 — Tides Park Lane");
    expect(formatDealDisplayName("Tides Park Lane — Change Order 2", null)).toBe("Change Order 2 — Tides Park Lane");
  });

  it("POST-CONDITION and idempotency hold in ALL flag states, over composed shapes", () => {
    const suffix = /\s*—\s*Change Order\s+[1-9]\d*\s*$/;
    const bases = ["", "   ", "Tides", "Tides — Phase 2", "Change Order 1", "Change Order 7 — Lobby"];
    const padding: Array<[string, string]> = [["", ""], ["   ", ""], ["", "   "], ["  ", "  "]];
    const violations: string[] = [];
    for (const flag of [undefined, null, true, false] as const) {
      for (const base of bases) {
        for (let depth = 0; depth <= 3; depth += 1) {
          let composed = base;
          for (let n = 1; n <= depth; n += 1) composed += ` — Change Order ${n}`;
          for (const [lead, trail] of padding) {
            const input = `${lead}${composed}${trail}`;
            const once = formatDealDisplayName(input, flag);
            if (once !== input && suffix.test(once)) violations.push(`${String(flag)}:${input}`);
            else if (formatDealDisplayName(once, flag) !== once) violations.push(`${String(flag)}:${input}`);
            else if (flag === false && once !== input) violations.push(`false-rewrote:${input}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("captureTargetDisplayName", () => {
  it("moves the generated change-order label to the front for a DEAL target", () => {
    expect(captureTargetDisplayName({ type: "deal", name: "Tides Park Lane — Change Order 2" }))
      .toBe("Change Order 2 — Tides Park Lane");
  });

  it("leaves a LEAD or OPPORTUNITY name byte for byte", () => {
    // The picker mixes all three types. Only a deal can be a generated change-order child — a lead is a
    // human-named leads row, and the server excludes opportunities from the `deal` type entirely.
    expect(captureTargetDisplayName({ type: "lead", name: "Lobby — Change Order 1" }))
      .toBe("Lobby — Change Order 1");
    expect(captureTargetDisplayName({ type: "opportunity", name: "Lobby — Change Order 1" }))
      .toBe("Lobby — Change Order 1");
  });

  it("obeys the DEAL branch's isChangeOrder flag over the name's shape", () => {
    expect(captureTargetDisplayName({ type: "deal", name: "Lobby — Change Order 1", isChangeOrder: false }))
      .toBe("Lobby — Change Order 1");
    expect(captureTargetDisplayName({ type: "deal", name: "Tides — Change Order 2", isChangeOrder: true }))
      .toBe("Change Order 2 — Tides");
    // A LEAD is still never rewritten, flag or not.
    expect(captureTargetDisplayName({ type: "lead", name: "Lobby — Change Order 1", isChangeOrder: true }))
      .toBe("Lobby — Change Order 1");
  });

  it("REGRESSION: a selection that keeps the picker's flag suppresses a false-flagged relabel", () => {
    // capture.tsx's onSelect used to store only { id, type, name }, dropping the flag the picker row had
    // just used. Everything downstream — the target card, the /walk nav param, the AI-walk headline —
    // then fell back to reading the name. This pins the shape the handler must preserve.
    const picked = { id: "d1", type: "deal" as const, name: "Lobby — Change Order 1", isChangeOrder: false };
    const stored = { id: picked.id, type: picked.type, name: picked.name, isChangeOrder: picked.isChangeOrder };
    expect(captureTargetDisplayName(stored)).toBe("Lobby — Change Order 1");
    // Dropping the flag (the old behaviour) silently changes what the user sees.
    expect(captureTargetDisplayName({ id: picked.id, type: picked.type, name: picked.name }))
      .toBe("Change Order 1 — Lobby");
  });

  it("leaves an ordinary deal name alone", () => {
    expect(captureTargetDisplayName({ type: "deal", name: "Tides Park Lane" })).toBe("Tides Park Lane");
  });
});
