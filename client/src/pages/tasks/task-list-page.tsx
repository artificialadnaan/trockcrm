import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock,
  FileText,
  Flag,
  Mail,
  MoreHorizontal,
  Phone,
  RefreshCw,
  Search,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MetricCard } from "@/components/shared/metric-card";
import {
  completeTask,
  getTaskStatusLabel,
  isTerminalTaskStatus,
  snoozeTask,
  useTaskCounts,
  useTask,
  useTasks,
  type Task,
  type TaskSortBy,
  type TaskSortDir,
} from "@/hooks/use-tasks";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { TaskCreateDialog } from "@/components/tasks/task-create-dialog";
import { TaskEditDialog } from "@/components/tasks/task-edit-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { formatDealDisplayNumber, sanitizeHubspotDealIdentifiers } from "@/lib/deal-utils";
import { toast } from "sonner";

type GroupKey = "overdue" | "today" | "this_week" | "later" | "completed";
const ALL_ASSIGNEES_VALUE = "__all__";

const GROUP_META: Record<GroupKey, { label: string; eyebrow: string; dotClass: string; defaultOpen: boolean }> = {
  overdue: { label: "Overdue", eyebrow: "Red path", dotClass: "bg-brand-red", defaultOpen: true },
  today: { label: "Today", eyebrow: "Due now", dotClass: "bg-amber-400", defaultOpen: true },
  this_week: { label: "This week", eyebrow: "Next 7 days", dotClass: "bg-blue-500", defaultOpen: true },
  later: { label: "Later", eyebrow: "Scheduled and upcoming", dotClass: "bg-slate-400", defaultOpen: false },
  completed: { label: "Completed recently", eyebrow: "Done", dotClass: "bg-emerald-500", defaultOpen: false },
};

// Per-bucket sort options. Each option pairs a field with its natural direction (the issue's
// 4-option "Sort: …" dropdown); the chosen pair is sent to the server as sortBy/sortDir so the
// FULL bucket sorts in the DB, not just the loaded cards. Completed swaps Due-date → Completed-date.
type SortOption = { value: string; label: string };

const ACTIVE_SORT_OPTIONS: SortOption[] = [
  { value: "due_date:asc", label: "Due date" },
  { value: "priority:desc", label: "Priority" },
  { value: "assignee:asc", label: "Assignee" },
  { value: "created_at:desc", label: "Newest" },
];

const COMPLETED_SORT_OPTIONS: SortOption[] = [
  { value: "completed_at:desc", label: "Completed date" },
  { value: "priority:desc", label: "Priority" },
  { value: "assignee:asc", label: "Assignee" },
  { value: "created_at:desc", label: "Newest" },
];

// Sensible default per bucket: due-soonest-first for active work, most-recently-completed-first
// for the Completed bucket.
const DEFAULT_SORT: Record<GroupKey, string> = {
  overdue: "due_date:asc",
  today: "due_date:asc",
  this_week: "due_date:asc",
  later: "due_date:asc",
  completed: "completed_at:desc",
};

function sortOptionsForGroup(groupKey: GroupKey): SortOption[] {
  return groupKey === "completed" ? COMPLETED_SORT_OPTIONS : ACTIVE_SORT_OPTIONS;
}

function parseSortValue(value: string): { sortBy: TaskSortBy; sortDir: TaskSortDir } {
  const [sortBy, sortDir] = value.split(":") as [TaskSortBy, TaskSortDir];
  return { sortBy, sortDir };
}

const PRIORITY_CLASSES: Record<string, string> = {
  urgent: "bg-brand-red text-white",
  high: "bg-brand-red/10 text-brand-red ring-1 ring-brand-red/20",
  normal: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  low: "bg-slate-100 text-slate-600 ring-1 ring-slate-200",
};

const TYPE_ICONS: Record<string, typeof Phone> = {
  call: Phone,
  phone: Phone,
  email: Mail,
  inbound_email: Mail,
  meeting: Users,
  follow_up: Clock,
  doc: FileText,
  review: FileText,
  stale_deal: AlertTriangle,
};

function getInitials(name: string | null | undefined) {
  if (!name) return "TR";
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function getTaskProjectContext(task: Pick<Task, "dealId" | "dealName" | "dealNumber" | "projectNumber">): string | null {
  if (!task.dealId) return null;
  const displayNumber = formatDealDisplayNumber(task).label;
  if (task.dealName) {
    return displayNumber === "Pending" ? task.dealName : `${displayNumber} - ${task.dealName}`;
  }
  if (displayNumber !== "Pending") return displayNumber;
  return "Project linked";
}

function formatDueDate(value: string | null) {
  if (!value) return "No date";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "No date";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function typeLabel(value: string) {
  return value.replace(/_/g, " ");
}

function stopRowKeyDownPropagation(event: React.KeyboardEvent) {
  if (event.key === "Enter" || event.key === " ") {
    event.stopPropagation();
  }
}

function TaskRow({ task, onUpdate }: { task: Task; onUpdate: () => void }) {
  const navigate = useNavigate();
  const [editOpen, setEditOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const isDone = isTerminalTaskStatus(task.status);
  const Icon = TYPE_ICONS[task.type] ?? MoreHorizontal;
  const projectContext = getTaskProjectContext(task);
  const taskTitle = sanitizeHubspotDealIdentifiers(task.title);

  const complete = async (event: React.MouseEvent) => {
    event.stopPropagation();
    setBusy(true);
    try {
      await completeTask(task.id);
      onUpdate();
    } catch (error) {
      console.error("[tasks] complete failed", error);
      toast.error(error instanceof Error ? error.message : "Failed to complete task");
    } finally {
      setBusy(false);
    }
  };

  const snooze = async (event: React.MouseEvent) => {
    event.stopPropagation();
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    setBusy(true);
    try {
      await snoozeTask(task.id, tomorrow);
      onUpdate();
    } catch (error) {
      console.error("[tasks] snooze failed", error);
      toast.error(error instanceof Error ? error.message : "Failed to snooze task");
    } finally {
      setBusy(false);
    }
  };

  const openLinkedRecord = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (task.dealId) navigate(`/deals/${task.dealId}`);
    else if (task.contactId) navigate(`/contacts/${task.contactId}`);
    else if (task.emailId) navigate("/email");
  };

  const openEdit = () => {
    if (isDone) return;
    setEditOpen(true);
  };

  return (
    <>
      <div
        className={cn(
          "group grid gap-3 border-b border-slate-100 bg-white px-4 py-3 transition-colors md:grid-cols-[32px_minmax(0,1fr)_120px_130px_150px_96px]",
          isDone ? "opacity-65" : "hover:bg-slate-50"
        )}
      >
        <button
          type="button"
          disabled={busy || isDone}
          onClick={complete}
          onKeyDown={stopRowKeyDownPropagation}
          aria-label={`Complete ${taskTitle}`}
          className={cn(
            "mt-1 flex h-6 w-6 items-center justify-center rounded border-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red",
            isDone ? "border-emerald-600 bg-emerald-600 text-white" : "border-slate-300 text-slate-300 hover:border-emerald-600 hover:text-emerald-600"
          )}
        >
          <Check className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          data-testid="task-row-content"
          disabled={isDone}
          onClick={openEdit}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openEdit();
            }
          }}
          className={cn(
            "grid min-w-0 gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red md:col-span-4 md:grid-cols-[minmax(0,1fr)_120px_130px_150px]",
            isDone ? "cursor-default" : "cursor-pointer"
          )}
        >
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600">
                <Icon className="h-3.5 w-3.5" />
              </span>
              <p className={cn("truncate text-sm font-black text-slate-950", isDone ? "line-through text-slate-500" : "")}>
                {taskTitle}
              </p>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-9 text-xs font-semibold text-slate-500">
              <span className="capitalize">{typeLabel(task.type)}</span>
              <span>{getTaskStatusLabel(task.status)}</span>
              {projectContext ? <span className="truncate">{projectContext}</span> : null}
            </div>
          </div>

          <div className="flex items-center">
            <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wide", PRIORITY_CLASSES[task.priority] ?? PRIORITY_CLASSES.low)}>
              <Flag className="h-3 w-3" />
              {task.priority === "normal" ? "Medium" : task.priority}
            </span>
          </div>

          <div className={cn("flex items-center text-xs font-black", task.isOverdue ? "text-brand-red" : "text-slate-600")}>
            {formatDueDate(task.dueDate)}
          </div>

          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-red text-[10px] font-black text-white">
              {getInitials(task.assignedToName)}
            </span>
            <span className="truncate text-xs font-semibold text-slate-600">{task.assignedToName ?? "Unassigned"}</span>
          </div>
        </button>

        <div className="flex items-center justify-end gap-1 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
          {!isDone ? (
            <button
              type="button"
              disabled={busy}
              onClick={snooze}
              onKeyDown={stopRowKeyDownPropagation}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-amber-50 hover:text-amber-600"
              aria-label={`Snooze ${taskTitle}`}
            >
              <Clock className="h-4 w-4" />
            </button>
          ) : null}
          {task.dealId || task.contactId || task.emailId ? (
            <button
              type="button"
              onClick={openLinkedRecord}
              onKeyDown={stopRowKeyDownPropagation}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-blue-50 hover:text-blue-600"
              aria-label={`Open linked record for ${taskTitle}`}
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>
      <TaskEditDialog task={task} open={editOpen} onOpenChange={setEditOpen} onUpdated={onUpdate} />
    </>
  );
}

function TaskGroupSortControl({
  groupKey,
  value,
  onChange,
  loading,
}: {
  groupKey: GroupKey;
  value: string;
  onChange: (value: string) => void;
  loading: boolean;
}) {
  const meta = GROUP_META[groupKey];
  const options = sortOptionsForGroup(groupKey);
  const selectedLabel = options.find((option) => option.value === value)?.label ?? options[0].label;
  const ariaLabel = `Sort ${meta.label} tasks`;

  return (
    <div data-sort-group={groupKey} className="flex items-center gap-1.5">
      {loading ? <RefreshCw className="h-3.5 w-3.5 animate-spin text-slate-400" aria-hidden /> : null}
      <span className="hidden text-[11px] font-black uppercase tracking-[0.14em] text-slate-500 sm:inline">Sort</span>
      <Select value={value} onValueChange={(next) => { if (next) onChange(next); }}>
        <SelectTrigger aria-label={ariaLabel} className="h-8 w-[150px] border-slate-200 bg-white">
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function TaskGroup({
  groupKey,
  tasks,
  onUpdate,
  sortValue,
  onSortChange,
  loading,
}: {
  groupKey: GroupKey;
  tasks: Task[];
  onUpdate: () => void;
  sortValue: string;
  onSortChange: (value: string) => void;
  loading: boolean;
}) {
  const meta = GROUP_META[groupKey];
  const [open, setOpen] = useState(meta.defaultOpen);
  const toggle = () => setOpen((value) => !value);

  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      {/* Header bar is NOT a single button: the collapse toggle and the sort dropdown are siblings
          so the dropdown never nests inside (or toggles) the accordion. */}
      <div className="flex w-full flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
        >
          <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", meta.dotClass)} />
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">{meta.eyebrow}</p>
            <h2 className="text-sm font-black uppercase text-slate-950">{meta.label}</h2>
          </div>
        </button>
        <div className="flex items-center gap-2">
          {open ? (
            <TaskGroupSortControl groupKey={groupKey} value={sortValue} onChange={onSortChange} loading={loading} />
          ) : null}
          <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-black tabular-nums text-slate-700 ring-1 ring-slate-200">
            {tasks.length}
          </span>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${meta.label}`}
            className="flex h-8 w-8 items-center justify-center rounded text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
          >
            <ChevronDown className={cn("h-4 w-4 transition-transform", open ? "rotate-180" : "")} />
          </button>
        </div>
      </div>
      {open ? (
        <div>
          {tasks.length > 0 ? (
            tasks.map((task) => <TaskRow key={task.id} task={task} onUpdate={onUpdate} />)
          ) : (
            <div className="p-8 text-center text-sm font-semibold text-slate-500">
              {loading ? "Loading…" : "No tasks in this group."}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function AssigneeFilter({
  selectedAssignee,
  onChange,
}: {
  selectedAssignee: string;
  onChange: (assigneeId: string) => void;
}) {
  const { assignees, loading } = useTaskAssignees();
  const selectedAssigneeLabel = selectedAssignee
    ? assignees.find((assignee) => assignee.id === selectedAssignee)?.displayName ?? "Selected assignee"
    : "All assignees";

  return (
    <div data-testid="assignee-filter" className="flex items-center gap-2">
      <label htmlFor="task-assignee-filter" className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
        Assignee
      </label>
      <Select
        value={selectedAssignee || ALL_ASSIGNEES_VALUE}
        onValueChange={(value) => onChange(!value || value === ALL_ASSIGNEES_VALUE ? "" : value)}
        disabled={loading}
      >
        <SelectTrigger id="task-assignee-filter" className="h-9 w-56 border-slate-200 bg-slate-50">
          <SelectValue>{loading ? "Loading assignees..." : selectedAssigneeLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_ASSIGNEES_VALUE}>All assignees</SelectItem>
          {assignees.map((assignee) => (
            <SelectItem key={assignee.id} value={assignee.id}>
              {assignee.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function TaskListPage() {
  const { user, loading: authLoading } = useAuth();

  if (authLoading || !user) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-8 text-sm font-semibold text-slate-500">
        Loading tasks...
      </div>
    );
  }

  return <TaskListPageContent role={user.role} />;
}

function TaskListPageContent({ role }: { role: string }) {
  const { taskId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const canAssign = role === "admin" || role === "director";
  const selectedAssignee = canAssign ? searchParams.get("assignee") ?? "" : "";
  const assigneeFilter = selectedAssignee || undefined;
  // Per-bucket sort selection (ephemeral view preference, kept in local state — not URL).
  const [sortByGroup, setSortByGroup] = useState<Record<GroupKey, string>>(DEFAULT_SORT);
  const setGroupSort = (groupKey: GroupKey) => (value: string) =>
    setSortByGroup((prev) => ({ ...prev, [groupKey]: value }));

  const overdueSort = parseSortValue(sortByGroup.overdue);
  const todaySort = parseSortValue(sortByGroup.today);
  const thisWeekSort = parseSortValue(sortByGroup.this_week);
  const laterSort = parseSortValue(sortByGroup.later);
  const completedSort = parseSortValue(sortByGroup.completed);

  const { counts, loading: countsLoading, stale: countsStale, refetch: refetchCounts } = useTaskCounts(assigneeFilter);
  // Each displayed bucket is now exactly one server query, sorted server-side over its full set.
  const { tasks: overdueTasks, loading: overdueLoading, error: overdueError, refetch: refetchOverdue } = useTasks({ section: "overdue", assignedTo: assigneeFilter, sortBy: overdueSort.sortBy, sortDir: overdueSort.sortDir });
  const { tasks: todayTasks, loading: todayLoading, error: todayError, refetch: refetchToday } = useTasks({ section: "today", assignedTo: assigneeFilter, sortBy: todaySort.sortBy, sortDir: todaySort.sortDir });
  const { tasks: thisWeekTasks, loading: thisWeekLoading, error: thisWeekError, refetch: refetchThisWeek } = useTasks({ section: "this_week", assignedTo: assigneeFilter, sortBy: thisWeekSort.sortBy, sortDir: thisWeekSort.sortDir });
  // limit 200 preserves the prior display ceiling: "Later" used to be two fetches (scheduled ≤100 +
  // the >7-day tail of upcoming ≤100); it's now a single unified server query. The default sort is by
  // effective date (due_date ?? scheduled_for), so near-term scheduled follow-ups are kept even when
  // the bucket is busy — the limit drops the furthest-out rows, not scheduled tasks categorically.
  const { tasks: laterTasks, loading: laterLoading, error: laterError, refetch: refetchLater } = useTasks({ section: "later", limit: 200, assignedTo: assigneeFilter, sortBy: laterSort.sortBy, sortDir: laterSort.sortDir });
  const { tasks: completedTasks, loading: completedLoading, error: completedError, refetch: refetchCompleted } = useTasks({ section: "completed", limit: 20, assignedTo: assigneeFilter, sortBy: completedSort.sortBy, sortDir: completedSort.sortDir });
  const { task: linkedTask, loading: linkedTaskLoading, error: linkedTaskError, refetch: refetchLinkedTask } = useTask(taskId);

  const groupLoading: Record<GroupKey, boolean> = {
    overdue: overdueLoading,
    today: todayLoading,
    this_week: thisWeekLoading,
    later: laterLoading,
    completed: completedLoading,
  };
  const loading = countsLoading || overdueLoading || todayLoading || thisWeekLoading || laterLoading || completedLoading || linkedTaskLoading;
  const error = linkedTaskError ?? overdueError ?? todayError ?? thisWeekError ?? laterError ?? completedError;

  const updateAssignee = (assigneeId: string) => {
    const next = new URLSearchParams(searchParams);
    if (assigneeId) next.set("assignee", assigneeId);
    else next.delete("assignee");
    setSearchParams(next);
  };

  const refetchAll = () => {
    refetchCounts();
    refetchOverdue();
    refetchToday();
    refetchThisWeek();
    refetchLater();
    refetchCompleted();
    refetchLinkedTask();
  };

  const grouped = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const matches = (task: Task) => {
      if (!normalizedQuery) return true;
      return [task.title, task.description, task.dealName, task.dealNumber, task.assignedToName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedQuery));
    };

    // Server already sorted each bucket; search only filters (never reorders), so the
    // server-chosen order is preserved.
    return {
      overdue: overdueTasks.filter(matches),
      today: todayTasks.filter(matches),
      this_week: thisWeekTasks.filter(matches),
      later: laterTasks.filter(matches),
      completed: completedTasks.filter(matches),
    } satisfies Record<GroupKey, Task[]>;
  }, [completedTasks, overdueTasks, query, laterTasks, todayTasks, thisWeekTasks]);

  // Authoritative, server-computed count — independent of the Completed bucket's sort/limit.
  const completedThisWeek = counts.completedThisWeek;
  // While a scope (assignee) swap is in flight the loaded counts belong to the previous assignee —
  // show a placeholder rather than another assignee's numbers.
  const cardValue = (value: number) => (countsStale ? "—" : String(value));

  // Whole-page loader only on the very first load. Subsequent refetches don't blank the page: a
  // sort refetch keeps each bucket's rows (header shows an inline spinner), and a scope (assignee)
  // change can't leave stale interactive rows because useTasks drops the previous scope's rows
  // synchronously — so the buckets simply reload (empty → "Loading…") instead of showing old rows.
  const [hasResolvedOnce, setHasResolvedOnce] = useState(false);
  useEffect(() => {
    if (!loading) setHasResolvedOnce(true);
  }, [loading]);
  const showInitialLoading = loading && !hasResolvedOnce;

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-brand-red">
            Workflow control
          </p>
          <h1 className="mt-2 text-4xl font-black uppercase leading-none tracking-tight text-slate-950">
            Tasks
          </h1>
          <p className="mt-2 max-w-2xl text-sm font-medium text-slate-500">
            Grouped operating list for due work, scheduled follow-ups, and recently completed tasks.
          </p>
        </div>
        <TaskCreateDialog onCreated={refetchAll} />
      </section>

      {taskId && linkedTask ? (
        <section className="overflow-hidden rounded-lg border border-brand-red/30 bg-white">
          <div className="border-b border-brand-red/20 bg-brand-red/5 px-4 py-3">
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-brand-red">Linked task</p>
          </div>
          <TaskRow task={linkedTask} onUpdate={refetchAll} />
        </section>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard eyebrow="Overdue" value={cardValue(counts.overdue)} badge="Red path" caption="Past due" tone={!countsStale && counts.overdue > 0 ? "red" : "white"} accent="red" />
        <MetricCard eyebrow="Due today" value={cardValue(counts.today)} badge="Today" caption="Current work" tone="white" accent="red" />
        <MetricCard eyebrow="Completed this week" value={cardValue(completedThisWeek)} badge="Done" caption="Last 7 days" tone="green" accent="green" />
      </div>

      <section className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search tasks"
              className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm font-medium text-slate-900 outline-none focus:border-brand-red focus:ring-2 focus:ring-brand-red/20"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {canAssign ? (
              <AssigneeFilter selectedAssignee={selectedAssignee} onChange={updateAssignee} />
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={refetchAll}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        </div>
      </section>

      {error ? (
        <div className="rounded-lg border border-brand-red/20 bg-brand-red/5 p-4 text-sm font-semibold text-brand-red">
          {error}
        </div>
      ) : null}

      {showInitialLoading ? (
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-sm font-semibold text-slate-500">
          Loading tasks...
        </div>
      ) : (
        <div className="space-y-4">
          {(Object.keys(GROUP_META) as GroupKey[]).map((groupKey) => (
            <TaskGroup
              key={groupKey}
              groupKey={groupKey}
              tasks={grouped[groupKey]}
              onUpdate={refetchAll}
              sortValue={sortByGroup[groupKey]}
              onSortChange={setGroupSort(groupKey)}
              loading={groupLoading[groupKey]}
            />
          ))}
        </div>
      )}
    </div>
  );
}
