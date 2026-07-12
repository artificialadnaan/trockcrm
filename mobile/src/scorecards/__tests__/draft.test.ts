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
  resolveScorecardTeamNames,
  seedScorecardDraftTeam,
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
// Score every V2 section to 10/10 and add both required electronic signatures.
function fullyScored(): ScorecardDraft {
  let d = newDraft();
  for (const k of FIELD_SCORECARD_SECTION_KEYS) {
    d = scorecardDraftReducer(d, { type: "setScore", sectionKey: k, points: 10 });
  }
  d = scorecardDraftReducer(d, { type: "setSignature", field: "superintendentSignature", value: "Sam Super" });
  d = scorecardDraftReducer(d, { type: "setSignature", field: "pmSignature", value: "Pat PM" });
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
  it("averages all eight categories and derives the rating", () => {
    const d = fullyScored();
    expect(scorecardDraftTotal(d)).toBe(10);
    expect(isScorecardDraftComplete(d)).toBe(true);
    expect(scorecardDraftRating(d)).toBe("elite");
  });

  it("tracks a selected slider value", () => {
    let d = newDraft();
    d = scorecardDraftReducer(d, { type: "setScore", sectionKey: "planning_precon", points: 1 });
    expect(d.scores.planning_precon).toBe(1);
    expect(scorecardDraftTotal(d)).toBe(0.1);
  });

  it("re-scoring a section overwrites, not accumulates", () => {
    let d = newDraft();
    d = scorecardDraftReducer(d, { type: "setScore", sectionKey: "schedule", points: 8 });
    d = scorecardDraftReducer(d, { type: "setScore", sectionKey: "schedule", points: 9 });
    expect(d.scores.schedule).toBe(9);
  });
});

describe("category action items", () => {
  it("keeps action items optional at the card level", () => {
    let d = fullyScored();
    d = scorecardDraftReducer(d, { type: "setScore", sectionKey: "schedule", points: 4 });
    expect(scorecardActionItemsRequired(d)).toBe(false);
    expect(validateScorecardDraft(d).needsActionItems).toBe(false);
    expect(validateScorecardDraft(d).canSubmit).toBe(true);
  });

  it("allows deficiency evidence without a global action-item gate", () => {
    let d = fullyScored();
    d = scorecardDraftReducer(d, { type: "toggleDeficiency", key: "failed_inspection" });
    expect(scorecardActionItemsRequired(d)).toBe(false);
    expect(validateScorecardDraft(d).canSubmit).toBe(true);
  });

  it("toggleDeficiency adds then removes", () => {
    let d = newDraft();
    d = scorecardDraftReducer(d, { type: "toggleDeficiency", key: "safety_violation" });
    expect(d.criticalDeficiencies).toEqual(["safety_violation"]);
    d = scorecardDraftReducer(d, { type: "toggleDeficiency", key: "safety_violation" });
    expect(d.criticalDeficiencies).toEqual([]);
  });
});

describe("validation", () => {
  it("blocks submit until all 8 sections are scored", () => {
    let d = newDraft();
    d = scorecardDraftReducer(d, { type: "setScore", sectionKey: "schedule", points: 8 });
    const v = validateScorecardDraft(d);
    expect(v.missingSections.length).toBe(7);
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

describe("resolveScorecardTeamNames", () => {
  it("passes the field route's resolved super + PM names through to the seed", () => {
    const names = resolveScorecardTeamNames({ superintendentName: "Sam Super", pmName: "Pat PM" });
    expect(names).toEqual({ superintendentName: "Sam Super", pmName: "Pat PM" });
  });

  it("skips blank/whitespace/null names and omits a role with none", () => {
    const names = resolveScorecardTeamNames({ superintendentName: "   ", pmName: null });
    expect(names.superintendentName).toBeUndefined();
    expect(names.pmName).toBeUndefined();

    const partial = resolveScorecardTeamNames({ superintendentName: "Real Super", pmName: null });
    expect(partial).toEqual({ superintendentName: "Real Super" });
    expect(partial.pmName).toBeUndefined();
  });

  it("returns an empty object when the team resolves to no names (or is missing)", () => {
    expect(resolveScorecardTeamNames({ superintendentName: null, pmName: null })).toEqual({});
    expect(resolveScorecardTeamNames(null)).toEqual({});
    expect(resolveScorecardTeamNames(undefined)).toEqual({});
  });
});

describe("seedScorecardDraftTeam", () => {
  it("fills blank super/PM fields from resolved names, keeping them editable", () => {
    const d = newDraft();
    expect(d.superintendentName).toBe("");
    const seeded = seedScorecardDraftTeam(d, { superintendentName: "Sam Super", pmName: "Pat PM" });
    expect(seeded.superintendentName).toBe("Sam Super");
    expect(seeded.pmName).toBe("Pat PM");
    // Still a normal field — a later setHeader overrides the seed.
    const edited = scorecardDraftReducer(seeded, { type: "setHeader", field: "pmName", value: "Someone Else" });
    expect(edited.pmName).toBe("Someone Else");
  });

  it("never clobbers a name the user already typed", () => {
    let d = newDraft();
    d = scorecardDraftReducer(d, { type: "setHeader", field: "superintendentName", value: "Typed Super" });
    const seeded = seedScorecardDraftTeam(d, { superintendentName: "CRM Super", pmName: "CRM PM" });
    expect(seeded.superintendentName).toBe("Typed Super"); // preserved
    expect(seeded.pmName).toBe("CRM PM"); // blank field still seeded
  });

  it("returns the SAME reference when there is nothing to seed (no needless autosave)", () => {
    const d = newDraft();
    expect(seedScorecardDraftTeam(d, {})).toBe(d);
    // A resolved name that would fill an already-filled field is also a no-op.
    let filled = scorecardDraftReducer(d, { type: "setHeader", field: "superintendentName", value: "Sam" });
    filled = scorecardDraftReducer(filled, { type: "setHeader", field: "pmName", value: "Pat" });
    expect(seedScorecardDraftTeam(filled, { superintendentName: "X", pmName: "Y" })).toBe(filled);
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
    expect(payload.formVersion).toBe(2);
    expect(payload.items).toHaveLength(8);
    expect(payload.items[0].sectionKey).toBe("planning_precon"); // canonical order
    expect(payload.items.find((i) => i.sectionKey === "schedule")?.note).toBe("on track");
    expect(payload.actionItems).toEqual(["do X", "do Y"]); // trimmed + blanks dropped
    expect(payload.photos).toEqual([{ sectionKey: "schedule", deficiencyKey: null, clientUploadId: "cu-1" }]);
  });
});
