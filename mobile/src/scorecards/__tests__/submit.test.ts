import { scorecardPhotoUploadInput, pendingScorecardPhotoIds } from "../submit";
import type { ScorecardDraftPhoto } from "../draft";

describe("scorecardPhotoUploadInput", () => {
  it("targets the deal and auto-tags scorecard + section, trimming the caption", () => {
    const photo: ScorecardDraftPhoto = {
      key: "p1", uri: "file://p1", clientUploadId: "cu-1", sectionKey: "schedule", caption: "  Slab crack  ",
    };
    const input = scorecardPhotoUploadInput(photo, "deal-1");
    expect(input.target).toEqual({ dealId: "deal-1" });
    expect(input.tags).toEqual(["scorecard", "schedule"]);
    expect(input.caption).toBe("Slab crack");
    expect(input.clientUploadId).toBe("cu-1");
    expect(input.category).toBeNull();
  });

  it("nulls a blank caption", () => {
    const photo: ScorecardDraftPhoto = { key: "p", uri: "u", clientUploadId: "c", sectionKey: "quality", caption: "   " };
    expect(scorecardPhotoUploadInput(photo, "d").caption).toBeNull();
  });
});

describe("pendingScorecardPhotoIds", () => {
  it("returns only the draft's ids that are still queued", () => {
    expect(pendingScorecardPhotoIds(["a", "b", "c"], ["b", "z"])).toEqual(["b"]);
    expect(pendingScorecardPhotoIds(["a"], [])).toEqual([]);
    expect(pendingScorecardPhotoIds([], ["a"])).toEqual([]);
  });
});
