import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DirectorRepWorkspace } from "./director-rep-workspace";

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("DirectorRepWorkspace", () => {
  it("renders table controls, page metadata, and the first page of reps", () => {
    const html = normalize(
      renderToStaticMarkup(
        <DirectorRepWorkspace
          repCards={[
            {
              repId: "rep-1",
              repName: "Alpha Rep",
              activeDeals: 4,
              pipelineValue: 150000,
              winRate: 40,
              activityScore: 12,
              staleDeals: 1,
              staleLeads: 0,
            },
            {
              repId: "rep-2",
              repName: "Bravo Rep",
              activeDeals: 7,
              pipelineValue: 450000,
              winRate: 55,
              activityScore: 3,
              staleDeals: 2,
              staleLeads: 2,
            },
          ]}
          initialPageSize={25}
          onSelectRep={vi.fn()}
        />
      )
    );

    expect(html).toContain("Rep performance");
    expect(html).toContain("Search reps");
    expect(html).toContain("Sort by");
    expect(html).toContain("Alpha Rep");
    expect(html).toContain("Bravo Rep");
    expect(html).toContain("Page 1 of 1");
  });
});
