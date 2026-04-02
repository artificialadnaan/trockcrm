import { Phone, FileText, Calendar, Mail, CheckSquare } from "lucide-react";
import { ActivityLogForm } from "@/components/activities/activity-log-form";
import { useActivities, createContactActivity } from "@/hooks/use-activities";
import type { Activity } from "@/hooks/use-activities";

interface ContactActivityTabProps {
  contactId: string;
}

const typeIcons: Record<string, typeof Phone> = {
  call: Phone,
  note: FileText,
  meeting: Calendar,
  email: Mail,
  task_completed: CheckSquare,
};

const typeLabels: Record<string, string> = {
  call: "Call",
  note: "Note",
  meeting: "Meeting",
  email: "Email",
  task_completed: "Task Completed",
};

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ContactActivityTab({ contactId }: ContactActivityTabProps) {
  const { activities, loading, refetch } = useActivities({ contactId });

  const handleLogActivity = async (data: {
    type: string;
    subject: string;
    body: string;
    outcome?: string;
    durationMinutes?: number;
  }) => {
    await createContactActivity(contactId, {
      type: data.type,
      subject: data.subject,
      body: data.body,
      outcome: data.outcome,
      durationMinutes: data.durationMinutes,
    });
    refetch();
  };

  return (
    <div className="space-y-4">
      <ActivityLogForm onSubmit={handleLogActivity} />

      {/* Activity Feed */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-muted animate-pulse rounded-md" />
          ))}
        </div>
      ) : activities.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground text-sm">
          No activity recorded yet. Use the buttons above to log a call, note, or meeting.
        </div>
      ) : (
        <div className="space-y-2">
          {activities.map((activity: Activity) => {
            const IconComponent = typeIcons[activity.type] ?? FileText;
            return (
              <div
                key={activity.id}
                className="flex items-start gap-3 px-3 py-2.5 rounded-md border bg-white"
              >
                <div className="mt-0.5 h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                  <IconComponent className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {typeLabels[activity.type] ?? activity.type}
                    </span>
                    {activity.outcome && (
                      <span className="text-xs text-muted-foreground capitalize">
                        ({activity.outcome.replace(/_/g, " ")})
                      </span>
                    )}
                    {activity.durationMinutes != null && (
                      <span className="text-xs text-muted-foreground">
                        {activity.durationMinutes} min
                      </span>
                    )}
                  </div>
                  {activity.body && (
                    <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">
                      {activity.body}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground mt-1">
                    {formatDate(activity.occurredAt)}
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
