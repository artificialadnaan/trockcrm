import { describe, expect, it, vi } from "vitest";
import {
  computePreviousPeriod,
  getCustomerConcentrationReport,
  getExecutiveTrendsReport,
  getMarketMixReport,
} from "./analytics-tier4-service.js";

function tenantDbWithRows(rowSets: unknown[][]) {
  return {
    execute: vi.fn().mockImplementation(() => Promise.resolve({ rows: rowSets.shift() ?? [] })),
  } as any;
}

describe("analytics tier 4 service", () => {
  it("builds Market Mix from industry, property type, region, quarterly, and breakdown rows", async () => {
    const tenantDb = tenantDbWithRows([
      [{ total_deal_count: 4, total_won_value: "250000", active_markets: 2, most_active_region: "Dallas" }],
      [{ name: "Healthcare", deal_count: 3, won_value: "200000" }],
      [{ name: "industrial", deal_count: 2, won_value: "150000" }],
      [{ name: "Dallas", deal_count: 4, won_value: "250000" }],
      [{ quarter: "2026 Q1", vertical: "Healthcare", won_value: "125000" }],
      [{ vertical: "Healthcare", active_deals: 2, won_last_year: "200000", wins: 2, losses: 1, avg_deal_size: "100000" }],
    ]);

    const report = await getMarketMixReport(tenantDb, {
      from: "2026-01-01",
      to: "2026-12-31",
      ownerIds: ["owner-1"],
    });

    expect(report.kpis.totalDealCount).toBe(4);
    expect(report.kpis.totalWonValue).toBe(250000);
    expect(report.verticalMix[0]).toMatchObject({ name: "Healthcare", dealCount: 3, wonValue: 200000 });
    expect(report.propertyTypeMix[0].name).toBe("Industrial");
    expect(report.breakdown[0]).toMatchObject({ vertical: "Healthcare", winRate: 66.7, avgDealSize: 100000 });
    expect(JSON.stringify(report)).not.toContain("owner-1");
  });

  it("builds Customer Concentration with concentration percentages and stale customer rows", async () => {
    const tenantDb = tenantDbWithRows([
      [{ total_active_customers: 3, total_open_value: "2000000", customers_over_one_million_open: 1 }],
      [
        {
          company_id: "company-1",
          company_name: "Acme Roofing",
          active_deals: 2,
          total_open_value: "1200000",
          total_won_lifetime: "500000",
          last_activity_at: "2026-03-01T00:00:00.000Z",
          account_owners: "Jordan, Taylor",
        },
        {
          company_id: "company-2",
          company_name: "Bravo Holdings",
          active_deals: 1,
          total_open_value: "800000",
          total_won_lifetime: "250000",
          last_activity_at: "2026-04-01T00:00:00.000Z",
          account_owners: "Casey",
        },
      ],
      [{ bucket: "$1M+", customer_count: 1 }],
      [{ company_name: "Acme Roofing", owner_name: "Jordan", open_deals: 2, open_value: "1200000", days_stale: 71 }],
    ]);

    const report = await getCustomerConcentrationReport(tenantDb, {
      from: "2026-01-01",
      to: "2026-12-31",
    });

    expect(report.kpis.topCustomerPipelinePercent).toBe(60);
    expect(report.topCustomers[0]).toMatchObject({
      companyId: "company-1",
      companyName: "Acme Roofing",
      totalOpenValue: 1200000,
      accountOwners: "Jordan, Taylor",
    });
    expect(report.pareto[1]).toMatchObject({ rank: 2, companyId: "company-2", cumulativePipelinePercent: 100 });
    expect(report.staleCustomers[0]).toMatchObject({ companyName: "Acme Roofing", daysStale: 71 });
  });

  it("keeps same-name customers separate by company id and combines owners per customer", async () => {
    const tenantDb = tenantDbWithRows([
      [{ total_active_customers: 2, total_open_value: "300000", customers_over_one_million_open: 0 }],
      [
        {
          company_id: "company-a",
          company_name: "Same Name LLC",
          active_deals: 2,
          total_open_value: "200000",
          total_won_lifetime: "0",
          last_activity_at: null,
          account_owners: "Alice, Bob",
        },
        {
          company_id: "company-b",
          company_name: "Same Name LLC",
          active_deals: 1,
          total_open_value: "100000",
          total_won_lifetime: "0",
          last_activity_at: null,
          account_owners: "Casey",
        },
      ],
      [],
      [],
    ]);

    const report = await getCustomerConcentrationReport(tenantDb, {
      from: "2026-01-01",
      to: "2026-12-31",
    });

    expect(report.topCustomers).toHaveLength(2);
    expect(report.topCustomers.map((row) => row.companyId)).toEqual(["company-a", "company-b"]);
    expect(report.topCustomers[0].accountOwners).toBe("Alice, Bob");
    expect(report.topCustomers[0].companyName).toBe(report.topCustomers[1].companyName);
  });

  it("fills empty monthly periods and avoids NaN percentages in Executive Trends", async () => {
    const tenantDb = tenantDbWithRows([
      [
        { metric: "current", total_pipeline: "300000", won_revenue: "100000", wins: 1, losses: 1, avg_deal_size: "100000" },
        { metric: "previous", total_pipeline: "0", won_revenue: "0", wins: 0, losses: 0, avg_deal_size: "0" },
      ],
      [
        { month: "2026-01", new_deals: 2, won_deals: 0, lost_deals: 0, active_pipeline_value: "150000" },
        { month: "2026-03", new_deals: 1, won_deals: 0, lost_deals: 1, active_pipeline_value: "300000" },
      ],
      [{ quarter: "2026 Q1", deals_created: 3, won: 1, lost: 1, avg_deal_size: "100000", pipeline_end_value: "300000" }],
      [{ month: "2026-01", wins: 1, losses: 0 }],
      [{ stage_name: "Opportunity", entered_count: 4, advanced_count: 3 }],
    ]);

    const report = await getExecutiveTrendsReport(tenantDb, {
      from: "2026-01-01",
      to: "2026-03-31",
    });

    expect(report.monthlyTrends.map((row) => row.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(report.monthlyTrends[1]).toMatchObject({
      newDeals: 0,
      wonDeals: 0,
      lostDeals: 0,
      activePipelineValue: 0,
    });
    expect(report.kpis.find((kpi) => kpi.label === "Win Rate")?.value).toBe(50);
    expect(report.kpis.every((kpi) => Number.isFinite(kpi.changePercent))).toBe(true);
    expect(report.stageProgression[0]).toMatchObject({ stageName: "Opportunity", progressionRate: 75 });
  });

  it("counts won deals in the outcome month instead of the created month", async () => {
    const tenantDb = tenantDbWithRows([
      [
        { metric: "current", total_pipeline: "0", won_revenue: "100000", wins: 1, losses: 0, avg_deal_size: "100000" },
        { metric: "previous", total_pipeline: "0", won_revenue: "0", wins: 0, losses: 0, avg_deal_size: "0" },
      ],
      [
        { month: "2026-01", new_deals: 1, won_deals: 0, lost_deals: 0, active_pipeline_value: "0" },
        { month: "2026-05", new_deals: 0, won_deals: 1, lost_deals: 0, active_pipeline_value: "0" },
      ],
      [],
      [],
      [],
    ]);

    const report = await getExecutiveTrendsReport(tenantDb, {
      from: "2026-01-01",
      to: "2026-05-31",
    });

    expect(report.monthlyTrends.find((row) => row.month === "2026-01")).toMatchObject({ newDeals: 1, wonDeals: 0 });
    expect(report.monthlyTrends.find((row) => row.month === "2026-05")).toMatchObject({ newDeals: 0, wonDeals: 1 });
  });

  it("computes inclusive current period days for previous-period comparison", () => {
    expect(computePreviousPeriod("2026-01-01", "2026-01-31")).toEqual({
      previousFrom: "2025-12-01",
      previousToExclusive: "2026-01-01",
      days: 31,
    });
  });

  it("anchors date bounds at UTC so monthly buckets do not drift in non-UTC sessions", async () => {
    // We don't actually run the SQL; we inspect the drizzle query chunks to
    // verify that filter.from / filter.to are cast to ::date AT TIME ZONE 'UTC'
    // rather than ::timestamptz (which uses session TZ).
    const seenQueries: unknown[] = [];
    const tenantDb = {
      execute: vi.fn().mockImplementation((query: unknown) => {
        seenQueries.push(query);
        return Promise.resolve({ rows: [] });
      }),
    } as any;

    await getMarketMixReport(tenantDb, { from: "2026-03-01", to: "2026-03-31" });

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

    const fullSql = seenQueries.map(extractSqlText).join("\n");
    expect(fullSql).toMatch(/AT TIME ZONE 'UTC'/);
    // No bare `::timestamptz` casts on date literals (we use AT TIME ZONE 'UTC').
    expect(fullSql).not.toMatch(/::date\s*\)\s*::timestamptz/);
    expect(fullSql).not.toMatch(/\$\d+::timestamptz/);
  });
});
