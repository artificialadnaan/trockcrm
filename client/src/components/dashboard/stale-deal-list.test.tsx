import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { StaleDealList } from "./stale-deal-list";

describe("StaleDealList", () => {
  it("routes the stale deal watchlist header to the reports stale deals section", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StaleDealList
          deals={[
            {
              dealId: "deal-1",
              dealNumber: "TR-2026-0001",
              dealName: "North Campus",
              stageName: "Estimating",
              repName: "Avery Rep",
              daysInStage: 22,
              dealValue: 125000,
            },
          ]}
        />
      </MemoryRouter>
    );

    expect(html).toContain('href="/reports#stale-deals"');
    expect(html).not.toContain("/deals?filter=stale");
  });
});
