// Drive the corrective-action per-item response state + submit orchestration deterministically by mocking
// the SCORECARD-SCOPED upload endpoints, the R2 PUT, and compression (jest hoists these above the imports).
// The response photos MUST upload through the scorecard-scoped endpoints (server resolves the SCORECARD'S
// office, not the uploader's active office) so the returned fileIds exist in the tenant the response POST
// reads — the fix for the off-office orphaned-file bug.
jest.mock("expo-file-system/legacy", () => ({
  FileSystemUploadType: { BINARY_CONTENT: 0 },
  // Default: R2 accepts the PUT.
  uploadAsync: jest.fn(async () => ({ status: 200 })),
}));
jest.mock("../../capture/compress", () => ({
  // Return a stable compressed descriptor keyed off the source uri so assertions can trace each photo.
  compressForUpload: jest.fn(async (uri: string) => ({
    uri: `${uri}.jpg`,
    sizeBytes: 1234,
    contentType: "image/jpeg",
  })),
}));
jest.mock("../../capture/concurrency", () => ({
  // Bounded pool that runs each worker and settles (never rejects) — preserves input order.
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
  requestCorrectiveActionUploadUrl: jest.fn(async (_f: unknown, _scorecardId: string) => ({
    uploadUrl: "https://r2.example/upload",
    objectKey: "obj-key",
    uploadToken: "up-token",
    expiresIn: 900,
  })),
  confirmCorrectiveActionUpload: jest.fn(async (_f: unknown, _scorecardId: string) => ({ fileId: "file-x" })),
  submitCorrectiveActionResponse: jest.fn(async () => ({ items: [{ id: "item-1", status: "resolved" }] })),
}));

import {
  correctiveResponseReducer,
  emptyCorrectiveResponse,
  submitCorrectiveActionItem,
  type CorrectiveResponsePhoto,
} from "../corrective-action";
import * as FileSystem from "expo-file-system/legacy";
import {
  requestCorrectiveActionUploadUrl,
  confirmCorrectiveActionUpload,
  submitCorrectiveActionResponse,
} from "../../api/endpoints";

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

describe("submitCorrectiveActionItem", () => {
  const fetcher = (() => {}) as never;

  beforeEach(() => {
    jest.clearAllMocks();
    (FileSystem.uploadAsync as jest.Mock).mockResolvedValue({ status: 200 });
    (requestCorrectiveActionUploadUrl as jest.Mock).mockResolvedValue({
      uploadUrl: "https://r2.example/upload",
      objectKey: "obj-key",
      uploadToken: "up-token",
      expiresIn: 900,
    });
    (confirmCorrectiveActionUpload as jest.Mock).mockResolvedValue({ fileId: "file-x" });
    (submitCorrectiveActionResponse as jest.Mock).mockResolvedValue({
      items: [{ id: "item-1", status: "resolved" }],
    });
  });

  it("with no photos: skips upload and POSTs just the comment → resolved", async () => {
    const result = await submitCorrectiveActionItem(fetcher, {
      scorecardId: "sc-1",
      itemId: "item-1",
      dealId: "deal-1",
      photos: [],
      comment: "No evidence needed.",
    });
    expect(requestCorrectiveActionUploadUrl).not.toHaveBeenCalled();
    expect(confirmCorrectiveActionUpload).not.toHaveBeenCalled();
    expect(FileSystem.uploadAsync).not.toHaveBeenCalled();
    expect(submitCorrectiveActionResponse).toHaveBeenCalledWith(fetcher, "sc-1", "item-1", {
      comment: "No evidence needed.",
      photoFileIds: [],
    });
    expect(result).toEqual({ status: "resolved", items: [{ id: "item-1", status: "resolved" }] });
  });

  it("uploads each photo through the SCORECARD-SCOPED endpoints (office resolves from the scorecard) and flows the fileIds into the response POST, in order", async () => {
    // Distinct fileId per confirm so we can assert order is preserved.
    (confirmCorrectiveActionUpload as jest.Mock).mockImplementation(async (_f, _sc, body) => ({
      fileId: `file-for-${body.objectKey}`,
    }));
    // Deterministic objectKey per photo, derived from its (distinct) compressed size, so confirm's
    // objectKey-derived fileId is traceable back to the source photo AND order-stable.
    (requestCorrectiveActionUploadUrl as jest.Mock).mockImplementation(async (_f, _sc, body) => ({
      uploadUrl: "https://r2.example/upload",
      objectKey: `obj-${body.sizeBytes}`,
      uploadToken: "up-token",
      expiresIn: 900,
    }));
    // Give the two photos distinct compressed sizes so their objectKeys (and thus fileIds) differ + are traceable.
    const { compressForUpload } = jest.requireMock("../../capture/compress") as {
      compressForUpload: jest.Mock;
    };
    compressForUpload
      .mockResolvedValueOnce({ uri: "file://a.jpg", sizeBytes: 111, contentType: "image/jpeg" })
      .mockResolvedValueOnce({ uri: "file://b.jpg", sizeBytes: 222, contentType: "image/jpeg" });

    const result = await submitCorrectiveActionItem(fetcher, {
      scorecardId: "sc-1",
      itemId: "item-1",
      dealId: "deal-1",
      photos: [photo("a"), photo("b")],
      comment: "Corrected.",
    });

    // Presign + confirm target the SCORECARD id (office resolves from the scorecard server-side), NOT a deal.
    expect(requestCorrectiveActionUploadUrl).toHaveBeenCalledTimes(2);
    expect((requestCorrectiveActionUploadUrl as jest.Mock).mock.calls[0][1]).toBe("sc-1");
    expect(confirmCorrectiveActionUpload).toHaveBeenCalledTimes(2);
    expect((confirmCorrectiveActionUpload as jest.Mock).mock.calls[0][1]).toBe("sc-1");
    // Each photo is PUT to the presigned R2 url.
    expect(FileSystem.uploadAsync).toHaveBeenCalledTimes(2);

    // The confirmed fileIds flow into the response POST, preserving the original photo order (a before b).
    const call = (submitCorrectiveActionResponse as jest.Mock).mock.calls[0];
    expect(call[1]).toBe("sc-1");
    expect(call[2]).toBe("item-1");
    expect(call[3].comment).toBe("Corrected.");
    expect(call[3].photoFileIds).toEqual(["file-for-obj-111", "file-for-obj-222"]);
    expect(result.status).toBe("resolved");
  });

  it("with a photo whose R2 PUT fails: returns photos_failed and does NOT POST", async () => {
    (FileSystem.uploadAsync as jest.Mock)
      .mockResolvedValueOnce({ status: 200 })
      .mockResolvedValueOnce({ status: 500 });
    const result = await submitCorrectiveActionItem(fetcher, {
      scorecardId: "sc-1",
      itemId: "item-1",
      dealId: "deal-1",
      photos: [photo("a"), photo("b")],
      comment: "Corrected.",
    });
    expect(result).toEqual({ status: "photos_failed", failed: 1 });
    expect(submitCorrectiveActionResponse).not.toHaveBeenCalled();
  });

  it("with a confirm that rejects: returns photos_failed and does NOT POST", async () => {
    (confirmCorrectiveActionUpload as jest.Mock).mockRejectedValue(new Error("network"));
    const result = await submitCorrectiveActionItem(fetcher, {
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
