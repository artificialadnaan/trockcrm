import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authServiceMocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUserOnboardingGateStatus: vi.fn(),
  signJwt: vi.fn(),
  verifyJwt: vi.fn(),
}));

const localAuthServiceMocks = vi.hoisted(() => ({
  loginWithLocalPassword: vi.fn(),
  changeLocalPassword: vi.fn(),
  getUserLocalAuthGate: vi.fn(),
}));

vi.mock("../src/modules/auth/service.js", async () => {
  const actual = await vi.importActual<typeof import("../src/modules/auth/service.js")>(
    "../src/modules/auth/service.js"
  );

  return {
    ...actual,
    getUserById: authServiceMocks.getUserById,
    getUserOnboardingGateStatus: authServiceMocks.getUserOnboardingGateStatus,
    signJwt: authServiceMocks.signJwt,
    verifyJwt: authServiceMocks.verifyJwt,
  };
});

vi.mock("../src/modules/auth/local-auth-service.js", async () => {
  const actual = await vi.importActual<typeof import("../src/modules/auth/local-auth-service.js")>(
    "../src/modules/auth/local-auth-service.js"
  );

  return {
    ...actual,
    loginWithLocalPassword: localAuthServiceMocks.loginWithLocalPassword,
    changeLocalPassword: localAuthServiceMocks.changeLocalPassword,
    getUserLocalAuthGate: localAuthServiceMocks.getUserLocalAuthGate,
  };
});

const { createApp } = await import("../src/app.js");
const fallbackApiHost = ["api-production-ad218", "up.railway.app"].join(".");
const tempSecret = "TempPassword123!";
const nextSecret = "NewPassword123!";

const crmUser = {
  id: "crm-user-1",
  email: "crm@example.com",
  displayName: "CRM User",
  role: "rep" as const,
  officeId: "office-1",
  activeOfficeId: "office-1",
  mustChangePassword: true,
  isActive: true,
};

function cookieHeaderFromSetCookie(setCookie: string[]) {
  // Model a browser cookie jar: apply each Set-Cookie in order; a later same-name entry overwrites, and
  // an empty value (a Max-Age=0 clear) removes it. Production login now emits legacy token= clears before
  // the real token=, so a naive flatten would keep the empty first duplicate (cookie-parser keeps first).
  const jar = new Map<string, string>();
  for (const entry of setCookie) {
    const pair = entry.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "") jar.delete(name);
    else jar.set(name, value);
  }
  return Array.from(jar, ([name, value]) => `${name}=${value}`).join("; ");
}

const ENV_KEYS = [
  "NODE_ENV",
  "AUTH_COOKIE_DOMAIN",
  "CORS_ALLOWED_ORIGINS",
  "STRICT_CROSS_SITE_AUTH_ORIGINS",
  "FIELD_APP_URL",
] as const;
let previousEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

describe("password-change auth cookies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.NODE_ENV = "production";
    process.env.AUTH_COOKIE_DOMAIN = ".trockcrm.com";
    process.env.CORS_ALLOWED_ORIGINS = "https://frontend-production-bcab.up.railway.app";
    process.env.STRICT_CROSS_SITE_AUTH_ORIGINS = "https://frontend-production-bcab.up.railway.app";
    process.env.FIELD_APP_URL = "https://trockcrm-field-production.up.railway.app";

    authServiceMocks.signJwt.mockReturnValue("next-session");
    authServiceMocks.verifyJwt.mockReturnValue({
      userId: crmUser.id,
      email: crmUser.email,
      officeId: crmUser.officeId,
      role: crmUser.role,
      authMethod: "local",
    });
    authServiceMocks.getUserById.mockResolvedValue(crmUser);
    authServiceMocks.getUserOnboardingGateStatus.mockResolvedValue({
      onboardingCompletedAt: null,
      onboardingPendingCount: 0,
      requiresOnboarding: false,
      cleanupUrl: "https://onboarding.trockcrm.com",
    });
    localAuthServiceMocks.loginWithLocalPassword.mockResolvedValue({
      user: { ...crmUser, mustChangePassword: true },
    });
    localAuthServiceMocks.changeLocalPassword.mockResolvedValue(undefined);
    localAuthServiceMocks.getUserLocalAuthGate.mockResolvedValue({
      mustChangePassword: false,
      isEnabled: true,
      inviteExpiresAt: null,
      lockedUntil: null,
      revokedAt: null,
    });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("supports cross-origin fallback login, password change, and me without dropping CSRF protection", async () => {
    const app = createApp();
    const fallbackOrigin = "https://frontend-production-bcab.up.railway.app";

    const login = await request(app)
      .post("/api/auth/local/login")
      .set("Origin", fallbackOrigin)
      .set("Host", fallbackApiHost)
      .send({ email: "crm@example.com", password: tempSecret });

    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);
    expect(login.body.csrfToken).toEqual(expect.any(String));
    const loginCookies = login.headers["set-cookie"] ?? [];
    expect(loginCookies.some((cookie: string) => /^token=/.test(cookie))).toBe(true);
    expect(loginCookies.some((cookie: string) => /^csrf_token=/.test(cookie))).toBe(true);
    expect(loginCookies.join("\n")).not.toContain("Domain=.trockcrm.com");
    expect(loginCookies.join("\n")).toContain("SameSite=None");
    const cookieHeader = cookieHeaderFromSetCookie(loginCookies);

    const passwordChange = await request(app)
      .post("/api/auth/local/change-password")
      .set("Origin", fallbackOrigin)
      .set("Host", fallbackApiHost)
      .set("Cookie", cookieHeader)
      .set("X-CSRF-Token", login.body.csrfToken)
      .send({
        currentPassword: tempSecret,
        newPassword: nextSecret,
      });

    expect(passwordChange.status).toBe(200);
    expect(localAuthServiceMocks.changeLocalPassword).toHaveBeenCalledWith({
      userId: crmUser.id,
      currentPassword: tempSecret,
      newPassword: nextSecret,
    });
    expect(passwordChange.body.user.mustChangePassword).toBe(false);
    expect(passwordChange.body.csrfToken).toEqual(login.body.csrfToken);

    const me = await request(app)
      .get("/api/auth/me")
      .set("Origin", fallbackOrigin)
      .set("Host", fallbackApiHost)
      .set("Cookie", cookieHeader);

    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("crm@example.com");
    expect(me.body.csrfToken).toEqual(login.body.csrfToken);
  });

  it("refreshes the CSRF cookie to the session lifetime on login, even when the browser already holds one", async () => {
    const app = createApp();
    const fallbackOrigin = "https://frontend-production-bcab.up.railway.app";

    // A returning browser carries a CSRF cookie from before the 30-day-session deploy. The global CSRF
    // middleware only writes csrf_token when it is ABSENT, so without an explicit refresh at login the
    // new 30-day auth cookie would pair with this older, shorter-lived CSRF cookie — which then lapses
    // mid-session and 403s the next unsafe request while the auth session is still valid.
    const login = await request(app)
      .post("/api/auth/local/login")
      .set("Origin", fallbackOrigin)
      .set("Host", fallbackApiHost)
      .set("Cookie", "csrf_token=carried-over-token")
      .send({ email: "crm@example.com", password: tempSecret });

    expect(login.status).toBe(200);
    const loginCookies: string[] = login.headers["set-cookie"] ?? [];
    const csrfSetCookie = loginCookies.find((cookie) => /^csrf_token=/.test(cookie));
    // Login must (re)issue the CSRF cookie so its expiry tracks the 30-day auth cookie.
    expect(csrfSetCookie).toBeDefined();
    expect(csrfSetCookie).toMatch(/Max-Age=2592000\b/);
    // Its value stays the one the double-submit pair already settled (no mid-flight mismatch).
    expect(csrfSetCookie).toContain("csrf_token=carried-over-token");
    // And it matches the token cookie's 30-day lifetime.
    const tokenSetCookie = loginCookies.find((cookie) => /^token=[^;]/.test(cookie));
    expect(tokenSetCookie).toMatch(/Max-Age=2592000\b/);
  });

  it("does not expose response-body CSRF tokens on canonical same-origin auth responses", async () => {
    const app = createApp();

    const login = await request(app)
      .post("/api/auth/local/login")
      .set("Origin", "https://trockcrm.com")
      .set("Host", "trockcrm.com")
      .send({ email: "crm@example.com", password: tempSecret });

    expect(login.status).toBe(200);
    expect(login.body.csrfToken).toBeUndefined();
    const cookieHeader = cookieHeaderFromSetCookie(login.headers["set-cookie"] ?? []);

    const me = await request(app)
      .get("/api/auth/me")
      .set("Origin", "https://trockcrm.com")
      .set("Host", "trockcrm.com")
      .set("Cookie", cookieHeader);

    expect(me.status).toBe(200);
    expect(me.body.csrfToken).toBeUndefined();
  });

  it("does not expose response-body CSRF tokens to localhost origins in production", async () => {
    const app = createApp();

    const login = await request(app)
      .post("/api/auth/local/login")
      .set("Origin", "https://frontend-production-bcab.up.railway.app")
      .set("Host", fallbackApiHost)
      .send({ email: "crm@example.com", password: tempSecret });

    expect(login.status).toBe(200);
    const cookieHeader = cookieHeaderFromSetCookie(login.headers["set-cookie"] ?? []);

    const me = await request(app)
      .get("/api/auth/me")
      .set("Origin", "http://localhost:5173")
      .set("Host", fallbackApiHost)
      .set("Cookie", cookieHeader);

    expect(me.status).toBe(200);
    expect(me.body.csrfToken).toBeUndefined();
  });

  it("rejects a simulated localhost state-changing attack against production", async () => {
    const app = createApp();

    const login = await request(app)
      .post("/api/auth/local/login")
      .set("Origin", "https://frontend-production-bcab.up.railway.app")
      .set("Host", fallbackApiHost)
      .send({ email: "crm@example.com", password: tempSecret });

    expect(login.status).toBe(200);
    const cookieHeader = cookieHeaderFromSetCookie(login.headers["set-cookie"] ?? []);

    const attack = await request(app)
      .post("/api/auth/local/change-password")
      .set("Origin", "http://localhost:5173")
      .set("Host", fallbackApiHost)
      .set("Cookie", cookieHeader)
      .set("X-CSRF-Token", login.body.csrfToken)
      .send({
        currentPassword: tempSecret,
        newPassword: nextSecret,
      });

    expect(attack.status).toBe(403);
    expect(attack.body).toEqual({ error: { message: "Forbidden origin" } });
    expect(localAuthServiceMocks.changeLocalPassword).not.toHaveBeenCalled();
  });

  it("still rejects password changes that omit the CSRF header", async () => {
    const response = await request(createApp())
      .post("/api/auth/local/change-password")
      .set("Origin", "https://frontend-production-bcab.up.railway.app")
      .set("Host", fallbackApiHost)
      .set("Cookie", ["token=next-session", "csrf_token=server-token"])
      .send({
        currentPassword: tempSecret,
        newPassword: nextSecret,
      });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "Invalid CSRF token" } });
    expect(localAuthServiceMocks.changeLocalPassword).not.toHaveBeenCalled();
  });
});
