import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, Loader2, Plus, RefreshCw, Search, Settings2 } from "lucide-react";
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
  dismissWeeklyReportWeek,
  useWeeklyReportDashboard,
  useWeeklyReportProjects,
  type WeeklyReportDashboardRow,
  type WeeklyReportProject,
} from "@/hooks/use-weekly-reports";
import { WeeklyReportProjectDialog } from "./weekly-report-project-dialog";
import { WeeklyReportHistoryPanel } from "./weekly-report-history-panel";
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
  const failed = useMemo(() => dashboard.rows.filter((row) => Boolean(row.sendError)), [dashboard.rows]);

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
        />
      )}
      {tab === "projects" && (
        <ProjectsTable
          loading={projectsQuery.loading}
          error={projectsQuery.error}
          projects={projectsQuery.projects}
          onEdit={setEditing}
        />
      )}
      {tab === "history" && (
        <WeeklyReportHistoryPanel projects={projectsQuery.projects} refreshSignal={historyRefreshSignal} />
      )}

      {(creating || editing) && (
        <WeeklyReportProjectDialog
          project={editing}
          existingDealIds={projectsQuery.projects.map((p) => p.dealId)}
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
}: {
  loading: boolean;
  error: string | null;
  rows: WeeklyReportDashboardRow[];
  olderOutstandingCounts: Record<string, number>;
  lookbackWeeks: number;
  onDismissed: () => void;
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
                className={`border-b border-slate-100 ${row.daysLate > 0 ? "bg-red-50/30" : ""}`}
              >
                <td className="px-3.5 py-3">
                  <div className="font-semibold text-slate-950">{row.projectName}</div>
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
                  {row.sendError && (
                    <div className="mt-1 flex items-center gap-1 text-[11.5px] font-bold text-brand-red">
                      <AlertTriangle className="h-3 w-3" /> Send failed
                    </div>
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
                  {row.state === "not_started" && row.daysLate > 0 && (
                    <DismissButton row={row} onDismissed={onDismissed} />
                  )}
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
}: {
  loading: boolean;
  error: string | null;
  projects: WeeklyReportProject[];
  onEdit: (project: WeeklyReportProject) => void;
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
                  <tr key={project.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-3.5 py-3">
                      <div className="font-semibold text-slate-950">
                        {project.propertyDisplayName ?? project.dealName ?? "Untitled project"}
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
