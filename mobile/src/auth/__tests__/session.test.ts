import { isTokenExpired, loadSession, saveSession, clearSession, type Session } from "../session";

// In-memory expo-secure-store (store lives inside the factory to dodge jest.mock hoisting).
jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>();
  return {
    setItemAsync: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    deleteItemAsync: jest.fn(async (k: string) => {
      store.delete(k);
    }),
  };
});

function jwtWithExp(exp: number | undefined): string {
  const payload = exp === undefined ? {} : { exp };
  const b64url = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `headerpart.${b64url}.sigpart`;
}

function session(token: string): Session {
  return {
    token,
    user: { id: "u1", email: "f@x.com", tenantId: "t1", role: "field_contractor" } as unknown as Session["user"],
    activeOfficeId: null,
  };
}

describe("isTokenExpired", () => {
  const NOW = 1_700_000_000_000;

  it("is true when exp is in the past", () => {
    expect(isTokenExpired(jwtWithExp(Math.floor(NOW / 1000) - 60), NOW)).toBe(true);
  });

  it("is false when exp is in the future", () => {
    expect(isTokenExpired(jwtWithExp(Math.floor(NOW / 1000) + 60), NOW)).toBe(false);
  });

  it("is false (optimistic) for a malformed token, non-base64 payload, or missing exp", () => {
    expect(isTokenExpired("not-a-jwt", NOW)).toBe(false); // not 3 parts
    expect(isTokenExpired("a.b.c", NOW)).toBe(false); // payload isn't valid JSON
    expect(isTokenExpired(jwtWithExp(undefined), NOW)).toBe(false); // no exp claim
  });
});

describe("loadSession expiry pre-check", () => {
  beforeEach(async () => {
    await clearSession();
  });

  it("drops + clears an already-expired stored token (route to login, no app flash)", async () => {
    await saveSession(session(jwtWithExp(Math.floor(Date.now() / 1000) - 60)));
    expect(await loadSession()).toBeNull();
    expect(await loadSession()).toBeNull(); // it was cleared, not just hidden
  });

  it("returns the session for a non-expired token", async () => {
    const token = jwtWithExp(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60); // ~30d out
    await saveSession(session(token));
    const loaded = await loadSession();
    expect(loaded?.token).toBe(token);
    expect(loaded?.user.id).toBe("u1");
  });
});
