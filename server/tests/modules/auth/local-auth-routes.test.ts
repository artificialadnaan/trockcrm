import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    };
    next();
  },
}));

vi.mock("../../../src/modules/auth/local-auth-service.js", () => ({
  loginWithLocalPassword: localAuthMocks.loginWithLocalPassword,
  changeLocalPassword: localAuthMocks.changeLocalPassword,
  getUserLocalAuthGate: vi.fn().mockResolvedValue({ mustChangePassword: false }),
}));

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

describe("local auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = "test-jwt-secret";
  });

  it("logs a user in with local credentials and sets the auth cookie", async () => {
    localAuthMocks.loginWithLocalPassword.mockResolvedValue({
      user: {
        id: "user-1",
        email: "rep@example.com",
        displayName: "Rep User",
        role: "rep",
        officeId: "office-dallas",
        activeOfficeId: "office-dallas",
        mustChangePassword: true,
      },
    });

    const app = createTestApp();
    const response = await request(app)
      .post("/api/auth/local/login")
      .send({ email: "rep@example.com", password: "TempPassword123!" });

    expect(response.status).toBe(200);
    expect(response.body.user.mustChangePassword).toBe(true);
    expect(response.headers["set-cookie"]?.[0]).toContain("token=");
    expect(localAuthMocks.loginWithLocalPassword).toHaveBeenCalledWith({
      email: "rep@example.com",
      password: "TempPassword123!",
    });
  });

  it("changes the password for an authenticated local user", async () => {
    const app = createTestApp();
    const response = await request(app)
      .post("/api/auth/local/change-password")
      .send({
        currentPassword: "TempPassword123!",
        newPassword: "NewPassword123!",
      });

    expect(response.status).toBe(200);
    expect(localAuthMocks.changeLocalPassword).toHaveBeenCalledWith({
      userId: "user-1",
      currentPassword: "TempPassword123!",
      newPassword: "NewPassword123!",
    });
    expect(response.body.user.mustChangePassword).toBe(false);
  });
});
