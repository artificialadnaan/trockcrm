import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
const staleAuthCookies = ["token=existing-session", "csrf_token=server-token"];

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
    process.env.NODE_ENV = "test";
    process.env.DEV_MODE = "true";
    process.env.FIELD_APP_URL = origin;

    authServiceMocks.signJwt.mockReturnValue("next-session");
    authServiceMocks.getUserByEmail.mockResolvedValue(crmUser);
    authServiceMocks.ensureDevUserPrimaryOffice.mockResolvedValue(crmUser);
    localAuthServiceMocks.loginWithLocalPassword.mockResolvedValue({ user: crmUser });
    fieldUserServiceMocks.acceptFieldInvite.mockResolvedValue({ user: fieldUser, token: "field-session" });
    fieldUserServiceMocks.loginFieldUser.mockResolvedValue({ user: fieldUser, token: "field-session" });
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
