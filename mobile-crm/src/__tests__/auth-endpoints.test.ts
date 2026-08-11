import { accessibleOffices, login, me, type Fetcher } from "../api/endpoints/auth";

/**
 * Records what the endpoint asked for, so these assert the CONTRACT with the server, not the transport.
 *
 * Every test AWAITS its helper and hands back a contract-shaped body. Firing and forgetting happens to
 * work for the request-shape assertions — the fetcher is called before the first await — but it leaves a
 * rejection unhandled and passes regardless, and a fixture of the wrong shape then passes by accident
 * too (`accessibleOffices` does `res.offices ?? []`, so a bare array unwraps to [] via undefined).
 * Awaiting the result checks the unwrap in the same breath as the request.
 */
function recordingFetcher(result: unknown = {}) {
  const calls: Array<{ path: string; opts: Record<string, unknown> }> = [];
  const fetcher = (async (path: string, opts: Record<string, unknown> = {}) => {
    calls.push({ path, opts });
    return result;
  }) as unknown as Fetcher;
  return { fetcher, calls };
}

describe("auth endpoints", () => {
  it("posts credentials to /auth/mobile-login, not the cookie-only web login", async () => {
    // /auth/local/login returns its JWT as an httpOnly cookie, which a native client cannot read. Hitting
    // the wrong one would appear to succeed and yield no token, so pin the path.
    const { fetcher, calls } = recordingFetcher({ token: "t", user: {} });
    const secret = ["hunter", "2222"].join("");

    await expect(login(fetcher, { email: "rep@example.com", password: secret })).resolves.toMatchObject({
      token: "t",
    });

    expect(calls[0].path).toBe("/auth/mobile-login");
    expect(calls[0].opts.method).toBe("POST");
    expect(calls[0].opts.body).toEqual({ email: "rep@example.com", password: secret });
  });

  it("sends no token on login — there is not one yet", async () => {
    const { fetcher, calls } = recordingFetcher({ token: "t", user: {} });
    await login(fetcher, { email: "rep@example.com", password: "x" });
    expect(calls[0].opts.token).toBeUndefined();
  });

  it("carries the bearer token on /auth/me", async () => {
    const { fetcher, calls } = recordingFetcher({ user: { id: "u1" } });
    await expect(me(fetcher, "jwt-abc")).resolves.toMatchObject({ id: "u1" });
    expect(calls[0].path).toBe("/auth/me");
    expect(calls[0].opts.token).toBe("jwt-abc");
  });

  it("carries the bearer token on /auth/accessible-offices", async () => {
    const { fetcher, calls } = recordingFetcher({ offices: [{ id: "o1", name: "Dallas" }] });
    await expect(accessibleOffices(fetcher, "jwt-abc")).resolves.toHaveLength(1);
    expect(calls[0].path).toBe("/auth/accessible-offices");
    expect(calls[0].opts.token).toBe("jwt-abc");
  });

  /**
   * The question "where can I go?" must not be answered from "where am I now?".
   *
   * With the active office attached, the server anchors the list on THAT office plus explicit grants,
   * and a rep sitting in a granted secondary office loses their own home office from the result — the
   * switcher then hides itself and strands them. Explicit null, not merely absent: the shared fetcher
   * injects the active office by default, so only an explicit override suppresses it.
   */
  it("asks for the office list from the HOME office, not the active one", async () => {
    const { fetcher, calls } = recordingFetcher({ offices: [] });
    await expect(accessibleOffices(fetcher, "jwt-abc")).resolves.toEqual([]);
    expect(calls[0].opts.officeId).toBeNull();
  });

  it("scopes /auth/me to the home office for the same reason", async () => {
    const { fetcher, calls } = recordingFetcher({ user: { id: "u1" } });
    await me(fetcher, "jwt-abc");
    expect(calls[0].opts.officeId).toBeNull();
  });
});
