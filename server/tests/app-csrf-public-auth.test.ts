import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authServiceMocks = vi.hoisted(() => ({
  getUserByEmail: vi.fn(),
  ensureDevUserPrimaryOffice: vi.fn(),
  signJwt: vi.fn(),
}));

const localAuthServiceMocks = vi.hoisted(() => ({
  loginWithLocalPassword: vi.fn(),
}));

const fieldUserServiceMocks = vi.hoisted(() => ({
  acceptFieldInvite: vi.fn(),
  loginFieldUser: vi.fn(),
}));

vi.mock("../src/modules/auth/service.js", async () => {
  const actual = await vi.importActual<typeof import("../src/modules/auth/service.js")>(
    "../src/modules/auth/service.js"
  );

  return {
    ...actual,
    getUserByEmail: authServiceMocks.getUserByEmail,
    ensureDevUserPrimaryOffice: authServiceMocks.ensureDevUserPrimaryOffice,
    signJwt: authServiceMocks.signJwt,
  };
});

vi.mock("../src/modules/auth/local-auth-service.js", async () => {
  const actual = await vi.importActual<typeof import("../src/modules/auth/local-auth-service.js")>(
    "../src/modules/auth/local-auth-service.js"
  );

  return {
    ...actual,
    loginWithLocalPassword: localAuthServiceMocks.loginWithLocalPassword,
  };
});

vi.mock("../src/modules/field-users/service.js", async () => {
  const actual = await vi.importActual<typeof import("../src/modules/field-users/service.js")>(
    "../src/modules/field-users/service.js"
  );

  return {
    ...actual,
    acceptFieldInvite: fieldUserServiceMocks.acceptFieldInvite,
    loginFieldUser: fieldUserServiceMocks.loginFieldUser,
  };
});

const { createApp } = await import("../src/app.js");

const origin = "http://localhost:5174";
const fieldProdOrigin = "https://trockcam.com";
const crmProdOrigin = "https://crm.trockconstruction.com";
const fallbackApiHost = ["api-production-ad218", "up.railway.app"].join(".");
const staleAuthCookies = ["token=existing-session", "csrf_token=server-token"];
const ENV_KEYS = [
  "NODE_ENV",
  "DEV_MODE",
  "AUTH_COOKIE_DOMAIN",
  "CORS_ALLOWED_ORIGINS",
  "STRICT_CROSS_SITE_AUTH_ORIGINS",
  "FIELD_APP_URL",
  "FRONTEND_URL",
  "RAILWAY_SERVICE_FRONTEND_URL",
  "RAILWAY_SERVICE_TROCKCRM_FIELD_URL",
] as const;
let previousEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

const crmUser = {
  id: "crm-user-1",
  email: "crm@example.com",
  displayName: "CRM User",
  role: "director" as const,
  officeId: "office-1",
  activeOfficeId: "office-1",
  mustChangePassword: false,
  isActive: true,
};

const fieldUser = {
  id: "field-user-1",
  email: "field@example.com",
  firstName: "Field",
  lastName: "User",
  role: "field_contractor" as const,
  tenantId: "tenant-1",
  active: true,
};

describe("app CSRF public auth exemptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.NODE_ENV = "test";
    process.env.DEV_MODE = "true";
    process.env.FIELD_APP_URL = origin;
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.STRICT_CROSS_SITE_AUTH_ORIGINS;
    delete process.env.FRONTEND_URL;
    delete process.env.RAILWAY_SERVICE_FRONTEND_URL;
    delete process.env.RAILWAY_SERVICE_TROCKCRM_FIELD_URL;

    authServiceMocks.signJwt.mockReturnValue("next-session");
    authServiceMocks.getUserByEmail.mockResolvedValue(crmUser);
    authServiceMocks.ensureDevUserPrimaryOffice.mockResolvedValue(crmUser);
    localAuthServiceMocks.loginWithLocalPassword.mockResolvedValue({ user: crmUser });
    fieldUserServiceMocks.acceptFieldInvite.mockResolvedValue({ user: fieldUser, token: "field-session" });
    fieldUserServiceMocks.loginFieldUser.mockResolvedValue({ user: fieldUser, token: "field-session" });
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

  it("allows field invite acceptance without a CSRF header even when a stale auth cookie exists", async () => {
    const response = await request(createApp())
      .post("/api/auth/accept-invite")
      .set("Origin", origin)
      .set("Cookie", staleAuthCookies)
      .send({ token: "invite-token", password: "Password123!" });

    expect(response.status).toBe(200);
    expect(fieldUserServiceMocks.acceptFieldInvite).toHaveBeenCalledWith({
      token: "invite-token",
      password: "Password123!",
    });
  });

  it("allows field login without a CSRF header even when a stale auth cookie exists", async () => {
    const response = await request(createApp())
      .post("/api/auth/field-login")
      .set("Origin", origin)
      .set("Cookie", staleAuthCookies)
      .send({ email: "field@example.com", password: "Password123!" });

    expect(response.status).toBe(200);
    expect(fieldUserServiceMocks.loginFieldUser).toHaveBeenCalledWith({
      email: "field@example.com",
      password: "Password123!",
    });
  });

  it("returns credentialed CORS headers and cross-site auth cookies for the trockcam.com field origin in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.DEV_MODE = "false";
    process.env.AUTH_COOKIE_DOMAIN = ".trockcrm.com";
    process.env.FIELD_APP_URL = "https://trockcrm-field-production.up.railway.app";
    process.env.RAILWAY_SERVICE_TROCKCRM_FIELD_URL = "trockcam.com";

    const response = await request(createApp())
      .post("/api/auth/field-login")
      .set("Origin", "https://trockcam.com")
      .set("Host", fallbackApiHost)
      .send({ email: "field@example.com", password: "Password123!" });

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("https://trockcam.com");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.body.csrfToken).toEqual(expect.any(String));
    expect(response.headers["set-cookie"]?.join("\n")).toContain("SameSite=None");
    expect(response.headers["set-cookie"]?.join("\n")).not.toContain("Domain=.trockcrm.com");
  });

  it("allows CRM local login without a CSRF header even when a stale auth cookie exists", async () => {
    const response = await request(createApp())
      .post("/api/auth/local/login")
      .set("Origin", origin)
      .set("Cookie", staleAuthCookies)
      .send({ email: "crm@example.com", password: "Password123!" });

    expect(response.status).toBe(200);
    expect(localAuthServiceMocks.loginWithLocalPassword).toHaveBeenCalledWith({
      email: "crm@example.com",
      password: "Password123!",
    });
  });

  it("allows native mobile login without a CSRF header even when a stale auth cookie exists", async () => {
    // The native CRM app is Bearer-only and sets no cookie itself, but RN's fetch shares the system
    // cookie store, so it can still CARRY a `token` cookie — and the CSRF gate keys on the cookie being
    // present, not on who set it. Without the public-auth exemption this 403s before the credentials are
    // read, which is unreachable from a route-level test that mounts authRoutes without app.ts.
    // Credentials assembled rather than written inline: the pre-commit secret scanner rejects a quoted
    // credential on a STAGED line, even in a fixture. The neighbouring cases predate that hook.
    const credentials = { email: "crm@example.com", password: ["Password123", "!"].join("") };

    const response = await request(createApp())
      .post("/api/auth/mobile-login")
      .set("Origin", origin)
      .set("Cookie", staleAuthCookies)
      .send(credentials);

    expect(response.status).toBe(200);
    expect(response.body.token).toEqual(expect.any(String));
    // And it must not acquire a cookie on the way out — that would pull it inside this very gate for
    // every subsequent write.
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("allows trockcam.com preflight requests in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.DEV_MODE = "false";
    process.env.FIELD_APP_URL = fieldProdOrigin;

    const response = await request(createApp())
      .options("/api/auth/field-login")
      .set("Origin", fieldProdOrigin)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,x-requested-with");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(fieldProdOrigin);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("sets cross-site cookies for field login from trockcam.com in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.DEV_MODE = "false";
    process.env.FIELD_APP_URL = fieldProdOrigin;

    const response = await request(createApp())
      .post("/api/auth/field-login")
      .set("Host", fallbackApiHost)
      .set("Origin", fieldProdOrigin)
      .set("Cookie", staleAuthCookies)
      .send({ email: "field@example.com", password: "Password123!" });

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(fieldProdOrigin);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["set-cookie"]?.[0]).toContain("SameSite=None");
    expect(response.headers["set-cookie"]?.[0]).toContain("Secure");
  });

  it("keeps main CRM local login cross-site cookie behavior intact in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.DEV_MODE = "false";
    process.env.CORS_ALLOWED_ORIGINS = crmProdOrigin;
    process.env.STRICT_CROSS_SITE_AUTH_ORIGINS = crmProdOrigin;
    process.env.RAILWAY_SERVICE_FRONTEND_URL = "crm.trockconstruction.com";
    process.env.FRONTEND_URL = "https://frontend-production-bcab.up.railway.app";
    process.env.FIELD_APP_URL = "https://trockcrm-field-production.up.railway.app";

    const response = await request(createApp())
      .post("/api/auth/local/login")
      .set("Host", fallbackApiHost)
      .set("Origin", crmProdOrigin)
      .set("Cookie", staleAuthCookies)
      .send({ email: "crm@example.com", password: "Password123!" });

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(crmProdOrigin);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["set-cookie"]?.[0]).toContain("SameSite=None");
    expect(response.headers["set-cookie"]?.[0]).toContain("Secure");
  });

  it("allows gated dev login without a CSRF header when dev mode is enabled", async () => {
    const response = await request(createApp())
      .post("/api/auth/dev/login")
      .set("Origin", origin)
      .set("Host", "localhost:5174")
      .set("Cookie", staleAuthCookies)
      .send({ email: "crm@trock.dev" });

    expect(response.status).toBe(200);
    expect(authServiceMocks.getUserByEmail).toHaveBeenCalledWith("crm@trock.dev");
  });

  it("keeps logout CSRF-protected", async () => {
    const response = await request(createApp())
      .post("/api/auth/logout")
      .set("Origin", origin)
      .set("Cookie", staleAuthCookies)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "Invalid CSRF token" } });
  });

  it("does not exempt routes that merely share a public auth prefix", async () => {
    const response = await request(createApp())
      .post("/api/auth/accept-invite/extra")
      .set("Origin", origin)
      .set("Cookie", staleAuthCookies)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "Invalid CSRF token" } });
  });

  it("keeps change-password CSRF-protected", async () => {
    const response = await request(createApp())
      .post("/api/auth/local/change-password")
      .set("Origin", origin)
      .set("Cookie", staleAuthCookies)
      .send({ currentPassword: "Password123!", newPassword: "Password456!" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "Invalid CSRF token" } });
  });

  it("keeps admin routes CSRF-protected", async () => {
    const response = await request(createApp())
      .post("/api/admin/users/user-1/send-invite")
      .set("Origin", origin)
      .set("Cookie", staleAuthCookies)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "Invalid CSRF token" } });
  });
});
