import * as MediaLibrary from "expo-media-library";
import { saveOriginalToCameraRoll } from "../camera-roll";
import { getSaveToCameraRoll } from "../../settings/camera-roll-setting";

jest.mock("expo-media-library", () => ({
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  saveToLibraryAsync: jest.fn(async () => {}),
}));
jest.mock("../../settings/camera-roll-setting", () => ({
  getSaveToCameraRoll: jest.fn(async () => true),
}));

describe("saveOriginalToCameraRoll", () => {
  beforeEach(() => jest.clearAllMocks());

  it("saves the original when the setting is ON and permission is granted", async () => {
    await saveOriginalToCameraRoll("file:///orig.jpg");
    expect(MediaLibrary.saveToLibraryAsync).toHaveBeenCalledWith("file:///orig.jpg");
  });

  it("requests WRITE-ONLY (add-only) permission, not full library access", async () => {
    await saveOriginalToCameraRoll("file:///orig.jpg");
    expect(MediaLibrary.requestPermissionsAsync).toHaveBeenCalledWith(true);
  });

  it("skips entirely when the setting is OFF (no permission prompt, no save)", async () => {
    (getSaveToCameraRoll as jest.Mock).mockResolvedValueOnce(false);
    await saveOriginalToCameraRoll("file:///orig.jpg");
    expect(MediaLibrary.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(MediaLibrary.saveToLibraryAsync).not.toHaveBeenCalled();
  });

  it("skips the save when permission is denied", async () => {
    (MediaLibrary.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });
    await saveOriginalToCameraRoll("file:///orig.jpg");
    expect(MediaLibrary.saveToLibraryAsync).not.toHaveBeenCalled();
  });

  it("never throws when saveToLibraryAsync fails (best-effort backup)", async () => {
    (MediaLibrary.saveToLibraryAsync as jest.Mock).mockRejectedValueOnce(new Error("disk full"));
    await expect(saveOriginalToCameraRoll("file:///orig.jpg")).resolves.toBeUndefined();
  });
});
