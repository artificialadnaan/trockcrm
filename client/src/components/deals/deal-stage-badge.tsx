import { Badge } from "@/components/ui/badge";
import { usePipelineStages } from "@/hooks/use-pipeline-config";

interface DealStageBadgeProps {
  stageId: string;
  className?: string;
}

// Fallback colors by stage slug
const STAGE_COLORS: Record<string, string> = {
  dd: "bg-slate-100 text-slate-700 border-slate-200",
  estimating: "bg-blue-100 text-blue-700 border-blue-200",
  bid_sent: "bg-indigo-100 text-indigo-700 border-indigo-200",
  in_production: "bg-amber-100 text-amber-700 border-amber-200",
  close_out: "bg-purple-100 text-purple-700 border-purple-200",
  closed_won: "bg-green-100 text-green-700 border-green-200",
  closed_lost: "bg-red-100 text-red-700 border-red-200",
};

export function DealStageBadge({ stageId, className }: DealStageBadgeProps) {
  const { stages } = usePipelineStages();
  const stage = stages.find((s) => s.id === stageId);

  if (!stage) {
    return <Badge variant="outline" className={className}>Unknown</Badge>;
  }

  const colorClass = STAGE_COLORS[stage.slug] ?? "bg-gray-100 text-gray-700 border-gray-200";

  return (
    <Badge variant="outline" className={`${colorClass} ${className ?? ""}`}>
      {stage.name}
    </Badge>
  );
}
