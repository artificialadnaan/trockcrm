import { describe, expect, it, vi } from "vitest";

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

function createMockTenantDb(rows: any[] = []) {
  return {
    execute: vi.fn().mockResolvedValue({ rows }),
  } as any;
}

function createUnifiedWorkflowMockTenantDb(overrides: Partial<Record<number, any[]>> = {}) {
  return {
    execute: vi.fn().mockImplementation((() => {
      let callIndex = 0;
      return () => Promise.resolve({ rows: overrides[callIndex++] ?? [] });
    })()),
  } as any;
}

function flattenSqlQuery(query: any): string {
  return (query?.queryChunks ?? [])
    .map((chunk: any) => {
      if (typeof chunk === "string") return chunk;
      if (chunk?.value && Array.isArray(chunk.value)) {
        return chunk.value
          .map((part: any) => (typeof part === "string" ? part : String(part)))
          .join("");
      }
      return String(chunk);
    })
    .join("");
}

describe("getUnifiedWorkflowOverview", () => {
  it("returns lead pipeline summary grouped by workflow family and status", async () => {
    const { getUnifiedWorkflowOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = createUnifiedWorkflowMockTenantDb({
      0: [
        { workflow_route: "normal", validation_status: "draft", intake_count: "3" },
        { workflow_route: "service", validation_status: "ready", intake_count: "2" },
      ],
    });

    const result = await getUnifiedWorkflowOverview(tenantDb);

    expect(result.leadPipelineSummary).toEqual([
      { workflowRoute: "normal", validationStatus: "draft", intakeCount: 3 },
      { workflowRoute: "service", validationStatus: "ready", intakeCount: 2 },
    ]);
  });

  it("returns standard and service rollups separately", async () => {
    const { getUnifiedWorkflowOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = createUnifiedWorkflowMockTenantDb({
      1: [
        { workflow_route: "normal", deal_count: "6", total_value: "600000", stale_deal_count: "1" },
        { workflow_route: "service", deal_count: "4", total_value: "240000", stale_deal_count: "2" },
      ],
    });

    const result = await getUnifiedWorkflowOverview(tenantDb);

    expect(result.standardVsServiceRollups).toEqual([
      { workflowRoute: "normal", dealCount: 6, totalValue: 600000, staleDealCount: 1 },
      { workflowRoute: "service", dealCount: 4, totalValue: 240000, staleDealCount: 2 },
    ]);
  });

  it("aggregates company rollups across multiple properties and deals", async () => {
    const { getUnifiedWorkflowOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = createUnifiedWorkflowMockTenantDb({
      2: [
        {
          company_id: "company-1",
          company_name: "Alpha Roofing",
          property_count: "2",
          deal_count: "3",
          lead_count: "2",
          active_deal_count: "2",
          standard_deal_count: "2",
          service_deal_count: "1",
          total_value: "750000",
        },
      ],
    });

    const result = await getUnifiedWorkflowOverview(tenantDb);

    expect(result.companyRollups).toEqual([
      {
        companyId: "company-1",
        companyName: "Alpha Roofing",
        propertyCount: 2,
        dealCount: 3,
        leadCount: 2,
        activeDealCount: 2,
        standardDealCount: 2,
        serviceDealCount: 1,
        totalValue: 750000,
      },
    ]);
  });

  it("splits rep activity between lead-stage and deal-stage work", async () => {
    const { getUnifiedWorkflowOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = createUnifiedWorkflowMockTenantDb({
      3: [
        {
          rep_id: "rep-1",
          rep_name: "Jordan",
          lead_stage_calls: "4",
          lead_stage_emails: "3",
          lead_stage_meetings: "1",
          lead_stage_notes: "2",
          deal_stage_calls: "5",
          deal_stage_emails: "6",
          deal_stage_meetings: "2",
          deal_stage_notes: "1",
          total_lead_stage_activities: "10",
          total_deal_stage_activities: "14",
        },
      ],
    });

    const result = await getUnifiedWorkflowOverview(tenantDb);

    expect(result.repActivitySplit).toEqual([
      {
        repId: "rep-1",
        repName: "Jordan",
        leadStageCalls: 4,
        leadStageEmails: 3,
        leadStageMeetings: 1,
        leadStageNotes: 2,
        dealStageCalls: 5,
        dealStageEmails: 6,
        dealStageMeetings: 2,
        dealStageNotes: 1,
        totalLeadStageActivities: 10,
        totalDealStageActivities: 14,
      },
    ]);
  });

  it("attributes activity using activation timing instead of a hard-coded year window", async () => {
    const { getUnifiedWorkflowOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = createUnifiedWorkflowMockTenantDb();

    await getUnifiedWorkflowOverview(tenantDb);

    const activityQuery = tenantDb.execute.mock.calls[3]?.[0];
    const sqlText = flattenSqlQuery(activityQuery);

    expect(sqlText).toContain("dsi.activated_at");
    expect(sqlText).toContain("a.occurred_at >= dsi.activated_at");
    expect(sqlText).not.toContain(`${new Date().getFullYear()}-01-01`);
  });

  it("returns stale lead and stale deal outputs", async () => {
    const { getUnifiedWorkflowOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = createUnifiedWorkflowMockTenantDb({
      4: [
        {
          lead_id: "lead-1",
          lead_name: "Palm Villas",
          company_name: "Alpha Roofing",
          workflow_route: "normal",
          validation_status: "ready",
          age_in_days: "21",
          stale_threshold_days: "14",
        },
      ],
      5: [
        {
          deal_id: "deal-1",
          deal_number: "TR-2026-0001",
          deal_name: "Roof Repair",
          stage_name: "Bid Sent",
          workflow_route: "normal",
          rep_name: "Jordan",
          days_in_stage: "18",
          stale_threshold_days: "14",
          deal_value: "250000",
          bid_board_stage_slug: "bid_sent",
          bid_board_stage_status: "stalled",
          region_classification: "Texas",
        },
      ],
    });

    const result = await getUnifiedWorkflowOverview(tenantDb);

    expect(result.staleLeads).toEqual([
      {
        leadId: "lead-1",
        leadName: "Palm Villas",
        companyName: "Alpha Roofing",
        workflowRoute: "normal",
        validationStatus: "ready",
        ageInDays: 21,
        staleThresholdDays: 14,
      },
    ]);
    expect(result.staleDeals).toEqual([
      {
        dealId: "deal-1",
        dealNumber: "TR-2026-0001",
        dealName: "Roof Repair",
        stageName: "Bid Sent",
        workflowRoute: "normal",
        repName: "Jordan",
        daysInStage: 18,
        staleThresholdDays: 14,
        dealValue: 250000,
        bidBoardStageSlug: "bid_sent",
        bidBoardStageStatus: "stalled",
        regionClassification: "Texas",
      },
    ]);
  });

  it("uses mirrored stage joins, mirrored entered-at timing, and workflow ordering in the new queries", async () => {
    const { getUnifiedWorkflowOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = createUnifiedWorkflowMockTenantDb();

    await getUnifiedWorkflowOverview(tenantDb);

    const staleDealsQuery = flattenSqlQuery(tenantDb.execute.mock.calls[5]?.[0]).toLowerCase();
    const progressionQuery = flattenSqlQuery(tenantDb.execute.mock.calls[6]?.[0]).toLowerCase();
    const disqualificationQuery = flattenSqlQuery(tenantDb.execute.mock.calls[8]?.[0]).toLowerCase();

    expect(staleDealsQuery).toContain("left join pipeline_stage_config mirror_psc");
    expect(staleDealsQuery).toContain("coalesce(d.bid_board_stage_entered_at, d.stage_entered_at)");
    expect(staleDealsQuery).toContain("coalesce(mirror_psc.stale_threshold_days, psc.stale_threshold_days)");
    expect(progressionQuery).toContain("min(display_order)");
    expect(progressionQuery).toContain("order by display_order asc");
    expect(disqualificationQuery).toContain("coalesce(l.disqualification_reason, 'other')");
    expect(disqualificationQuery).not.toContain("and l.disqualification_reason is not null");
  });
});
