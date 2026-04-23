import { Badge } from "@/components/ui/badge";
import { usePipelineStages } from "@/hooks/use-pipeline-config";
import { Lock } from "lucide-react";
import { getDealStageMetadata } from "@/lib/pipeline-ownership";

interface DealStageBadgeProps {
  stageId: string;
  className?: string;
  readOnly?: boolean;
  ownership?: "crm" | "bid_board";
  showOwnership?: boolean;
  workflowRoute?: "normal" | "service";
  bidBoardStageSlug?: string | null;
}

// Fallback colors by stage slug
const STAGE_COLORS: Record<string, string> = {
  opportunity: "bg-emerald-50 text-emerald-700 border-emerald-200",
  estimate_in_progress: "bg-blue-100 text-blue-700 border-blue-200",
  service_estimating: "bg-slate-200 text-slate-700 border-slate-300",
  estimate_under_review: "bg-green-100 text-green-700 border-green-200",
  estimate_sent_to_client: "bg-orange-100 text-orange-700 border-orange-200",
  sent_to_production: "bg-cyan-50 text-cyan-700 border-cyan-200",
  service_sent_to_production: "bg-indigo-100 text-indigo-700 border-indigo-200",
  production_lost: "bg-red-100 text-red-700 border-red-200",
  service_lost: "bg-zinc-100 text-zinc-700 border-zinc-300",
};

export function DealStageBadge({
  stageId,
  className,
  readOnly = false,
  ownership,
  showOwnership = false,
  workflowRoute = "normal",
  bidBoardStageSlug = null,
}: DealStageBadgeProps) {
  const { stages } = usePipelineStages();
  const metadata = getDealStageMetadata(
    {
      stageId,
      workflowRoute,
      isBidBoardOwned: ownership === "bid_board" || readOnly,
      bidBoardStageSlug,
      readOnlySyncedAt: ownership === "bid_board" || readOnly ? "mirror" : null,
    },
    stages
  );
  const stage = metadata.stage;

  if (!stage) {
    return <Badge variant="outline" className={className}>Unknown</Badge>;
  }

  const colorClass = metadata.slug ? STAGE_COLORS[metadata.slug] ?? "bg-gray-100 text-gray-700 border-gray-200" : "bg-gray-100 text-gray-700 border-gray-200";
  const readOnlyClass = readOnly || ownership === "bid_board"
    ? "border-dashed bg-slate-100 text-slate-700 border-slate-300"
    : colorClass;
  const label = showOwnership && (readOnly || ownership === "bid_board")
    ? `${metadata.label} Mirror`
    : metadata.label;

  return (
    <Badge variant="outline" className={`${readOnlyClass} ${className ?? ""}`.trim()}>
      {(readOnly || ownership === "bid_board") && <Lock className="mr-1 h-3 w-3" />}
      {label}
    </Badge>
  );
}
