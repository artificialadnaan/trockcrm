import * as SecureStore from "expo-secure-store";
import {
  getSaveToCameraRoll,
  setSaveToCameraRoll,
  __resetSaveToCameraRollSession,
} from "../camera-roll-setting";

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
    __resetSaveToCameraRollSession();
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

  it("honors an in-session opt-out even when the persist REJECTS (no save despite a failed write)", async () => {
    (SecureStore.setItemAsync as jest.Mock).mockRejectedValueOnce(new Error("keychain locked"));
    await setSaveToCameraRoll(false);
    // Persist failed, but the in-session override still reflects the user's OFF choice.
    expect(await getSaveToCameraRoll()).toBe(false);
  });

  it("serializes overlapping persists so the LAST toggle wins on disk even if an earlier write is slower", async () => {
    // Model the durable store: each write updates it WHEN it completes, so the final value reflects which
    // write landed LAST — the actual invariant (not just call order).
    let durable: string | null = null;
    let resolveFirst!: () => void;
    (SecureStore.setItemAsync as jest.Mock)
      .mockImplementationOnce(
        (_k: string, v: string) =>
          new Promise<void>((r) => {
            resolveFirst = () => {
              durable = v;
              r();
            };
          }),
      )
      .mockImplementationOnce(async (_k: string, v: string) => {
        durable = v;
      });
    const p1 = setSaveToCameraRoll(false); // slow
    const p2 = setSaveToCameraRoll(true); // fast, but must not land before the slow one
    await new Promise((r) => setTimeout(r, 0)); // let the chained first write call setItemAsync
    resolveFirst(); // completes the slow write → durable="false"
    await Promise.all([p1, p2]);
    const calls = (SecureStore.setItemAsync as jest.Mock).mock.calls;
    expect(calls.map((c) => c[1])).toEqual(["false", "true"]); // executed in call order
    expect(durable).toBe("true"); // …and the LAST toggle is what remains on disk
  });
});
