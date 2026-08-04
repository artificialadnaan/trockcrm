import { describe, expect, it } from "vitest";
import { captureTargetDisplayName, filterPhotos, groupPhotos, isProjectOffOffice, relativeDate, type FieldPhoto } from "./field-projects";

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
    // The capture-target search now returns `deals.is_change_order`, so the deal branch is authoritative
    // rather than syntactic. A deal a human named "Lobby — Change Order 1" must render as typed.
    expect(captureTargetDisplayName({ type: "deal", name: "Lobby — Change Order 1", isChangeOrder: false }))
      .toBe("Lobby — Change Order 1");
    expect(captureTargetDisplayName({ type: "deal", name: "Tides — Change Order 2", isChangeOrder: true }))
      .toBe("Change Order 2 — Tides");
    // No flag on the payload -> documented fallback to syntax.
    expect(captureTargetDisplayName({ type: "deal", name: "Tides — Change Order 2" }))
      .toBe("Change Order 2 — Tides");
  });

  it("leaves an ordinary deal name alone", () => {
    expect(captureTargetDisplayName({ type: "deal", name: "Tides Park Lane" })).toBe("Tides Park Lane");
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
    expect(isProjectOffOffice({ officeId: "office-1" }, undefined)).toBe(true);
    expect(isProjectOffOffice({ officeId: "office-1" }, null)).toBe(true);
  });
});

const basePhoto: FieldPhoto = {
  id: "photo-1",
  category: "photo",
  photoCategory: "damage",
  subcategory: null,
  displayName: "Damage",
  mimeType: "image/jpeg",
  fileSizeBytes: 1000,
  fileExtension: ".jpg",
  dealId: "deal-1",
  leadId: null,
  description: null,
  tags: ["roofing"],
  takenAt: "2026-05-05T12:00:00.000Z",
  createdAt: "2026-05-05T12:00:00.000Z",
  uploadedBy: "user-1",
  uploaderName: "Field User",
  uploaderAvatarUrl: null,
  latitude: null,
  longitude: null,
  address: null,
  addressSource: null,
  geocodedAt: null,
  procoreSyncStatus: null,
  deletedAt: null,
  imageUrl: "https://example.com/photo.jpg",
};

describe("field project photo helpers", () => {
  it("filters photos by category, uploader, and date range", () => {
    const photos = [
      basePhoto,
      { ...basePhoto, id: "photo-2", photoCategory: "safety", uploadedBy: "user-2", takenAt: "2026-05-02T12:00:00.000Z" },
    ];

    expect(filterPhotos(photos, {
      categories: ["damage"],
      tags: [],
      uploaderIds: ["user-1"],
      from: "2026-05-04",
      to: "2026-05-06",
    }).map((photo) => photo.id)).toEqual(["photo-1"]);
  });

  it("groups photos by date, category, uploader, or none", () => {
    const photos = [
      basePhoto,
      { ...basePhoto, id: "photo-2", photoCategory: "safety", uploadedBy: "user-2", uploaderName: "Other User", takenAt: "2026-05-04T12:00:00.000Z" },
    ];

    expect(groupPhotos(photos, "date")[0].label).toContain("Tuesday, May 5th, 2026");
    expect(groupPhotos(photos, "category").map((group) => group.label)).toContain("Damage");
    expect(groupPhotos(photos, "uploader").map((group) => group.label)).toContain("Field User");
    expect(groupPhotos(photos, "none")).toHaveLength(1);
  });

  it("formats relative dates for project cards", () => {
    expect(relativeDate(null)).toBe("no recent activity");
  });
});
