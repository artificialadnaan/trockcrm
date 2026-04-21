import { describe, expect, it, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EstimatingWorkflowShell } from "./estimating-workflow-shell";
import type { EstimatingWorkflowState } from "./estimating-workflow-shell";

const mocks = vi.hoisted(() => ({
  activePanel: null as string | null,
  manualDialogOpen: null as boolean | null,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();

  return {
    ...actual,
    useState: <T,>(initialState: T) => {
      if (mocks.activePanel !== null && initialState === "documents") {
        return [mocks.activePanel as T, vi.fn()] as const;
      }

      if (mocks.manualDialogOpen !== null && initialState === false) {
        return [mocks.manualDialogOpen as T, vi.fn()] as const;
      }

      return actual.useState(initialState);
    },
  };
});

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: any }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: any }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: any }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: any }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: any }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: any }) => <div>{children}</div>,
}));

vi.mock("./estimate-extraction-review-table", () => ({
  EstimateExtractionReviewTable: ({ onRefresh }: { onRefresh?: unknown }) => (
    <div>Extraction refresh {typeof onRefresh}</div>
  ),
}));

vi.mock("./estimate-catalog-match-table", () => ({
  EstimateCatalogMatchTable: ({ onRefresh }: { onRefresh?: unknown }) => (
    <div>Match refresh {typeof onRefresh}</div>
  ),
}));

vi.mock("./estimate-pricing-review-table", () => ({
  isFreeTextManualRow: () => false,
  EstimatePricingReviewTable: ({
    onRefresh,
    onOpenManualAdd,
    onPromoteToEstimate,
    onReviewAction,
  }: {
    onRefresh?: unknown;
    onOpenManualAdd?: unknown;
    onPromoteToEstimate?: unknown;
    onReviewAction?: unknown;
  }) => (
    <div>
      Pricing refresh {typeof onRefresh} manual add {typeof onOpenManualAdd} promote{" "}
      {typeof onPromoteToEstimate} review {typeof onReviewAction}
    </div>
  ),
}));

afterEach(() => {
  mocks.activePanel = null;
  mocks.manualDialogOpen = null;
  vi.restoreAllMocks();
});

function buildWorkflow(canPromote: boolean) {
  return {
    documents: [],
    extractionRows: [],
    matchRows: [],
    pricingRows: [
      {
        id: "price-1",
        status: "approved",
        createdByRunId: "run-1",
        extractionMatchId: "match-1",
        sectionName: "Doors",
        duplicateGroupBlocked: false,
        promotable: canPromote,
      },
    ],
    reviewEvents: [],
    summary: {
      documents: { total: 0, queued: 0, failed: 0 },
      extractions: { total: 0, pending: 0, approved: 0, rejected: 0, unmatched: 0 },
      matches: { total: 0, suggested: 0, selected: 0, rejected: 0 },
      pricing: {
        total: 1,
        pending: 0,
        approved: 1,
        overridden: 0,
        rejected: 0,
        readyToPromote: canPromote ? 1 : 0,
      },
    },
    promotionReadiness: {
      canPromote,
      generationRunIds: canPromote ? ["run-1"] : [],
    },
  } satisfies EstimatingWorkflowState;
}

describe("EstimatingWorkflowShell", () => {
  it("threads the workbench action callbacks into the pricing panel", () => {
    mocks.activePanel = "pricing";

    const html = renderToStaticMarkup(
      <EstimatingWorkflowShell
        dealId="deal-1"
        workflow={buildWorkflow(true)}
        onRefresh={async () => {}}
      />
    );

    expect(html).toContain("Pricing refresh function");
    expect(html).toContain("manual add function");
    expect(html).toContain("promote function");
    expect(html).toContain("review function");
  });

  it("shows promote-to-estimate gating when the workflow is not ready", () => {
    mocks.activePanel = "pricing";
    mocks.manualDialogOpen = true;

    const html = renderToStaticMarkup(
      <EstimatingWorkflowShell
        dealId="deal-1"
        workflow={buildWorkflow(false)}
        onRefresh={async () => {}}
      />
    );

    expect(html).toContain("Add manual row");
    expect(html).toContain("Promote to estimate");
    expect(html).toContain("Disabled");
    expect(html).toContain("Needs review");
    expect(html).toContain("Manual add unavailable");
    expect(html).toContain("Search catalog options");
    expect(html).toContain("Use free-text/manual row instead");
  });

  it("requires a focused promotable row when multiple generation runs are ready", () => {
    mocks.activePanel = "pricing";

    const html = renderToStaticMarkup(
      <EstimatingWorkflowShell
        dealId="deal-1"
        workflow={{
          ...buildWorkflow(true),
          pricingRows: [
            {
              id: "price-1",
              status: "approved",
              createdByRunId: "run-1",
              extractionMatchId: "match-1",
              sectionName: "Doors",
              duplicateGroupBlocked: false,
              promotable: false,
            },
            {
              id: "price-2",
              status: "approved",
              createdByRunId: "run-2",
              extractionMatchId: "match-2",
              sectionName: "Windows",
              duplicateGroupBlocked: false,
              promotable: true,
            },
          ],
          promotionReadiness: {
            canPromote: true,
            generationRunIds: ["run-1", "run-2"],
          },
        }}
        onRefresh={async () => {}}
      />
    );

    expect(html).toContain("Focus a promotable row to choose which draft run to promote.");
    expect(html).toContain("Disabled");
  });
});
