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
          stuck_deal_count: 6,
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
      totalStuckDeals: 6,
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
          proposal_sent_at: "2026-05-01T00:00:00.000Z",
          proposal_accepted_at: "2026-05-05T00:00:00.000Z",
          contract_signed_date: "2026-05-08",
          contract_signed_at: "2026-05-08T00:00:00.000Z",
          bid_board_assigned_pm: "Pat PM",
          next_milestone_at: "2026-05-15T00:00:00.000Z",
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
    expect(report.missingReadiness.map((deal) => deal.dealName)).toEqual(["Scoping Deal", "Estimate Deal"]);
    expect(report.ownerSummary).toContainEqual({
      ownerName: "Avery Rep",
      scopingIncomplete: 1,
      estimatingIncomplete: 0,
      kickoffIncomplete: 0,
    });
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
