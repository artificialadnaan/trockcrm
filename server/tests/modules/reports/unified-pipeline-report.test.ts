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

describe("getUnifiedWorkflowOverview", () => {
  it("returns lead pipeline summary grouped by workflow family and status", async () => {
    const { getUnifiedWorkflowOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = {
      execute: vi.fn()
        .mockResolvedValueOnce({
          rows: [
            { workflow_route: "estimating", validation_status: "draft", intake_count: "3" },
            { workflow_route: "service", validation_status: "ready", intake_count: "2" },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    } as any;

    const result = await getUnifiedWorkflowOverview(tenantDb);

    expect(result.leadPipelineSummary).toEqual([
      { workflowRoute: "estimating", validationStatus: "draft", intakeCount: 3 },
      { workflowRoute: "service", validationStatus: "ready", intakeCount: 2 },
    ]);
  });

  it("returns standard and service rollups separately", async () => {
    const { getUnifiedWorkflowOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { workflow_route: "estimating", deal_count: "6", total_value: "600000", stale_deal_count: "1" },
            { workflow_route: "service", deal_count: "4", total_value: "240000", stale_deal_count: "2" },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    } as any;

    const result = await getUnifiedWorkflowOverview(tenantDb);

    expect(result.standardVsServiceRollups).toEqual([
      { workflowRoute: "estimating", dealCount: 6, totalValue: 600000, staleDealCount: 1 },
      { workflowRoute: "service", dealCount: 4, totalValue: 240000, staleDealCount: 2 },
    ]);
  });

  it("aggregates company rollups across multiple properties and deals", async () => {
    const { getUnifiedWorkflowOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
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
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    } as any;

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
    const tenantDb = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
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
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    } as any;

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

  it("returns stale lead and stale deal outputs", async () => {
    const { getUnifiedWorkflowOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              lead_id: "lead-1",
              lead_name: "Palm Villas",
              company_name: "Alpha Roofing",
              workflow_route: "estimating",
              validation_status: "ready",
              age_in_days: "21",
              stale_threshold_days: "14",
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              deal_id: "deal-1",
              deal_number: "TR-2026-0001",
              deal_name: "Roof Repair",
              stage_name: "Estimating",
              workflow_route: "estimating",
              rep_name: "Jordan",
              days_in_stage: "18",
              stale_threshold_days: "14",
              deal_value: "250000",
            },
          ],
        }),
    } as any;

    const result = await getUnifiedWorkflowOverview(tenantDb);

    expect(result.staleLeads).toEqual([
      {
        leadId: "lead-1",
        leadName: "Palm Villas",
        companyName: "Alpha Roofing",
        workflowRoute: "estimating",
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
        stageName: "Estimating",
        workflowRoute: "estimating",
        repName: "Jordan",
        daysInStage: 18,
        staleThresholdDays: 14,
        dealValue: 250000,
      },
    ]);
  });
});
