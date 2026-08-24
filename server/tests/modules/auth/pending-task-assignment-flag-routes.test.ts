// C5 — the flag has to ride `withOnboardingGate`, not just `/auth/me`.
//
// `localLogin` never refetches /auth/me: client/src/lib/auth.tsx sets `user` in place from the login
// response, and the /auth/me fetch runs once on mount with an empty dependency list. So a signal that
// only appears on /auth/me is absent on the login that the feature is actually about.
//
// And the population this feature exists for — a newly provisioned person with assignments already
// waiting — never sees the login response either. App.tsx returns <ForcePasswordChangeScreen/> before
// children mount while `mustChangePassword` is true, so the ONLY user object their app ever receives
// comes from /local/change-password. A flag wired into /local/login and /auth/me and nothing else is
// invisible to exactly the user it was written for.
//
// withOnboardingGate is the one shared builder behind all five: /dev/login, /local/login,
// /mobile-login, /me and /local/change-password. These tests drive all five through the real router.
//
// C11 — asserting the KEY exists is green against a hardcoded `false`, so each path is asserted in BOTH
// states, driven by the service the route is supposed to be calling.
import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authServiceMocks = vi.hoisted(() => ({
  userHasPendingTaskAssignments: vi.fn(),
}));

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
    // The gate's own DB work is out of scope here; only the new flag is under test.
    getUserOnboardingGateStatus: vi.fn().mockResolvedValue({
      onboardingCompletedAt: null,
      onboardingPendingCount: 0,
      requiresOnboarding: false,
      cleanupUrl: "http://localhost:5175",
    }),
    userHasPendingTaskAssignments: authServiceMocks.userHasPendingTaskAssignments,
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

describe("hasPendingTaskAssignments rides every auth response", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = "test-jwt-secret";
    // /dev/login is gated on isDevAuthEnabled(env, host); supertest's host is 127.0.0.1.
    process.env.NODE_ENV = "development";
    localAuthMocks.loginWithLocalPassword.mockResolvedValue({ user: SESSION_USER });
    localAuthMocks.changeLocalPassword.mockResolvedValue({ tokenVersion: 1 });
  });

  for (const path of PATHS) {
    it(`${path.name} reports TRUE when the person has an unseen assignment`, async () => {
      authServiceMocks.userHasPendingTaskAssignments.mockResolvedValue(true);

      const response = await path.call(createTestApp());

      expect(response.status).toBe(200);
      expect(response.body.user.hasPendingTaskAssignments).toBe(true);
    });

    it(`${path.name} reports FALSE when they do not`, async () => {
      authServiceMocks.userHasPendingTaskAssignments.mockResolvedValue(false);

      const response = await path.call(createTestApp());

      expect(response.status).toBe(200);
      expect(response.body.user.hasPendingTaskAssignments).toBe(false);
    });
  }

  it("asks about the ACTIVE office, not the home office", async () => {
    authServiceMocks.userHasPendingTaskAssignments.mockResolvedValue(false);

    await request(createTestApp()).get("/api/auth/me");

    expect(authServiceMocks.userHasPendingTaskAssignments).toHaveBeenCalledWith({
      userId: "user-1",
      officeId: "office-dallas",
    });
  });

  // The flag is a nice-to-have; the session is not. If the lookup throws, the person still signs in.
  it("still returns the user when the lookup REJECTS, with the flag off", async () => {
    authServiceMocks.userHasPendingTaskAssignments.mockRejectedValue(new Error("pool exhausted"));

    const response = await request(createTestApp()).get("/api/auth/me");

    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe("user-1");
    expect(response.body.user.hasPendingTaskAssignments).toBe(false);
  });

  // A SYNCHRONOUS throw is the one that gets away. Called straight into a Promise.allSettled array it
  // raises while the array is still being constructed — before allSettled exists to catch anything —
  // and every login path 500s. It is not hypothetical: a suite that stubs the whole auth service
  // module without this export makes the function `undefined`, and calling undefined throws
  // synchronously. That is how this was found.
  it("still returns the user when the lookup throws SYNCHRONOUSLY, with the flag off", async () => {
    authServiceMocks.userHasPendingTaskAssignments.mockImplementation(() => {
      throw new TypeError("userHasPendingTaskAssignments is not a function");
    });

    const response = await request(createTestApp()).get("/api/auth/me");

    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe("user-1");
    expect(response.body.user.hasPendingTaskAssignments).toBe(false);
  });

  // The gate is NOT optional in the same way: it decides whether somebody is allowed into the app at
  // all, and it already fails closed internally. Swallowing its failure here would hand a blocked user
  // a working session, so its rejection must still propagate.
  it("does NOT swallow an onboarding-gate failure", async () => {
    const { getUserOnboardingGateStatus } = await import("../../../src/modules/auth/service.js");
    vi.mocked(getUserOnboardingGateStatus).mockRejectedValueOnce(new Error("gate down"));
    authServiceMocks.userHasPendingTaskAssignments.mockResolvedValue(false);

    const response = await request(createTestApp()).get("/api/auth/me");

    expect(response.status).toBe(500);
  });
});
