import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireCrmUser } from "../../middleware/field-auth.js";

// The Reports-by-Region route was director-gated (requireDirector). It is now OPEN to any authenticated
// CRM user: the /api/reports mount still applies requireCrmUser (auth + non-field_contractor) and the
// service still runs against req.tenantDb (office/tenant scoping). These tests lock that in — a `rep`
// reaches the report, the CRM/auth gate is preserved, and the service is called with the request's
// tenant-scoped db (never a cross-office handle).
const mocks = vi.hoisted(() => ({
  getRegionReport: vi.fn(),
}));

vi.mock("./region-report-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./region-report-service.js")>();
  return {
    ...actual,
    getRegionReport: mocks.getRegionReport,
  };
});

import { reportRoutes } from "./routes.js";

const TENANT_DB = { __tag: "office-scoped-tenant-db" } as any;

// Mirror app.ts: the router is mounted behind requireCrmUser, so the route test exercises the SAME
// auth/CRM gate the app applies. `user: null` simulates an unauthenticated request.
function createApp(user: Record<string, unknown> | null) {
  const app = express();
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (user) req.user = user as any;
    req.tenantDb = TENANT_DB;
    req.commitTransaction = vi.fn().mockResolvedValue(undefined) as any;
    next();
  });
  app.use("/api/reports", requireCrmUser, reportRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((err as any).statusCode ?? 500).json({
      error: { message: err instanceof Error ? err.message : "Internal server error" },
    });
  });
  return app;
}

function userWithRole(role: string) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    email: `${role}@example.com`,
    displayName: role,
    role,
    officeId: "22222222-2222-4222-8222-222222222222",
    activeOfficeId: "22222222-2222-4222-8222-222222222222",
  };
}

describe("GET /api/reports/region access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRegionReport.mockResolvedValue({ regions: [], stageColumns: [] });
  });

  it("lets a rep (non-director) reach the region report and returns the data", async () => {
    const response = await request(createApp(userWithRole("rep"))).get("/api/reports/region");

    expect(response.status).toBe(200);
    expect(mocks.getRegionReport).toHaveBeenCalledTimes(1);
    // Office/tenant scoping preserved: the service runs against the request's tenant-scoped db.
    expect(mocks.getRegionReport.mock.calls[0][0]).toBe(TENANT_DB);
  });

  it("also lets a construction-role CRM user reach it", async () => {
    const response = await request(createApp(userWithRole("construction"))).get("/api/reports/region");

    expect(response.status).toBe(200);
    expect(mocks.getRegionReport).toHaveBeenCalledTimes(1);
  });

  it("still lets directors and admins reach it", async () => {
    for (const role of ["director", "admin"]) {
      vi.clearAllMocks();
      mocks.getRegionReport.mockResolvedValue({ regions: [], stageColumns: [] });
      const response = await request(createApp(userWithRole(role))).get("/api/reports/region");
      expect(response.status).toBe(200);
      expect(mocks.getRegionReport).toHaveBeenCalledTimes(1);
    }
  });

  it("still requires authentication (401 when no user)", async () => {
    const response = await request(createApp(null)).get("/api/reports/region");

    expect(response.status).toBe(401);
    expect(mocks.getRegionReport).not.toHaveBeenCalled();
  });

  it("still rejects field contractors (CRM gate preserved)", async () => {
    const response = await request(createApp(userWithRole("field_contractor"))).get("/api/reports/region");

    expect(response.status).toBe(403);
    expect(mocks.getRegionReport).not.toHaveBeenCalled();
  });
});
