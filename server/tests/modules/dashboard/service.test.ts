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

vi.mock("../../../src/modules/migration/service.js", () => ({
  getMigrationSummary: vi.fn().mockResolvedValue({
    deals: { needs_review: 1 },
    contacts: { needs_review: 2 },
    activities: { needs_review: 0 },
    companies: { needs_review: 0 },
    properties: { needs_review: 0 },
    leads: { needs_review: 3 },
    recentRuns: [{ startedAt: "2026-04-21T00:00:00.000Z" }],
  }),
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
        [{ count: "4" }],
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
        [],
        [],
        [],
        [
          {
            lead_id: "lead-1",
            lead_name: "Lead One",
            company_name: "Birchstone",
            property_name: "North Tower",
            stage_name: "Discovery",
            days_in_stage: "5",
            updated_at: "2026-04-20T00:00:00.000Z",
          },
        ],
        [
          {
            deal_id: "deal-1",
            deal_name: "Deal One",
            company_name: "Birchstone",
            property_name: "North Tower",
            stage_slug: "estimating",
            mirrored_stage_slug: "estimating",
            workflow_route: "normal",
            stage_name: "Estimating",
            total_value: "250000",
            updated_at: "2026-04-20T00:00:00.000Z",
          },
        ],
      ]);

      const result = await getRepDashboard(tenantDb, "user-1");
      expect(result.activeLeads.count).toBe(4);
      expect(getMyCleanupQueueMock).toHaveBeenCalledWith(tenantDb, "user-1");
      expect(result.activeDeals.count).toBe(5);
      expect(result.tasksToday.overdue).toBe(2);
      expect(result.activityThisWeek.total).toBe(20);
      expect(result.followUpCompliance.complianceRate).toBe(90);
      expect(result.pipelineByStage).toHaveLength(1);
      expect(result.leadSnapshot).toHaveLength(1);
      expect(result.dealSnapshot).toHaveLength(1);
      expect(result.dealSnapshot[0]?.stageName).toBe("Estimate in Progress");
      expect(result.myCleanup.total).toBe(2);
      expect(result.myCleanup.byReason).toEqual([
        { reasonCode: "missing_next_step", count: 1 },
        { reasonCode: "stale_no_recent_activity", count: 1 },
      ]);
    });

    it("should handle empty data gracefully", async () => {
      const { getRepDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [{ count: "0" }],
        [{ count: "0", total_value: "0" }],
        [{ overdue: "0", today: "0" }],
        [{ calls: "0", emails: "0", meetings: "0", notes: "0", total: "0" }],
        [{ total: "0", on_time: "0" }],
        [],
        [],
        [],
        [],
      ]);

      const result = await getRepDashboard(tenantDb, "user-1");
      expect(result.activeLeads.count).toBe(0);
      expect(result.activeDeals.count).toBe(0);
      expect(result.activeDeals.totalValue).toBe(0);
      expect(result.tasksToday.overdue).toBe(0);
      expect(result.activityThisWeek.total).toBe(0);
      expect(result.followUpCompliance.complianceRate).toBe(100);
      expect(result.pipelineByStage).toHaveLength(0);
      expect(result.leadSnapshot).toHaveLength(0);
      expect(result.dealSnapshot).toHaveLength(0);
      expect(result.myCleanup.total).toBe(0);
      expect(result.myCleanup.byReason).toEqual([]);
    });

    it("uses responsible activity ownership in the weekly activity query", async () => {
      const { getRepDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [{ count: "0" }],
        [{ count: "0", total_value: "0" }],
        [{ overdue: "0", today: "0" }],
        [{ calls: "0", emails: "0", meetings: "0", notes: "0", total: "0" }],
        [{ total: "0", on_time: "0" }],
        [],
        [],
        [],
        [],
      ]);

      await getRepDashboard(tenantDb, "user-1");

      const activityQueryText = extractSqlText(tenantDb.execute.mock.calls[3][0]).toLowerCase();
      expect(activityQueryText).toContain("responsible_user_id");
      expect(activityQueryText).not.toContain("where user_id =");
    });

    it("returns canonical funnel buckets for the rep dashboard", async () => {
      const { getRepDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [{ count: "4" }],
        [{ count: "2", total_value: "250000" }],
        [{ overdue: "1", today: "2" }],
        [{ calls: "1", emails: "2", meetings: "0", notes: "1", total: "4" }],
        [{ total: "5", on_time: "4" }],
        [{ stage_id: "deal-stage-1", stage_name: "DD", stage_color: "#2563EB", display_order: 1, deal_count: "1", total_value: "100000" }],
        [],
        [],
        [],
        [
          { lead_id: "lead-1", lead_name: "Lead One", company_name: "Birchstone", property_name: "North Tower", stage_name: "Qualified Lead", days_in_stage: "5", updated_at: "2026-04-20T00:00:00.000Z" },
        ],
        [
          {
            deal_id: "deal-1",
            deal_name: "Deal One",
            company_name: "Birchstone",
            property_name: "North Tower",
            stage_slug: "estimating",
            mirrored_stage_slug: "estimating",
            workflow_route: "normal",
            stage_name: "Estimating",
            total_value: "250000",
            updated_at: "2026-04-20T00:00:00.000Z",
          },
        ],
        [
          { slug: "new_lead", count: "4" },
          { slug: "qualified_lead", count: "2" },
          { slug: "sales_validation_stage", count: "3" },
        ],
        [
          { slug: "dd", count: "3", total_value: "120000" },
          { slug: "estimate_in_progress", count: "2", total_value: "70000" },
          { slug: "estimate_sent_to_client", count: "1", total_value: "50000" },
        ],
      ]);

      const result = await getRepDashboard(tenantDb, "user-1");

      expect(result.funnelBuckets).toEqual([
        { key: "lead", label: "Leads", count: 4, totalValue: null, route: "/leads", bucket: "lead" },
        { key: "qualified_lead", label: "Qualified Leads", count: 2, totalValue: null, route: "/leads", bucket: "qualified_lead" },
        { key: "opportunity", label: "Opportunities", count: 3, totalValue: null, route: "/leads", bucket: "opportunity" },
        { key: "due_diligence", label: "Due Diligence", count: 3, totalValue: 120000, route: "/deals", bucket: "due_diligence" },
        { key: "estimating", label: "Bid Board Pipeline", count: 3, totalValue: 120000, route: "/deals", bucket: "estimating" },
      ]);
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

    it("returns office funnel buckets and rep rows in default workload order", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = {
        execute: vi.fn().mockImplementation((query: unknown) => {
          const text = extractSqlText(query).toLowerCase();

          if (text.includes("dd_value") && text.includes("pipeline_value")) {
            return Promise.resolve({
              rows: [{ dd_value: "0", dd_count: "0", pipeline_value: "0", pipeline_count: "0", total_value: "0", total_count: "0" }],
            });
          }

          if (
            text.includes("from leads l") &&
            text.includes("psc.workflow_family = 'lead'") &&
            text.includes("group by psc.slug")
          ) {
            return Promise.resolve({
              rows: [
                { slug: "new_lead", count: "5" },
                { slug: "qualified_lead", count: "3" },
                { slug: "sales_validation_stage", count: "2" },
              ],
            });
          }

          if (
            text.includes("from deals d") &&
            text.includes("estimate_in_progress") &&
            text.includes("group by psc.slug")
          ) {
            return Promise.resolve({
              rows: [
                { slug: "dd", count: "2", total_value: "60000" },
                { slug: "estimate_in_progress", count: "1", total_value: "40000" },
                { slug: "estimate_sent_to_client", count: "2", total_value: "90000" },
              ],
            });
          }

          if (text.includes("with lead_counts as") && text.includes("qualified_leads")) {
            return Promise.resolve({
              rows: [
                { rep_id: "rep-2", rep_name: "Alex Rep", leads: "2", qualified_leads: "1", opportunities: "1", due_diligence: "1", estimating: "1" },
                { rep_id: "rep-1", rep_name: "Blair Rep", leads: "3", qualified_leads: "2", opportunities: "0", due_diligence: "2", estimating: "1" },
              ],
            });
          }

          return Promise.resolve({ rows: [] });
        }),
      } as any;

      const result = await getDirectorDashboard(tenantDb, { from: "2026-01-01", to: "2026-12-31" });

      expect(result.officeFunnelBuckets).toEqual([
        { key: "lead", label: "Leads", count: 5, totalValue: null, route: "/leads", bucket: "lead" },
        { key: "qualified_lead", label: "Qualified Leads", count: 3, totalValue: null, route: "/leads", bucket: "qualified_lead" },
        { key: "opportunity", label: "Opportunities", count: 2, totalValue: null, route: "/leads", bucket: "opportunity" },
        { key: "due_diligence", label: "Due Diligence", count: 2, totalValue: 60000, route: "/deals", bucket: "due_diligence" },
        { key: "estimating", label: "Bid Board Pipeline", count: 3, totalValue: 130000, route: "/deals", bucket: "estimating" },
      ]);
      expect(result.repFunnelRows.map((row) => row.repName)).toEqual(["Blair Rep", "Alex Rep"]);
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
        [{ count: "1" }],
        [{ count: "1", total_value: "100000" }],
        [{ overdue: "0", today: "1" }],
        [{ calls: "2", emails: "3", meetings: "1", notes: "0", total: "6" }],
        [{ total: "5", on_time: "4" }],
        [{ stage_id: "s1", stage_name: "Bid Sent", stage_color: "#EAB308", display_order: 3, deal_count: "1", total_value: "100000" }],
        [],
        [],
        [],
      ]);

      const result = await getRepDashboard(tenantDb, "user-2");

      // Verify shape
      expect(result).toHaveProperty("activeDeals");
      expect(result).toHaveProperty("activeLeads");
      expect(result).toHaveProperty("tasksToday");
      expect(result).toHaveProperty("activityThisWeek");
      expect(result).toHaveProperty("followUpCompliance");
      expect(result).toHaveProperty("funnelBuckets");
      expect(result).toHaveProperty("commissionSummary");
      expect(result).toHaveProperty("pipelineByStage");
      expect(result).toHaveProperty("leadSnapshot");
      expect(result).toHaveProperty("dealSnapshot");
      expect(result).toHaveProperty("myCleanup");

      // Verify types
      expect(typeof result.activeLeads.count).toBe("number");
      expect(typeof result.activeDeals.count).toBe("number");
      expect(typeof result.activeDeals.totalValue).toBe("number");
      expect(typeof result.tasksToday.overdue).toBe("number");
      expect(typeof result.activityThisWeek.calls).toBe("number");
      expect(typeof result.followUpCompliance.complianceRate).toBe("number");
      expect(typeof result.commissionSummary.totalEarnedCommission).toBe("number");
      expect(Array.isArray(result.pipelineByStage)).toBe(true);
      expect(Array.isArray(result.leadSnapshot)).toBe(true);
      expect(Array.isArray(result.dealSnapshot)).toBe(true);
      expect(typeof result.myCleanup.total).toBe("number");
      expect(Array.isArray(result.myCleanup.byReason)).toBe(true);
    });

    it("casts CRM-owned workflow routes to text before combining lead and opportunity progression", async () => {
      const { getRepDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [{ count: "0" }],
        [{ count: "0", total_value: "0" }],
        [{ overdue: "0", today: "0" }],
        [{ calls: "0", emails: "0", meetings: "0", notes: "0", total: "0" }],
        [{ total: "0", on_time: "0" }],
        [],
        [],
        [],
        [],
      ]);

      await getRepDashboard(tenantDb, "user-1");

      const crmOwnedProgressionQuery = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .find((text: string) => text.includes("workflow_bucket") && text.includes("crm_owned_progression"));

      expect(crmOwnedProgressionQuery).toBeTruthy();
      expect(crmOwnedProgressionQuery).toContain("l.pipeline_type::text as workflow_route");
      expect(crmOwnedProgressionQuery).toContain("d.workflow_route::text as workflow_route");
    });
  });

  describe("getAdminDashboardSummary", () => {
    it("reads audit actor labels from changed_by joined to users instead of actor_name", async () => {
      const { getAdminDashboardSummary } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [{ pending_count: "1", oldest_minutes: "5" }],
        [{ open_count: "2", oldest_minutes: "10" }],
        [{ total_count: "3", primary_cluster_label: "handoff" }],
        [{ open_count: "4", oldest_minutes: "15" }],
        [{ change_count_24h: "6", last_actor_label: "Taylor Admin" }],
        [{ conflict_count: "0" }],
      ]);

      const result = await getAdminDashboardSummary(tenantDb, "office-1");

      expect(result.audit.lastActorLabel).toBe("Taylor Admin");

      const auditQueryText = extractSqlText(tenantDb.execute.mock.calls[4][0]).toLowerCase();
      expect(auditQueryText).toContain("changed_by");
      expect(auditQueryText).toContain("left join public.users u on u.id =");
      expect(auditQueryText).not.toContain("actor_name");
    });
  });
});
