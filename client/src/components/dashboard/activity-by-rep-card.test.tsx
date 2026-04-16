import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityByRepCard } from "./activity-by-rep-card";

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("ActivityByRepCard", () => {
  it("renders ranked rep summaries with actionable detail", () => {
    const html = normalize(
      renderToStaticMarkup(
        <ActivityByRepCard
          activityByRep={[
            {
              repId: "rep-1",
              repName: "Caleb Rep",
              calls: 8,
              emails: 9,
              meetings: 3,
              notes: 4,
              total: 24,
            },
            {
              repId: "rep-2",
              repName: "James Director",
              calls: 1,
              emails: 1,
              meetings: 0,
              notes: 1,
              total: 3,
            },
          ]}
          repCards={[
            {
              repId: "rep-1",
              repName: "Caleb Rep",
              activeDeals: 7,
              pipelineValue: 1200000,
              staleDeals: 2,
              staleLeads: 1,
            },
            {
              repId: "rep-2",
              repName: "James Director",
              activeDeals: 2,
              pipelineValue: 250000,
              staleDeals: 0,
              staleLeads: 0,
            },
          ]}
          onSelectRep={vi.fn()}
          formatCurrency={(value) => `$${value.toLocaleString()}`}
        />
      )
    );

    expect(html).toContain("Activity by Rep");
    expect(html).toContain("Team activity");
    expect(html).toContain("Most active rep");
    expect(html).toContain("Caleb Rep");
    expect(html).toContain("James Director");
    expect(html).toContain("High output");
    expect(html).toContain("Needs review");
    expect(html).toContain("Open detailed activity report");
    expect(html).toContain("$1,200,000");
  });
});
