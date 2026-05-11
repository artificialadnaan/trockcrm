import { useMemo } from "react";
import { Calendar, Clock3, FileText, Mail, Phone, MessageSquare } from "lucide-react";
import { useActivities, type Activity } from "@/hooks/use-activities";

interface LeadTimelineTabProps {
  leadId: string;
  convertedDealId?: string | null;
  convertedAt?: string | null;
}

const ACTIVITY_ICONS: Record<string, typeof Phone> = {
  call: Phone,
  email: Mail,
  note: FileText,
  meeting: Calendar,
  task_completed: MessageSquare,
};

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function getStageChangeText(activity: Activity) {
  const actor = activity.performedByUserName ?? activity.responsibleUserName ?? "Someone";
  const body = activity.body?.trim();
  if (!body) {
    return activity.subject ?? `${actor} moved this lead`;
  }

  return `${actor} ${body.replace(/^Moved/, "moved").replace(/\.$/, "")}`;
}

function ActivityList({
  title,
  items,
  emptyMessage,
}: {
  title: string;
  items: Activity[];
  emptyMessage: string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
        <span className="text-xs text-muted-foreground">({items.length})</span>
      </div>
      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((activity) => {
            const isStageChange = activity.outcome === "lead_stage_changed";
            const Icon = isStageChange ? Clock3 : ACTIVITY_ICONS[activity.type] ?? FileText;
            const actorName = activity.performedByUserName ?? activity.responsibleUserName ?? "Unknown User";
            const actorAvatarUrl = activity.performedByUserAvatarUrl ?? activity.responsibleUserAvatarUrl ?? null;
            return (
              <div key={activity.id} className="rounded-lg border bg-white p-3">
                <div className="flex items-start gap-3">
                  <div
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-100 text-xs font-semibold text-slate-700"
                    aria-label={actorName}
                  >
                    {actorAvatarUrl ? (
                      <img src={actorAvatarUrl} alt="" className="h-full w-full object-cover" />
                    ) : isStageChange ? (
                      getInitials(actorName)
                    ) : (
                      <Icon className="h-4 w-4 text-slate-600" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium capitalize">
                        {isStageChange ? "Stage change" : activity.type.replace(/_/g, " ")}
                      </span>
                    </div>
                    {isStageChange ? (
                      <p className="text-sm">{getStageChangeText(activity)}</p>
                    ) : activity.subject ? (
                      <p className="text-sm">{activity.subject}</p>
                    ) : null}
                    {!isStageChange && activity.body && (
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                        {activity.body}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      {formatTimestamp(activity.occurredAt)}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function LeadTimelineTab({ leadId, convertedDealId, convertedAt }: LeadTimelineTabProps) {
  const { activities, loading, error } = useActivities(
    convertedDealId ? { dealId: convertedDealId, limit: 100 } : { leadId, limit: 100 }
  );

  const split = useMemo(() => {
    if (!convertedAt) {
      return {
        leadActivities: activities,
        dealActivities: [] as typeof activities,
      };
    }

    const cutoff = new Date(convertedAt).getTime();
    return {
      leadActivities: activities.filter((activity) => new Date(activity.occurredAt).getTime() < cutoff),
      dealActivities: activities.filter((activity) => new Date(activity.occurredAt).getTime() >= cutoff),
    };
  }, [activities, convertedAt]);

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="h-20 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  if (split.leadActivities.length === 0 && split.dealActivities.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Clock3 className="mx-auto mb-3 h-10 w-10 opacity-30" />
        <p className="text-lg font-medium">No Lead Activity Yet</p>
        <p className="text-sm mt-1">Calls, emails, notes, and meetings will appear here as the lead develops.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-amber-50/50 p-4 text-sm text-amber-900">
        Pre-RFP activity stays visible here when the lead converts into a deal.
      </div>

      <ActivityList
        title="Lead Activity"
        items={split.leadActivities}
        emptyMessage="No pre-RFP activity recorded yet."
      />

      {convertedAt && (
        <ActivityList
          title="Post-Conversion Activity"
          items={split.dealActivities}
          emptyMessage="No post-conversion activity recorded yet."
        />
      )}
    </div>
  );
}
