// Mock the durable-queue + API seams so we can drive submitScorecard's orchestration deterministically
// (jest hoists these above the imports). The pure helpers below are unaffected — they don't touch them.
jest.mock("../../capture/upload-queue", () => ({
  MAX_UPLOAD_ATTEMPTS: 5,
  enqueueUploads: jest.fn(async () => []),
  drainUploadQueue: jest.fn(async () => ({ succeeded: 0, failed: 0, remaining: 0 })),
  getQueuedUploads: jest.fn(async () => []),
  removeQueuedUploadsAndWait: jest.fn(async () => undefined),
}));
jest.mock("../../api/endpoints", () => ({
  createScorecard: jest.fn(async () => ({ scorecard: { id: "sc-1", dealId: "deal-1" } })),
}));

import {
  scorecardPhotoUploadInput,
  pendingScorecardPhotoIds,
  classifyDraftPhotoUploads,
  submitScorecard,
} from "../submit";
import { todayLocalIso, type ScorecardDraft, type ScorecardDraftPhoto } from "../draft";
import { enqueueUploads, drainUploadQueue, getQueuedUploads } from "../../capture/upload-queue";
import { createScorecard } from "../../api/endpoints";

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
    expect(input.scorecardId).toBeUndefined();
    expect(input.routeByTarget).toBeUndefined();
  });

  it("persists the scorecard scope only for submitted-card edit evidence", () => {
    const photo: ScorecardDraftPhoto = {
      key: "p1", uri: "file://p1", clientUploadId: "cu-1", sectionKey: "schedule", caption: "",
    };
    expect(scorecardPhotoUploadInput(photo, "deal-1", "scorecard-1")).toEqual(
      expect.objectContaining({ scorecardId: "scorecard-1", routeByTarget: true }),
    );
  });

  it("nulls a blank caption", () => {
    const photo: ScorecardDraftPhoto = { key: "p", uri: "u", clientUploadId: "c", sectionKey: "quality", caption: "   " };
    expect(scorecardPhotoUploadInput(photo, "d").caption).toBeNull();
  });

  it("forwards capture metadata incl. addressSource (live_gps evidence isn't audited as exif)", () => {
    const photo: ScorecardDraftPhoto = {
      key: "p", uri: "u", clientUploadId: "c", sectionKey: "quality", caption: "",
      takenAt: "2026-06-30T18:00:00Z", latitude: 32.9, longitude: -96.7, addressSource: "live_gps",
    };
    expect(scorecardPhotoUploadInput(photo, "d").metadata).toEqual({
      takenAt: "2026-06-30T18:00:00Z", latitude: 32.9, longitude: -96.7, addressSource: "live_gps",
    });
  });
});

describe("pendingScorecardPhotoIds", () => {
  it("returns only the draft's ids that are still queued", () => {
    expect(pendingScorecardPhotoIds(["a", "b", "c"], ["b", "z"])).toEqual(["b"]);
    expect(pendingScorecardPhotoIds(["a"], [])).toEqual([]);
    expect(pendingScorecardPhotoIds([], ["a"])).toEqual([]);
  });
});

describe("classifyDraftPhotoUploads", () => {
  it("splits still-queued photos into pending vs terminally-failed; uploaded ones are neither", () => {
    const r = classifyDraftPhotoUploads(
      ["a", "b", "c"],
      [
        { clientUploadId: "a", attempts: 1 },
        { clientUploadId: "b", attempts: 5 },
      ],
      5,
    );
    expect(r.pending).toEqual(["a"]); // attempts < max → still retrying
    expect(r.failed).toEqual(["b"]); // attempts >= max → terminal
    // "c" is not in the queue → uploaded/confirmed → in neither list
  });
});

describe("submitScorecard (orchestration)", () => {
  const fetcher = (() => {}) as any;
  function photo(id: string): ScorecardDraftPhoto {
    return { key: id, uri: `file://${id}`, clientUploadId: id, sectionKey: "schedule", caption: "" };
  }
  function draftWith(photos: ScorecardDraftPhoto[]): ScorecardDraft {
    return {
      id: "d1", clientSubmissionId: "sub-1", dealId: "deal-1", dealName: "Maple", projectNumber: null,
      weekOf: "2026-06-30", superintendentName: "", pmName: "",
      scores: {}, notes: {}, photos, criticalDeficiencies: [], actionItems: [], createdAt: 0, updatedAt: 0,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (getQueuedUploads as jest.Mock).mockResolvedValue([]);
    (createScorecard as jest.Mock).mockResolvedValue({ scorecard: { id: "sc-1", dealId: "deal-1" } });
  });

  it("with no photos: skips the upload queue and POSTs the scorecard → submitted", async () => {
    const result = await submitScorecard(fetcher, "owner-1", draftWith([]));
    expect(enqueueUploads).not.toHaveBeenCalled();
    expect(drainUploadQueue).not.toHaveBeenCalled();
    expect(createScorecard).toHaveBeenCalledTimes(1);
    expect((createScorecard as jest.Mock).mock.calls[0][1].clientSubmissionId).toBe("sub-1");
    expect(result).toEqual({ status: "submitted", scorecard: { id: "sc-1", dealId: "deal-1" } });
  });

  it("POSTs a new or recovered draft through its office-pinned fetcher", async () => {
    const neutralScorecardFetcher = jest.fn();
    const draftOfficeFetcher = jest.fn();

    await submitScorecard(neutralScorecardFetcher as any, "owner-1", draftWith([]), {
      draftOfficeFetcher: draftOfficeFetcher as any,
    });

    expect(createScorecard).toHaveBeenCalledWith(draftOfficeFetcher, expect.any(Object));
    expect(createScorecard).not.toHaveBeenCalledWith(neutralScorecardFetcher, expect.any(Object));
  });

  it("stamps Week Of = the LOCAL submit date, overriding a stale draft value", async () => {
    // A draft seeded on an earlier day (offline, submitted later) must file under the SUBMIT day, not its
    // creation day — the server no longer re-stamps, so the client owns the completion date.
    const stale: ScorecardDraft = { ...draftWith([]), weekOf: "2020-01-01" };
    await submitScorecard(fetcher, "owner-1", stale);
    const payload = (createScorecard as jest.Mock).mock.calls[0][1];
    expect(payload.weekOf).not.toBe("2020-01-01"); // the stale draft value is discarded
    expect(payload.weekOf).toBe(todayLocalIso()); // the local completion date is stamped instead
  });

  it("with photos all confirmed: enqueues, drains, then POSTs → submitted", async () => {
    (getQueuedUploads as jest.Mock).mockResolvedValue([]); // nothing left queued = all uploaded
    const result = await submitScorecard(fetcher, "owner-1", draftWith([photo("a"), photo("b")]));
    expect(enqueueUploads).toHaveBeenCalledTimes(1);
    expect(enqueueUploads).toHaveBeenCalledWith(
      "owner-1",
      expect.arrayContaining([expect.not.objectContaining({ routeByTarget: true })]),
    );
    expect(drainUploadQueue).toHaveBeenCalledWith("owner-1", fetcher, undefined);
    expect(createScorecard).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("submitted");
  });

  it("with a photo still retrying: returns photos_pending and does NOT POST", async () => {
    (getQueuedUploads as jest.Mock).mockResolvedValue([{ clientUploadId: "a", attempts: 1 }]);
    const result = await submitScorecard(fetcher, "owner-1", draftWith([photo("a")]));
    expect(result).toEqual({ status: "photos_pending", remaining: 1 });
    expect(createScorecard).not.toHaveBeenCalled();
  });

  it("with a photo past the retry cap: returns photos_failed and does NOT POST", async () => {
    (getQueuedUploads as jest.Mock).mockResolvedValue([{ clientUploadId: "a", attempts: 5 }]);
    const result = await submitScorecard(fetcher, "owner-1", draftWith([photo("a")]));
    expect(result).toEqual({ status: "photos_failed", failed: 1 });
    expect(createScorecard).not.toHaveBeenCalled();
  });
});
