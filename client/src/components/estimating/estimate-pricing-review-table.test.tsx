import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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
    <EstimatePricingReviewTable dealId="deal-1" rows={rows} onRefresh={onRefresh} />
  );
}

describe("EstimatePricingReviewTable", () => {
  beforeEach(() => {
    mocks.apiMock.mockReset();
  });

  it("renders ranked pricing recommendation detail, duplicate blockers, and row actions", () => {
    const html = renderTable([
      {
        id: "price-1",
        status: "pending_review",
        recommendedQuantity: "12",
        recommendedUnit: "sq",
        recommendedUnitPrice: "355.25",
        recommendedTotalPrice: "4263.00",
        priceBasis: "catalog option",
        confidence: "0.81",
        createdByRunId: "run-7",
        selectedSourceType: "catalog_option",
        selectedOptionId: "option-rec",
        duplicateGroupBlocked: true,
        duplicateGroupKey: "Roofing::tpo membrane",
        catalogBacking: "local_catalog",
        sourceType: "inferred",
        recommendationOptions: [
          {
            id: "option-rec",
            optionKind: "recommended",
            optionLabel: "Recommended TPO membrane",
            rank: 1,
            rationale: "Best match for the selected extraction.",
          },
          {
            id: "option-alt-1",
            optionKind: "alternate",
            optionLabel: "Alternate TPO membrane",
            rank: 2,
            rationale: "Good fallback if the recommended stock is unavailable.",
          },
        ],
      },
    ]);

    expect(html).toContain("Draft Pricing");
    expect(html).toContain("Recommended");
    expect(html).toContain("Default");
    expect(html).toContain("12 sq");
    expect(html).toContain("$355.25");
    expect(html).toContain("$4,263.00");
    expect(html).toContain("catalog option");
    expect(html).toContain("Inferred");
    expect(html).toContain("Duplicate blocked");
    expect(html).toContain("Local catalog");
    expect(html).toContain("Alternates");
    expect(html).toContain("Recommended TPO membrane");
    expect(html).toContain("Accept recommended");
    expect(html).toContain("Accept manual row");
    expect(html).toContain("Override");
    expect(html).toContain("Reject");
    expect(html).toContain("Pending review");
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
