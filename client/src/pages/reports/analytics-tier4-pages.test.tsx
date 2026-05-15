import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PieChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pie: () => <div>Pie chart</div>,
  Cell: () => null,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: () => <div>Bar chart</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Line: () => <div>Line chart</div>,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Legend: () => <div>Legend</div>,
  Tooltip: () => null,
}));

vi.mock("@/components/reports/report-filter-bar", () => ({
  ReportFilterBar: () => <div>Report Filters</div>,
  useReportFilters: () => ({
    filters: { range: "12m", dateFrom: "2025-05-11", dateTo: "2026-05-11", office: "all", ownerIds: [] },
    query: { dateFrom: "2025-05-11", dateTo: "2026-05-11", office: "all", ownerIds: [] },
  }),
}));

vi.mock("@/hooks/use-reports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-reports")>();
  return {
    ...actual,
    useMarketMixReport: vi.fn(() => ({
      loading: false,
      error: null,
      data: {
        kpis: { totalDealCount: 4, totalWonValue: 250000, activeMarkets: 2, mostActiveRegion: "Dallas" },
        verticalMix: [{ name: "Healthcare", dealCount: 3, wonValue: 200000 }],
        propertyTypeMix: [{ name: "Industrial", dealCount: 2, wonValue: 150000 }],
        regionMix: [{ name: "Dallas", dealCount: 4, wonValue: 250000 }],
        quarterlyWonByVertical: [{ quarter: "2026 Q1", vertical: "Healthcare", wonValue: 125000 }],
        breakdown: [{ vertical: "Healthcare", activeDeals: 2, wonLastYear: 200000, winRate: 66.7, avgDealSize: 100000 }],
        proxyNotes: ["Company industry used as vertical; deal project type is fallback."],
      },
      refetch: vi.fn(),
    })),
    useCustomerConcentrationReport: vi.fn(() => ({
      loading: false,
      error: null,
      data: {
        kpis: {
          totalActiveCustomers: 3,
          totalOpenValue: 2000000,
          topCustomerPipelinePercent: 60,
          customersOverOneMillionOpen: 1,
        },
        scopeNote: "Customer concentration excludes deals without a company/account from customer totals and ranking.",
        topCustomers: [
          {
            companyId: "company-1",
            companyName: "Acme Roofing",
            activeDeals: 2,
            totalOpenValue: 1200000,
            totalWonLifetime: 500000,
            lastActivityAt: "2026-03-01T00:00:00.000Z",
            accountOwners: "Jordan",
          },
        ],
        pareto: [{ rank: 1, companyId: "company-1", companyName: "Acme Roofing", cumulativePipelinePercent: 60, pipelineValue: 1200000 }],
        distribution: [{ bucket: "$1M+", customerCount: 1 }],
        staleCustomers: [{ companyName: "Acme Roofing", ownerName: "Jordan", openDeals: 2, openValue: 1200000, daysStale: 71 }],
      },
      refetch: vi.fn(),
    })),
    useExecutiveTrendsReport: vi.fn(() => ({
      loading: false,
      error: null,
      data: {
        kpis: [
          { label: "Total Pipeline", value: 300000, changePercent: 12.5, direction: "up", format: "currency" },
          { label: "Win Rate", value: 50, changePercent: 0, direction: "flat", format: "percent" },
        ],
        monthlyTrends: [{ month: "2026-01", newDeals: 2, wonDeals: 1, lostDeals: 0, activePipelineValue: 150000 }],
        activePipelineNote: "Active pipeline is a current open-pipeline snapshot repeated across the selected months; historical month-end pipeline snapshots are not available.",
        quarterlyComparison: [{ quarter: "2026 Q1", dealsCreated: 3, won: 1, lost: 1, winRate: 50, avgDealSize: 100000, pipelineEndValue: 300000 }],
        winRateTrend: [{ month: "2026-01", winRate: 100 }],
        stageProgression: [{ stageName: "Opportunity", enteredCount: 4, advancedCount: 3, progressionRate: 75 }],
      },
      refetch: vi.fn(),
    })),
  };
});

import { MarketMixPage } from "./market-mix-page";
import { CustomerConcentrationPage } from "./customer-concentration-page";
import { ExecutiveTrendsPage } from "./executive-trends-page";

function renderPage(element: React.ReactElement) {
  return renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
}

describe("analytics tier 4 report pages", () => {
  it("renders Market Mix with formatted money, percentages, and display names", () => {
    const html = renderPage(<MarketMixPage />);

    expect(html).toContain("Market Mix");
    expect(html).toContain("Report Filters");
    expect(html).toContain("Export to Excel");
    expect(html).toContain("$250,000");
    expect(html).toContain("Healthcare");
    expect(html).toContain("66.7%");
    expect(html).not.toContain("00000000-0000");
  });

  it("renders Customer Concentration without UUIDs or raw slugs", () => {
    const html = renderPage(<CustomerConcentrationPage />);

    expect(html).toContain("Customer Concentration");
    expect(html).toContain("Export to Excel");
    expect(html).toContain("Acme Roofing");
    expect(html).toContain("$1,200,000");
    expect(html).toContain("60.0%");
    expect(html).not.toContain("company_id");
  });

  it("renders Executive Trends with trend arrows and quarterly rows", () => {
    const html = renderPage(<ExecutiveTrendsPage />);

    expect(html).toContain("Executive Trends");
    expect(html).toContain("Export to Excel");
    expect(html).toContain("Total Pipeline");
    expect(html).toContain("$300,000");
    expect(html).toContain("12.5%");
    expect(html).toContain("2026 Q1");
    expect(html).toContain("Opportunity");
  });
});
