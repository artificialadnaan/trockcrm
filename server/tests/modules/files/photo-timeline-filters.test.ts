import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildDealPhotoTimelineConditions,
  describeDealPhotoTimelineFilters,
  latestActiveVersionCondition,
} from "../../../src/modules/files/photo-timeline-filters.js";

const dialect = new PgDialect();

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
      tags: ["roofing"],
      uploaderIds: ["user-1", "user-2"],
      from: "2026-01-01",
      to: "2026-05-04",
    };
    await expect(buildDealPhotoTimelineConditions(tenantDb() as any, "deal-1", filters)).resolves.toBeTruthy();
    const keys = describeDealPhotoTimelineFilters(filters);

    expect(keys).toContain("photo_category");
    expect(keys).toContain("tags");
    expect(keys).toContain("uploaded_by");
    expect(keys).toContain("taken_at");
    expect(keys).toContain("created_at");
  });
});

describe("latestActiveVersionCondition", () => {
  it("excludes a row when an active family member has a HIGHER version (handles flat parent=root chains)", () => {
    const sqlText = dialect.sqlToQuery(latestActiveVersionCondition()).sql;
    // Groups the whole version family (root + every child) via COALESCE(parent_file_id, id) and excludes
    // a row only when an active sibling has a greater version — so intermediate versions (v2 when v3
    // exists) are correctly hidden, not just the root.
    expect(sqlText).toContain("COALESCE");
    expect(sqlText).toContain("parent_file_id");
    expect(sqlText).toContain("is_active");
    expect(sqlText).toMatch(/f2\.version\s*>\s*files\.version/);
    // Must NOT be the old single-level check (only excluded the root).
    expect(sqlText).not.toContain("f2.parent_file_id = files.id");
  });
});
