import * as MediaLibrary from "expo-media-library";
import { getLibraryCreationTime } from "../library-asset-time";

jest.mock("expo-media-library", () => ({
  getAssetInfoAsync: jest.fn(async () => ({ creationTime: 0 })),
}));

const mockInfo = (info: unknown) =>
  (MediaLibrary.getAssetInfoAsync as unknown as jest.Mock).mockResolvedValueOnce(info);

describe("getLibraryCreationTime", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns the Photos library's creation time as an ISO string", async () => {
    const ms = Date.UTC(2026, 2, 10, 14, 5, 9);
    mockInfo({ creationTime: ms });
    await expect(getLibraryCreationTime("asset-1")).resolves.toBe(new Date(ms).toISOString());
    expect(MediaLibrary.getAssetInfoAsync).toHaveBeenCalledWith("asset-1");
  });

  // A limited photo-library grant can leave assetId null on the picker result. That is a normal outcome,
  // not an error, and it must not cost a native call.
  it("skips the lookup entirely for a missing assetId", async () => {
    await expect(getLibraryCreationTime(null)).resolves.toBeUndefined();
    await expect(getLibraryCreationTime(undefined)).resolves.toBeUndefined();
    await expect(getLibraryCreationTime("")).resolves.toBeUndefined();
    expect(MediaLibrary.getAssetInfoAsync).not.toHaveBeenCalled();
  });

  it("returns undefined rather than throwing when the lookup fails", async () => {
    (MediaLibrary.getAssetInfoAsync as unknown as jest.Mock).mockRejectedValueOnce(new Error("denied"));
    await expect(getLibraryCreationTime("asset-1")).resolves.toBeUndefined();
  });

  // Each of these would otherwise become a real-looking date — 1970 for the zero/absent cases, or a thrown
  // RangeError out of toISOString for the out-of-range one, inside a best-effort path nobody is watching.
  it.each([
    ["absent", {}],
    ["null info", null],
    ["zero", { creationTime: 0 }],
    ["negative", { creationTime: -1 }],
    ["non-numeric", { creationTime: "2026-03-10" }],
    ["NaN", { creationTime: Number.NaN }],
    ["Infinity", { creationTime: Number.POSITIVE_INFINITY }],
    ["beyond the Date range", { creationTime: 8.64e15 + 1 }],
  ])("returns undefined for an unusable creationTime (%s)", async (_label, info) => {
    mockInfo(info);
    await expect(getLibraryCreationTime("asset-1")).resolves.toBeUndefined();
  });
});
