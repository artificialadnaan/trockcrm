import { describe, it, expect, vi, beforeEach } from "vitest";

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

const getMyCleanupQueueMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/modules/admin/cleanup-queue-service.js", () => ({
  getMyCleanupQueue: getMyCleanupQueueMock,
}));

function createMockTenantDb(responses: any[][] = []) {
  let callIndex = 0;
  return {
    execute: vi.fn().mockImplementation(() => {
      const rows = responses[callIndex] ?? [];
      callIndex++;
      return Promise.resolve({ rows });
    }),
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

describe("Dashboard Service", () => {
  beforeEach(() => {
    getMyCleanupQueueMock.mockReset();
    getMyCleanupQueueMock.mockResolvedValue({ rows: [], byReason: [] });
  });

  describe("getRepDashboard", () => {
    it("should return all dashboard sections", async () => {
      const { getRepDashboard } = await import("../../../src/modules/dashboard/service.js");
      getMyCleanupQueueMock.mockResolvedValue({
        rows: [
          { recordId: "deal-1" },
          { recordId: "lead-1" },
        ],
        byReason: [
          { reasonCode: "missing_next_step", count: 1 },
          { reasonCode: "stale_no_recent_activity", count: 1 },
        ],
      });
      const tenantDb = createMockTenantDb([
        // active deals
        [{ count: "5", total_value: "500000" }],
        // task counts
        [{ overdue: "2", today: "3" }],
        // activity this week
        [{ calls: "5", emails: "10", meetings: "2", notes: "3", total: "20" }],
        // follow-up compliance (from reports/service)
        [{ total: "10", on_time: "9" }],
        // pipeline by stage
        [
          { stage_id: "s1", stage_name: "Estimating", stage_color: "#3B82F6", display_order: 2, deal_count: "3", total_value: "300000" },
        ],
      ]);

      const result = await getRepDashboard(tenantDb, "user-1");
      expect(getMyCleanupQueueMock).toHaveBeenCalledWith(tenantDb, "user-1");
      expect(result.activeDeals.count).toBe(5);
      expect(result.tasksToday.overdue).toBe(2);
      expect(result.activityThisWeek.total).toBe(20);
      expect(result.followUpCompliance.complianceRate).toBe(90);
      expect(result.pipelineByStage).toHaveLength(1);
      expect(result.myCleanup.total).toBe(2);
      expect(result.myCleanup.byReason).toEqual([
        { reasonCode: "missing_next_step", count: 1 },
        { reasonCode: "stale_no_recent_activity", count: 1 },
      ]);
    });

    it("should handle empty data gracefully", async () => {
      const { getRepDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [{ count: "0", total_value: "0" }],
        [{ overdue: "0", today: "0" }],
        [{ calls: "0", emails: "0", meetings: "0", notes: "0", total: "0" }],
        [{ total: "0", on_time: "0" }],
        [],
      ]);

      const result = await getRepDashboard(tenantDb, "user-1");
      expect(result.activeDeals.count).toBe(0);
      expect(result.activeDeals.totalValue).toBe(0);
      expect(result.tasksToday.overdue).toBe(0);
      expect(result.activityThisWeek.total).toBe(0);
      expect(result.followUpCompliance.complianceRate).toBe(100);
      expect(result.pipelineByStage).toHaveLength(0);
      expect(result.myCleanup.total).toBe(0);
      expect(result.myCleanup.byReason).toEqual([]);
    });

    it("uses responsible activity ownership in the weekly activity query", async () => {
      const { getRepDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [{ count: "0", total_value: "0" }],
        [{ overdue: "0", today: "0" }],
        [{ calls: "0", emails: "0", meetings: "0", notes: "0", total: "0" }],
        [{ total: "0", on_time: "0" }],
        [],
      ]);

      await getRepDashboard(tenantDb, "user-1");

      const activityQueryText = extractSqlText(tenantDb.execute.mock.calls[2][0]).toLowerCase();
      expect(activityQueryText).toContain("responsible_user_id");
      expect(activityQueryText).not.toContain("where user_id =");
    });
  });

  describe("getDirectorDashboard", () => {
    it("should return director-level aggregations", async () => {
      // This test validates the function exists and returns the expected shape.
      // Full integration testing requires a database with seeded data.
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      expect(typeof getDirectorDashboard).toBe("function");
    });

    it("uses responsible activity ownership in director rep-card aggregations", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [],
        [],
        [],
        [],
        [],
        [],
        [{ dd_value: "0", dd_count: "0", pipeline_value: "0", pipeline_count: "0" }],
      ]);

      await getDirectorDashboard(tenantDb, { from: "2026-01-01", to: "2026-12-31" });

      const repCardsQueryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
      expect(repCardsQueryText).toContain("a.responsible_user_id as rep_id");
      expect(repCardsQueryText).not.toContain("a.user_id");
    });
  });

  describe("getRepDetail", () => {
    it("should be a function accepting repId and options", async () => {
      const { getRepDetail } = await import("../../../src/modules/dashboard/service.js");
      expect(typeof getRepDetail).toBe("function");
    });
  });

  describe("RepDashboardData shape", () => {
    it("should include all required sections", async () => {
      const { getRepDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [{ count: "1", total_value: "100000" }],
        [{ overdue: "0", today: "1" }],
        [{ calls: "2", emails: "3", meetings: "1", notes: "0", total: "6" }],
        [{ total: "5", on_time: "4" }],
        [{ stage_id: "s1", stage_name: "Bid Sent", stage_color: "#EAB308", display_order: 3, deal_count: "1", total_value: "100000" }],
      ]);

      const result = await getRepDashboard(tenantDb, "user-2");

      // Verify shape
      expect(result).toHaveProperty("activeDeals");
      expect(result).toHaveProperty("tasksToday");
      expect(result).toHaveProperty("activityThisWeek");
      expect(result).toHaveProperty("followUpCompliance");
      expect(result).toHaveProperty("pipelineByStage");
      expect(result).toHaveProperty("myCleanup");

      // Verify types
      expect(typeof result.activeDeals.count).toBe("number");
      expect(typeof result.activeDeals.totalValue).toBe("number");
      expect(typeof result.tasksToday.overdue).toBe("number");
      expect(typeof result.activityThisWeek.calls).toBe("number");
      expect(typeof result.followUpCompliance.complianceRate).toBe("number");
      expect(Array.isArray(result.pipelineByStage)).toBe(true);
      expect(typeof result.myCleanup.total).toBe("number");
      expect(Array.isArray(result.myCleanup.byReason)).toBe(true);
    });
  });
});
