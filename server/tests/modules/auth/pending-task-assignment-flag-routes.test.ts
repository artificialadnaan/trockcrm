// Authentication is the first request behind every CRM render. Pending-task lookup is intentionally
// absent from its shared response builder: the client asks once, after the recipient's next ordinary
// interaction, rather than adding tenant work to every login and /auth/me response. These tests drive
// all five user-returning paths through the real router to prevent that coupling from quietly returning.
import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authServiceMocks = vi.hoisted(() => ({ getUserOnboardingGateStatus: vi.fn() }));

/** Opaque placeholders. The local-auth service is mocked, so neither value is ever checked. */
const PLACEHOLDER_OLD = "current-secret-placeholder";
const PLACEHOLDER_NEW = "replacement-secret-placeholder";

const DEV_USER = vi.hoisted(() => ({
  id: "user-1",
  email: "rep@trock.dev",
  displayName: "Rep User",
  role: "rep",
  officeId: "office-dallas",
  activeOfficeId: "office-dallas",
  tokenVersion: 0,
  isActive: true,
  mustChangePassword: false,
}));

const localAuthMocks = vi.hoisted(() => ({
  loginWithLocalPassword: vi.fn(),
  changeLocalPassword: vi.fn(),
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
      role: "rep",
      officeId: "office-dallas",
      activeOfficeId: "office-dallas",
      mustChangePassword: true,
    } as never;
    next();
  },
}));

vi.mock("../../../src/modules/auth/local-auth-service.js", () => ({
  loginWithLocalPassword: localAuthMocks.loginWithLocalPassword,
  changeLocalPassword: localAuthMocks.changeLocalPassword,
  getUserLocalAuthGate: vi.fn().mockResolvedValue({ mustChangePassword: false }),
}));

vi.mock("../../../src/modules/auth/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/auth/service.js")>(
    "../../../src/modules/auth/service.js"
  );
  return {
    ...actual,
    // The gate's own DB work is out of scope here; only the auth response shape is under test.
    getUserOnboardingGateStatus: authServiceMocks.getUserOnboardingGateStatus,
    // Inlined rather than spread from SESSION_USER below: a vi.mock factory runs during module
    // resolution, before this file's own top-level consts have been evaluated.
    getUserByEmail: vi.fn().mockResolvedValue(DEV_USER),
    ensureDevUserPrimaryOffice: vi.fn().mockResolvedValue(DEV_USER),
  };
});

vi.mock("../../../src/modules/auth/dev-demo-bootstrap.js", () => ({
  isAuthDemoBootstrapEnabled: () => false,
  ensureDevDemoWorkspace: vi.fn(),
}));

const { authRoutes } = await import("../../../src/modules/auth/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

const SESSION_USER = {
  id: "user-1",
  email: "rep@example.com",
  displayName: "Rep User",
  role: "rep",
  officeId: "office-dallas",
  activeOfficeId: "office-dallas",
  tokenVersion: 0,
  isActive: true,
  mustChangePassword: false,
};

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use(errorHandler);
  return app;
}

/**
 * The five responses that carry a user object, each named by the client state it is the ONLY source
 * for. /local/change-password is the one the body of the spec never enumerated and the one a newly
 * provisioned person depends on.
 */
const PATHS = [
  {
    name: "POST /dev/login",
    call: (app: express.Express) =>
      request(app).post("/api/auth/dev/login").send({ email: "rep@trock.dev" }),
  },
  {
    name: "POST /local/login",
    call: (app: express.Express) =>
      request(app).post("/api/auth/local/login").send({ email: "rep@example.com", password: "x" }),
  },
  {
    name: "POST /mobile-login",
    call: (app: express.Express) =>
      request(app).post("/api/auth/mobile-login").send({ email: "rep@example.com", password: "x" }),
  },
  {
    name: "GET /me",
    call: (app: express.Express) => request(app).get("/api/auth/me"),
  },
  {
    name: "POST /local/change-password",
    call: (app: express.Express) =>
      request(app)
        .post("/api/auth/local/change-password")
        // Values are placeholders only -- changeLocalPassword is mocked, so nothing validates them.
        .send({ currentPassword: PLACEHOLDER_OLD, newPassword: PLACEHOLDER_NEW }),
  },
] as const;

describe("auth responses leave task-assignment lookup to the client interaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = "test-jwt-secret";
    // /dev/login is gated on isDevAuthEnabled(env, host); supertest's host is 127.0.0.1.
    process.env.NODE_ENV = "development";
    authServiceMocks.getUserOnboardingGateStatus.mockResolvedValue({
      onboardingCompletedAt: null,
      onboardingPendingCount: 0,
      requiresOnboarding: false,
      cleanupUrl: "http://localhost:5175",
    });
    localAuthMocks.loginWithLocalPassword.mockResolvedValue({ user: SESSION_USER });
    localAuthMocks.changeLocalPassword.mockResolvedValue({ tokenVersion: 1 });
  });

  for (const path of PATHS) {
    it(`${path.name} returns the user without a pending-task assignment flag`, async () => {
      const response = await path.call(createTestApp());

      expect(response.status).toBe(200);
      expect(response.body.user).not.toHaveProperty("hasPendingTaskAssignments");
      expect(authServiceMocks.getUserOnboardingGateStatus).toHaveBeenCalled();
    });
  }

  it("still asks the real onboarding gate about the active office", async () => {
    await request(createTestApp()).get("/api/auth/me");

    expect(authServiceMocks.getUserOnboardingGateStatus).toHaveBeenCalledWith({
      userId: "user-1",
      officeId: "office-dallas",
      role: "rep",
    });
  });

  it("does not retain the auth-side pending-task lookup export", async () => {
    const authService = await import("../../../src/modules/auth/service.js");
    expect("userHasPendingTaskAssignments" in authService).toBe(false);
  });

  // The gate is NOT optional in the same way: it decides whether somebody is allowed into the app at
  // all, and it already fails closed internally. Swallowing its failure here would hand a blocked user
  // a working session, so its rejection must still propagate.
  it("does NOT swallow an onboarding-gate failure", async () => {
    const { getUserOnboardingGateStatus } = await import("../../../src/modules/auth/service.js");
    vi.mocked(getUserOnboardingGateStatus).mockRejectedValueOnce(new Error("gate down"));

    const response = await request(createTestApp()).get("/api/auth/me");

    expect(response.status).toBe(500);
  });
});
