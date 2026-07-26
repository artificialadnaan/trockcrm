import { chooseActiveOffice, isOfficeConfirmed } from "../auth/office";
import { createPersistQueue } from "../auth/persist-queue";

/**
 * Two review findings live here, and both are silent-wrong rather than loud-wrong:
 *
 *  1. Secondary offices were discarded on EVERY launch, because the check compared them against
 *     /auth/me — which is answered without an office header and therefore always reports the PRIMARY
 *     office. A user who works out of a second office was quietly moved back to their first one, and the
 *     app then showed a different Postgres schema's pipeline with no error to explain it.
 *
 *  2. Sign-out only cleared memory. If SecureStore's delete rejected, the token stayed on disk and the
 *     next launch restored the session the user had just signed out of — on a shared field device that
 *     hands the account to whoever picks the phone up next.
 */

describe("chooseActiveOffice", () => {
  const PRIMARY = "office-primary";
  const SECONDARY = "office-secondary";

  it("keeps a secondary office that is still granted", () => {
    // The regression case. serverOfficeId is the PRIMARY office (that is all a header-less /auth/me can
    // report), so a naive equality check returns null here and silently switches the office every launch.
    expect(
      chooseActiveOffice({ storedActiveOfficeId: SECONDARY, serverOfficeId: PRIMARY, probe: "granted" }),
    ).toBe(SECONDARY);
  });

  it("drops a secondary office whose grant was revoked", () => {
    // Only a 403 from the office-scoped probe produces "revoked". Keeping it would send a stale
    // x-office-id on every request and 403 the entire app.
    expect(
      chooseActiveOffice({ storedActiveOfficeId: SECONDARY, serverOfficeId: PRIMARY, probe: "revoked" }),
    ).toBeNull();
  });

  it("keeps the stored office when the probe could not answer", () => {
    // "unknown" is offline / 5xx / a different gate answering first — NOT a revocation. Reverting on a
    // flaky connection would show another office's Postgres schema with nothing on screen to say why.
    expect(
      chooseActiveOffice({ storedActiveOfficeId: SECONDARY, serverOfficeId: PRIMARY, probe: "unknown" }),
    ).toBe(SECONDARY);
  });

  it("keeps the stored office when no probe was made at all", () => {
    expect(
      chooseActiveOffice({ storedActiveOfficeId: SECONDARY, serverOfficeId: PRIMARY, probe: null }),
    ).toBe(SECONDARY);
  });

  it("needs no probe when the stored office is the one the server reports", () => {
    expect(
      chooseActiveOffice({ storedActiveOfficeId: PRIMARY, serverOfficeId: PRIMARY, probe: null }),
    ).toBe(PRIMARY);
  });

  it("returns null when nothing was stored", () => {
    expect(
      chooseActiveOffice({ storedActiveOfficeId: null, serverOfficeId: PRIMARY, probe: "granted" }),
    ).toBeNull();
  });
});

describe("isOfficeConfirmed", () => {
  const PRIMARY = "office-primary";
  const SECONDARY = "office-secondary";

  it("confirms the common case where no probe was needed", () => {
    // THE regression. signIn seeds activeOfficeId from the login response, so on every subsequent launch
    // the stored office equals the home office and no probe runs. Reading that absence as doubt marked
    // essentially every session unconfirmed: the gate never left "stale", it retried every 30 seconds
    // forever, the onboarding fields were never refreshed from /auth/me, and the onboarding screen showed
    // "Couldn't reach the server" while /auth/me was in fact succeeding.
    expect(isOfficeConfirmed({ activeOfficeId: PRIMARY, serverOfficeId: PRIMARY, probe: null })).toBe(true);
  });

  it("confirms when no office is kept at all", () => {
    // Falls back to the home office, which is exactly what the header-less /auth/me describes.
    expect(isOfficeConfirmed({ activeOfficeId: null, serverOfficeId: PRIMARY, probe: null })).toBe(true);
  });

  it("confirms a secondary office only once its probe is granted", () => {
    expect(
      isOfficeConfirmed({ activeOfficeId: SECONDARY, serverOfficeId: PRIMARY, probe: "granted" }),
    ).toBe(true);
  });

  it.each(["unknown", "revoked", null] as const)(
    "does not confirm a secondary office on probe %p",
    (probe) => {
      // The onboarding fields are computed per-office server-side, so an unconfirmed secondary office
      // must not adopt home-office answers — that is how a gate opens on the wrong office's data.
      expect(isOfficeConfirmed({ activeOfficeId: SECONDARY, serverOfficeId: PRIMARY, probe })).toBe(false);
    },
  );
});

describe("clearSession durability", () => {
  const KEY = "trock.crm.session.v1";

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  /** Re-import session.ts against a fresh expo-secure-store mock for each scenario. */
  function withStore(store: {
    deleteItemAsync: jest.Mock;
    setItemAsync?: jest.Mock;
    getItemAsync?: jest.Mock;
  }) {
    jest.resetModules();
    jest.doMock("expo-secure-store", () => ({
      deleteItemAsync: store.deleteItemAsync,
      setItemAsync: store.setItemAsync ?? jest.fn().mockResolvedValue(undefined),
      getItemAsync: store.getItemAsync ?? jest.fn().mockResolvedValue(null),
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../auth/session") as typeof import("../auth/session");
  }

  it("deletes the item on the happy path and writes nothing", async () => {
    const deleteItemAsync = jest.fn().mockResolvedValue(undefined);
    const setItemAsync = jest.fn().mockResolvedValue(undefined);
    const session = withStore({ deleteItemAsync, setItemAsync });

    await expect(session.clearSession()).resolves.toBeUndefined();
    expect(deleteItemAsync).toHaveBeenCalledWith(KEY);
    expect(setItemAsync).not.toHaveBeenCalled();
  });

  it("overwrites the stored session when deletion rejects", async () => {
    const deleteItemAsync = jest.fn().mockRejectedValue(new Error("keychain unavailable"));
    const setItemAsync = jest.fn().mockResolvedValue(undefined);
    const session = withStore({ deleteItemAsync, setItemAsync });

    await expect(session.clearSession()).resolves.toBeUndefined();
    expect(setItemAsync).toHaveBeenCalledTimes(1);
    expect(setItemAsync.mock.calls[0][0]).toBe(KEY);
  });

  it("writes something loadSession refuses to restore", async () => {
    const deleteItemAsync = jest.fn().mockRejectedValue(new Error("keychain unavailable"));
    const setItemAsync = jest.fn().mockResolvedValue(undefined);
    const session = withStore({ deleteItemAsync, setItemAsync });
    await session.clearSession();
    const written = setItemAsync.mock.calls[0][1] as string;

    // The whole point of the fallback: whatever we leave behind must not restore as a session. Asserting
    // the literal "{}" would pass while proving nothing — this asserts the PROPERTY that matters.
    const reader = withStore({
      deleteItemAsync: jest.fn().mockResolvedValue(undefined),
      getItemAsync: jest.fn().mockResolvedValue(written),
    });
    await expect(reader.loadSession()).resolves.toBeNull();
  });

  it("never lets a failed cleanup escape loadSession", async () => {
    // clearSession rejects when BOTH the delete and the tombstone fail. loadSession calls it for a
    // corrupt record, and letting that reject escape would turn "the stored record was unreadable" into
    // a throw from the one function the rest of this file promises will fail safe.
    const session = withStore({
      deleteItemAsync: jest.fn().mockRejectedValue(new Error("delete failed")),
      setItemAsync: jest.fn().mockRejectedValue(new Error("write failed")),
      getItemAsync: jest.fn().mockResolvedValue("{ not json"),
    });
    await expect(session.loadSession()).resolves.toBeNull();
  });

  it("also fails safe for a structurally invalid record", async () => {
    const session = withStore({
      deleteItemAsync: jest.fn().mockRejectedValue(new Error("delete failed")),
      setItemAsync: jest.fn().mockRejectedValue(new Error("write failed")),
      getItemAsync: jest.fn().mockResolvedValue(JSON.stringify({ token: "", user: null })),
    });
    await expect(session.loadSession()).resolves.toBeNull();
  });

  it("rejects only when both the delete and the overwrite fail", async () => {
    const deleteItemAsync = jest.fn().mockRejectedValue(new Error("delete failed"));
    const setItemAsync = jest.fn().mockRejectedValue(new Error("write failed"));
    const session = withStore({ deleteItemAsync, setItemAsync });

    // Surfaces the ORIGINAL delete failure, which is the one that describes what actually went wrong.
    await expect(session.clearSession()).rejects.toThrow("delete failed");
  });
});

describe("persist queue", () => {
  /** A deferred promise, so a test can control exactly when an operation completes. */
  function deferred() {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("runs operations in order, never overlapping", async () => {
    const order: string[] = [];
    let generation = 0;
    const queue = createPersistQueue(() => generation);

    const first = deferred();
    const a = queue.save(0, async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = queue.save(0, async () => {
      order.push("b:start");
    });

    first.resolve();
    await Promise.all([a, b]);
    // b must not begin before a finishes: an interleaved delete and save is exactly how a newer
    // account's stored session gets removed by an older account's pending clear.
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("skips a SAVE whose generation has been superseded while it waited", async () => {
    // Writing an older session over a newer one is corruption, so this one must be dropped.
    let generation = 0;
    const queue = createPersistQueue(() => generation);
    const blocker = deferred();

    const held = queue.save(0, () => blocker.promise);
    const staleSave = jest.fn().mockResolvedValue(undefined);
    const stale = queue.save(0, staleSave);

    generation = 1; // a sign-in lands while the queue is blocked
    blocker.resolve();
    await Promise.all([held, stale]);
    expect(staleSave).not.toHaveBeenCalled();
  });

  it("still runs a CLEAR after a newer sign-in has advanced the generation", async () => {
    // The one that matters. A queued sign-out skipped because sign-in moved the generation leaves the
    // previous account's token on disk — and if the replacement save then fails, the new account is
    // never published either, so the NEXT LAUNCH silently restores an account somebody explicitly
    // signed out of. On a shared field device that is a credential exposure caused by the optimisation.
    let generation = 0;
    const queue = createPersistQueue(() => generation);
    const blocker = deferred();

    const held = queue.save(0, () => blocker.promise);
    const clearOp = jest.fn().mockResolvedValue(undefined);
    const clear = queue.clear(clearOp);

    generation = 1;
    blocker.resolve();
    await Promise.all([held, clear]);
    expect(clearOp).toHaveBeenCalledTimes(1);
  });

  it("orders a sign-out clear ahead of the replacement save", async () => {
    // FIFO is what makes it safe to run the clear unconditionally: the newer save lands after it.
    const order: string[] = [];
    let generation = 0;
    const queue = createPersistQueue(() => generation);

    const clear = queue.clear(async () => {
      order.push("clear");
    });
    generation = 1;
    const save = queue.save(1, async () => {
      order.push("save");
    });

    await Promise.all([clear, save]);
    expect(order).toEqual(["clear", "save"]);
  });

  it("runs a save issued by the CURRENT generation", async () => {
    let generation = 0;
    const queue = createPersistQueue(() => generation);
    generation = 1;
    const op = jest.fn().mockResolvedValue(undefined);
    await queue.save(1, op);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("keeps draining after a rejected operation", async () => {
    // A single keychain failure must not disable every later write for the life of the process.
    let generation = 0;
    const queue = createPersistQueue(() => generation);

    const failing = queue.save(0, () => Promise.reject(new Error("keychain unavailable")));
    await expect(failing).rejects.toThrow("keychain unavailable");

    const after = jest.fn().mockResolvedValue(undefined);
    await queue.save(0, after);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("propagates the failure to the caller that issued it", async () => {
    // signIn depends on this: a failed save must reject so the login screen shows a failure rather than
    // navigating into an app whose session was never written.
    let generation = 0;
    const queue = createPersistQueue(() => generation);
    await expect(queue.save(0, () => Promise.reject(new Error("write failed")))).rejects.toThrow(
      "write failed",
    );
  });
});
