import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authServiceMocks = vi.hoisted(() => ({
  ensureDevDemoWorkspace: vi.fn(),
  ensureDevUserPrimaryOffice: vi.fn(),
  getAccessibleOffices: vi.fn(),
  getDevUsers: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserById: vi.fn(),
  getUserOnboardingGateStatus: vi.fn(),
  signJwt: vi.fn(),
}));

vi.mock("../../../src/middleware/rate-limit.js", () => ({
  authLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../../../src/middleware/auth.js", () => ({
  authMiddleware: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../../../src/modules/auth/service.js", () => authServiceMocks);

const { authRoutes } = await import("../../../src/modules/auth/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use(errorHandler);
  return app;
}

describe("dev login demo bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DEV_MODE = "true";
    process.env.JWT_SECRET = "test-secret";
    delete process.env.ENABLE_AUTH_DEMO_BOOTSTRAP;

    authServiceMocks.getUserByEmail.mockResolvedValue({
      id: "user-1",
      email: "director@trock.dev",
      displayName: "Director",
      role: "director",
      officeId: "office-dallas",
      isActive: true,
    });
    authServiceMocks.ensureDevUserPrimaryOffice.mockResolvedValue({
      id: "user-1",
      email: "director@trock.dev",
      displayName: "Director",
      role: "director",
      officeId: "office-dallas",
      isActive: true,
    });
    authServiceMocks.getUserOnboardingGateStatus.mockResolvedValue({
      onboardingCompletedAt: null,
      onboardingPendingCount: 0,
      requiresOnboarding: false,
      cleanupUrl: "http://localhost:5175",
    });
    authServiceMocks.signJwt.mockReturnValue("signed-token");
  });

  it("does not seed the auth demo workspace by default during dev login", async () => {
    const app = createTestApp();

    const response = await request(app)
      .post("/api/auth/dev/login")
      .send({ email: "director@trock.dev" });

    expect(response.status).toBe(200);
    expect(authServiceMocks.ensureDevDemoWorkspace).not.toHaveBeenCalled();
  });

  it("can still seed the auth demo workspace when explicitly enabled", async () => {
    process.env.ENABLE_AUTH_DEMO_BOOTSTRAP = "true";
    const app = createTestApp();

    const response = await request(app)
      .post("/api/auth/dev/login")
      .send({ email: "director@trock.dev" });

    expect(response.status).toBe(200);
    expect(authServiceMocks.ensureDevDemoWorkspace).toHaveBeenCalledWith("user-1", "dallas");
  });
});
