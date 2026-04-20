import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  EstimatePricingReviewTable,
  runEstimatePricingReviewAction,
} from "./estimate-pricing-review-table";

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: mocks.apiMock,
}));

function renderTable(rows: any[], onRefresh = vi.fn().mockResolvedValue(undefined)) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/deals/deal-1/estimates"]}>
      <Routes>
        <Route
          path="/deals/:dealId/estimates"
          element={<EstimatePricingReviewTable rows={rows} onRefresh={onRefresh} />}
        />
      </Routes>
    </MemoryRouter>
  );
}

describe("EstimatePricingReviewTable", () => {
  beforeEach(() => {
    mocks.apiMock.mockReset();
  });

  it("renders pricing review rows with recommendation detail and actions", () => {
    const html = renderTable([
      {
        id: "price-1",
        status: "pending",
        recommendedQuantity: "12",
        recommendedUnit: "sq",
        recommendedUnitPrice: "355.25",
        recommendedTotalPrice: "4263.00",
        priceBasis: "catalog",
        confidence: "0.81",
        createdByRunId: "run-7",
      },
    ]);

    expect(html).toContain("Draft Pricing");
    expect(html).toContain("12 sq");
    expect(html).toContain("$355.25");
    expect(html).toContain("$4,263.00");
    expect(html).toContain("catalog");
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
  });

  it("posts pricing review actions then refreshes", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    mocks.apiMock.mockResolvedValue({});

    await runEstimatePricingReviewAction({
      action: "approve",
      dealId: "deal-1",
      recommendationId: "price-1",
      refresh,
    });

    await runEstimatePricingReviewAction({
      action: "reject",
      dealId: "deal-1",
      recommendationId: "price-1",
      refresh,
    });

    expect(mocks.apiMock).toHaveBeenNthCalledWith(
      1,
      "/deals/deal-1/estimating/pricing-recommendations/price-1/approve",
      { method: "POST" }
    );
    expect(mocks.apiMock).toHaveBeenNthCalledWith(
      2,
      "/deals/deal-1/estimating/pricing-recommendations/price-1/reject",
      { method: "POST" }
    );
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
