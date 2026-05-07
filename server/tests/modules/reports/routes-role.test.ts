import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/modules/reports/service.js", () => ({
  getPipelineSummary: vi.fn(),
  getWeightedPipelineForecast: vi.fn(),
  getWinLossRatioByRep: vi.fn(),
  getWinRateTrend: vi.fn(),
  getUnifiedWorkflowOverview: vi.fn(),
  getActivitySummaryByRep: vi.fn(),
  getStaleDeals: vi.fn(),
  getLostDealsByReason: vi.fn(),
  getRevenueByProjectType: vi.fn(),
  getLeadSourceROI: vi.fn(),
  getForecastVarianceOverview: vi.fn(),
  getFollowUpCompliance: vi.fn(),
  getDdVsPipeline: vi.fn(),
  getClosedWonSummary: vi.fn(),
  getRegionalOwnershipOverview: vi.fn(),
  getPipelineByRep: vi.fn(),
  getDataMiningOverview: vi.fn(),
  executeCustomReport: vi.fn(),
  getRepPerformanceComparison: vi.fn(),
  normalizeAnalyticsFilters: vi.fn((input) => input),
}));

vi.mock("../../../src/modules/reports/saved-reports-service.js", () => ({
  getSavedReports: vi.fn(),
  getSavedReportById: vi.fn(),
  createSavedReport: vi.fn(),
  updateSavedReport: vi.fn(),
  deleteSavedReport: vi.fn(),
  seedLockedReports: vi.fn(),
}));

vi.mock("../../../src/modules/reports/report-builder-service.js", () => ({
  runReportBuilder: vi.fn(),
}));

import { errorHandler } from "../../../src/middleware/error-handler.js";
import * as reportService from "../../../src/modules/reports/service.js";
import { runReportBuilder } from "../../../src/modules/reports/report-builder-service.js";
import { reportRoutes } from "../../../src/modules/reports/routes.js";

function buildApp(role: "rep" | "director" | "admin") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = {
      id: "user-1",
      role,
      officeId: "office-1",
      activeOfficeId: "office-1",
    };
    req.tenantDb = {};
    req.commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/reports", reportRoutes);
  app.use(errorHandler);
  return app;
}

describe("report route role guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks reps from executing ad-hoc custom report configs", async () => {
    const response = await request(buildApp("rep"))
      .post("/api/reports/execute")
      .send({ config: { entity: "deals", columns: [] } });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "Requires one of: admin, director" } });
    expect(reportService.executeCustomReport).not.toHaveBeenCalled();
  });

  it("blocks reps from running ad-hoc report-builder queries", async () => {
    const response = await request(buildApp("rep"))
      .post("/api/reports/run")
      .send({ dimensions: [], measures: [] });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "Requires one of: admin, director" } });
    expect(runReportBuilder).not.toHaveBeenCalled();
  });

  it("allows directors to execute ad-hoc custom reports", async () => {
    vi.mocked(reportService.executeCustomReport).mockResolvedValueOnce({ rows: [], total: 0 } as any);

    const response = await request(buildApp("director"))
      .post("/api/reports/execute")
      .send({ config: { entity: "deals", columns: [] } });

    expect(response.status).toBe(200);
    expect(reportService.executeCustomReport).toHaveBeenCalledOnce();
  });
});
