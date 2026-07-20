jest.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg" },
  manipulateAsync: jest.fn(async () => ({ uri: "file:///compressed.jpg" })),
}));
jest.mock("expo-file-system/legacy", () => ({
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 456 })),
}));

import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import { compressForEnqueue } from "../compress";

describe("compressForEnqueue", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns the compressed source + size + compressed:true on success", async () => {
    const r = await compressForEnqueue("file:///orig.heic", 5000, 4000);
    expect(r).toEqual({ sourceUri: "file:///compressed.jpg", sizeBytes: 456, compressed: true });
  });

  it("stays compressed:true when the size read misses (sizeBytes 0) — the drain re-stats, never re-encodes", async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: 0 });
    const r = await compressForEnqueue("file:///orig.heic", 5000, 4000);
    expect(r).toEqual({ sourceUri: "file:///compressed.jpg", sizeBytes: 0, compressed: true });
  });

  it("falls back to the ORIGINAL uri with compressed:false when compression throws (no photo lost)", async () => {
    (ImageManipulator.manipulateAsync as jest.Mock).mockRejectedValueOnce(new Error("decode failed"));
    const r = await compressForEnqueue("file:///orig.heic", 5000, 4000);
    expect(r).toEqual({ sourceUri: "file:///orig.heic", compressed: false });
  });
});
