import type { FieldScorecardDetail } from "../../api/types";
import {
  createScorecardEditDraft,
  rebaseScorecardEditDraft,
  refreshScorecardEditPhotoUrls,
  scorecardEditRebaseMessage,
  scorecardDraftToUpdate,
} from "../edit";
import {
  isExistingScorecardDraftPhoto,
  isNewScorecardDraftPhoto,
  scorecardDraftReducer,
  scorecardDraftNewPhotos,
  validateScorecardDraft,
  MAX_SCORECARD_PHOTOS,
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
      editBasePhotoIds: ["scorecard-photo-1", "scorecard-photo-2"],
      editBaseCriticalDeficiencies: ["failed_inspection"],
      editBaseCriticalDeficiencyNotes: { failed_inspection: "Reinspect stair rail" },
      editTouchedCriticalDeficiencies: [],
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
    expect(draft.editBaseContentFingerprint).toMatch(/^v1:\d+:[a-f0-9]{16}$/);
    expect(draft.editBaseContentFingerprint!.length).toBeLessThan(40);
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
  it("refreshes canonical retained metadata, preserves placement/new evidence, and clears project signatures", () => {
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
      superintendentSignature: "fresh-super-signature",
      pmSignature: "fresh-pm-signature",
      photos: [
        { ...base.photos[0], sectionKey: "schedule" as const, caption: "Locally edited caption" },
        ...base.photos.slice(1),
        newPhoto,
      ],
    };
    const refreshed = refreshScorecardEditPhotoUrls(edited, detail({
      updatedAt: "2026-07-14T14:10:00.000Z",
      photos: detail().photos.map((photo) => photo.id === "scorecard-photo-1"
        ? { ...photo, url: "https://fresh.example/photo.jpg", caption: "Stale server caption" }
        : photo),
    }));

    expect(refreshed.photos[0]).toMatchObject({
      existingScorecardPhotoId: "scorecard-photo-1",
      uri: "https://fresh.example/photo.jpg",
      sectionKey: "schedule",
      caption: "Stale server caption",
    });
    expect(refreshed.superintendentSignature).toBe("");
    expect(refreshed.pmSignature).toBe("");
    expect(refreshed.editBaseUpdatedAt).toBe("2026-07-14T14:10:00.000Z");
    expect(refreshed.photos[2]).toBe(newPhoto);
    expect(isNewScorecardDraftPhoto(refreshed.photos[2])).toBe(true);
  });

  it("keeps the old token when a caption refresh also contains a concurrent form edit", () => {
    const base = createScorecardEditDraft(detail(), { id: "local", clientSubmissionId: "edit", now: 1 });
    const refreshed = refreshScorecardEditPhotoUrls(base, detail({
      updatedAt: "2026-07-14T14:15:00.000Z",
      superintendentName: "Changed in another edit",
      photos: detail().photos.map((photo) => photo.id === "scorecard-photo-1"
        ? { ...photo, caption: "Canonical updated description" }
        : photo),
    }));

    expect(refreshed.photos[0]).toMatchObject({ caption: "Canonical updated description" });
    expect(refreshed.editBaseUpdatedAt).toBe("2026-07-14T14:05:00.000Z");
  });

  it("treats an older cached detail as a complete no-op", () => {
    const base = createScorecardEditDraft(detail(), { id: "local", clientSubmissionId: "edit", now: 1 });
    const signed = {
      ...base,
      superintendentSignature: "fresh-super-signature",
      pmSignature: "fresh-pm-signature",
    };
    const refreshed = refreshScorecardEditPhotoUrls(signed, detail({
      updatedAt: "2026-07-14T14:04:00.000Z",
      criticalDeficiencyNotes: { failed_inspection: "Stale note must not be loaded" },
      photos: detail().photos.map((photo) => ({
        ...photo,
        url: `https://older.example/${photo.id}.jpg`,
        caption: "Stale caption must not be loaded",
      })),
    }));

    expect(refreshed).toBe(signed);
    expect(refreshed.photos[0]).toMatchObject({
      uri: "https://old.example/photo.jpg",
      caption: "Existing evidence",
    });
    expect(refreshed.superintendentSignature).toBe("fresh-super-signature");
    expect(refreshed.pmSignature).toBe("fresh-pm-signature");
  });

  it("also ignores a malformed detail revision once a valid edit token is loaded", () => {
    const base = createScorecardEditDraft(detail(), { id: "local", clientSubmissionId: "edit", now: 1 });
    const refreshed = refreshScorecardEditPhotoUrls(base, detail({
      updatedAt: "not-a-revision",
      photos: detail().photos.map((photo) => ({
        ...photo,
        url: `https://malformed.example/${photo.id}.jpg`,
        caption: "Malformed generation caption",
      })),
    }));

    expect(refreshed).toBe(base);
  });

  it("hydrates missing deficiency snapshots when a safe revision refresh advances", () => {
    const legacy = createScorecardEditDraft(detail(), { id: "local", clientSubmissionId: "edit", now: 1 });
    delete legacy.editBaseCriticalDeficiencies;
    delete legacy.editBaseCriticalDeficiencyNotes;

    const refreshed = refreshScorecardEditPhotoUrls(legacy, detail({
      updatedAt: "2026-07-14T14:10:00.000Z",
    }));

    expect(refreshed.editBaseUpdatedAt).toBe("2026-07-14T14:10:00.000Z");
    expect(refreshed.editBaseCriticalDeficiencies).toEqual(["failed_inspection"]);
    expect(refreshed.editBaseCriticalDeficiencyNotes).toEqual({
      failed_inspection: "Reinspect stair rail",
    });
  });

  it("preserves project signatures when only retained URLs rotate", () => {
    const base = createScorecardEditDraft(detail(), { id: "local", clientSubmissionId: "edit", now: 1 });
    const signed = {
      ...base,
      superintendentSignature: "fresh-super-signature",
      pmSignature: "fresh-pm-signature",
    };
    const refreshed = refreshScorecardEditPhotoUrls(signed, detail({
      photos: detail().photos.map((photo) => ({ ...photo, url: `https://fresh.example/${photo.id}.jpg` })),
    }));

    expect(refreshed.superintendentSignature).toBe("fresh-super-signature");
    expect(refreshed.pmSignature).toBe("fresh-pm-signature");
  });

  it("does nothing when the detail belongs to a different submitted card", () => {
    const draft = createScorecardEditDraft(detail(), { id: "local", clientSubmissionId: "edit", now: 1 });
    expect(refreshScorecardEditPhotoUrls(draft, detail({ id: "other-scorecard" }))).toBe(draft);
  });
});

describe("rebaseScorecardEditDraft", () => {
  it.each([
    ["Project", "project" as const],
    ["Leadership", "leadership" as const],
  ])("canonicalizes a response-loss upload before rebasing a %s card", (_label, kind) => {
    const leadership = kind === "leadership";
    const source = detail(leadership ? {
      kind: "leadership",
      items: FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS.map((sectionKey) => ({ sectionKey, points: 8, note: null })),
      criticalDeficiencies: [],
      criticalDeficiencyNotes: {},
      actionItems: [],
      photos: [],
      summary: "Leadership summary",
    } : {});
    const base = createScorecardEditDraft(source, {
      id: `response-loss-${kind}`,
      clientSubmissionId: `response-loss-${kind}-edit`,
      now: 1,
    });
    const sectionKey = leadership ? "safety" as const : "quality" as const;
    const localNewPhoto: ScorecardDraftPhoto = {
      key: "local-response-loss-photo",
      uri: "file:///local/response-loss.jpg",
      clientUploadId: "response-loss-upload-1",
      sectionKey,
      caption: "Local caption from the committed request",
    };
    const local = {
      ...base,
      photos: [...base.photos, localNewPhoto],
      evidenceUploadAttempted: true,
      evidenceUploadAttemptedIds: ["response-loss-upload-1"],
      notes: { ...base.notes, [sectionKey]: "Later local note" },
    };
    const latest = detail({
      ...(leadership ? {
        kind: "leadership",
        items: source.items,
        criticalDeficiencies: [],
        criticalDeficiencyNotes: {},
        actionItems: [],
        summary: "Leadership summary",
      } : {}),
      updatedAt: "2026-07-14T17:00:00.000Z",
      photos: [
        ...source.photos,
        {
          id: "response-loss-link-1",
          fileId: "response-loss-file-1",
          clientUploadId: "response-loss-upload-1",
          sectionKey,
          deficiencyKey: null,
          url: "https://fresh.example/response-loss.jpg",
          caption: "Canonical uploaded caption",
        },
      ],
    });

    const rebased = rebaseScorecardEditDraft(local, latest);
    const matchingPhotos = rebased.draft.photos.filter((photo) =>
      isExistingScorecardDraftPhoto(photo)
        ? photo.existingScorecardPhotoId === "response-loss-link-1"
        : photo.clientUploadId === "response-loss-upload-1",
    );

    expect(matchingPhotos).toEqual([expect.objectContaining({
      existingScorecardPhotoId: "response-loss-link-1",
      sectionKey,
      uri: "https://fresh.example/response-loss.jpg",
      caption: "Canonical uploaded caption",
    })]);
    expect(rebased.mergedServerPhotoCount).toBe(0);
    expect(rebased.draft.notes[sectionKey]).toBe("Later local note");
    expect(scorecardDraftToUpdate(rebased.draft).photos.filter((photo) =>
      ("scorecardPhotoId" in photo && photo.scorecardPhotoId === "response-loss-link-1") ||
      ("clientUploadId" in photo && photo.clientUploadId === "response-loss-upload-1")
    )).toEqual([expect.objectContaining({ scorecardPhotoId: "response-loss-link-1" })]);
  });

  it.each([
    ["Project", "project" as const],
    ["Leadership", "leadership" as const],
  ])("does not resurrect a response-loss upload removed from a %s card", (_label, kind) => {
    const leadership = kind === "leadership";
    const source = detail(leadership ? {
      kind: "leadership",
      items: FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS.map((sectionKey) => ({ sectionKey, points: 8, note: null })),
      criticalDeficiencies: [],
      criticalDeficiencyNotes: {},
      actionItems: [],
      photos: [],
      summary: "Leadership summary",
    } : {});
    const base = createScorecardEditDraft(source, {
      id: `response-loss-remove-${kind}`,
      clientSubmissionId: `response-loss-remove-${kind}-edit`,
      now: 1,
    });
    // The upload was part of a PUT that committed, but after the response was lost the user removed it.
    const local = {
      ...base,
      evidenceUploadAttempted: true,
      evidenceUploadAttemptedIds: ["removed-after-response-loss"],
    };
    const latest = detail({
      ...(leadership ? {
        kind: "leadership",
        items: source.items,
        criticalDeficiencies: [],
        criticalDeficiencyNotes: {},
        actionItems: [],
        summary: "Leadership summary",
      } : {}),
      updatedAt: "2026-07-14T17:05:00.000Z",
      photos: [
        ...source.photos,
        {
          id: "removed-response-loss-link",
          fileId: "removed-response-loss-file",
          clientUploadId: "removed-after-response-loss",
          sectionKey: leadership ? "safety" : "quality",
          deficiencyKey: null,
          url: "https://fresh.example/removed-response-loss.jpg",
          caption: "Removed local evidence",
        },
      ],
    });

    const rebased = rebaseScorecardEditDraft(local, latest);

    expect(rebased.mergedServerPhotoCount).toBe(0);
    expect(rebased.draft.photos.some((photo) =>
      isExistingScorecardDraftPhoto(photo)
        ? photo.existingScorecardPhotoId === "removed-response-loss-link"
        : photo.clientUploadId === "removed-after-response-loss",
    )).toBe(false);
    expect(scorecardDraftToUpdate(rebased.draft).photos.some((photo) =>
      ("scorecardPhotoId" in photo && photo.scorecardPhotoId === "removed-response-loss-link") ||
      ("clientUploadId" in photo && photo.clientUploadId === "removed-after-response-loss")
    )).toBe(false);
  });

  it("keeps a deficiency removal made after a successful PUT response was lost", () => {
    const source = detail({
      criticalDeficiencyCount: 0,
      criticalDeficiencies: [],
      criticalDeficiencyNotes: {},
      photos: [detail().photos[0]],
    });
    const base = createScorecardEditDraft(source, {
      id: "response-loss-deficiency-remove",
      clientSubmissionId: "response-loss-deficiency-remove-edit",
      now: 1,
    });
    const committedUnsigned = scorecardDraftReducer(
      scorecardDraftReducer(base, { type: "toggleDeficiency", key: "safety_violation" }),
      { type: "setDeficiencyNote", key: "safety_violation", note: "Guardrail missing" },
    );
    const committed = {
      ...committedUnsigned,
      superintendentSignature: "signed-before-response-loss",
      pmSignature: "pm-signed-before-response-loss",
    };
    // The first PUT committed `committed`, its response was lost, then the user deliberately undid it.
    const localAfterLoss = scorecardDraftReducer(committed, {
      type: "toggleDeficiency",
      key: "safety_violation",
    });
    const latest = detail({
      ...source,
      updatedAt: "2026-07-14T17:10:00.000Z",
      criticalDeficiencyCount: 1,
      criticalDeficiencies: ["safety_violation"],
      criticalDeficiencyNotes: { safety_violation: "Guardrail missing" },
    });

    const rebased = rebaseScorecardEditDraft(localAfterLoss, latest);

    expect(localAfterLoss.editTouchedCriticalDeficiencies).toContain("safety_violation");
    expect(localAfterLoss.superintendentSignature).toBe("");
    expect(localAfterLoss.pmSignature).toBe("");
    expect(rebased.draft.criticalDeficiencies).toEqual([]);
    expect(rebased.draft.deficiencyNotes).toEqual({});
    expect(rebased.draft.editTouchedCriticalDeficiencies).toContain("safety_violation");
  });

  it("keeps a deficiency note deliberately reverted after a successful PUT response was lost", () => {
    const base = createScorecardEditDraft(detail(), {
      id: "response-loss-deficiency-note",
      clientSubmissionId: "response-loss-deficiency-note-edit",
      now: 1,
    });
    const committed = scorecardDraftReducer(base, {
      type: "setDeficiencyNote",
      key: "failed_inspection",
      note: "Interim committed note",
    });
    const localAfterLoss = scorecardDraftReducer(committed, {
      type: "setDeficiencyNote",
      key: "failed_inspection",
      note: "Reinspect stair rail",
    });
    const latest = detail({
      updatedAt: "2026-07-14T17:20:00.000Z",
      criticalDeficiencyNotes: { failed_inspection: "Interim committed note" },
    });

    const rebased = rebaseScorecardEditDraft(localAfterLoss, latest);

    expect(rebased.draft.criticalDeficiencies).toEqual(["failed_inspection"]);
    expect(rebased.draft.deficiencyNotes).toEqual({ failed_inspection: "Reinspect stair rail" });
  });

  it("advances the revision while preserving local fields/placements/new evidence and re-requiring signatures", () => {
    const base = createScorecardEditDraft(detail(), {
      id: "local-edit-1",
      clientSubmissionId: "edit-attempt-1",
      now: 1234,
    });
    const localNewPhoto: ScorecardDraftPhoto = {
      key: "new-photo",
      uri: "file:///local/new-photo.jpg",
      clientUploadId: "new-upload-1",
      sectionKey: "safety",
      caption: "Local evidence",
    };
    const local = {
      ...base,
      superintendentName: "Locally edited superintendent",
      scores: { ...base.scores, safety: 10 },
      superintendentSignature: "fresh-super-signature",
      pmSignature: "fresh-pm-signature",
      photos: [
        { ...base.photos[0], sectionKey: "schedule" as const, caption: "Local retained caption" },
        base.photos[1],
        localNewPhoto,
      ],
      evidenceUploadAttempted: true,
    };
    const latest = detail({
      updatedAt: "2026-07-14T15:00:00.000Z",
      officeId: "office-2",
      // The other session retained photo 1, removed photo 2, and added a different server photo.
      photos: [
        { ...detail().photos[0], url: "https://fresh.example/retained.jpg" },
        {
          id: "scorecard-photo-from-other-session",
          fileId: "file-other",
          sectionKey: "quality",
          deficiencyKey: null,
          url: "https://fresh.example/other.jpg",
          caption: "Other session evidence",
        },
      ],
    });

    const rebased = rebaseScorecardEditDraft(local, latest);

    expect(rebased.removedRetainedPhotoCount).toBe(1);
    expect(rebased.mergedServerPhotoCount).toBe(1);
    expect(rebased.updatedRetainedCaptionCount).toBe(1);
    expect(rebased.draft).toMatchObject({
      editBaseUpdatedAt: "2026-07-14T15:00:00.000Z",
      editBasePhotoIds: ["scorecard-photo-1", "scorecard-photo-from-other-session"],
      editingOfficeId: "office-2",
      superintendentName: "Locally edited superintendent",
      scores: expect.objectContaining({ safety: 10 }),
      superintendentSignature: "",
      pmSignature: "",
      evidenceUploadAttempted: true,
    });
    expect(rebased.draft.photos).toEqual([
      expect.objectContaining({
        existingScorecardPhotoId: "scorecard-photo-1",
        uri: "https://fresh.example/retained.jpg",
        sectionKey: "schedule",
        caption: "Existing evidence",
      }),
      localNewPhoto,
      expect.objectContaining({
        existingScorecardPhotoId: "scorecard-photo-from-other-session",
        uri: "https://fresh.example/other.jpg",
        sectionKey: "quality",
        caption: "Other session evidence",
      }),
    ]);
    expect(scorecardEditRebaseMessage(rebased)).toBe(
      "Latest revision loaded. Your local changes and new photos were kept. 1 photo added in the other edit was also preserved. 1 submitted photo removed in the other edit can’t be reattached automatically. 1 submitted photo description was refreshed from the latest report. Review, then tap Save changes again.",
    );
  });

  it("preserves fresh signatures when rebase changes no evidence links", () => {
    const base = createScorecardEditDraft(detail(), { id: "local", clientSubmissionId: "edit", now: 1 });
    const local = {
      ...base,
      superintendentSignature: "fresh-super-signature",
      pmSignature: "fresh-pm-signature",
    };
    const latest = detail({
      updatedAt: "2026-07-14T15:30:00.000Z",
      photos: detail().photos.map((photo) => ({ ...photo, url: `https://fresh.example/${photo.id}.jpg` })),
    });

    const rebased = rebaseScorecardEditDraft(local, latest);

    expect(rebased.removedRetainedPhotoCount).toBe(0);
    expect(rebased.mergedServerPhotoCount).toBe(0);
    expect(rebased.updatedRetainedCaptionCount).toBe(0);
    expect(rebased.draft.superintendentSignature).toBe("fresh-super-signature");
    expect(rebased.draft.pmSignature).toBe("fresh-pm-signature");
  });

  it("loads a changed retained caption and requires fresh project signatures", () => {
    const base = createScorecardEditDraft(detail(), { id: "local", clientSubmissionId: "edit", now: 1 });
    const local = {
      ...base,
      superintendentSignature: "fresh-super-signature",
      pmSignature: "fresh-pm-signature",
    };
    const latest = detail({
      updatedAt: "2026-07-14T15:45:00.000Z",
      photos: detail().photos.map((photo) => photo.id === "scorecard-photo-1"
        ? { ...photo, caption: "Canonical updated description" }
        : photo),
    });

    const rebased = rebaseScorecardEditDraft(local, latest);

    expect(rebased.removedRetainedPhotoCount).toBe(0);
    expect(rebased.mergedServerPhotoCount).toBe(0);
    expect(rebased.updatedRetainedCaptionCount).toBe(1);
    expect(rebased.draft.photos[0]).toMatchObject({ caption: "Canonical updated description" });
    expect(rebased.draft.superintendentSignature).toBe("");
    expect(rebased.draft.pmSignature).toBe("");
  });

  it("does not resurrect a base photo intentionally removed locally, but preserves a concurrent addition", () => {
    const base = createScorecardEditDraft(detail(), { id: "local", clientSubmissionId: "edit", now: 1 });
    const local = { ...base, photos: [base.photos[0]] }; // user intentionally removed base photo 2
    const latest = detail({
      updatedAt: "2026-07-14T16:00:00.000Z",
      photos: [
        ...detail().photos,
        {
          id: "scorecard-photo-3",
          fileId: "file-3",
          sectionKey: "safety",
          deficiencyKey: null,
          url: "https://fresh.example/three.jpg",
          caption: "Concurrent evidence",
        },
      ],
    });

    const rebased = rebaseScorecardEditDraft(local, latest);

    expect(rebased.removedRetainedPhotoCount).toBe(0);
    expect(rebased.mergedServerPhotoCount).toBe(1);
    expect(rebased.draft.photos.map((photo) =>
      isExistingScorecardDraftPhoto(photo) ? photo.existingScorecardPhotoId : "new",
    )).toEqual(["scorecard-photo-1", "scorecard-photo-3"]);
  });

  it("does not resurrect a critical deficiency removed locally when remote still has it and adds evidence", () => {
    const base = createScorecardEditDraft(detail(), {
      id: "local-removed-deficiency",
      clientSubmissionId: "removed-deficiency-edit",
      now: 1,
    });
    const local = {
      ...base,
      criticalDeficiencies: [],
      deficiencyNotes: {},
      // Removing a selected deficiency in the UI requires removing its evidence first.
      photos: [base.photos[0]],
      superintendentSignature: "fresh-super-signature",
      pmSignature: "fresh-pm-signature",
    };
    const latest = detail({
      updatedAt: "2026-07-14T16:15:00.000Z",
      photos: [
        ...detail().photos,
        {
          id: "remote-new-failed-inspection-photo",
          fileId: "remote-new-failed-inspection-file",
          sectionKey: "critical_deficiency",
          deficiencyKey: "failed_inspection",
          url: "https://fresh.example/remote-failed-inspection.jpg",
          caption: "Remote evidence for locally removed deficiency",
        },
      ],
    });

    const rebased = rebaseScorecardEditDraft(local, latest);

    expect(rebased.draft.criticalDeficiencies).toEqual([]);
    expect(rebased.draft.deficiencyNotes).toEqual({});
    expect(rebased.draft.photos).toEqual([
      expect.objectContaining({ existingScorecardPhotoId: "scorecard-photo-1" }),
    ]);
    expect(rebased.mergedServerDeficiencyCount).toBe(0);
    expect(rebased.mergedServerPhotoCount).toBe(0);
    // Rebase did not change the locally reviewed report; fresh approvals remain valid.
    expect(rebased.draft.superintendentSignature).toBe("fresh-super-signature");
    expect(rebased.draft.pmSignature).toBe("fresh-pm-signature");
    // The next conflict compares local intent against this latest remote base again.
    expect(rebased.draft.editBaseCriticalDeficiencies).toEqual(["failed_inspection"]);
    expect(rebased.draft.editBaseCriticalDeficiencyNotes).toEqual({
      failed_inspection: "Reinspect stair rail",
    });
  });

  it("keeps a pre-snapshot legacy draft local-biased instead of guessing that a removed deficiency is remote-new", () => {
    const base = createScorecardEditDraft(detail(), {
      id: "legacy-removed-deficiency",
      clientSubmissionId: "legacy-removed-deficiency-edit",
      now: 1,
    });
    const local = {
      ...base,
      editBaseCriticalDeficiencies: undefined,
      editBaseCriticalDeficiencyNotes: undefined,
      criticalDeficiencies: [],
      deficiencyNotes: {},
      photos: [base.photos[0]],
    };

    const rebased = rebaseScorecardEditDraft(local, detail({
      updatedAt: "2026-07-14T16:20:00.000Z",
    }));

    expect(rebased.draft.criticalDeficiencies).toEqual([]);
    expect(rebased.draft.photos).toEqual([
      expect.objectContaining({ existingScorecardPhotoId: "scorecard-photo-1" }),
    ]);
    expect(rebased.draft.editBaseCriticalDeficiencies).toEqual(["failed_inspection"]);
    expect(rebased.draft.editBaseCriticalDeficiencyNotes).toEqual({
      failed_inspection: "Reinspect stair rail",
    });
  });

  it("keeps a local note edit when the remote edit removes that deficiency", () => {
    const base = createScorecardEditDraft(detail({
      // Keep evidence out of this case so the local report itself is unchanged by rebase.
      photos: [detail().photos[0]],
    }), {
      id: "local-note-vs-remote-removal",
      clientSubmissionId: "local-note-vs-remote-removal-edit",
      now: 1,
    });
    const local = {
      ...base,
      deficiencyNotes: { failed_inspection: "Local inspector follow-up is scheduled" },
      superintendentSignature: "fresh-super-signature",
      pmSignature: "fresh-pm-signature",
    };
    const latest = detail({
      updatedAt: "2026-07-14T16:22:00.000Z",
      criticalDeficiencyCount: 0,
      criticalDeficiencies: [],
      criticalDeficiencyNotes: {},
      photos: [detail().photos[0]],
    });

    const rebased = rebaseScorecardEditDraft(local, latest);

    expect(rebased.draft.criticalDeficiencies).toEqual(["failed_inspection"]);
    expect(rebased.draft.deficiencyNotes).toEqual({
      failed_inspection: "Local inspector follow-up is scheduled",
    });
    expect(rebased.removedServerDeficiencyCount).toBe(0);
    expect(rebased.updatedServerDeficiencyNoteCount).toBe(0);
    expect(rebased.draft.superintendentSignature).toBe("fresh-super-signature");
    expect(rebased.draft.pmSignature).toBe("fresh-pm-signature");
    expect(rebased.draft.editBaseCriticalDeficiencies).toEqual([]);
    expect(rebased.draft.editBaseCriticalDeficiencyNotes).toEqual({});
  });

  it("adopts a remote-only deficiency note edit and requires fresh signatures", () => {
    const base = createScorecardEditDraft(detail(), {
      id: "remote-note-only",
      clientSubmissionId: "remote-note-only-edit",
      now: 1,
    });
    const local = {
      ...base,
      superintendentSignature: "fresh-super-signature",
      pmSignature: "fresh-pm-signature",
    };
    const latest = detail({
      updatedAt: "2026-07-14T16:23:00.000Z",
      criticalDeficiencyNotes: { failed_inspection: "Remote inspector changed the follow-up" },
    });

    const rebased = rebaseScorecardEditDraft(local, latest);

    expect(rebased.draft.criticalDeficiencies).toEqual(["failed_inspection"]);
    expect(rebased.draft.deficiencyNotes).toEqual({
      failed_inspection: "Remote inspector changed the follow-up",
    });
    expect(rebased.updatedServerDeficiencyNoteCount).toBe(1);
    expect(rebased.draft.superintendentSignature).toBe("");
    expect(rebased.draft.pmSignature).toBe("");
    expect(rebased.draft.editBaseCriticalDeficiencyNotes).toEqual({
      failed_inspection: "Remote inspector changed the follow-up",
    });
    expect(scorecardEditRebaseMessage(rebased)).toContain(
      "1 critical deficiency note updated in the other edit was loaded for review.",
    );
  });

  it("keeps a conflicting local deficiency note edit while advancing the remote base snapshot", () => {
    const base = createScorecardEditDraft(detail(), {
      id: "conflicting-note-edit",
      clientSubmissionId: "conflicting-note-edit-attempt",
      now: 1,
    });
    const local = {
      ...base,
      deficiencyNotes: { failed_inspection: "Keep the local correction plan" },
      superintendentSignature: "fresh-super-signature",
      pmSignature: "fresh-pm-signature",
    };
    const latest = detail({
      updatedAt: "2026-07-14T16:24:00.000Z",
      criticalDeficiencyNotes: { failed_inspection: "Conflicting remote correction plan" },
    });

    const rebased = rebaseScorecardEditDraft(local, latest);

    expect(rebased.draft.deficiencyNotes).toEqual({
      failed_inspection: "Keep the local correction plan",
    });
    expect(rebased.updatedServerDeficiencyNoteCount).toBe(0);
    // Rebase did not alter the locally reviewed report, so its fresh approvals remain valid.
    expect(rebased.draft.superintendentSignature).toBe("fresh-super-signature");
    expect(rebased.draft.pmSignature).toBe("fresh-pm-signature");
    expect(rebased.draft.editBaseCriticalDeficiencyNotes).toEqual({
      failed_inspection: "Conflicting remote correction plan",
    });
  });

  it("adopts a truly concurrent remote deficiency without evidence and requires fresh signatures", () => {
    const baseDetail = detail({
      criticalDeficiencyCount: 0,
      criticalDeficiencies: [],
      criticalDeficiencyNotes: {},
      photos: [detail().photos[0]],
    });
    const base = createScorecardEditDraft(baseDetail, {
      id: "remote-deficiency-add",
      clientSubmissionId: "remote-deficiency-add-edit",
      now: 1,
    });
    const local = {
      ...base,
      superintendentSignature: "fresh-super-signature",
      pmSignature: "fresh-pm-signature",
    };
    const latest = detail({
      ...baseDetail,
      updatedAt: "2026-07-14T16:25:00.000Z",
      criticalDeficiencyCount: 1,
      criticalDeficiencies: ["safety_violation"],
      criticalDeficiencyNotes: { safety_violation: "Remote safety issue" },
    });

    const rebased = rebaseScorecardEditDraft(local, latest);

    expect(rebased.draft.criticalDeficiencies).toEqual(["safety_violation"]);
    expect(rebased.draft.deficiencyNotes).toEqual({ safety_violation: "Remote safety issue" });
    expect(rebased.mergedServerDeficiencyCount).toBe(1);
    expect(rebased.removedServerDeficiencyCount).toBe(0);
    expect(rebased.draft.superintendentSignature).toBe("");
    expect(rebased.draft.pmSignature).toBe("");
    expect(scorecardEditRebaseMessage(rebased)).toContain(
      "1 critical deficiency added in the other edit was also preserved.",
    );
  });

  it("adopts a remote deficiency removal when local stayed at base and requires fresh signatures", () => {
    const base = createScorecardEditDraft(detail(), {
      id: "remote-deficiency-remove",
      clientSubmissionId: "remote-deficiency-remove-edit",
      now: 1,
    });
    const local = {
      ...base,
      superintendentSignature: "fresh-super-signature",
      pmSignature: "fresh-pm-signature",
    };
    const latest = detail({
      updatedAt: "2026-07-14T16:28:00.000Z",
      criticalDeficiencyCount: 0,
      criticalDeficiencies: [],
      criticalDeficiencyNotes: {},
      photos: [detail().photos[0]],
    });

    const rebased = rebaseScorecardEditDraft(local, latest);

    expect(rebased.draft.criticalDeficiencies).toEqual([]);
    expect(rebased.draft.deficiencyNotes).toEqual({});
    expect(rebased.removedServerDeficiencyCount).toBe(1);
    expect(rebased.removedRetainedPhotoCount).toBe(1);
    expect(rebased.draft.superintendentSignature).toBe("");
    expect(rebased.draft.pmSignature).toBe("");
    expect(scorecardEditRebaseMessage(rebased)).toContain(
      "1 critical deficiency removed in the other edit was removed from this revision.",
    );
  });

  it("preserves the selected deficiency and note required by concurrently added deficiency evidence", () => {
    const baseDetail = detail({
      criticalDeficiencyCount: 0,
      criticalDeficiencies: [],
      criticalDeficiencyNotes: {},
      photos: [detail().photos[0]],
    });
    const local = createScorecardEditDraft(baseDetail, {
      id: "local-deficiency-edit",
      clientSubmissionId: "deficiency-edit",
      now: 1,
    });
    const latest = detail({
      ...baseDetail,
      updatedAt: "2026-07-14T16:30:00.000Z",
      criticalDeficiencyCount: 1,
      criticalDeficiencies: ["safety_violation"],
      criticalDeficiencyNotes: { safety_violation: "Open edge protection missing" },
      photos: [
        baseDetail.photos[0],
        {
          id: "scorecard-photo-safety",
          fileId: "file-safety",
          sectionKey: "critical_deficiency",
          deficiencyKey: "safety_violation",
          url: "https://fresh.example/safety.jpg",
          caption: "Concurrent safety evidence",
        },
      ],
    });

    const rebased = rebaseScorecardEditDraft({
      ...local,
      superintendentSignature: "fresh-super-signature",
      pmSignature: "fresh-pm-signature",
    }, latest);

    expect(rebased.draft.criticalDeficiencies).toEqual(["safety_violation"]);
    expect(rebased.draft.deficiencyNotes).toEqual({
      safety_violation: "Open edge protection missing",
    });
    expect(rebased.draft.photos).toEqual([
      expect.objectContaining({ existingScorecardPhotoId: "scorecard-photo-1" }),
      expect.objectContaining({
        existingScorecardPhotoId: "scorecard-photo-safety",
        sectionKey: "critical_deficiency",
        deficiencyKey: "safety_violation",
      }),
    ]);
    expect(rebased.mergedServerDeficiencyCount).toBe(1);
    expect(rebased.mergedServerPhotoCount).toBe(1);
    expect(rebased.draft.superintendentSignature).toBe("");
    expect(rebased.draft.pmSignature).toBe("");
  });

  it("rebases leadership edits without losing local scores, summary, or category evidence", () => {
    const leadershipItems = FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS.map((sectionKey) => ({
      sectionKey,
      points: 8,
      note: `${sectionKey} server note`,
    }));
    const baseDetail = detail({
      kind: "leadership",
      items: leadershipItems,
      summary: "Original summary",
      photos: [{
        id: "lead-photo-1",
        fileId: "lead-file-1",
        sectionKey: "quality_control",
        deficiencyKey: null,
        url: "https://old.example/lead.jpg",
        caption: "Original caption",
      }],
    });
    const base = createScorecardEditDraft(baseDetail, {
      id: "local-leadership",
      clientSubmissionId: "leadership-edit",
      now: 1,
    });
    const newPhoto: ScorecardDraftPhoto = {
      key: "new-lead-photo",
      uri: "file:///local/lead.jpg",
      clientUploadId: "new-lead-upload",
      sectionKey: "safety",
      caption: "New local evidence",
    };
    const local = {
      ...base,
      scores: { ...base.scores, safety: 10 },
      notes: { ...base.notes, safety: "Local safety note" },
      summary: "Locally revised summary",
      photos: [{ ...base.photos[0], caption: "Local category caption" }, newPhoto],
    };
    const latest = detail({
      ...baseDetail,
      updatedAt: "2026-07-14T17:00:00.000Z",
      photos: [
        { ...baseDetail.photos[0], url: "https://fresh.example/lead.jpg" },
        {
          id: "lead-photo-2",
          fileId: "lead-file-2",
          sectionKey: "project_summary",
          deficiencyKey: null,
          url: "https://fresh.example/summary.jpg",
          caption: "Concurrent summary evidence",
        },
      ],
    });

    const rebased = rebaseScorecardEditDraft(local, latest);

    expect(rebased.draft.kind).toBe("leadership");
    expect(rebased.draft.editBaseUpdatedAt).toBe("2026-07-14T17:00:00.000Z");
    expect(rebased.draft.scores.safety).toBe(10);
    expect(rebased.draft.notes.safety).toBe("Local safety note");
    expect(rebased.draft.summary).toBe("Locally revised summary");
    expect(rebased.draft.photos).toEqual([
      expect.objectContaining({
        existingScorecardPhotoId: "lead-photo-1",
        uri: "https://fresh.example/lead.jpg",
        caption: "Original caption",
      }),
      newPhoto,
      expect.objectContaining({
        existingScorecardPhotoId: "lead-photo-2",
        sectionKey: "project_summary",
        caption: "Concurrent summary evidence",
      }),
    ]);
    expect(rebased.mergedServerPhotoCount).toBe(1);
    expect(rebased.updatedRetainedCaptionCount).toBe(1);
  });

  it("keeps all project evidence when a concurrent addition pushes a rebase over 100, then blocks save", () => {
    const base = createScorecardEditDraft(detail(), { id: "local-project-cap", clientSubmissionId: "edit-cap", now: 1 });
    const localNewPhotos: ScorecardDraftPhoto[] = Array.from(
      { length: MAX_SCORECARD_PHOTOS - base.photos.length },
      (_, index) => ({
        key: `local-project-${index}`,
        uri: `file:///local-project-${index}.jpg`,
        clientUploadId: `local-project-upload-${index}`,
        sectionKey: "quality",
        caption: "Local evidence",
      }),
    );
    const latest = detail({
      updatedAt: "2026-07-14T18:00:00.000Z",
      photos: [
        ...detail().photos,
        {
          id: "concurrent-project-photo",
          fileId: "concurrent-project-file",
          sectionKey: "safety",
          deficiencyKey: null,
          url: "https://fresh.example/concurrent-project.jpg",
          caption: "Concurrent project evidence",
        },
      ],
    });

    const rebased = rebaseScorecardEditDraft({ ...base, photos: [...base.photos, ...localNewPhotos] }, latest);

    expect(rebased.draft.photos).toHaveLength(MAX_SCORECARD_PHOTOS + 1);
    expect(rebased.draft.photos).toEqual(expect.arrayContaining(localNewPhotos));
    expect(rebased.draft.photos).toEqual(expect.arrayContaining([
      expect.objectContaining({ existingScorecardPhotoId: "concurrent-project-photo" }),
    ]));
    expect(validateScorecardDraft(rebased.draft)).toMatchObject({
      tooManyPhotos: true,
      photoOverflowCount: 1,
      canSubmit: false,
    });
  });

  it("keeps all leadership evidence when a concurrent addition pushes a rebase over 100, then blocks save", () => {
    const leadershipDetail = detail({
      kind: "leadership",
      items: FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS.map((sectionKey) => ({ sectionKey, points: 8, note: null })),
      criticalDeficiencies: [],
      criticalDeficiencyNotes: {},
      actionItems: [],
      photos: [{
        id: "lead-base-photo",
        fileId: "lead-base-file",
        sectionKey: "quality_control",
        deficiencyKey: null,
        url: "https://old.example/lead-base.jpg",
        caption: "Base leadership evidence",
      }],
    });
    const base = createScorecardEditDraft(leadershipDetail, {
      id: "local-lead-cap",
      clientSubmissionId: "lead-edit-cap",
      now: 1,
    });
    const localNewPhotos: ScorecardDraftPhoto[] = Array.from(
      { length: MAX_SCORECARD_PHOTOS - base.photos.length },
      (_, index) => ({
        key: `local-lead-${index}`,
        uri: `file:///local-lead-${index}.jpg`,
        clientUploadId: `local-lead-upload-${index}`,
        sectionKey: "safety",
        caption: "Local leadership evidence",
      }),
    );
    const latest = detail({
      ...leadershipDetail,
      updatedAt: "2026-07-14T18:30:00.000Z",
      photos: [
        ...leadershipDetail.photos,
        {
          id: "concurrent-lead-photo",
          fileId: "concurrent-lead-file",
          sectionKey: "project_summary",
          deficiencyKey: null,
          url: "https://fresh.example/concurrent-lead.jpg",
          caption: "Concurrent leadership evidence",
        },
      ],
    });

    const rebased = rebaseScorecardEditDraft({ ...base, photos: [...base.photos, ...localNewPhotos] }, latest);

    expect(rebased.draft.photos).toHaveLength(MAX_SCORECARD_PHOTOS + 1);
    expect(rebased.draft.photos).toEqual(expect.arrayContaining(localNewPhotos));
    expect(rebased.draft.photos).toEqual(expect.arrayContaining([
      expect.objectContaining({ existingScorecardPhotoId: "concurrent-lead-photo" }),
    ]));
    expect(validateScorecardDraft(rebased.draft)).toMatchObject({
      tooManyPhotos: true,
      photoOverflowCount: 1,
      canSubmit: false,
    });
  });

  it("refuses to rebase against a different card or a card the current user cannot edit", () => {
    const draft = createScorecardEditDraft(detail(), { id: "local", clientSubmissionId: "edit", now: 1 });
    expect(() => rebaseScorecardEditDraft(draft, detail({ id: "different-card" }))).toThrow(
      "The latest scorecard does not match this local edit.",
    );
    expect(() => rebaseScorecardEditDraft(draft, detail({ canEdit: false }))).toThrow(
      "Only the submitter can edit this scorecard.",
    );
  });
});

describe("edit reducer refresh/replacement actions", () => {
  it("refreshes only retained URLs, without clobbering a new local photo", () => {
    const base = createScorecardEditDraft(detail(), { id: "local", clientSubmissionId: "edit", now: 1 });
    const newPhoto: ScorecardDraftPhoto = {
      key: "new-photo",
      uri: "file:///local.jpg",
      clientUploadId: "new-upload",
      sectionKey: "safety",
      caption: "Local",
    };
    const draft = { ...base, photos: [...base.photos, newPhoto] };

    const refreshed = scorecardDraftReducer(draft, {
      type: "refreshExistingPhotoUrls",
      urlsByScorecardPhotoId: { "scorecard-photo-1": "https://fresh.example/one.jpg" },
    });

    expect(refreshed.photos[0]).toMatchObject({ uri: "https://fresh.example/one.jpg" });
    expect(refreshed.photos[1]).toBe(base.photos[1]);
    expect(refreshed.photos[2]).toBe(newPhoto);
  });

  it("keeps retained gallery captions read-only while allowing new-photo captions", () => {
    const base = createScorecardEditDraft(detail(), { id: "local", clientSubmissionId: "edit", now: 1 });
    const retained = base.photos[0];
    const newPhoto: ScorecardDraftPhoto = {
      key: "new-photo",
      uri: "file:///local.jpg",
      clientUploadId: "new-upload",
      sectionKey: "quality",
      caption: "Original local caption",
    };
    const draft = { ...base, photos: [retained, newPhoto] };

    expect(scorecardDraftReducer(draft, {
      type: "setPhotoCaption",
      key: retained.key,
      caption: "Must not change gallery metadata",
    })).toBe(draft);
    expect(scorecardDraftReducer(draft, {
      type: "appendPhotoCaption",
      key: retained.key,
      text: "Must not append",
    })).toBe(draft);

    const updated = scorecardDraftReducer(draft, {
      type: "setPhotoCaption",
      key: newPhoto.key,
      caption: "Updated before upload",
    });
    expect(updated.photos[1]).toMatchObject({ caption: "Updated before upload" });
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
