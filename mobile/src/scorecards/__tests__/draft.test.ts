import {
  createScorecardDraft,
  scorecardDraftReducer,
  scorecardDraftTotal,
  isScorecardDraftComplete,
  scorecardDraftRating,
  scorecardActionItemsRequired,
  scorecardDraftPhotosForSection,
  validateScorecardDraft,
  scorecardDraftToSubmission,
  type ScorecardDraft,
} from "../draft";
import { FIELD_SCORECARD_SECTION_KEYS } from "../scoring";

function newDraft(): ScorecardDraft {
  return createScorecardDraft({
    id: "d1",
    clientSubmissionId: "sub-1",
    dealId: "deal-1",
    dealName: "Maple St",
    projectNumber: "DFW-10432",
    weekOf: "2026-06-30",
    now: 1000,
  });
}
// Score every section to its max (total 100).
function fullyScored(): ScorecardDraft {
  let d = newDraft();
  const max: Record<string, number> = {
    planning_precon: 10, jobsite_5s: 15, schedule: 20, subcontractor: 15, quality: 20, communication: 10, financial: 10,
  };
  for (const k of FIELD_SCORECARD_SECTION_KEYS) {
    d = scorecardDraftReducer(d, { type: "setScore", sectionKey: k, points: max[k] });
  }
  return d;
}

describe("createScorecardDraft", () => {
  it("starts empty with the passed header + a stable idempotency id", () => {
    const d = newDraft();
    expect(d.clientSubmissionId).toBe("sub-1");
    expect(d.dealId).toBe("deal-1");
    expect(Object.keys(d.scores)).toHaveLength(0);
    expect(d.photos).toEqual([]);
    expect(d.criticalDeficiencies).toEqual([]);
    expect(isScorecardDraftComplete(d)).toBe(false);
  });
});

describe("scoring", () => {
  it("sums answered sections and derives the rating", () => {
    const d = fullyScored();
    expect(scorecardDraftTotal(d)).toBe(100);
    expect(isScorecardDraftComplete(d)).toBe(true);
    expect(scorecardDraftRating(d)).toBe("elite");
  });

  it("treats an explicit 0 as answered", () => {
    let d = newDraft();
    d = scorecardDraftReducer(d, { type: "setScore", sectionKey: "planning_precon", points: 0 });
    expect(d.scores.planning_precon).toBe(0);
    expect(scorecardDraftTotal(d)).toBe(0);
  });

  it("re-scoring a section overwrites, not accumulates", () => {
    let d = newDraft();
    d = scorecardDraftReducer(d, { type: "setScore", sectionKey: "schedule", points: 20 });
    d = scorecardDraftReducer(d, { type: "setScore", sectionKey: "schedule", points: 10 });
    expect(d.scores.schedule).toBe(10);
  });
});

describe("action-item gate", () => {
  it("requires action items below 85", () => {
    let d = fullyScored();
    d = scorecardDraftReducer(d, { type: "setScore", sectionKey: "schedule", points: 0 }); // 80
    expect(scorecardActionItemsRequired(d)).toBe(true);
    expect(validateScorecardDraft(d).needsActionItems).toBe(true);
    expect(validateScorecardDraft(d).canSubmit).toBe(false);

    d = scorecardDraftReducer(d, { type: "setActionItems", items: ["Re-sequence the pour"] });
    expect(validateScorecardDraft(d).needsActionItems).toBe(false);
    expect(validateScorecardDraft(d).canSubmit).toBe(true);
  });

  it("requires action items when a deficiency is flagged even at 100", () => {
    let d = fullyScored();
    d = scorecardDraftReducer(d, { type: "toggleDeficiency", key: "failed_inspection" });
    expect(scorecardActionItemsRequired(d)).toBe(true);
    expect(validateScorecardDraft(d).canSubmit).toBe(false);
  });

  it("toggleDeficiency adds then removes", () => {
    let d = newDraft();
    d = scorecardDraftReducer(d, { type: "toggleDeficiency", key: "safety_access" });
    expect(d.criticalDeficiencies).toEqual(["safety_access"]);
    d = scorecardDraftReducer(d, { type: "toggleDeficiency", key: "safety_access" });
    expect(d.criticalDeficiencies).toEqual([]);
  });
});

describe("validation", () => {
  it("blocks submit until all 7 sections are scored", () => {
    let d = newDraft();
    d = scorecardDraftReducer(d, { type: "setScore", sectionKey: "schedule", points: 20 });
    const v = validateScorecardDraft(d);
    expect(v.missingSections.length).toBe(6);
    expect(v.canSubmit).toBe(false);
  });

  it("blocks submit when weekOf is blank", () => {
    let d = fullyScored();
    d = scorecardDraftReducer(d, { type: "setHeader", field: "weekOf", value: "" });
    expect(validateScorecardDraft(d).missingWeekOf).toBe(true);
    expect(validateScorecardDraft(d).canSubmit).toBe(false);
  });

  it("blocks submit on a malformed weekOf (typo / impossible calendar date)", () => {
    let d = fullyScored();
    for (const bad of ["2026-02-30", "2026-2-3", "2026-13-01", "nope"]) {
      d = scorecardDraftReducer(d, { type: "setHeader", field: "weekOf", value: bad });
      expect(validateScorecardDraft(d).missingWeekOf).toBe(true);
    }
    d = scorecardDraftReducer(d, { type: "setHeader", field: "weekOf", value: "2026-06-30" });
    expect(validateScorecardDraft(d).missingWeekOf).toBe(false);
    expect(validateScorecardDraft(d).canSubmit).toBe(true);
  });
});

describe("photos", () => {
  it("adds, captions, filters by section, and removes", () => {
    let d = newDraft();
    d = scorecardDraftReducer(d, {
      type: "addPhoto",
      photo: { key: "p1", uri: "file://p1", clientUploadId: "cu-1", sectionKey: "schedule", caption: "" },
    });
    d = scorecardDraftReducer(d, {
      type: "addPhoto",
      photo: { key: "p2", uri: "file://p2", clientUploadId: "cu-2", sectionKey: "quality", caption: "" },
    });
    d = scorecardDraftReducer(d, { type: "setPhotoCaption", key: "p1", caption: "Slab crack" });
    expect(scorecardDraftPhotosForSection(d, "schedule").map((p) => p.caption)).toEqual(["Slab crack"]);
    expect(scorecardDraftPhotosForSection(d, "quality")).toHaveLength(1);

    d = scorecardDraftReducer(d, { type: "removePhoto", key: "p1" });
    expect(scorecardDraftPhotosForSection(d, "schedule")).toHaveLength(0);
  });

  it("setPhotoUri swaps a photo's uri (raw → durable) without touching others", () => {
    let d = newDraft();
    d = scorecardDraftReducer(d, {
      type: "addPhoto",
      photo: { key: "p1", uri: "file://raw1", clientUploadId: "cu-1", sectionKey: "schedule", caption: "" },
    });
    d = scorecardDraftReducer(d, {
      type: "addPhoto",
      photo: { key: "p2", uri: "file://raw2", clientUploadId: "cu-2", sectionKey: "quality", caption: "" },
    });
    d = scorecardDraftReducer(d, { type: "setPhotoUri", key: "p1", uri: "file://durable1" });
    expect(d.photos.find((p) => p.key === "p1")?.uri).toBe("file://durable1");
    expect(d.photos.find((p) => p.key === "p2")?.uri).toBe("file://raw2");
  });
});

describe("appendNote", () => {
  it("appends to the current note (dictation-safe — no stale-closure clobber)", () => {
    let d = newDraft();
    d = scorecardDraftReducer(d, { type: "setNote", sectionKey: "schedule", note: "typed" });
    d = scorecardDraftReducer(d, { type: "appendNote", sectionKey: "schedule", text: "dictated" });
    expect(d.notes.schedule).toBe("typed dictated");
  });
  it("starts fresh when the note is empty", () => {
    let d = newDraft();
    d = scorecardDraftReducer(d, { type: "appendNote", sectionKey: "quality", text: "first" });
    expect(d.notes.quality).toBe("first");
  });
});

describe("appendActionItem", () => {
  it("appends a trimmed transcript as a new action item (dictation-safe)", () => {
    let d = newDraft();
    d = scorecardDraftReducer(d, { type: "setActionItems", items: ["Re-pour slab"] });
    d = scorecardDraftReducer(d, { type: "appendActionItem", text: "  Schedule recovery meeting  " });
    expect(d.actionItems).toEqual(["Re-pour slab", "Schedule recovery meeting"]);
  });
  it("drops trailing blank lines before appending (no double blank from a mid-typed newline)", () => {
    let d = newDraft();
    d = scorecardDraftReducer(d, { type: "setActionItems", items: ["First", ""] });
    d = scorecardDraftReducer(d, { type: "appendActionItem", text: "Second" });
    expect(d.actionItems).toEqual(["First", "Second"]);
  });
  it("ignores an empty/whitespace transcript", () => {
    let d = newDraft();
    d = scorecardDraftReducer(d, { type: "setActionItems", items: ["Keep"] });
    d = scorecardDraftReducer(d, { type: "appendActionItem", text: "   " });
    expect(d.actionItems).toEqual(["Keep"]);
  });
});

describe("scorecardDraftToSubmission", () => {
  it("builds the POST payload in canonical section order with trimmed action items + photo refs", () => {
    let d = fullyScored();
    d = scorecardDraftReducer(d, { type: "setNote", sectionKey: "schedule", note: "  on track  " });
    d = scorecardDraftReducer(d, { type: "setActionItems", items: ["  do X  ", "", "do Y"] });
    d = scorecardDraftReducer(d, {
      type: "addPhoto",
      photo: { key: "p1", uri: "file://p1", clientUploadId: "cu-1", sectionKey: "schedule", caption: "c" },
    });

    const payload = scorecardDraftToSubmission(d);
    expect(payload.clientSubmissionId).toBe("sub-1");
    expect(payload.dealId).toBe("deal-1");
    expect(payload.items).toHaveLength(7);
    expect(payload.items[0].sectionKey).toBe("planning_precon"); // canonical order
    expect(payload.items.find((i) => i.sectionKey === "schedule")?.note).toBe("on track");
    expect(payload.actionItems).toEqual(["do X", "do Y"]); // trimmed + blanks dropped
    expect(payload.photos).toEqual([{ sectionKey: "schedule", clientUploadId: "cu-1" }]);
  });
});
