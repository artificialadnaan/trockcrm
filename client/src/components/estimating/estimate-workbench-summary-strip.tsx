import { Badge } from "@/components/ui/badge";
import {
  formatEstimateResolutionLevel,
  getEstimateRerunLabel,
} from "./estimate-market-override-panel";
import type { EstimatingWorkflowState } from "./estimating-workflow-shell";

export function EstimateWorkbenchSummaryStrip({
  workflow,
}: {
  workflow: EstimatingWorkflowState;
}) {
  const reviewReady = workflow.summary.pricing.readyToPromote > 0 || workflow.promotionReadiness.canPromote;
  const rerunStatus = workflow.rerunStatus?.status ?? "idle";
  const rerunLabel = getEstimateRerunLabel(workflow.rerunStatus ?? null);
  const marketName = workflow.marketContext?.effectiveMarket?.name ?? "No market";
  const marketDetail = workflow.marketContext?.isOverridden
    ? "Override active"
    : workflow.marketContext
      ? `Auto-detected · ${formatEstimateResolutionLevel(workflow.marketContext.resolutionLevel)}`
      : "No market context";

  return (
    <section className="rounded-lg border bg-background">
      <div className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Estimator Workbench
          </h2>
          <p className="text-sm text-foreground">
            {workflow.summary.documents.total} source docs, {workflow.summary.extractions.total} extracted rows,{" "}
            {workflow.summary.pricing.readyToPromote} review-ready pricing items.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={reviewReady ? "secondary" : "outline"}>
            {reviewReady ? "Review-ready" : "Needs review"}
          </Badge>
          <Badge variant={rerunStatus === "failed" ? "destructive" : "outline"}>{rerunLabel}</Badge>
        </div>
      </div>

      <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-5">
        <SummaryCell label="Documents" value={`${workflow.summary.documents.total} source docs`} detail={`${workflow.summary.documents.queued} OCR queued`} />
        <SummaryCell label="Extraction" value={`${workflow.summary.extractions.pending} pending`} detail={`${workflow.summary.extractions.approved} approved`} />
        <SummaryCell label="Catalog Match" value={`${workflow.summary.matches.suggested} suggested`} detail={`${workflow.summary.matches.selected} selected`} />
        <SummaryCell label="Draft Pricing" value={`${workflow.summary.pricing.pending} pending`} detail={`${workflow.summary.pricing.readyToPromote} ready to promote`} />
        <SummaryCell label="Market" value={marketName} detail={`${marketDetail} · ${rerunLabel}`} />
      </div>
    </section>
  );
}

function SummaryCell({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="bg-background px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-medium">{value}</div>
      <div className="text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}
