import { chooseActiveOffice } from "../auth/office";

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
    // The regression case. serverOfficeId is the PRIMARY office (that is all /auth/me can report), so a
    // naive equality check returns null here and silently switches the user's office on every launch.
    expect(
      chooseActiveOffice({
        storedActiveOfficeId: SECONDARY,
        serverOfficeId: PRIMARY,
        accessibleOfficeIds: [PRIMARY, SECONDARY],
      }),
    ).toBe(SECONDARY);
  });

  it("drops a secondary office whose grant was revoked", () => {
    // Keeping it would send a stale x-office-id on every request and 403 the entire app.
    expect(
      chooseActiveOffice({
        storedActiveOfficeId: SECONDARY,
        serverOfficeId: PRIMARY,
        accessibleOfficeIds: [PRIMARY],
      }),
    ).toBeNull();
  });

  it("treats an empty grant list as definitive, not as unknown", () => {
    expect(
      chooseActiveOffice({
        storedActiveOfficeId: SECONDARY,
        serverOfficeId: PRIMARY,
        accessibleOfficeIds: [],
      }),
    ).toBeNull();
  });

  it("keeps the stored office when the grant lookup could not be made", () => {
    // null means "offline or 5xx", NOT "no offices". Reverting on a flaky connection would show another
    // office's data with nothing on screen to say why.
    expect(
      chooseActiveOffice({
        storedActiveOfficeId: SECONDARY,
        serverOfficeId: PRIMARY,
        accessibleOfficeIds: null,
      }),
    ).toBe(SECONDARY);
  });

  it("needs no lookup at all when the stored office is the one the server reports", () => {
    expect(
      chooseActiveOffice({
        storedActiveOfficeId: PRIMARY,
        serverOfficeId: PRIMARY,
        accessibleOfficeIds: null,
      }),
    ).toBe(PRIMARY);
  });

  it.each([null, undefined])("returns null when nothing was stored (%p)", (stored) => {
    expect(
      chooseActiveOffice({
        storedActiveOfficeId: (stored ?? null) as string | null,
        serverOfficeId: PRIMARY,
        accessibleOfficeIds: [PRIMARY],
      }),
    ).toBeNull();
  });
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

  it("rejects only when both the delete and the overwrite fail", async () => {
    const deleteItemAsync = jest.fn().mockRejectedValue(new Error("delete failed"));
    const setItemAsync = jest.fn().mockRejectedValue(new Error("write failed"));
    const session = withStore({ deleteItemAsync, setItemAsync });

    // Surfaces the ORIGINAL delete failure, which is the one that describes what actually went wrong.
    await expect(session.clearSession()).rejects.toThrow("delete failed");
  });
});
