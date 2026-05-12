import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearOperationsReportsCache,
  getPortfolioLoadReport,
  getProjectReadinessReport,
  getWorkflowBottlenecksReport,
  normalizeOperationsReportFilters,
} from "../../../src/modules/reports/operations-tier3-service.js";

function makeTenantDb(results: unknown[][]) {
  const execute = vi.fn(async () => ({ rows: results.shift() ?? [] }));
  return { execute } as any;
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

describe("operations tier 3 reports", () => {
  beforeEach(() => {
    clearOperationsReportsCache();
  });

  it("builds workflow bottlenecks with stage aging, stuck deals, and handoff blockages", async () => {
    const tenantDb = makeTenantDb([
      [
        {
          stage_name: "Estimating",
          open_deal_count: 6,
          avg_days_in_stage: "34.5",
          median_days_in_stage: "31.0",
          max_days_in_stage: 72,
          stuck_deal_count: 5,
        },
      ],
      [
        {
          deal_id: "deal-1",
          deal_name: "North Campus Roof",
          owner_name: "Avery Rep",
          stage_name: "Estimating",
          days_in_stage: 72,
          days_since_last_activity: 12,
          value: "250000",
          project_number: "TR-123",
        },
      ],
      [
        {
          deal_id: "deal-2",
          deal_name: "South Handoff",
          owner_name: "Avery Rep",
          stage_name: "Contract",
          days_in_stage: 22,
          days_since_last_activity: 8,
          value: "99000",
          project_number: null,
        },
      ],
    ]);

    const report = await getWorkflowBottlenecksReport(tenantDb, {
      dateFrom: "2026-02-01",
      dateTo: "2026-05-11",
      office: "all",
      ownerIds: ["owner-1"],
      cacheScope: "tenant-a",
    });

    expect(report.kpis).toEqual({
      totalStuckDeals: 5,
      avgDealAge: 34.5,
      longestStuckDealAge: 72,
      stagesWithFivePlusStuckDeals: 1,
    });
    expect(report.stageAging[0]?.stageName).toBe("Estimating");
    expect(report.topStuckDeals[0]).toMatchObject({
      dealName: "North Campus Roof",
      ownerName: "Avery Rep",
      stageName: "Estimating",
      value: 250000,
    });
    expect(report.handoffBlockages[0]?.dealName).toBe("South Handoff");
  });

  it("keeps the five-minute cache scoped by tenant cacheScope", async () => {
    const results = [
      [{ stage_name: "Scoping", open_deal_count: 1, avg_days_in_stage: 10, median_days_in_stage: 10, max_days_in_stage: 10, stuck_deal_count: 0 }],
      [],
      [],
      [{ stage_name: "Scoping", open_deal_count: 2, avg_days_in_stage: 20, median_days_in_stage: 20, max_days_in_stage: 20, stuck_deal_count: 0 }],
      [],
      [],
    ];
    const tenantDb = makeTenantDb(results);

    await getWorkflowBottlenecksReport(tenantDb, { dateFrom: "2026-02-01", dateTo: "2026-05-11", cacheScope: "tenant-a" });
    await getWorkflowBottlenecksReport(tenantDb, { dateFrom: "2026-02-01", dateTo: "2026-05-11", cacheScope: "tenant-a" });
    await getWorkflowBottlenecksReport(tenantDb, { dateFrom: "2026-02-01", dateTo: "2026-05-11", cacheScope: "tenant-b" });

    expect(tenantDb.execute).toHaveBeenCalledTimes(6);
  });

  it("reuses the workflow-bottlenecks cache when only the date range changes", async () => {
    // Active-work reports intentionally exclude date filters from SQL, so the
    // cache key must also exclude them or every range change re-issues the
    // same three queries.
    const results = [
      [{ stage_name: "Scoping", open_deal_count: 1, avg_days_in_stage: 10, median_days_in_stage: 10, max_days_in_stage: 10, stuck_deal_count: 0 }],
      [],
      [],
    ];
    const tenantDb = makeTenantDb(results);

    await getWorkflowBottlenecksReport(tenantDb, {
      dateFrom: "2026-02-01",
      dateTo: "2026-05-11",
      cacheScope: "tenant-a",
    });
    await getWorkflowBottlenecksReport(tenantDb, {
      dateFrom: "2025-01-01",
      dateTo: "2025-12-31",
      cacheScope: "tenant-a",
    });

    expect(tenantDb.execute).toHaveBeenCalledTimes(3);
  });

  it("overlays the current request date range onto the cached response filters", async () => {
    // The cache key intentionally ignores dateFrom/dateTo (active-work reports
    // do not filter by date in SQL), but the response embeds `filters` for
    // downstream consumers (UI badges, export metadata). On a cache hit the
    // helper must overlay the new request's dates so a second caller does not
    // see stale dateFrom/dateTo from the first call.
    const results = [
      [{ stage_name: "Scoping", open_deal_count: 1, avg_days_in_stage: 10, median_days_in_stage: 10, max_days_in_stage: 10, stuck_deal_count: 0 }],
      [],
      [],
    ];
    const tenantDb = makeTenantDb(results);

    const first = await getWorkflowBottlenecksReport(tenantDb, {
      dateFrom: "2026-02-01",
      dateTo: "2026-05-11",
      cacheScope: "tenant-a",
    });
    const second = await getWorkflowBottlenecksReport(tenantDb, {
      dateFrom: "2025-01-01",
      dateTo: "2025-12-31",
      cacheScope: "tenant-a",
    });

    expect(first.filters.dateFrom).toBe("2026-02-01");
    expect(first.filters.dateTo).toBe("2026-05-11");
    // The second call hits cache (asserted in the previous test) but its
    // filters should reflect ITS request, not the first one's.
    expect(second.filters.dateFrom).toBe("2025-01-01");
    expect(second.filters.dateTo).toBe("2025-12-31");
  });

  it("does not date-bound current active-work reports by deal creation date", async () => {
    const tenantDb = makeTenantDb([[], [], [], [], []]);

    await getWorkflowBottlenecksReport(tenantDb, {
      dateFrom: "2026-04-11",
      dateTo: "2026-05-11",
      cacheScope: "tenant-a",
    });
    await getProjectReadinessReport(tenantDb, {
      dateFrom: "2026-04-11",
      dateTo: "2026-05-11",
      cacheScope: "tenant-a",
    });
    await getPortfolioLoadReport(tenantDb, {
      dateFrom: "2026-04-11",
      dateTo: "2026-05-11",
      cacheScope: "tenant-a",
    });

    const sqlText = tenantDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query)).join("\n");
    expect(sqlText).toContain("d.is_active = TRUE");
    expect(sqlText).toContain("psc.is_terminal = FALSE");
    expect(sqlText).not.toContain("d.created_at");
  });

  it("reports zero longest-stuck age when no deals are actually stuck", async () => {
    const tenantDb = makeTenantDb([
      [
        {
          stage_name: "Scoping",
          open_deal_count: 3,
          avg_days_in_stage: 10,
          median_days_in_stage: 10,
          max_days_in_stage: 29,
          stuck_deal_count: 0,
        },
      ],
      [],
      [],
    ]);

    const report = await getWorkflowBottlenecksReport(tenantDb, {
      dateFrom: "2026-04-11",
      dateTo: "2026-05-11",
      cacheScope: "tenant-a",
    });

    expect(report.kpis.totalStuckDeals).toBe(0);
    expect(report.kpis.longestStuckDealAge).toBe(0);
    expect(report.kpis.stagesWithFivePlusStuckDeals).toBe(0);
  });

  it("builds project readiness from scoping completion, proposal, contract, and kickoff proxies", async () => {
    const tenantDb = makeTenantDb([
      [
        {
          deal_id: "deal-1",
          deal_name: "Scoping Deal",
          owner_name: "Avery Rep",
          stage_name: "Scoping",
          stage_slug: "scoping",
          days_in_stage: 9,
          project_number: "TR-1",
          proposal_status: "not_started",
          proposal_sent_at: null,
          proposal_accepted_at: null,
          contract_signed_date: null,
          contract_signed_at: null,
          bid_board_assigned_pm: null,
          next_milestone_at: null,
          scoping_status: "draft",
          completion_state: {
            attachments: { isComplete: false, missingFields: [], missingAttachments: ["sitePhotos"] },
          },
        },
        {
          deal_id: "deal-2",
          deal_name: "Estimate Deal",
          owner_name: "Blake Rep",
          stage_name: "Estimating",
          stage_slug: "estimating",
          days_in_stage: 12,
          project_number: null,
          proposal_status: "drafting",
          proposal_sent_at: null,
          proposal_accepted_at: null,
          contract_signed_date: null,
          contract_signed_at: null,
          bid_board_assigned_pm: null,
          next_milestone_at: null,
          scoping_status: "ready",
          completion_state: {},
        },
        {
          deal_id: "deal-3",
          deal_name: "Signed Deal",
          owner_name: "Blake Rep",
          stage_name: "Contract",
          stage_slug: "contract",
          days_in_stage: 2,
          project_number: null,
          proposal_status: "accepted",
          proposal_sent_at: null,
          proposal_accepted_at: "2026-05-05T00:00:00.000Z",
          contract_signed_date: "2026-05-08",
          contract_signed_at: "2026-05-08T00:00:00.000Z",
          bid_board_assigned_pm: "Pat PM",
          next_milestone_at: "2026-05-15T00:00:00.000Z",
          scoping_status: "ready",
          completion_state: {},
        },
        {
          deal_id: "deal-4",
          deal_name: "Kickoff Deal",
          owner_name: "Casey Ops",
          stage_name: "Kickoff",
          stage_slug: "kickoff",
          days_in_stage: 14,
          project_number: "TR-4",
          proposal_status: "not_started",
          proposal_sent_at: null,
          proposal_accepted_at: null,
          contract_signed_date: null,
          contract_signed_at: null,
          bid_board_assigned_pm: null,
          next_milestone_at: null,
          scoping_status: "ready",
          completion_state: {},
        },
      ],
    ]);

    const report = await getProjectReadinessReport(tenantDb, {
      dateFrom: "2026-02-01",
      dateTo: "2026-05-11",
      cacheScope: "tenant-a",
    });

    expect(report.kpis.dealsInScoping).toBe(1);
    expect(report.kpis.dealsInEstimating).toBe(1);
    expect(report.kpis.dealsContractReady).toBe(1);
    expect(report.kpis.dealsKickoffReady).toBe(1);
    expect(report.missingReadiness.map((deal) => deal.dealName)).toEqual(["Scoping Deal", "Estimate Deal", "Kickoff Deal"]);
    expect(report.ownerSummary).toContainEqual({
      ownerName: "Avery Rep",
      scopingIncomplete: 1,
      estimatingIncomplete: 0,
      kickoffIncomplete: 0,
    });
    expect(report.ownerSummary).toContainEqual({
      ownerName: "Casey Ops",
      scopingIncomplete: 0,
      estimatingIncomplete: 0,
      kickoffIncomplete: 1,
    });
  });

  it("classifies rejected proposals on ambiguous stages as estimating", async () => {
    const tenantDb = makeTenantDb([
      [
        {
          deal_id: "deal-rejected",
          deal_name: "Rejected Proposal Deal",
          owner_name: "Blake Rep",
          stage_name: "Operations Review",
          stage_slug: "ops_review",
          days_in_stage: 3,
          project_number: "TR-REJECTED",
          proposal_status: "rejected",
          proposal_sent_at: null,
          proposal_accepted_at: null,
          contract_signed_date: null,
          contract_signed_at: null,
          bid_board_assigned_pm: null,
          next_milestone_at: null,
          scoping_status: "ready",
          completion_state: {},
        },
      ],
    ]);

    const report = await getProjectReadinessReport(tenantDb, {
      dateFrom: "2026-02-01",
      dateTo: "2026-05-11",
      cacheScope: "tenant-rejected",
    });

    expect(report.kpis.dealsInEstimating).toBe(1);
    expect(report.kpis.dealsKickoffReady).toBe(0);
    expect(report.missingReadiness[0]).toMatchObject({
      dealName: "Rejected Proposal Deal",
      stageName: "Operations Review",
    });
    expect(report.checklistBreakdown).toContainEqual(expect.objectContaining({
      stageGroup: "Estimating",
      incompleteCount: 1,
    }));
    expect(report.checklistBreakdown).toContainEqual(expect.objectContaining({
      stageGroup: "Kickoff",
      incompleteCount: 0,
    }));
  });

  it("builds portfolio load grouped by company, property, office, and region", async () => {
    const tenantDb = makeTenantDb([
      [
        {
          deal_id: "deal-1",
          company_id: "company-1",
          company_name: "Acme Properties",
          property_id: "property-1",
          property_name: "Acme Tower",
          owner_name: "Avery Rep",
          office_code: "dallas",
          city: "Dallas",
          state: "TX",
          region: "North Texas",
          value: "200000",
          days_in_stage: 20,
          last_activity_at: "2026-05-02T00:00:00.000Z",
        },
        {
          deal_id: "deal-2",
          company_id: "company-1",
          company_name: "Acme Properties",
          property_id: "property-2",
          property_name: "Acme Annex",
          owner_name: "Blake Rep",
          office_code: "dallas",
          city: "Dallas",
          state: "TX",
          region: "North Texas",
          value: "50000",
          days_in_stage: 10,
          last_activity_at: "2026-05-08T00:00:00.000Z",
        },
      ],
    ]);

    const report = await getPortfolioLoadReport(tenantDb, {
      dateFrom: "2026-02-01",
      dateTo: "2026-05-11",
      office: "dallas",
      cacheScope: "tenant-a",
    });

    expect(report.kpis).toMatchObject({
      activeCompanies: 1,
      activeProperties: 2,
      totalActiveValue: 250000,
      avgDealValuePerCompany: 250000,
    });
    expect(report.companyBreakdown[0]).toMatchObject({
      companyName: "Acme Properties",
      activeDealCount: 2,
      totalOpenValue: 250000,
      topProperty: "Acme Tower",
      avgDealAge: 15,
    });
    expect(report.geographicSpread.byOffice[0]).toEqual({ office: "Dallas", dealCount: 2, totalValue: 250000 });
  });

  it("normalizes date, office, and owner filters", () => {
    expect(normalizeOperationsReportFilters({
      dateFrom: "2026-02-01",
      dateTo: "2026-05-11",
      office: "dallas",
      ownerIds: "owner-1, owner-2",
      ownerNames: "Avery Rep, Blake Rep",
      cacheScope: "tenant-a",
    })).toMatchObject({
      dateFrom: "2026-02-01",
      dateTo: "2026-05-11",
      office: "dallas",
      ownerIds: ["owner-1", "owner-2"],
      ownerNames: ["Avery Rep", "Blake Rep"],
      cacheScope: "tenant-a",
    });
  });
});
