import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EstimateWorkbenchSummaryStrip } from "./estimate-workbench-summary-strip";
import type { EstimatingWorkflowState } from "./estimating-workflow-shell";

function buildWorkflow(): EstimatingWorkflowState {
  return {
    documents: [],
    extractionRows: [],
    matchRows: [],
    pricingRows: [],
    reviewEvents: [],
    summary: {
      documents: { total: 2, queued: 1, failed: 0 },
      extractions: { total: 4, pending: 2, approved: 2, rejected: 0, unmatched: 0 },
      matches: { total: 3, suggested: 1, selected: 2, rejected: 0 },
      pricing: { total: 3, pending: 1, approved: 2, overridden: 0, rejected: 0, readyToPromote: 2 },
    },
    promotionReadiness: {
      canPromote: true,
      generationRunIds: ["run-1"],
    },
    marketContext: {
      effectiveMarket: { id: "market-1", name: "North Texas", type: "state" },
      resolutionLevel: "state",
    },
    rerunStatus: {
      status: "queued",
      rerunRequestId: "rerun-1",
    },
    manualAddContext: {
      generationRunId: "run-1",
      extractionMatchId: "match-1",
      estimateSectionName: "Roofing",
    },
  };
}

describe("EstimateWorkbenchSummaryStrip", () => {
  it("renders market name and rerun status in the summary strip", () => {
    const html = renderToStaticMarkup(
      <EstimateWorkbenchSummaryStrip workflow={buildWorkflow()} />
    );

    expect(html).toContain("North Texas");
    expect(html).toContain("Auto-detected");
    expect(html).toContain("Override rerun queued");
    expect(html).toContain("Review-ready");
  });
});
