// @vitest-environment jsdom
//
// The inline row links on reports whose hooks are office-scoped. Same rule and same both-directions
// shape as deal-link-office-scope.test.tsx, which covers the two shared DealLink components:
//
//   ?officeId verbatim, or nothing. Never derived from ?office.
//
// These six links were deferred as a follow-up while their reports did not follow the office scope —
// a bare link matched a page that always read the viewer's own tenant. Converting those hooks to
// useScopedReport made the rows office-aware and turned the deferral into a bug: correct rows under
// links pointing at the default tenant. The negative cases below are what stop a future edit
// "resolving" ?office into a scope again.
//
// Portfolio Load links companies and properties rather than deals. Those detail pages never mention
// officeId — unlike DealDetailPage, which reads it explicitly — but they do not need to: api()
// injects x-office-id from ?officeId in window.location for any request that has not set the header,
// and useCompanyDetail / usePropertyDetail both fetch through api().

import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/components/reports/report-filter-bar", () => ({
  ReportFilterBar: () => <div>Report Filters</div>,
  useReportFilters: () => ({
    filters: { dateFrom: "2026-06-01", dateTo: "2026-06-30", office: "all", ownerNames: [] },
    query: { dateFrom: "2026-06-01", dateTo: "2026-06-30", office: "all", ownerIds: [], ownerNames: [] },
  }),
}));

// Fixtures mirror the real report interfaces (PipelineVelocityOverview, ClosedWonRevenueOverview,
// PortfolioLoadReport) — a loose shape would render an empty table and assert nothing.
const PIPELINE_VELOCITY = {
  kpis: { avgDealAgeDays: 10, totalOpenValue: 1000, openDealCount: 2, stuckDealCount: 1 },
  stages: [
    {
      stageId: "stage-1",
      stageName: "Estimating",
      openDeals: 2,
      totalValue: 1000,
      avgDaysInStage: 5,
      medianDaysInStage: 4,
      oldestDeal: { dealId: "deal-oldest", dealName: "Oldest Deal", daysInStage: 30 },
    },
  ],
  agingBuckets: [],
  stuckDeals: [
    { dealId: "deal-stuck", dealName: "Stuck Deal", ownerName: "Alice", stageName: "Estimating", daysInStage: 40, value: 500 },
  ],
};

const CLOSED_WON = {
  kpis: { totalBookedRevenue: 100, wonDealCount: 1, avgDealSize: 100, winRate: 0.5 },
  monthlyRevenue: [],
  byOwner: [
    {
      ownerId: "user-alice",
      ownerName: "Alice",
      wonDeals: 1,
      totalRevenue: 100,
      avgDealSize: 100,
      largestWonDeal: { dealId: "deal-largest", dealName: "Largest Deal", value: 100 },
    },
  ],
  byRegion: [],
  byWorkflowFamily: [],
  topDeals: [{ dealId: "deal-won", dealName: "Won Deal", ownerName: "Alice", value: 100, wonAt: "2026-06-02" }],
};

const PORTFOLIO_LOAD = {
  generatedAt: "2026-06-02T00:00:00.000Z",
  kpis: { activeCompanies: 1, activeProperties: 1, totalActiveValue: 10, avgDealValuePerCompany: 10 },
  companyBreakdown: [
    {
      companyId: "co-1",
      companyName: "Acme Property Group",
      activeDealCount: 1,
      totalOpenValue: 10,
      topProperty: "Tower A",
      owners: ["Alice"],
      avgDealAge: 3,
    },
  ],
  propertyBreakdown: [
    {
      propertyId: "prop-1",
      propertyName: "Tower A",
      companyName: "Acme Property Group",
      activeDealCount: 1,
      totalValue: 10,
      mostRecentActivity: "2026-06-01T00:00:00.000Z",
      ownerName: "Alice",
    },
  ],
  concentrationRisk: [],
  geographicSpread: { byOffice: [], byRegion: [] },
};

vi.mock("@/hooks/use-reports", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-reports")>("@/hooks/use-reports");
  const ok = (data: unknown) => () => ({ data, loading: false, error: null, refetch: vi.fn() });
  return {
    ...actual,
    usePipelineVelocityReport: ok(PIPELINE_VELOCITY),
    useClosedWonRevenueReport: ok(CLOSED_WON),
    usePortfolioLoadReport: ok(PORTFOLIO_LOAD),
  };
});

const { PipelineVelocityPage } = await import("./pipeline-velocity-page");
const { ClosedWonRevenuePage } = await import("./closed-won-revenue-page");
const { PortfolioLoadPage } = await import("./portfolio-load-page");

function hrefs(Page: () => ReactElement, search: string) {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/reports/x${search}`]}>
      <Page />
    </MemoryRouter>
  );
  return Array.from(html.matchAll(/href="([^"]*)"/g)).map((m) => m[1]);
}

const CASES = [
  ["Pipeline Velocity", () => <PipelineVelocityPage />, ["/deals/deal-oldest", "/deals/deal-stuck"]],
  ["Closed Won Revenue", () => <ClosedWonRevenuePage />, ["/deals/deal-largest", "/deals/deal-won"]],
  ["Portfolio Load", () => <PortfolioLoadPage />, ["/companies/co-1", "/properties/prop-1"]],
] as const;

describe.each(CASES)("%s row links", (_name, Page, expectedPaths) => {
  it("carries an explicit ?officeId verbatim on every row link", () => {
    const found = hrefs(Page, "?officeId=office-atlanta");
    for (const path of expectedPaths) {
      expect(found).toContain(`${path}?officeId=office-atlanta`);
    }
  });

  it("carries nothing when there is no office scope", () => {
    const found = hrefs(Page, "");
    for (const path of expectedPaths) {
      expect(found).toContain(path);
    }
    expect(found.some((href) => href.includes("officeId="))).toBe(false);
  });

  it("never synthesises an officeId from the ?office report filter", () => {
    for (const value of ["atlanta", "office-atlanta", "ATLANTA", "all"]) {
      const found = hrefs(Page, `?office=${value}`);
      expect(found.some((href) => href.includes("officeId="))).toBe(false);
      for (const path of expectedPaths) {
        expect(found).toContain(path);
      }
    }
  });

  it("uses the tenant scope and ignores the filter when both are present", () => {
    const found = hrefs(Page, "?officeId=office-atlanta&office=dallas");
    for (const path of expectedPaths) {
      expect(found).toContain(`${path}?officeId=office-atlanta`);
    }
    expect(found.some((href) => href.includes("officeId=office-dallas"))).toBe(false);
  });
});
