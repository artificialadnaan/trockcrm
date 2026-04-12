import cookieParser from "cookie-parser";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const oauthTokenServiceMocks = vi.hoisted(() => ({
  upsertProcoreOauthTokens: vi.fn(),
  getStoredProcoreOauthTokens: vi.fn(),
  clearStoredProcoreOauthTokens: vi.fn(),
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
  rep: {
    id: "rep-1",
    role: "rep" as const,
    displayName: "Rep User",
    email: "rep@trock.dev",
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

    if (token === "rep-token") {
      req.user = authTestUsers.rep;
      next();
      return;
    }

    res.status(401).json({ error: { message: "Authentication required" } });
  },
}));

vi.mock("../../../src/middleware/rate-limit.js", () => ({
  authLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../../../src/modules/procore/oauth-token-service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/modules/procore/oauth-token-service.js")
  >("../../../src/modules/procore/oauth-token-service.js");

  return {
    ...actual,
    upsertProcoreOauthTokens: oauthTokenServiceMocks.upsertProcoreOauthTokens,
    getStoredProcoreOauthTokens: oauthTokenServiceMocks.getStoredProcoreOauthTokens,
    clearStoredProcoreOauthTokens: oauthTokenServiceMocks.clearStoredProcoreOauthTokens,
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

function createSignedState(overrides: Partial<{
  sub: string;
  role: string;
  officeId: string;
  purpose: string;
}> = {}) {
  return jwt.sign(
    {
      sub: authTestUsers.admin.id,
      role: authTestUsers.admin.role,
      officeId: authTestUsers.admin.activeOfficeId,
      purpose: "procore_oauth",
      ...overrides,
    },
    process.env.JWT_SECRET!,
    { expiresIn: "10m" }
  );
}

function mockFetchResponse({
  ok = true,
  status = 200,
  json,
  text = "",
}: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
}) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(json),
    text: vi.fn().mockResolvedValue(text),
  };
}

describe("procore oauth auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    process.env.JWT_SECRET = "test-jwt-secret";
    process.env.PROCORE_CLIENT_ID = "procore-client-id";
    process.env.PROCORE_CLIENT_SECRET = "procore-client-secret";
    process.env.API_BASE_URL = "http://localhost:3001";
    process.env.FRONTEND_URL = "http://localhost:5173";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a Procore authorize URL for admin users", async () => {
    const app = createTestApp();

    const res = await request(app)
      .get("/api/auth/procore/url")
      .set("Cookie", adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.url).toContain("https://login.procore.com/oauth/authorize");
  });

  it("returns a null authorize URL when Procore OAuth env vars are missing", async () => {
    delete process.env.PROCORE_CLIENT_ID;
    delete process.env.PROCORE_CLIENT_SECRET;
    const app = createTestApp();

    const res = await request(app)
      .get("/api/auth/procore/url")
      .set("Cookie", adminCookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      url: null,
      authMode: "dev",
      message: "Procore auth not configured — using dev mode",
    });
  });

  it("returns disconnected when no stored Procore OAuth token exists", async () => {
    oauthTokenServiceMocks.getStoredProcoreOauthTokens.mockResolvedValue(null);
    const app = createTestApp();

    const res = await request(app)
      .get("/api/auth/procore/status")
      .set("Cookie", adminCookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      connected: false,
      authMode: "client_credentials",
      expiresAt: null,
      accountEmail: null,
      accountName: null,
      status: null,
      errorMessage: null,
    });
  });

  it("returns oauth status metadata when stored Procore OAuth tokens exist", async () => {
    oauthTokenServiceMocks.getStoredProcoreOauthTokens.mockResolvedValue({
      id: "token-row-1",
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      expiresAt: new Date("2026-04-13T12:00:00.000Z"),
      scopes: ["read"],
      accountEmail: "admin@trock.dev",
      accountName: "Admin User",
      status: "active",
      lastError: null,
    });
    const app = createTestApp();

    const res = await request(app)
      .get("/api/auth/procore/status")
      .set("Cookie", adminCookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      connected: true,
      authMode: "oauth",
      expiresAt: "2026-04-13T12:00:00.000Z",
      accountEmail: "admin@trock.dev",
      accountName: "Admin User",
      status: "active",
      errorMessage: null,
    });
  });

  it("exchanges the callback code and stores tokens before redirecting to /admin/procore", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockFetchResponse({
          ok: true,
          status: 200,
          json: {
            access_token: "oauth-access",
            refresh_token: "oauth-refresh",
            expires_in: 3600,
            scope: "read projects",
          },
        })
      )
    );

    const app = createTestApp();
    const signedState = createSignedState();

    const res = await request(app)
      .get("/api/auth/procore/callback")
      .query({ code: "abc123", state: signedState });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/admin/procore?procore=connected");
    expect(oauthTokenServiceMocks.upsertProcoreOauthTokens).toHaveBeenCalledTimes(1);
    expect(oauthTokenServiceMocks.upsertProcoreOauthTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "oauth-access",
        refreshToken: "oauth-refresh",
        scopes: ["read", "projects"],
        accountEmail: null,
        accountName: null,
      })
    );
  });

  it("redirects to a non-state auth error when token exchange fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockFetchResponse({
          ok: false,
          status: 401,
          text: "exchange failed",
        })
      )
    );

    const app = createTestApp();
    const signedState = createSignedState();

    const res = await request(app)
      .get("/api/auth/procore/callback")
      .query({ code: "abc123", state: signedState });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/admin/procore?procore=error&reason=token_exchange_failed");
  });

  it("deletes the stored Procore OAuth token on disconnect", async () => {
    const app = createTestApp();

    const res = await request(app)
      .post("/api/auth/procore/disconnect")
      .set("Cookie", adminCookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(oauthTokenServiceMocks.clearStoredProcoreOauthTokens).toHaveBeenCalledTimes(1);
  });

  it("redirects to an auth error when callback state is invalid", async () => {
    const app = createTestApp();

    const res = await request(app)
      .get("/api/auth/procore/callback")
      .query({ code: "abc123", state: "bad-state" });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/admin/procore?procore=error&reason=invalid_state");
  });

  it("redirects to an auth error when Procore returns an oauth error", async () => {
    const app = createTestApp();
    const signedState = createSignedState();

    const res = await request(app)
      .get("/api/auth/procore/callback")
      .query({ error: "access_denied", state: signedState });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/admin/procore?procore=error&reason=access_denied");
  });
});
