import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRepRosterOptions: vi.fn(),
  getAccessibleOffices: vi.fn(),
  user: {
    id: "user-1",
    email: "rep@example.com",
    displayName: "Rep User",
    role: "rep",
    officeId: "office-dallas",
    activeOfficeId: "office-dallas" as string | null,
  },
}));

vi.mock("../../../src/db.js", () => ({ db: {} }));

vi.mock("../../../src/modules/dashboard/service.js", () => ({
  getRepRosterOptions: mocks.getRepRosterOptions,
  // The router imports these eagerly; none are exercised here.
  getAdminDashboardSummary: vi.fn(),
  getRepDashboard: vi.fn(),
  getDirectorDashboard: vi.fn(),
  getDirectorCommissionWorkspace: vi.fn(),
  getDirectorCommissionEvidence: vi.fn(),
  isCommissionEvidenceMetric: vi.fn(),
  getRepDetail: vi.fn(),
  getRepPerformanceSnapshots: vi.fn(),
  REP_PERFORMANCE_PERIOD_KINDS: ["mtd"],
}));

vi.mock("../../../src/modules/auth/service.js", () => ({
  getAccessibleOffices: mocks.getAccessibleOffices,
}));

vi.mock("../../../src/modules/commissions/reporting-service.js", () => ({
  getRepCommissionDashboard: vi.fn(),
  normalizeCommissionPeriod: vi.fn(),
}));

const { dashboardRoutes } = await import("../../../src/modules/dashboard/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = mocks.user;
    (req as any).tenantDb = {};
    (req as any).commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/dashboard", dashboardRoutes);
  app.use(errorHandler);
  return app;
}

describe("GET /api/dashboard/rep-roster", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.activeOfficeId = "office-dallas";
    mocks.getAccessibleOffices.mockResolvedValue([{ id: "office-dallas" }, { id: "office-atlanta" }]);
    mocks.getRepRosterOptions.mockResolvedValue([{ id: "u1", displayName: "Colby Burling" }]);
  });

  it("returns the roster for the caller's active office", async () => {
    const response = await request(createTestApp()).get("/api/dashboard/rep-roster");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ users: [{ id: "u1", displayName: "Colby Burling" }] });
    expect(mocks.getRepRosterOptions).toHaveBeenCalledWith(expect.anything(), "office-dallas");
  });

  it("honours an x-office-id header the caller has access to", async () => {
    await request(createTestApp())
      .get("/api/dashboard/rep-roster")
      .set("x-office-id", "office-atlanta");

    expect(mocks.getRepRosterOptions).toHaveBeenCalledWith(expect.anything(), "office-atlanta");
  });

  it("rejects an x-office-id the caller cannot access", async () => {
    const response = await request(createTestApp())
      .get("/api/dashboard/rep-roster")
      .set("x-office-id", "office-secret");

    expect(response.status).toBe(403);
    expect(mocks.getRepRosterOptions).not.toHaveBeenCalled();
  });

  it("refuses to run without an office instead of leaking every office's roster", async () => {
    // dashboardRosterMembershipSql degrades its office test to TRUE when given no office, and `users` is a
    // PUBLIC table — so calling the service with undefined would return every generates_sales user in
    // every office. The service must not be reached at all.
    mocks.user.activeOfficeId = null;
    (mocks.user as any).officeId = null;

    const response = await request(createTestApp()).get("/api/dashboard/rep-roster");

    expect(response.status).toBe(400);
    expect(mocks.getRepRosterOptions).not.toHaveBeenCalled();

    (mocks.user as any).officeId = "office-dallas";
  });

  it("rejects a resolved office the caller has lost access to", async () => {
    // A revoked grant leaves a stale activeOfficeId on the session; re-checking the RESOLVED office (not
    // just a supplied header) is what stops it reading a roster the caller can no longer see.
    mocks.getAccessibleOffices.mockResolvedValue([{ id: "office-atlanta" }]);

    const response = await request(createTestApp()).get("/api/dashboard/rep-roster");

    expect(response.status).toBe(403);
    expect(mocks.getRepRosterOptions).not.toHaveBeenCalled();
  });
});
