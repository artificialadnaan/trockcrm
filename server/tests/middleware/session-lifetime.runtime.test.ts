import type { Request, Response, NextFunction } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JwtClaims } from "@trock-crm/shared/types";

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const THIRTY_DAYS_MS = THIRTY_DAYS_SECONDS * 1000;

const mocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getOfficeAccess: vi.fn(),
  getUserLocalAuthGate: vi.fn(),
}));

// Keep the REAL signJwt/verifyJwt so we exercise the actual 30-day access token; mock only the
// per-request DB lookups so we can prove invalidation still fires within the 30-day window.
vi.mock("../../src/modules/auth/service.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/modules/auth/service.js")>();
  return {
    ...actual,
    getUserById: mocks.getUserById,
    getOfficeAccess: mocks.getOfficeAccess,
  };
});

vi.mock("../../src/modules/auth/local-auth-service.js", () => ({
  getUserLocalAuthGate: mocks.getUserLocalAuthGate,
}));

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-session-lifetime";

const { signJwt, verifyJwt } = await import("../../src/modules/auth/service.js");
const { authMiddleware } = await import("../../src/middleware/auth.js");
const { getTokenCookieOptions, getCsrfCookieOptions } = await import("../../src/modules/auth/http-config.js");

function signSession(tokenVersion: number): string {
  const claims: JwtClaims = {
    userId: "user-1",
    email: "rep@example.com",
    officeId: "office-1",
    role: "rep",
    authMethod: "local",
    tokenVersion,
  };
  return signJwt(claims);
}

function createRequest(token: string): Request {
  return { cookies: { token }, headers: {}, originalUrl: "/api/deals" } as Request;
}

describe("CRM office-staff session lifetime (30 days)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOfficeAccess.mockResolvedValue({ hasAccess: false, roleOverride: null });
    mocks.getUserLocalAuthGate.mockResolvedValue({
      mustChangePassword: false,
      isEnabled: true,
      inviteExpiresAt: null,
      lockedUntil: null,
      revokedAt: null,
    });
  });

  it("(a) mints a 30-day CRM access token", () => {
    const decoded = verifyJwt(signSession(0));
    expect(decoded.exp! - decoded.iat!).toBe(THIRTY_DAYS_SECONDS);
  });

  it("(a) sets the token cookie and the matching CSRF cookie to a 30-day maxAge", () => {
    const env = { NODE_ENV: "production" } as Parameters<typeof getTokenCookieOptions>[0];
    // Both must match: a 30-day token under a 24h CSRF cookie would break mutating requests after a day.
    expect(getTokenCookieOptions(env).maxAge).toBe(THIRTY_DAYS_MS);
    expect(getCsrfCookieOptions(env).maxAge).toBe(THIRTY_DAYS_MS);
  });

  it("(b) still kills the session immediately on a token_version bump, within the 30-day window", async () => {
    const token = signSession(0); // freshly minted, cryptographically valid for 30 days
    // Prove the token really is a live 30-day token (not expired) so the rejection is from the
    // version check, not expiry.
    const decoded = verifyJwt(token);
    expect(decoded.exp! * 1000).toBeGreaterThan(Date.now() + THIRTY_DAYS_MS - 60_000);

    // DB token_version has moved ahead (deactivate/reactivate/role-change bumps it).
    mocks.getUserById.mockResolvedValue({
      id: "user-1",
      email: "rep@example.com",
      displayName: "Rep User",
      role: "rep",
      officeId: "office-1",
      isActive: true,
      tokenVersion: 1,
    });

    const next = vi.fn() as NextFunction;
    await authMiddleware(createRequest(token), {} as Response, next);

    const error = next.mock.calls[0]?.[0];
    expect(error?.statusCode).toBe(401);
    expect(error?.code).toBe("SESSION_INVALIDATED");
  });

  it("(b) still kills the session immediately on deactivation, within the 30-day window", async () => {
    const token = signSession(0);
    mocks.getUserById.mockResolvedValue({
      id: "user-1",
      email: "rep@example.com",
      displayName: "Rep User",
      role: "rep",
      officeId: "office-1",
      isActive: false,
      tokenVersion: 0,
    });

    const next = vi.fn() as NextFunction;
    await authMiddleware(createRequest(token), {} as Response, next);

    const error = next.mock.calls[0]?.[0];
    expect(error?.statusCode).toBe(401);
    expect(error?.code).toBe("SESSION_INVALIDATED");
  });
});
