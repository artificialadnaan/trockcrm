import { describe, expect, it, vi } from "vitest";

function createMockTenantDb(rowsByCall: any[][] = []) {
  return {
    execute: vi.fn().mockImplementation(() => Promise.resolve({ rows: rowsByCall.shift() ?? [] })),
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

describe("commission reporting service", () => {
  it("calculates MTD, QTD, YTD, and All date ranges deterministically", async () => {
    const { getCommissionPeriodDateRange } = await import("../../../src/modules/commissions/reporting-service.js");
    const now = new Date("2026-05-09T12:00:00.000Z");

    expect(getCommissionPeriodDateRange("mtd", now)).toEqual({ from: "2026-05-01", to: "2026-05-09" });
    expect(getCommissionPeriodDateRange("qtd", now)).toEqual({ from: "2026-04-01", to: "2026-05-09" });
    expect(getCommissionPeriodDateRange("ytd", now)).toEqual({ from: "2026-01-01", to: "2026-05-09" });
    expect(getCommissionPeriodDateRange("all", now)).toEqual({ from: null, to: null });
  });

  it("uses UTC consistently when deriving period date ranges", async () => {
    const { getCommissionPeriodDateRange } = await import("../../../src/modules/commissions/reporting-service.js");
    const nearUtcMonthBoundary = {
      getFullYear: () => 2026,
      getMonth: () => 1,
      getUTCFullYear: () => 2026,
      getUTCMonth: () => 2,
      toISOString: () => "2026-03-01T01:00:00.000Z",
    } as unknown as Date;

    expect(getCommissionPeriodDateRange("mtd", nearUtcMonthBoundary)).toEqual({
      from: "2026-03-01",
      to: "2026-03-01",
    });
  });

  it("maps summary, stage potential, earned months, and deal table with matching totals", async () => {
    const {
      getCommissionPotential,
      getCommissionEarned,
      getCommissionSummary,
    } = await import("../../../src/modules/commissions/reporting-service.js");
    const tenantDb = createMockTenantDb([
      [
        {
          stage_id: "stage-1",
          stage_name: "Estimate Sent to Client",
          stage_slug: "estimate_sent_to_client",
          display_order: 40,
          deal_count: "2",
          total_deal_value: "300000.00",
          potential_commission: "22500.00",
        },
      ],
      [
        { month: "2026-04", earned_commission: "7500.00", deal_count: "1" },
        { month: "2026-05", earned_commission: "15000.00", deal_count: "1" },
      ],
      [
        {
          deal_id: "deal-1",
          deal_number: "D-1",
          deal_name: "North Tower",
          rep_id: "rep-1",
          rep_name: "Rep One",
          stage_name: "Contract",
          stage_slug: "contract",
          source_value_amount: "100000.00",
          applied_rate: "0.075000",
          earned_commission: "7500.00",
          contract_signed_date: "2026-04-10",
          paid_ytd: "7500.00",
        },
        {
          deal_id: "deal-2",
          deal_number: "D-2",
          deal_name: "South Tower",
          rep_id: "rep-1",
          rep_name: "Rep One",
          stage_name: "Production",
          stage_slug: "sent_to_production",
          source_value_amount: "200000.00",
          applied_rate: "0.075000",
          earned_commission: "15000.00",
          contract_signed_date: "2026-05-10",
          paid_ytd: "0.00",
        },
      ],
      [
        {
          earned_mtd: "7500.00",
          earned_ytd: "22500.00",
          potential_pipeline: "22500.00",
          paid_ytd: "7500.00",
        },
      ],
    ]);

    const filters = {
      role: "rep" as const,
      userId: "rep-1",
      repId: "rep-2",
      from: "2026-01-01",
      to: "2026-12-31",
      stages: [],
    };

    const potential = await getCommissionPotential(tenantDb, filters);
    const earned = await getCommissionEarned(tenantDb, filters);
    const summary = await getCommissionSummary(tenantDb, filters);

    expect(potential.stageGroups[0]).toMatchObject({
      stageId: "stage-1",
      stageName: "Estimate Sent to Client",
      dealCount: 2,
      totalDealValue: 300000,
      potentialCommission: 22500,
    });
    expect(earned.months.map((row) => row.earnedCommission)).toEqual([7500, 15000]);
    expect(earned.deals.reduce((sum, row) => sum + row.earnedCommission, 0)).toBe(summary.earnedYtd);
    expect(summary).toMatchObject({
      earnedMtd: 7500,
      earnedYtd: 22500,
      potentialPipeline: 22500,
      paidYtd: 7500,
    });
  });

  it("forces rep users to their own commission rows even if a different rep filter is supplied", async () => {
    const { effectiveCommissionRepId, getCommissionSummary } = await import("../../../src/modules/commissions/reporting-service.js");
    const tenantDb = createMockTenantDb([[{ earned_mtd: "0", earned_ytd: "0", potential_pipeline: "0", paid_ytd: "0" }]]);

    const filters = {
      role: "rep",
      userId: "rep-self",
      repId: "rep-other",
      from: "2026-01-01",
      to: "2026-12-31",
      stages: [],
    } as const;

    await getCommissionSummary(tenantDb, filters);

    const queryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    expect(effectiveCommissionRepId(filters)).toBe("rep-self");
    expect(queryText).toContain("d.assigned_rep_id =");
  });

  it("includes legacy estimating aliases in potential commission during migration", async () => {
    const { getCommissionPotential } = await import("../../../src/modules/commissions/reporting-service.js");
    const tenantDb = createMockTenantDb([
      [
        {
          stage_id: "legacy-stage-1",
          stage_name: "Estimate in Progress",
          stage_slug: "estimate_in_progress",
          display_order: 30,
          deal_count: "1",
          total_deal_value: "100000.00",
          potential_commission: "7500.00",
        },
        {
          stage_id: "legacy-stage-2",
          stage_name: "Service Estimate Under Review",
          stage_slug: "service_estimate_under_review",
          display_order: 35,
          deal_count: "1",
          total_deal_value: "200000.00",
          potential_commission: "15000.00",
        },
      ],
    ]);

    const potential = await getCommissionPotential(tenantDb, {
      role: "admin",
      userId: "admin-1",
      stages: [],
    });

    const queryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    expect(queryText).toContain("'estimate_in_progress'");
    expect(queryText).toContain("'service_estimate_under_review'");
    expect(queryText).toContain("'service_estimate_sent_to_client'");
    expect(potential.stageGroups.map((row) => row.stageSlug)).toEqual([
      "estimate_in_progress",
      "service_estimate_under_review",
    ]);
    expect(potential.stageGroups.reduce((sum, row) => sum + row.potentialCommission, 0)).toBe(22500);
  });

  it("uses unsigned active deals for potential and signed non-lost deals for earned", async () => {
    const { getCommissionEarned, getCommissionSummary } = await import("../../../src/modules/commissions/reporting-service.js");
    const tenantDb = createMockTenantDb([[], [], [{ earned_mtd: "0", earned_ytd: "0", potential_pipeline: "0", paid_ytd: "0" }]]);
    const filters = {
      role: "admin",
      userId: "admin-1",
      from: "2026-01-01",
      to: "2026-12-31",
      stages: [],
    } as const;

    await getCommissionEarned(tenantDb, filters);
    await getCommissionSummary(tenantDb, filters);

    const sqlText = tenantDb.execute.mock.calls.map((call: any[]) => extractSqlText(call[0]).toLowerCase()).join("\n");
    expect(sqlText).toContain("'contract'");
    expect(sqlText).toContain("'opportunity'");
    expect(sqlText).toContain("'estimating'");
    expect(sqlText).toContain("'service_estimating'");
    expect(sqlText).toContain("'estimate_under_review'");
    expect(sqlText).toContain("'estimate_sent_to_client'");
    expect(sqlText).toContain("'estimate_in_progress'");
    expect(sqlText).toContain("'service_estimate_under_review'");
    expect(sqlText).toContain("'service_estimate_sent_to_client'");
    expect(sqlText).toContain("contract_signed_at is null");
    expect(sqlText).toContain("contract_signed_date is null");
    expect(sqlText).toContain("coalesce(d.contract_signed_at::date, d.contract_signed_date, dsc.contract_signed_date_at_signing) is not null");
    expect(sqlText).toContain("slug not in ('lost', 'production_lost', 'service_lost', 'closed_lost')");
    expect(sqlText).not.toContain("slug in ('won', 'sent_to_production', 'service_sent_to_production', 'closed_won')");
    expect(sqlText).not.toContain("display_order >=");
    expect(sqlText).not.toContain("service_contract_signed");
    expect(sqlText).not.toContain("estimated_margin_rate");
    expect(sqlText).not.toContain("current_date");
    expect(sqlText).not.toContain("date_trunc('month', current_date)");
    expect(sqlText).not.toContain("date_trunc('year', current_date)");
  });

  it("counts historical contract_signed_date rows as earned without requiring won stage", async () => {
    const { getCommissionEarned } = await import("../../../src/modules/commissions/reporting-service.js");
    const tenantDb = createMockTenantDb([
      [{ month: "2026-04", earned_commission: "7500.00", deal_count: "1" }],
      [
        {
          deal_id: "deal-legacy",
          deal_number: "D-LEGACY",
          deal_name: "Legacy Signed Deal",
          rep_id: "rep-1",
          rep_name: "Rep One",
          stage_name: "Contract",
          stage_slug: "contract",
          source_value_amount: "100000.00",
          applied_rate: "0.075000",
          earned_commission: "7500.00",
          contract_signed_date: "2026-04-10",
          paid_ytd: "0.00",
        },
      ],
    ]);

    const earned = await getCommissionEarned(tenantDb, {
      role: "admin",
      userId: "admin-1",
      from: "2026-01-01",
      to: "2026-12-31",
      stages: [],
    });

    const sqlText = tenantDb.execute.mock.calls.map((call: any[]) => extractSqlText(call[0]).toLowerCase()).join("\n");
    expect(earned.months[0]).toMatchObject({ earnedCommission: 7500, dealCount: 1 });
    expect(earned.deals[0]).toMatchObject({ dealId: "deal-legacy", earnedCommission: 7500, contractSignedDate: "2026-04-10" });
    expect(sqlText).toContain("coalesce(d.contract_signed_at::date, d.contract_signed_date, dsc.contract_signed_date_at_signing)");
    expect(sqlText).not.toContain("slug in ('won', 'sent_to_production', 'service_sent_to_production', 'closed_won')");
  });

  it("builds the sales-rep dashboard with earned, pipeline, stage totals, and deltas", async () => {
    const { getRepCommissionDashboard } = await import("../../../src/modules/commissions/reporting-service.js");
    const tenantDb = createMockTenantDb([
      [
        {
          deal_id: "deal-earned",
          deal_number: "D-1",
          deal_name: "Signed Deal",
          rep_id: "rep-1",
          company_name: "Client Co",
          property_name: "Main Campus",
          property_address: "1 Main",
          stage_slug: "sent_to_production",
          deal_value: "100000.00",
          commission_rate: "0.015000",
          commission: "1500.00",
          contract_signed_date: "2026-05-02",
          expected_close_date: null,
          days_in_stage: "5",
          is_earned: true,
          snapshot_commission_amount: "1500.00",
        },
        {
          deal_id: "deal-contract",
          deal_number: "D-2",
          deal_name: "Contract Deal",
          rep_id: "rep-1",
          company_name: "Industrial Co",
          property_name: null,
          property_address: "2 Main",
          stage_slug: "contract",
          deal_value: "305000.00",
          commission_rate: "0.015000",
          commission: "4575.00",
          contract_signed_date: null,
          expected_close_date: "2026-05-22",
          days_in_stage: "7",
          is_earned: false,
          snapshot_commission_amount: "4500.00",
        },
      ],
      [],
    ]);

    const data = await getRepCommissionDashboard(tenantDb, {
      role: "rep",
      userId: "rep-1",
      repId: "rep-other",
      period: "ytd",
      stages: [],
    });

    expect(data.summary).toMatchObject({
      earned: 1500,
      inPipeline: 4575,
      totalPotential: 6075,
      openDealCount: 1,
    });
    expect(data.deals.find((deal) => deal.dealId === "deal-contract")).toMatchObject({
      stageKey: "contract",
      deltaCommission: 75,
    });
    expect(data.stageTotals.map((stage) => stage.stageKey)).toEqual([
      "won",
      "contract",
      "estimate_sent",
      "estimating",
      "opportunity",
    ]);
    expect(tenantDb.execute).toHaveBeenCalledTimes(2);
  });

  it("scopes snapshot reads and writes by both deal and rep", async () => {
    const { getRepCommissionDashboard } = await import("../../../src/modules/commissions/reporting-service.js");
    const tenantDb = createMockTenantDb([
      [
        {
          deal_id: "deal-earned",
          deal_number: "D-1",
          deal_name: "Signed Deal",
          rep_id: "rep-1",
          company_name: "Client Co",
          property_name: null,
          property_address: null,
          stage_slug: "sent_to_production",
          deal_value: "100000.00",
          commission_rate: "0.015000",
          commission: "1500.00",
          contract_signed_date: "2026-05-02",
          expected_close_date: null,
          days_in_stage: "5",
          is_earned: true,
          snapshot_commission_amount: "1200.00",
        },
      ],
      [],
    ]);

    await getRepCommissionDashboard(tenantDb, {
      role: "rep",
      userId: "rep-1",
      period: "ytd",
      stages: [],
    });

    const querySql = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    const snapshotSql = extractSqlText(tenantDb.execute.mock.calls[1][0]).toLowerCase();
    expect(querySql).toContain("left join commission_deal_snapshots cds on cds.deal_id = d.id");
    expect(querySql).toContain("cds.rep_user_id = dsc.rep_user_id");
    expect(querySql).toContain("cds.rep_user_id = d.assigned_rep_id");
    expect(snapshotSql).toContain("on conflict (deal_id, rep_user_id) do update");
  });

  it("forces the rep dashboard query to the current rep and uses deal value times rate for pipeline", async () => {
    const { getRepCommissionDashboard } = await import("../../../src/modules/commissions/reporting-service.js");
    const tenantDb = createMockTenantDb([[], []]);

    await getRepCommissionDashboard(tenantDb, {
      role: "rep",
      userId: "rep-self",
      repId: "rep-other",
      period: "mtd",
      stages: [],
    });

    const queryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    expect(queryText).toContain("dsc.rep_user_id =");
    expect(queryText).toContain("d.assigned_rep_id =");
    expect(queryText).toContain("coalesce(cs.commission_rate, 0)");
    expect(queryText).not.toContain("estimated_margin_rate");
  });
});
