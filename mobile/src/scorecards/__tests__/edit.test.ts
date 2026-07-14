import type { FieldScorecardDetail } from "../../api/types";
import {
  createScorecardEditDraft,
  refreshScorecardEditPhotoUrls,
  scorecardDraftToUpdate,
} from "../edit";
import {
  isExistingScorecardDraftPhoto,
  isNewScorecardDraftPhoto,
  scorecardDraftNewPhotos,
  type ScorecardDraftPhoto,
} from "../draft";
import {
  FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS,
  FIELD_SCORECARD_SECTION_KEYS,
} from "../scoring";

const PROJECT_ITEMS = FIELD_SCORECARD_SECTION_KEYS.map((sectionKey, index) => ({
  sectionKey,
  points: index + 1,
  note: index === 0 ? "  Mobilization plan  " : null,
}));

function detail(overrides: Partial<FieldScorecardDetail> = {}): FieldScorecardDetail {
  return {
    id: "scorecard-1",
    dealId: "deal-1",
    weekOf: "2026-07-14",
    totalScore: 4.5,
    averageScore: 4.5,
    rating: "corrective_action",
    ratingLabel: "Corrective Action Required",
    superintendentName: "Sam Superintendent",
    pmName: "Pat Manager",
    projectName: "  Riverwalk Apartments  ",
    projectNumber: "DFW-1-10000-aa",
    criticalDeficiencyCount: 1,
    submittedByName: "Erin Evaluator",
    submittedAt: "2026-07-14T14:00:00.000Z",
    officeId: "office-1",
    officeSlug: "dfw",
    formVersion: 2,
    kind: "project",
    canEdit: true,
    updatedAt: "2026-07-14T14:05:00.000Z",
    items: PROJECT_ITEMS,
    criticalDeficiencies: ["failed_inspection"],
    criticalDeficiencyNotes: { failed_inspection: "  Reinspect stair rail  " },
    actionItems: ["Repair stair rail"],
    photos: [
      {
        id: "scorecard-photo-1",
        fileId: "file-1",
        sectionKey: "quality",
        deficiencyKey: null,
        url: "https://old.example/photo.jpg",
        caption: "Existing evidence",
      },
      {
        id: "scorecard-photo-2",
        fileId: "file-2",
        sectionKey: "critical_deficiency",
        deficiencyKey: "failed_inspection",
        url: null,
        caption: null,
      },
    ],
    superintendentSignature: "data:image/png;base64,old-super-signature",
    pmSignature: "Pat Manager (typed legacy signature)",
    summary: null,
    ...overrides,
  };
}

describe("createScorecardEditDraft", () => {
  it("hydrates a V2 project edit while requiring fresh signatures", () => {
    const draft = createScorecardEditDraft(detail(), {
      id: "local-edit-1",
      clientSubmissionId: "edit-attempt-1",
      now: 1234,
    });

    expect(draft).toMatchObject({
      id: "local-edit-1",
      clientSubmissionId: "edit-attempt-1",
      editingScorecardId: "scorecard-1",
      editingOfficeId: "office-1",
      editBaseUpdatedAt: "2026-07-14T14:05:00.000Z",
      dealId: "deal-1",
      dealName: "Riverwalk Apartments",
      projectNumber: "DFW-1-10000-aa",
      weekOf: "2026-07-14",
      superintendentName: "Sam Superintendent",
      pmName: "Pat Manager",
      scores: Object.fromEntries(PROJECT_ITEMS.map((item) => [item.sectionKey, item.points])),
      criticalDeficiencies: ["failed_inspection"],
      deficiencyNotes: { failed_inspection: "Reinspect stair rail" },
      actionItems: ["Repair stair rail"],
      evidenceUploadAttempted: false,
      superintendentSignature: "",
      pmSignature: "",
      createdAt: 1234,
      updatedAt: 1234,
    });
    expect(draft.kind).toBeUndefined();
    expect(draft.notes.planning_precon).toBe("  Mobilization plan  ");
    expect(draft.photos).toEqual([
      {
        key: "submitted:scorecard-photo-1",
        uri: "https://old.example/photo.jpg",
        existingScorecardPhotoId: "scorecard-photo-1",
        sectionKey: "quality",
        deficiencyKey: undefined,
        caption: "Existing evidence",
      },
      {
        key: "submitted:scorecard-photo-2",
        uri: "",
        existingScorecardPhotoId: "scorecard-photo-2",
        sectionKey: "critical_deficiency",
        deficiencyKey: "failed_inspection",
        caption: "",
      },
    ]);
    expect(draft.photos.every(isExistingScorecardDraftPhoto)).toBe(true);
    expect(scorecardDraftNewPhotos(draft)).toEqual([]);
  });

  it("hydrates leadership fields, category/summary evidence, and no project-only data", () => {
    const leadershipItems = FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS.map((sectionKey) => ({
      sectionKey,
      points: 9,
      note: `${sectionKey} note`,
    }));
    const draft = createScorecardEditDraft(detail({
      kind: "leadership",
      totalScore: 9,
      averageScore: 9,
      rating: "elite",
      ratingLabel: "Elite Execution",
      items: leadershipItems,
      summary: "Strong leadership visit",
      criticalDeficiencies: ["failed_inspection"],
      criticalDeficiencyNotes: { failed_inspection: "must not carry over" },
      actionItems: ["must not carry over"],
      photos: [
        {
          id: "lead-photo-1",
          fileId: "file-lead-1",
          sectionKey: "quality_control",
          deficiencyKey: null,
          url: "https://example.test/category.jpg",
          caption: "Category evidence",
        },
        {
          id: "lead-photo-2",
          fileId: "file-lead-2",
          sectionKey: "project_summary",
          deficiencyKey: null,
          url: "https://example.test/summary.jpg",
          caption: "Summary evidence",
        },
      ],
    }), { id: "local-lead", clientSubmissionId: "lead-edit", now: 99 });

    expect(draft.kind).toBe("leadership");
    expect(draft.evaluatorName).toBe("Erin Evaluator");
    expect(draft.summary).toBe("Strong leadership visit");
    expect(draft.scores).toEqual(Object.fromEntries(leadershipItems.map((item) => [item.sectionKey, 9])));
    expect(draft.criticalDeficiencies).toEqual([]);
    expect(draft.deficiencyNotes).toEqual({});
    expect(draft.actionItems).toEqual([]);
    expect(draft.photos.map((photo) => photo.sectionKey)).toEqual(["quality_control", "project_summary"]);
  });

  it("rejects a non-owner or historical form before creating a local edit", () => {
    expect(() => createScorecardEditDraft(detail({ canEdit: false }), {
      id: "local",
      clientSubmissionId: "attempt",
      now: 0,
    })).toThrow("Only the submitter can edit this scorecard.");
    expect(() => createScorecardEditDraft(detail({ formVersion: 1 }), {
      id: "local",
      clientSubmissionId: "attempt",
      now: 0,
    })).toThrow("Historical scorecards cannot be edited in T-Rock Cam.");
  });
});

describe("refreshScorecardEditPhotoUrls", () => {
  it("refreshes only retained URLs and preserves local captions, placement, and new local evidence", () => {
    const base = createScorecardEditDraft(detail(), {
      id: "local-edit-1",
      clientSubmissionId: "edit-attempt-1",
      now: 1234,
    });
    const newPhoto: ScorecardDraftPhoto = {
      key: "new-photo",
      uri: "file:///local/new-photo.jpg",
      clientUploadId: "new-upload-1",
      sectionKey: "safety",
      caption: "Local new caption",
    };
    const edited = {
      ...base,
      photos: [
        { ...base.photos[0], sectionKey: "schedule" as const, caption: "Locally edited caption" },
        ...base.photos.slice(1),
        newPhoto,
      ],
    };
    const refreshed = refreshScorecardEditPhotoUrls(edited, detail({
      photos: detail().photos.map((photo) => photo.id === "scorecard-photo-1"
        ? { ...photo, url: "https://fresh.example/photo.jpg", caption: "Stale server caption" }
        : photo),
    }));

    expect(refreshed.photos[0]).toMatchObject({
      existingScorecardPhotoId: "scorecard-photo-1",
      uri: "https://fresh.example/photo.jpg",
      sectionKey: "schedule",
      caption: "Locally edited caption",
    });
    expect(refreshed.photos[2]).toBe(newPhoto);
    expect(isNewScorecardDraftPhoto(refreshed.photos[2])).toBe(true);
  });

  it("does nothing when the detail belongs to a different submitted card", () => {
    const draft = createScorecardEditDraft(detail(), { id: "local", clientSubmissionId: "edit", now: 1 });
    expect(refreshScorecardEditPhotoUrls(draft, detail({ id: "other-scorecard" }))).toBe(draft);
  });
});

describe("scorecardDraftToUpdate", () => {
  it("builds a project full replacement with retained/new evidence references and fresh signatures", () => {
    const retainedDraft = createScorecardEditDraft(detail(), {
      id: "local-edit-1",
      clientSubmissionId: "edit-attempt-1",
      now: 1234,
    });
    const draft = {
      ...retainedDraft,
      superintendentName: "  New Superintendent  ",
      pmName: "  New PM  ",
      actionItems: ["  Recover schedule  ", "   "],
      superintendentSignature: "  data:image/png;base64,new-super  ",
      pmSignature: "  New PM typed signature  ",
      photos: [
        retainedDraft.photos[0],
        {
          key: "new-photo",
          uri: "file:///new.jpg",
          clientUploadId: "new-upload-1",
          sectionKey: "safety" as const,
          caption: "New evidence",
        },
      ],
    };

    expect(scorecardDraftToUpdate(draft)).toEqual({
      expectedUpdatedAt: "2026-07-14T14:05:00.000Z",
      superintendentName: "New Superintendent",
      pmName: "New PM",
      items: PROJECT_ITEMS.map((item) => ({
        sectionKey: item.sectionKey,
        points: item.points,
        note: item.note?.trim() || null,
      })),
      criticalDeficiencies: ["failed_inspection"],
      criticalDeficiencyNotes: { failed_inspection: "Reinspect stair rail" },
      actionItems: ["Recover schedule"],
      superintendentSignature: "data:image/png;base64,new-super",
      pmSignature: "New PM typed signature",
      summary: null,
      photos: [
        {
          scorecardPhotoId: "scorecard-photo-1",
          sectionKey: "quality",
          deficiencyKey: null,
        },
        {
          clientUploadId: "new-upload-1",
          sectionKey: "safety",
          deficiencyKey: null,
        },
      ],
    });
  });

  it("builds leadership-only fields and nulls project-only fields", () => {
    const leadershipItems = FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS.map((sectionKey) => ({
      sectionKey,
      points: 8,
      note: null,
    }));
    const draft = createScorecardEditDraft(detail({
      kind: "leadership",
      items: leadershipItems,
      summary: "  Field leaders aligned  ",
      criticalDeficiencies: [],
      actionItems: [],
      photos: [],
    }), { id: "lead-local", clientSubmissionId: "lead-attempt", now: 5 });

    expect(scorecardDraftToUpdate(draft)).toMatchObject({
      expectedUpdatedAt: "2026-07-14T14:05:00.000Z",
      criticalDeficiencies: [],
      criticalDeficiencyNotes: {},
      actionItems: [],
      superintendentSignature: null,
      pmSignature: null,
      summary: "Field leaders aligned",
      items: leadershipItems,
    });
  });

  it("refuses to create a PUT body without the submitted id and revision", () => {
    const draft = createScorecardEditDraft(detail(), { id: "local", clientSubmissionId: "edit", now: 1 });
    expect(() => scorecardDraftToUpdate({ ...draft, editBaseUpdatedAt: undefined })).toThrow(
      "A submitted scorecard edit is missing its server revision.",
    );
    expect(() => scorecardDraftToUpdate({ ...draft, editingScorecardId: undefined })).toThrow(
      "A submitted scorecard edit is missing its server revision.",
    );
  });
});
