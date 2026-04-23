import { Badge } from "@/components/ui/badge";
import { usePipelineStages } from "@/hooks/use-pipeline-config";
import { getLeadStageMetadata } from "@/hooks/use-leads";

interface LeadStageBadgeProps {
  stageId: string;
  className?: string;
  converted?: boolean;
}

export function LeadStageBadge({ stageId, className, converted = false }: LeadStageBadgeProps) {
  const { stages } = usePipelineStages();
  const metadata = getLeadStageMetadata(stageId, stages);
  const stage = metadata.stage;

  if (!stage) {
    return <Badge variant="outline" className={className}>Lead</Badge>;
  }

  const label = converted && metadata.isOpportunityStage ? "Converted · Opportunity" : metadata.label;

  const colorClass = metadata.slug === "new_lead"
    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : metadata.slug === "qualified_lead"
      ? "bg-sky-50 text-sky-700 border-sky-200"
      : metadata.slug === "sales_validation_stage"
        ? "bg-amber-50 text-amber-800 border-amber-200"
        : metadata.slug === "opportunity"
          ? "bg-slate-100 text-slate-700 border-slate-200"
          : "bg-slate-100 text-slate-700 border-slate-200";

  return (
    <Badge variant="outline" className={`${colorClass} ${className ?? ""}`.trim()}>
      {label}
    </Badge>
  );
}
