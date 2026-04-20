import type { EstimatingWorkflowState, WorkbenchPanelId } from "./estimating-workflow-shell";

const PANEL_COPY: Record<WorkbenchPanelId, { title: string; body: string }> = {
  overview: {
    title: "Current panel",
    body: "Use the workbench to assess document intake, review AI extraction output, and decide when draft pricing is ready to promote into the estimate editor below.",
  },
  documents: {
    title: "Current panel",
    body: "Source documents should be complete before extraction review. Reprocess any file if OCR stalled, failed, or needs a fresh pass after upstream fixes.",
  },
  extraction: {
    title: "Current panel",
    body: "Pending extractions need estimator confirmation before catalog match decisions and pricing recommendations become trustworthy.",
  },
  match: {
    title: "Current panel",
    body: "Catalog match review is where estimator intent gets anchored to known cost structure and historical line-item evidence.",
  },
  pricing: {
    title: "Current panel",
    body: "Approved or overridden pricing recommendations become promotion candidates for the estimate editor below.",
  },
  estimate: {
    title: "Current panel",
    body: "The editable estimate remains below this workbench. Use this stage when the draft is stable enough to reconcile section structure and line-item totals.",
  },
  copilot: {
    title: "Current panel",
    body: "Copilot should answer from the same workbench evidence. Treat it as support for review decisions, not a replacement for estimator sign-off.",
  },
  reviewLog: {
    title: "Current panel",
    body: "Use the review log to understand what has already been approved, rejected, overridden, or promoted before making the next decision.",
  },
};

export function EstimateWorkbenchDetailPane({
  activePanel,
  workflow,
}: {
  activePanel: WorkbenchPanelId;
  workflow: EstimatingWorkflowState;
}) {
  const reviewReady = workflow.summary.pricing.readyToPromote;

  return (
    <aside className="rounded-lg border bg-background">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">{PANEL_COPY[activePanel].title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{PANEL_COPY[activePanel].body}</p>
      </div>

      <div className="space-y-4 px-4 py-4 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Queued for OCR</div>
          <div className="mt-1 text-xl font-semibold">{workflow.summary.documents.queued}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Pending extraction review</div>
          <div className="mt-1 text-xl font-semibold">{workflow.summary.extractions.pending}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Review-ready pricing</div>
          <div className="mt-1 text-xl font-semibold">{reviewReady}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {workflow.promotionReadiness.canPromote
              ? "At least one generation run can be promoted."
              : "No approved pricing run is ready for promotion yet."}
          </div>
        </div>
      </div>
    </aside>
  );
}
