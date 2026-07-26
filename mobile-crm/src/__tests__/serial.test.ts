import { createSerialRunner } from "../lib/serial";

/** A deferred promise, so a test can control exactly when an operation completes. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The ordering primitive behind BOTH the SecureStore queue and session revalidation. The bug it exists
 * to prevent is the same in both: an operation that reads shared state starting before the previous one
 * finished writing it.
 */
describe("createSerialRunner", () => {
  it("never overlaps two operations", async () => {
    const order: string[] = [];
    const run = createSerialRunner();
    const gate = deferred();

    const a = run(async () => {
      order.push("a:start");
      await gate.promise;
      order.push("a:end");
    });
    const b = run(async () => {
      order.push("b:start");
    });

    gate.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("lets the LAST submitted operation observe what earlier ones wrote", async () => {
    // This is what makes "newest revalidation wins" true. Without it both calls read the same starting
    // state, the first response to land replaces it, and the second — though newer — is discarded by its
    // own identity check.
    let state = "initial";
    const run = createSerialRunner();
    const gate = deferred();

    const first = run(async () => {
      await gate.promise;
      state = "from-first";
    });
    const second = run(async () => {
      // Runs only after `first` finished, so it sees that write rather than the original value.
      expect(state).toBe("from-first");
      state = "from-second";
    });

    gate.resolve();
    await Promise.all([first, second]);
    expect(state).toBe("from-second");
  });

  it("keeps running later operations after one rejects", async () => {
    // A single failure must not wedge the chain for the life of the process.
    const run = createSerialRunner();
    await expect(run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");

    const after = jest.fn().mockResolvedValue("ok");
    await expect(run(after)).resolves.toBe("ok");
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("propagates the rejection to the caller that submitted it", async () => {
    const run = createSerialRunner();
    await expect(run(() => Promise.reject(new Error("write failed")))).rejects.toThrow("write failed");
  });

  it("returns each operation's own resolved value", async () => {
    const run = createSerialRunner();
    await expect(run(async () => 42)).resolves.toBe(42);
  });
});

describe("openLink reports success as well as failure", () => {
  afterEach(() => jest.resetModules());

  function withLinking(openURL: jest.Mock) {
    jest.resetModules();
    jest.doMock("react-native", () => ({ Linking: { openURL } }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../lib/open-link") as typeof import("../lib/open-link");
  }

  it("reports null on success so a previous failure is cleared", async () => {
    // Without this a single transient handoff failure stuck permanently: the button kept reading
    // "Can't call" even after a retry that plainly opened the dialer.
    const { openLink } = withLinking(jest.fn().mockResolvedValue(undefined));
    const report = jest.fn();
    await openLink("tel:2145551212", report);
    expect(report).toHaveBeenCalledWith(null);
  });

  it("clears on a retry that succeeds after a failure", async () => {
    const openURL = jest
      .fn()
      .mockRejectedValueOnce(new Error("no handler"))
      .mockResolvedValueOnce(undefined);
    const { openLink } = withLinking(openURL);
    const seen: Array<string | null> = [];
    const report = (m: string | null) => void seen.push(m);

    await openLink("tel:2145551212", report);
    await openLink("tel:2145551212", report);
    expect(seen).toEqual(["Couldn't call from this device.", null]);
  });
});
