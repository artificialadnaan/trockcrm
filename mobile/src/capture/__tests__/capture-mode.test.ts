jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
}));

import * as SecureStore from "expo-secure-store";
import { DEFAULT_CAPTURE_MODE, loadCaptureMode, saveCaptureMode } from "../capture-mode";

const getItem = SecureStore.getItemAsync as jest.Mock;
const setItem = SecureStore.setItemAsync as jest.Mock;

describe("capture-mode persistence", () => {
  beforeEach(() => jest.clearAllMocks());

  it("defaults to per-photo (document-as-you-go) when nothing is stored", async () => {
    getItem.mockResolvedValue(null);
    expect(DEFAULT_CAPTURE_MODE).toBe("perPhoto");
    expect(await loadCaptureMode()).toBe("perPhoto");
  });

  it("returns the stored mode", async () => {
    getItem.mockResolvedValue("batch");
    expect(await loadCaptureMode()).toBe("batch");
  });

  it("ignores a corrupt stored value and falls back to the default", async () => {
    getItem.mockResolvedValue("garbage");
    expect(await loadCaptureMode()).toBe("perPhoto");
  });

  it("never throws on a storage read failure — falls back to the default", async () => {
    getItem.mockRejectedValue(new Error("keychain unavailable"));
    expect(await loadCaptureMode()).toBe("perPhoto");
  });

  it("persists the chosen mode", async () => {
    setItem.mockResolvedValue(undefined);
    await saveCaptureMode("batch");
    expect(setItem).toHaveBeenCalledWith("trockcam.captureMode", "batch");
  });

  it("swallows a storage write failure (choice still applies this session)", async () => {
    setItem.mockRejectedValue(new Error("disk full"));
    await expect(saveCaptureMode("perPhoto")).resolves.toBeUndefined();
  });
});
