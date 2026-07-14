jest.mock("../../capture/upload-queue", () => ({
  MAX_UPLOAD_ATTEMPTS: 5,
  enqueueUploads: jest.fn(async () => []),
  drainUploadQueue: jest.fn(async () => ({ succeeded: 1, failed: 0, remaining: 0 })),
  getQueuedUploads: jest.fn(async () => []),
}));

jest.mock("../../api/endpoints", () => ({
  createScorecard: jest.fn(),
  updateScorecard: jest.fn(async () => ({
    scorecard: { id: "scorecard-1", dealId: "deal-1", weekOf: "2026-07-01" },
  })),
}));

import { createScorecard, updateScorecard, type Fetcher } from "../../api/endpoints";
import { drainUploadQueue, enqueueUploads, getQueuedUploads } from "../../capture/upload-queue";
import { FIELD_SCORECARD_SECTION_KEYS } from "../scoring";
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
      createdAt: 1,
      updatedAt: 2,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (getQueuedUploads as jest.Mock).mockResolvedValue([]);
  });

  it("uses the office-pinned fetcher only for new evidence, then PUTs with the normal fetcher", async () => {
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
      [expect.objectContaining({ clientUploadId: "new-upload-1", uri: "file:///new-photo.jpg" })],
    );
    expect(drainUploadQueue).toHaveBeenCalledWith("user-1:office-1", officePinnedUploadFetcher);
    expect(createScorecard).not.toHaveBeenCalled();
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
});
