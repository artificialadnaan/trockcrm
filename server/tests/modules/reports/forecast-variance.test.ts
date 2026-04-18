import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reportRouteMocks = vi.hoisted(() => ({
  requireDirector: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock("../../../src/middleware/rbac.js", () => ({
  requireRole: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  requireDirector: reportRouteMocks.requireDirector,
}));

const { reportRoutes } = await import("../../../src/modules/reports/routes.js");

function createMockTenantDb(rows: any[] = []) {
  const queue = Array.isArray(rows[0]) ? [...(rows as any[][])] : [rows];
  return {
    execute: vi.fn().mockImplementation(async () => ({ rows: queue.shift() ?? [] })),
  } as any;
}

function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }

  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }

  return "";
}

describe("forecast milestone helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives forecast amount from awarded, bid, then dd values", async () => {
    const { deriveForecastAmount } = await import("../../../src/modules/reports/forecast-milestones-service.js");

    expect(deriveForecastAmount({ awardedAmount: "150000", bidEstimate: "120000", ddEstimate: "90000" })).toBe(150000);
    expect(deriveForecastAmount({ awardedAmount: null, bidEstimate: "120000", ddEstimate: "90000" })).toBe(120000);
    expect(deriveForecastAmount({ awardedAmount: null, bidEstimate: null, ddEstimate: "90000" })).toBe(90000);
  });

  it("captures dd, estimating, and closed_won milestones only once", async () => {
    const { captureStageDrivenForecastMilestone } = await import("../../../src/modules/reports/forecast-milestones-service.js");
    const tenantDb = createMockTenantDb([[], []]);

    await captureStageDrivenForecastMilestone(tenantDb, {
      deal: {
        id: "deal-1",
        assignedRepId: "rep-1",
        workflowRoute: "estimating",
        ddEstimate: "100000",
        bidEstimate: "120000",
        awardedAmount: "130000",
        stageId: "stage-dd",
        expectedCloseDate: "2026-05-01",
        source: "Trade Show",
      },
      currentStage: { slug: "lead" },
      targetStage: { slug: "dd" },
      userId: "user-1",
    });

    expect(tenantDb.execute).toHaveBeenCalledTimes(2);
  });

  it("builds initial and closed_won backfill rows from safe sources", async () => {
    const { buildForecastMilestoneBackfillRows } = await import("../../../src/modules/reports/forecast-milestones-service.js");

    const rows = buildForecastMilestoneBackfillRows({
      dealId: "deal-1",
      source: "Trade Show",
      workflowRoute: "estimating",
      stageId: "stage-1",
      assignedRepId: "rep-1",
      auditInsertRow: {
        full_row: {
          dd_estimate: "90000",
          bid_estimate: null,
          awarded_amount: null,
          expected_close_date: "2026-04-01",
        },
      },
      closedWonDealRow: {
        awardedAmount: "125000",
        expectedCloseDate: "2026-04-01",
        actualCloseDate: "2026-04-15",
      },
    });

    expect(rows.map((row) => row.milestoneKey)).toEqual(["initial", "closed_won"]);
    expect(rows[0].captureSource).toBe("audit_backfill");
    expect(rows[1].forecastAmount).toBe("125000");
  });
});

describe("forecast variance reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns summary, rep rollups, and deal rows", async () => {
    const { getForecastVarianceOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = createMockTenantDb([
      [{ comparable_deals: "3", avg_initial_variance: "15000", avg_qualified_variance: "10000", avg_estimating_variance: "4000", avg_close_drift_days: "12" }],
      [{ rep_id: "rep-1", rep_name: "Jordan", comparable_deals: "2", avg_initial_variance: "12000", avg_qualified_variance: "8000", avg_estimating_variance: "4000", avg_close_drift_days: "10" }],
      [{ deal_id: "deal-1", deal_name: "North Plaza", rep_name: "Jordan", workflow_route: "estimating", initial_forecast: "100000", qualified_forecast: "110000", estimating_forecast: "120000", awarded_amount: "125000", initial_variance: "25000", qualified_variance: "15000", estimating_variance: "5000", close_drift_days: "7" }],
    ]);

    const result = await getForecastVarianceOverview(tenantDb, { officeId: "office-1" });

    expect(result.summary.comparableDeals).toBe(3);
    expect(result.repRollups[0].repName).toBe("Jordan");
    expect(result.deals[0].dealName).toBe("North Plaza");
  });

  it("scopes forecast variance to current office and shared analytics filters", async () => {
    const { getForecastVarianceOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = createMockTenantDb([[], [], []]);

    await getForecastVarianceOverview(tenantDb, {
      officeId: "office-1",
      regionId: "region-1",
      repId: "rep-1",
      source: "Trade Show",
    });

    const queryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    expect(queryText).toContain("dsi.office_id");
    expect(queryText).toContain("d.region_id");
    expect(queryText).toContain("d.assigned_rep_id");
    expect(queryText).toContain("d.source");
  });
});

describe("forecast variance route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes active office scope into the forecast variance route", async () => {
    const reportsService = await import("../../../src/modules/reports/service.js");
    const spy = vi.spyOn(reportsService, "getForecastVarianceOverview").mockResolvedValue({
      summary: {
        comparableDeals: 0,
        avgInitialVariance: 0,
        avgQualifiedVariance: 0,
        avgEstimatingVariance: 0,
        avgCloseDriftDays: 0,
      },
      repRollups: [],
      deals: [],
    });

    const app = express();
    app.use((req: any, _res, next) => {
      req.user = { role: "director", officeId: "office-1", activeOfficeId: "office-2" };
      req.tenantDb = {};
      req.commitTransaction = vi.fn().mockResolvedValue(undefined);
      next();
    });
    app.use("/api/reports", reportRoutes);

    const response = await request(app).get("/api/reports/forecast-variance?from=2026-01-01&to=2026-12-31");

    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        officeId: "office-2",
        from: "2026-01-01",
        to: "2026-12-31",
      })
    );
  });
});
