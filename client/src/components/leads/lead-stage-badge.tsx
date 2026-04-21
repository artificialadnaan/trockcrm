import { Badge } from "@/components/ui/badge";
import { usePipelineStages } from "@/hooks/use-pipeline-config";

interface LeadStageBadgeProps {
  stageId: string;
  className?: string;
  converted?: boolean;
}

export function LeadStageBadge({ stageId, className, converted = false }: LeadStageBadgeProps) {
  const { stages } = usePipelineStages();
  const stage = stages.find((item) => item.id === stageId);

  if (!stage) {
    return <Badge variant="outline" className={className}>Lead</Badge>;
  }

  const isLeadStage = stage.workflowFamily === "lead";
  const label = isLeadStage
    ? stage.name
    : converted
      ? `Converted · ${stage.name}`
      : stage.name;

  const colorClass = isLeadStage
    ? "bg-amber-100 text-amber-800 border-amber-200"
    : "bg-slate-100 text-slate-700 border-slate-200";

  return (
    <Badge variant="outline" className={`${colorClass} ${className ?? ""}`.trim()}>
      {label}
    </Badge>
  );
}
