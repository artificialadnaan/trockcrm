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
  getReportSchedules: vi.fn(),
  createReportSchedule: vi.fn(),
  getReportRuns: vi.fn(),
  createReportRun: vi.fn(),
}));

vi.mock("../../../src/modules/reports/report-builder-service.js", () => ({
  runReportBuilder: vi.fn(),
}));

import { errorHandler } from "../../../src/middleware/error-handler.js";
import * as reportService from "../../../src/modules/reports/service.js";
import { runReportBuilder } from "../../../src/modules/reports/report-builder-service.js";
import * as savedReportsService from "../../../src/modules/reports/saved-reports-service.js";
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

  it("lists report schedules and runs using existing saved report visibility context", async () => {
    vi.mocked(savedReportsService.getReportSchedules).mockResolvedValueOnce([{ id: "schedule-1" }] as any);
    vi.mocked(savedReportsService.getReportRuns).mockResolvedValueOnce([{ id: "run-1" }] as any);

    const app = buildApp("director");

    const schedulesResponse = await request(app).get("/api/reports/schedules");
    const runsResponse = await request(app).get("/api/reports/runs");

    expect(schedulesResponse.status).toBe(200);
    expect(schedulesResponse.body).toEqual({ schedules: [{ id: "schedule-1" }] });
    expect(savedReportsService.getReportSchedules).toHaveBeenCalledWith("user-1", "office-1");

    expect(runsResponse.status).toBe(200);
    expect(runsResponse.body).toEqual({ runs: [{ id: "run-1" }] });
    expect(savedReportsService.getReportRuns).toHaveBeenCalledWith("user-1", "office-1");
  });

  it("creates report run rows with queued status through the saved report route", async () => {
    vi.mocked(savedReportsService.createReportRun).mockResolvedValueOnce({ id: "run-1", status: "queued" } as any);

    const response = await request(buildApp("director"))
      .post("/api/reports/saved/report-1/runs")
      .send();

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ run: { id: "run-1", status: "queued" } });
    expect(savedReportsService.createReportRun).toHaveBeenCalledWith({
      reportId: "report-1",
      userId: "user-1",
      officeId: "office-1",
      scheduleId: null,
    });
  });

  it("creates report schedules through the saved report route", async () => {
    vi.mocked(savedReportsService.createReportSchedule).mockResolvedValueOnce({ id: "schedule-1" } as any);

    const payload = {
      frequency: "weekly",
      cronExpr: "0 7 * * 1",
      recipients: [{ email: "director@example.com" }],
      nextRunAt: "2026-05-11T12:00:00.000Z",
    };

    const response = await request(buildApp("director"))
      .post("/api/reports/saved/report-1/schedules")
      .send(payload);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ schedule: { id: "schedule-1" } });
    expect(savedReportsService.createReportSchedule).toHaveBeenCalledWith({
      reportId: "report-1",
      userId: "user-1",
      officeId: "office-1",
      ...payload,
    });
  });

  it("rejects invalid report schedule frequencies before service execution", async () => {
    const response = await request(buildApp("director"))
      .post("/api/reports/saved/report-1/schedules")
      .send({
        frequency: "hourly",
        cronExpr: "0 7 * * 1",
        nextRunAt: "2026-05-11T12:00:00.000Z",
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        message: "frequency must be one of: daily, weekly, biweekly, monthly, quarterly",
      },
    });
    expect(savedReportsService.createReportSchedule).not.toHaveBeenCalled();
  });
});
