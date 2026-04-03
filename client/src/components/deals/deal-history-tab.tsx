import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DealStageBadge } from "./deal-stage-badge";
import { formatDate } from "@/lib/deal-utils";
import type { DealDetail } from "@/hooks/use-deals";
import {
  ArrowRight,
  ArrowLeft,
  Shield,
  Clock,
} from "lucide-react";

interface DealHistoryTabProps {
  deal: DealDetail;
}

export function DealHistoryTab({ deal }: DealHistoryTabProps) {
  if (deal.stageHistory.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Clock className="h-12 w-12 mx-auto mb-3 opacity-30" />
        <p>No stage history yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {deal.stageHistory.map((entry) => (
        <Card key={entry.id}>
          <CardContent className="py-3 px-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                {entry.fromStageId ? (
                  <>
                    <DealStageBadge stageId={entry.fromStageId} />
                    {entry.isBackwardMove ? (
                      <ArrowLeft className="h-4 w-4 text-orange-500" />
                    ) : (
                      <ArrowRight className="h-4 w-4 text-green-500" />
                    )}
                    <DealStageBadge stageId={entry.toStageId} />
                  </>
                ) : (
                  <>
                    <span className="text-sm text-muted-foreground">Created in</span>
                    <DealStageBadge stageId={entry.toStageId} />
                  </>
                )}

                {entry.isBackwardMove && (
                  <Badge variant="outline" className="bg-orange-100 text-orange-700 border-orange-200 text-xs">
                    Backward
                  </Badge>
                )}
                {entry.isDirectorOverride && (
                  <Badge variant="outline" className="bg-red-100 text-red-700 border-red-200 text-xs">
                    <Shield className="h-3 w-3 mr-1" />
                    Override
                  </Badge>
                )}
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {formatDate(entry.createdAt)}
              </span>
            </div>

            {entry.overrideReason && (
              <p className="text-sm text-muted-foreground mt-2 ml-1 italic">
                Override reason: {entry.overrideReason}
              </p>
            )}

            {entry.durationInPreviousStage && (
              <p className="text-xs text-muted-foreground mt-1 ml-1">
                Time in previous stage: {entry.durationInPreviousStage}
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
