import { describe, expect, it } from "vitest";
import { filterPhotos, groupPhotos, isProjectOffOffice, relativeDate, type FieldPhoto } from "./field-projects";

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
