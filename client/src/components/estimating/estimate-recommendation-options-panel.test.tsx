import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EstimateRecommendationOptionsPanel,
  getDisplayedSelectedOption,
  runEstimatePricingReviewStateAction,
} from "./estimate-recommendation-options-panel";
import { EstimateManualRowDialog, switchManualRowDraftToFreeText } from "./estimate-manual-row-dialog";
import {
  runEstimateManualRowCreateAction,
} from "./estimate-manual-row-dialog";

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: mocks.apiMock,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: any }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: any }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: any }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: any }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: any }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: any }) => <div>{children}</div>,
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
    expect(html).not.toContain("Promote to local catalog");
    expect(html).toContain("Evidence");
    expect(html).toContain("Best match for the selected extraction");
  });

  it("shows local-catalog promotion for free-text manual rows", () => {
    const html = renderToStaticMarkup(
      <EstimateRecommendationOptionsPanel
        dealId="deal-1"
        recommendation={{
          id: "price-manual",
          sectionName: "Roofing",
          normalizedIntent: "custom flashing",
          selectedSourceType: "manual",
          catalogBacking: "estimate_only",
          recommendationOptions: [
            {
              id: "option-rec",
              optionKind: "recommended",
              optionLabel: "Manual flashing",
              rank: 1,
            },
          ],
        }}
        onReviewAction={vi.fn()}
        onPromoteLocalCatalog={vi.fn()}
      />
    );

    expect(html).toContain("Promote to local catalog");
  });

  it("does not fall back to a catalog option as the selected option for free-text manual rows", () => {
    expect(
      getDisplayedSelectedOption({
        id: "price-manual",
        selectedSourceType: "manual",
        recommendationOptions: [
          {
            id: "option-rec",
            optionKind: "recommended",
            optionLabel: "Manual flashing",
            rank: 1,
          },
        ],
      })
    ).toBeNull();
  });

  it("renders the manual add dialog with catalog-first and free-text controls", () => {
    const html = renderToStaticMarkup(
      <EstimateManualRowDialog
        dealId="deal-1"
        generationRunId="run-1"
        estimateSectionName="Doors"
        open
        onOpenChange={vi.fn()}
        onSubmitted={vi.fn()}
        initialValues={{
          label: "Walk-in door kit",
          quantity: "2",
          unit: "ea",
          unitPrice: "125.00",
          notes: "Estimator note",
        }}
        catalogOptions={[
          { id: "cat-1", optionLabel: "Walk-in door kit", optionKind: "recommended", rank: 1 },
          { id: "cat-2", optionLabel: "Door hardware", optionKind: "alternate", rank: 2 },
        ]}
      />
    );

    expect(html).toContain("Add manual estimate row");
    expect(html).toContain("Search catalog options");
    expect(html).toContain("Use free-text/manual row instead");
    expect(html).toContain("Walk-in door kit");
    expect(html).toContain("Door hardware");
  });

  it("blocks manual-row creation without active generation-run context", () => {
    const html = renderToStaticMarkup(
      <EstimateManualRowDialog
        dealId="deal-1"
        open
        onOpenChange={vi.fn()}
        onSubmitted={vi.fn()}
      />
    );

    expect(html).toContain("Manual row creation is unavailable until an active pricing run is selected.");
    expect(html).toContain("disabled");
  });

  it("clears catalog-backed selection when switching back to free-text mode", () => {
    expect(
      switchManualRowDraftToFreeText({
        label: "Walk-in door kit",
        quantity: "2",
        unit: "ea",
        unitPrice: "125.00",
        notes: "Estimator note",
        selectedSourceType: "catalog_option",
        selectedOptionId: "cat-1",
      })
    ).toEqual({
      label: "Walk-in door kit",
      quantity: "2",
      unit: "ea",
      unitPrice: "125.00",
      notes: "Estimator note",
      selectedSourceType: "manual",
      selectedOptionId: "",
    });
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
      generationRunId: "run-1",
      estimateSectionName: "Doors",
      input: {
        label: "Walk-in door kit",
        quantity: "2",
        unit: "ea",
        unitPrice: "125.00",
        notes: "Estimator note",
        selectedSourceType: "manual",
      },
      catalogQuery: "door",
      catalogOptions: [
        {
          id: "cat-1",
          optionLabel: "Walk-in door kit",
          rationale: "Best match",
        },
      ],
      refresh,
    });

    expect(mocks.apiMock).toHaveBeenCalledWith("/deals/deal-1/estimating/manual-rows", {
      method: "POST",
      json: {
        generationRunId: "run-1",
        estimateSectionName: "Doors",
        manualLabel: "Walk-in door kit",
        manualQuantity: "2",
        manualUnit: "ea",
        manualUnitPrice: "125.00",
        manualNotes: "Estimator note",
        selectedSourceType: "manual",
        catalogQuery: "door",
        catalogOptions: [
          {
            optionLabel: "Walk-in door kit",
            stableId: "cat-1",
          },
        ],
      },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("posts selected catalog options using stable ids for manual-add round trips", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    mocks.apiMock.mockResolvedValue({});

    await runEstimateManualRowCreateAction({
      dealId: "deal-1",
      generationRunId: "run-1",
      estimateSectionName: "Doors",
      input: {
        label: "Walk-in door kit",
        quantity: "2",
        unit: "ea",
        unitPrice: "125.00",
        notes: "",
        selectedSourceType: "catalog_option",
        selectedOptionId: "cat-1",
      },
      catalogQuery: "door",
      catalogOptions: [
        {
          id: "cat-1",
          optionLabel: "Walk-in door kit",
          optionKind: "recommended",
          rationale: "Best match",
        },
        {
          id: "cat-2",
          optionLabel: "Door hardware",
          optionKind: "alternate",
        },
      ],
      refresh,
    });

    expect(mocks.apiMock).toHaveBeenCalledWith("/deals/deal-1/estimating/manual-rows", {
      method: "POST",
      json: {
        generationRunId: "run-1",
        estimateSectionName: "Doors",
        manualLabel: "Walk-in door kit",
        manualQuantity: "2",
        manualUnit: "ea",
        manualUnitPrice: "125.00",
        manualNotes: "",
        selectedSourceType: "catalog_option",
        selectedOptionStableId: "cat-1",
        catalogQuery: "door",
        catalogOptions: [
          {
            optionLabel: "Walk-in door kit",
            optionKind: "recommended",
            stableId: "cat-1",
          },
          {
            optionLabel: "Door hardware",
            optionKind: "alternate",
            stableId: "cat-2",
          },
        ],
      },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
