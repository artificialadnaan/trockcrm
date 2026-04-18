import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

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

import { SourcePerformanceSection } from "./source-performance-section";

describe("SourcePerformanceSection", () => {
  it("renders the canonical source-performance lane with lead counts and source filters", () => {
    const html = renderToStaticMarkup(<SourcePerformanceSection />);

    expect(html).toContain("Source Performance");
    expect(html).toContain("Trade Show");
    expect(html).toContain("Lead Count");
    expect(html).toContain("Deal Count");
    expect(html).toContain("Office ID");
    expect(html).toContain("Unknown");
  });
});
