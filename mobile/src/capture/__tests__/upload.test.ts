jest.mock("expo-file-system/legacy", () => ({
  FileSystemUploadType: { BINARY_CONTENT: 0 },
  uploadAsync: jest.fn(async () => ({ status: 200 })),
}));

jest.mock("../compress", () => ({
  compressForUpload: jest.fn(async () => ({
    uri: "file:///compressed.jpg",
    contentType: "image/jpeg",
    sizeBytes: 123,
  })),
}));

jest.mock("../../api/endpoints", () => ({
  createUploadUrl: jest.fn(async () => ({
    uploadUrl: "https://upload.test/photo",
    objectKey: "office_atlanta/photo.jpg",
    uploadToken: "token-1",
  })),
  confirmUpload: jest.fn(async () => ({ photo: { id: "photo-1" } })),
  replacePhotoTags: jest.fn(async () => ({ tags: [] })),
}));

import * as FileSystem from "expo-file-system/legacy";
import { confirmUpload, createUploadUrl, replacePhotoTags } from "../../api/endpoints";
import { compressForUpload } from "../compress";
import { uploadCapture, type CaptureUploadInput } from "../upload";

function input(scorecardId?: string): CaptureUploadInput {
  return {
    uri: "file:///photo.jpg",
    target: { dealId: "deal-1" },
    category: null,
    caption: "Evidence",
    tags: ["scorecard", "safety"],
    metadata: {},
    clientUploadId: "upload-1",
    ...(scorecardId ? { scorecardId, routeByTarget: true } : {}),
  };
}

describe("uploadCapture scorecard edit scope", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sends the exact scorecard + client id scope in both backend steps for submitted-edit evidence", async () => {
    const fetcher = jest.fn() as never;
    await uploadCapture(fetcher, input("scorecard-1"));

    expect(createUploadUrl).toHaveBeenCalledWith(
      fetcher,
      expect.objectContaining({
        dealId: "deal-1",
        scorecardId: "scorecard-1",
        clientUploadId: "upload-1",
      }),
    );
    expect(confirmUpload).toHaveBeenCalledWith(
      fetcher,
      expect.objectContaining({ dealId: "deal-1", scorecardId: "scorecard-1", clientUploadId: "upload-1" }),
    );
    expect(replacePhotoTags).toHaveBeenCalledWith(fetcher, "photo-1", ["scorecard", "safety"]);
  });

  it("does not add a scorecard scope to ordinary/new-draft uploads", async () => {
    const fetcher = jest.fn() as never;
    await uploadCapture(fetcher, input());

    expect(createUploadUrl).toHaveBeenCalledWith(fetcher, expect.not.objectContaining({ scorecardId: expect.anything() }));
    expect(createUploadUrl).toHaveBeenCalledWith(fetcher, expect.objectContaining({ clientUploadId: "upload-1" }));
    expect(confirmUpload).toHaveBeenCalledWith(fetcher, expect.not.objectContaining({ scorecardId: expect.anything() }));
    expect(replacePhotoTags).toHaveBeenCalledWith(fetcher, "photo-1", ["scorecard", "safety"]);
  });
});

describe("uploadCapture compression handling (compress-on-enqueue)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("does NOT re-compress a pre-compressed item — uploads its uri with the stored sizeBytes", async () => {
    const fetcher = jest.fn() as never;
    await uploadCapture(fetcher, {
      ...input(),
      uri: "file:///already-compressed.jpg",
      compressed: true,
      sizeBytes: 999,
    });
    expect(compressForUpload).not.toHaveBeenCalled();
    expect(createUploadUrl).toHaveBeenCalledWith(fetcher, expect.objectContaining({ sizeBytes: 999 }));
    expect(FileSystem.uploadAsync).toHaveBeenCalledWith(
      "https://upload.test/photo",
      "file:///already-compressed.jpg",
      expect.anything(),
    );
  });

  it("re-compresses a stale queued item with a frozen sizeBytes:0 — never PUTs a zero size (self-heal)", async () => {
    const fetcher = jest.fn() as never;
    await uploadCapture(fetcher, { ...input(), uri: "file:///c.jpg", compressed: true, sizeBytes: 0 });
    expect(compressForUpload).toHaveBeenCalled(); // 0 is not trusted → falls through to compression
    expect(createUploadUrl).toHaveBeenCalledWith(fetcher, expect.objectContaining({ sizeBytes: 123 }));
  });

  it("compresses a legacy/fallback item (compressed unset) at drain time, as before", async () => {
    const fetcher = jest.fn() as never;
    await uploadCapture(fetcher, input()); // no compressed flag → drain compresses
    expect(compressForUpload).toHaveBeenCalledWith("file:///photo.jpg", undefined, undefined);
    expect(createUploadUrl).toHaveBeenCalledWith(fetcher, expect.objectContaining({ sizeBytes: 123 }));
    expect(FileSystem.uploadAsync).toHaveBeenCalledWith(
      "https://upload.test/photo",
      "file:///compressed.jpg",
      expect.anything(),
    );
  });
});
