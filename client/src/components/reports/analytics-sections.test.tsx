import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/hooks/use-reports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-reports")>();
  return {
    ...actual,
    useLeadSourceROI: vi.fn(() => ({
      data: [
        {
          source: "Trade Show",
          leadCount: 4,
          dealCount: 3,
          activeDeals: 2,
          wonDeals: 1,
          lostDeals: 1,
          activePipelineValue: 250000,
          wonValue: 100000,
          winRate: 50,
        },
        {
          source: "Unknown",
          leadCount: 2,
          dealCount: 1,
          activeDeals: 1,
          wonDeals: 0,
          lostDeals: 0,
          activePipelineValue: 50000,
          wonValue: 0,
          winRate: 0,
        },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })),
    useForecastVarianceOverview: vi.fn(() => ({
      data: {
        summary: {
          comparableDeals: 3,
          avgInitialVariance: 15000,
          avgQualifiedVariance: 10000,
          avgEstimatingVariance: 4000,
          avgCloseDriftDays: 12,
        },
        repRollups: [
          {
            repId: "rep-1",
            repName: "Jordan",
            comparableDeals: 2,
            avgInitialVariance: 12000,
            avgQualifiedVariance: 8000,
            avgEstimatingVariance: 4000,
            avgCloseDriftDays: 10,
          },
        ],
        deals: [
          {
            dealId: "deal-1",
            dealName: "North Plaza",
            repName: "Jordan",
            workflowRoute: "estimating",
            initialForecast: 100000,
            qualifiedForecast: 110000,
            estimatingForecast: 120000,
            awardedAmount: 125000,
            initialVariance: 25000,
            qualifiedVariance: 15000,
            estimatingVariance: 5000,
            closeDriftDays: 7,
          },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })),
  };
});

import { DataMiningSection } from "./data-mining-section";
import { ForecastVarianceSection } from "./forecast-variance-section";
import { RegionalOwnershipSection } from "./regional-ownership-section";
import { SourcePerformanceSection } from "./source-performance-section";
import { canViewDataMiningSection } from "@/pages/reports/reports-page";

const mockApi = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: mockApi,
}));

describe("analytics reporting sections", () => {
  beforeEach(() => {
    mockApi.mockReset();
  });

  it("builds the data mining endpoint with shared analytics filters", async () => {
    mockApi.mockResolvedValue({
      data: {
        summary: {
          untouchedContact30Count: 1,
          untouchedContact60Count: 2,
          untouchedContact90Count: 3,
          dormantCompany90Count: 4,
        },
        untouchedContacts: [],
        dormantCompanies: [],
      },
    });

    const { executeDataMiningOverview } = await import("@/hooks/use-reports");
    await executeDataMiningOverview({
      from: "2026-01-01",
      to: "2026-12-31",
      officeId: "office-1",
      regionId: "region-1",
      repId: "rep-1",
      source: "Trade Show",
    });

    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi).toHaveBeenCalledWith(
      "/reports/data-mining?from=2026-01-01&to=2026-12-31&officeId=office-1&regionId=region-1&repId=rep-1&source=Trade+Show"
    );
  });

  it("builds the regional ownership endpoint with the shared office filter", async () => {
    mockApi.mockResolvedValue({
      data: {
        regionRollups: [],
        repRollups: [],
        ownershipGaps: [],
      },
    });

    const { executeRegionalOwnershipOverview } = await import("@/hooks/use-reports");
    await executeRegionalOwnershipOverview({
      from: "2026-01-01",
      to: "2026-12-31",
      officeId: "office-1",
      regionId: "region-1",
      repId: "rep-1",
      source: "Trade Show",
    });

    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi).toHaveBeenCalledWith(
      "/reports/regional-ownership?from=2026-01-01&to=2026-12-31&officeId=office-1&regionId=region-1&repId=rep-1&source=Trade+Show"
    );
  });

  it("builds the forecast variance endpoint with the shared analytics filters", async () => {
    mockApi.mockResolvedValue({
      data: {
        summary: {
          comparableDeals: 1,
          avgInitialVariance: 10000,
          avgQualifiedVariance: 8000,
          avgEstimatingVariance: 4000,
          avgCloseDriftDays: 5,
        },
        repRollups: [],
        deals: [],
      },
    });

    const { executeForecastVarianceOverview } = await import("@/hooks/use-reports");
    await executeForecastVarianceOverview({
      from: "2026-01-01",
      to: "2026-12-31",
      officeId: "office-1",
      regionId: "region-1",
      repId: "rep-1",
      source: "Trade Show",
    });

    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi).toHaveBeenCalledWith(
      "/reports/forecast-variance?from=2026-01-01&to=2026-12-31&officeId=office-1&regionId=region-1&repId=rep-1&source=Trade+Show"
    );
  });

  it("only allows directors to view the data mining section", () => {
    expect(canViewDataMiningSection("director")).toBe(true);
    expect(canViewDataMiningSection("admin")).toBe(false);
    expect(canViewDataMiningSection("rep")).toBe(false);
    expect(canViewDataMiningSection(undefined)).toBe(false);
  });

  it("renders the data mining section with untouched and dormant summaries", () => {
    const html = renderToStaticMarkup(
      <DataMiningSection
        loading={false}
        data={{
          summary: {
            untouchedContact30Count: 4,
            untouchedContact60Count: 2,
            untouchedContact90Count: 1,
            dormantCompany90Count: 3,
          },
          untouchedContacts: [
            {
              contactId: "contact-1",
              contactName: "Jordan Client",
              companyName: "Acme Roofing",
              daysSinceTouch: 63,
              lastTouchedAt: "2026-02-01T00:00:00.000Z",
            },
          ],
          dormantCompanies: [
            {
              companyId: "company-1",
              companyName: "Acme Roofing",
              daysSinceActivity: 137,
              lastActivityAt: "2025-12-01T00:00:00.000Z",
              activeDealCount: 0,
            },
          ],
        }}
      />
    );

    expect(html).toContain("Untouched Contacts and Dormant Companies");
    expect(html).toContain("Untouched 30d+");
    expect(html).toContain("Dormant 90d+");
    expect(html).toContain("Jordan Client");
    expect(html).toContain("Acme Roofing");
  });

  it("renders an empty data mining state when data has not loaded", () => {
    const html = renderToStaticMarkup(<DataMiningSection loading={false} data={null} />);
    expect(html).toContain("No data-mining records found for the selected filters.");
  });
});

describe("SourcePerformanceSection", () => {
  it("renders the canonical source-performance lane with lead counts and source filters", () => {
    const html = renderToStaticMarkup(<SourcePerformanceSection />);

    expect(html).toContain("Source Performance");
    expect(html).toContain("Lead and Deal Volume by Source");
    expect(html).toContain("Trade Show");
    expect(html).toContain("Lead Count");
    expect(html).toContain("Deal Count");
    expect(html).toContain("Office ID");
    expect(html).toContain("Export CSV");
    expect(html).toContain("Export PDF");
    expect(html).toContain("Unknown");
  });
});

describe("ForecastVarianceSection", () => {
  it("renders the forecast variance lane with variance summaries and deal rows", () => {
    const html = renderToStaticMarkup(
      <ForecastVarianceSection />
    );

    expect(html).toContain("Forecast Variance");
    expect(html).toContain("Avg Initial Variance");
    expect(html).toContain("Office ID");
    expect(html).toContain("Export CSV");
    expect(html).toContain("North Plaza");
    expect(html).toContain("Jordan");
  });
});

describe("RegionalOwnershipSection", () => {
  it("renders regional ownership rollups and ownership gaps", () => {
    const html = renderToStaticMarkup(
      <RegionalOwnershipSection
        data={{
          regionRollups: [
            {
              regionId: "region-1",
              regionName: "North Texas",
              dealCount: 4,
              pipelineValue: 240000,
              staleDealCount: 1,
            },
          ],
          repRollups: [
            {
              repId: "rep-1",
              repName: "Jordan",
              dealCount: 3,
              pipelineValue: 180000,
              activityCount: 12,
              staleDealCount: 0,
            },
          ],
          ownershipGaps: [
            { gapType: "missing_assigned_rep", count: 2 },
            { gapType: "missing_region", count: 1 },
          ],
        }}
        loading={false}
      />
    );

    expect(html).toContain("Regional and Rep Ownership");
    expect(html).toContain("Regional Pipeline by Region");
    expect(html).toContain("Export CSV");
    expect(html).toContain("Export PDF");
    expect(html).toContain("North Texas");
    expect(html).toContain("Jordan");
    expect(html).toContain("Missing Assigned Rep");
    expect(html).toContain("Missing Region");
  });

  it("renders a loading state while the overview is fetching", () => {
    const html = renderToStaticMarkup(<RegionalOwnershipSection data={null} loading />);
    expect(html).toContain("Loading regional ownership");
  });
});
