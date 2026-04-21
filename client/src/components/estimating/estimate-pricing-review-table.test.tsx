import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EstimatePricingReviewTable,
  getPricingRowSelectionState,
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
    <EstimatePricingReviewTable
      dealId="deal-1"
      rows={rows}
      onRefresh={onRefresh}
      onPromoteLocalCatalog={vi.fn()}
    />
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
        sourceType: "manual",
        selectedSourceType: null,
        duplicateGroupBlocked: true,
        duplicateGroupKey: "Roofing::tpo membrane",
        catalogBacking: "estimate_only",
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
    expect(html).toContain("Manual / free-text row");
    expect(html).toContain("12 sq");
    expect(html).toContain("$355.25");
    expect(html).toContain("$4,263.00");
    expect(html).toContain("catalog option");
    expect(html).toContain("Duplicate blocked");
    expect(html).toContain("Alternates");
    expect(html).toContain("Accept recommended");
    expect(html).toContain("Accept manual row");
    expect(html).toContain("Override");
    expect(html).toContain("Reject");
    expect(html).toContain("Pending review");
    expect(html).toContain("Promote to local catalog");
  });

  it("does not expose local-catalog promotion for catalog-backed rows", () => {
    const html = renderTable([
      {
        id: "price-2",
        status: "pending_review",
        recommendedQuantity: "12",
        recommendedUnit: "sq",
        recommendedUnitPrice: "355.25",
        recommendedTotalPrice: "4263.00",
        priceBasis: "catalog option",
        confidence: "0.81",
        createdByRunId: "run-7",
        selectedSourceType: "catalog_option",
        duplicateGroupBlocked: false,
        catalogBacking: "local_promoted",
      },
    ]);

    expect(html).not.toContain("Promote to local catalog");
  });

  it("hides unsupported review actions when a row has no recommended option or prices", () => {
    const html = renderTable([
      {
        id: "price-missing-actions",
        status: "pending_review",
        sourceType: "manual",
        manualOrigin: "manual_estimator_added",
        selectedSourceType: "manual",
        selectedOptionId: null,
        catalogBacking: "procore_synced",
        recommendationOptions: [
          {
            id: "option-alt-1",
            optionKind: "alternate",
            optionLabel: "Alternate only",
            rank: 2,
          },
        ],
      },
    ]);

    expect(html).not.toContain("Accept recommended");
    expect(html).not.toContain("Override");
    expect(html).not.toContain("Promote to local catalog");
  });

  it("does not expose local-catalog promotion for extracted rows that were merely accepted as manual", () => {
    const html = renderTable([
      {
        id: "price-3",
        status: "pending_review",
        sourceType: "extracted",
        selectedSourceType: "manual",
        catalogBacking: "estimate_only",
      },
    ]);

    expect(html).not.toContain("Promote to local catalog");
  });

  it("does not expose local-catalog promotion for generated manual clones", () => {
    const html = renderTable([
      {
        id: "price-4",
        status: "pending_review",
        sourceType: "manual",
        manualOrigin: "generated",
        selectedSourceType: null,
        catalogBacking: "estimate_only",
      },
    ]);

    expect(html).not.toContain("Promote to local catalog");
  });

  it("tracks the actual chosen row state instead of inferring recommended badges from availability", () => {
    const options = [
      {
        id: "option-rec",
        optionKind: "recommended" as const,
        optionLabel: "Recommended TPO membrane",
        rank: 1,
      },
      {
        id: "option-alt-1",
        optionKind: "alternate" as const,
        optionLabel: "Alternate TPO membrane",
        rank: 2,
      },
    ];

    expect(
      getPricingRowSelectionState({
        id: "price-manual",
        sourceType: "manual",
        selectedSourceType: null,
        recommendationOptions: options,
      })
    ).toMatchObject({
      displayLabel: "Manual / free-text row",
      isManual: true,
      isRecommended: false,
      isDefault: false,
      isAlternate: false,
      selectedOption: null,
    });

    expect(
      getPricingRowSelectionState({
        id: "price-alt",
        selectedSourceType: "catalog_option",
        selectedOptionId: "option-alt-1",
        recommendationOptions: options,
      })
    ).toMatchObject({
      displayLabel: "Alternate TPO membrane",
      isManual: false,
      isRecommended: false,
      isDefault: false,
      isAlternate: true,
    });

    expect(
      getPricingRowSelectionState({
        id: "price-rec",
        selectedSourceType: "catalog_option",
        selectedOptionId: "option-rec",
        recommendationOptions: options,
      })
    ).toMatchObject({
      displayLabel: "Recommended TPO membrane",
      isManual: false,
      isRecommended: true,
      isDefault: true,
      isAlternate: false,
    });
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
