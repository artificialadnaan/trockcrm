import { describe, expect, it, vi } from "vitest";

function createMockTenantDb(rows: any[] = []) {
  const queue = Array.isArray(rows[0]) ? [...(rows as any[][])] : [rows];
  return {
    execute: vi.fn().mockImplementation(async () => ({ rows: queue.shift() ?? [] })),
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

function compactSql(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ");
}

describe("on-hold report count consistency", () => {
  it("excludes on-hold deals from pipeline velocity counts", async () => {
    const { getPipelineVelocityReport } = await import("../../../src/modules/reports/sales-tier1-service.js");
    const tenantDb = createMockTenantDb([[], [], []]);

    await getPipelineVelocityReport(tenantDb, {
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      officeSlug: undefined,
      ownerIds: [],
      ownerNames: [],
      ownerEmails: [],
    });

    const sqlText = tenantDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query).toLowerCase()).join("\n");
    expect(sqlText).toContain("coalesce(ranked.on_hold, false) = false");
    expect(sqlText).toContain("coalesce(open_deals.on_hold, false) = false");
    expect(sqlText).toContain("open_deals");
  });

  it("keeps closed-won revenue and lead-conversion won revenue on an awarded-first fallback basis with on-hold counts excluded", async () => {
    const { getClosedWonRevenueReport, getLeadConversionReport } = await import("../../../src/modules/reports/sales-tier1-service.js");

    const closedWonDb = createMockTenantDb([[], [], [], [], [], []]);
    await getClosedWonRevenueReport(closedWonDb, {
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      officeSlug: undefined,
      ownerIds: [],
      ownerNames: [],
      ownerEmails: [],
    });
    const closedWonSql = closedWonDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query).toLowerCase()).join("\n");
    expect(closedWonSql).toContain("awarded_amount");
    expect(closedWonSql).toContain("bid_board_total_sales");
    expect(closedWonSql).toContain("bid_estimate");
    expect(closedWonSql).toContain("dd_estimate");
    expect(closedWonSql).not.toContain("forecast_revenue");
    expect(closedWonSql).toContain("coalesce(d.on_hold, false) = false");

    const leadConversionDb = createMockTenantDb([[], [], [], []]);
    await getLeadConversionReport(leadConversionDb, {
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      officeSlug: undefined,
      ownerIds: [],
      ownerNames: [],
      ownerEmails: [],
    });
    const leadConversionSql = leadConversionDb.execute.mock.calls
      .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
      .join("\n");
    expect(leadConversionSql).toContain("awarded_amount");
    expect(leadConversionSql).toContain("bid_board_total_sales");
    expect(leadConversionSql).toContain("bid_estimate");
    expect(leadConversionSql).toContain("dd_estimate");
    expect(leadConversionSql).toContain("coalesce(d.on_hold, false) = false");
    expect(leadConversionSql.match(/left join deals d on/g)?.length).toBe(4);
    expect(leadConversionSql.match(/coalesce\(d\.on_hold, false\) = false/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps lead-conversion headline won count hold-aware and aligned with source breakdown won counts", async () => {
    const { getLeadConversionReport } = await import("../../../src/modules/reports/sales-tier1-service.js");
    const tenantDb = {
      execute: vi.fn().mockImplementation(async (query: unknown) => {
        const queryText = extractSqlText(query).toLowerCase();
        const hasHoldAwareWonFilter =
          queryText.includes("as won") && queryText.includes("coalesce(d.on_hold, false) = false");

        if (queryText.includes('as "totalleads"')) {
          return {
            rows: [
              {
                totalLeads: 2,
                qualified: 2,
                inDeals: 2,
                won: hasHoldAwareWonFilter ? 1 : 2,
              },
            ],
          };
        }

        if (queryText.includes('as "convertedtodeal"') && queryText.includes("group by 1")) {
          return {
            rows: [
              {
                source: "Website",
                leads: 2,
                qualified: 2,
                convertedToDeal: 2,
                won: hasHoldAwareWonFilter ? 1 : 2,
                totalRevenue: 1000,
              },
            ],
          };
        }

        if (queryText.includes("date_trunc('month'")) {
          return {
            rows: [
              {
                month: "2026-01",
                leads: 2,
                convertedToDeal: 2,
                won: hasHoldAwareWonFilter ? 1 : 2,
              },
            ],
          };
        }

        return {
          rows: [
            {
              source: "Website",
              totalRevenue: 1000,
              won: hasHoldAwareWonFilter ? 1 : 2,
            },
          ],
        };
      }),
    } as any;

    const report = await getLeadConversionReport(
      tenantDb,
      {
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
        officeSlug: undefined,
        ownerIds: [],
        ownerNames: [],
        ownerEmails: [],
      },
      "lead-conversion-held-won-regression"
    );

    const sourceWonTotal = report.bySource.reduce((sum, source) => sum + source.won, 0);
    const monthlyWonTotal = report.monthlyTrend.reduce((sum, month) => sum + month.won, 0);
    const revenueWonTotal = report.topRevenueSources.reduce((sum, source) => sum + source.won, 0);
    expect(report.kpis.won).toBe(1);
    expect(report.funnel.find((step) => step.key === "won")?.count).toBe(1);
    expect(report.kpis.won).toBe(sourceWonTotal);
    expect(report.kpis.won).toBe(monthlyWonTotal);
    expect(report.kpis.won).toBe(revenueWonTotal);
  });

  it("keeps service report pipeline and awarded rollups count-consistent", async () => {
    const {
      getRevenueByProjectType,
      getLeadSourceROI,
      getRegionalOwnershipOverview,
      getClosedWonSummary,
      getPipelineByRep,
      getWinLossRatioByRep,
      getUnifiedWorkflowOverview,
    } = await import("../../../src/modules/reports/service.js");

    const revenueDb = createMockTenantDb([]);
    await getRevenueByProjectType(revenueDb, { from: "2026-01-01", to: "2026-12-31" });
    const revenueSql = extractSqlText(revenueDb.execute.mock.calls[0][0]).toLowerCase();
    expect(revenueSql).toContain("awarded_amount");
    expect(revenueSql).toContain("bid_board_total_sales");
    expect(revenueSql).toContain("bid_estimate");
    expect(revenueSql).toContain("dd_estimate");
    expect(revenueSql).toContain("coalesce(d.on_hold, false) = false");

    const roiDb = createMockTenantDb([]);
    await getLeadSourceROI(roiDb, { from: "2026-01-01", to: "2026-12-31" });
    const roiSql = extractSqlText(roiDb.execute.mock.calls[0][0]).toLowerCase();
    expect(roiSql).toContain("active_deals");
    expect(roiSql).toContain("won_deals");
    expect(roiSql).toContain("coalesce(d.on_hold, false) = false");

    const regionalDb = createMockTenantDb([[], [], [], []]);
    await getRegionalOwnershipOverview(regionalDb, {
      from: "2026-01-01",
      to: "2026-12-31",
      officeId: "office-1",
    });
    const regionalSql = regionalDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query).toLowerCase()).join("\n");
    expect(regionalSql).toContain("deal_count");
    expect(regionalSql).toContain("pipeline_value");
    expect(regionalSql).toContain("coalesce(d.on_hold, false) = false");

    const closedWonSummaryDb = createMockTenantDb([[], [], []]);
    await getClosedWonSummary(closedWonSummaryDb, { from: "2026-01-01", to: "2026-12-31" });
    const closedWonSummarySql = closedWonSummaryDb.execute.mock.calls
      .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
      .join("\n");
    expect(closedWonSummarySql).toContain("total_won_deals");
    expect(closedWonSummarySql).toContain("coalesce(d.on_hold, false) = false");

    const pipelineByRepDb = createMockTenantDb([]);
    await getPipelineByRep(pipelineByRepDb);
    const pipelineByRepSql = extractSqlText(pipelineByRepDb.execute.mock.calls[0][0]).toLowerCase();
    expect(pipelineByRepSql).toContain("deal_count");
    expect(pipelineByRepSql).toContain("coalesce(d.on_hold, false) = false");

    const winLossDb = createMockTenantDb([]);
    await getWinLossRatioByRep(winLossDb, { from: "2026-01-01", to: "2026-12-31" });
    const winLossSql = extractSqlText(winLossDb.execute.mock.calls[0][0]).toLowerCase();
    expect(winLossSql).toContain("coalesce(d.on_hold, false) = false");
    expect(winLossSql).toContain("awarded_amount");
    expect(winLossSql).toContain("bid_board_total_sales");
    expect(winLossSql).toContain("bid_estimate");
    expect(winLossSql).toContain("dd_estimate");

    const unifiedDb = createMockTenantDb([[], [], [], [], [], [], [], [], []]);
    await getUnifiedWorkflowOverview(unifiedDb);
    const unifiedSql = unifiedDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query).toLowerCase()).join("\n");
    expect(unifiedSql).toContain("mirrored_stage_slug");
    expect(unifiedSql).toContain("coalesce(d.on_hold, false) = false");
    expect(unifiedSql).toContain("active_deal_count");
    expect(unifiedSql).toContain("service_deal_count");
  });

  it("keeps director scorecard, customer concentration, executive trends, and report builder counts aligned with hold-aware values", async () => {
    const { getDirectorScorecard, getRepActivityReport } = await import("../../../src/modules/reports/performance-tier2-service.js");
    const { getCustomerConcentrationReport, getExecutiveTrendsReport, getMarketMixReport } = await import("../../../src/modules/reports/analytics-tier4-service.js");
    const { runReportBuilder } = await import("../../../src/modules/reports/report-builder-service.js");

    const scorecardDb = createMockTenantDb([[], [], [], [], []]);
    await getDirectorScorecard(scorecardDb, {
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      ownerIds: [],
      ownerNames: [],
    }, "tenant-a");
    const scorecardSql = scorecardDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query).toLowerCase()).join("\n");
    expect(scorecardSql).toContain("open_deal_count");
    expect(scorecardSql).toContain("deals_at_risk");
    expect(scorecardSql).toContain("coalesce(d.on_hold, false) = false");

    const repActivityDb = createMockTenantDb([[], [], [], []]);
    await getRepActivityReport(
      repActivityDb,
      {
        dateFrom: "2026-01-01",
        dateTo: "2026-12-31",
        ownerIds: [],
        ownerNames: [],
      },
      { role: "director", userId: "director-1", displayName: "Director One" },
      "tenant-b"
    );
    const repActivitySql = repActivityDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query).toLowerCase()).join("\n");
    expect(repActivitySql).toContain("total_open_value");
    expect(repActivitySql).toContain("coalesce(d.on_hold, false) = false");

    const customerDb = createMockTenantDb([[], [], [], []]);
    await getCustomerConcentrationReport(customerDb, { from: "2026-01-01", to: "2026-12-31" });
    const customerSql = customerDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query).toLowerCase()).join("\n");
    expect(customerSql).toContain("active_deals");
    expect(customerSql).toContain("open_deals");
    expect(customerSql).toContain("coalesce(d.on_hold, false) = false");

    const marketMixDb = createMockTenantDb([[], [], [], [], [], []]);
    await getMarketMixReport(marketMixDb, { from: "2026-01-01", to: "2026-12-31" });
    const marketMixSql = marketMixDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query).toLowerCase()).join("\n");
    expect(marketMixSql).toContain("deal_count");
    expect(marketMixSql).toContain("wins");
    expect(marketMixSql).toContain("coalesce(d.on_hold, false) = false");
    expect(marketMixSql).toMatch(
      /count\(distinct d\.id\) filter \(where coalesce\(d\.on_hold, false\) = false\)::int as total_deal_count/
    );

    const executiveDb = createMockTenantDb([[], [], [], [], []]);
    await getExecutiveTrendsReport(executiveDb, { from: "2026-01-01", to: "2026-12-31" });
    const executiveSql = executiveDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query).toLowerCase()).join("\n");
    expect(executiveSql).toContain("won_revenue");
    expect(executiveSql).toContain("total_pipeline");
    expect(executiveSql).toContain("coalesce(d.on_hold, false) = false");

    const reportBuilderDb = createMockTenantDb([]);
    await runReportBuilder(reportBuilderDb, {
      dimensions: ["stage"],
      measures: ["deal_count", "total_value", "avg_value"],
      filters: { from: "2026-01-01", to: "2026-12-31" },
      dateField: "created_at",
      role: "admin",
      userId: "admin-1",
    });
    const reportBuilderSql = extractSqlText(reportBuilderDb.execute.mock.calls[0][0]).toLowerCase();
    expect(reportBuilderSql).toContain("count(distinct d.id) filter (where");
    expect(reportBuilderSql).toContain("avg(");
    expect(reportBuilderSql).toContain("coalesce(d.on_hold, false) = false");
  });

  it("covers all PR 444 audit findings for value basis, sibling aggregates, and generated report measures", async () => {
    const { getPipelineVelocityReport } = await import("../../../src/modules/reports/sales-tier1-service.js");
    const { getDirectorScorecard, getForecastAccuracyReport } = await import("../../../src/modules/reports/performance-tier2-service.js");
    const { getCustomerConcentrationReport, getExecutiveTrendsReport, getMarketMixReport } = await import("../../../src/modules/reports/analytics-tier4-service.js");
    const { getWorkflowBottlenecksReport, getPortfolioLoadReport, getProjectReadinessReport } = await import("../../../src/modules/reports/operations-tier3-service.js");
    const {
      getClosedWonSummary,
      getRegionalOwnershipOverview,
      getUnifiedWorkflowOverview,
      getLostDealsByReason,
      getRepPerformanceComparison,
    } = await import("../../../src/modules/reports/service.js");
    const { runReportBuilder } = await import("../../../src/modules/reports/report-builder-service.js");

    const velocityDb = createMockTenantDb([[], [], []]);
    await getPipelineVelocityReport(
      velocityDb,
      {
        dateFrom: "2026-02-01",
        dateTo: "2026-02-28",
        officeSlug: undefined,
        ownerIds: [],
        ownerNames: [],
        ownerEmails: [],
      },
      "audit-fix-pipeline-velocity"
    );
    const velocityQueries = velocityDb.execute.mock.calls.map(([query]: [unknown]) => compactSql(extractSqlText(query)));
    expect(velocityQueries[0]).toMatch(/avg\(days_in_stage\) filter \(where coalesce\(ranked\.on_hold, false\) = false\)/);
    expect(velocityQueries[0]).toMatch(/percentile_cont\(0\.5\).*filter \(where coalesce\(ranked\.on_hold, false\) = false\)/);
    expect(velocityQueries[0]).toMatch(/array_agg\(id::text\) filter \(where rn = 1 and coalesce\(ranked\.on_hold, false\) = false\)/);
    expect(velocityQueries[2]).toContain("and coalesce(d.on_hold, false) = false");

    const scorecardDb = createMockTenantDb([[], [], [], [], []]);
    await getDirectorScorecard(
      scorecardDb,
      { dateFrom: "2026-02-01", dateTo: "2026-02-28", ownerIds: [], ownerNames: [] },
      "audit-fix-director-scorecard"
    );
    const scorecardQueries = scorecardDb.execute.mock.calls.map(([query]: [unknown]) => compactSql(extractSqlText(query)));
    expect(scorecardQueries[1]).toMatch(/with scoped_deals as \( select d\.\* .*and coalesce\(d\.on_hold, false\) = false/);
    expect(scorecardQueries[1]).toMatch(/task_deals as \( select d\.id .*and coalesce\(d\.on_hold, false\) = false/);
    expect(scorecardQueries[4]).toContain("and coalesce(d.on_hold, false) = false");

    const forecastDb = createMockTenantDb([[], [], []]);
    await getForecastAccuracyReport(
      forecastDb,
      { dateFrom: "2026-02-01", dateTo: "2026-02-28", ownerIds: [], ownerNames: [] },
      "audit-fix-forecast"
    );
    const forecastSql = compactSql(forecastDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query)).join("\n"));
    expect(forecastSql).toContain("case when d.forecast_revenue > 0 then d.forecast_revenue end");
    expect(forecastSql).toContain("case when d.bid_board_total_sales > 0 then d.bid_board_total_sales end");
    expect(forecastSql).toContain("case when d.awarded_amount > 0 then d.awarded_amount end");

    const marketMixDb = createMockTenantDb([[], [], [], [], [], []]);
    await getMarketMixReport(marketMixDb, { from: "2026-02-01", to: "2026-02-28" });
    const marketMixSql = compactSql(marketMixDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query)).join("\n"));
    expect(marketMixSql).toMatch(/avg\(case when coalesce\(d\.on_hold, false\).*awarded_amount.*filter \( where psc\.slug in .* and coalesce\(d\.on_hold, false\) = false \)/);
    expect(marketMixSql).toContain("count(distinct coalesce(nullif(c.industry::text, ''), nullif(d.project_type, ''), 'uncategorized')) filter (where coalesce(d.on_hold, false) = false)::int as active_markets");
    expect(marketMixSql).toContain("and coalesce(d.on_hold, false) = false group by");
    expect(marketMixSql).toContain("order by count(*) filter (where coalesce(d.on_hold, false) = false) desc");

    const customerDb = createMockTenantDb([[], [], [], []]);
    await getCustomerConcentrationReport(customerDb, { from: "2026-02-01", to: "2026-02-28" });
    const customerSql = compactSql(customerDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query)).join("\n"));
    expect(customerSql).toContain("case when d.forecast_revenue > 0 then d.forecast_revenue end");
    expect(customerSql).toContain("case when d.bid_board_total_sales > 0 then d.bid_board_total_sales end");
    expect(customerSql).toContain("case when d.awarded_amount > 0 then d.awarded_amount end");
    expect(customerSql).not.toContain("nullif");

    const executiveDb = createMockTenantDb([[], [], [], [], []]);
    await getExecutiveTrendsReport(executiveDb, { from: "2026-02-01", to: "2026-02-28" });
    const executiveSql = compactSql(executiveDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query)).join("\n"));
    expect(executiveSql).toContain("case when d.forecast_revenue > 0 then d.forecast_revenue end");
    expect(executiveSql).toContain("case when d.bid_board_total_sales > 0 then d.bid_board_total_sales end");
    expect(executiveSql).toContain("case when d.awarded_amount > 0 then d.awarded_amount end");
    expect(executiveSql).not.toContain("nullif");
    // PR-C: avg deal size = AVG over the on-hold-zeroed awarded-first Won value, FILTERed to the Won
    // stage + usable won date (the won-date cohort). On-hold exclusion is via the value-zeroing CASE +
    // the outer scope WHERE (asserted above), not inside the AVG FILTER.
    expect(executiveSql).toMatch(/avg\(case when coalesce\(d\.on_hold, false\).*awarded_amount.*\) filter \(\s*where psc\.slug in .*d\.won_closed_date is not null/);

    const closedWonSummaryDb = createMockTenantDb([[], [], []]);
    await getClosedWonSummary(closedWonSummaryDb, { from: "2026-02-01", to: "2026-02-28" });
    const closedWonSummarySql = compactSql(closedWonSummaryDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query)).join("\n"));
    expect(closedWonSummarySql).toMatch(/avg\( extract\(day from d\.won_closed_date::timestamp - d\.created_at\) \) filter \(where coalesce\(d\.on_hold, false\) = false\)/);

    const regionalDb = createMockTenantDb([[], [], [], []]);
    await getRegionalOwnershipOverview(regionalDb, { from: "2026-02-01", to: "2026-02-28", officeId: "office-1" });
    const regionalSql = compactSql(regionalDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query)).join("\n"));
    expect(regionalSql).not.toContain("stale_threshold_days");
    expect(regionalSql).toContain("on_hold_accumulated_seconds");

    const unifiedDb = createMockTenantDb([[], [], [], [], [], [], [], [], [], []]);
    await getUnifiedWorkflowOverview(unifiedDb);
    const unifiedSql = compactSql(unifiedDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query)).join("\n"));
    expect(unifiedSql).not.toContain("stale_threshold_days");
    expect(unifiedSql).toContain("on_hold_accumulated_seconds");

    const lostReasonsDb = createMockTenantDb([[], []]);
    await getLostDealsByReason(lostReasonsDb, { from: "2026-02-01", to: "2026-02-28" });
    const lostReasonCompetitorSql = compactSql(extractSqlText(lostReasonsDb.execute.mock.calls[1][0]));
    expect(lostReasonCompetitorSql).toContain("coalesce(d.on_hold, false) = false");

    const repComparisonDb = createMockTenantDb([[], []]);
    await getRepPerformanceComparison(repComparisonDb, "month");
    const repComparisonSql = compactSql(extractSqlText(repComparisonDb.execute.mock.calls[0][0]));
    expect((repComparisonSql.match(/coalesce\(d\.on_hold, false\) = false/g) ?? []).length).toBeGreaterThanOrEqual(6);

    const reportBuilderDb = createMockTenantDb([]);
    await runReportBuilder(reportBuilderDb, {
      dimensions: ["stage"],
      measures: ["win_rate", "avg_cycle_time", "avg_age_in_stage"],
      filters: { from: "2026-02-01", to: "2026-02-28" },
      dateField: "created_at",
      role: "admin",
      userId: "admin-1",
    });
    const reportBuilderSql = compactSql(extractSqlText(reportBuilderDb.execute.mock.calls[0][0]));
    expect((reportBuilderSql.match(/coalesce\(d\.on_hold, false\) = false/g) ?? []).length).toBeGreaterThanOrEqual(4);

    const bottlenecksDb = createMockTenantDb([[], [], []]);
    await getWorkflowBottlenecksReport(bottlenecksDb, { from: "2026-02-01", to: "2026-02-28" });
    const bottleneckSql = compactSql(bottlenecksDb.execute.mock.calls.map(([query]: [unknown]) => extractSqlText(query)).join("\n"));
    expect((bottleneckSql.match(/coalesce\(d\.on_hold, false\) = false/g) ?? []).length).toBeGreaterThanOrEqual(3);

    const portfolioDb = createMockTenantDb([]);
    await getPortfolioLoadReport(portfolioDb, { from: "2026-02-01", to: "2026-02-28" });
    const portfolioSql = compactSql(extractSqlText(portfolioDb.execute.mock.calls[0][0]));
    expect(portfolioSql).toContain("coalesce(d.on_hold, false) = false");

    const readinessDb = createMockTenantDb([]);
    await getProjectReadinessReport(readinessDb, { from: "2026-02-01", to: "2026-02-28" });
    const readinessSql = compactSql(extractSqlText(readinessDb.execute.mock.calls[0][0]));
    expect(readinessSql).toContain("coalesce(d.on_hold, false) = false");
  });
});
