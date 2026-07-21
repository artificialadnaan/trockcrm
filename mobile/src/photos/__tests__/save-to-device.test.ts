jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  downloadAsync: jest.fn(async () => ({ uri: "file:///cache/trockcam-download-1.jpg", status: 200 })),
  deleteAsync: jest.fn(async () => undefined),
}));
jest.mock("expo-media-library", () => ({
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  saveToLibraryAsync: jest.fn(async () => undefined),
}));

import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import { savePhotoToDevice } from "../save-to-device";

describe("savePhotoToDevice", () => {
  beforeEach(() => jest.clearAllMocks());

  it("requests add-only permission, downloads, saves to the library, and cleans up the temp file", async () => {
    const r = await savePhotoToDevice("https://r2.test/photo.jpg?sig=abc");
    expect(r).toBe("saved");
    expect(MediaLibrary.requestPermissionsAsync).toHaveBeenCalledWith(true); // write-only / add-only
    expect(FileSystem.downloadAsync).toHaveBeenCalledWith(
      "https://r2.test/photo.jpg?sig=abc",
      expect.stringContaining(".jpg"),
    );
    expect(MediaLibrary.saveToLibraryAsync).toHaveBeenCalledWith("file:///cache/trockcam-download-1.jpg");
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith("file:///cache/trockcam-download-1.jpg", { idempotent: true });
  });

  it("returns permission_denied WITHOUT downloading when add permission is refused", async () => {
    (MediaLibrary.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });
    const r = await savePhotoToDevice("https://r2.test/photo.jpg");
    expect(r).toBe("permission_denied");
    expect(FileSystem.downloadAsync).not.toHaveBeenCalled();
    expect(MediaLibrary.saveToLibraryAsync).not.toHaveBeenCalled();
  });

  it("returns failed (and still cleans up) on a non-2xx download", async () => {
    (FileSystem.downloadAsync as jest.Mock).mockResolvedValueOnce({ uri: "file:///cache/x.jpg", status: 403 });
    const r = await savePhotoToDevice("https://r2.test/photo.jpg");
    expect(r).toBe("failed");
    expect(MediaLibrary.saveToLibraryAsync).not.toHaveBeenCalled();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith("file:///cache/x.jpg", { idempotent: true });
  });

  it("returns failed on an exception (never throws to the caller)", async () => {
    (FileSystem.downloadAsync as jest.Mock).mockRejectedValueOnce(new Error("network down"));
    expect(await savePhotoToDevice("https://r2.test/photo.jpg")).toBe("failed");
  });

  it("returns failed for an empty url (no permission prompt)", async () => {
    expect(await savePhotoToDevice("")).toBe("failed");
    expect(MediaLibrary.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it("defaults the temp extension to .jpg when the url has no clean extension", async () => {
    await savePhotoToDevice("https://r2.test/deal/v1.2/photo");
    expect(FileSystem.downloadAsync).toHaveBeenCalledWith(
      "https://r2.test/deal/v1.2/photo",
      expect.stringContaining(".jpg"),
    );
  });
});
