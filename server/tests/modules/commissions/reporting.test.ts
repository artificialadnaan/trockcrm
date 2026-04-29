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
          stage_name: "Contract Signed",
          stage_slug: "contract_signed",
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
          stage_name: "Contract Signed",
          stage_slug: "contract_signed",
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
      stages: ["contract_signed"],
    };

    const potential = await getCommissionPotential(tenantDb, filters);
    const earned = await getCommissionEarned(tenantDb, filters);
    const summary = await getCommissionSummary(tenantDb, filters);

    expect(potential.stageGroups[0]).toMatchObject({
      stageId: "stage-1",
      stageName: "Contract Signed",
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
});
