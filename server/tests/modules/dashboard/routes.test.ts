import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getRepDashboardMock = vi.hoisted(() => vi.fn());
const commitTransactionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../../../server/src/modules/dashboard/service.js", () => ({
  getRepDashboard: getRepDashboardMock,
  getDirectorDashboard: vi.fn(),
  getRepDetail: vi.fn(),
}));

import { dashboardRoutes } from "../../../../server/src/modules/dashboard/routes.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: "rep-1",
      email: "rep@trock.dev",
      displayName: "Rep One",
      role: "rep",
      officeId: "office-1",
      activeOfficeId: "office-1",
    };
    req.tenantDb = {
      execute: vi.fn(),
    };
    req.commitTransaction = commitTransactionMock;
    next();
  });
  app.use("/api/dashboard", dashboardRoutes);
  return app;
}

describe("dashboard routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commitTransactionMock.mockResolvedValue(undefined);
  });

  it("serves GET /api/dashboard/rep with the cleanup summary envelope", async () => {
    getRepDashboardMock.mockResolvedValue({
      activeDeals: { count: 3, totalValue: 125000 },
      tasksToday: { overdue: 0, today: 1 },
      activityThisWeek: { calls: 2, emails: 3, meetings: 1, notes: 0, total: 6 },
      followUpCompliance: { total: 4, onTime: 4, complianceRate: 100 },
      pipelineByStage: [],
      staleLeads: { count: 0, averageDaysInStage: null, leads: [] },
      myCleanup: {
        total: 2,
        byReason: [
          { reasonCode: "missing_next_step", count: 1 },
          { reasonCode: "stale_no_recent_activity", count: 1 },
        ],
      },
    });

    const response = await request(buildApp()).get("/api/dashboard/rep");

    expect(response.status).toBe(200);
    expect(getRepDashboardMock).toHaveBeenCalledOnce();
    expect(getRepDashboardMock).toHaveBeenCalledWith(expect.anything(), "rep-1", { range: undefined });
    expect(commitTransactionMock).toHaveBeenCalledOnce();
    expect(response.body).toEqual({
      data: {
        activeDeals: { count: 3, totalValue: 125000 },
        tasksToday: { overdue: 0, today: 1 },
        activityThisWeek: { calls: 2, emails: 3, meetings: 1, notes: 0, total: 6 },
        followUpCompliance: { total: 4, onTime: 4, complianceRate: 100 },
        pipelineByStage: [],
        staleLeads: { count: 0, averageDaysInStage: null, leads: [] },
        myCleanup: {
          total: 2,
          byReason: [
            { reasonCode: "missing_next_step", count: 1 },
            { reasonCode: "stale_no_recent_activity", count: 1 },
          ],
        },
      },
    });
  });
});
