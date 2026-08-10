// The `canViewDailyActivityLog` session flag the web client hides its report card and page on.
//
// It has to mean "can actually open it", which is BOTH guards on GET /api/reports/daily-activity-log:
// the requireAnyRole floor and the DAILY_ACTIVITY_LOG_VIEWER_EMAILS allowlist. Reporting the allowlist
// alone would set it true for an allowlisted sales_manager, who would then be offered a card whose route
// bounces them to "/" with no explanation.
import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TAKASHI = "tyamashita@trockgc.com";

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

// `director` bypasses the onboarding-gate DB query, which is why every fixture that is not specifically
// testing a role uses it.
function signedInAs(overrides: Record<string, unknown>) {
  authState.user = {
    id: "u1",
    email: TAKASHI,
    displayName: "Takashi Yamashita",
    role: "director",
    officeId: "office-dallas",
    activeOfficeId: "office-dallas",
    ...overrides,
  };
}

describe("GET /api/auth/me — canViewDailyActivityLog flag (runtime)", () => {
  const originalList = process.env.DAILY_ACTIVITY_LOG_VIEWER_EMAILS;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = "test-jwt-secret";
    process.env.DAILY_ACTIVITY_LOG_VIEWER_EMAILS = `${TAKASHI}, ashaw@trockgc.com`;
  });
  afterEach(() => {
    if (originalList === undefined) delete process.env.DAILY_ACTIVITY_LOG_VIEWER_EMAILS;
    else process.env.DAILY_ACTIVITY_LOG_VIEWER_EMAILS = originalList;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("is true for a listed user holding a permitted role", async () => {
    signedInAs({ email: TAKASHI.toUpperCase() });
    const res = await request(createTestApp()).get("/api/auth/me");

    expect(res.status).toBe(200);
    expect(res.body.user.canViewDailyActivityLog).toBe(true);
  });

  it("is false for an unlisted user, even a director", async () => {
    signedInAs({ email: "someadmin@trockgc.com" });
    const res = await request(createTestApp()).get("/api/auth/me");

    expect(res.status).toBe(200);
    expect(res.body.user.canViewDailyActivityLog).toBe(false);
  });

  // The role half. Without it the card would be offered to someone the route then redirects away.
  it("is false for a LISTED user whose role is outside the route's floor", async () => {
    signedInAs({ email: TAKASHI, role: "sales_manager" });
    const res = await request(createTestApp()).get("/api/auth/me");

    expect(res.status).toBe(200);
    expect(res.body.user.canViewDailyActivityLog).toBe(false);
  });

  it("is true for each role the route does admit", async () => {
    for (const role of ["admin", "director", "rep"]) {
      signedInAs({ email: TAKASHI, role });
      const res = await request(createTestApp()).get("/api/auth/me");
      expect(res.body.user.canViewDailyActivityLog, `role=${role}`).toBe(true);
    }
  });

  it("is false for everyone when the allowlist is unset outside dev/test", async () => {
    delete process.env.DAILY_ACTIVITY_LOG_VIEWER_EMAILS;
    process.env.NODE_ENV = "production";
    signedInAs({ email: TAKASHI });
    const res = await request(createTestApp()).get("/api/auth/me");

    expect(res.status).toBe(200);
    expect(res.body.user.canViewDailyActivityLog).toBe(false);
  });
});
