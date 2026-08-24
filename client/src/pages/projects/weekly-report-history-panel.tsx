import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarClock, Loader2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  weeklyReportRetryDuplicateRiskPrompt,
  weeklyReportRetryIsProviderDeduped,
} from "@trock-crm/shared/lib/weeklyReportEmail";
import {
  isWeeklyReportDeliveryStatus,
  weeklyReportDeliveryFailed,
  weeklyReportDeliveryLabel,
  type WeeklyReportBounceClass,
} from "@trock-crm/shared/lib/weeklyReportDelivery";
import {
  createWeeklyReportCorrection,
  fetchWeeklyReportDetail,
  retryWeeklyReportSend,
  useWeeklyReportHistory,
  useWeeklyReportProjects,
  type WeeklyReportDetail,
  type WeeklyReportHistoryEntry,
  type WeeklyReportProject,
} from "@/hooks/use-weekly-reports";
import { WeeklyReportDeleteDialog } from "./weekly-report-delete-dialog";
import { WeeklyReportEditDialog } from "./weekly-report-edit-dialog";

const STATUS_BADGE: Record<string, string> = {
  draft: "border-amber-200 bg-amber-50 text-amber-700",
  pending_review: "border-blue-200 bg-blue-50 text-blue-700",
  approved: "border-violet-200 bg-violet-50 text-violet-700",
  sent: "border-emerald-200 bg-emerald-50 text-emerald-700",
};
const STATUS_LABEL: Record<string, string> = {
  draft: "With super",
  pending_review: "Pending PM review",
  approved: "Approved, not sent",
  sent: "Sent",
};

function fmtWeek(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

/**
 * An instant, in the reader's own zone — unlike `fmtWeek`, which pins to UTC.
 *
 * The difference is deliberate and it is not a style choice. `week_of` is a plain calendar date with no
 * time in it, so reading it locally would slide it to the previous day for anyone west of Greenwich.
 * These are true timestamps of things people did, and "who approved this, and when" is answered in the
 * zone the person asking is standing in.
 */
function fmtStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function WeeklyReportHistoryPanel({
  projects,
  refreshSignal,
  onSend,
  onChanged,
}: {
  projects: WeeklyReportProject[];
  /** Incremented by the page's Refresh button. This panel's request belongs to no one else. */
  refreshSignal: number;
  /** Opens the page-level send modal. One dialog for the whole page, not a second copy in here. */
  onSend: (reportId: string) => void;
  /** Fired after a correction is created, so the board picks up the new version. */
  onChanged: () => void;
}) {
  const [projectId, setProjectId] = useState<string>("");

  /**
   * REPORTS UNDER A STOPPED SETUP, which this selector could not otherwise reach.
   *
   * "Stop reporting" soft-deletes the setup row, and `listWeeklyReportProjects` filters `wrp.is_active`
   * — so the setup leaves the `projects` prop and takes every report under it with it. Those reports
   * stay readable and deletable on purpose (the delete deliberately opts out of the project's
   * `is_active` filter, because a stopped setup is exactly where leftover test data comes to rest), and
   * without this there was no way to select one. Opt-in, and not fetched until it is asked for: the tab
   * is live work by default.
   */
  const [showStopped, setShowStopped] = useState(false);
  const { projects: withStopped } = useWeeklyReportProjects({
    includeInactive: true,
    enabled: showStopped,
  });
  const selectable = showStopped ? withStopped : projects;

  // Default to the first project once the list arrives, so the tab isn't an empty prompt on open.
  //
  // AND FALL BACK when the selected one leaves the list — which is what unticking "include stopped
  // setups" does to a stopped project. A `<select>` bound to a value none of its options carry renders
  // blank, and the table under it empties, with nothing on screen saying why.
  useEffect(() => {
    if (selectable.length === 0) return;
    if (!projectId || !selectable.some((p) => p.id === projectId)) setProjectId(selectable[0]!.id);
  }, [selectable, projectId]);

  const { reports, loading, error, refetch } = useWeeklyReportHistory(projectId || null);
  const [detail, setDetail] = useState<WeeklyReportDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  // ONE dialog for the whole table, holding the row it was opened from — not a dialog per row. Fifty-two
  // weeks of a job is fifty-two mounted forms otherwise, each with its own state.
  const [editing, setEditing] = useState<WeeklyReportHistoryEntry | null>(null);
  const [deleting, setDeleting] = useState<WeeklyReportHistoryEntry | null>(null);

  // Re-run the history request when the page refreshes, but NOT on mount — the hook already loads on
  // mount and on every project change, so an unguarded effect would fire a second, identical request
  // alongside the first and let whichever answered last win.
  const lastRefreshSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === lastRefreshSignal.current) return;
    lastRefreshSignal.current = refreshSignal;
    void refetch();
  }, [refreshSignal, refetch]);

  const selected = useMemo(
    () => selectable.find((p) => p.id === projectId) ?? null,
    [selectable, projectId],
  );

  // The highest live version per week. "Send correction" is offered on the newest version of a week and
  // nowhere else: a report is only marked superseded when its replacement is SENT, so a PM who drafts a
  // v2 and comes back to the same v1 row would otherwise be offered the button a second time and get a
  // v3 nobody wanted. The server refuses that outright; this stops the UI inviting it.
  const latestVersionByWeek = useMemo(() => {
    const highest = new Map<string, number>();
    for (const report of reports) {
      highest.set(report.weekOf, Math.max(highest.get(report.weekOf) ?? 0, report.version));
    }
    return highest;
  }, [reports]);

  const openDetail = async (reportId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      setDetail(await fetchWeeklyReportDetail(reportId));
    } catch (error) {
      // Previously there was no catch at all, so a failed load left `detail` null and `detailLoading`
      // false — which is the sheet's own closed state. The panel opened, flashed, and shut with no
      // message, and from the outside that is indistinguishable from View not being wired up.
      setDetailError(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setDetailLoading(false);
    }
  };

  if (projects.length === 0) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white p-6 text-[13.5px] font-semibold text-slate-500">
        <CalendarClock className="h-4 w-4 text-slate-400" />
        Add a weekly report project first — history appears here once reports start going out.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
        <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Project</span>
        <select
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          aria-label="Project"
          className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[13px] font-semibold text-slate-700"
        >
          {selectable.map((project) => (
            <option key={project.id} value={project.id}>
              {project.propertyDisplayName ?? project.dealName ?? "Untitled project"}
              {/* MARKED, not merely listed. A stopped job shown identically to a live one reads as
                  though reporting were still running on it. */}
              {project.isActive === false ? " · stopped" : ""}
            </option>
          ))}
        </select>
        {selected?.clientName && (
          <span className="text-[12.5px] font-semibold text-slate-500">for {selected.clientName}</span>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-[12.5px] font-semibold text-slate-500">
          <input
            type="checkbox"
            aria-label="Include stopped setups"
            checked={showStopped}
            onChange={(event) => setShowStopped(event.target.checked)}
            className="h-3.5 w-3.5 accent-brand-red"
          />
          Include stopped setups
        </label>
      </div>

      {loading ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white p-6 text-[13.5px] font-semibold text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> Loading history…
        </div>
      ) : error ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white p-6 text-[13.5px] font-semibold text-slate-500">
          <AlertTriangle className="h-4 w-4 text-brand-red" /> {error}
        </div>
      ) : reports.length === 0 ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white p-6 text-[13.5px] font-semibold text-slate-500">
          <CalendarClock className="h-4 w-4 text-slate-400" /> No reports yet for this project.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full border-collapse text-[13.5px]">
            <thead className="border-b border-slate-200 bg-slate-50/70">
              <tr>
                <Th>Week of</Th>
                <Th>Status</Th>
                <Th>Author</Th>
                <Th className="text-right">Completion</Th>
                <Th className="text-right">Photos</Th>
                <Th className="text-right" />
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => (
                <tr key={report.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3.5 py-3 font-semibold text-slate-900">
                    {fmtWeek(report.weekOf)}
                    {report.version > 1 && (
                      <span className="ml-1.5 text-[10.5px] font-bold uppercase tracking-wide text-violet-600">
                        v{report.version}
                      </span>
                    )}
                  </td>
                  <td className="px-3.5 py-3">
                    <Badge variant="outline" className={`${STATUS_BADGE[report.status] ?? ""} whitespace-nowrap`}>
                      {STATUS_LABEL[report.status] ?? report.status}
                    </Badge>
                    {/* What the mail provider said AFTERWARDS. The "Sent" badge above means the PM
                        committed and the provider accepted; it has never meant the client received
                        anything, and a report addressed to a mistyped domain wears it just the same.
                        This line is the only place that difference is visible to a person. Rendered only
                        when a verdict exists — silence here means no webhook has spoken, which is
                        "unknown", and dressing that up as "Delivered" is the bug this whole feature is
                        about. */}
                    <DeliveryVerdict report={report} />
                  </td>
                  <td className="px-3.5 py-3 text-slate-600">{report.authoredByName ?? "—"}</td>
                  <td className="px-3.5 py-3 text-right tabular-nums text-slate-700">
                    {report.completionPercent == null ? "—" : `${report.completionPercent}%`}
                  </td>
                  <td className="px-3.5 py-3 text-right tabular-nums text-slate-500">{report.photos.length || "—"}</td>
                  <td className="px-3.5 py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => void openDetail(report.id)}
                        className="rounded-lg border border-slate-200 px-2.5 py-1 text-[12.5px] font-semibold text-slate-600 hover:border-brand-red hover:text-brand-red"
                      >
                        View
                      </button>
                      {report.status === "approved" && (
                        <Button size="sm" onClick={() => onSend(report.id)}>
                          Send
                        </Button>
                      )}
                      {/* A sent report the client has NOT been shown to have received needs its delivery
                          retrying, not a correction. Offered first, and prominently, because the obvious
                          button to reach for on a failed send used to be "Send correction" — which
                          creates a v2, takes the failure off the board, and leaves the client with
                          nothing at all if the PM is pulled away before finishing it.

                          `!report.supersededById` is the same predicate the board's undelivered query
                          uses, and it is load-bearing rather than cosmetic. v1 sent Monday and undelivered,
                          corrected, v2 sent and DELIVERED Tuesday leaves v1 `sent`, superseded, with
                          `send_delivered_at` still null and its stored request — share URL and all — still
                          on the row. Retrying it emails the client the version they were already told was
                          replaced, with `isCorrection: false` so nothing in the message says so, linking
                          to a page that then tells them their copy is out of date. The board is silent on
                          that row by construction; History was the one surface that offered the action.
                          The server and the worker each refuse it independently — this only stops the CRM
                          inviting it. */}
                      {report.status === "sent" && !report.sendDeliveredAt && !report.supersededById && (
                        <RetryButton
                          reportId={report.id}
                          sentAt={report.sentAt}
                          sendError={report.sendError}
                          onRetried={onChanged}
                        />
                      )}
                      {/* Only on the LIVE, NEWEST version. A report already superseded by a correction has
                          nothing left to correct — the fix is on the version that replaced it — and an
                          older version with a newer one already drafted has the same problem. */}
                      {report.status === "sent" &&
                        !report.supersededById &&
                        report.version >= (latestVersionByWeek.get(report.weekOf) ?? report.version) && (
                          <CorrectionButton
                            reportId={report.id}
                            // ACCEPTANCE MINUS THE PROVIDER'S LATER VERDICT, not acceptance alone. A
                            // bounced report has `sendDeliveredAt` set — the provider took it before the
                            // receiving server refused it — so the old test called it delivered and told
                            // the PM their correction "replaces the copy the client already has". The
                            // client has no copy.
                            delivered={
                              Boolean(report.sendDeliveredAt) &&
                              !weeklyReportDeliveryFailed(report.sendDeliveryStatus)
                            }
                            bounced={weeklyReportDeliveryFailed(report.sendDeliveryStatus)}
                            onCreated={(correction) => {
                              void refetch();
                              onChanged();
                              // Straight into the send modal on the new version: a correction nobody sends
                              // is just a second draft, and the original keeps standing as current.
                              onSend(correction.id);
                            }}
                          />
                        )}
                      {/* EDIT AND DELETE GO IN THE OVERFLOW, not beside the four above. A row that can
                          be sent, retried and corrected already carries four controls; six inline
                          buttons is a wall, and the destructive one has no business being the easiest
                          thing on the row to hit. This is the house row-destructive idiom — see
                          file-row.tsx, where Delete is a red DropdownMenuItem and not an inline
                          button. */}
                      <RowActions
                        report={report}
                        onEdit={() => setEditing(report)}
                        onDelete={() => setDeleting(report)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Sheet
        open={Boolean(detail) || detailLoading || Boolean(detailError)}
        onOpenChange={(open) => {
          if (open) return;
          setDetail(null);
          setDetailError(null);
        }}
      >
        {/* `sm:!max-w-3xl`, and the `!` is doing real work. `SheetContent` pins
            `data-[side=right]:sm:max-w-sm` in the primitive, and tailwind-merge does NOT treat that as
            the same key as a plain `sm:max-w-*` — the variant prefixes differ, so BOTH classes survive
            and the primitive's extra attribute selector wins on specificity. This panel asked for
            `sm:max-w-xl` and rendered at 384px: a week's work, its look-ahead, its issues and its photo
            captions crushed into a third of the width, which reads as content that failed to load.
            Four of the five sheets in this app are clamped the same way, and the estimator evidence
            sheet already carries a hand-rolled escape for it. Fixing the primitive moves four surfaces
            at once and wants its own visual pass; this is the same `!` escape the weekly-report dialogs
            use, applied where the bug was reported. */}
        <SheetContent className="w-full overflow-y-auto sm:!max-w-3xl">
          <SheetHeader>
            <SheetTitle>{detail ? `Week of ${fmtWeek(detail.weekOf)}` : "Loading…"}</SheetTitle>
          </SheetHeader>
          {detailError ? (
            // A failed load used to leave `detail` null and `detailLoading` false, which closed the
            // sheet again and said nothing at all. Clicking View and having the panel flash shut is
            // indistinguishable from the app ignoring the click.
            <div className="m-4 flex items-start gap-2 rounded-lg border border-brand-red/30 bg-brand-red/[0.03] p-3 text-[13.5px] text-brand-red">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
              <span>
                <span className="font-semibold">This report could not be loaded.</span> {detailError}
              </span>
            </div>
          ) : detailLoading && !detail ? (
            <div className="flex items-center gap-2 p-4 text-[13.5px] text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading report…
            </div>
          ) : detail ? (
            <div className="space-y-4 p-4">
              <ReportProvenance detail={detail} />
              <Section title="Work Completed / In-Progress" body={detail.workCompleted} />
              <Section title="Next Week Look Ahead" body={detail.nextWeekLookAhead} />
              <Section title="Issues / Concerns" body={detail.issuesConcerns} />
              <div className="grid grid-cols-3 gap-3">
                <Metric label="Completion" value={detail.completionPercent == null ? "—" : `${detail.completionPercent}%`} />
                <Metric label="Weather delays" value={detail.weatherDelayDays == null ? "—" : `${detail.weatherDelayDays}d`} />
                <Metric label="Weeks remaining" value={detail.remainingWeeks == null ? "—" : String(detail.remainingWeeks)} />
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Photos ({detail.photos.length})
                </p>
                {detail.photos.length === 0 ? (
                  <p className="text-[13px] text-slate-400">No photos on this report.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {detail.photos.map((photo) => (
                      <li key={photo.fileId} className="rounded-lg border border-slate-200 px-2.5 py-2 text-[13px]">
                        {photo.caption ?? <span className="text-slate-400">No caption</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      {editing && (
        <WeeklyReportEditDialog
          report={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void refetch();
            // The board reads the same rows: a completion percentage or a cleared work-completed section
            // changes what This Week says about the project, not only what History shows.
            onChanged();
          }}
        />
      )}
      {deleting && (
        <WeeklyReportDeleteDialog
          report={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            void refetch();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/**
 * The row's overflow menu: Edit, then Delete last and red.
 *
 * GATED ON THE SERVER'S ANSWER, never on a role read from the session. `canEdit` consults the report's
 * status and the project's two assignment slots as well as the role — a sent report is closed to
 * everyone, an approved one only to the PM — and the CRM re-deriving any of that is how a button that
 * 403s reaches a user.
 *
 * Renders NOTHING when neither is offered, rather than an empty menu. An overflow button that opens onto
 * nothing reads as a broken control, and for a rep — who can open this whole tab and act on none of it —
 * that would be every row.
 */
function RowActions({
  report,
  onEdit,
  onDelete,
}: {
  report: WeeklyReportHistoryEntry;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // Optional-chained because the envelope arrives from the API: a browser that loaded before the deploy
  // that added it would otherwise throw here and blank the entire History tab, which is a far worse
  // outcome than a row that briefly offers no actions.
  const canEdit = report.permissions?.canEdit === true;
  const canDelete = report.permissions?.canDelete === true;
  if (!canEdit && !canDelete) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={`More actions for the week of ${fmtWeek(report.weekOf)}`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {canEdit && (
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="mr-2 h-4 w-4" />
            Edit report
          </DropdownMenuItem>
        )}
        {canDelete && (
          <DropdownMenuItem onClick={onDelete} className="text-red-600">
            <Trash2 className="mr-2 h-4 w-4" />
            Delete report
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * WHO HANDLED THIS WEEK, above the week's contents.
 *
 * The panel could describe what was written and not one person who touched it, which is backwards for
 * the question people actually open a past week to settle — "who sent this", "who signed off". Those
 * names existed, on the per-project audit endpoint, two clicks away on a different tab.
 *
 * Steps with no timestamp are RENDERED AND GREYED rather than dropped, because the gap is the
 * information: a week that was never approved should look different from one that was, not simply
 * shorter. `—` for a missing name against a real timestamp is honest too — some rows predate the
 * columns that record the actor.
 */
function ReportProvenance({ detail }: { detail: WeeklyReportDetail }) {
  const steps: Array<{ label: string; who: string | null; at: string | null }> = [
    { label: "Drafted", who: detail.authoredByName, at: detail.authoredAt },
    { label: "Submitted", who: detail.submittedByName, at: detail.submittedAt },
    { label: "Approved", who: detail.reviewedByName, at: detail.reviewedAt },
    { label: "Sent", who: detail.sentByName, at: detail.sentAt },
  ];

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={STATUS_BADGE[detail.status] ?? ""}>
          {detail.status.replace(/_/g, " ")}
        </Badge>
        {detail.version > 1 && (
          <span className="text-[11.5px] font-semibold text-slate-500">Version {detail.version}</span>
        )}
        {detail.supersededById && (
          <span className="rounded border border-slate-200 bg-white px-1.5 py-px text-[11px] font-semibold text-slate-500">
            Superseded by a correction
          </span>
        )}
      </div>
      <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {steps.map((step) => (
          <div key={step.label} className="flex items-baseline gap-2">
            <dt className="w-[4.75rem] shrink-0 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              {step.label}
            </dt>
            <dd className={`text-[13.5px] ${step.at ? "text-slate-800" : "text-slate-400"}`}>
              {step.at ? (
                <>
                  <span className="font-semibold">{step.who ?? "—"}</span>
                  <span className="text-slate-500"> · {fmtStamp(step.at)}</span>
                </>
              ) : (
                "Not yet"
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The mail provider's verdict on this version's send, when there is one.
 *
 * RENDERS NOTHING WITHOUT A VERDICT, and that silence is the honest answer rather than a gap. A `sent`
 * report with no delivery status has not been reported as delivered — it has not been reported on at all,
 * which is the permanent state of everything sent before the webhook existed and of every environment
 * where it is not configured. Filling that in with "Delivered" would recreate the exact overclaim this
 * feature was built to remove.
 */
function DeliveryVerdict({ report }: { report: WeeklyReportDetail }) {
  const status = report.sendDeliveryStatus;
  if (!isWeeklyReportDeliveryStatus(status)) return null;

  const detail = report.sendDeliveryDetail;
  const rawClass = detail && typeof detail.bounceClass === "string" ? detail.bounceClass : null;
  const bounceClass = (
    rawClass === "hard" || rawClass === "soft" ? rawClass : "unknown"
  ) satisfies WeeklyReportBounceClass;
  const failed = weeklyReportDeliveryFailed(status);
  const message = detail && typeof detail.message === "string" ? detail.message : null;

  return (
    <div
      className={`mt-1 flex items-center gap-1 text-[11.5px] font-bold ${
        failed ? "text-brand-red" : status === "complained" ? "text-amber-600" : "text-slate-400"
      }`}
      title={message ?? undefined}
    >
      {failed && <AlertTriangle className="h-3 w-3" />}
      {weeklyReportDeliveryLabel(status, bounceClass)}
    </div>
  );
}

/**
 * Clone a sent report to the next version so it can be corrected.
 *
 * Confirmed first: this creates a real second version of a document a client has already read, and the
 * cost of an accidental click is a v2 sitting on the board that somebody has to explain.
 */
function CorrectionButton({
  reportId,
  delivered,
  bounced,
  onCreated,
}: {
  reportId: string;
  /** Whether the version being corrected actually reached the client. Changes what a correction MEANS. */
  delivered: boolean;
  /**
   * The provider told us it did not reach them. A THIRD case, not the negation of `delivered`.
   *
   * "Never reached the client" covers two situations that need opposite advice. A send still stuck in the
   * queue is fixed by Retry, and the copy below says so. A BOUNCE is not — the message went out, the
   * receiving server refused it, and replaying the identical message to the identical address does it
   * again. The only route that reaches anybody is a correction addressed differently, which is why this
   * is the one case where the button in front of them is the right one.
   */
  bounced: boolean;
  onCreated: (correction: WeeklyReportDetail) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        if (
          !window.confirm(
            bounced
              ? "The mail provider reported this report as not delivered — the client did not receive it. Check their email address on the project first, then create a new version to send to the corrected address. Continue?"
              : delivered
                ? "Issue a correction? This creates a new version of the report. Once you send it, the client is told it replaces the copy they already have and their old link shows a notice."
                : // The wording the old copy was missing entirely, and the case a PM staring at a "Send
                  // failed" chip is most likely to be in. A correction is NOT how a failed send is fixed.
                  "This report's email never reached the client. A correction is a new version, not a re-send — if you only need the delivery to go out, use Retry send instead. Create a new version anyway?",
          )
        ) {
          return;
        }
        setBusy(true);
        try {
          onCreated(await createWeeklyReportCorrection(reportId));
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Couldn't create a correction");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Send correction"}
    </Button>
  );
}

/**
 * Queue the same client email again.
 *
 * The same control the board carries, on the History tab, so a PM who lands here from a failed send has
 * the right button in front of them rather than only the one that makes a new version. Past the
 * provider's 24-hour idempotency window a replay is a genuinely second email, so the PM is told and the
 * acknowledgement is passed on — the server refuses without it.
 *
 * WHEN IT ASKS is age alone — the same rule as the server's 409, so the two cannot disagree about
 * whether this click needs agreeing to.
 *
 * WHAT IT SAYS is what `sendError` is here for. On a provable rejection the dialog can tell the PM that
 * attempt sent nothing, which is the sentence the original complaint was really about: without it a
 * "Send failed" chip read as "retrying is dangerous" and PMs reached for Send correction instead. It
 * stops there and still warns, because a recorded `rejected:` says nothing about the OTHER attempts —
 * neither earlier ones nor a later one whose delivery stamp was lost. See
 * `weeklyReportRetryDuplicateRiskPrompt`.
 */
function RetryButton({
  reportId,
  sentAt,
  sendError,
  onRetried,
}: {
  reportId: string;
  sentAt: string | null;
  sendError: string | null;
  onRetried: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        const needsAck = !weeklyReportRetryIsProviderDeduped(sentAt);
        if (needsAck && !window.confirm(weeklyReportRetryDuplicateRiskPrompt(sendError))) {
          return;
        }
        setBusy(true);
        try {
          await retryWeeklyReportSend(reportId, needsAck);
          toast.success("Send queued again");
          onRetried();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Couldn't retry that send");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Retry send"}
    </Button>
  );
}

function Section({ title, body }: { title: string; body: string | null }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">{title}</p>
      <p className="whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[13px] text-slate-700">
        {body ?? "—"}
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-2.5">
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-0.5 text-[16px] font-black tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-3.5 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-slate-400 ${className}`}
    >
      {children}
    </th>
  );
}
