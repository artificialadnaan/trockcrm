import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const graphAuthMocks = vi.hoisted(() => ({
  isGraphAuthConfigured: vi.fn(),
  getConsentUrl: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
}));

const authTestUsers = {
  admin: {
    id: "admin-1",
    role: "admin" as const,
    displayName: "Admin User",
    email: "admin@trock.dev",
    officeId: "office-1",
    activeOfficeId: "office-1",
  },
};

vi.mock("../../../src/middleware/auth.js", () => ({
  authMiddleware: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = req.cookies?.token;

    if (token === "admin-token") {
      req.user = authTestUsers.admin;
      next();
      return;
    }

    res.status(401).json({ error: { message: "Authentication required" } });
  },
}));

vi.mock("../../../src/middleware/rate-limit.js", () => ({
  authLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../../../src/modules/email/graph-auth.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/modules/email/graph-auth.js")
  >("../../../src/modules/email/graph-auth.js");

  return {
    ...actual,
    isGraphAuthConfigured: graphAuthMocks.isGraphAuthConfigured,
    getConsentUrl: graphAuthMocks.getConsentUrl,
    exchangeCodeForTokens: graphAuthMocks.exchangeCodeForTokens,
  };
});

const { authRoutes } = await import("../../../src/modules/auth/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

const adminCookie = "token=admin-token";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use(errorHandler);
  return app;
}

describe("graph oauth auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    process.env.JWT_SECRET = "test-jwt-secret";
    process.env.API_BASE_URL = "https://api.example.com";
    process.env.FRONTEND_URL = "https://frontend.example.com";
    process.env.NODE_ENV = "production";

    graphAuthMocks.isGraphAuthConfigured.mockReturnValue(true);
    graphAuthMocks.getConsentUrl.mockReturnValue("https://login.microsoftonline.com/example-consent");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sets a cross-site-safe nonce cookie for graph consent in production", async () => {
    const app = createTestApp();

    const res = await request(app)
      .get("/api/auth/graph/consent")
      .set("Cookie", adminCookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      url: "https://login.microsoftonline.com/example-consent",
    });

    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    expect(setCookie[0]).toContain("graph_auth_nonce=");
    expect(setCookie[0]).toContain("HttpOnly");
    expect(setCookie[0]).toContain("Secure");
    expect(setCookie[0]).toContain("SameSite=None");
  });
});
