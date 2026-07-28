import { useState } from "react";
import { Calendar, CalendarClock, CheckSquare, FileText, Mail, MapPinned, Phone, PhoneCall, SendHorizontal, Handshake } from "lucide-react";
import { ActivityLogForm } from "@/components/activities/activity-log-form";
import { RecordingList } from "@/components/call-recordings/recording-list";
import { Button } from "@/components/ui/button";
import { MoveCloseDateDialog } from "@/components/deals/move-close-date-dialog";
import { createActivity, useActivities, type Activity, type ActivitySourceEntityType } from "@/hooks/use-activities";

/**
 * `property` joins the list because field prospecting logs a site visit against the BUILDING, and its
 * tab was a "coming soon" placeholder — so every capture a rep made landed in a table no office screen
 * read. The server already answered `GET /activities?propertyId=` and the hook already took the filter;
 * only this union and the map below excluded it.
 */
type SupportedActivityEntity = Extract<
  ActivitySourceEntityType,
  "company" | "lead" | "deal" | "property"
>;

interface EntityActivityTabProps {
  entityType: SupportedActivityEntity;
  entityId: string;
  emptyLabel: string;
  showRecordings?: boolean;
  /** Deal-only: the current expected_close_date ("YYYY-MM-DD"), used to seed the Move Close Date picker. */
  closeTargetDate?: string | null;
  /** Deal-only: the deal sits in the genuine estimating stage, where the SLA follows the BID due date, so
   *  the Move Close Date dialog must not promise an SLA pause it cannot deliver (2026-07-28). */
  slaFollowsBidDueDate?: boolean;
  /** Deal-only: called after the close date moves so the host can refetch the deal (the SLA badge). */
  onDealChanged?: () => void | Promise<void>;
  /** Deal-only: whether the viewer may edit the deal (assigned rep or admin). Gates the Move Close Date
   *  action so a view-only collaborator doesn't hit a 403 after filling the dialog. Default false. */
  canMoveCloseDate?: boolean;
  /**
   * Hide the log FORM and show the feed only.
   *
   * A soft-deleted record still resolves on its detail route, and the surrounding page treats it as
   * read-only — but this tab mounted a writable form regardless, and POST /activities does not check
   * whether the target is active. So opening Activity on a deleted property let notes, calls and site
   * visits be written against it, where nothing lists them.
   */
  readOnly?: boolean;
  /** Deal-only: the office the deal was read from (cross-office detail). Threaded into the Move Close
   *  Date PATCH so a cross-office move/clear targets the deal's tenant, not the viewer's active office. */
  officeId?: string | null;
}

/**
 * The marker the field app writes into `nextStep` when a rep flags a prospect worth a lead.
 *
 * Matched as a PREFIX because the app keeps the rep's own next step alongside it — one column holds
 * both ("Create lead — Call Dana Monday"), so an exact comparison would miss every flag that carried a
 * note, which is most of them.
 */
const LEAD_FLAG_PREFIX = "Create lead";

/**
 * A due DATE, rendered without a timezone shift.
 *
 * ActivityLogForm's `type="date"` input sends "YYYY-MM-DD", which the server stores as midnight UTC.
 * Running that through the activity timestamp formatter applies the browser's zone, so every user west
 * of UTC saw the PREVIOUS calendar day — a 28 July due date reading as 27 July, plus a 7:00 PM that
 * means nothing. Read the calendar parts back in UTC and show only the date.
 */
function formatDueDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function isLeadFlagged(activity: Pick<Activity, "nextStep">): boolean {
  const next = activity.nextStep?.trim();
  if (!next) return false;
  if (next === LEAD_FLAG_PREFIX) return true;
  /**
   * A BOUNDARY after the marker, because nextStep is free text.
   *
   * A bare prefix test badged "Create leadership deck" as a prospect flag on every activity tab in the
   * app. The field app writes either the marker alone or the marker, a space-padded em dash, and the
   * rep's own note — so anything else that merely starts with those characters is a different
   * sentence.
   */
  return next.startsWith(`${LEAD_FLAG_PREFIX} — `);
}

const activityFilterKey: Record<
  SupportedActivityEntity,
  "companyId" | "leadId" | "dealId" | "propertyId"
> = {
  company: "companyId",
  lead: "leadId",
  deal: "dealId",
  property: "propertyId",
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
  readOnly = false,
  showRecordings = false,
  closeTargetDate = null,
  slaFollowsBidDueDate,
  onDealChanged,
  canMoveCloseDate = false,
  officeId = null,
}: EntityActivityTabProps) {
  const scopedPayload = buildScopedPayload(entityType, entityId);
  const { activities, loading, error, refetch } = useActivities(scopedPayload);
  const [moveCloseDateOpen, setMoveCloseDateOpen] = useState(false);

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
      {/* Recordings attach to a person or a deal, never to a BUILDING — RecordingList's own union says
          so. Narrowed here rather than widened there: a property has no call to record. */}
      {showRecordings && entityType !== "property" ? (
        <RecordingList entityType={entityType} entityId={entityId} />
      ) : null}
      {readOnly ? null : (
      <ActivityLogForm
        onSubmit={handleLogActivity}
        showProposalSent={entityType === "deal"}
        extraActions={
          entityType === "deal" && canMoveCloseDate ? (
            <Button size="sm" variant="outline" onClick={() => setMoveCloseDateOpen(true)}>
              <CalendarClock className="h-4 w-4 mr-1" /> Move Close Date
            </Button>
          ) : undefined
        }
      />
      )}
      {entityType === "deal" && canMoveCloseDate ? (
        <MoveCloseDateDialog
          open={moveCloseDateOpen}
          onOpenChange={setMoveCloseDateOpen}
          dealId={entityId}
          currentDate={closeTargetDate}
          slaFollowsBidDueDate={slaFollowsBidDueDate}
          officeId={officeId}
          onSaved={async () => {
            await refetch();
            await onDealChanged?.();
          }}
        />
      ) : null}

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
                    {/* The FLAG a rep sets in the field on a prospect worth a lead. It was written to
                        nextStep and rendered by nothing, anywhere — so the marker existed and no office
                        surface showed it, which made the whole "flag it and the office picks it up"
                        handoff invisible. */}
                    {isLeadFlagged(activity) ? (
                      <span
                        data-testid="activity-lead-flag"
                        className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900"
                      >
                        Worth a lead
                      </span>
                    ) : null}
                  </div>
                  {activity.body ? (
                    <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                      {activity.body}
                    </p>
                  ) : null}
                  {/* The rep's own next step, flagged or not — it is what they wrote down for whoever
                      picks this up, and it was not shown at all. */}
                  {activity.nextStep ? (
                    <p className="mt-1 text-xs text-muted-foreground" data-testid="activity-next-step">
                      <span className="font-medium">Next: </span>
                      {activity.nextStep}
                      {activity.nextStepDueAt ? ` (due ${formatDueDate(activity.nextStepDueAt)})` : ""}
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
