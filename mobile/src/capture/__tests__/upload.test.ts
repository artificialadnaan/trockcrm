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

import { confirmUpload, createUploadUrl, replacePhotoTags } from "../../api/endpoints";
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
