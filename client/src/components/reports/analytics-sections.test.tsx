import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach } from "vitest";

vi.mock("@/hooks/use-reports", () => ({
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
}));

import { DataMiningSection } from "./data-mining-section";
import { SourcePerformanceSection } from "./source-performance-section";

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

  it("renders an empty state when data has not loaded", () => {
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
