import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, Loader2, Plus, RefreshCw, Search, Send, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SortHeaderButton, useTableSort, type SortColumn } from "@/components/reports/sortable";
import {
  weeklyReportWeekStateLabel,
  type WeeklyReportWeekState,
} from "@trock-crm/shared/types";
import {
  weeklyReportRetryDuplicateRiskPrompt,
  weeklyReportRetryIsProviderDeduped,
} from "@trock-crm/shared/lib/weeklyReportEmail";
import {
  dismissWeeklyReportWeek,
  retryWeeklyReportSend,
  useWeeklyReportDashboard,
  useWeeklyReportProjects,
  type WeeklyReportDashboardRow,
  type WeeklyReportProject,
} from "@/hooks/use-weekly-reports";
import { WeeklyReportProjectAuditDialog } from "./weekly-report-project-audit-dialog";
import { WeeklyReportProjectDialog } from "./weekly-report-project-dialog";
import { WeeklyReportHistoryPanel } from "./weekly-report-history-panel";
import { WeeklyReportSendDialog } from "./weekly-report-send-dialog";
import { WeeklyReportSettingsDialog } from "./weekly-report-settings-dialog";

const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Chips are keyed on the WEEK STATE, not the report status — `not_started` and `dismissed` have no
 * report row at all, which is the whole reason the board is generated from the cadence.
 */
const STATE_BADGE: Record<WeeklyReportWeekState, string> = {
  not_started: "border-slate-200 bg-slate-50 text-slate-600",
  draft: "border-amber-200 bg-amber-50 text-amber-700",
  pending_review: "border-blue-200 bg-blue-50 text-blue-700",
  approved: "border-violet-200 bg-violet-50 text-violet-700",
  sent: "border-emerald-200 bg-emerald-50 text-emerald-700",
  dismissed: "border-slate-200 bg-white text-slate-400",
};

function fmtWeek(iso: string): string {
  // Parsed at UTC and rendered in UTC: week_of is a plain calendar date, and letting the browser's
  // timezone touch it shows the previous day for anyone west of Greenwich.
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function latenessLabel(row: WeeklyReportDashboardRow): string {
  if (row.state === "sent") return "Sent";
  if (row.state === "dismissed") return "Dismissed";
  if (row.daysLate <= 0) return "Due";
  return `${row.daysLate} day${row.daysLate === 1 ? "" : "s"} late`;
}

type Tab = "this-week" | "projects" | "history";

export default function WeeklyReportsPage() {
  const [tab, setTab] = useState<Tab>("this-week");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editing, setEditing] = useState<WeeklyReportProject | null>(null);
  const [creating, setCreating] = useState(false);
  // One send modal for the whole page, so opening it from This Week and from History cannot end up as two
  // divergent copies of the same dialog.
  const [sendingReportId, setSendingReportId] = useState<string | null>(null);
  // The project whose full history is open. Its own state rather than a field on `editing`: opening the
  // record is a READ and must not put the page into the editing mode whose save handler closes dialogs.
  const [auditProjectId, setAuditProjectId] = useState<string | null>(null);

  const [historyRefreshSignal, setHistoryRefreshSignal] = useState(0);

  const dashboard = useWeeklyReportDashboard();
  const projectsQuery = useWeeklyReportProjects();

  const refreshAll = useCallback(() => {
    void dashboard.refetch();
    void projectsQuery.refetch();
    // History runs its OWN request, keyed on the project picked inside that tab, so neither refetch
    // above touches it. Left out, the table a director is looking at when they press Refresh is the one
    // surface that keeps showing the state from before the report which prompted the gesture was sent.
    setHistoryRefreshSignal((signal) => signal + 1);
  }, [dashboard, projectsQuery]);

  const outstanding = useMemo(
    () => dashboard.rows.filter((row) => row.state !== "sent" && row.state !== "dismissed"),
    [dashboard.rows],
  );
  const overdue = useMemo(() => outstanding.filter((row) => row.daysLate > 0), [outstanding]);
  const awaitingPm = useMemo(
    () => dashboard.rows.filter((row) => row.state === "pending_review" || row.state === "approved"),
    [dashboard.rows],
  );
  // `sendFailed || sendStalled`, never the raw `sendError`. The server owns both judgements: a report
  // whose retry succeeded keeps its error text as the record of what happened, and a send that failed
  // WITHOUT recording anything — the delivery job's own bookkeeping goes to the same database whose
  // absence is the likeliest reason it failed — has no error text to read at all.
  //
  // `sendBounced` joins them, and is the one that would otherwise never appear: it is the only send
  // failure whose delivery stamp is PRESENT — the provider accepted the message and the receiving server
  // then refused it — so every predicate keyed on a missing delivery reads it as a success. The card's
  // "need a retry" is not literally true of a bounce (a retry replays the same message to the same bad
  // address; the fix is a correction), but the count exists to tell a director how many clients are
  // missing a report, and a bounced one is missing it exactly as much.
  const failed = useMemo(
    () => dashboard.rows.filter((row) => row.sendFailed || row.sendStalled || row.sendBounced),
    [dashboard.rows],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Projects · Client Reporting"
        title="Weekly Reports"
        description="Set up which projects send a weekly client update, track who still owes one this week, and pull any report that has already gone out."
      />

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Outstanding" value={String(outstanding.length)} meta="weeks not yet sent" />
        <StatCard tone="bad" label="Overdue" value={String(overdue.length)} meta="past their due date" />
        <StatCard tone="warn" label="With the PM" value={String(awaitingPm.length)} meta="submitted, not yet sent" />
        <StatCard
          tone={failed.length ? "bad" : "ok"}
          label="Send failures"
          value={String(failed.length)}
          meta="need a retry"
        />
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <TabButton active={tab === "this-week"} onClick={() => setTab("this-week")}>
          This Week
        </TabButton>
        <TabButton active={tab === "projects"} onClick={() => setTab("projects")}>
          Projects
        </TabButton>
        <TabButton active={tab === "history"} onClick={() => setTab("history")}>
          History
        </TabButton>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={refreshAll}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="mr-1.5 h-3.5 w-3.5" /> Settings
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> New project
          </Button>
        </div>
      </div>

      {tab === "this-week" && (
        <ThisWeekTable
          loading={dashboard.loading}
          error={dashboard.error}
          rows={dashboard.rows}
          olderOutstandingCounts={dashboard.data?.olderOutstandingCounts ?? {}}
          lookbackWeeks={dashboard.data?.lookbackWeeks ?? 0}
          onDismissed={refreshAll}
          onOpen={setAuditProjectId}
          onSend={setSendingReportId}
          onRetried={refreshAll}
        />
      )}
      {tab === "projects" && (
        <ProjectsTable
          onOpen={setAuditProjectId}
          loading={projectsQuery.loading}
          error={projectsQuery.error}
          projects={projectsQuery.projects}
          onEdit={setEditing}
        />
      )}
      {tab === "history" && (
        <WeeklyReportHistoryPanel
          projects={projectsQuery.projects}
          refreshSignal={historyRefreshSignal}
          onSend={setSendingReportId}
          onChanged={refreshAll}
        />
      )}

      {/* No `existingDealIds`: the picker's endpoint excludes jobs that already have a setup with a
          NOT EXISTS, rather than the browser filtering whichever page of results it happens to hold —
          which silently stopped working as soon as the list ran past one page. */}
      {(creating || editing) && (
        <WeeklyReportProjectDialog
          project={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            refreshAll();
          }}
        />
      )}
      {auditProjectId && (
        <WeeklyReportProjectAuditDialog
          projectId={auditProjectId}
          onClose={() => setAuditProjectId(null)}
        />
      )}
      {sendingReportId && (
        <WeeklyReportSendDialog
          reportId={sendingReportId}
          onClose={() => setSendingReportId(null)}
          // Refresh WITHOUT closing: the dialog stays open to show the client link, which is the only
          // moment it exists in a copyable form.
          onSent={refreshAll}
        />
      )}
      {settingsOpen && <WeeklyReportSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`rounded-lg px-3 py-1.5 text-[13px] font-bold transition-colors ${
        active ? "bg-brand-red text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}

function StatCard(props: { label: string; value: string; meta: string; tone?: "ok" | "warn" | "bad" }) {
  const toneClass =
    props.tone === "bad"
      ? "text-brand-red"
      : props.tone === "warn"
        ? "text-amber-600"
        : props.tone === "ok"
          ? "text-emerald-600"
          : "text-slate-950";
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">{props.label}</p>
      <p className={`mt-1 text-[26px] font-black tabular-nums ${toneClass}`}>{props.value}</p>
      <p className="mt-0.5 text-[11.5px] font-semibold text-slate-400">{props.meta}</p>
    </div>
  );
}

const THIS_WEEK_COLUMNS: ReadonlyArray<SortColumn<WeeklyReportDashboardRow>> = [
  { key: "project", type: "text", accessor: (row) => row.projectName },
  { key: "weekOf", type: "date", accessor: (row) => row.weekOf },
  { key: "state", type: "text", accessor: (row) => row.state },
  { key: "waitingOn", type: "text", accessor: (row) => row.waitingOn },
  { key: "daysLate", type: "number", accessor: (row) => row.daysLate },
];

function ThisWeekTable({
  loading,
  error,
  rows,
  olderOutstandingCounts,
  lookbackWeeks,
  onDismissed,
  onOpen,
  onSend,
  onRetried,
}: {
  loading: boolean;
  error: string | null;
  rows: WeeklyReportDashboardRow[];
  olderOutstandingCounts: Record<string, number>;
  lookbackWeeks: number;
  onDismissed: () => void;
  onOpen: (projectId: string) => void;
  onSend: (reportId: string) => void;
  onRetried: () => void;
}) {
  const { sortedRows, toggle, getHeaderProps } = useTableSort(rows, THIS_WEEK_COLUMNS, {
    initialSort: { key: "daysLate", dir: "desc" },
  });

  const olderTotal = useMemo(
    () => Object.values(olderOutstandingCounts).reduce((sum, n) => sum + n, 0),
    [olderOutstandingCounts],
  );

  if (loading) return <PanelMessage icon="spinner">Loading the board…</PanelMessage>;
  if (error) return <PanelMessage icon="error">{error}</PanelMessage>;
  if (rows.length === 0) {
    // "Nothing is due" ONLY when nothing is owed. The older-outstanding banner below this table cannot
    // render on an empty board — this return fires first — so a board whose every outstanding week sits
    // beyond the lookback window used to read as all-caught-up, which is the precise misreading that
    // banner exists to prevent. Undelivered sends on a stopped setup land in this tally too, so an empty
    // in-window board with a client still owed their report is reachable, not hypothetical.
    if (olderTotal > 0) {
      return (
        <PanelMessage icon="calendar">
          {olderTotal} outstanding week{olderTotal === 1 ? " is" : "s are"} older than the last {lookbackWeeks} weeks,
          so {olderTotal === 1 ? "it is" : "they are"} not shown here. Open a project&rsquo;s History to see{" "}
          {olderTotal === 1 ? "it" : "them"}.
        </PanelMessage>
      );
    }
    return (
      <PanelMessage icon="calendar">
        Nothing is due. Add a project on the Projects tab to start tracking weekly updates.
      </PanelMessage>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] border-collapse text-[13.5px]">
          <thead className="border-b border-slate-200 bg-slate-50/70">
            <tr>
              <Th>
                <SortHeaderButton label="Project" {...getHeaderProps("project")} onClick={() => toggle("project")} />
              </Th>
              <Th>
                <SortHeaderButton label="Week of" {...getHeaderProps("weekOf")} onClick={() => toggle("weekOf")} />
              </Th>
              <Th>
                <SortHeaderButton label="Status" {...getHeaderProps("state")} onClick={() => toggle("state")} />
              </Th>
              <Th>
                <SortHeaderButton
                  label="Waiting on"
                  {...getHeaderProps("waitingOn")}
                  onClick={() => toggle("waitingOn")}
                />
              </Th>
              <Th className="text-right">
                <SortHeaderButton
                  label="Lateness"
                  numeric
                  {...getHeaderProps("daysLate")}
                  onClick={() => toggle("daysLate")}
                />
              </Th>
              <Th className="text-right" />
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr
                key={`${row.weeklyReportProjectId}-${row.weekOf}`}
                // THE WAY IN, from the tab people actually land on.
                //
                // The record drill-in shipped on the Projects tab only, and this is the default view —
                // so from where anyone stands when they open Weekly Reports, it did not exist. A row
                // here is a project's week, and "what happened to this one" is the question the row
                // provokes; making it answer that is the whole point of the audit trail.
                onClick={() => onOpen(row.weeklyReportProjectId)}
                className={`cursor-pointer border-b border-slate-100 hover:bg-slate-50 ${
                  row.daysLate > 0 ? "bg-red-50/30" : ""
                }`}
              >
                <td className="px-3.5 py-3">
                  <div className="font-semibold text-slate-950">
                    {/* A real button, so the record is reachable and announced to a keyboard and a
                        screen reader — the <tr> handler above is the mouse affordance only. This is the
                        same pattern the Projects tab already uses; wiring the row here without it left
                        keyboard users with no way in at all, which is worse than the tab-only drill-in
                        it was fixing. Caught by Greptile. */}
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpen(row.weeklyReportProjectId);
                      }}
                      className="text-left hover:text-brand-red hover:underline"
                    >
                      {row.projectName}
                    </button>
                  </div>
                  <div className="mt-0.5 text-[11.5px] font-semibold text-slate-400">
                    {[row.projectNumber, row.clientName].filter(Boolean).join(" · ") || "—"}
                  </div>
                </td>
                <td className="px-3.5 py-3 text-slate-600">
                  {fmtWeek(row.weekOf)}
                  {!row.isCurrentWeek && (
                    <span className="ml-1.5 text-[10.5px] font-bold uppercase tracking-wide text-slate-400">
                      backlog
                    </span>
                  )}
                </td>
                <td className="px-3.5 py-3">
                  <Badge variant="outline" className={`${STATE_BADGE[row.state]} whitespace-nowrap`}>
                    {weeklyReportWeekStateLabel(row.state)}
                  </Badge>
                  {/* BOUNCED FIRST, because it is the only one of the four whose row otherwise looks
                      completely healthy. The other three are all keyed on a MISSING delivery stamp; a
                      bounce has one — the provider accepted the message and the receiving server then
                      refused it — so without this branch the week renders as plain "Sent" and the client
                      who never got their report is invisible on the page built to catch exactly that.
                      Mutually exclusive with the rest by construction, so the order is for the reader. */}
                  {row.sendBounced ? (
                    <div
                      className="mt-1 flex items-center gap-1 text-[11.5px] font-bold text-brand-red"
                      title={
                        "The mail provider accepted this report and then reported that it was not " +
                        "delivered. Check the client's email address on the project and send a correction " +
                        "— retrying would replay the same message to the same address."
                      }
                    >
                      <AlertTriangle className="h-3 w-3" /> Not delivered
                    </div>
                  ) : row.sendFailed ? (
                    <div
                      className="mt-1 flex items-center gap-1 text-[11.5px] font-bold text-brand-red"
                      title={row.sendError ?? undefined}
                    >
                      <AlertTriangle className="h-3 w-3" /> Send failed
                      {row.sendAttempts > 1 && (
                        <span className="font-semibold text-slate-400">· {row.sendAttempts} attempts</span>
                      )}
                    </div>
                  ) : row.sendStalled ? (
                    // Committed, never delivered, and nothing was ever written down about why. Worded
                    // differently from "Send failed" because there is no error to show and no provider
                    // to blame — the report simply never went anywhere.
                    //
                    // The title SPLITS on the attempt count, because the flat "no delivery was ever
                    // recorded" was false in the state a PM most often reads it in: a send that failed
                    // three times and was then retried has an attempt history, and the retry is what
                    // erased the error text this chip is standing in for. Telling them nothing was ever
                    // recorded contradicts the "· 3 attempts" they were looking at a moment earlier.
                    <div
                      className="mt-1 flex items-center gap-1 text-[11.5px] font-bold text-brand-red"
                      title={
                        row.sendAttempts > 0
                          ? `This report was marked sent and its delivery has been attempted ${
                              row.sendAttempts
                            } time${row.sendAttempts === 1 ? "" : "s"}, but the mail provider has never ` +
                            "been recorded as accepting it and the last attempt reported no error."
                          : "This report was marked sent but no delivery was ever attempted or recorded."
                      }
                    >
                      <AlertTriangle className="h-3 w-3" /> Send stuck
                      {row.sendAttempts > 0 && (
                        <span className="font-semibold text-slate-400">
                          · {row.sendAttempts} attempt{row.sendAttempts === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>
                  ) : (
                    // Undelivered, no error, and recent enough to still be a queued job rather than a
                    // problem. Saying "Sending…" instead of nothing is what stops a PM re-sending on it.
                    row.sendPending && (
                      <div className="mt-1 text-[11.5px] font-semibold text-slate-400">Sending…</div>
                    )
                  )}
                </td>
                <td className="px-3.5 py-3 text-slate-600">{row.waitingOn ?? "—"}</td>
                <td
                  className={`px-3.5 py-3 text-right font-bold tabular-nums ${
                    row.daysLate > 0 ? "text-brand-red" : "text-slate-500"
                  }`}
                >
                  {latenessLabel(row)}
                </td>
                <td className="px-3.5 py-3 text-right">
                  {/*
                    Retry and Send are NOT alternatives once a correction exists over a failed send, which
                    is why this is a list rather than the if/else chain it used to be. In that state the
                    row is `approved` AND carries a "Send failed" chip, and the chain offered Retry alone —
                    so the only button replayed the OLD content, and the correction the PM had just
                    written had no path off This Week at all. They had to find it in History.

                    The two do different jobs and a PM may want either: Retry replays the send that
                    failed, for a transport problem; Send delivers the correction, for a content one.
                  */}
                  {/* The row opens the record; these do their own thing. Without this, Send / Retry /
                      Dismiss would each ALSO open the audit dialog on top of what they just did — and
                      Dismiss opens a prompt of its own, so the two would fight over the screen. */}
                  <div
                    className="flex items-center justify-end gap-2"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {(row.sendFailed || row.sendStalled) && row.sendRetryReportId && (
                      // `sendRetryReportId`, not `reportId`: once a PM has drafted a correction over a
                      // failed send the live row is the unsent clone, and retrying THAT would replay a
                      // report nobody sent. `sendRetrySentAt` for the same reason — the clone has no
                      // `sent_at`, so measuring the provider's dedupe window off `row.sentAt` would warn
                      // about a duplicate for a send committed minutes ago.
                      <RetryButton
                        reportId={row.sendRetryReportId}
                        sentAt={row.sendRetrySentAt}
                        sendError={row.sendRetrySendError}
                        onRetried={onRetried}
                      />
                    )}
                    {row.state === "approved" && row.reportId && (
                      <Button size="sm" onClick={() => onSend(row.reportId!)}>
                        <Send className="mr-1.5 h-3.5 w-3.5" /> Send
                      </Button>
                    )}
                    {row.state === "not_started" &&
                      row.daysLate > 0 &&
                      !((row.sendFailed || row.sendStalled) && row.sendRetryReportId) && (
                        <DismissButton row={row} onDismissed={onDismissed} />
                      )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {olderTotal > 0 && (
        // Surfaced rather than silently truncated: a board that stops at the window edge reads as
        // "all caught up" on a project that is months behind.
        <div className="border-t border-slate-200 bg-slate-50/70 px-3.5 py-2 text-[12px] font-semibold text-slate-500">
          {olderTotal} more outstanding week{olderTotal === 1 ? "" : "s"} older than the last {lookbackWeeks} weeks are
          not shown.
        </div>
      )}
    </div>
  );
}

function DismissButton({ row, onDismissed }: { row: WeeklyReportDashboardRow; onDismissed: () => void }) {
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    const reason = window.prompt(`Why is the week of ${fmtWeek(row.weekOf)} being written off?`);
    // A dismissal without a reason is indistinguishable from clearing the board, which is the
    // accountability this page exists to create — so an empty answer cancels.
    if (!reason || !reason.trim()) return;
    setBusy(true);
    try {
      await dismissWeeklyReportWeek(row.weeklyReportProjectId, row.weekOf, reason.trim());
      toast.success("Week dismissed");
      onDismissed();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't dismiss that week");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant="ghost" size="sm" disabled={busy} onClick={onClick}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Dismiss"}
    </Button>
  );
}

/**
 * Queue the SAME email again.
 *
 * Not a re-send with new recipients — the server replays the stored request under the same provider
 * idempotency key, so a job that actually succeeded before the process died cannot become a second copy
 * in the client's inbox. Reaching different people is a correction.
 *
 * THAT PROTECTION EXPIRES. Resend keeps an idempotency key for 24 hours and this chip lives on the board
 * for the 26-week lookback, so a PM clicking Retry the following Monday is outside the window and the
 * replay is a real second email. Past it the PM is told so and has to agree; the server refuses without
 * the acknowledgement, so this dialog is the explanation, not the enforcement.
 *
 * AND IT ONLY EXPIRES INTO A RISK WHEN THE RECORD IS SILENT. A recorded provider error on the send being
 * replayed says the message was refused, so there is no first copy and nothing to warn about — which is
 * the "Send failed" chip, the one a PM is most often looking at when they reach for this button.
 * `sendRetrySendError`, not `sendError`: the two describe different reports once a correction exists.
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

const PROJECT_COLUMNS: ReadonlyArray<SortColumn<WeeklyReportProject>> = [
  { key: "project", type: "text", accessor: (row) => row.propertyDisplayName ?? row.dealName },
  { key: "client", type: "text", accessor: (row) => row.clientName },
  { key: "cadence", type: "number", accessor: (row) => row.cadenceWeekday },
  { key: "sent", type: "number", accessor: (row) => row.summary?.reportsSent ?? 0 },
  // lastSentAt (when it actually went out), NOT lastSentWeekOf (the week it covered). Approval can
  // land a report days after its cadence date, and a column headed "Last sent" that shows the
  // reporting week misstates how recently the client last heard from us — which is the one thing
  // this column is read for.
  { key: "lastSent", type: "date", accessor: (row) => row.summary?.lastSentAt ?? null },
  { key: "nextDue", type: "date", accessor: (row) => row.summary?.nextDueWeekOf ?? null },
];

function ProjectsTable({
  loading,
  error,
  projects,
  onEdit,
  onOpen,
}: {
  loading: boolean;
  error: string | null;
  projects: WeeklyReportProject[];
  onEdit: (project: WeeklyReportProject) => void;
  onOpen: (projectId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return projects;
    return projects.filter((project) =>
      [project.propertyDisplayName, project.dealName, project.clientName, project.projectNumber]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(term)),
    );
  }, [projects, search]);

  const { sortedRows, toggle, getHeaderProps } = useTableSort(filtered, PROJECT_COLUMNS, {
    initialSort: { key: "project", dir: "asc" },
  });

  if (loading) return <PanelMessage icon="spinner">Loading projects…</PanelMessage>;
  if (error) return <PanelMessage icon="error">{error}</PanelMessage>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-2">
        <Search className="ml-1 h-4 w-4 text-slate-400" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search projects, clients or project numbers"
          aria-label="Search weekly report projects"
          className="w-full bg-transparent text-[13.5px] outline-none placeholder:text-slate-400"
        />
      </div>

      {sortedRows.length === 0 ? (
        <PanelMessage icon="calendar">
          No weekly report projects yet. Use “New project” to add the first one.
        </PanelMessage>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-[13.5px]">
              <thead className="border-b border-slate-200 bg-slate-50/70">
                <tr>
                  <Th>
                    <SortHeaderButton
                      label="Project"
                      {...getHeaderProps("project")}
                      onClick={() => toggle("project")}
                    />
                  </Th>
                  <Th>
                    <SortHeaderButton label="Client" {...getHeaderProps("client")} onClick={() => toggle("client")} />
                  </Th>
                  <Th>
                    <SortHeaderButton
                      label="Due every"
                      {...getHeaderProps("cadence")}
                      onClick={() => toggle("cadence")}
                    />
                  </Th>
                  <Th>Team</Th>
                  <Th className="text-right">
                    <SortHeaderButton label="Sent" numeric {...getHeaderProps("sent")} onClick={() => toggle("sent")} />
                  </Th>
                  <Th>
                    <SortHeaderButton
                      label="Last sent"
                      {...getHeaderProps("lastSent")}
                      onClick={() => toggle("lastSent")}
                    />
                  </Th>
                  <Th>
                    <SortHeaderButton
                      label="Next due"
                      {...getHeaderProps("nextDue")}
                      onClick={() => toggle("nextDue")}
                    />
                  </Th>
                  <Th className="text-right" />
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((project) => (
                  <tr
                    key={project.id}
                    // The whole row opens the record. `onClick` on the <tr> rather than wrapping the
                    // first cell in a link, so the large hit area a table row already looks like is the
                    // one that works — and the Edit button stops propagation so it still edits.
                    onClick={() => onOpen(project.id)}
                    className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-3.5 py-3">
                      <div className="font-semibold text-slate-950">
                        {/* A real button, so the row is reachable and announced to a keyboard and a
                            screen reader. The <tr> handler above is the mouse affordance only. */}
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpen(project.id);
                          }}
                          className="text-left hover:text-brand-red hover:underline"
                        >
                          {project.propertyDisplayName ?? project.dealName ?? "Untitled project"}
                        </button>
                      </div>
                      <div className="mt-0.5 text-[11.5px] font-semibold text-slate-400">
                        {project.projectNumber ?? "—"}
                      </div>
                    </td>
                    <td className="px-3.5 py-3 text-slate-600">{project.clientName ?? "—"}</td>
                    <td className="px-3.5 py-3 text-slate-600">{WEEKDAY_LABELS[project.cadenceWeekday] ?? "—"}</td>
                    <td className="px-3.5 py-3 text-[12.5px] text-slate-600">
                      <div>PM · {project.trockPmName ?? "Unassigned"}</div>
                      <div className="text-slate-400">Super · {project.trockSuperName ?? "Unassigned"}</div>
                    </td>
                    <td className="px-3.5 py-3 text-right font-bold tabular-nums text-slate-800">
                      {project.summary?.reportsSent ?? 0}
                      {/* The count is DELIVERED reports, so a committed send that never got out would
                          otherwise vanish from this tab entirely — and this tab is the only place some of
                          them are mentioned at all. Shown next to the number it was removed from. */}
                      {(project.summary?.undeliveredSends ?? 0) > 0 && (
                        <div className="mt-0.5 text-[11px] font-bold text-brand-red">
                          {project.summary!.undeliveredSends} not delivered
                        </div>
                      )}
                    </td>
                    <td className="px-3.5 py-3 text-slate-600">
                      {project.summary?.lastSentAt ? (
                        <>
                          {fmtDateTime(project.summary.lastSentAt)}
                          {project.summary.lastSentWeekOf && (
                            <span className="ml-1.5 text-[11px] font-semibold text-slate-400">
                              wk {fmtWeek(project.summary.lastSentWeekOf)}
                            </span>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3.5 py-3 text-slate-600">
                      {project.summary?.nextDueWeekOf ? fmtWeek(project.summary.nextDueWeekOf) : "—"}
                    </td>
                    <td className="px-3.5 py-3 text-right">
                      <Button variant="outline" size="sm" onClick={() => onEdit(project)}>
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
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

function PanelMessage({ icon, children }: { icon: "spinner" | "error" | "calendar"; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white p-6 text-[13.5px] font-semibold text-slate-500">
      {icon === "spinner" && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
      {icon === "error" && <AlertTriangle className="h-4 w-4 text-brand-red" />}
      {icon === "calendar" && <CalendarClock className="h-4 w-4 text-slate-400" />}
      {children}
    </div>
  );
}

/** Exported for the unit suite, which asserts the lateness copy without mounting the whole page. */
export { latenessLabel, fmtWeek, fmtDateTime };
