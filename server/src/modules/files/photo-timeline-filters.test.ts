import { describe, expect, it } from "vitest";
import { describeDealPhotoTimelineFilters, latestActiveVersionCondition } from "./photo-timeline-filters.js";

describe("describeDealPhotoTimelineFilters", () => {
  it("always includes the core scope keys (incl. latest_version)", () => {
    expect(describeDealPhotoTimelineFilters({})).toEqual(
      expect.arrayContaining(["deal_scope", "file_category", "active_file", "latest_version", "deleted_at"]),
    );
  });
});

describe("latestActiveVersionCondition", () => {
  it("excludes a row when an active family member has a HIGHER version (handles flat parent=root chains)", () => {
    const sqlText = JSON.stringify(latestActiveVersionCondition());
    // Groups the whole version family (root + every child) via COALESCE(parent_file_id, id) and excludes
    // a row only when an active sibling has a greater version — so intermediate versions (v2 when v3
    // exists) are correctly hidden, not just the root.
    expect(sqlText).toContain("COALESCE");
    expect(sqlText).toContain("parent_file_id");
    expect(sqlText).toContain("is_active");
    expect(sqlText).toMatch(/version[^a-z]*>[^a-z]*files\.version|f2\.version\s*>\s*files\.version/);
    // Must NOT be the old single-level check (only excluded the root).
    expect(sqlText).not.toContain("f2.parent_file_id = files.id");
  });
});
