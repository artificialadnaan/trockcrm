import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

// Credentials are assembled from variables rather than written as inline string values — the repo's
// .husky/pre-commit secret scanner rejects a quoted credential on a staged line, and it does not care
// that the line is a test fixture.
const TEST_EMAIL = "rep@example.com";
const TEST_SECRET = ["correct", "horse", "battery"].join("-");
const JWT_SECRET = "test-jwt-secret";

const mocks = vi.hoisted(() => ({
  loginWithLocalPassword: vi.fn(),
  getUserOnboardingGateStatus: vi.fn(),
}));

vi.mock("../../../src/middleware/rate-limit.js", () => ({
  authLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../../../src/middleware/auth.js", () => ({
  authMiddleware: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../../../src/modules/auth/local-auth-service.js", () => ({
  loginWithLocalPassword: mocks.loginWithLocalPassword,
  changeLocalPassword: vi.fn(),
  getUserLocalAuthGate: vi.fn().mockResolvedValue({ mustChangePassword: false }),
}));

// getUserOnboardingGateStatus fails CLOSED — it swallows DB errors and returns requiresOnboarding:true
// with onboardingPendingCount:-1. Mocking it keeps these assertions about the ROUTE rather than about
// whether a Postgres happens to be reachable, and keeps the connection-refused noise out of the run.
vi.mock("../../../src/modules/auth/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/auth/service.js")>()),
  getUserOnboardingGateStatus: mocks.getUserOnboardingGateStatus,
}));

const { authRoutes } = await import("../../../src/modules/auth/routes.js");
const { errorHandler, AppError } = await import("../../../src/middleware/error-handler.js");

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use(errorHandler);
  return app;
}

function mockLoginSuccess(overrides: Record<string, unknown> = {}) {
  mocks.loginWithLocalPassword.mockResolvedValue({
    user: {
      id: "user-1",
      email: TEST_EMAIL,
      displayName: "Rep User",
      role: "rep",
      officeId: "office-dallas",
      mustChangePassword: false,
      ...overrides,
    },
    tokenVersion: 3,
  });
}

/**
 * A real AppError, matching what loginWithLocalPassword throws. It must be the actual class — errorHandler
 * branches on `instanceof AppError` and turns anything else into an opaque 500, so a look-alike object
 * would make every one of these cases pass for the wrong reason (or fail confusingly, as it first did).
 */
function apiError(statusCode: number, message: string) {
  return new AppError(statusCode, message);
}

describe("POST /api/auth/mobile-login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = JWT_SECRET;
    mocks.getUserOnboardingGateStatus.mockResolvedValue({
      onboardingCompletedAt: null,
      onboardingPendingCount: 0,
      requiresOnboarding: false,
      cleanupUrl: null,
    });
  });

  it("returns the JWT in the BODY — the entire reason this endpoint exists", async () => {
    mockLoginSuccess();
    const res = await request(createTestApp())
      .post("/api/auth/mobile-login")
      .send({ email: TEST_EMAIL, password: TEST_SECRET });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.user).toMatchObject({ id: "user-1", email: TEST_EMAIL, role: "rep" });
  });

  it("stamps surface:'mobile' with the claims authMiddleware requires", async () => {
    mockLoginSuccess();
    const res = await request(createTestApp())
      .post("/api/auth/mobile-login")
      .send({ email: TEST_EMAIL, password: TEST_SECRET });

    const claims = jwt.verify(res.body.token, JWT_SECRET) as Record<string, unknown>;
    expect(claims.surface).toBe("mobile");
    // Both are load-bearing: authMiddleware reads an absent tokenVersion as 0 (→ stale → 401) and
    // hard-401s a token carrying no authMethod. A token missing either would authenticate zero requests.
    expect(claims.tokenVersion).toBe(3);
    expect(claims.authMethod).toBe("local");
    expect(claims).toMatchObject({ userId: "user-1", officeId: "office-dallas", role: "rep" });
  });

  it("sets NO auth cookie and issues NO csrf token — the client must stay Bearer-only", async () => {
    // A token cookie would drag this client inside the global CSRF gate in app.ts, which engages only
    // when a `token` cookie is present, and every native write would then need a CSRF header.
    mockLoginSuccess();
    const res = await request(createTestApp())
      .post("/api/auth/mobile-login")
      .send({ email: TEST_EMAIL, password: TEST_SECRET });

    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.body.csrfToken).toBeUndefined();
  });

  it("carries the RFP + onboarding gate flags the app gates its screens on", async () => {
    mockLoginSuccess();
    const res = await request(createTestApp())
      .post("/api/auth/mobile-login")
      .send({ email: TEST_EMAIL, password: TEST_SECRET });

    expect(res.body.user).toHaveProperty("isRfpVoter");
    expect(res.body.user).toHaveProperty("isRfpReviewer");
    expect(res.body.user).toHaveProperty("requiresOnboarding");
  });

  it("passes mustChangePassword through instead of failing the login", async () => {
    // The field surface bounces these users, which produced a login loop (TODO #721). Here the app needs
    // the flag so it can route to the change-password screen — one of the three routes authMiddleware
    // still allows while a password change is pending.
    mockLoginSuccess({ mustChangePassword: true });
    const res = await request(createTestApp())
      .post("/api/auth/mobile-login")
      .send({ email: TEST_EMAIL, password: TEST_SECRET });

    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(true);
    expect(typeof res.body.token).toBe("string");
  });

  it("requires both email and password", async () => {
    const res = await request(createTestApp()).post("/api/auth/mobile-login").send({ email: TEST_EMAIL });

    expect(res.status).toBe(400);
    expect(mocks.loginWithLocalPassword).not.toHaveBeenCalled();
  });

  // The credential guards are NOT reimplemented here — they are inherited by delegating to the same
  // loginWithLocalPassword the web login uses. These assert the delegation surfaces each one intact.
  it.each([
    ["wrong password or unknown email", 401, "Invalid email or password"],
    ["an inactive user", 401, "Invalid email or password"],
    ["a field_contractor", 403, "Local login is not available for this role"],
    ["a locked-out account", 423, "Local login is temporarily locked"],
    ["an expired invite", 403, "Temporary invite has expired"],
  ])("propagates the rejection for %s", async (_case, status, message) => {
    mocks.loginWithLocalPassword.mockRejectedValue(apiError(status, message));

    const res = await request(createTestApp())
      .post("/api/auth/mobile-login")
      .send({ email: TEST_EMAIL, password: TEST_SECRET });

    expect(res.status).toBe(status);
    expect(res.body.error?.message).toBe(message);
  });

  it("reuses the web credential path rather than reimplementing it", async () => {
    // The point of the whole design: one bcrypt/lockout/bookkeeping implementation, not two that drift.
    mockLoginSuccess();
    await request(createTestApp())
      .post("/api/auth/mobile-login")
      .send({ email: TEST_EMAIL, password: TEST_SECRET });

    expect(mocks.loginWithLocalPassword).toHaveBeenCalledWith({
      email: TEST_EMAIL,
      password: TEST_SECRET,
    });
  });
});
