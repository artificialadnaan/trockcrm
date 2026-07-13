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

vi.mock("../../../src/modules/reports/monday-showcase-service.js", () => ({
  getMondayShowcaseData: vi.fn(),
  getMondayShowcaseEvidence: vi.fn(),
}));

vi.mock("../../../src/modules/reports/estimator-pipeline-service.js", () => ({
  getEstimatorPipelineReport: vi.fn(),
  getEstimatorPipelineEvidence: vi.fn(),
}));

import { errorHandler } from "../../../src/middleware/error-handler.js";
import * as reportService from "../../../src/modules/reports/service.js";
import * as mondayShowcaseService from "../../../src/modules/reports/monday-showcase-service.js";
import * as estimatorPipelineService from "../../../src/modules/reports/estimator-pipeline-service.js";
import { runReportBuilder } from "../../../src/modules/reports/report-builder-service.js";
import * as savedReportsService from "../../../src/modules/reports/saved-reports-service.js";
import { reportRoutes } from "../../../src/modules/reports/routes.js";

const REPORT_ID = "66666666-6666-4666-8666-666666666666";
const SCHEDULE_ID = "77777777-7777-4777-8777-777777777777";

function buildApp(role: "rep" | "director" | "admin" | "construction" | "field_contractor") {
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

  it("POST /api/reports/run does not require director role", async () => {
    vi.mocked(runReportBuilder).mockResolvedValueOnce({ rows: [], totals: {} } as any);

    const response = await request(buildApp("rep"))
      .post("/api/reports/run")
      .send({ dimensions: [], measures: [] });

    expect(response.status).not.toBe(403);
    expect(response.status).toBe(200);
    expect(runReportBuilder).toHaveBeenCalledOnce();
  });

  it("allows reps to load the Monday showcase and drill evidence", async () => {
    vi.mocked(mondayShowcaseService.getMondayShowcaseData).mockResolvedValueOnce({ period: { mode: "completed" } } as any);
    vi.mocked(mondayShowcaseService.getMondayShowcaseEvidence).mockResolvedValueOnce({ metric: "won", records: [] } as any);

    const showcaseResponse = await request(buildApp("rep")).get("/api/reports/monday-showcase?mode=completed");
    const evidenceResponse = await request(buildApp("rep")).get("/api/reports/monday-showcase/evidence?metric=won");

    expect(showcaseResponse.status).toBe(200);
    expect(showcaseResponse.body).toEqual({ data: { period: { mode: "completed" } } });
    expect(mondayShowcaseService.getMondayShowcaseData).toHaveBeenCalledWith({}, { mode: "completed" });

    expect(evidenceResponse.status).toBe(200);
    expect(evidenceResponse.body).toEqual({ data: { metric: "won", records: [] } });
    expect(mondayShowcaseService.getMondayShowcaseEvidence).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ metric: "won", mode: "to_date" }),
    );
  });

  it("keeps estimator pipeline summaries and project evidence leadership-only", async () => {
    const app = buildApp("rep");

    const summaryResponse = await request(app).get("/api/reports/estimator-pipeline");
    const evidenceResponse = await request(app).get(
      "/api/reports/estimator-pipeline/evidence?bucket=missing",
    );

    expect(summaryResponse.status).toBe(403);
    expect(evidenceResponse.status).toBe(403);
    expect(estimatorPipelineService.getEstimatorPipelineReport).not.toHaveBeenCalled();
    expect(estimatorPipelineService.getEstimatorPipelineEvidence).not.toHaveBeenCalled();
  });

  it("allows directors to load estimator summaries and validated evidence filters", async () => {
    vi.mocked(estimatorPipelineService.getEstimatorPipelineReport).mockResolvedValueOnce({
      pipeline: { count: 0, value: 0 },
    } as any);
    vi.mocked(estimatorPipelineService.getEstimatorPipelineEvidence).mockResolvedValueOnce({
      records: [],
    } as any);
    const app = buildApp("director");

    const summaryResponse = await request(app).get("/api/reports/estimator-pipeline");
    const evidenceResponse = await request(app).get(
      "/api/reports/estimator-pipeline/evidence?bucket=target&estimatorKey=sidney_gibson&stageSlug=estimating&page=2&pageSize=50",
    );

    expect(summaryResponse.status).toBe(200);
    expect(summaryResponse.body).toEqual({ data: { pipeline: { count: 0, value: 0 } } });
    expect(estimatorPipelineService.getEstimatorPipelineReport).toHaveBeenCalledWith({});
    expect(evidenceResponse.status).toBe(200);
    expect(estimatorPipelineService.getEstimatorPipelineEvidence).toHaveBeenCalledWith({}, {
      bucket: "target",
      estimatorKey: "sidney_gibson",
      stageSlug: "estimating",
      page: 2,
      pageSize: 50,
    });
  });

  it("blocks non-CRM roles from report-builder runs", async () => {
    const response = await request(buildApp("construction"))
      .post("/api/reports/run")
      .send({ dimensions: [], measures: [] });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "Requires one of: admin, director, rep" } });
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
      .post(`/api/reports/saved/${REPORT_ID}/runs`)
      .send();

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ run: { id: "run-1", status: "queued" } });
    expect(savedReportsService.createReportRun).toHaveBeenCalledWith({
      reportId: REPORT_ID,
      userId: "user-1",
      officeId: "office-1",
      scheduleId: null,
    });
  });

  it("rejects malformed report ids on report run creation before service execution", async () => {
    const response = await request(buildApp("director"))
      .post("/api/reports/saved/not-a-uuid/runs")
      .send();

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        message: "reportId must be a valid UUID",
      },
    });
    expect(savedReportsService.createReportRun).not.toHaveBeenCalled();
  });

  it("rejects malformed schedule ids on report run creation before service execution", async () => {
    const response = await request(buildApp("director"))
      .post(`/api/reports/saved/${REPORT_ID}/runs`)
      .send({ scheduleId: "not-a-uuid" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        message: "scheduleId must be a valid UUID",
      },
    });
    expect(savedReportsService.createReportRun).not.toHaveBeenCalled();
  });

  it("passes valid schedule ids through report run creation", async () => {
    vi.mocked(savedReportsService.createReportRun).mockResolvedValueOnce({ id: "run-1", status: "queued" } as any);

    const response = await request(buildApp("director"))
      .post(`/api/reports/saved/${REPORT_ID}/runs`)
      .send({ scheduleId: SCHEDULE_ID });

    expect(response.status).toBe(201);
    expect(savedReportsService.createReportRun).toHaveBeenCalledWith({
      reportId: REPORT_ID,
      userId: "user-1",
      officeId: "office-1",
      scheduleId: SCHEDULE_ID,
    });
  });

  it("creates report schedules through the saved report route", async () => {
    vi.mocked(savedReportsService.createReportSchedule).mockResolvedValueOnce({ id: "schedule-1" } as any);

    const payload = {
      frequency: "weekly",
      cronExpr: "0 7 * * 1",
      recipients: [{ email: "director@example.com" }],
      nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
    };

    const response = await request(buildApp("director"))
      .post(`/api/reports/saved/${REPORT_ID}/schedules`)
      .send(payload);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ schedule: { id: "schedule-1" } });
    expect(savedReportsService.createReportSchedule).toHaveBeenCalledWith({
      reportId: REPORT_ID,
      userId: "user-1",
      officeId: "office-1",
      ...payload,
    });
  });

  it("rejects malformed report ids on report schedule creation before service execution", async () => {
    const response = await request(buildApp("director"))
      .post("/api/reports/saved/not-a-uuid/schedules")
      .send({
        frequency: "weekly",
        cronExpr: "0 7 * * 1",
        nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        message: "reportId must be a valid UUID",
      },
    });
    expect(savedReportsService.createReportSchedule).not.toHaveBeenCalled();
  });

  it("rejects invalid report schedule frequencies before service execution", async () => {
    const response = await request(buildApp("director"))
      .post(`/api/reports/saved/${REPORT_ID}/schedules`)
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

  it("rejects invalid nextRunAt timestamps before service execution", async () => {
    const response = await request(buildApp("director"))
      .post(`/api/reports/saved/${REPORT_ID}/schedules`)
      .send({
        frequency: "weekly",
        cronExpr: "0 7 * * 1",
        nextRunAt: "not-a-date",
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        message: "nextRunAt must be a valid ISO timestamp",
      },
    });
    expect(savedReportsService.createReportSchedule).not.toHaveBeenCalled();
  });

  it("rejects past nextRunAt timestamps before service execution", async () => {
    const response = await request(buildApp("director"))
      .post(`/api/reports/saved/${REPORT_ID}/schedules`)
      .send({
        frequency: "weekly",
        cronExpr: "0 7 * * 1",
        nextRunAt: "2020-01-01T12:00:00.000Z",
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        message: "nextRunAt must be in the future",
      },
    });
    expect(savedReportsService.createReportSchedule).not.toHaveBeenCalled();
  });
});
