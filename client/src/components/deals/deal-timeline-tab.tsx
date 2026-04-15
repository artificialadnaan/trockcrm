import { useMemo } from "react";
import { Clock3, CheckSquare, Mail, Phone, FileText, Calendar, GitBranch } from "lucide-react";
import { useActivities } from "@/hooks/use-activities";
import { DealStageBadge } from "./deal-stage-badge";

interface DealTimelineTabProps {
  dealId: string;
  stageHistory: Array<{
    id: string;
    fromStageId: string | null;
    toStageId: string;
    changedBy: string;
    isBackwardMove: boolean;
    isDirectorOverride: boolean;
    overrideReason: string | null;
    durationInPreviousStage: string | null;
    createdAt: string;
  }>;
}

const activityIcons: Record<string, typeof Phone> = {
  call: Phone,
  email: Mail,
  note: FileText,
  meeting: Calendar,
  task_completed: CheckSquare,
};

const sourceEntityLabels: Record<string, string> = {
  deal: "Deal",
  lead: "Lead history",
  company: "Company",
  property: "Property",
  contact: "Contact",
};

function formatTimestamp(date: string): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function DealTimelineTab({ dealId, stageHistory }: DealTimelineTabProps) {
  const { activities, loading, error } = useActivities({ dealId, limit: 100 });

  const items = useMemo(() => {
    const activityItems = activities.map((activity) => ({
      id: `activity-${activity.id}`,
      createdAt: activity.occurredAt ?? activity.createdAt,
      kind: "activity" as const,
      payload: activity,
    }));

    const historyItems = stageHistory.map((entry) => ({
      id: `stage-${entry.id}`,
      createdAt: entry.createdAt,
      kind: "stage" as const,
      payload: entry,
    }));

    return [...activityItems, ...historyItems].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [activities, stageHistory]);

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-20 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Clock3 className="h-12 w-12 mx-auto mb-3 opacity-30" />
        <p className="text-lg font-medium">No Timeline Events Yet</p>
        <p className="text-sm mt-1">
          Stage changes, emails, calls, meetings, and notes will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        if (item.kind === "stage") {
          const entry = item.payload;
          return (
            <div key={item.id} className="rounded-lg border bg-white p-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-slate-100">
                  <GitBranch className="h-4 w-4 text-slate-600" />
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      {entry.isBackwardMove ? "Stage Moved Backward" : "Stage Changed"}
                    </span>
                    {entry.isDirectorOverride && (
                      <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                        Director Override
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {entry.fromStageId ? <DealStageBadge stageId={entry.fromStageId} /> : <span className="text-xs text-muted-foreground">Created</span>}
                    <span className="text-xs text-muted-foreground">to</span>
                    <DealStageBadge stageId={entry.toStageId} />
                  </div>
                  {entry.overrideReason && (
                    <p className="text-sm text-muted-foreground">
                      Override reason: {entry.overrideReason}
                    </p>
                  )}
                  {entry.durationInPreviousStage && (
                    <p className="text-xs text-muted-foreground">
                      Time in previous stage: {entry.durationInPreviousStage}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {formatTimestamp(entry.createdAt)}
                  </p>
                </div>
              </div>
            </div>
          );
        }

        const activity = item.payload;
        const Icon = activityIcons[activity.type] ?? FileText;

        return (
          <div key={item.id} className="rounded-lg border bg-white p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-slate-100">
                <Icon className="h-4 w-4 text-slate-600" />
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium capitalize">
                    {activity.type.replace(/_/g, " ")}
                  </span>
                  {activity.sourceEntityType && (
                    <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                      {sourceEntityLabels[activity.sourceEntityType] ?? activity.sourceEntityType}
                    </span>
                  )}
                  {activity.outcome && (
                    <span className="text-xs text-muted-foreground capitalize">
                      {activity.outcome.replace(/_/g, " ")}
                    </span>
                  )}
                  {activity.durationMinutes != null && (
                    <span className="text-xs text-muted-foreground">
                      {activity.durationMinutes} min
                    </span>
                  )}
                </div>
                {activity.subject && (
                  <p className="text-sm">{activity.subject}</p>
                )}
                {activity.body && (
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                    {activity.body}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  {formatTimestamp(item.createdAt)}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export type { DealTimelineTabProps };
