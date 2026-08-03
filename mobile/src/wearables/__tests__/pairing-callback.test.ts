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

describe("deliverPendingPairingUrl", () => {
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
