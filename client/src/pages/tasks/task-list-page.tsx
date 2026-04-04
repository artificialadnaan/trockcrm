import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Check,
  Clock,
  ChevronDown,
  Mail,
  Pencil,
  User,
  Users,
  X,
} from "lucide-react";
import { useTasks, useTaskCounts, completeTask, dismissTask, snoozeTask } from "@/hooks/use-tasks";
import type { Task } from "@/hooks/use-tasks";
import { TaskCreateDialog } from "@/components/tasks/task-create-dialog";
import { TaskEditDialog } from "@/components/tasks/task-edit-dialog";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type FilterKey = "all" | "critical" | "pending" | "overdue" | "completed";
type SortKey = "dueDate" | "priority" | "title";

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "critical", label: "Critical Path" },
  { key: "pending", label: "Pending Review" },
  { key: "overdue", label: "Overdue" },
  { key: "completed", label: "Completed" },
];

const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: "dueDate", label: "Due Date" },
  { key: "priority", label: "Priority" },
  { key: "title", label: "Title" },
];

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function daysOverdue(dueDate: string): number {
  const due = new Date(dueDate + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((now.getTime() - due.getTime()) / 86400000));
}

function formatDueDate(dueDate: string): string {
  return new Date(dueDate + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusDot({ task }: { task: Task }) {
  const isCompleted = task.status === "completed" || task.status === "dismissed";
  if (isCompleted) {
    return <span className="h-2.5 w-2.5 rounded-full bg-green-500 shrink-0" />;
  }
  if (task.isOverdue) {
    return <span className="h-2.5 w-2.5 rounded-full bg-[#CC0000] shrink-0" />;
  }
  return <span className="h-2.5 w-2.5 rounded-full bg-amber-400 shrink-0" />;
}

function PriorityPill({ priority }: { priority: string }) {
  const styles: Record<string, string> = {
    urgent: "bg-[#CC0000] text-white",
    high: "bg-zinc-700 text-white",
    normal: "bg-zinc-200 text-zinc-700",
    low: "bg-green-100 text-green-800",
  };
  const labels: Record<string, string> = {
    urgent: "Critical",
    high: "High",
    normal: "Medium",
    low: "Low",
  };
  return (
    <span
      className={`inline-block px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded-sm ${styles[priority] ?? "bg-zinc-200 text-zinc-700"}`}
    >
      {labels[priority] ?? priority}
    </span>
  );
}

function AssigneeAvatar({ name }: { name: string | null }) {
  if (!name) {
    return (
      <div className="h-8 w-8 rounded-full bg-zinc-200 flex items-center justify-center">
        <User className="h-3.5 w-3.5 text-zinc-500" />
      </div>
    );
  }
  return (
    <div className="h-8 w-8 rounded-full bg-zinc-800 text-white flex items-center justify-center text-[10px] font-bold tracking-wider">
      {getInitials(name)}
    </div>
  );
}

const typeIcons: Record<string, React.ReactNode> = {
  follow_up: <Clock className="h-3 w-3" />,
  stale_deal: <AlertTriangle className="h-3 w-3" />,
  inbound_email: <Mail className="h-3 w-3" />,
  touchpoint: <Users className="h-3 w-3" />,
  manual: <Pencil className="h-3 w-3" />,
};

// ---------------------------------------------------------------------------
// Task Row
// ---------------------------------------------------------------------------

function IndustrialTaskRow({
  task,
  onUpdate,
}: {
  task: Task;
  onUpdate: () => void;
}) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const isCompleted = task.status === "completed" || task.status === "dismissed";
  const overdueDays = task.dueDate && task.isOverdue ? daysOverdue(task.dueDate) : 0;

  const handleComplete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setLoading(true);
    try {
      await completeTask(task.id);
      onUpdate();
    } catch (err) {
      console.error("Failed to complete task:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleDismiss = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setLoading(true);
    try {
      await dismissTask(task.id);
      onUpdate();
    } catch (err) {
      console.error("Failed to dismiss task:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleSnooze = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
    setLoading(true);
    try {
      await snoozeTask(task.id, tomorrow);
      onUpdate();
    } catch (err) {
      console.error("Failed to snooze task:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleClick = () => {
    setEditOpen(true);
  };

  const handleNavigate = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (task.dealId) navigate(`/deals/${task.dealId}`);
    else if (task.contactId) navigate(`/contacts/${task.contactId}`);
    else if (task.emailId) navigate("/email");
  };

  return (
    <>
    <div
      onClick={handleClick}
      className={`grid grid-cols-12 items-center gap-4 px-4 py-3 cursor-pointer transition-all group ${
        isCompleted
          ? "bg-gray-50 opacity-60"
          : task.isOverdue
            ? "bg-white border-l-4 border-l-[#CC0000] hover:bg-red-50/30"
            : "bg-gray-50/70 hover:bg-gray-100/80 border-l-4 border-l-transparent"
      }`}
    >
      {/* Identifier & Description — col-span-6 */}
      <div className="col-span-6 flex items-start gap-3 min-w-0">
        <div className="mt-1.5">
          <StatusDot task={task} />
        </div>
        <div className="min-w-0 flex-1">
          <p
            className={`text-sm font-bold text-gray-900 truncate leading-tight ${
              isCompleted ? "line-through text-gray-500" : ""
            }`}
          >
            {isCompleted && <Check className="inline h-3.5 w-3.5 text-green-600 mr-1 -mt-0.5" />}
            {task.title}
          </p>
          {task.description && (
            <p className="text-xs text-gray-500 truncate mt-0.5">{task.description}</p>
          )}
          <div className="flex items-center gap-2 mt-1">
            {task.dealId && (
              <span className="text-[10px] font-mono bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded-sm tracking-wide">
                DEAL
              </span>
            )}
            {task.contactId && (
              <span className="text-[10px] font-mono bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded-sm tracking-wide">
                CONTACT
              </span>
            )}
            <span className="text-[10px] font-mono text-gray-400 uppercase tracking-wide flex items-center gap-1">
              {typeIcons[task.type]}
              {task.type.replace(/_/g, " ")}
            </span>
          </div>
        </div>
      </div>

      {/* Priority — col-span-2 */}
      <div className="col-span-2 flex justify-center">
        <PriorityPill priority={task.priority} />
      </div>

      {/* Timeline — col-span-2 */}
      <div className="col-span-2">
        {isCompleted ? (
          <span className="text-xs font-bold text-green-600 uppercase tracking-wider">
            Completed
          </span>
        ) : task.dueDate ? (
          <div>
            <p className={`text-sm font-bold ${task.isOverdue ? "text-[#CC0000]" : "text-gray-900"}`}>
              {formatDueDate(task.dueDate)}
            </p>
            {task.isOverdue && overdueDays > 0 && (
              <p className="text-[10px] font-bold text-[#CC0000] uppercase tracking-wider mt-0.5">
                Overdue {overdueDays}d
              </p>
            )}
          </div>
        ) : (
          <span className="text-xs text-gray-400">No date</span>
        )}
      </div>

      {/* Assigned To — col-span-2 */}
      <div className="col-span-2 flex items-center justify-end gap-2">
        {!isCompleted && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity mr-1">
            <button
              onClick={handleComplete}
              disabled={loading}
              className="h-6 w-6 rounded flex items-center justify-center hover:bg-green-100 transition-colors"
              title="Complete"
            >
              <Check className="h-3 w-3 text-green-600" />
            </button>
            <button
              onClick={handleSnooze}
              disabled={loading}
              className="h-6 w-6 rounded flex items-center justify-center hover:bg-amber-100 transition-colors"
              title="Snooze"
            >
              <Clock className="h-3 w-3 text-amber-600" />
            </button>
            <button
              onClick={handleDismiss}
              disabled={loading}
              className="h-6 w-6 rounded flex items-center justify-center hover:bg-gray-200 transition-colors"
              title="Dismiss"
            >
              <X className="h-3 w-3 text-gray-400" />
            </button>
          </div>
        )}
        {(task.dealId || task.contactId || task.emailId) && (
          <button
            onClick={handleNavigate}
            className="h-6 w-6 rounded flex items-center justify-center hover:bg-blue-100 transition-colors opacity-0 group-hover:opacity-100"
            title="Go to linked record"
          >
            <Pencil className="h-3 w-3 text-blue-500" />
          </button>
        )}
        <AssigneeAvatar name={task.assignedToName} />
      </div>
    </div>
    <TaskEditDialog task={task} open={editOpen} onOpenChange={setEditOpen} onUpdated={onUpdate} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function TaskListPage() {
  const navigate = useNavigate();
  const { counts, refetch: refetchCounts } = useTaskCounts();

  const { tasks: overdueTasks, refetch: refetchOverdue } = useTasks({ section: "overdue" });
  const { tasks: todayTasks, refetch: refetchToday } = useTasks({ section: "today" });
  const { tasks: upcomingTasks, refetch: refetchUpcoming } = useTasks({ section: "upcoming" });
  const { tasks: completedTasks, refetch: refetchCompleted } = useTasks({
    section: "completed",
    limit: 20,
  });

  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [sortBy, setSortBy] = useState<SortKey>("dueDate");
  const [sortOpen, setSortOpen] = useState(false);

  const refetchAll = () => {
    refetchCounts();
    refetchOverdue();
    refetchToday();
    refetchUpcoming();
    refetchCompleted();
  };

  // Merge all active tasks for filtering
  const allActiveTasks = useMemo(
    () => [...overdueTasks, ...todayTasks, ...upcomingTasks],
    [overdueTasks, todayTasks, upcomingTasks],
  );

  // Apply filter
  const filteredTasks = useMemo(() => {
    let source: Task[];
    switch (activeFilter) {
      case "critical":
        source = allActiveTasks.filter((t) => t.priority === "urgent");
        break;
      case "pending":
        source = allActiveTasks.filter((t) => t.status === "pending");
        break;
      case "overdue":
        source = allActiveTasks.filter((t) => t.isOverdue);
        break;
      case "completed":
        source = completedTasks;
        break;
      default:
        source = allActiveTasks;
    }
    return source;
  }, [activeFilter, allActiveTasks, completedTasks]);

  // Apply sort
  const sortedTasks = useMemo(() => {
    const copy = [...filteredTasks];
    switch (sortBy) {
      case "dueDate":
        copy.sort((a, b) => {
          if (!a.dueDate && !b.dueDate) return 0;
          if (!a.dueDate) return 1;
          if (!b.dueDate) return -1;
          return a.dueDate.localeCompare(b.dueDate);
        });
        break;
      case "priority":
        copy.sort(
          (a, b) => (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99),
        );
        break;
      case "title":
        copy.sort((a, b) => a.title.localeCompare(b.title));
        break;
    }
    return copy;
  }, [filteredTasks, sortBy]);

  const totalActive = counts.overdue + counts.today + counts.upcoming;

  // Top 3 overdue for alert panel
  const topOverdue = useMemo(
    () =>
      [...overdueTasks]
        .sort((a, b) => {
          const aDays = a.dueDate ? daysOverdue(a.dueDate) : 0;
          const bDays = b.dueDate ? daysOverdue(b.dueDate) : 0;
          return bDays - aDays;
        })
        .slice(0, 3),
    [overdueTasks],
  );

  // Workload utilization (simple: active / (active + completed) )
  const totalAll = totalActive + counts.completed;
  const utilizationPct = totalAll > 0 ? Math.round((totalActive / totalAll) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold text-[#CC0000] uppercase tracking-[0.2em] mb-1">
            System Operations
          </p>
          <h1 className="text-4xl font-extrabold tracking-tight text-gray-900 leading-none">
            Tasks & Deliverables
          </h1>
          <div className="flex items-center gap-4 mt-2">
            <div className="flex items-center gap-6 text-[11px] uppercase tracking-widest font-mono text-gray-500">
              <span>
                <span className="text-gray-900 font-bold text-sm">{totalActive}</span> Active
              </span>
              <span>
                <span className="text-[#CC0000] font-bold text-sm">{counts.overdue}</span> Overdue
              </span>
              <span>
                <span className="text-green-600 font-bold text-sm">{counts.completed}</span> Done
              </span>
            </div>
          </div>
        </div>
        <TaskCreateDialog onCreated={refetchAll} />
      </div>

      {/* ── 12-Column Grid ── */}
      <div className="grid grid-cols-12 gap-6">
        {/* ── Left Column: Filters + Table (8 cols) ── */}
        <div className="col-span-12 lg:col-span-8 space-y-4">
          {/* Filter Bar */}
          <div className="flex items-center justify-between bg-gray-100 rounded-lg p-1.5">
            <div className="flex items-center gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setActiveFilter(f.key)}
                  className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-all ${
                    activeFilter === f.key
                      ? "bg-white text-gray-900 shadow-sm"
                      : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {f.label}
                  {f.key === "overdue" && counts.overdue > 0 && (
                    <span className="ml-1.5 bg-[#CC0000] text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">
                      {counts.overdue}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Sort Dropdown */}
            <div className="relative">
              <button
                onClick={() => setSortOpen(!sortOpen)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-gray-500 hover:text-gray-700 rounded-md hover:bg-gray-50 transition-all"
              >
                Sort By: {SORT_OPTIONS.find((s) => s.key === sortBy)?.label}
                <ChevronDown className="h-3 w-3" />
              </button>
              {sortOpen && (
                <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1 min-w-[140px]">
                  {SORT_OPTIONS.map((opt) => (
                    <button
                      key={opt.key}
                      onClick={() => {
                        setSortBy(opt.key);
                        setSortOpen(false);
                      }}
                      className={`block w-full text-left px-3 py-1.5 text-xs font-medium transition-colors ${
                        sortBy === opt.key
                          ? "bg-gray-100 text-gray-900"
                          : "text-gray-600 hover:bg-gray-50"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Table Header */}
          <div className="grid grid-cols-12 gap-4 px-4 py-2 text-[10px] font-bold text-gray-400 uppercase tracking-[0.15em] border-b border-gray-200">
            <div className="col-span-6">Identifier & Description</div>
            <div className="col-span-2 text-center">Priority</div>
            <div className="col-span-2">Timeline</div>
            <div className="col-span-2 text-right">Assigned To</div>
          </div>

          {/* Task Rows */}
          <div className="space-y-1">
            {activeFilter === "all" ? (
              <>
                {overdueTasks.length === 0 && todayTasks.length === 0 && upcomingTasks.length === 0 ? (
                  <div className="text-center py-12 text-gray-400">
                    <p className="text-sm font-medium">No tasks match this filter</p>
                  </div>
                ) : (
                  <>
                    {overdueTasks.length > 0 && (
                      <>
                        <div className="px-6 py-2 bg-red-50/50 text-[10px] font-black uppercase tracking-[0.15em] text-gray-500 flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-red-500" />
                          Overdue ({overdueTasks.length})
                        </div>
                        {overdueTasks.map((task) => (
                          <IndustrialTaskRow key={task.id} task={task} onUpdate={refetchAll} />
                        ))}
                      </>
                    )}
                    {todayTasks.length > 0 && (
                      <>
                        <div className="px-6 py-2 bg-amber-50/50 text-[10px] font-black uppercase tracking-[0.15em] text-gray-500 flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-amber-400" />
                          Today ({todayTasks.length})
                        </div>
                        {todayTasks.map((task) => (
                          <IndustrialTaskRow key={task.id} task={task} onUpdate={refetchAll} />
                        ))}
                      </>
                    )}
                    {upcomingTasks.length > 0 && (
                      <>
                        <div className="px-6 py-2 bg-gray-50/80 text-[10px] font-black uppercase tracking-[0.15em] text-gray-500 flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-gray-400" />
                          Upcoming ({upcomingTasks.length})
                        </div>
                        {upcomingTasks.map((task) => (
                          <IndustrialTaskRow key={task.id} task={task} onUpdate={refetchAll} />
                        ))}
                      </>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                {sortedTasks.length === 0 ? (
                  <div className="text-center py-12 text-gray-400">
                    <p className="text-sm font-medium">No tasks match this filter</p>
                  </div>
                ) : (
                  sortedTasks.map((task) => (
                    <IndustrialTaskRow key={task.id} task={task} onUpdate={refetchAll} />
                  ))
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Right Sidebar (4 cols) ── */}
        <div className="col-span-12 lg:col-span-4 space-y-4">
          {/* Operational Alert Card */}
          {counts.overdue > 0 && (
            <div className="bg-[#CC0000] rounded-lg p-5 text-white">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="h-4 w-4" />
                <h3 className="text-xs font-bold uppercase tracking-[0.15em]">
                  Operational Alert
                </h3>
              </div>
              <p className="text-sm font-medium leading-snug mb-4">
                {counts.overdue} critical path deliverable{counts.overdue !== 1 ? "s" : ""} currently
                overdue
              </p>
              <div className="space-y-2">
                {topOverdue.map((t) => (
                  <div
                    key={t.id}
                    onClick={() => {
                      if (t.dealId) navigate(`/deals/${t.dealId}`);
                      else if (t.contactId) navigate(`/contacts/${t.contactId}`);
                    }}
                    className="flex items-center justify-between bg-white/10 rounded px-3 py-2 cursor-pointer hover:bg-white/20 transition-colors"
                  >
                    <p className="text-xs font-medium truncate flex-1 mr-2">{t.title}</p>
                    <span className="text-[10px] font-bold bg-white/20 px-2 py-0.5 rounded shrink-0">
                      -{t.dueDate ? daysOverdue(t.dueDate) : 0} Days
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Workload Capacity Card */}
          <div className="bg-gray-50 rounded-lg p-5 border border-gray-200">
            <h3 className="text-xs font-bold text-gray-400 uppercase tracking-[0.15em] mb-4">
              Workload Capacity
            </h3>

            <div className="space-y-4">
              {/* Active */}
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Active
                </span>
                <span className="text-3xl font-black text-gray-900 tabular-nums leading-none">
                  {totalActive}
                </span>
              </div>

              {/* Pending */}
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Pending
                </span>
                <span className="text-xl font-bold text-amber-600 tabular-nums leading-none">
                  {counts.today + counts.upcoming}
                </span>
              </div>

              {/* Completed (last 7d) */}
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Completed (7d)
                </span>
                <span className="text-xl font-bold text-green-600 tabular-nums leading-none">
                  {counts.completed}
                </span>
              </div>

              {/* Utilization bar */}
              <div className="pt-2 border-t border-gray-200">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                    Utilization
                  </span>
                  <span className="text-xs font-bold text-gray-700">{utilizationPct}%</span>
                </div>
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      utilizationPct > 80 ? "bg-[#CC0000]" : utilizationPct > 50 ? "bg-amber-500" : "bg-green-500"
                    }`}
                    style={{ width: `${utilizationPct}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
