import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EstimateRecommendationOptionsPanel,
  runEstimatePricingReviewStateAction,
} from "./estimate-recommendation-options-panel";
import {
  runEstimateManualRowCreateAction,
} from "./estimate-manual-row-dialog";

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: mocks.apiMock,
}));

describe("EstimateRecommendationOptionsPanel", () => {
  beforeEach(() => {
    mocks.apiMock.mockReset();
  });

  it("renders ranked options, duplicate blockers, and local catalog actions", () => {
    const html = renderToStaticMarkup(
      <EstimateRecommendationOptionsPanel
        dealId="deal-1"
        recommendation={{
          id: "price-1",
          sectionName: "Roofing",
          normalizedIntent: "tpo membrane",
          duplicateGroupKey: "Roofing::tpo membrane",
          duplicateGroupBlocked: true,
          selectedSourceType: "catalog_option",
          selectedOptionId: "option-rec",
          catalogBacking: "local_catalog",
          recommendationOptions: [
            {
              id: "option-rec",
              optionKind: "recommended",
              optionLabel: "Recommended TPO membrane",
              rank: 1,
              rationale: "Best match for the selected extraction and catalog history.",
              evidenceText: "Matched to roof plan detail A-2.",
            },
            {
              id: "option-alt-1",
              optionKind: "alternate",
              optionLabel: "Alternate TPO membrane",
              rank: 2,
              rationale: "Matches the same scope with a broader roll width.",
            },
            {
              id: "option-alt-2",
              optionKind: "alternate",
              optionLabel: "Alternate insulation package",
              rank: 3,
              rationale: "Fallback if the primary membrane is unavailable.",
            },
          ],
          evidenceJson: {
            sourceDocumentId: "doc-7",
            sourcePage: "12",
          },
          assumptionsJson: {
            source: "document-backed",
          },
        }}
        onReviewAction={vi.fn()}
        onPromoteLocalCatalog={vi.fn()}
      />
    );

    expect(html).toContain("Recommended TPO membrane");
    expect(html).toContain("Alternate TPO membrane");
    expect(html).toContain("Alternate insulation package");
    expect(html).toContain("Rank 1");
    expect(html).toContain("Duplicate blocked");
    expect(html).toContain("Local catalog");
    expect(html).toContain("Promote to local catalog");
    expect(html).toContain("Evidence");
    expect(html).toContain("Best match for the selected extraction");
  });

  it("posts review-state actions through the workbench helper", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    mocks.apiMock.mockResolvedValue({});

    await runEstimatePricingReviewStateAction({
      dealId: "deal-1",
      recommendationId: "price-1",
      refresh,
      input: {
        action: "switch_to_alternate",
        alternateOptionId: "option-alt-1",
        reason: "alternate option fits better",
      },
    });

    expect(mocks.apiMock).toHaveBeenCalledWith(
      "/deals/deal-1/estimating/pricing-recommendations/price-1/review-state",
      {
        method: "POST",
        json: {
          action: "switch_to_alternate",
          alternateOptionId: "option-alt-1",
          reason: "alternate option fits better",
        },
      }
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("posts manual rows through the helper", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    mocks.apiMock.mockResolvedValue({});

    await runEstimateManualRowCreateAction({
      dealId: "deal-1",
      input: {
        label: "Walk-in door kit",
        quantity: "2",
        unit: "ea",
        unitPrice: "125.00",
        selectedSourceType: "manual",
      },
      refresh,
    });

    expect(mocks.apiMock).toHaveBeenCalledWith("/deals/deal-1/estimating/manual-rows", {
      method: "POST",
      json: {
        label: "Walk-in door kit",
        quantity: "2",
        unit: "ea",
        unitPrice: "125.00",
        selectedSourceType: "manual",
      },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
