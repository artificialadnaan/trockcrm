import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EstimateCatalogMatchTable } from "./estimate-catalog-match-table";
import { EstimateCopilotPanel } from "./estimate-copilot-panel";
import { EstimateDocumentsPanel } from "./estimate-documents-panel";
import { EstimateExtractionReviewTable } from "./estimate-extraction-review-table";
import { EstimateManualRowDialog } from "./estimate-manual-row-dialog";
import {
  EstimatePricingReviewTable,
  runEstimatePricingReviewStateAction,
  runEstimatePromoteToEstimateAction,
} from "./estimate-pricing-review-table";
import { EstimateRecommendationOptionsPanel, runEstimatePromoteLocalCatalogAction } from "./estimate-recommendation-options-panel";
import { EstimateReviewLogPanel } from "./estimate-review-log-panel";
import { EstimateWorkbenchDetailPane } from "./estimate-workbench-detail-pane";
import { EstimateWorkbenchSidebar } from "./estimate-workbench-sidebar";
import { EstimateWorkbenchSummaryStrip } from "./estimate-workbench-summary-strip";

export interface EstimatingWorkflowState {
  documents: any[];
  extractionRows: any[];
  matchRows: any[];
  pricingRows: any[];
  reviewEvents: any[];
  summary: {
    documents: { total: number; queued: number; failed: number };
    extractions: {
      total: number;
      pending: number;
      approved: number;
      rejected: number;
      unmatched: number;
    };
    matches: { total: number; suggested: number; selected: number; rejected: number };
    pricing: {
      total: number;
      pending: number;
      approved: number;
      overridden: number;
      rejected: number;
      readyToPromote: number;
    };
  };
  promotionReadiness: {
    canPromote: boolean;
    generationRunIds: string[];
  };
}

export type WorkbenchPanelId =
  | "overview"
  | "documents"
  | "extraction"
  | "match"
  | "pricing"
  | "estimate"
  | "copilot"
  | "reviewLog";

export interface EstimatingWorkflowShellProps {
  dealId: string;
  workflow: EstimatingWorkflowState;
  onRefresh: () => Promise<void>;
  copilotEnabled?: boolean;
}

export function EstimatingWorkflowShell({
  dealId,
  workflow,
  onRefresh,
  copilotEnabled,
}: EstimatingWorkflowShellProps) {
  const [activePanel, setActivePanel] = useState<WorkbenchPanelId>("documents");
  const [manualAddOpen, setManualAddOpen] = useState(false);
  const [selectedPricingRowId, setSelectedPricingRowId] = useState<string | null>(
    workflow.pricingRows[0]?.id ?? null
  );
  const [pricingMutationPending, setPricingMutationPending] = useState(false);

  const selectedPricingRow =
    workflow.pricingRows.find((row) => row.id === selectedPricingRowId) ??
    workflow.pricingRows[0] ??
    null;

  const activeGenerationRunIds = new Set(
    workflow.promotionReadiness.generationRunIds.filter(
      (runId): runId is string => Boolean(runId?.trim())
    )
  );
  const promotionRunId =
    selectedPricingRow?.promotable &&
    selectedPricingRow?.createdByRunId &&
    activeGenerationRunIds.has(selectedPricingRow.createdByRunId)
      ? selectedPricingRow.createdByRunId
      : workflow.promotionReadiness.generationRunIds.length === 1
        ? workflow.promotionReadiness.generationRunIds[0] ?? null
        : null;
  const canPromote = workflow.promotionReadiness.canPromote && Boolean(promotionRunId);
  const selectedPricingRunId = selectedPricingRow?.createdByRunId ?? null;
  const selectedExtractionMatchId = selectedPricingRow?.extractionMatchId ?? null;
  const manualAddGenerationRunId = selectedPricingRunId?.trim() ? selectedPricingRunId : null;
  const manualAddSectionName = selectedPricingRow?.sectionName ?? null;
  const manualAddExtractionMatchId = selectedExtractionMatchId?.trim() ? selectedExtractionMatchId : null;
  const canAddManualRow = Boolean(
    manualAddGenerationRunId?.trim?.() &&
      manualAddSectionName?.trim?.() &&
      manualAddExtractionMatchId?.trim?.()
  );

  const handlePricingReviewAction = async ({
    row,
    input,
  }: {
    row: any;
    input: Parameters<typeof runEstimatePricingReviewStateAction>[0]["input"];
  }) => {
    setPricingMutationPending(true);
    try {
      await runEstimatePricingReviewStateAction({
        dealId,
        recommendationId: row.id,
        input,
        refresh: onRefresh,
      });
    } finally {
      setPricingMutationPending(false);
    }
  };

  const handlePromoteToEstimate = async () => {
    if (!promotionRunId) {
      return;
    }

    await runEstimatePromoteToEstimateAction({
      dealId,
      generationRunId: promotionRunId,
      refresh: onRefresh,
    });
  };

  const handlePromoteLocalCatalog = async (recommendationId: string) => {
    setPricingMutationPending(true);
    try {
      await runEstimatePromoteLocalCatalogAction({
        dealId,
        recommendationId,
        refresh: onRefresh,
      });
    } finally {
      setPricingMutationPending(false);
    }
  };

  const steps = [
    {
      id: "overview" as const,
      label: "Overview",
      count: undefined,
      detail: "Workflow posture and promotion readiness.",
    },
    {
      id: "documents" as const,
      label: "Documents",
      count: workflow.summary.documents.total,
      detail: "Source file intake and OCR status.",
    },
    {
      id: "extraction" as const,
      label: "Extraction",
      count: workflow.summary.extractions.pending,
      detail: "Rows awaiting estimator review.",
    },
    {
      id: "match" as const,
      label: "Catalog Match",
      count: workflow.summary.matches.suggested,
      detail: "Suggested mappings to resolve.",
    },
    {
      id: "pricing" as const,
      label: "Draft Pricing",
      count: workflow.summary.pricing.pending,
      detail: "Recommendations waiting on sign-off.",
    },
    {
      id: "estimate" as const,
      label: "Estimate",
      count: workflow.summary.pricing.readyToPromote,
      detail: "Promotion handoff into the editor below.",
    },
    ...(copilotEnabled
      ? [
          {
            id: "copilot" as const,
            label: "Copilot",
            count: undefined,
            detail: "Question answering from current workbench state.",
          },
        ]
      : []),
    {
      id: "reviewLog" as const,
      label: "Review Log",
      count: workflow.reviewEvents.length,
      detail: "Latest estimator and system review events.",
    },
  ];

  const activePanelContent = (() => {
    switch (activePanel) {
      case "overview":
        return <EstimateOverviewPanel dealId={dealId} />;
      case "documents":
        return (
          <EstimateDocumentsPanel
            dealId={dealId}
            documents={workflow.documents}
            onRefresh={onRefresh}
          />
        );
      case "extraction":
        return (
          <EstimateExtractionReviewTable
            rows={workflow.extractionRows}
            onRefresh={onRefresh}
          />
        );
      case "match":
        return (
          <EstimateCatalogMatchTable rows={workflow.matchRows} onRefresh={onRefresh} />
        );
      case "pricing":
        return (
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold">Workbench Actions</h3>
                <p className="text-xs text-muted-foreground">
                  {canPromote
                    ? "Approved rows can be promoted into the canonical estimate."
                    : workflow.promotionReadiness.generationRunIds.length > 1
                      ? "Focus a promotable row to choose which draft run to promote."
                      : "Review and resolve rows before promotion."}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canAddManualRow}
                  onClick={() => setManualAddOpen(true)}
                >
                  Add manual row
                </Button>
                <Button
                  size="sm"
                  disabled={!canPromote}
                  onClick={handlePromoteToEstimate}
                >
                  Promote to estimate
                </Button>
                <span className="text-xs text-muted-foreground">
                  {canAddManualRow ? "Manual add ready" : "Manual add unavailable"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {canPromote ? "Ready to promote" : "Disabled"}
                </span>
              </div>
            </div>

            <EstimatePricingReviewTable
              dealId={dealId}
              rows={workflow.pricingRows}
              actionsDisabled={pricingMutationPending}
              onRefresh={onRefresh}
              onReviewAction={handlePricingReviewAction}
              onFocusRow={setSelectedPricingRowId}
              onOpenManualAdd={() => setManualAddOpen(true)}
              onPromoteToEstimate={handlePromoteToEstimate}
              onPromoteLocalCatalog={handlePromoteLocalCatalog}
            />

            <EstimateRecommendationOptionsPanel
              dealId={dealId}
              recommendation={selectedPricingRow}
              actionsDisabled={pricingMutationPending}
              onReviewAction={(input) =>
                selectedPricingRow
                  ? handlePricingReviewAction({ row: selectedPricingRow, input })
                  : Promise.resolve()
              }
              onPromoteLocalCatalog={handlePromoteLocalCatalog}
            />
          </div>
        );
      case "estimate":
        return <EstimateOverviewPanel dealId={dealId} />;
      case "copilot":
        return copilotEnabled ? <EstimateCopilotPanel dealId={dealId} /> : null;
      case "reviewLog":
        return <EstimateReviewLogPanel events={workflow.reviewEvents} />;
      default:
        return null;
    }
  })();

  return (
    <div className="space-y-4">
      <EstimateWorkbenchSummaryStrip workflow={workflow} />

      <div className="grid gap-4 xl:grid-cols-[240px_minmax(0,1fr)_280px]">
        <EstimateWorkbenchSidebar
          activePanel={activePanel}
          onSelectPanel={setActivePanel}
          steps={steps}
        />

        <section className="min-w-0 rounded-lg border bg-background">{activePanelContent}</section>

        <EstimateWorkbenchDetailPane activePanel={activePanel} workflow={workflow} />
      </div>

      <EstimateManualRowDialog
        dealId={dealId}
        generationRunId={manualAddGenerationRunId}
        extractionMatchId={manualAddExtractionMatchId}
        estimateSectionName={manualAddSectionName}
        open={manualAddOpen}
        onOpenChange={setManualAddOpen}
        onSubmitted={onRefresh}
        catalogOptions={selectedPricingRow?.recommendationOptions ?? []}
      />
    </div>
  );
}

function EstimateOverviewPanel({ dealId }: { dealId: string }) {
  return (
    <section className="rounded-lg border p-4">
      <h3 className="text-sm font-semibold">Overview</h3>
      <p className="text-sm text-muted-foreground">Deal {dealId} estimate workflow overview.</p>
    </section>
  );
}
