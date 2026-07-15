jest.mock("../../capture/upload-queue", () => ({
  MAX_UPLOAD_ATTEMPTS: 5,
  enqueueUploads: jest.fn(async () => []),
  drainUploadQueue: jest.fn(async () => ({ succeeded: 1, failed: 0, remaining: 0 })),
  getQueuedUploads: jest.fn(async () => []),
  removeQueuedUploadsAndWait: jest.fn(async () => undefined),
}));

jest.mock("../../api/endpoints", () => ({
  createScorecard: jest.fn(),
  discardScorecardEditEvidence: jest.fn(async () => ({ discarded: 0 })),
  updateScorecard: jest.fn(async () => ({
    scorecard: { id: "scorecard-1", dealId: "deal-1", weekOf: "2026-07-01" },
  })),
}));

import { createScorecard, discardScorecardEditEvidence, updateScorecard, type Fetcher } from "../../api/endpoints";
import {
  drainUploadQueue,
  enqueueUploads,
  getQueuedUploads,
  removeQueuedUploadsAndWait,
} from "../../capture/upload-queue";
import { FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS, FIELD_SCORECARD_SECTION_KEYS } from "../scoring";
import { submitScorecard } from "../submit";
import type { ScorecardDraft, ScorecardDraftPhoto } from "../draft";

describe("submitScorecard submitted-card edit", () => {
  function editDraft(photos: ScorecardDraftPhoto[]): ScorecardDraft {
    return {
      id: "local-edit-1",
      clientSubmissionId: "local-attempt-1",
      editingScorecardId: "scorecard-1",
      editingOfficeId: "office-1",
      editBaseUpdatedAt: "2026-07-14T15:30:00.000Z",
      dealId: "deal-1",
      dealName: "Riverwalk Apartments",
      projectNumber: "DFW-1-10000-aa",
      weekOf: "2026-07-01",
      superintendentName: "Sam Superintendent",
      pmName: "Pat Manager",
      scores: Object.fromEntries(FIELD_SCORECARD_SECTION_KEYS.map((key) => [key, 8])),
      notes: {},
      photos,
      criticalDeficiencies: [],
      deficiencyNotes: {},
      actionItems: [],
      superintendentSignature: "data:image/png;base64,super",
      pmSignature: "data:image/png;base64,pm",
      evidenceUploadAttempted: true,
      evidenceUploadAttemptedIds: photos.flatMap((photo) =>
        "clientUploadId" in photo && photo.clientUploadId ? [photo.clientUploadId] : [],
      ),
      createdAt: 1,
      updatedAt: 2,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (getQueuedUploads as jest.Mock).mockResolvedValue([]);
  });

  it("marks edit evidence for target routing, then PUTs with the headerless scorecard fetcher", async () => {
    const scorecardFetcher = jest.fn() as unknown as Fetcher;
    const officePinnedUploadFetcher = jest.fn() as unknown as Fetcher;
    const draft = editDraft([
        {
          key: "submitted:photo-1",
          uri: "https://example.test/submitted.jpg",
          existingScorecardPhotoId: "photo-1",
          sectionKey: "quality",
          caption: "Retained evidence",
        },
        {
          key: "new-photo-1",
          uri: "file:///new-photo.jpg",
          clientUploadId: "new-upload-1",
          sectionKey: "safety",
          caption: "New evidence",
        },
      ]);

    const result = await submitScorecard(scorecardFetcher, "user-1:office-1", draft, {
      draftOfficeFetcher: officePinnedUploadFetcher,
    });

    expect(enqueueUploads).toHaveBeenCalledTimes(1);
    expect(enqueueUploads).toHaveBeenCalledWith(
      "user-1:office-1",
      [expect.objectContaining({
        clientUploadId: "new-upload-1",
        uri: "file:///new-photo.jpg",
        scorecardId: "scorecard-1",
        routeByTarget: true,
      })],
    );
    expect(drainUploadQueue).toHaveBeenCalledWith(
      "user-1:office-1",
      officePinnedUploadFetcher,
      { targetFetcher: scorecardFetcher },
    );
    expect(createScorecard).not.toHaveBeenCalled();
    expect(removeQueuedUploadsAndWait).not.toHaveBeenCalled();
    expect(updateScorecard).toHaveBeenCalledTimes(1);
    expect(updateScorecard).toHaveBeenCalledWith(
      scorecardFetcher,
      "scorecard-1",
      expect.objectContaining({
        expectedUpdatedAt: "2026-07-14T15:30:00.000Z",
        photos: [
          { scorecardPhotoId: "photo-1", sectionKey: "quality", deficiencyKey: null },
          { clientUploadId: "new-upload-1", sectionKey: "safety", deficiencyKey: null },
        ],
      }),
    );
    expect((updateScorecard as jest.Mock).mock.calls[0][2]).not.toHaveProperty("weekOf");
    // The append-only ledger includes the currently selected upload. It must be linked by the PUT, never
    // pre-discarded as abandoned evidence.
    expect(discardScorecardEditEvidence).not.toHaveBeenCalled();
    expect(draft.weekOf).toBe("2026-07-01");
    expect(result).toEqual({
      status: "submitted",
      scorecard: { id: "scorecard-1", dealId: "deal-1", weekOf: "2026-07-01" },
    });
  });

  it("skips the upload queue when an edit keeps only submitted evidence", async () => {
    const draft = editDraft([{
      key: "submitted:photo-1",
      uri: "https://example.test/submitted.jpg",
      existingScorecardPhotoId: "photo-1",
      sectionKey: "quality",
      caption: "Retained evidence",
    }]);

    await submitScorecard((() => undefined) as never, "user-1:office-1", draft);

    expect(enqueueUploads).not.toHaveBeenCalled();
    expect(drainUploadQueue).not.toHaveBeenCalled();
    expect(updateScorecard).toHaveBeenCalledTimes(1);
    expect((updateScorecard as jest.Mock).mock.calls[0][2].photos).toEqual([
      { scorecardPhotoId: "photo-1", sectionKey: "quality", deficiencyKey: null },
    ]);
  });

  it("does not PUT while a newly added evidence photo is still queued", async () => {
    (getQueuedUploads as jest.Mock).mockResolvedValue([{ clientUploadId: "new-upload-1", attempts: 1 }]);
    const draft = editDraft([{
      key: "new-photo-1",
      uri: "file:///new-photo.jpg",
      clientUploadId: "new-upload-1",
      sectionKey: "safety",
      caption: "New evidence",
    }]);

    const result = await submitScorecard((() => undefined) as never, "user-1:office-1", draft);

    expect(result).toEqual({ status: "photos_pending", remaining: 1 });
    expect(updateScorecard).not.toHaveBeenCalled();
    expect(createScorecard).not.toHaveBeenCalled();
  });

  it.each([
    ["Project", undefined],
    ["Leadership", "leadership" as const],
  ])("reconciles only removed attempts before uploading and saving a %s card", async (_label, kind) => {
    const draft: ScorecardDraft = {
      ...editDraft([{
        key: "selected-new-photo",
        uri: "file:///selected-new-photo.jpg",
        clientUploadId: "selected-upload",
        sectionKey: "safety" as const,
        caption: "Selected evidence",
      }]),
      kind,
      scores: kind === "leadership"
        ? Object.fromEntries(FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS.map((key) => [key, 8]))
        : Object.fromEntries(FIELD_SCORECARD_SECTION_KEYS.map((key) => [key, 8])),
      summary: kind === "leadership" ? "Leadership summary" : undefined,
      // This photo confirmed during an earlier failed attempt, then the user removed it from the form.
      evidenceUploadAttemptedIds: ["removed-confirmed-upload", "selected-upload"],
    };
    const scorecardFetcher = jest.fn() as unknown as Fetcher;

    await expect(submitScorecard(scorecardFetcher, "user-1:office-1", draft)).resolves.toMatchObject({
      status: "submitted",
    });
    expect(removeQueuedUploadsAndWait).toHaveBeenCalledWith(
      "user-1:office-1",
      ["removed-confirmed-upload"],
    );
    expect(discardScorecardEditEvidence).toHaveBeenCalledWith(
      scorecardFetcher,
      "scorecard-1",
      ["removed-confirmed-upload"],
    );
    expect(discardScorecardEditEvidence).not.toHaveBeenCalledWith(
      scorecardFetcher,
      "scorecard-1",
      expect.arrayContaining(["selected-upload"]),
    );
    expect(enqueueUploads).toHaveBeenCalledTimes(1);
    expect(updateScorecard).toHaveBeenCalledTimes(1);
    expect((removeQueuedUploadsAndWait as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (discardScorecardEditEvidence as jest.Mock).mock.invocationCallOrder[0],
    );
    expect((discardScorecardEditEvidence as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (enqueueUploads as jest.Mock).mock.invocationCallOrder[0],
    );
    expect((enqueueUploads as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (drainUploadQueue as jest.Mock).mock.invocationCallOrder[0],
    );
    expect((drainUploadQueue as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (updateScorecard as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it.each([
    ["Project", undefined],
    ["Leadership", "leadership" as const],
  ])("does not upload or PUT a %s card when removed-evidence cleanup fails", async (_label, kind) => {
    const draft: ScorecardDraft = {
      ...editDraft([{
        key: "selected-new-photo",
        uri: "file:///selected-new-photo.jpg",
        clientUploadId: "selected-upload",
        sectionKey: "safety" as const,
        caption: "Selected evidence",
      }]),
      kind,
      scores: kind === "leadership"
        ? Object.fromEntries(FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS.map((key) => [key, 8]))
        : Object.fromEntries(FIELD_SCORECARD_SECTION_KEYS.map((key) => [key, 8])),
      summary: kind === "leadership" ? "Leadership summary" : undefined,
      evidenceUploadAttemptedIds: ["removed-confirmed-upload", "selected-upload"],
    };
    (discardScorecardEditEvidence as jest.Mock).mockRejectedValueOnce(new Error("cleanup offline"));

    await expect(submitScorecard((() => undefined) as never, "user-1:office-1", draft))
      .rejects.toThrow("cleanup offline");

    expect(removeQueuedUploadsAndWait).toHaveBeenCalledWith(
      "user-1:office-1",
      ["removed-confirmed-upload"],
    );
    expect(discardScorecardEditEvidence).toHaveBeenCalledTimes(1);
    expect(discardScorecardEditEvidence).toHaveBeenCalledWith(
      expect.anything(),
      "scorecard-1",
      ["removed-confirmed-upload"],
    );
    expect(enqueueUploads).not.toHaveBeenCalled();
    expect(drainUploadQueue).not.toHaveBeenCalled();
    expect(updateScorecard).not.toHaveBeenCalled();
    expect(draft.editBaseUpdatedAt).toBe("2026-07-14T15:30:00.000Z");
  });

  it.each([
    ["Project", undefined],
    ["Leadership", "leadership" as const],
  ])("waits for removed in-flight evidence before saving a %s card", async (_label, kind) => {
    let releaseWait!: () => void;
    const activeUploadSettled = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    (removeQueuedUploadsAndWait as jest.Mock).mockReturnValueOnce(activeUploadSettled);
    const draft: ScorecardDraft = {
      ...editDraft([]),
      kind,
      scores: kind === "leadership"
        ? Object.fromEntries(FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS.map((key) => [key, 8]))
        : Object.fromEntries(FIELD_SCORECARD_SECTION_KEYS.map((key) => [key, 8])),
      summary: kind === "leadership" ? "Leadership summary" : undefined,
      evidenceUploadAttemptedIds: ["removed-in-flight-upload"],
    };

    const submission = submitScorecard((() => undefined) as never, "user-1:office-1", draft);
    await Promise.resolve();

    expect(removeQueuedUploadsAndWait).toHaveBeenCalledWith(
      "user-1:office-1",
      ["removed-in-flight-upload"],
    );
    expect(updateScorecard).not.toHaveBeenCalled();
    expect(discardScorecardEditEvidence).not.toHaveBeenCalled();

    releaseWait();
    await expect(submission).resolves.toMatchObject({ status: "submitted" });
    expect((removeQueuedUploadsAndWait as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (discardScorecardEditEvidence as jest.Mock).mock.invocationCallOrder[0],
    );
    expect((discardScorecardEditEvidence as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (updateScorecard as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it("does not PUT when removed evidence cannot be cancelled safely", async () => {
    (removeQueuedUploadsAndWait as jest.Mock).mockRejectedValueOnce(new Error("queue index unavailable"));
    const draft = {
      ...editDraft([]),
      evidenceUploadAttemptedIds: ["removed-upload"],
    };

    await expect(submitScorecard((() => undefined) as never, "user-1:office-1", draft))
      .rejects.toThrow("queue index unavailable");
    expect(updateScorecard).not.toHaveBeenCalled();
    expect(discardScorecardEditEvidence).not.toHaveBeenCalled();
  });
});
