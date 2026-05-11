import { describe, expect, it, vi } from "vitest";
import {
  buildClosedWonRevenueOverviewFromRows,
  buildLeadConversionOverviewFromRows,
  buildPipelineVelocityOverviewFromRows,
  getClosedWonRevenueReport,
  getLeadConversionReport,
  getPipelineVelocityReport,
  normalizeSalesReportFilters,
} from "./sales-tier1-service.js";

function tenantDbWithRows(rowSets: unknown[][]) {
  return {
    execute: vi.fn().mockImplementation(() => Promise.resolve({ rows: rowSets.shift() ?? [] })),
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

  return "";
}

function executedSql(db: { execute: ReturnType<typeof vi.fn> }) {
  return db.execute.mock.calls.map((call) => extractSqlText(call[0]));
}

describe("sales tier 1 report services", () => {
  it("normalizes date, office, and owner filters from report query params", () => {
    const filters = normalizeSalesReportFilters({
      dateFrom: "2026-02-01",
      dateTo: "2026-02-28",
      office: "office-dallas",
      ownerIds: "rep-1, rep-2,,rep-3",
    });

    expect(filters).toEqual({
      dateFrom: "2026-02-01",
      dateTo: "2026-02-28",
      officeSlug: "office-dallas",
      ownerIds: ["rep-1", "rep-2", "rep-3"],
      ownerNames: [],
      ownerEmails: [],
    });
  });

  it("normalizes friendly office slugs and owner names without UUID casts", () => {
    const filters = normalizeSalesReportFilters({
      office: "dallas",
      owners: "Jordan Lee, Alex Smith",
      ownerEmails: "JORDAN@trock.test, alex@trock.test",
    });

    expect(filters.officeSlug).toBe("dallas");
    expect(filters.ownerNames).toEqual(["Jordan Lee", "Alex Smith"]);
    expect(filters.ownerEmails).toEqual(["jordan@trock.test", "alex@trock.test"]);
    expect(filters.ownerIds).toEqual([]);
  });

  it("aggregates pipeline velocity rows into executive-ready KPIs and display stages", () => {
    const overview = buildPipelineVelocityOverviewFromRows({
      stageRows: [
        {
          stageId: "stage-1",
          stageName: "Opportunity",
          stageOrder: 10,
          openDeals: 2,
          totalValue: 300000,
          avgDaysInStage: 18,
          medianDaysInStage: 16,
          oldestDealId: "deal-1",
          oldestDealName: "North Plaza Roof",
          oldestDealDays: 42,
        },
        {
          stageId: "stage-2",
          stageName: "Estimating",
          stageOrder: 20,
          openDeals: 1,
          totalValue: 125000,
          avgDaysInStage: 8,
          medianDaysInStage: 8,
          oldestDealId: "deal-2",
          oldestDealName: "South Tower Repairs",
          oldestDealDays: 8,
        },
      ],
      agingRows: [
        { bucket: "0-7", dealCount: 1, totalValue: 125000 },
        { bucket: "31-60", dealCount: 2, totalValue: 300000 },
      ],
      stuckRows: [
        {
          dealId: "deal-1",
          dealName: "North Plaza Roof",
          ownerName: "Jordan Lee",
          stageName: "Opportunity",
          daysInStage: 42,
          value: 200000,
        },
      ],
    });

    expect(overview.kpis).toEqual({
      avgDealAgeDays: 15,
      totalOpenValue: 425000,
      openDealCount: 3,
      stuckDealCount: 1,
    });
    expect(overview.stages[0]).toMatchObject({
      stageName: "Opportunity",
      oldestDeal: { dealId: "deal-1", dealName: "North Plaza Roof", daysInStage: 42 },
    });
    expect(JSON.stringify(overview)).not.toContain("opportunity_stage_slug");
  });

  it("aggregates closed won revenue rows by owner, office, workflow, month, and top deals", () => {
    const overview = buildClosedWonRevenueOverviewFromRows({
      summaryRows: [{ wonDeals: 2, lostDeals: 1, totalRevenue: 600000 }],
      ownerRows: [
        {
          ownerId: "rep-1",
          ownerName: "Jordan Lee",
          wonDeals: 2,
          totalRevenue: 600000,
          largestWonDealId: "deal-1",
          largestWonDealName: "North Plaza Roof",
          largestWonDealValue: 425000,
        },
      ],
      officeRows: [{ officeId: "office-1", officeName: "Dallas", wonDeals: 2, totalRevenue: 600000 }],
      workflowRows: [{ workflowFamily: "standard_deal", wonDeals: 2, totalRevenue: 600000 }],
      monthlyRows: [{ month: "2026-05", totalRevenue: 600000, wonDeals: 2 }],
      topDeals: [
        {
          dealId: "deal-1",
          dealName: "North Plaza Roof",
          ownerName: "Jordan Lee",
          value: 425000,
          wonAt: "2026-05-08",
        },
      ],
    });

    expect(overview.kpis).toEqual({
      totalBookedRevenue: 600000,
      wonDealCount: 2,
      avgDealSize: 300000,
      winRate: 66.7,
    });
    expect(overview.byWorkflowFamily[0].workflowFamilyName).toBe("Standard Deal");
    expect(overview.byOffice[0].percentOfTotal).toBe(100);
  });

  it("aggregates lead conversion rows into funnel, source, and monthly trend data", () => {
    const overview = buildLeadConversionOverviewFromRows({
      summaryRows: [{ totalLeads: 10, qualified: 6, inDeals: 4, won: 2 }],
      sourceRows: [
        {
          source: "Trade Show",
          leads: 5,
          qualified: 4,
          convertedToDeal: 3,
          won: 2,
          totalRevenue: 500000,
        },
      ],
      monthlyRows: [{ month: "2026-05", leads: 10, convertedToDeal: 4, won: 2 }],
      revenueRows: [{ source: "Trade Show", totalRevenue: 500000, won: 2 }],
    });

    expect(overview.kpis).toEqual({
      totalLeads: 10,
      qualified: 6,
      inDeals: 4,
      won: 2,
      leadToDealRate: 40,
      dealToWonRate: 50,
    });
    expect(overview.funnel.map((step) => step.label)).toEqual(["Leads", "Qualified", "In Deal", "Won"]);
    expect(overview.bySource[0]).toMatchObject({ source: "Trade Show", totalRevenue: 500000 });
  });

  it("matches Dallas office filters against assigned rep office or deal office_code", async () => {
    const db = tenantDbWithRows([[], [], []]);

    await getPipelineVelocityReport(db, {
      dateFrom: "2026-02-01",
      dateTo: "2026-05-01",
      officeSlug: "dallas",
      ownerIds: [],
      ownerNames: [],
      ownerEmails: [],
    }, "office-code-scope");

    const sqlText = executedSql(db).join("\n");
    expect(sqlText).toContain("d.office_code");
    expect(sqlText).toContain(" OR ");
  });

  it("matches owner filters by id, email, or display name rather than requiring all identifiers", async () => {
    const db = tenantDbWithRows([[], [], []]);

    await getPipelineVelocityReport(db, {
      dateFrom: "2026-02-01",
      dateTo: "2026-05-01",
      ownerIds: ["rep-1"],
      ownerNames: ["Jordan Rep"],
      ownerEmails: ["jordan@trock.test"],
    }, "owner-identity-scope");

    const sqlText = executedSql(db).join("\n");
    expect(sqlText).toContain("d.assigned_rep_id IN");
    expect(sqlText).toContain("LOWER(u.email) IN");
    expect(sqlText).toContain("u.display_name IN");
    expect(sqlText).toContain(" OR ");
  });

  it("counts lost deals by lost-stage date instead of stale updated_at for closed won win rate", async () => {
    const db = tenantDbWithRows([[], [], [], [], [], []]);

    await getClosedWonRevenueReport(db, {
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
      ownerIds: [],
      ownerNames: [],
      ownerEmails: [],
    }, "lost-date-scope");

    const [summarySql] = executedSql(db);
    expect(summarySql).toContain("WHEN p.slug IN");
    expect(summarySql).toContain("stage_entered_at");
    expect(summarySql).not.toContain("d.updated_at) >= ");
  });

  it("returns Lead Conversion monthly trend from the most recent six months in chronological order", async () => {
    const db = tenantDbWithRows([
      [{ totalLeads: 0, qualified: 0, inDeals: 0, won: 0 }],
      [],
      [
        { month: "2026-05", leads: 5, convertedToDeal: 2, won: 1 },
        { month: "2026-04", leads: 4, convertedToDeal: 1, won: 0 },
      ],
      [],
    ]);

    const report = await getLeadConversionReport(db, {
      dateFrom: "2025-06-01",
      dateTo: "2026-05-31",
      ownerIds: [],
      ownerNames: [],
      ownerEmails: [],
    }, "lead-trend-recent");

    const monthlySql = executedSql(db)[2];
    expect(monthlySql).toContain("ORDER BY month DESC");
    expect(report.monthlyTrend.map((row) => row.month)).toEqual(["2026-04", "2026-05"]);
  });
});
