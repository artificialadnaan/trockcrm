import { accessibleOffices, me, type Fetcher } from "../api/endpoints/auth";

/**
 * The CRM auth routes do NOT use a uniform envelope, and getting that wrong is silent rather than loud:
 *   POST /auth/mobile-login  -> { token, user }        (top level)
 *   GET  /auth/me            -> { user, csrfToken? }   (wrapped)
 *   GET  /auth/accessible-offices -> { offices }       (wrapped)
 *
 * Typing /auth/me's response as a bare user made `fresh.role` undefined, which failed the role check on
 * every cold start and DELETED a perfectly valid session. TypeScript could not catch it — the type was a
 * hand-written mirror asserting a shape the server never sends. These tests are the check instead.
 */
function fetcherReturning(payload: unknown) {
  const calls: Array<{ path: string; opts: Record<string, unknown> }> = [];
  const fetcher = (async (path: string, opts: Record<string, unknown> = {}) => {
    calls.push({ path, opts });
    return payload;
  }) as unknown as Fetcher;
  return { fetcher, calls };
}

describe("/auth/me envelope", () => {
  it("unwraps { user } rather than returning the envelope", async () => {
    const { fetcher } = fetcherReturning({
      user: { id: "u1", email: "rep@example.com", role: "rep", officeId: "o1", displayName: "Rep" },
      csrfToken: "irrelevant-to-a-bearer-client",
    });

    const user = await me(fetcher, "jwt");

    // The bug this pins: returning the envelope leaves `role` undefined, the caller's role check fails,
    // and the session is destroyed on launch.
    expect(user.role).toBe("rep");
    expect(user.id).toBe("u1");
    expect(user).not.toHaveProperty("csrfToken");
  });

  it("sends no x-office-id, so a stale office cannot block the call that would fix it", async () => {
    // The stored session's office may be revoked or moved. authMiddleware rejects a stale x-office-id
    // with a 403 — which would block the very request whose job is to report the current office.
    const { fetcher, calls } = fetcherReturning({ user: { id: "u1", role: "rep" } });

    await me(fetcher, "jwt");

    expect(calls[0].opts.officeId).toBeNull();
    expect(calls[0].opts.token).toBe("jwt");
  });
});

describe("/auth/accessible-offices envelope", () => {
  it("unwraps { offices } to an array", async () => {
    const { fetcher } = fetcherReturning({ offices: [{ id: "o1", name: "Dallas" }] });

    const offices = await accessibleOffices(fetcher, "jwt");

    expect(Array.isArray(offices)).toBe(true);
    expect(offices[0].name).toBe("Dallas");
  });

  it("returns an empty array when the key is absent rather than undefined", async () => {
    // A caller doing .map() on undefined crashes the screen; an empty list renders an empty state.
    const { fetcher } = fetcherReturning({});

    await expect(accessibleOffices(fetcher, "jwt")).resolves.toEqual([]);
  });
});
