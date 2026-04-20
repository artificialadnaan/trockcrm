import { useState } from "react";
import { EstimateCatalogMatchTable } from "./estimate-catalog-match-table";
import { EstimateCopilotPanel } from "./estimate-copilot-panel";
import { EstimateDocumentsPanel } from "./estimate-documents-panel";
import { EstimateExtractionReviewTable } from "./estimate-extraction-review-table";
import { EstimateOverviewPanel } from "./estimate-overview-panel";
import { EstimatePricingReviewTable } from "./estimate-pricing-review-table";
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
          <EstimatePricingReviewTable
            rows={workflow.pricingRows}
            onRefresh={onRefresh}
          />
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

        <section className="min-w-0 rounded-lg border bg-background">
          {activePanelContent}
        </section>

        <EstimateWorkbenchDetailPane activePanel={activePanel} workflow={workflow} />
      </div>
    </div>
  );
}
