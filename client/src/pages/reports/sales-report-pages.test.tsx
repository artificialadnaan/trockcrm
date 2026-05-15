import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/hooks/use-reports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-reports")>();
  return {
    ...actual,
    usePipelineVelocityReport: vi.fn(() => ({
      data: {
        kpis: { avgDealAgeDays: 15, totalOpenValue: 425000, openDealCount: 3, stuckDealCount: 1 },
        stages: [
          {
            stageId: "stage-1",
            stageName: "Opportunity",
            openDeals: 2,
            totalValue: 300000,
            avgDaysInStage: 18,
            medianDaysInStage: 16,
            oldestDeal: { dealId: "deal-1", dealName: "North Plaza Roof", daysInStage: 42 },
          },
        ],
        agingBuckets: [{ bucket: "31-60", label: "31-60 days", dealCount: 2, totalValue: 300000 }],
        stuckDeals: [
          {
            dealId: "deal-1",
            dealName: "North Plaza Roof",
            ownerName: "Jordan Lee",
            stageName: "Opportunity",
            daysInStage: 42,
            value: 200000,
          },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })),
    useClosedWonRevenueReport: vi.fn(() => ({
      data: {
        kpis: { totalBookedRevenue: 600000, wonDealCount: 2, avgDealSize: 300000, winRate: 66.7 },
        monthlyRevenue: [{ month: "2026-05", label: "May 2026", totalRevenue: 600000, wonDeals: 2 }],
        byOwner: [
          {
            ownerId: "rep-1",
            ownerName: "Jordan Lee",
            wonDeals: 2,
            totalRevenue: 600000,
            avgDealSize: 300000,
            largestWonDeal: { dealId: "deal-1", dealName: "North Plaza Roof", value: 425000 },
          },
        ],
        byOffice: [{ officeId: "office-1", officeName: "Dallas", wonDeals: 2, totalRevenue: 600000, avgDealSize: 300000, percentOfTotal: 100 }],
        byWorkflowFamily: [{ workflowFamily: "standard_deal", workflowFamilyName: "Standard Deal", wonDeals: 2, totalRevenue: 600000 }],
        topDeals: [{ dealId: "deal-1", dealName: "North Plaza Roof", ownerName: "Jordan Lee", value: 425000, wonAt: "2026-05-08" }],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })),
    useLeadConversionReport: vi.fn(() => ({
      data: {
        kpis: { totalLeads: 10, qualified: 6, inDeals: 4, won: 2, leadToDealRate: 40, dealToWonRate: 50 },
        funnel: [
          { key: "leads", label: "Leads", count: 10, conversionRate: 100 },
          { key: "qualified", label: "Qualified", count: 6, conversionRate: 60 },
          { key: "inDeals", label: "In Deal", count: 4, conversionRate: 66.7 },
          { key: "won", label: "Won", count: 2, conversionRate: 50 },
        ],
        bySource: [{ source: "Trade Show", leads: 5, qualified: 4, convertedToDeal: 3, won: 2, totalRevenue: 500000 }],
        monthlyTrend: [{ month: "2026-05", label: "May 2026", leads: 10, convertedToDeal: 4, won: 2, conversionRate: 40 }],
        topRevenueSources: [{ source: "Trade Show", totalRevenue: 500000, won: 2 }],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })),
  };
});

vi.mock("@/components/reports/report-filter-bar", () => ({
  ReportFilterBar: () => <div>Shared report filters</div>,
  useReportFilters: () => ({
    filters: { range: "90", dateFrom: "2026-02-10", dateTo: "2026-05-11", office: "all", ownerIds: [], ownerNames: [], ownerEmails: [] },
    query: { dateFrom: "2026-02-10", dateTo: "2026-05-11" },
  }),
}));

import { ClosedWonRevenuePage } from "./closed-won-revenue-page";
import { LeadConversionPage } from "./lead-conversion-page";
import { PipelineVelocityPage } from "./pipeline-velocity-page";

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("Sales report pages", () => {
  it("renders Pipeline Velocity with filters, KPIs, display stage names, and stuck deal links", () => {
    const html = normalize(renderToStaticMarkup(<MemoryRouter><PipelineVelocityPage /></MemoryRouter>));

    expect(html).toContain("Pipeline Velocity");
    expect(html).toContain("Shared report filters");
    expect(html).toContain("Export to Excel");
    expect(html).toContain("$425,000");
    expect(html).toContain("Opportunity");
    expect(html).toContain("Jordan Lee");
    expect(html).toContain('href="/deals/deal-1"');
    expect(html).not.toContain("stage-1");
  });

  it("renders Closed Won Revenue with executive currency and readable won dates", () => {
    const html = normalize(renderToStaticMarkup(<MemoryRouter><ClosedWonRevenuePage /></MemoryRouter>));

    expect(html).toContain("Closed Won Revenue");
    expect(html).toContain("Export to Excel");
    expect(html).toContain("$600,000");
    expect(html).toContain("$300,000");
    expect(html).toContain("Standard Deal");
    expect(html).toContain("May 8, 2026");
    expect(html).not.toContain("rep-1");
  });

  it("renders Lead Conversion with funnel rates and source revenue", () => {
    const html = normalize(renderToStaticMarkup(<MemoryRouter><LeadConversionPage /></MemoryRouter>));

    expect(html).toContain("Lead Conversion");
    expect(html).toContain("Export to Excel");
    expect(html).toContain("Lead-to-Deal");
    expect(html).toContain("40%");
    expect(html).toContain("Trade Show");
    expect(html).toContain("$500,000");
  });
});
