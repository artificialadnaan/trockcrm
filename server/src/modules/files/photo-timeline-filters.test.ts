import { describe, expect, it } from "vitest";
import { describeDealPhotoTimelineFilters } from "./photo-timeline-filters.js";

describe("describeDealPhotoTimelineFilters", () => {
  it("adds the photo_ids key only when a non-empty photoIds whitelist is provided", () => {
    expect(describeDealPhotoTimelineFilters({})).not.toContain("photo_ids");
    expect(describeDealPhotoTimelineFilters({ photoIds: [] })).not.toContain("photo_ids");
    expect(describeDealPhotoTimelineFilters({ photoIds: ["  "] })).not.toContain("photo_ids");
    expect(describeDealPhotoTimelineFilters({ photoIds: ["photo-1"] })).toContain("photo_ids");
  });
});
