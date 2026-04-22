import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EstimateWorkbenchDetailPane } from "./estimate-workbench-detail-pane";
import type { EstimatingWorkflowState } from "./estimating-workflow-shell";

const workflow: EstimatingWorkflowState = {
  documents: [],
  extractionRows: [],
  matchRows: [],
  pricingRows: [],
  reviewEvents: [],
  summary: {
    documents: { total: 2, queued: 1, failed: 0 },
    extractions: { total: 5, pending: 3, approved: 2, rejected: 0, unmatched: 0 },
    matches: { total: 3, suggested: 1, selected: 2, rejected: 0 },
    pricing: { total: 4, pending: 1, approved: 2, overridden: 1, rejected: 0, readyToPromote: 3 },
  },
  promotionReadiness: {
    canPromote: true,
    generationRunIds: ["run-1"],
  },
  marketContext: {
    effectiveMarket: { id: "market-1", name: "North Texas", type: "state" },
    resolutionLevel: "state",
    resolutionSource: { type: "state", key: "TX", marketId: "market-1" },
  },
  rerunStatus: {
    status: "failed",
    rerunRequestId: "rerun-2",
    errorSummary: "Queue worker timed out",
  },
  manualAddContext: {
    generationRunId: "run-1",
    extractionMatchId: "match-1",
    estimateSectionName: "Roofing",
  },
};

describe("EstimateWorkbenchDetailPane", () => {
  it("renders effective market and rerun failure detail", () => {
    const html = renderToStaticMarkup(
      <EstimateWorkbenchDetailPane activePanel="pricing" workflow={workflow} />
    );

    expect(html).toContain("North Texas");
    expect(html).toContain("Auto-detected");
    expect(html).toContain("state (TX)");
    expect(html).toContain("Failed");
    expect(html).toContain("Queue worker timed out");
  });

  it("shows a true no-context state when market resolution is unavailable", () => {
    const html = renderToStaticMarkup(
      <EstimateWorkbenchDetailPane
        activePanel="pricing"
        workflow={{
          ...workflow,
          marketContext: null,
        }}
      />
    );

    expect(html).toContain("No market context");
    expect(html).not.toContain("Auto-detected");
    expect(html).not.toContain("unknown source");
  });
});
