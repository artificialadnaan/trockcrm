import type { Request, Response, NextFunction } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyJwt: vi.fn(),
  getUserById: vi.fn(),
  getOfficeAccess: vi.fn(),
  getUserLocalAuthGate: vi.fn(),
}));

vi.mock("../../src/modules/auth/service.js", () => ({
  verifyJwt: mocks.verifyJwt,
  getUserById: mocks.getUserById,
  getOfficeAccess: mocks.getOfficeAccess,
}));

vi.mock("../../src/modules/auth/local-auth-service.js", () => ({
  getUserLocalAuthGate: mocks.getUserLocalAuthGate,
}));

const { authMiddleware } = await import("../../src/middleware/auth.js");

function createRequest(overrides: Partial<Request> = {}) {
  return {
    cookies: { token: "jwt-token" },
    headers: {},
    originalUrl: "/api/deals",
    ...overrides,
  } as Request;
}

function createResponse() {
  return {} as Response;
}

describe("authMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyJwt.mockReturnValue({ userId: "user-1", authMethod: "local" });
    mocks.getUserById.mockResolvedValue({
      id: "user-1",
      email: "rep@example.com",
      displayName: "Rep User",
      role: "rep",
      officeId: "office-1",
      isActive: true,
    });
    mocks.getOfficeAccess.mockResolvedValue({ hasAccess: false, roleOverride: null });
    mocks.getUserLocalAuthGate.mockResolvedValue({
      mustChangePassword: false,
      isEnabled: true,
      inviteExpiresAt: null,
      lockedUntil: null,
      revokedAt: null,
    });
  });

  it("rejects legacy sessions that do not include authMethod", async () => {
    mocks.verifyJwt.mockReturnValue({ userId: "user-1" });
    const req = createRequest();
    const next = vi.fn() as NextFunction;

    await authMiddleware(req, createResponse(), next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0]?.[0];
    expect(error?.statusCode).toBe(401);
    expect(error?.message).toBe("Session expired, please sign in again");
  });

  it("rejects revoked local-auth sessions", async () => {
    mocks.getUserLocalAuthGate.mockResolvedValue({
      mustChangePassword: false,
      isEnabled: true,
      inviteExpiresAt: null,
      lockedUntil: null,
      revokedAt: "2026-04-20T10:00:00.000Z",
    });
    const req = createRequest();
    const next = vi.fn() as NextFunction;

    await authMiddleware(req, createResponse(), next);

    const error = next.mock.calls[0]?.[0];
    expect(error?.statusCode).toBe(401);
    expect(error?.message).toBe("Local login is no longer enabled for this user");
  });

  it("allows valid local sessions and attaches authMethod to req.user", async () => {
    const req = createRequest();
    const next = vi.fn() as NextFunction;

    await authMiddleware(req, createResponse(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toMatchObject({
      id: "user-1",
      email: "rep@example.com",
      authMethod: "local",
      mustChangePassword: false,
    });
  });

  it("rejects field-audience tokens (surface:'field') on CRM routes, regardless of role", async () => {
    // Same CRM-capable user (role 'rep' from beforeEach) but the token is field-stamped.
    mocks.verifyJwt.mockReturnValue({ userId: "user-1", authMethod: "local", surface: "field" });
    const req = createRequest();
    const next = vi.fn() as NextFunction;

    await authMiddleware(req, createResponse(), next);

    const error = next.mock.calls[0]?.[0];
    expect(error?.statusCode).toBe(401);
    expect(error?.message).toBe("This session is not valid for CRM access");
    // Rejected by the audience guard BEFORE any user/role/office lookup — so no role can make it work,
    // and a promoted field user's existing token still can't reach CRM.
    expect(mocks.getUserById).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  // The surface matrix. Adding surface:"mobile" (the native CRM app, /api/auth/mobile-login) required NO
  // change to this middleware, because the guard is a field-only denylist. These cases pin that: the two
  // accepted audiences must keep working and the rejected one must stay rejected, so a future edit to the
  // guard cannot quietly sever the web CRM or quietly admit a field token.
  it("accepts a surface-less token — exactly what the WEB CRM login mints today", async () => {
    // /api/auth/local/login signs { userId, email, officeId, role, tokenVersion, authMethod } with no
    // surface claim at all. If this ever fails, every web CRM user is logged out.
    mocks.verifyJwt.mockReturnValue({ userId: "user-1", authMethod: "local" });
    const req = createRequest();
    const next = vi.fn() as NextFunction;

    await authMiddleware(req, createResponse(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toMatchObject({ id: "user-1", role: "rep" });
  });

  it("accepts surface:'mobile' tokens (the native CRM app) on CRM routes", async () => {
    mocks.verifyJwt.mockReturnValue({ userId: "user-1", authMethod: "local", surface: "mobile" });
    const req = createRequest();
    const next = vi.fn() as NextFunction;

    await authMiddleware(req, createResponse(), next);

    expect(next).toHaveBeenCalledWith();
    // A mobile token resolves to the same user with the same effective role as the web token above —
    // "mobile" is a provenance label, not a reduced-privilege session.
    expect(req.user).toMatchObject({ id: "user-1", role: "rep" });
  });
});
