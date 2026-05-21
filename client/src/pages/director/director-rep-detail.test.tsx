// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DirectorRepDetail } from "./director-rep-detail";

const mocks = vi.hoisted(() => ({
  useRepDetailMock: vi.fn(),
  presetToDateRangeMock: vi.fn(),
}));

vi.mock("@/hooks/use-director-dashboard", () => ({
  useRepDetail: mocks.useRepDetailMock,
  presetToDateRange: mocks.presetToDateRangeMock,
}));

vi.mock("@/components/dashboard/date-range-toggle", () => ({
  DateRangeToggle: ({ value }: { value: string }) => <div>Date Range: {value}</div>,
}));

vi.mock("@/components/dashboard/stat-card", () => ({
  StatCard: ({ title, value, subtitle }: { title: string; value: ReactNode; subtitle?: ReactNode }) => (
    <div>
      <h3>{title}</h3>
      <div>{value}</div>
      {subtitle ? <p>{subtitle}</p> : null}
    </div>
  ),
}));

vi.mock("@/components/dashboard/stale-deal-list", () => ({
  StaleDealList: () => <div>Stale Deals</div>,
}));

vi.mock("@/components/dashboard/stale-lead-list", () => ({
  StaleLeadList: () => <div>Stale Leads</div>,
}));

vi.mock("@/components/charts/pipeline-bar-chart", () => ({
  PipelineBarChart: () => <div>Pipeline Chart</div>,
}));

vi.mock("@/components/charts/win-rate-trend-chart", () => ({
  WinRateTrendChart: () => <div>Win Rate Trend</div>,
}));

vi.mock("@/components/charts/chart-colors", () => ({
  formatCurrency: (value: number) => `$${value.toLocaleString()}`,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...props }: { children: ReactNode }) => <div {...props}>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

function renderPage(entry: string) {
  return normalize(
    renderToStaticMarkup(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/director/rep/:repId" element={<DirectorRepDetail />} />
        </Routes>
      </MemoryRouter>
    )
  );
}

describe("DirectorRepDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.presetToDateRangeMock.mockImplementation((preset: string) => ({
      from: preset === "qtd" ? "2026-04-01" : "2026-01-01",
      to: "2026-05-15",
    }));
    mocks.useRepDetailMock.mockReturnValue({
      loading: false,
      error: null,
      data: {
        commissionSummary: {
          totalEarnedCommission: 12000,
          overrideEarnedCommission: 0,
          newCustomerShare: 0.25,
        },
        activeDeals: { count: 4, totalValue: 500000 },
        tasksToday: { overdue: 0, today: 2 },
        activityThisWeek: { calls: 35, emails: 0, meetings: 5, notes: 17, total: 57 },
        winLoss: { repName: "Kevin Scott", winRate: 66, wins: 4, losses: 2 },
        followUpCompliance: { complianceRate: 91, onTime: 10, total: 11 },
        pipelineByStage: [],
        winRateTrend: [],
        staleDeals: [],
        staleLeads: [],
      },
    });
  });

  it("renders activity labels using the selected quarter preset from the URL", () => {
    const html = renderPage("/director/rep/rep-1?preset=qtd");

    expect(mocks.presetToDateRangeMock).toHaveBeenCalledWith("qtd");
    expect(html).toContain("Activity · QTD");
    expect(html).toContain("35 calls in this quarter");
    expect(html).toContain("Logged in this quarter across calls, emails, meetings, and notes.");
    expect(html).toContain("Calls logged in this quarter");
    expect(html).toContain("Meetings logged in this quarter");
    expect(html).toContain("Win Rate · QTD");
    expect(html).toContain("Active Deals (Current)");
    expect(html).toContain("Earned Commission (Rolling 12M)");
    expect(html).toContain("Follow-up Compliance · QTD");
  });

  it("defaults to ytd labels when no preset query parameter is present", () => {
    const html = renderPage("/director/rep/rep-1");

    expect(mocks.presetToDateRangeMock).toHaveBeenCalledWith("ytd");
    expect(html).toContain("Activity · YTD");
    expect(html).toContain("Logged in this year across calls, emails, meetings, and notes.");
    expect(html).toContain("Calls logged in this year");
  });

  it("renders the charts as the last section of the page", () => {
    const html = renderPage("/director/rep/rep-1");
    const headings = Array.from(html.matchAll(/<h2>(.*?)<\/h2>/g)).map((match) => match[1]);
    const penultimateHeading = headings[headings.length - 2];
    const lastHeading = headings[headings.length - 1];

    expect(html.indexOf("Stale Deals")).toBeLessThan(html.indexOf("Pipeline by Stage"));
    expect(html.indexOf("Stale Leads")).toBeLessThan(html.indexOf("Pipeline by Stage"));
    expect(html.indexOf("Pipeline by Stage")).toBeLessThan(html.indexOf("Win Rate Trend"));
    expect(penultimateHeading).toBe("Pipeline by Stage");
    expect(lastHeading).toBe("Win Rate Trend");
  });
});
