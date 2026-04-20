import { EstimateCatalogMatchTable } from "./estimate-catalog-match-table";
import { EstimateCopilotPanel } from "./estimate-copilot-panel";
import { EstimateDocumentsPanel } from "./estimate-documents-panel";
import { EstimateExtractionReviewTable } from "./estimate-extraction-review-table";
import { EstimateOverviewPanel } from "./estimate-overview-panel";
import { EstimatePricingReviewTable } from "./estimate-pricing-review-table";
import { EstimateReviewLogPanel } from "./estimate-review-log-panel";

export interface EstimatingWorkflowShellProps {
  dealId: string;
  documents: any[];
  extractionRows: any[];
  matchRows: any[];
  pricingRows: any[];
  reviewEvents: any[];
  copilotEnabled?: boolean;
}

export function EstimatingWorkflowShell(props: EstimatingWorkflowShellProps) {
  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-2 text-sm">
        {["Overview", "Documents", "Extraction", "Catalog Match", "Draft Pricing", "Estimate", "Copilot", "Review Log"].map((step) => (
          <div key={step} className="rounded-full border px-3 py-1">
            {step}
          </div>
        ))}
      </nav>

      <EstimateOverviewPanel dealId={props.dealId} />
      <EstimateDocumentsPanel dealId={props.dealId} documents={props.documents} />
      <EstimateExtractionReviewTable rows={props.extractionRows} />
      <EstimateCatalogMatchTable rows={props.matchRows} />
      <EstimatePricingReviewTable rows={props.pricingRows} />
      {props.copilotEnabled ? <EstimateCopilotPanel dealId={props.dealId} /> : null}
      <EstimateReviewLogPanel events={props.reviewEvents} />
    </div>
  );
}
