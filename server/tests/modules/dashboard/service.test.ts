import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
vi.mock("@trock-crm/shared/types", async () => import("../../../../shared/src/types/index.js"));

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
    execute: vi.fn().mockImplementation((query?: unknown) => {
      const text = extractSqlText(query).toLowerCase();
      if (text.includes("to_regclass(current_schema()")) {
        const relationName = text.includes("deal_subscriptions")
          ? "office_test.deal_subscriptions"
          : text.includes("lead_subscriptions")
            ? "office_test.lead_subscriptions"
            : null;
        return Promise.resolve({ rows: [{ relation_name: relationName }] });
      }
      if (text.includes("information_schema.columns")) {
        const columnExists =
          text.includes("deal_subscriptions") ||
          text.includes("lead_subscriptions") ||
          text.includes("created_by_user_id");
        return Promise.resolve({ rows: [{ column_exists: columnExists }] });
      }
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

function nonIntrospectionExecuteCalls(tenantDb: { execute: { mock: { calls: unknown[][] } } }) {
  return tenantDb.execute.mock.calls.filter((call) => {
    const text = extractSqlText(call[0]).toLowerCase();
    return !text.includes("to_regclass(current_schema()") && !text.includes("information_schema.columns");
  });
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
            stage_slug: "contacted",
            stage_name: "Contacted",
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
            stage_slug: "due_diligence",
            mirrored_stage_slug: "due_diligence",
            workflow_route: "normal",
            stage_name: "Due Diligence",
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
      expect(result.leadSnapshot[0]?.stageName).toBe("New Lead");
      expect(result.dealSnapshot).toHaveLength(1);
      expect(result.dealSnapshot[0]?.stageName).toBe("Opportunity");
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

      const activityQueryText = extractSqlText(nonIntrospectionExecuteCalls(tenantDb)[3][0]).toLowerCase();
      expect(activityQueryText).toContain("responsible_user_id");
      expect(activityQueryText).not.toContain("where user_id =");
    });

    it("excludes active on-hold deals from the rep recent active-deal snapshot", async () => {
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

      const dealSnapshotQueryText =
        nonIntrospectionExecuteCalls(tenantDb)
          .map(([query]) => extractSqlText(query).toLowerCase())
          .find((queryText) => queryText.includes("from deals d") && queryText.includes("limit 5")) ?? "";
      expect(dealSnapshotQueryText).toContain("from deals d");
      expect(dealSnapshotQueryText).toContain("coalesce(d.on_hold, false) = false");
    });

    it("defaults activity counts to the weekly window when no explicit date range is passed", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
      try {
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

        const activityQueryText = extractSqlText(nonIntrospectionExecuteCalls(tenantDb)[3][0]).toLowerCase();
        expect(activityQueryText).toContain("2026-05-08");
        expect(activityQueryText).toContain("2026-05-15");
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses an explicit activity date range when provided", async () => {
      const { getRepDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [{ count: "0" }],
        [{ count: "0", total_value: "0" }],
        [{ overdue: "0", today: "0" }],
        [{ calls: "35", emails: "0", meetings: "5", notes: "17", total: "57" }],
        [{ total: "0", on_time: "0" }],
        [],
        [],
        [],
        [],
      ]);

      const result = await getRepDashboard(tenantDb, "user-1", {
        activityDateRange: { from: "2026-04-01", to: "2026-05-15" },
      });

      const activityQueryText = extractSqlText(nonIntrospectionExecuteCalls(tenantDb)[3][0]).toLowerCase();
      expect(result.activityThisWeek.total).toBe(57);
      expect(activityQueryText).toContain("2026-04-01");
      expect(activityQueryText).toContain("2026-05-15");
    });

    it("supports custom explicit activity date ranges", async () => {
      const { getRepDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [{ count: "0" }],
        [{ count: "0", total_value: "0" }],
        [{ overdue: "0", today: "0" }],
        [{ calls: "3", emails: "1", meetings: "2", notes: "4", total: "10" }],
        [{ total: "0", on_time: "0" }],
        [],
        [],
        [],
        [],
      ]);

      const result = await getRepDashboard(tenantDb, "user-1", {
        activityDateRange: { from: "2026-04-15", to: "2026-04-30" },
      });

      const activityQueryText = extractSqlText(nonIntrospectionExecuteCalls(tenantDb)[3][0]).toLowerCase();
      expect(result.activityThisWeek.total).toBe(10);
      expect(activityQueryText).toContain("2026-04-15");
      expect(activityQueryText).toContain("2026-04-30");
    });

    it("excludes mirrored terminal stage slugs from rep active deal counts and pipeline value", async () => {
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

      const repExecuteCalls = nonIntrospectionExecuteCalls(tenantDb);
      const activeDealQuery = extractSqlText(repExecuteCalls[1][0]).toLowerCase();
      const pipelineByStageQuery = extractSqlText(repExecuteCalls[5][0]).toLowerCase();
      expect(activeDealQuery).toContain("coalesce(d.bid_board_stage_slug, psc.slug)");
      expect(activeDealQuery).toContain("not in");
      expect(activeDealQuery).toContain("closed_won");
      expect(activeDealQuery).toContain("service_lost");
      expect(pipelineByStageQuery).toContain("coalesce(d.bid_board_stage_slug, psc.slug)");
      expect(pipelineByStageQuery).toContain("not in");
      expect(pipelineByStageQuery).toContain("closed_won");
      expect(pipelineByStageQuery).toContain("service_lost");
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
          { slug: "estimate_in_progress", count: "2", total_value: "70000" },
          { slug: "estimate_sent_to_client", count: "1", total_value: "50000" },
        ],
      ]);

      const result = await getRepDashboard(tenantDb, "user-1");

      expect(result.funnelBuckets).toEqual([
        { key: "lead", label: "Leads", count: 4, totalValue: null, route: "/leads", bucket: "lead" },
        { key: "qualified_lead", label: "Qualified Leads", count: 2, totalValue: null, route: "/leads", bucket: "qualified_lead" },
        { key: "opportunity", label: "Opportunities", count: 3, totalValue: null, route: "/leads", bucket: "opportunity" },
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

      await getDirectorDashboard(tenantDb, { from: "2026-01-01", to: "2026-12-31", officeId: "office-1" });

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
                { slug: "estimate_in_progress", count: "1", total_value: "40000" },
                { slug: "estimate_sent_to_client", count: "2", total_value: "90000" },
              ],
            });
          }

          if (text.includes("qualified_leads") && text.includes("deal_owners")) {
            return Promise.resolve({
              rows: [
                { rep_id: "rep-2", rep_name: "Alex Rep", leads: "2", qualified_leads: "1", opportunities: "1", estimating: "1" },
                { rep_id: "rep-1", rep_name: "Blair Rep", leads: "3", qualified_leads: "2", opportunities: "0", estimating: "1" },
              ],
            });
          }

          return Promise.resolve({ rows: [] });
        }),
      } as any;

      const result = await getDirectorDashboard(tenantDb, { from: "2026-01-01", to: "2026-12-31", officeId: "office-1" });

      expect(result.officeFunnelBuckets).toEqual([
        { key: "lead", label: "Leads", count: 5, totalValue: null, route: "/leads", bucket: "lead" },
        { key: "qualified_lead", label: "Qualified Leads", count: 3, totalValue: null, route: "/leads", bucket: "qualified_lead" },
        { key: "opportunity", label: "Opportunities", count: 2, totalValue: null, route: "/leads", bucket: "opportunity" },
        { key: "estimating", label: "Bid Board Pipeline", count: 3, totalValue: 130000, route: "/deals", bucket: "estimating" },
      ]);
      expect(result.repFunnelRows.map((row) => row.repName)).toEqual(["Blair Rep", "Alex Rep"]);
    });

    it("includes deal-owning directors and admins in the rep-card list while leaving dashboard totals unchanged", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = {
        execute: vi.fn().mockImplementation((query: unknown) => {
          const text = extractSqlText(query).toLowerCase();

          if (text.includes("from users u") && text.includes("coalesce(rd.active_deals, 0)::int as active_deals")) {
            return Promise.resolve({
              rows: [
                {
                  rep_id: "rep-1",
                  rep_name: "Alex Rep",
                  active_deals: "4",
                  pipeline_value: "250000",
                  wins: "2",
                  losses: "1",
                  activity_score: "14",
                  stale_deals: "1",
                  stale_leads: "0",
                },
                {
                  rep_id: "director-1",
                  rep_name: "Brett Bell",
                  active_deals: "3",
                  pipeline_value: "180000",
                  wins: "1",
                  losses: "0",
                  activity_score: "9",
                  stale_deals: "0",
                  stale_leads: "0",
                },
                {
                  rep_id: "admin-1",
                  rep_name: "Adnaan Iqbal",
                  active_deals: "2",
                  pipeline_value: "95000",
                  wins: "1",
                  losses: "1",
                  activity_score: "7",
                  stale_deals: "0",
                  stale_leads: "1",
                },
              ],
            });
          }

          if (text.includes("scope_summary")) {
            return Promise.resolve({
              rows: [
                {
                  active_pipeline_count: "4",
                  active_pipeline_total: "610000",
                  won_count: "1",
                  won_total: "125000",
                  at_risk_count: "1",
                  at_risk_total: "275000",
                  stale_count: "1",
                  stale_total: "275000",
                },
              ],
            });
          }

          if (text.includes("dd_value") && text.includes("pipeline_value")) {
            return Promise.resolve({
              rows: [{ dd_value: "0", dd_count: "0", pipeline_value: "0", pipeline_count: "0", total_value: "0", total_count: "0" }],
            });
          }

          return Promise.resolve({ rows: [] });
        }),
      } as any;

      const result = await getDirectorDashboard(tenantDb, { from: "2026-01-01", to: "2026-12-31", officeId: "office-1" });
      const repCardsQueryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();

      expect(repCardsQueryText).not.toContain("and u.role = 'rep'");
      expect(repCardsQueryText).toContain("deal_owners");
      expect(repCardsQueryText).toContain("u.role = 'rep' or owner_rows.rep_id is not null");
      expect(result.repCards.map((row) => row.repName)).toEqual(["Alex Rep", "Brett Bell", "Adnaan Iqbal"]);
      expect(result.repCards.find((row) => row.repName === "Brett Bell")).toMatchObject({
        activeDeals: 3,
        pipelineValue: 180000,
        winRate: 100,
        activityScore: 9,
      });
      expect(result.scopeSummary).toMatchObject({
        activePipeline: { count: expect.any(Number), totalValue: expect.any(Number) },
        won: { count: expect.any(Number), totalValue: expect.any(Number) },
        atRisk: { count: expect.any(Number), totalValue: expect.any(Number) },
        // P2-9: 'stale' removed (was a dead alias of at-risk).
      });
    });

    it("includes deal-owning directors/admins in funnel rows without widening via lead-only non-reps", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = {
        execute: vi.fn().mockImplementation((query: unknown) => {
          const text = extractSqlText(query).toLowerCase();

          if (
            text.includes("from leads l") &&
            text.includes("psc.workflow_family = 'lead'") &&
            text.includes("group by psc.slug")
          ) {
            return Promise.resolve({ rows: [] });
          }

          if (
            text.includes("from deals d") &&
            text.includes("estimate_in_progress") &&
            text.includes("group by psc.slug")
          ) {
            return Promise.resolve({ rows: [] });
          }

          if (text.includes("qualified_leads") && text.includes("deal_owners")) {
            return Promise.resolve({
              rows: [
                { rep_id: "rep-1", rep_name: "Alex Rep", leads: "2", qualified_leads: "1", opportunities: "0", estimating: "1" },
                { rep_id: "director-1", rep_name: "James Helms", leads: "0", qualified_leads: "0", opportunities: "0", estimating: "3" },
                { rep_id: "admin-1", rep_name: "Adnaan Iqbal", leads: "0", qualified_leads: "0", opportunities: "0", estimating: "2" },
              ],
            });
          }

          if (text.includes("dd_value") && text.includes("pipeline_value")) {
            return Promise.resolve({
              rows: [{ dd_value: "0", dd_count: "0", pipeline_value: "0", pipeline_count: "0", total_value: "0", total_count: "0" }],
            });
          }

          return Promise.resolve({ rows: [] });
        }),
      } as any;

      const result = await getDirectorDashboard(tenantDb, { from: "2026-01-01", to: "2026-12-31", officeId: "office-1" });
      const funnelQueryText = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .find((text: string) => text.includes("qualified_leads") && text.includes("deal_owners"));

      expect(funnelQueryText).not.toContain("and u.role = 'rep'");
      expect(funnelQueryText).toContain("deal_owners");
      expect(funnelQueryText).toContain("u.role = 'rep' or owner_rows.rep_id is not null");
      expect(result.repFunnelRows.map((row) => row.repName)).toEqual([
        "Alex Rep",
        "James Helms",
        "Adnaan Iqbal",
      ]);
      expect(result.repFunnelRows.find((row) => row.repName === "James Helms")).toMatchObject({
        leads: 0,
        qualifiedLeads: 0,
        opportunities: 0,
        estimating: 3,
      });
    });

    it("gates non-rep inclusion on deal ownership rather than lead or activity presence", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [],
        [],
        [],
        [],
        [],
        [],
        [{ dd_value: "0", dd_count: "0", pipeline_value: "0", pipeline_count: "0", total_value: "0", total_count: "0" }],
      ]);

      await getDirectorDashboard(tenantDb, { from: "2026-01-01", to: "2026-12-31", officeId: "office-1" });

      const repCardsQueryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
      const funnelQueryText = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .find((text: string) => text.includes("qualified_leads") && text.includes("deal_owners"));

      expect(repCardsQueryText).toContain("deal_owners");
      expect(repCardsQueryText).toContain("from deals d\n      where d.assigned_rep_id is not null");
      expect(repCardsQueryText).not.toContain("or rd.rep_id is not null");
      expect(repCardsQueryText).not.toContain("or rw.rep_id is not null");
      expect(repCardsQueryText).not.toContain("or ra.rep_id is not null");
      expect(funnelQueryText).toContain("deal_owners");
      expect(funnelQueryText).toContain("from deals d\n        where d.assigned_rep_id is not null");
      expect(funnelQueryText).not.toContain("or lc.rep_id is not null");
      expect(funnelQueryText).not.toContain("or dc.rep_id is not null");
    });

    it("limits deal-owner widening to the per-rep row queries and leaves aggregate queries untouched", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [],
        [],
        [],
        [],
        [],
        [],
        [{ dd_value: "0", dd_count: "0", pipeline_value: "0", pipeline_count: "0", total_value: "0", total_count: "0" }],
      ]);

      await getDirectorDashboard(tenantDb, { from: "2026-01-01", to: "2026-12-31", officeId: "office-1" });

      const dealOwnerQueries = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .filter((text: string) => text.includes("deal_owners"));

      expect(dealOwnerQueries).toHaveLength(2);
      expect(dealOwnerQueries.every((text: string) => text.includes("from users u"))).toBe(true);
    });

    it("manager override applies to commission amount, not full contract value", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = {
        execute: vi.fn().mockImplementation((query: unknown) => {
          const text = extractSqlText(query).toLowerCase();

          if (text.includes("select id, display_name") && text.includes("role = 'rep'")) {
            return Promise.resolve({ rows: [{ id: "manager-1", display_name: "Manager Rep" }] });
          }

          if (text.includes("left join public.user_commission_settings")) {
            return Promise.resolve({
              rows: [
                {
                  is_active: true,
                  commission_rate: "0.05",
                  rolling_floor: "0",
                  override_rate: "0.10",
                  estimated_margin_rate: "0.30",
                  min_margin_percent: "0.20",
                  new_customer_share_floor: "0.10",
                  new_customer_window_months: "6",
                },
              ],
            });
          }

          if (text.includes("as override_earned")) {
            return Promise.resolve({ rows: [{ override_earned: "500" }] });
          }

          if (text.includes("sum(dsc.source_value_amount)") && text.includes("earned_commission")) {
            return Promise.resolve({ rows: [{ source_value_amount: "100000", earned_commission: "5000" }] });
          }

          if (text.includes("potential_revenue")) {
            return Promise.resolve({ rows: [{ potential_revenue: "0" }] });
          }

          if (text.includes("dd_value") && text.includes("pipeline_value")) {
            return Promise.resolve({
              rows: [{ dd_value: "0", dd_count: "0", pipeline_value: "0", pipeline_count: "0", total_value: "0", total_count: "0" }],
            });
          }

          return Promise.resolve({ rows: [] });
        }),
      } as any;

      await getDirectorDashboard(tenantDb, { from: "2026-01-01", to: "2026-12-31", officeId: "office-1" });

      const overrideQuery = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .find((text: string) => text.includes("as override_earned"));

      expect(overrideQuery).toContain("sum(dsc.amount *");
      expect(overrideQuery).toContain("coalesce(d.on_hold, false) = false");
      expect(overrideQuery).not.toContain("sum(dsc.source_value_amount *");
    });

    it("uses unsigned commission pipeline stages and deal value times rate for director commission potential", async () => {
      const { getDirectorCommissionWorkspace } = await import("../../../src/modules/dashboard/service.js");

      const tenantDb = {
        execute: vi.fn().mockImplementation((query: unknown) => {
          const text = extractSqlText(query).toLowerCase();

          if (text.includes("select id, display_name") && text.includes("role = 'rep'")) {
            return Promise.resolve({ rows: [{ id: "rep-1", display_name: "Alex Rep" }] });
          }

          if (text.includes("left join public.user_commission_settings")) {
            return Promise.resolve({
              rows: [
                {
                  is_active: true,
                  commission_rate: "0.05",
                  rolling_floor: "0",
                  override_rate: "0",
                  estimated_margin_rate: "0.30",
                  min_margin_percent: "0.20",
                  new_customer_share_floor: "0.10",
                  new_customer_window_months: "6",
                },
              ],
            });
          }

          if (text.includes("sum(dsc.source_value_amount)") && text.includes("earned_commission")) {
            return Promise.resolve({ rows: [{ source_value_amount: "0", earned_commission: "0" }] });
          }

          if (text.includes("dsc.source_value_amount::numeric as paid_revenue")) {
            return Promise.resolve({ rows: [] });
          }

          if (text.includes("potential_revenue")) {
            return Promise.resolve({ rows: [{ potential_revenue: "100000" }] });
          }

          if (text.includes("as override_earned")) {
            return Promise.resolve({ rows: [{ override_earned: "0" }] });
          }

          if (text.includes("activity_type")) {
            return Promise.resolve({ rows: [] });
          }

          if (text.includes("with lead_counts as") && text.includes("qualified_leads")) {
            return Promise.resolve({ rows: [] });
          }

          if (text.includes("as active_deals") && text.includes("pipeline_value")) {
            return Promise.resolve({ rows: [{ rep_id: "rep-1", active_deals: "1", pipeline_value: "100000" }] });
          }

          return Promise.resolve({ rows: [] });
        }),
      } as any;

      const result = await getDirectorCommissionWorkspace(tenantDb, { from: "2026-01-01", to: "2026-12-31" });

      const potentialQuery = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .find((text: string) => text.includes("potential_revenue")) ?? "";
      const pipelineSummaryQuery = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .find((text: string) => text.includes("as active_deals") && text.includes("pipeline_value")) ?? "";

      expect(result.rows[0]).toMatchObject({
        repId: "rep-1",
        potentialCommission: 5000,
        activeDeals: 1,
        pipelineValue: 100000,
      });
      expect(potentialQuery).toContain("contract_signed_at is null");
      expect(potentialQuery).toContain("contract_signed_date is null");
      expect(potentialQuery).toContain("coalesce(d.on_hold, false) = false");
      expect(potentialQuery).toContain("opportunity");
      expect(potentialQuery).toContain("contract");
      expect(potentialQuery).toContain("estimate_sent_to_client");
      expect(potentialQuery).not.toContain("is_terminal = false");
      expect(potentialQuery).not.toContain("estimated_margin_rate");
      expect(pipelineSummaryQuery).toContain("contract_signed_at is null");
      expect(pipelineSummaryQuery).toContain("contract_signed_date is null");
      expect(pipelineSummaryQuery.match(/coalesce\(d\.on_hold, false\) = false/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(pipelineSummaryQuery).not.toContain("is_terminal");
    });

    it("uses the same on-hold-aware population for dashboard commission values and deal rollups", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = {
        execute: vi.fn().mockImplementation((query: unknown) => {
          const text = extractSqlText(query).toLowerCase();

          if (text.includes("select id, display_name") && text.includes("role = 'rep'")) {
            return Promise.resolve({ rows: [{ id: "rep-1", display_name: "Alex Rep" }] });
          }

          if (text.includes("left join public.user_commission_settings")) {
            return Promise.resolve({
              rows: [
                {
                  is_active: true,
                  commission_rate: "0.05",
                  rolling_floor: "0",
                  override_rate: "0",
                  estimated_margin_rate: "0.30",
                  min_margin_percent: "0.20",
                  new_customer_share_floor: "0.10",
                  new_customer_window_months: "6",
                },
              ],
            });
          }

          if (text.includes("sum(dsc.source_value_amount)") && text.includes("earned_commission")) {
            return Promise.resolve({ rows: [{ source_value_amount: "100000", earned_commission: "5000" }] });
          }

          if (text.includes("dsc.source_value_amount::numeric as paid_revenue")) {
            return Promise.resolve({ rows: [] });
          }

          if (text.includes("potential_revenue")) {
            return Promise.resolve({ rows: [{ potential_revenue: "0" }] });
          }

          if (text.includes("dd_value") && text.includes("pipeline_value")) {
            return Promise.resolve({
              rows: [{ dd_value: "0", dd_count: "0", pipeline_value: "0", pipeline_count: "0", total_value: "0", total_count: "0" }],
            });
          }

          return Promise.resolve({ rows: [] });
        }),
      } as any;

      await getDirectorDashboard(tenantDb, { from: "2026-01-01", to: "2026-12-31", officeId: "office-1" });

      const queryTexts = tenantDb.execute.mock.calls.map(([query]: [unknown]) =>
        extractSqlText(query).toLowerCase()
      );
      const directQuery = queryTexts.find((text: string) =>
        text.includes("sum(dsc.source_value_amount)") && text.includes("earned_commission")
      ) ?? "";
      const rollupQuery = queryTexts.find((text: string) =>
        text.includes("dsc.source_value_amount::numeric as paid_revenue")
      ) ?? "";

      expect(directQuery).toContain("coalesce(d.on_hold, false) = false");
      expect(rollupQuery).toContain("coalesce(d.on_hold, false) = false");
    });

    it("uses the selected rep-performance period for director forecast data", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [],
        [],
        [],
        [],
        [],
        [],
        [{ dd_value: "0", dd_count: "0", pipeline_value: "0", pipeline_count: "0", total_value: "0", total_count: "0" }],
      ]);

      await getDirectorDashboard(tenantDb, {
        from: "2026-01-01",
        to: "2026-03-31",
        officeId: "office-1",
        periodKind: "last_quarter",
      });

      const snapshotQuery = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .find((text: string) => text.includes("from public.rep_performance_snapshots"));

      expect(snapshotQuery).toContain("where rps.period_kind = ");
      expect(snapshotQuery).toContain("last_quarter");
      expect(snapshotQuery).not.toContain("where rps.period_kind = mtd");
    });

    it("builds the closed KPI from an uncapped won aggregate instead of the recent-closes feed", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [],
        [],
        [],
        [],
        [],
        [],
        [],
      ]);

      await getDirectorDashboard(tenantDb, {
        from: "2026-01-01",
        to: "2026-03-31",
        officeId: "office-1",
        periodKind: "qtd",
      });

      const aggregateWonQuery = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .find((text: string) => text.includes("won_count") && text.includes("won_value"));
      const recentClosesQuery = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .find((text: string) => text.includes("select") && text.includes("closed_at desc nulls last"));

      expect(aggregateWonQuery).toBeTruthy();
      expect(aggregateWonQuery).not.toContain("limit 12");
      expect(recentClosesQuery).toContain("limit 12");
    });

    it("excludes active on-hold deals from recent closes and rep-card outcome populations", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([[], [], [], [], [], [], []]);

      await getDirectorDashboard(tenantDb, {
        from: "2026-01-01",
        to: "2026-03-31",
        officeId: "office-1",
        periodKind: "qtd",
      });

      const queries = tenantDb.execute.mock.calls.map(([query]: [unknown]) =>
        extractSqlText(query).toLowerCase()
      );
      const sqlText = queries.join("\n");
      const recentClosesQuery = queries.find((text) => text.includes("closed_at desc nulls last"));
      expect(recentClosesQuery).toContain("coalesce(d.on_hold, false) = false");
      expect(recentClosesQuery).toContain("won");
      expect(recentClosesQuery).toContain("sent_to_production");
      expect(recentClosesQuery).toContain("service_sent_to_production");
      expect(recentClosesQuery).toContain("service_scheduled");
      expect(recentClosesQuery).toContain("service_complete");
      expect(recentClosesQuery).toContain("closed_won");
      expect(recentClosesQuery).not.toContain("in_production");
      expect(recentClosesQuery).not.toContain("close_out");
      expect(recentClosesQuery).toContain("case when d.awarded_amount > 0 then d.awarded_amount end");
      expect(sqlText).toMatch(/rep_wins[\s\S]*coalesce\(d\.on_hold, false\) = false/);
    });

    it("scopes the recent-closes feed to the viewer in mine scope (P1-7)", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([]);

      await getDirectorDashboard(tenantDb, {
        from: "2026-01-01",
        to: "2026-03-31",
        officeId: "office-1",
        scope: "mine",
        viewerUserId: "viewer-1",
      });

      const recentClosesQuery = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .find((text: string) => text.includes("closed_at desc nulls last"));

      // P1-7: in mine scope, Recent Closes must narrow to the viewer's deals (matching the
      // KPI cards), not list office-wide closes. The caller previously omitted scope.
      expect(recentClosesQuery).toBeTruthy();
      expect(recentClosesQuery).toContain("assigned_rep_id = ");
    });

    it("leaves the recent-closes feed office-wide in all scope (P1-7 control)", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([]);

      await getDirectorDashboard(tenantDb, {
        from: "2026-01-01",
        to: "2026-03-31",
        officeId: "office-1",
        scope: "all",
      });

      const recentClosesQuery = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .find((text: string) => text.includes("closed_at desc nulls last"));

      expect(recentClosesQuery).toBeTruthy();
      expect(recentClosesQuery).not.toContain("assigned_rep_id = ");
    });

    it("scopes the activity-pulse rows to the viewer only when a viewer is set (P1-7)", async () => {
      const { scopeActivityPulseRowsToViewer } = await import(
        "../../../src/modules/dashboard/service.js"
      );
      const rows = [
        { repId: "viewer-1", activityTotal: 10 },
        { repId: "other-2", activityTotal: 99 },
      ];

      // Mine scope: only the viewer's activity row survives.
      expect(scopeActivityPulseRowsToViewer(rows, "viewer-1")).toEqual([
        { repId: "viewer-1", activityTotal: 10 },
      ]);
      // All scope (no viewer): office-wide, unchanged.
      expect(scopeActivityPulseRowsToViewer(rows, undefined)).toBe(rows);
    });

    it("does not expose a duplicate 'stale' metric alongside at-risk (P2-9)", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([]);

      const result = await getDirectorDashboard(tenantDb, {
        from: "2026-01-01",
        to: "2026-12-31",
        officeId: "office-1",
      });

      // P2-9: scopeSummary.stale was an alias of at-risk (the SAME isAtRisk predicate) and
      // was rendered nowhere -- a dead duplicate. Removed so the payload no longer claims a
      // distinct metric it doesn't have.
      expect(result.scopeSummary).toHaveProperty("atRisk");
      expect(result.scopeSummary).not.toHaveProperty("stale");
    });

    it("excludes is_test_data users from every director-dashboard rep roster (P2-8)", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([]);

      await getDirectorDashboard(tenantDb, {
        from: "2026-01-01",
        to: "2026-12-31",
        officeId: "office-1",
      });

      const queries = tenantDb.execute.mock.calls.map(([query]: [unknown]) =>
        extractSqlText(query).toLowerCase()
      );
      const filter = "coalesce(u.is_test_data, false) = false";

      // Rep roster (buildRepPerformanceCards): the WHERE that admits active reps + deal owners.
      const repRosterQuery = queries.find((t) => t.includes("owner_rows.rep_id is not null"));
      expect(repRosterQuery).toBeTruthy();
      expect(repRosterQuery).toContain(filter);

      // Snapshot roster (getRepPerformanceSnapshots) -> drives Activity Pulse / alerts / AI.
      const snapshotQuery = queries.find((t) => t.includes("rep_performance_snapshots"));
      expect(snapshotQuery).toBeTruthy();
      expect(snapshotQuery).toContain(filter);

      // Activity roster (getActivitySummaryByRep, reports module).
      const activityQuery = queries.find((t) => t.includes("a.type = 'call'"));
      expect(activityQuery).toBeTruthy();
      expect(activityQuery).toContain(filter);

      // Commission roster (getDirectorRepCommissionRows) -> dashboard payload + commission
      // workspace. Bare column (the query has no `u` alias). (Codex round 2)
      const commissionQuery = queries.find((t) => t.includes("order by display_name asc"));
      expect(commissionQuery).toBeTruthy();
      expect(commissionQuery).toContain("coalesce(is_test_data, false) = false");

      // Funnel roster (getDirectorFunnelSummary repFunnelRows). (Codex round 2)
      const funnelQuery = queries.find((t) => t.includes("qualified_leads"));
      expect(funnelQuery).toBeTruthy();
      expect(funnelQuery).toContain(filter);
    });

    it("keeps at-risk scope summary aligned to the role-relative engine population", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = {
        execute: vi.fn().mockImplementation((query: unknown) => {
          const text = extractSqlText(query).toLowerCase();

          if (text.includes("on_hold_accumulated_seconds_at_stage_entry")) {
            return Promise.resolve({
              rows: [
                {
                  deal_id: "deal-at-risk-1",
                  rep_id: "rep-1",
                  rep_name: "Avery Rep",
                  deal_name: "At Risk One",
                  stage_name: "Opportunity",
                  stage_slug: "opportunity",
                  mirrored_stage_status: "blocked",
                  workflow_route: "normal",
                  region_classification: "Dallas, TX",
                  deal_value: "2500",
                  stage_entered_at: "2026-01-15",
                  on_hold: false,
                  on_hold_started_at: null,
                  on_hold_accumulated_seconds: "0",
                  on_hold_accumulated_seconds_at_stage_entry: "0",
                },
                {
                  deal_id: "deal-at-risk-2",
                  rep_id: "rep-2",
                  rep_name: "Blake Rep",
                  deal_name: "At Risk Two",
                  stage_name: "Contract",
                  stage_slug: "contract",
                  mirrored_stage_status: "at_risk",
                  workflow_route: "normal",
                  region_classification: "Fort Worth, TX",
                  deal_value: "4000",
                  stage_entered_at: "2026-01-10",
                  on_hold: false,
                  on_hold_started_at: null,
                  on_hold_accumulated_seconds: "0",
                  on_hold_accumulated_seconds_at_stage_entry: "0",
                },
              ],
            });
          }

          if (text.includes("mirrored_stage_status")) {
            return Promise.resolve({
              rows: [{
                deal_id: "deal-bottleneck",
                rep_id: "rep-1",
                rep_name: "Avery Rep",
                deal_name: "Blocked Deal",
                stage_name: "Contract",
                mirrored_stage_slug: "contract",
                mirrored_stage_status: "blocked",
                workflow_route: "service",
                region_classification: "Dallas, TX",
                deal_value: "1000",
                stage_entered_at: "2026-01-01",
                on_hold: false,
                on_hold_started_at: null,
                on_hold_accumulated_seconds: "0",
                on_hold_accumulated_seconds_at_stage_entry: "0",
              }],
            });
          }

          if (text.includes("won_count") && text.includes("won_value")) {
            return Promise.resolve({ rows: [{ won_count: "0", won_value: "0" }] });
          }

          if (text.includes("dd_value") && text.includes("pipeline_value")) {
            return Promise.resolve({
              rows: [{ dd_value: "0", dd_count: "0", pipeline_value: "0", pipeline_count: "0", total_value: "0", total_count: "0" }],
            });
          }

          return Promise.resolve({ rows: [] });
        }),
      } as any;

      const result = await getDirectorDashboard(tenantDb, {
        from: "2026-01-01",
        to: "2026-03-31",
        officeId: "office-1",
        periodKind: "qtd",
      });

      expect(result.scopeSummary.atRisk).toEqual({ count: 2, totalValue: 6500 });
      expect(result.atRiskDeals).toHaveLength(2);
    });

    it("forwards mine fallback flags into director scope subqueries when subscription tables are unavailable", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = {
        execute: vi.fn().mockImplementation((query: unknown) => {
          const text = extractSqlText(query).toLowerCase();
          if (text.includes("to_regclass(current_schema()")) {
            return Promise.resolve({ rows: [{ relation_name: null }] });
          }
          if (text.includes("information_schema.columns")) {
            return Promise.resolve({ rows: [{ column_exists: false }] });
          }
          if (text.includes("dd_value") && text.includes("pipeline_value")) {
            return Promise.resolve({
              rows: [{ dd_value: "0", dd_count: "0", pipeline_value: "0", pipeline_count: "0", total_value: "0", total_count: "0" }],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
      } as any;

      await getDirectorDashboard(tenantDb, {
        from: "2026-01-01",
        to: "2026-03-31",
        officeId: "office-1",
        scope: "mine",
        viewerUserId: "admin-1",
      });

      const scopeQueries = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .filter((text: string) => text.includes("assigned_rep_id = ") || text.includes("performed_by_user_id = "));

      expect(scopeQueries.some((text: string) => text.includes("deal_subscriptions"))).toBe(false);
      expect(scopeQueries.some((text: string) => text.includes("lead_subscriptions"))).toBe(false);
      expect(scopeQueries.some((text: string) => text.includes("created_by_user_id"))).toBe(false);
    });

    it("includes rep attribution in dashboard at-risk deals", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = {
        execute: vi.fn().mockImplementation((query: unknown) => {
          const text = extractSqlText(query).toLowerCase();

          if (text.includes("on_hold_accumulated_seconds_at_stage_entry")) {
            return Promise.resolve({
              rows: [{
                deal_id: "deal-1",
                rep_id: "rep-1",
                rep_name: "Avery Rep",
                deal_name: "Blocked Deal",
                stage_name: "Opportunity",
                stage_slug: "opportunity",
                mirrored_stage_status: "blocked",
                workflow_route: "normal",
                region_classification: "Dallas, TX",
                deal_value: "1000",
                stage_entered_at: "2026-01-01",
                on_hold: false,
                on_hold_started_at: null,
                on_hold_accumulated_seconds: "0",
                on_hold_accumulated_seconds_at_stage_entry: "0",
              }],
            });
          }

          if (text.includes("downstream") || text.includes("mirrored_stage_status")) {
            return Promise.resolve({
              rows: [{
                deal_id: "deal-1",
                rep_id: "rep-1",
                rep_name: "Avery Rep",
                deal_name: "Blocked Deal",
                stage_name: "Contract",
                mirrored_stage_slug: "contract",
                mirrored_stage_status: "blocked",
                workflow_route: "service",
                region_classification: "Dallas, TX",
                deal_value: "1000",
                stage_entered_at: "2026-01-01",
                on_hold: false,
                on_hold_started_at: null,
                on_hold_accumulated_seconds: "0",
                on_hold_accumulated_seconds_at_stage_entry: "0",
              }],
            });
          }

          if (text.includes("dd_value") && text.includes("pipeline_value")) {
            return Promise.resolve({
              rows: [{ dd_value: "0", dd_count: "0", pipeline_value: "0", pipeline_count: "0", total_value: "0", total_count: "0" }],
            });
          }

          return Promise.resolve({ rows: [] });
        }),
      } as any;

      const result = await getDirectorDashboard(tenantDb, {
        from: "2026-01-01",
        to: "2026-03-31",
        officeId: "office-1",
        periodKind: "qtd",
      });

      expect(result.atRiskDeals[0]).toMatchObject({
        dealId: "deal-1",
        repId: "rep-1",
        repName: "Avery Rep",
      });
    });

    it("prefers canonical upstream stage timestamps over history ingest time for downstream days-in-stage", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [],
        [],
        [],
        [],
        [],
        [],
        [],
      ]);

      await getDirectorDashboard(tenantDb, {
        from: "2026-01-01",
        to: "2026-03-31",
        officeId: "office-1",
        periodKind: "qtd",
      });

      const downstreamQuery = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .find((text: string) => text.includes("mirrored_stage_status"));

      expect(downstreamQuery).toContain("from deal_stage_history");
      expect(downstreamQuery).toContain("max(dsh.created_at)");
      expect(downstreamQuery).toContain("dsh.to_stage_id = d.stage_id");
      expect(downstreamQuery).toContain("coalesce(d.bid_board_stage_entered_at, d.stage_entered_at, latest_current_stage_entered_at.entered_at) as stage_entered_at");
      expect(downstreamQuery).not.toContain("coalesce(latest_current_stage_entered_at.entered_at, d.bid_board_stage_entered_at, d.stage_entered_at)");
    });

    it("keeps history as the downstream days-in-stage fallback when canonical timestamps are null", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [],
        [],
        [],
        [],
        [],
        [],
        [],
      ]);

      await getDirectorDashboard(tenantDb, {
        from: "2026-01-01",
        to: "2026-03-31",
        officeId: "office-1",
        periodKind: "qtd",
      });

      const downstreamQuery = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .find((text: string) => text.includes("mirrored_stage_status"));

      const stageClockExpression = "coalesce(d.bid_board_stage_entered_at, d.stage_entered_at, latest_current_stage_entered_at.entered_at)";
      expect(downstreamQuery).toContain(`${stageClockExpression} as stage_entered_at`);
    });

    it("scopes the rep-performance and funnel rosters to the active office (D-5)", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([]);

      await getDirectorDashboard(tenantDb, {
        from: "2026-01-01",
        to: "2026-03-31",
        officeId: "office-1",
        periodKind: "qtd",
      });

      const queryTexts = tenantDb.execute.mock.calls.map(([query]: [unknown]) =>
        extractSqlText(query).toLowerCase()
      );
      // users is a GLOBAL (public) table, so `FROM users u` returns reps from every office
      // unless the roster is office-scoped. Both Source-A rosters (the Sales Force rep cards
      // and the funnel distribution rows) must filter u.office_id, matching the Source-B
      // snapshot read (getRepPerformanceSnapshots) -- otherwise foreign-office reps leak in.
      const rosterQuery = queryTexts.find((t) => t.includes("from users u") && t.includes("rep_deals"));
      const funnelQuery = queryTexts.find((t) => t.includes("from users u") && t.includes("lead_counts"));

      expect(rosterQuery, "rep-performance roster query").toBeDefined();
      expect(funnelQuery, "director funnel rep-rows query").toBeDefined();
      expect(rosterQuery).toContain("u.office_id =");
      expect(funnelQuery).toContain("u.office_id =");
    });

    it("does not read admin-configured stale thresholds for stale lead watchlists", async () => {
      const { getDirectorDashboard } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([[], [], [], [], [], [], []]);

      await getDirectorDashboard(tenantDb, {
        from: "2026-01-01",
        to: "2026-03-31",
        officeId: "office-1",
        periodKind: "qtd",
      });

      const staleLeadQuery = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .find((text: string) => text.includes("from leads l") && text.includes("workflow_family = 'lead'"));

      expect(staleLeadQuery).toBeTruthy();
      expect(staleLeadQuery).not.toContain("stale_threshold_days");
    });
  });

  describe("getRepDetail", () => {
    it("should be a function accepting repId and options", async () => {
      const { getRepDetail } = await import("../../../src/modules/dashboard/service.js");
      expect(typeof getRepDetail).toBe("function");
    });

    it("passes the selected qtd range through to the rep activity query", async () => {
      const { getRepDetail } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [{ count: "0" }],
        [{ count: "0", total_value: "0" }],
        [{ overdue: "0", today: "0" }],
        [{ calls: "35", emails: "0", meetings: "5", notes: "17", total: "57" }],
        [{ total: "0", on_time: "0" }],
        [],
        [],
        [],
        [],
      ]);

      await getRepDetail(tenantDb, "rep-1", { from: "2026-04-01", to: "2026-05-15" });

      const activityQueryText = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .find((text: string) => text.includes("from activities") && text.includes("responsible_user_id")) ?? "";

      expect(activityQueryText).toContain("2026-04-01");
      expect(activityQueryText).toContain("2026-05-15");
    });

    it("passes the selected weekly range through to the rep activity query", async () => {
      const { getRepDetail } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [{ count: "0" }],
        [{ count: "0", total_value: "0" }],
        [{ overdue: "0", today: "0" }],
        [{ calls: "0", emails: "0", meetings: "0", notes: "2", total: "2" }],
        [{ total: "0", on_time: "0" }],
        [],
        [],
        [],
        [],
      ]);

      await getRepDetail(tenantDb, "rep-1", { from: "2026-05-08", to: "2026-05-15" });

      const activityQueryText = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .find((text: string) => text.includes("from activities") && text.includes("responsible_user_id")) ?? "";

      expect(activityQueryText).toContain("2026-05-08");
      expect(activityQueryText).toContain("2026-05-15");
    });

    it("passes the selected preset range through to follow-up compliance instead of hard-coding ytd", async () => {
      const { getRepDetail } = await import("../../../src/modules/dashboard/service.js");
      const tenantDb = createMockTenantDb([
        [{ count: "0" }],
        [{ count: "0", total_value: "0" }],
        [{ overdue: "0", today: "0" }],
        [{ calls: "0", emails: "0", meetings: "0", notes: "0", total: "0" }],
        [{ total: "7", on_time: "6" }],
        [],
        [],
        [],
        [],
      ]);

      await getRepDetail(tenantDb, "rep-1", { from: "2026-04-01", to: "2026-04-30" });

      const followUpQueryText = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .find((text: string) => text.includes("from tasks t") && text.includes("t.type = 'follow_up'")) ?? "";

      expect(followUpQueryText).toContain("2026-04-01");
      expect(followUpQueryText).toContain("2026-04-30");
    });

    it("anchors earned commission to a rolling 12-month window ending at the selected preset end date", async () => {
      const { getRepDetail } = await import("../../../src/modules/dashboard/service.js");
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

      await getRepDetail(tenantDb, "rep-1", { from: "2026-04-01", to: "2026-04-30" });

      const commissionQueryTexts = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .filter((text: string) =>
          text.includes("rep_user_id") &&
          text.includes("source_value_amount") &&
          text.includes("earned_commission")
        );

      expect(commissionQueryTexts.length).toBeGreaterThan(0);
      for (const text of commissionQueryTexts) {
        expect(text).toContain("2025-05-01");
        expect(text).toContain("2026-04-30");
        expect(text).not.toContain("2026-04-01");
      }
    });

    it("clamps leap-day rolling commission windows to the previous year's last valid day before adding one day", async () => {
      const { getRepDetail } = await import("../../../src/modules/dashboard/service.js");
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-02-29T12:00:00.000Z"));
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

      try {
        await getRepDetail(tenantDb, "rep-1", { from: "2024-02-01", to: "2024-02-29" });
      } finally {
        vi.useRealTimers();
      }

      const commissionQueryTexts = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .filter((text: string) =>
          text.includes("rep_user_id") &&
          text.includes("source_value_amount") &&
          text.includes("earned_commission")
        );

      expect(commissionQueryTexts.length).toBeGreaterThan(0);
      for (const text of commissionQueryTexts) {
        expect(text).toContain("2023-03-01");
        expect(text).toContain("2024-02-29");
        expect(text).not.toContain("2023-03-02");
      }
    });
  });

  describe("shared commission semantics", () => {
    it("preserves the rep self-dashboard commission range semantics outside the director detail override", async () => {
      const { getRepDashboard } = await import("../../../src/modules/dashboard/service.js");
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-21T12:00:00.000Z"));
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

      try {
        await getRepDashboard(tenantDb, "rep-1", { range: "month" });
      } finally {
        vi.useRealTimers();
      }

      const commissionQueryTexts = tenantDb.execute.mock.calls
        .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
        .filter((text: string) =>
          text.includes("rep_user_id") &&
          text.includes("source_value_amount") &&
          text.includes("earned_commission")
        );

      expect(commissionQueryTexts.length).toBeGreaterThan(0);
      for (const text of commissionQueryTexts) {
        expect(text).toContain("2026-05-01");
        expect(text).toContain("2026-05-21");
      }
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
