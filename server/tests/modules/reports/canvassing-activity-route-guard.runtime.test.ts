// Proves the allowlist guard is actually MOUNTED on GET /reports/canvassing-activity.
//
// The middleware's own behaviour is covered in tests/middleware/require-canvassing-report-viewer.runtime.test.ts.
// What that cannot see is whether anyone wired it to the route — a route left with only requireAnyRole would
// hand the per-person scoreboard to every rep in the office. So this suite deliberately does NOT mock rbac.
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const COLBY = "cburling@trockgc.com";

const serviceMocks = vi.hoisted(() => ({
  getCanvassingActivityReport: vi.fn(async () => ({ ok: true })),
}));

// Only the data layer is stubbed, so a 200 means the request cleared every guard on the route.
vi.mock("../../../src/modules/reports/canvassing-activity-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/modules/reports/canvassing-activity-service.js")>();
  return { ...actual, getCanvassingActivityReport: serviceMocks.getCanvassingActivityReport };
});

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

const listed: FakeUser = {
  id: "u-colby",
  email: COLBY,
  role: "director",
  baseRole: "director",
  displayName: "Colby Burling",
};

describe("GET /reports/canvassing-activity — allowlist guard wiring", () => {
  const originalList = process.env.CANVASSING_REPORT_VIEWER_EMAILS;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CANVASSING_REPORT_VIEWER_EMAILS = COLBY;
  });
  afterEach(() => {
    if (originalList === undefined) delete process.env.CANVASSING_REPORT_VIEWER_EMAILS;
    else process.env.CANVASSING_REPORT_VIEWER_EMAILS = originalList;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("serves a listed viewer", async () => {
    const res = await request(appAs(listed)).get("/reports/canvassing-activity");

    expect(res.status).toBe(200);
    expect(serviceMocks.getCanvassingActivityReport).toHaveBeenCalledTimes(1);
  });

  it("403s a director who is not on the list, without running the query", async () => {
    const res = await request(appAs({ ...listed, id: "u-other", email: "other@trockgc.com" })).get(
      "/reports/canvassing-activity"
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CANVASSING_REPORT_VIEWER_ONLY");
    expect(serviceMocks.getCanvassingActivityReport).not.toHaveBeenCalled();
  });

  it("403s a rep who is not on the list", async () => {
    const res = await request(
      appAs({ ...listed, id: "u-rep", email: "arep@trockgc.com", role: "rep", baseRole: "rep" })
    ).get("/reports/canvassing-activity");

    expect(res.status).toBe(403);
    expect(serviceMocks.getCanvassingActivityReport).not.toHaveBeenCalled();
  });

  // The role floor still runs, and runs first: the allowlist narrows, it never widens.
  it("still applies the role floor to a listed user holding an out-of-scope role", async () => {
    const res = await request(appAs({ ...listed, role: "construction", baseRole: "construction" })).get(
      "/reports/canvassing-activity"
    );

    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe("CANVASSING_REPORT_VIEWER_ONLY");
    expect(serviceMocks.getCanvassingActivityReport).not.toHaveBeenCalled();
  });

  it("refuses everyone when the allowlist is unset outside dev/test", async () => {
    delete process.env.CANVASSING_REPORT_VIEWER_EMAILS;
    process.env.NODE_ENV = "production";

    const res = await request(appAs(listed)).get("/reports/canvassing-activity");

    expect(res.status).toBe(403);
    expect(serviceMocks.getCanvassingActivityReport).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated request", async () => {
    const res = await request(appAs(null)).get("/reports/canvassing-activity");

    expect(res.status).toBe(401);
    expect(serviceMocks.getCanvassingActivityReport).not.toHaveBeenCalled();
  });

  it("passes the query through the normalizer rather than trusting it", async () => {
    await request(appAs(listed)).get(
      "/reports/canvassing-activity?bucket=fortnight&dateFrom=2026-06-30&dateTo=2026-06-01&userIds=not-a-uuid"
    );

    const filters = serviceMocks.getCanvassingActivityReport.mock.calls[0]?.[1] as unknown as {
      bucket: string;
      dateFrom: string;
      dateTo: string;
      userIds?: string[];
    };
    expect(filters.bucket).toBe("week");
    expect(filters.dateFrom).toBe("2026-06-01");
    expect(filters.dateTo).toBe("2026-06-30");
    // A userIds param that was PRESENT but entirely malformed stays a filter — one that matches nobody.
    // It used to normalise to undefined, which downstream reads as "no filter", so a corrupted
    // person-filtered bookmark quietly rendered the whole office.
    expect(filters.userIds).toEqual(["00000000-0000-0000-0000-000000000000"]);
  });
});
