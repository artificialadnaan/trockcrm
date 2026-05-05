import { describe, expect, it } from "vitest";
import {
  buildDealPhotoTimelineConditions,
  describeDealPhotoTimelineFilters,
} from "../../../src/modules/files/photo-timeline-filters.js";

function tenantDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ sourceLeadId: null }],
        }),
      }),
    }),
  };
}

describe("deal photo timeline filters", () => {
  it("excludes soft-deleted photos by default and includes them when requested", async () => {
    await expect(buildDealPhotoTimelineConditions(tenantDb() as any, "deal-1", {})).resolves.toBeTruthy();

    expect(describeDealPhotoTimelineFilters({})).toContain("deleted_at");
    expect(describeDealPhotoTimelineFilters({ includeDeleted: true })).not.toContain("deleted_at");
  });

  it("adds category, uploader, and taken-at date filters", async () => {
    const filters = {
      categories: ["damage", "uncategorized"],
      uploaderIds: ["user-1", "user-2"],
      from: "2026-01-01",
      to: "2026-05-04",
    };
    await expect(buildDealPhotoTimelineConditions(tenantDb() as any, "deal-1", filters)).resolves.toBeTruthy();
    const keys = describeDealPhotoTimelineFilters(filters);

    expect(keys).toContain("photo_category");
    expect(keys).toContain("uploaded_by");
    expect(keys).toContain("taken_at");
    expect(keys).toContain("created_at");
  });
});
