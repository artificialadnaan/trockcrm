// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RepPerformanceCard } from "./rep-performance-card";
import type { RepPerformanceCard as RepCardData } from "@/hooks/use-director-dashboard";

// RepPerformanceCard is a director-dashboard surface that formats rep.pipelineValue
// with the (formerly unsafe) chart-colors formatCurrency. This proves the call
// site renders the safe fallback instead of "$NaN" when the value is missing/invalid,
// and that valid values still render the compact currency unchanged.
function makeRep(overrides: Partial<RepCardData>): RepCardData {
  return {
    repId: "rep-1",
    repName: "Jordan Rep",
    activeDeals: 3,
    pipelineValue: 125_000,
    winRate: 42,
    activityScore: 17,
    staleDeals: 0,
    staleLeads: 0,
    closedValue: 0,
    winsCount: 0,
    ...overrides,
  };
}

describe("RepPerformanceCard — no $NaN on the director dashboard", () => {
  it("renders the safe fallback (not '$NaN') when pipelineValue is NaN", () => {
    const html = renderToStaticMarkup(
      <RepPerformanceCard rep={makeRep({ pipelineValue: NaN })} onClick={() => {}} />
    );
    expect(html).not.toContain("$NaN");
    expect(html).toContain("--");
  });

  it("renders compact currency unchanged for a valid pipeline value", () => {
    const html = renderToStaticMarkup(
      <RepPerformanceCard rep={makeRep({ pipelineValue: 1_500_000 })} onClick={() => {}} />
    );
    expect(html).toContain("$1.5M");
    expect(html).not.toContain("$NaN");
  });
});
