import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: mocks.apiMock,
}));

describe("use-reports helpers", () => {
  beforeEach(() => {
    mocks.apiMock.mockReset();
  });

  it("requests workflow overview data and preserves the expanded unified workflow fields", async () => {
    const { executeWorkflowOverview } = await import("./use-reports");

    mocks.apiMock.mockResolvedValue({
      data: {
        leadPipelineSummary: [],
        standardVsServiceRollups: [],
        companyRollups: [],
        repActivitySplit: [],
        staleLeads: [],
        staleDeals: [],
        crmOwnedProgression: [
          {
            workflowBucket: "opportunity",
            workflowRoute: "service",
            stageName: "Opportunity",
            itemCount: 3,
            totalValue: 450000,
          },
        ],
        mirroredDownstreamSummary: [
          {
            mirroredStageSlug: "estimating",
            mirroredStageName: "Estimating",
            mirroredStageStatus: "blocked",
            workflowRoute: "service",
            dealCount: 2,
            totalValue: 275000,
          },
        ],
        reasonCodedDisqualifications: [
          {
            workflowRoute: "normal",
            disqualificationReason: "other",
            leadCount: 1,
          },
        ],
      },
    });

    const result = await executeWorkflowOverview({ from: "2026-01-01", to: "2026-01-31" });

    expect(mocks.apiMock).toHaveBeenCalledWith("/reports/workflow-overview?from=2026-01-01&to=2026-01-31");
    expect(result.data.crmOwnedProgression[0].stageName).toBe("Opportunity");
    expect(result.data.mirroredDownstreamSummary[0].mirroredStageName).toBe("Estimating");
    expect(result.data.reasonCodedDisqualifications[0].disqualificationReason).toBe("other");
  });

  it("adds schedule and run helpers without replacing saved reports helpers", async () => {
    const {
      createReportRun,
      createReportSchedule,
      listReportRuns,
      listReportSchedules,
    } = await import("./use-reports");

    mocks.apiMock
      .mockResolvedValueOnce({ run: { id: "run-1" } })
      .mockResolvedValueOnce({ schedule: { id: "schedule-1" } })
      .mockResolvedValueOnce({ runs: [] })
      .mockResolvedValueOnce({ schedules: [] });

    await createReportRun("report-1");
    await createReportSchedule("report-1", {
      frequency: "weekly",
      cronExpr: "0 7 * * 1",
      recipients: [{ email: "director@example.com" }],
      nextRunAt: "2026-05-11T12:00:00.000Z",
    });
    await listReportRuns();
    await listReportSchedules();

    expect(mocks.apiMock).toHaveBeenNthCalledWith(1, "/reports/saved/report-1/runs", {
      method: "POST",
    });
    expect(mocks.apiMock).toHaveBeenNthCalledWith(2, "/reports/saved/report-1/schedules", {
      method: "POST",
      json: {
        frequency: "weekly",
        cronExpr: "0 7 * * 1",
        recipients: [{ email: "director@example.com" }],
        nextRunAt: "2026-05-11T12:00:00.000Z",
      },
    });
    expect(mocks.apiMock).toHaveBeenNthCalledWith(3, "/reports/runs");
    expect(mocks.apiMock).toHaveBeenNthCalledWith(4, "/reports/schedules");
  });
});
