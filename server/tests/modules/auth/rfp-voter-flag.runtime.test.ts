import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SIDNEY = "sidney@trockgc.com";

const authState = vi.hoisted(() => ({ user: null as any }));

vi.mock("../../../src/middleware/rate-limit.js", () => ({
  authLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../../../src/middleware/auth.js", () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = authState.user;
    next();
  },
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

describe("GET /api/auth/me — isRfpVoter flag (runtime)", () => {
  const original = process.env.RFP_VOTER_EMAILS;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = "test-jwt-secret";
    process.env.RFP_VOTER_EMAILS = `${SIDNEY}, tim@trockgc.com, james@trockgc.com`;
  });
  afterEach(() => {
    process.env.RFP_VOTER_EMAILS = original;
  });

  it("carries isRfpVoter=true for a configured voter (case-insensitive)", async () => {
    authState.user = {
      id: "u1",
      email: SIDNEY.toUpperCase(),
      displayName: "Sidney Gibson",
      role: "director", // bypasses the onboarding-gate DB query
      officeId: "office-dallas",
      activeOfficeId: "office-dallas",
    };
    const res = await request(createTestApp()).get("/api/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.user.isRfpVoter).toBe(true);
  });

  it("carries isRfpVoter=false for a non-voter (incl. a plain admin)", async () => {
    authState.user = {
      id: "u2",
      email: "someadmin@trockgc.com",
      displayName: "Some Admin",
      role: "director",
      officeId: "office-dallas",
      activeOfficeId: "office-dallas",
    };
    const res = await request(createTestApp()).get("/api/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.user.isRfpVoter).toBe(false);
  });
});
