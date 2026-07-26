import { accessibleOffices, login, me, type Fetcher } from "../api/endpoints/auth";

/** Records what the endpoint asked for, so these assert the CONTRACT with the server, not the transport. */
function recordingFetcher(result: unknown = {}) {
  const calls: Array<{ path: string; opts: Record<string, unknown> }> = [];
  const fetcher = (async (path: string, opts: Record<string, unknown> = {}) => {
    calls.push({ path, opts });
    return result;
  }) as unknown as Fetcher;
  return { fetcher, calls };
}

describe("auth endpoints", () => {
  it("posts credentials to /auth/mobile-login, not the cookie-only web login", () => {
    // /auth/local/login returns its JWT as an httpOnly cookie, which a native client cannot read. Hitting
    // the wrong one would appear to succeed and yield no token, so pin the path.
    const { fetcher, calls } = recordingFetcher({ token: "t", user: {} });
    const secret = ["hunter", "2222"].join("");

    void login(fetcher, { email: "rep@example.com", password: secret });

    expect(calls[0].path).toBe("/auth/mobile-login");
    expect(calls[0].opts.method).toBe("POST");
    expect(calls[0].opts.body).toEqual({ email: "rep@example.com", password: secret });
  });

  it("sends no token on login — there is not one yet", () => {
    const { fetcher, calls } = recordingFetcher({ token: "t", user: {} });
    void login(fetcher, { email: "rep@example.com", password: "x" });
    expect(calls[0].opts.token).toBeUndefined();
  });

  it("carries the bearer token on /auth/me", () => {
    const { fetcher, calls } = recordingFetcher({ id: "u1" });
    void me(fetcher, "jwt-abc");
    expect(calls[0].path).toBe("/auth/me");
    expect(calls[0].opts.token).toBe("jwt-abc");
  });

  it("carries the bearer token on /auth/accessible-offices", () => {
    const { fetcher, calls } = recordingFetcher([]);
    void accessibleOffices(fetcher, "jwt-abc");
    expect(calls[0].path).toBe("/auth/accessible-offices");
    expect(calls[0].opts.token).toBe("jwt-abc");
  });
});
