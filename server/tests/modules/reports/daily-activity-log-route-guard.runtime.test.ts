// Proves the allowlist guard is actually MOUNTED on GET /reports/daily-activity-log.
//
// The middleware's own behaviour is covered in tests/middleware/require-daily-activity-log-viewer.runtime.test.ts.
// What that test cannot see is whether anyone wired it to the route — and a route left with only requireAnyRole
// is indistinguishable from the pre-change code. So this suite deliberately does NOT mock rbac: it runs the real
// guard chain against a real Express router and asserts on status codes.
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TAKASHI = "tyamashita@trockgc.com";

const serviceMocks = vi.hoisted(() => ({
  getDailyActivityLogReport: vi.fn(async () => ({ ok: true })),
}));

// Only the data layer is stubbed. A 200 therefore means the request cleared every guard on the route.
vi.mock("../../../src/modules/reports/daily-activity-log-service.js", () => ({
  getDailyActivityLogReport: serviceMocks.getDailyActivityLogReport,
  normalizeDailyActivityLogOptions: () => ({}),
}));

const { reportRoutes } = await import("../../../src/modules/reports/routes.js");

type FakeUser = { id: string; email: string | null; role: string; baseRole: string; displayName: string };

function appAs(user: FakeUser | null) {
  const app = express();
  app.use((req: any, _res, next) => {
    if (user) req.user = user;
    req.tenantDb = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    req.commitTransaction = vi.fn().mockResolvedValue(undefined);
    req.officeSlug = "dallas";
    next();
  });
  app.use("/reports", reportRoutes);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message, code: err?.code });
  });
  return app;
}

const listedAdmin: FakeUser = {
  id: "u-listed",
  email: TAKASHI,
  role: "admin",
  baseRole: "admin",
  displayName: "Takashi Yamashita",
};

describe("GET /reports/daily-activity-log — allowlist guard wiring", () => {
  const originalList = process.env.DAILY_ACTIVITY_LOG_VIEWER_EMAILS;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DAILY_ACTIVITY_LOG_VIEWER_EMAILS = TAKASHI;
  });
  afterEach(() => {
    if (originalList === undefined) delete process.env.DAILY_ACTIVITY_LOG_VIEWER_EMAILS;
    else process.env.DAILY_ACTIVITY_LOG_VIEWER_EMAILS = originalList;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("serves a listed viewer", async () => {
    const res = await request(appAs(listedAdmin)).get("/reports/daily-activity-log");

    expect(res.status).toBe(200);
    expect(serviceMocks.getDailyActivityLogReport).toHaveBeenCalledTimes(1);
  });

  // The behaviour change: role alone used to be enough. An admin off the list must now be refused, and
  // refused BEFORE the service runs — otherwise the rows were read even if the response hid them.
  it("403s an admin who is not on the list, without reading any rows", async () => {
    const res = await request(appAs({ ...listedAdmin, id: "u-other", email: "someadmin@trockgc.com" })).get(
      "/reports/daily-activity-log"
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("DAILY_ACTIVITY_LOG_VIEWER_ONLY");
    expect(serviceMocks.getDailyActivityLogReport).not.toHaveBeenCalled();
  });

  it("403s a rep who is not on the list", async () => {
    const res = await request(
      appAs({ ...listedAdmin, id: "u-rep", email: "arep@trockgc.com", role: "rep", baseRole: "rep" })
    ).get("/reports/daily-activity-log");

    expect(res.status).toBe(403);
    expect(serviceMocks.getDailyActivityLogReport).not.toHaveBeenCalled();
  });

  // The role floor still runs first, and still runs at all: a role outside admin/director/rep is refused
  // by requireAnyRole even when its address is on the allowlist. The list narrows; it never widens.
  it("still applies the role floor to a listed user holding an out-of-scope role", async () => {
    const res = await request(
      appAs({ ...listedAdmin, role: "construction", baseRole: "construction" })
    ).get("/reports/daily-activity-log");

    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe("DAILY_ACTIVITY_LOG_VIEWER_ONLY");
    expect(serviceMocks.getDailyActivityLogReport).not.toHaveBeenCalled();
  });

  it("refuses everyone when the allowlist is unset outside dev/test", async () => {
    delete process.env.DAILY_ACTIVITY_LOG_VIEWER_EMAILS;
    process.env.NODE_ENV = "production";

    const res = await request(appAs(listedAdmin)).get("/reports/daily-activity-log");

    expect(res.status).toBe(403);
    expect(serviceMocks.getDailyActivityLogReport).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated request", async () => {
    const res = await request(appAs(null)).get("/reports/daily-activity-log");

    expect(res.status).toBe(401);
    expect(serviceMocks.getDailyActivityLogReport).not.toHaveBeenCalled();
  });
});
