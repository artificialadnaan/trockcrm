import { useNavigate } from "react-router-dom";
import { useDraggable } from "@dnd-kit/core";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  formatCurrencyCompact,
  bestEstimate,
  daysInStage,
  winProbabilityColor,
} from "@/lib/deal-utils";
import type { Deal } from "@/hooks/use-deals";
import { Clock, MapPin, GripVertical } from "lucide-react";

interface DealCardProps {
  deal: Deal;
  isDragging?: boolean;
}

export function DealCard({ deal, isDragging }: DealCardProps) {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: deal.id,
    data: { deal },
  });

  const style = transform
    ? {
        transform: `translate(${transform.x}px, ${transform.y}px)`,
        zIndex: 50,
      }
    : undefined;

  const days = daysInStage(deal.stageEnteredAt);

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={`p-3 cursor-pointer transition-shadow ${
        isDragging ? "shadow-lg opacity-75" : "hover:shadow-md"
      }`}
      onClick={() => navigate(`/deals/${deal.id}`)}
    >
      <div className="flex items-start gap-2">
        <button
          {...attributes}
          {...listeners}
          className="mt-0.5 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-4 w-4" />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1 mb-1">
            <span className="text-[10px] text-muted-foreground font-mono">
              {deal.dealNumber}
            </span>
            <span className="text-sm font-semibold">
              {formatCurrencyCompact(bestEstimate(deal))}
            </span>
          </div>
          <p className="text-sm font-medium truncate">{deal.name}</p>
          <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-0.5">
              <Clock className="h-3 w-3" />
              {days}d
            </span>
            {deal.propertyCity && (
              <span className="flex items-center gap-0.5 truncate">
                <MapPin className="h-3 w-3" />
                {deal.propertyCity}
              </span>
            )}
            {deal.winProbability != null && (
              <Badge
                variant="outline"
                className={`${winProbabilityColor(deal.winProbability)} text-[10px] px-1 py-0`}
              >
                {deal.winProbability}%
              </Badge>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
