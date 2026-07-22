// Drive the corrective-action per-item response state + submit orchestration deterministically by mocking
// the durable-queue, direct-upload, and API seams (jest hoists these above the imports).
jest.mock("../../capture/upload-queue", () => ({
  MAX_UPLOAD_ATTEMPTS: 5,
  UPLOAD_CONCURRENCY: 5,
  enqueueUploads: jest.fn(async () => []),
  drainUploadQueue: jest.fn(async () => ({ succeeded: 0, failed: 0, remaining: 0, confirmedFileIds: {} })),
  getQueuedUploads: jest.fn(async () => []),
}));
jest.mock("../../capture/upload", () => ({
  // Default: every capture resolves to a photo whose id is the fileId (id === clientUploadId-derived).
  uploadCapture: jest.fn(async (_f: unknown, input: { clientUploadId: string }) => ({
    id: `file-${input.clientUploadId}`,
  })),
  // Minimal bounded pool for the fallback path — run each worker and settle (never rejects).
  runConcurrentUploads: jest.fn(
    async <T, R>(items: T[], _c: number, worker: (item: T, index: number) => Promise<R>) =>
      Promise.all(
        items.map(async (item, i): Promise<PromiseSettledResult<R>> => {
          try {
            return { status: "fulfilled", value: await worker(item, i) };
          } catch (reason) {
            return { status: "rejected", reason };
          }
        }),
      ),
  ),
}));
jest.mock("../../api/endpoints", () => ({
  submitCorrectiveActionResponse: jest.fn(async () => ({ items: [{ id: "item-1", status: "resolved" }] })),
}));

import {
  correctiveResponseReducer,
  emptyCorrectiveResponse,
  correctiveResponsePhotoUploadInput,
  submitCorrectiveActionItem,
  type CorrectiveResponsePhoto,
} from "../corrective-action";
import { enqueueUploads, drainUploadQueue, getQueuedUploads } from "../../capture/upload-queue";
import { uploadCapture, runConcurrentUploads } from "../../capture/upload";
import { submitCorrectiveActionResponse } from "../../api/endpoints";

function photo(id: string, extra: Partial<CorrectiveResponsePhoto> = {}): CorrectiveResponsePhoto {
  return { key: id, uri: `file://${id}`, clientUploadId: id, caption: "", ...extra };
}

describe("correctiveResponseReducer", () => {
  it("adds a photo, sets its caption, removes it, and sets the comment", () => {
    let state = emptyCorrectiveResponse();
    state = correctiveResponseReducer(state, { type: "addPhoto", photo: photo("a") });
    state = correctiveResponseReducer(state, { type: "addPhoto", photo: photo("b") });
    expect(state.photos.map((p) => p.key)).toEqual(["a", "b"]);

    state = correctiveResponseReducer(state, { type: "setPhotoCaption", key: "a", caption: "Fixed the rail" });
    expect(state.photos.find((p) => p.key === "a")?.caption).toBe("Fixed the rail");

    state = correctiveResponseReducer(state, { type: "removePhoto", key: "a" });
    expect(state.photos.map((p) => p.key)).toEqual(["b"]);

    state = correctiveResponseReducer(state, { type: "setComment", comment: "All corrected." });
    expect(state.comment).toBe("All corrected.");
  });

  it("appends to a photo caption without clobbering concurrent transcripts", () => {
    let state = emptyCorrectiveResponse();
    state = correctiveResponseReducer(state, { type: "addPhoto", photo: photo("a", { caption: "One" }) });
    state = correctiveResponseReducer(state, { type: "appendPhotoCaption", key: "a", text: "two" });
    expect(state.photos.find((p) => p.key === "a")?.caption).toBe("One two");
  });
});

describe("correctiveResponsePhotoUploadInput", () => {
  it("targets the deal and tags the upload as corrective-action evidence, trimming the caption", () => {
    const input = correctiveResponsePhotoUploadInput(
      photo("a", { caption: "  Re-inspected  ", takenAt: "2026-07-22T00:00:00Z", latitude: 32.9, longitude: -96.7, addressSource: "live_gps" }),
      "deal-1",
    );
    expect(input.target).toEqual({ dealId: "deal-1" });
    expect(input.tags).toEqual(["scorecard", "corrective_action"]);
    expect(input.caption).toBe("Re-inspected");
    expect(input.category).toBeNull();
    expect(input.clientUploadId).toBe("a");
    expect(input.metadata).toMatchObject({ latitude: 32.9, longitude: -96.7, addressSource: "live_gps" });
  });

  it("nulls a blank caption", () => {
    expect(correctiveResponsePhotoUploadInput(photo("a", { caption: "   " }), "d").caption).toBeNull();
  });
});

describe("submitCorrectiveActionItem", () => {
  const fetcher = (() => {}) as never;

  beforeEach(() => {
    jest.clearAllMocks();
    (getQueuedUploads as jest.Mock).mockResolvedValue([]);
    (enqueueUploads as jest.Mock).mockResolvedValue([]);
    (drainUploadQueue as jest.Mock).mockResolvedValue({ succeeded: 0, failed: 0, remaining: 0, confirmedFileIds: {} });
    (uploadCapture as jest.Mock).mockImplementation(async (_f: unknown, input: { clientUploadId: string }) => ({
      id: `file-${input.clientUploadId}`,
    }));
    (runConcurrentUploads as jest.Mock).mockImplementation(
      async <T, R>(items: T[], _c: number, worker: (item: T, index: number) => Promise<R>) =>
        Promise.all(
          items.map(async (item, i): Promise<PromiseSettledResult<R>> => {
            try {
              return { status: "fulfilled", value: await worker(item, i) };
            } catch (reason) {
              return { status: "rejected", reason };
            }
          }),
        ),
    );
    (submitCorrectiveActionResponse as jest.Mock).mockResolvedValue({ items: [{ id: "item-1", status: "resolved" }] });
  });

  it("with no photos: skips the queue and POSTs just the comment → resolved", async () => {
    const result = await submitCorrectiveActionItem(fetcher, "owner-1", {
      scorecardId: "sc-1",
      itemId: "item-1",
      dealId: "deal-1",
      photos: [],
      comment: "No evidence needed.",
    });
    expect(enqueueUploads).not.toHaveBeenCalled();
    expect(drainUploadQueue).not.toHaveBeenCalled();
    expect(submitCorrectiveActionResponse).toHaveBeenCalledWith(fetcher, "sc-1", "item-1", {
      comment: "No evidence needed.",
      photoFileIds: [],
    });
    expect(result).toEqual({ status: "resolved", items: [{ id: "item-1", status: "resolved" }] });
  });

  it("with photos all confirmed IN THIS DRAIN: reads fileIds from the drain summary WITHOUT a second upload", async () => {
    (getQueuedUploads as jest.Mock).mockResolvedValue([]); // nothing left queued = all uploaded
    (drainUploadQueue as jest.Mock).mockResolvedValue({
      succeeded: 2,
      failed: 0,
      remaining: 0,
      confirmedFileIds: { a: "file-a", b: "file-b" },
    });
    const result = await submitCorrectiveActionItem(fetcher, "owner-1", {
      scorecardId: "sc-1",
      itemId: "item-1",
      dealId: "deal-1",
      photos: [photo("a"), photo("b")],
      comment: "Corrected.",
    });
    expect(enqueueUploads).toHaveBeenCalledTimes(1);
    expect(drainUploadQueue).toHaveBeenCalledWith("owner-1", fetcher);
    // No second upload: the drain already surfaced the confirmed file ids.
    expect(uploadCapture).not.toHaveBeenCalled();
    expect(runConcurrentUploads).not.toHaveBeenCalled();
    expect(submitCorrectiveActionResponse).toHaveBeenCalledWith(fetcher, "sc-1", "item-1", {
      comment: "Corrected.",
      photoFileIds: ["file-a", "file-b"],
    });
    expect(result.status).toBe("resolved");
  });

  it("falls back to a concurrent idempotent re-confirm (no re-PUT context) only for photos missing from the drain map, preserving order", async () => {
    (getQueuedUploads as jest.Mock).mockResolvedValue([]); // nothing left queued = all uploaded
    // Photo "a" was confirmed by an EARLIER drain (already gone from the queue → not in this map); "b" here.
    (drainUploadQueue as jest.Mock).mockResolvedValue({
      succeeded: 1,
      failed: 0,
      remaining: 0,
      confirmedFileIds: { b: "file-b" },
    });
    const result = await submitCorrectiveActionItem(fetcher, "owner-1", {
      scorecardId: "sc-1",
      itemId: "item-1",
      dealId: "deal-1",
      photos: [photo("a"), photo("b")],
      comment: "Corrected.",
    });
    // Only the uncovered photo ("a") is re-confirmed via uploadCapture; "b" comes from the drain map.
    expect(runConcurrentUploads).toHaveBeenCalledTimes(1);
    expect(uploadCapture).toHaveBeenCalledTimes(1);
    expect((uploadCapture as jest.Mock).mock.calls[0][1]).toMatchObject({ clientUploadId: "a" });
    expect(submitCorrectiveActionResponse).toHaveBeenCalledWith(fetcher, "sc-1", "item-1", {
      comment: "Corrected.",
      photoFileIds: ["file-a", "file-b"],
    });
    expect(result.status).toBe("resolved");
  });

  it("with a photo still retrying: returns photos_pending and does NOT POST", async () => {
    (getQueuedUploads as jest.Mock).mockResolvedValue([{ clientUploadId: "a", attempts: 1 }]);
    const result = await submitCorrectiveActionItem(fetcher, "owner-1", {
      scorecardId: "sc-1",
      itemId: "item-1",
      dealId: "deal-1",
      photos: [photo("a")],
      comment: "Corrected.",
    });
    expect(result).toEqual({ status: "photos_pending", remaining: 1 });
    expect(submitCorrectiveActionResponse).not.toHaveBeenCalled();
  });

  it("with a photo past the retry cap: returns photos_failed and does NOT POST", async () => {
    (getQueuedUploads as jest.Mock).mockResolvedValue([{ clientUploadId: "a", attempts: 5 }]);
    const result = await submitCorrectiveActionItem(fetcher, "owner-1", {
      scorecardId: "sc-1",
      itemId: "item-1",
      dealId: "deal-1",
      photos: [photo("a")],
      comment: "Corrected.",
    });
    expect(result).toEqual({ status: "photos_failed", failed: 1 });
    expect(submitCorrectiveActionResponse).not.toHaveBeenCalled();
  });
});
