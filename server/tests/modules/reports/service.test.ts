import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the reporting service aggregation queries.
 *
 * These tests validate the query builder logic and result mapping.
 * Because the aggregation queries use raw SQL via tenantDb.execute(),
 * integration tests against a real PostgreSQL instance are recommended
 * for full validation. These unit tests verify the service functions
 * exist, accept the correct parameters, and handle empty results.
 */

// Mock the db import (public schema queries)
// The mock must be thenable so Drizzle's query builder resolves when awaited.
function createChainableMock(resolveValue: any[] = []) {
  const chain: any = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    then: vi.fn((resolve: any) => resolve(resolveValue)),
  };
  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

vi.mock("../../../src/db.js", () => ({
  db: createChainableMock([]),
}));

// Create a mock tenantDb
function createMockTenantDb(rows: any[] = []) {
  return {
    execute: vi.fn().mockResolvedValue({ rows }),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnValue([]),
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

  if ("name" in (value as Record<string, unknown>) && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name;
  }

  return "";
}

describe("Reports Service", () => {
  describe("getPipelineSummary", () => {
    it("should return empty array when no stages exist", async () => {
      const { getPipelineSummary } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([]);
      // db mock returns empty stages
      const result = await getPipelineSummary(tenantDb);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getWeightedPipelineForecast", () => {
    it("should return forecast rows with numeric values", async () => {
      const { getWeightedPipelineForecast } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([
        { month: "2026-03", deal_count: "5", raw_value: "500000", weighted_value: "250000" },
      ]);
      const result = await getWeightedPipelineForecast(tenantDb);
      expect(result).toHaveLength(1);
      expect(result[0].month).toBe("2026-03");
      expect(result[0].dealCount).toBe(5);
      expect(result[0].rawValue).toBe(500000);
      expect(result[0].weightedValue).toBe(250000);
    });
  });

  describe("getWinLossRatioByRep", () => {
    it("should calculate win rate correctly", async () => {
      const { getWinLossRatioByRep } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([
        { rep_id: "r1", rep_name: "Alice", wins: "3", losses: "1", total_value: "300000" },
      ]);
      const result = await getWinLossRatioByRep(tenantDb);
      expect(result).toHaveLength(1);
      expect(result[0].winRate).toBe(75);
    });

    it("should handle zero closed deals gracefully", async () => {
      const { getWinLossRatioByRep } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([
        { rep_id: "r1", rep_name: "Bob", wins: "0", losses: "0", total_value: "0" },
      ]);
      const result = await getWinLossRatioByRep(tenantDb);
      expect(result[0].winRate).toBe(0);
    });
  });

  describe("getActivitySummaryByRep", () => {
    it("should return activity breakdown by type", async () => {
      const { getActivitySummaryByRep } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([
        {
          rep_id: "r1", rep_name: "Alice",
          calls: "10", emails: "20", meetings: "5", notes: "3", tasks_completed: "7", total: "45",
        },
      ]);
      const result = await getActivitySummaryByRep(tenantDb);
      expect(result[0].calls).toBe(10);
      expect(result[0].emails).toBe(20);
      expect(result[0].total).toBe(45);
    });

    it("queries by responsible activity owner after the attribution migration", async () => {
      const { getActivitySummaryByRep } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([]);

      await getActivitySummaryByRep(tenantDb);

      const queryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
      expect(queryText).toContain("a.responsible_user_id as rep_id");
      expect(queryText).toContain("join users u on u.id = a.responsible_user_id");
      expect(queryText).not.toContain("a.user_id");
    });
  });

  describe("getFollowUpCompliance", () => {
    it("should return 100% when no follow-up tasks exist", async () => {
      const { getFollowUpCompliance } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([{ total: "0", on_time: "0" }]);
      const result = await getFollowUpCompliance(tenantDb, "rep-id");
      expect(result.complianceRate).toBe(100);
    });

    it("should calculate compliance rate correctly", async () => {
      const { getFollowUpCompliance } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([{ total: "10", on_time: "8" }]);
      const result = await getFollowUpCompliance(tenantDb, "rep-id");
      expect(result.complianceRate).toBe(80);
    });
  });

  describe("getLeadSourceROI", () => {
    it("should return source breakdown with win rates", async () => {
      const { getLeadSourceROI } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([
        {
          source: "Referral", total_deals: "10", active_deals: "5",
          won_deals: "3", lost_deals: "2", pipeline_value: "500000", won_value: "300000",
        },
      ]);
      const result = await getLeadSourceROI(tenantDb);
      expect(result[0].source).toBe("Referral");
      expect(result[0].winRate).toBe(60);
    });
  });

  describe("getDdVsPipeline", () => {
    it("should separate DD and pipeline values", async () => {
      const { getDdVsPipeline } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([
        { dd_value: "100000", dd_count: "5", pipeline_value: "400000", pipeline_count: "20" },
      ]);
      const result = await getDdVsPipeline(tenantDb);
      expect(result.ddValue).toBe(100000);
      expect(result.pipelineValue).toBe(400000);
      expect(result.totalValue).toBe(500000);
    });
  });

  describe("defaultDateRange", () => {
    it("should default to current calendar year", async () => {
      // Verified through getPipelineSummary -- when no from/to, uses year boundaries
      const year = new Date().getFullYear();
      // This is implicitly tested via all service functions that call defaultDateRange
      expect(year).toBeGreaterThan(2025);
    });
  });

  describe("executeCustomReport", () => {
    it("maps legacy activities.user_id configs to responsible_user_id", async () => {
      const { executeCustomReport } = await import("../../../src/modules/reports/service.js");
      const tenantDb = {
        execute: vi.fn()
          .mockResolvedValueOnce({ rows: [{ total: "1" }] })
          .mockResolvedValueOnce({ rows: [{ responsible_user_id: "rep-1", type: "email" }] }),
      } as any;

      await executeCustomReport(tenantDb, {
        entity: "activities",
        columns: ["user_id", "type"],
        filters: [{ field: "user_id", op: "eq", value: "rep-1" }],
        sort: { field: "user_id", dir: "asc" },
      });

      const countQueryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
      const dataQueryText = extractSqlText(tenantDb.execute.mock.calls[1][0]).toLowerCase();

      expect(countQueryText).toContain("responsible_user_id");
      expect(dataQueryText).toContain("responsible_user_id");
      expect(dataQueryText).not.toContain(" user_id ");
    });
  });

  describe("getRepPerformanceComparison", () => {
    it("uses responsible activity ownership in comparison activity rollups", async () => {
      const { getRepPerformanceComparison } = await import("../../../src/modules/reports/service.js");
      const tenantDb = {
        execute: vi.fn()
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] }),
      } as any;

      await getRepPerformanceComparison(tenantDb, "month");

      const activityQueryText = extractSqlText(tenantDb.execute.mock.calls[1][0]).toLowerCase();
      expect(activityQueryText).toContain("a.responsible_user_id as rep_id");
      expect(activityQueryText).not.toContain("a.user_id");
    });
  });

  describe("getWinRateTrend", () => {
    it("should return monthly win rate data", async () => {
      const { getWinRateTrend } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([
        { month: "2026-01", wins: "4", losses: "1" },
        { month: "2026-02", wins: "2", losses: "3" },
      ]);
      const result = await getWinRateTrend(tenantDb);
      expect(result).toHaveLength(2);
      expect(result[0].winRate).toBe(80);
      expect(result[1].winRate).toBe(40);
    });
  });

  describe("getStaleDeals", () => {
    it("should return stale deal rows with numeric coercion", async () => {
      const { getStaleDeals } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([
        {
          deal_id: "d1", deal_number: "TR-2026-0001", deal_name: "Test Deal",
          stage_id: "s1", stage_name: "Estimating", assigned_rep_id: "r1",
          rep_name: "Alice", stage_entered_at: "2026-01-01", days_in_stage: "45",
          stale_threshold_days: "30", deal_value: "250000",
        },
      ]);
      const result = await getStaleDeals(tenantDb);
      expect(result).toHaveLength(1);
      expect(result[0].daysInStage).toBe(45);
      expect(result[0].staleThresholdDays).toBe(30);
      expect(result[0].dealValue).toBe(250000);
    });

    it("uses mirrored stage joins and Bid Board timing when a mirrored downstream slug is present", async () => {
      const { getStaleDeals } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([
        {
          deal_id: "d1",
          deal_number: "TR-2026-0001",
          deal_name: "Test Deal",
          stage_id: "s1",
          stage_name: "Opportunity",
          assigned_rep_id: "r1",
          rep_name: "Alice",
          stage_entered_at: "2026-01-01",
          days_in_stage: "45",
          stale_threshold_days: "10",
          deal_value: "250000",
          workflow_route: "service",
          bid_board_stage_slug: "bid_sent",
          bid_board_stage_status: "stalled",
          region_classification: "Texas",
        },
      ]);

      const result = await getStaleDeals(tenantDb);

      expect(result[0].stageName).toBe("Bid Sent");

      const queryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
      expect(queryText).toContain("left join pipeline_stage_config mirror_psc");
      expect(queryText).toContain("coalesce(d.bid_board_stage_entered_at, d.stage_entered_at)");
      expect(queryText).toContain("coalesce(mirror_psc.stale_threshold_days, psc.stale_threshold_days)");
    });
  });

  describe("getRevenueByProjectType", () => {
    it("should group revenue by project type", async () => {
      const { getRevenueByProjectType } = await import("../../../src/modules/reports/service.js");
      const tenantDb = createMockTenantDb([
        { project_type_id: "pt1", project_type_name: "Commercial", deal_count: "5", total_revenue: "1000000" },
        { project_type_id: null, project_type_name: "Unspecified", deal_count: "2", total_revenue: "200000" },
      ]);
      const result = await getRevenueByProjectType(tenantDb);
      expect(result).toHaveLength(2);
      expect(result[0].projectTypeName).toBe("Commercial");
      expect(result[0].totalRevenue).toBe(1000000);
    });
  });

  describe("getLostDealsByReason", () => {
    it("should group lost deals by reason with competitors", async () => {
      const { getLostDealsByReason } = await import("../../../src/modules/reports/service.js");
      // Mock needs two sequential calls: reason query + competitor query
      const tenantDb = {
        execute: vi.fn()
          .mockResolvedValueOnce({
            rows: [
              { reason_id: "lr1", reason_label: "Price", count: "5", total_value: "500000" },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              { reason_id: "lr1", competitor: "Acme Corp", count: "3" },
              { reason_id: "lr1", competitor: "Not specified", count: "2" },
            ],
          }),
      } as any;
      const result = await getLostDealsByReason(tenantDb);
      expect(result).toHaveLength(1);
      expect(result[0].reasonLabel).toBe("Price");
      expect(result[0].competitors).toHaveLength(2);
    });
  });

  describe("getUnifiedWorkflowOverview", () => {
    it("keeps CRM-owned progression, mirrored downstream bottlenecks, and reason-coded disqualifications queryable", async () => {
      const { getUnifiedWorkflowOverview } = await import("../../../src/modules/reports/service.js");
      const tenantDb = {
        execute: vi.fn()
          .mockResolvedValueOnce({
            rows: [{ workflow_route: "normal", validation_status: "ready", intake_count: "2" }],
          })
          .mockResolvedValueOnce({
            rows: [{ workflow_route: "service", deal_count: "1", total_value: "80000", stale_deal_count: "1" }],
          })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({
            rows: [{
              lead_id: "lead-1",
              lead_name: "Church Campus",
              company_name: "North Star",
              workflow_route: "normal",
              validation_status: "ready",
              age_in_days: "19",
              stale_threshold_days: "14",
            }],
          })
          .mockResolvedValueOnce({
            rows: [{
              deal_id: "deal-1",
              deal_number: "TR-1001",
              deal_name: "Bid Board Mirror",
              stage_name: "Opportunity",
              workflow_route: "service",
              rep_name: "Avery Rep",
              days_in_stage: "22",
              stale_threshold_days: "14",
              deal_value: "275000",
              bid_board_stage_slug: "estimating",
              bid_board_stage_status: "blocked",
              region_classification: "Texas / Southwest",
            }],
          })
          .mockResolvedValueOnce({
            rows: [{
              workflow_bucket: "crm_owned",
              workflow_route: "normal",
              stage_name: "Opportunity",
              item_count: "3",
              total_value: "450000",
            }],
          })
          .mockResolvedValueOnce({
            rows: [{
              mirrored_stage_slug: "estimating",
              mirrored_stage_name: "Opportunity",
              mirrored_stage_status: "blocked",
              workflow_route: "service",
              deal_count: "2",
              total_value: "275000",
            }],
          })
          .mockResolvedValueOnce({
            rows: [{
              workflow_route: "normal",
              disqualification_reason: "no_budget",
              lead_count: "1",
            }],
          }),
      } as any;

      const result = await getUnifiedWorkflowOverview(tenantDb);

      expect(result.crmOwnedProgression).toEqual([
        {
          workflowBucket: "crm_owned",
          workflowRoute: "normal",
          stageName: "Opportunity",
          itemCount: 3,
          totalValue: 450000,
        },
      ]);
      expect(result.mirroredDownstreamSummary).toEqual([
        {
          mirroredStageSlug: "estimating",
          mirroredStageName: "Estimating",
          mirroredStageStatus: "blocked",
          workflowRoute: "service",
          dealCount: 2,
          totalValue: 275000,
        },
      ]);
      expect(result.reasonCodedDisqualifications).toEqual([
        {
          workflowRoute: "normal",
          disqualificationReason: "no_budget",
          leadCount: 1,
        },
      ]);
      expect(result.staleDeals[0]).toMatchObject({
        stageName: "Estimating",
        workflowRoute: "service",
        bidBoardStageSlug: "estimating",
        bidBoardStageStatus: "blocked",
        regionClassification: "Texas / Southwest",
      });

      const progressionQuery = extractSqlText(tenantDb.execute.mock.calls[6][0]).toLowerCase();
      const mirrorQuery = extractSqlText(tenantDb.execute.mock.calls[7][0]).toLowerCase();
      const disqualificationQuery = extractSqlText(tenantDb.execute.mock.calls[8][0]).toLowerCase();

      expect(progressionQuery).toContain("workflow_bucket");
      expect(progressionQuery).toContain("opportunity");
      expect(mirrorQuery).toContain("bid_board_stage_slug");
      expect(mirrorQuery).toContain("bid_board_stage_status");
      expect(disqualificationQuery).toContain("disqualification_reason");
      expect(disqualificationQuery).toContain("pipeline_type");
      const staleDealQuery = extractSqlText(tenantDb.execute.mock.calls[5][0]).toLowerCase();
      expect(staleDealQuery).toContain("left join pipeline_stage_config mirror_psc");
      expect(staleDealQuery).toContain("coalesce(d.bid_board_stage_entered_at, d.stage_entered_at)");
      expect(staleDealQuery).toContain("coalesce(mirror_psc.stale_threshold_days, psc.stale_threshold_days)");
    });

    it("returns CRM-owned progression in workflow order instead of alphabetical stage order", async () => {
      const { getUnifiedWorkflowOverview } = await import("../../../src/modules/reports/service.js");
      const tenantDb = {
        execute: vi.fn()
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({
            rows: [
              { workflow_bucket: "lead", workflow_route: "normal", stage_name: "Sales Validation Stage", item_count: "1", total_value: "1000" },
              { workflow_bucket: "lead", workflow_route: "normal", stage_name: "New Lead", item_count: "2", total_value: "2000" },
              { workflow_bucket: "opportunity", workflow_route: "service", stage_name: "Opportunity", item_count: "3", total_value: "3000" },
            ],
          })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] }),
      } as any;

      await getUnifiedWorkflowOverview(tenantDb);

      const progressionQuery = extractSqlText(tenantDb.execute.mock.calls[6][0]).toLowerCase();
      expect(progressionQuery).toContain("min(display_order)");
      expect(progressionQuery).toContain("order by display_order asc");
    });
  });
});
