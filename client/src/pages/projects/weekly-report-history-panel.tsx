import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarClock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS,
  weeklyReportRetryIsProviderDeduped,
} from "@trock-crm/shared/lib/weeklyReportEmail";
import {
  createWeeklyReportCorrection,
  fetchWeeklyReportDetail,
  retryWeeklyReportSend,
  useWeeklyReportHistory,
  type WeeklyReportDetail,
  type WeeklyReportProject,
} from "@/hooks/use-weekly-reports";

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

  // Default to the first project once the list arrives, so the tab isn't an empty prompt on open.
  useEffect(() => {
    if (!projectId && projects.length > 0) setProjectId(projects[0]!.id);
  }, [projects, projectId]);

  const { reports, loading, error, refetch } = useWeeklyReportHistory(projectId || null);
  const [detail, setDetail] = useState<WeeklyReportDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Re-run the history request when the page refreshes, but NOT on mount — the hook already loads on
  // mount and on every project change, so an unguarded effect would fire a second, identical request
  // alongside the first and let whichever answered last win.
  const lastRefreshSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === lastRefreshSignal.current) return;
    lastRefreshSignal.current = refreshSignal;
    void refetch();
  }, [refreshSignal, refetch]);

  const selected = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId]);

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
    try {
      setDetail(await fetchWeeklyReportDetail(reportId));
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
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.propertyDisplayName ?? project.dealName ?? "Untitled project"}
            </option>
          ))}
        </select>
        {selected?.clientName && (
          <span className="text-[12.5px] font-semibold text-slate-400">for {selected.clientName}</span>
        )}
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
                        <RetryButton reportId={report.id} sentAt={report.sentAt} onRetried={onChanged} />
                      )}
                      {/* Only on the LIVE, NEWEST version. A report already superseded by a correction has
                          nothing left to correct — the fix is on the version that replaced it — and an
                          older version with a newer one already drafted has the same problem. */}
                      {report.status === "sent" &&
                        !report.supersededById &&
                        report.version >= (latestVersionByWeek.get(report.weekOf) ?? report.version) && (
                          <CorrectionButton
                            reportId={report.id}
                            delivered={Boolean(report.sendDeliveredAt)}
                            onCreated={(correction) => {
                              void refetch();
                              onChanged();
                              // Straight into the send modal on the new version: a correction nobody sends
                              // is just a second draft, and the original keeps standing as current.
                              onSend(correction.id);
                            }}
                          />
                        )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Sheet open={Boolean(detail) || detailLoading} onOpenChange={(open) => !open && setDetail(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{detail ? `Week of ${fmtWeek(detail.weekOf)}` : "Loading…"}</SheetTitle>
          </SheetHeader>
          {detailLoading && !detail ? (
            <div className="flex items-center gap-2 p-4 text-[13.5px] text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading report…
            </div>
          ) : detail ? (
            <div className="space-y-4 p-4">
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
  onCreated,
}: {
  reportId: string;
  /** Whether the version being corrected actually reached the client. Changes what a correction MEANS. */
  delivered: boolean;
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
            delivered
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
 */
function RetryButton({
  reportId,
  sentAt,
  onRetried,
}: {
  reportId: string;
  sentAt: string | null;
  onRetried: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        const deduped = weeklyReportRetryIsProviderDeduped(sentAt);
        if (
          !deduped &&
          !window.confirm(
            `This send is more than ${WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS} hours old, so the ` +
              "mail provider will no longer treat a retry as a duplicate. If the first email did go out, " +
              "the client will receive a second copy. Send it again?",
          )
        ) {
          return;
        }
        setBusy(true);
        try {
          await retryWeeklyReportSend(reportId, !deduped);
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
