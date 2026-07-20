import * as SecureStore from "expo-secure-store";
import { getSaveToCameraRoll, setSaveToCameraRoll } from "../camera-roll-setting";

// In-memory expo-secure-store (store lives inside the factory to dodge jest.mock hoisting).
jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
    setItemAsync: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    __clear: () => store.clear(),
  };
});

describe("saveToCameraRoll setting", () => {
  beforeEach(() => {
    (SecureStore as unknown as { __clear: () => void }).__clear();
    jest.clearAllMocks();
  });

  it("defaults to ON when never set", async () => {
    expect(await getSaveToCameraRoll()).toBe(true);
  });

  it("round-trips a set value (off, then back on)", async () => {
    await setSaveToCameraRoll(false);
    expect(await getSaveToCameraRoll()).toBe(false);
    await setSaveToCameraRoll(true);
    expect(await getSaveToCameraRoll()).toBe(true);
  });

  it("stays ON if the secure-store read throws (never silently disables the backup)", async () => {
    (SecureStore.getItemAsync as jest.Mock).mockRejectedValueOnce(new Error("keychain locked"));
    expect(await getSaveToCameraRoll()).toBe(true);
  });
});
