import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EstimateMarketOverridePanel,
  loadEstimateMarketChoicesAction,
  runEstimateClearMarketOverrideAction,
  runEstimateSetMarketOverrideAction,
} from "./estimate-market-override-panel";

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: mocks.apiMock,
}));

describe("EstimateMarketOverridePanel", () => {
  beforeEach(() => {
    mocks.apiMock.mockReset();
  });

  it("renders effective market, override state, and rerun status", () => {
    const html = renderToStaticMarkup(
      <EstimateMarketOverridePanel
        dealId="deal-1"
        marketContext={{
          effectiveMarket: { id: "market-1", name: "North Texas", type: "state" },
          resolutionLevel: "override",
          resolutionSource: { type: "override", key: "deal-1", marketId: "market-1" },
          location: { zip: "75001", state: "TX", regionId: "south" },
          isOverridden: true,
          override: {
            marketId: "market-1",
            marketName: "North Texas",
            overrideReason: "storm area",
          },
        }}
        rerunStatus={{
          status: "running",
          rerunRequestId: "rerun-1",
        }}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(html).toContain("Market Context");
    expect(html).toContain("North Texas");
    expect(html).toContain("Override active");
    expect(html).toContain("Override rerun running");
    expect(html).toContain("Location: 75001");
    expect(html).toContain("Override reason: storm area");
    expect(html).toContain("request rerun-1");
    expect(html).toContain("Apply override");
    expect(html).toContain("Clear override");
  });

  it("loads market choices from the server", async () => {
    mocks.apiMock.mockResolvedValueOnce({
      markets: [{ id: "market-1", name: "North Texas", slug: "north-texas", type: "state" }],
    });

    const markets = await loadEstimateMarketChoicesAction("deal-1");

    expect(markets).toHaveLength(1);
    expect(mocks.apiMock).toHaveBeenCalledWith("/deals/deal-1/estimating/markets");
  });

  it("posts set and clear override actions", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    mocks.apiMock.mockResolvedValue({});

    await runEstimateSetMarketOverrideAction({
      dealId: "deal-1",
      marketId: "market-2",
      reason: "storm area",
      refresh,
    });
    await runEstimateClearMarketOverrideAction({
      dealId: "deal-1",
      reason: "reset",
      refresh,
    });

    expect(mocks.apiMock).toHaveBeenNthCalledWith(1, "/deals/deal-1/estimating/market-override", {
      method: "PUT",
      json: {
        marketId: "market-2",
        reason: "storm area",
      },
    });
    expect(mocks.apiMock).toHaveBeenNthCalledWith(2, "/deals/deal-1/estimating/market-override", {
      method: "DELETE",
      json: {
        reason: "reset",
      },
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
