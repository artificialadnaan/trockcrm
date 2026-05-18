import { Calendar, CheckSquare, FileText, Mail, MapPinned, Phone, PhoneCall, SendHorizontal, Handshake } from "lucide-react";
import { ActivityLogForm } from "@/components/activities/activity-log-form";
import { RecordingList } from "@/components/call-recordings/recording-list";
import { createActivity, useActivities, type Activity, type ActivitySourceEntityType } from "@/hooks/use-activities";

type SupportedActivityEntity = Extract<ActivitySourceEntityType, "company" | "lead" | "deal">;

interface EntityActivityTabProps {
  entityType: SupportedActivityEntity;
  entityId: string;
  emptyLabel: string;
  showRecordings?: boolean;
}

const activityFilterKey: Record<SupportedActivityEntity, "companyId" | "leadId" | "dealId"> = {
  company: "companyId",
  lead: "leadId",
  deal: "dealId",
};

const activityLabels: Record<string, string> = {
  call: "Call",
  note: "Note",
  meeting: "Meeting",
  voicemail: "Voicemail",
  lunch: "Lunch",
  site_visit: "Site Visit",
  proposal_sent: "Proposal Sent",
  email: "Email",
  task_completed: "Task Completed",
};

const activityIcons: Record<string, typeof Phone> = {
  call: Phone,
  note: FileText,
  meeting: Calendar,
  voicemail: PhoneCall,
  lunch: Handshake,
  site_visit: MapPinned,
  proposal_sent: SendHorizontal,
  email: Mail,
  task_completed: CheckSquare,
};

function formatActivityDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildScopedPayload(entityType: SupportedActivityEntity, entityId: string) {
  return { [activityFilterKey[entityType]]: entityId };
}

export function EntityActivityTab({
  entityType,
  entityId,
  emptyLabel,
  showRecordings = false,
}: EntityActivityTabProps) {
  const scopedPayload = buildScopedPayload(entityType, entityId);
  const { activities, loading, error, refetch } = useActivities(scopedPayload);

  const handleLogActivity = async (data: {
    type: string;
    subject: string;
    body: string;
    outcome?: string;
    nextStep?: string;
    nextStepDueAt?: string;
    durationMinutes?: number;
    occurredAt?: string;
    responsibleUserId?: string;
  }) => {
    await createActivity({
      type: data.type,
      subject: data.subject,
      body: data.body,
      outcome: data.outcome,
      nextStep: data.nextStep,
      nextStepDueAt: data.nextStepDueAt,
      durationMinutes: data.durationMinutes,
      occurredAt: data.occurredAt,
      responsibleUserId: entityType === "deal" ? undefined : data.responsibleUserId,
      ...scopedPayload,
    });
    await refetch();
  };

  return (
    <div className="space-y-4">
      {showRecordings ? <RecordingList entityType={entityType} entityId={entityId} /> : null}
      <ActivityLogForm onSubmit={handleLogActivity} showProposalSent={entityType === "deal"} />

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      ) : error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : activities.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No activities logged for this {emptyLabel} yet.
        </p>
      ) : (
        <div className="space-y-2">
          {activities.map((activity: Activity) => {
            const Icon = activityIcons[activity.type] ?? FileText;
            return (
              <div key={activity.id} className="flex items-start gap-3 rounded-md border bg-white px-3 py-2.5">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      {activityLabels[activity.type] ?? activity.type.replace(/_/g, " ")}
                    </span>
                    {activity.outcome ? (
                      <span className="text-xs capitalize text-muted-foreground">
                        ({activity.outcome.replace(/_/g, " ")})
                      </span>
                    ) : null}
                    {activity.durationMinutes != null ? (
                      <span className="text-xs text-muted-foreground">
                        {activity.durationMinutes} min
                      </span>
                    ) : null}
                  </div>
                  {activity.body ? (
                    <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                      {activity.body}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatActivityDate(activity.occurredAt)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
