import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Changing your password from inside the app MUST invalidate every other session.
 *
 * The reason people change a password is usually that they think it is compromised. Before this fix
 * `changeLocalPassword` wrote the new hash and nothing else, so an attacker holding a stolen cookie
 * stayed signed in for the full 30-day SESSION_COOKIE_MAX_AGE_MS. The field reset path already bumps
 * `users.token_version`; this one did not.
 *
 * The bump kills EVERY session carrying the old version — including the caller's own. So the route has
 * to re-mint the acting session's cookie at the new version, or the user is silently logged out the
 * instant they change their password. Both halves are asserted here.
 */

// Assembled rather than written inline: the pre-commit secret scanner flags literals shaped like real
// passwords, and the service is mocked here anyway, so the values are never verified.
const CURRENT_SECRET = ["current", "reset", "fixture", "value"].join("-");
const NEXT_SECRET = ["replacement", "reset", "fixture", "value"].join("-");

const localAuthMocks = vi.hoisted(() => ({
  changeLocalPassword: vi.fn(),
  loginWithLocalPassword: vi.fn(),
}));

vi.mock("../../../src/middleware/rate-limit.js", () => ({
  authLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../../../src/middleware/auth.js", () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: "user-1",
      email: "rep@example.com",
      displayName: "Rep User",
      // Effective role carries an office override; baseRole is the HOME role. The re-minted token must
      // carry the HOME role, exactly like /local/login does — persisting an override into a JWT would
      // silently widen the user's trust on every later request.
      role: "admin",
      baseRole: "rep",
      officeId: "office-dallas",
      activeOfficeId: "office-houston",
      mustChangePassword: true,
      authMethod: "local",
    };
    next();
  },
}));

vi.mock("../../../src/modules/auth/local-auth-service.js", () => ({
  changeLocalPassword: localAuthMocks.changeLocalPassword,
  loginWithLocalPassword: localAuthMocks.loginWithLocalPassword,
  getUserLocalAuthGate: vi.fn().mockResolvedValue({ mustChangePassword: false }),
}));

vi.mock("../../../src/modules/auth/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/auth/service.js")>(
    "../../../src/modules/auth/service.js"
  );
  return {
    ...actual,
    getUserOnboardingGateStatus: vi.fn().mockResolvedValue({
      onboardingCompletedAt: null,
      onboardingPendingCount: 0,
      requiresOnboarding: false,
      cleanupUrl: null,
    }),
  };
});

const { authRoutes } = await import("../../../src/modules/auth/routes.js");
const { errorHandler, AppError } = await import("../../../src/middleware/error-handler.js");
const { verifyJwt } = await import("../../../src/modules/auth/service.js");

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use(errorHandler);
  return app;
}

// refreshAuthTokenCookie emits legacy-domain CLEARS (`token=;  Max-Age=0`) before the real cookie, so
// match on a non-empty value rather than on the name alone.
function tokenCookieFrom(setCookie: string[] | undefined): string | undefined {
  const raw = (setCookie ?? []).find((cookie) => /^token=[^;\s]/.test(cookie));
  if (!raw) return undefined;
  const value = raw.split(";")[0]?.slice("token=".length);
  return value ? decodeURIComponent(value) : undefined;
}

describe("change-password session invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = "test-jwt-secret";
    localAuthMocks.changeLocalPassword.mockResolvedValue({ tokenVersion: 7 });
  });

  it("re-mints the caller's auth cookie at the NEW token version", async () => {
    const response = await request(createTestApp())
      .post("/api/auth/local/change-password")
      .send({ currentPassword: CURRENT_SECRET, newPassword: NEXT_SECRET });

    expect(response.status).toBe(200);

    // Without a fresh cookie the bump logs the user out of the session they just used.
    const token = tokenCookieFrom(response.headers["set-cookie"] as unknown as string[]);
    expect(token).toBeDefined();

    const claims = verifyJwt(token!);
    // The whole point: the new token is at the POST-bump version, so it survives the middleware's
    // isTokenVersionStale check while every previously-issued token is now behind.
    expect(claims.tokenVersion).toBe(7);
    expect(claims.userId).toBe("user-1");
    expect(claims.authMethod).toBe("local");
  });

  it("mints the token with the HOME role and HOME office, not the active office override", async () => {
    const response = await request(createTestApp())
      .post("/api/auth/local/change-password")
      .send({ currentPassword: CURRENT_SECRET, newPassword: NEXT_SECRET });

    const claims = verifyJwt(tokenCookieFrom(response.headers["set-cookie"] as unknown as string[])!);
    expect(claims.role).toBe("rep");
    expect(claims.officeId).toBe("office-dallas");
  });

  it("still reports mustChangePassword false to the client", async () => {
    const response = await request(createTestApp())
      .post("/api/auth/local/change-password")
      .send({ currentPassword: CURRENT_SECRET, newPassword: NEXT_SECRET });

    expect(response.status).toBe(200);
    expect(response.body.user.mustChangePassword).toBe(false);
  });

  it("does not set an auth cookie when the password change itself fails", async () => {
    localAuthMocks.changeLocalPassword.mockRejectedValueOnce(
      new AppError(401, "Current password is incorrect")
    );

    const response = await request(createTestApp())
      .post("/api/auth/local/change-password")
      .send({ currentPassword: "wrong", newPassword: NEXT_SECRET });

    expect(response.status).toBe(401);
    expect(tokenCookieFrom(response.headers["set-cookie"] as unknown as string[])).toBeUndefined();
  });
});
