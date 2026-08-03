/**
 * The one-shot pairing callback, and what happens to it when `configure()` fails.
 *
 * A Meta registration callback arrives exactly once. Handing it to an SDK that is not configured
 * spends it: the SDK rejects, nothing replays the URL, and the user is left on unpaired glasses with
 * no error anywhere and no way back except running the whole Meta AI handoff again. The root layout
 * used to do precisely that — it waited for configuration to be ATTEMPTED, which resolves on failure
 * too, and then called `handleUrl` regardless and discarded the rejection.
 */
const mockConfigure = jest.fn();
const mockHandleUrl = jest.fn();
const mockSetStartupConfigureError = jest.fn();

jest.mock("../native", () => ({
  isAvailable: true,
  setStartupConfigureError: (error: unknown) => mockSetStartupConfigureError(error),
  Wearables: {
    configure: () => mockConfigure(),
    handleUrl: (url: string) => mockHandleUrl(url),
  },
}));

type PairingCallback = typeof import("../pairing-callback");

/** A fresh module registry per test: the configure memo and the retained URL are module state, and a
 *  test that inherits either from the one before it is testing the previous test's leftovers. */
function load(): PairingCallback {
  let mod!: PairingCallback;
  jest.isolateModules(() => {
    mod = require("../pairing-callback") as PairingCallback;
  });
  return mod;
}

/** Let queued chain work start: deliveries run on a promise chain, not synchronously at call time. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const CALLBACK_URL = "trockcam://wearables/callback?state=abc123";
const LATER_CALLBACK_URL = "trockcam://wearables/callback?state=def456";
const CONFIGURED = { configured: true, alreadyConfigured: false };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("deliverPairingUrl", () => {
  it("REGRESSION: holds the callback when configure FAILED, instead of spending it on an SDK that cannot receive it", async () => {
    mockConfigure.mockRejectedValue(new Error("MetaAppID rejected: invalid client token"));
    const pairing = load();

    await pairing.deliverPairingUrl(CALLBACK_URL);

    // The precise defect: `handleUrl` was called here anyway and its rejection swallowed.
    expect(mockHandleUrl).not.toHaveBeenCalled();
    expect(pairing.hasPendingPairingUrl()).toBe(true);
  });

  it("REGRESSION: the held callback reaches the SDK on the pairing row's next successful configure", async () => {
    mockConfigure.mockRejectedValueOnce(new Error("SDK init failed")).mockResolvedValue(CONFIGURED);
    mockHandleUrl.mockResolvedValue({ handled: true });
    const pairing = load();

    await pairing.deliverPairingUrl(CALLBACK_URL);
    expect(mockHandleUrl).not.toHaveBeenCalled();

    // What `PairingRow.check()` does on mount, on manual refresh and on every foreground.
    expect(await pairing.deliverPendingPairingUrl()).toBe(true);

    // The SAME URL, delivered without Meta AI having been asked to reissue anything.
    expect(mockHandleUrl).toHaveBeenCalledTimes(1);
    expect(mockHandleUrl).toHaveBeenCalledWith(CALLBACK_URL);
    expect(pairing.hasPendingPairingUrl()).toBe(false);
  });

  it("REGRESSION: holds the callback when handleUrl itself rejects — the loss is identical", async () => {
    mockConfigure.mockResolvedValue(CONFIGURED);
    mockHandleUrl.mockRejectedValueOnce(new Error("handleUrl failed: registrationInProgress"));
    const pairing = load();

    await pairing.deliverPairingUrl(CALLBACK_URL);

    expect(mockHandleUrl).toHaveBeenCalledWith(CALLBACK_URL);
    expect(pairing.hasPendingPairingUrl()).toBe(true);
  });

  it("GUARD: a callback delivered to a configured SDK is handled once and nothing is retained", async () => {
    mockConfigure.mockResolvedValue(CONFIGURED);
    mockHandleUrl.mockResolvedValue({ handled: true });
    const pairing = load();

    await pairing.deliverPairingUrl(CALLBACK_URL);

    expect(mockHandleUrl).toHaveBeenCalledTimes(1);
    expect(mockHandleUrl).toHaveBeenCalledWith(CALLBACK_URL);
    // Nothing to replay: a retry here would hand the SDK a URL it has already consumed.
    expect(pairing.hasPendingPairingUrl()).toBe(false);
    expect(await pairing.deliverPendingPairingUrl()).toBe(false);
  });

  it("GUARD: a callback that got through clears one held from an earlier failure", async () => {
    mockConfigure.mockRejectedValueOnce(new Error("SDK init failed")).mockResolvedValue(CONFIGURED);
    mockHandleUrl.mockResolvedValue({ handled: true });
    const pairing = load();

    await pairing.deliverPairingUrl(CALLBACK_URL);
    expect(pairing.hasPendingPairingUrl()).toBe(true);

    // Pairing was re-run and this one landed, so the held URL describes a registration that is over.
    await pairing.deliverPairingUrl(LATER_CALLBACK_URL);

    expect(mockHandleUrl).toHaveBeenCalledWith(LATER_CALLBACK_URL);
    expect(pairing.hasPendingPairingUrl()).toBe(false);
  });
});

describe("a `handled: false` result", () => {
  it("REGRESSION: a callback the SDK DECLINES without throwing is held, not treated as delivered", async () => {
    mockConfigure.mockResolvedValue(CONFIGURED);
    // The quietest of the three failures: the promise resolves, so at the call site a decline is
    // indistinguishable from success unless the result is actually read.
    mockHandleUrl.mockResolvedValue({ handled: false });
    const pairing = load();

    await pairing.deliverPairingUrl(CALLBACK_URL);

    expect(pairing.hasPendingPairingUrl()).toBe(true);
  });

  it("REGRESSION: a DECLINED replay reports failure and keeps the callback", async () => {
    mockConfigure.mockRejectedValueOnce(new Error("SDK init failed")).mockResolvedValue(CONFIGURED);
    const pairing = load();
    await pairing.deliverPairingUrl(CALLBACK_URL);

    mockHandleUrl.mockResolvedValueOnce({ handled: false });
    expect(await pairing.deliverPendingPairingUrl()).toBe(false);
    expect(pairing.hasPendingPairingUrl()).toBe(true);

    mockHandleUrl.mockResolvedValueOnce({ handled: true });
    expect(await pairing.deliverPendingPairingUrl()).toBe(true);
    expect(pairing.hasPendingPairingUrl()).toBe(false);
  });
});

describe("the app's own deep links", () => {
  it.each([
    ["trockcam://accept-invite?token=abc", "an invite"],
    ["trockcam://scorecards/corrective-action/42", "a corrective action"],
  ])("REGRESSION: %s does not overwrite a held pairing callback (%s)", async (deepLink) => {
    mockConfigure.mockRejectedValue(new Error("SDK init failed"));
    const pairing = load();

    await pairing.deliverPairingUrl(CALLBACK_URL);
    expect(pairing.hasPendingPairingUrl()).toBe(true);

    // The root listener forwards EVERY incoming URL, so this arrives on the same path.
    await pairing.deliverPairingUrl(deepLink);

    // Still the pairing callback that is held — not the link the user happened to open next.
    mockConfigure.mockResolvedValue(CONFIGURED);
    mockHandleUrl.mockResolvedValue({ handled: true });
    expect(await pairing.deliverPendingPairingUrl()).toBe(true);
    expect(mockHandleUrl).toHaveBeenLastCalledWith(CALLBACK_URL);
  });

  it("GUARD: an unrecognised URL is still held — the SDK, not this module, decides what a callback is", () => {
    const pairing = load();
    // Meta publishes no stable callback path, so anything that is not one of ours is kept.
    expect(pairing.isRetainablePairingUrl("trockcam://wearables/callback?state=x")).toBe(true);
    expect(pairing.isRetainablePairingUrl("trockcam://some-unknown-meta-path")).toBe(true);
    expect(pairing.isRetainablePairingUrl("trockcam://accept-invite?token=abc")).toBe(false);
    expect(pairing.isRetainablePairingUrl("trockcam://Scorecards/corrective-action/1")).toBe(false);
  });
});

describe("deliverPendingPairingUrl", () => {
  it("REGRESSION: a foreground replay racing an in-flight delivery waits for it instead of reading an empty slot", async () => {
    let failConfigure!: (error: Error) => void;
    mockConfigure.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failConfigure = reject;
        })
    );
    mockConfigure.mockResolvedValue(CONFIGURED);
    mockHandleUrl.mockResolvedValue({ handled: true });
    const pairing = load();

    // A warm callback arrives. Its configure has not settled, so nothing is held YET.
    const delivering = pairing.deliverPairingUrl(CALLBACK_URL);
    await flush(); // let the delivery reach configure(), so it is genuinely in flight
    expect(pairing.hasPendingPairingUrl()).toBe(false);

    // `PairingRow.check()` fires on the same foreground, inside that window.
    const replaying = pairing.deliverPendingPairingUrl();

    failConfigure(new Error("SDK init failed"));
    await delivering;

    // Queued behind the delivery, so it sees what that delivery held rather than the empty slot it
    // had a moment earlier — which would have passed the only automatic retry point.
    expect(await replaying).toBe(true);
    expect(mockHandleUrl).toHaveBeenCalledWith(CALLBACK_URL);
    expect(pairing.hasPendingPairingUrl()).toBe(false);
  });

  it("REGRESSION: a REJECTED replay keeps the callback held rather than spending it", async () => {
    mockConfigure.mockRejectedValueOnce(new Error("SDK init failed")).mockResolvedValue(CONFIGURED);
    const pairing = load();

    await pairing.deliverPairingUrl(CALLBACK_URL);

    mockHandleUrl.mockRejectedValueOnce(new Error("handleUrl failed: not ready"));
    expect(await pairing.deliverPendingPairingUrl()).toBe(false);
    expect(pairing.hasPendingPairingUrl()).toBe(true);

    // The next foreground gets a real attempt, not an empty slot.
    mockHandleUrl.mockResolvedValueOnce({ handled: true });
    expect(await pairing.deliverPendingPairingUrl()).toBe(true);
    expect(mockHandleUrl).toHaveBeenLastCalledWith(CALLBACK_URL);
  });

  it("GUARD: with nothing held it does not touch the SDK at all", async () => {
    mockConfigure.mockResolvedValue(CONFIGURED);
    const pairing = load();

    expect(await pairing.deliverPendingPairingUrl()).toBe(false);
    expect(mockHandleUrl).not.toHaveBeenCalled();
  });
});

describe("ensureWearablesConfigured", () => {
  it("REGRESSION: a FAILED configure is not cached as the permanent answer — the next caller retries", async () => {
    mockConfigure.mockRejectedValueOnce(new Error("SDK init failed")).mockResolvedValue(CONFIGURED);
    const pairing = load();

    expect(await pairing.ensureWearablesConfigured()).toBe(false);
    // Without the retry, every pairing callback for the rest of the process inherits launch's failure.
    expect(await pairing.ensureWearablesConfigured()).toBe(true);
    expect(mockConfigure).toHaveBeenCalledTimes(2);
  });

  it("REGRESSION: survives a native module missing SYNCHRONOUSLY rather than rejecting", async () => {
    // `Wearables.configure` throws on the spot when the bridge is absent (native.ts's `require_`), so a
    // catch inside the attempt runs BEFORE the memo is assigned. Clearing the memo from there would
    // cache the failure forever — the exact opposite of the line above.
    mockConfigure.mockImplementationOnce(() => {
      throw new Error("WearablesBridge native module is missing.");
    });
    mockConfigure.mockResolvedValue(CONFIGURED);
    const pairing = load();

    expect(await pairing.ensureWearablesConfigured()).toBe(false);
    expect(await pairing.ensureWearablesConfigured()).toBe(true);
  });

  it("GUARD: a SUCCESSFUL configure is shared, not repeated per caller", async () => {
    mockConfigure.mockResolvedValue(CONFIGURED);
    const pairing = load();

    const [a, b] = await Promise.all([pairing.ensureWearablesConfigured(), pairing.ensureWearablesConfigured()]);

    expect([a, b]).toEqual([true, true]);
    expect(mockConfigure).toHaveBeenCalledTimes(1);
  });

  it("GUARD: retains the cause of a failure, and clears it once one succeeds", async () => {
    const cause = new Error("MetaAppID rejected: invalid client token");
    mockConfigure.mockRejectedValueOnce(cause).mockResolvedValue(CONFIGURED);
    const pairing = load();

    await pairing.ensureWearablesConfigured();
    // What `useWalk` reads to explain a refused walk instead of a generic "not configured".
    expect(mockSetStartupConfigureError).toHaveBeenCalledWith(cause);

    await pairing.ensureWearablesConfigured();
    // A stale cause outliving the failure would be appended to an unrelated later refusal.
    expect(mockSetStartupConfigureError).toHaveBeenLastCalledWith(null);
  });
});
