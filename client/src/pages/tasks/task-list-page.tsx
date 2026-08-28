import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock,
  ExternalLink,
  FileText,
  Flag,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Phone,
  RefreshCw,
  Search,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MetricCard } from "@/components/shared/metric-card";
import { ScopeToggle, type ScopeToggleOption } from "@/components/shared/scope-toggle";
import {
  completeTask,
  getTaskStatusLabel,
  isTerminalTaskStatus,
  snoozeTask,
  useTaskCounts,
  useTask,
  useTasks,
  useTasksAwaitingMe,
  isTaskSource,
  type Task,
  type TaskSortBy,
  type TaskSortDir,
  type TaskSource,
} from "@/hooks/use-tasks";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { TaskCreateDialog } from "@/components/tasks/task-create-dialog";
import { TaskEditDialog } from "@/components/tasks/task-edit-dialog";
import { TaskConversationDrawer } from "@/components/tasks/task-conversation-drawer";
import { TaskProjectLink } from "@/components/tasks/task-project-link";
import { TaskResolutionDialog } from "@/components/tasks/task-resolution-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { sanitizeHubspotDealIdentifiers } from "@/lib/deal-utils";
import { appendOfficeIdSearch } from "@/lib/office-selection";
import { getTaskProjectContext } from "@/lib/task-project-context";
import { toast } from "sonner";

type GroupKey = "overdue" | "today" | "this_week" | "later" | "completed";

/**
 * "Show everyone", said out loud.
 *
 * Both filters now DEFAULT to something, so absence of the parameter means "the default" and can no
 * longer double as "no filter". Expressing All by deleting the param — which is what both controls
 * used to do — would let the default re-apply on the very next render and make the All option
 * unclickable. The sentinel is the whole reason the defaults are safe.
 */
const ALL_ASSIGNEES_VALUE = "all";
const ALL_SOURCES_VALUE = "all";

/** The tab the Tasks page opens on. See useTaskSourceFilter. */
const DEFAULT_TASK_SOURCE: TaskSource = "manual";

/**
 * Task types that say nothing a reader does not already know.
 *
 * `task.type` is the ACTIVITY kind — call, email, meeting, follow_up. On a hand-typed task it is the
 * literal string "manual", and on a couple of machine paths it is "system"; rendering either put the
 * word "Manual" on the row directly beneath a Manual/Automated tab that means something completely
 * different. Suppressing them costs nothing: the source badge and the status chip beside it carry the
 * information those two values were being read for.
 */
const UNINFORMATIVE_TASK_TYPES = new Set(["manual", "system", "other"]);

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

// Re-exported, not redefined: the row and the detail drawer must label a task's project identically,
// and the definition moved to @/lib/task-project-context so both can import the one copy. This export
// keeps the existing import path (and its suites) working.
export { getTaskProjectContext };

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

function TaskRow({
  task,
  onUpdate,
  refreshing = false,
  showUnreadReplies = false,
}: {
  task: Task;
  onUpdate: () => void;
  refreshing?: boolean;
  /**
   * Render the "N replies" affordance. Passed in rather than derived from the row, because the
   * affordance is only meaningful to the ASSIGNER — an unread marker on the assignee's own list would
   * be telling them about their own reply. The Needs-your-attention bucket is scoped to
   * `created_by = me` server-side, which is the only place it is true by construction.
   */
  showUnreadReplies?: boolean;
}) {
  const navigate = useNavigate();
  // The ROUTER's location, not window.location — they diverge under a MemoryRouter and, more to the
  // point, the router is the authority for where the app actually is.
  const { search } = useLocation();
  const [editOpen, setEditOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // While the bucket is refetching (e.g. right after this row's own complete/snooze), these rows are
  // stale until fresh data lands — lock their mutating actions so a just-resolved row can't be
  // re-acted on. The edit dialog, once open, stays open (its own submit is independently guarded).
  const locked = busy || refreshing;
  const isDone = isTerminalTaskStatus(task.status);
  const Icon = TYPE_ICONS[task.type] ?? MoreHorizontal;
  const taskTitle = sanitizeHubspotDealIdentifiers(task.title);

  // Office context is URL-driven (lib/api reads ?officeId and sends x-office-id), so an in-app link
  // that drops it resolves the record against the READER's own office. Carried on both the project
  // link and the linked-record action for that reason — see TaskProjectLink.
  const officeId = new URLSearchParams(search).get("officeId")?.trim() || null;
  const linkedRecordHref = task.dealId
    ? appendOfficeIdSearch(`/deals/${task.dealId}`, officeId)
    : task.contactId
      ? appendOfficeIdSearch(`/contacts/${task.contactId}`, officeId)
      : task.emailId
        ? appendOfficeIdSearch("/email", officeId)
        : null;

  const openComplete = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (locked || isDone || !mayClose) return;
    setCompleteOpen(true);
  };

  const complete = async (resolutionNote: string) => {
    setBusy(true);
    try {
      await completeTask(task.id, resolutionNote);
      onUpdate();
    } catch (error) {
      console.error("[tasks] complete failed", error);
      throw error;
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

  const openEdit = () => {
    if (isDone || refreshing) return;
    setEditOpen(true);
  };

  /**
   * The whole row opens the editor — EXCEPT when the click came from something that already does
   * its own thing.
   *
   * The row used to BE a <button>, which is why the project name could only ever be text: an <a>
   * inside a <button> is invalid HTML and every browser resolves it differently. Moving the handler
   * onto the container is what makes a real link possible while keeping the full-width click target.
   *
   * The container is deliberately NOT focusable and carries no role: the title button below is the
   * keyboard affordance, so there is exactly one tab stop per row and nothing is announced twice.
   */
  const handleRowClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("a,button,input,select,textarea,[role='dialog']")) return;
    openEdit();
  };

  // Navigates rather than opening local state, so the URL the emails deep-link to and the URL a click
  // produces are the same one — /tasks/<id> is the task's address, and the drawer just renders it.
  //
  // The query string rides along. Opening a conversation from a `?source=`/`?assignee=` filtered list
  // and landing back on an unfiltered one destroys the triage context the drawer exists to preserve —
  // and `?officeId` is load-bearing besides: dropping it re-resolves the tenant from the reader's
  // home office and 404s a cross-office task.
  const openConversation = (event: React.MouseEvent) => {
    event.stopPropagation();
    // ...except `complete`, which is the one parameter that names a TASK rather than a view. It arrives
    // from a specific task's emailed "Mark complete" link, and carrying it to a different task focuses
    // and highlights that task's close action as though the email had asked for it. The other params
    // describe where the reader is; this one describes what they were asked to do, and about what.
    const carried = new URLSearchParams(search);
    carried.delete("complete");
    const query = carried.toString();
    navigate(`/tasks/${task.id}${query ? `?${query}` : ""}`);
  };

  const unreadReplies = showUnreadReplies ? task.unreadReplyCount ?? 0 : 0;
  // The SERVER's verdict. `undefined` (an API predating the field) stays permissive so a deploy
  // window cannot disable every row; the server refuses what it refuses either way.
  const mayClose = task.canClose !== false;

  return (
    <>
      <div
        data-testid="task-row"
        onClick={handleRowClick}
        className={cn(
          "group grid gap-3 border-b border-slate-100 bg-white px-4 py-3 transition-colors md:grid-cols-[32px_minmax(0,1fr)_120px_130px_150px_96px]",
          isDone ? "opacity-65" : "cursor-pointer hover:bg-slate-50"
        )}
      >
        <button
          type="button"
          disabled={locked || isDone || !mayClose}
          onClick={openComplete}
          onKeyDown={stopRowKeyDownPropagation}
          aria-label={`Complete ${taskTitle}`}
          // Named, not merely greyed: a disabled control with no explanation reads as a bug.
          title={mayClose ? undefined : "Only the assignee, the person who assigned this task, or an admin can close it"}
          className={cn(
            "mt-1 flex h-6 w-6 items-center justify-center rounded border-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red",
            isDone ? "border-emerald-600 bg-emerald-600 text-white" : "border-slate-300 text-slate-300 hover:border-emerald-600 hover:text-emerald-600"
          )}
        >
          <Check className="h-3.5 w-3.5" />
        </button>

        {/*
          NOT a <button> any more. It used to be one, spanning all four of these cells — which is
          exactly why the project could only ever be plain text, since an <a> inside a <button> is
          invalid HTML. The click target lives on the row container now; this is a plain grid subtree.
        */}
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600">
              <Icon className="h-3.5 w-3.5" />
            </span>
            {/*
              The one tab stop on the row, and the keyboard route to the editor.

              The explicit keydown handler is not redundant with the browser's native Enter-activates-
              a-button behaviour: Space on a button SCROLLS unless preventDefault is called, and the
              suite drives these rows with synthetic KeyboardEvents, which never synthesize a click.
            */}
            <button
              type="button"
              data-testid="task-row-content"
              disabled={isDone || refreshing}
              onClick={openEdit}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                // The row container's click handler already ignores anything that came from a button,
                // so this cannot double-fire; stopping propagation keeps that true for keydown too.
                event.stopPropagation();
                openEdit();
              }}
              className={cn(
                "min-w-0 truncate rounded text-left text-sm font-black text-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red",
                isDone ? "cursor-default text-slate-500 line-through" : "cursor-pointer"
              )}
            >
              {taskTitle}
            </button>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-9 text-xs font-semibold text-slate-500">
            {/*
              `task.type` is the ACTIVITY kind (call, email, meeting…). On a hand-typed task it is the
              literal string "manual", which used to render right next to a Manual/Automated tab that
              means something entirely different — two identical words, neither describing the other.
              Show the type only when it carries information, and say "Automated" only when it is true.
            */}
            {UNINFORMATIVE_TASK_TYPES.has(task.type) ? null : (
              <span className="capitalize">{typeLabel(task.type)}</span>
            )}
            {task.source === "automated" ? (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-black uppercase tracking-wide text-slate-500">
                Automated
              </span>
            ) : null}
            <span>{getTaskStatusLabel(task.status)}</span>
            <TaskProjectLink task={task} officeId={officeId} />
            {unreadReplies > 0 ? (
              <span className="flex items-center gap-1.5 font-black text-brand-red">
                <span className="h-2 w-2 rounded-full bg-brand-red" aria-hidden />
                {unreadReplies} {unreadReplies === 1 ? "reply" : "replies"}
              </span>
            ) : null}
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

        <div className="flex items-center justify-end gap-1 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
          {/* Available on EVERY row, including completed ones: a reply to a task that was closed
              before the answer arrived is exactly the sequence the loop exists to record. */}
          <button
            type="button"
            onClick={openConversation}
            onKeyDown={stopRowKeyDownPropagation}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-md hover:bg-slate-100",
              unreadReplies > 0 ? "text-brand-red" : "text-slate-400 hover:text-slate-700"
            )}
            aria-label={`Open the conversation for ${taskTitle}`}
          >
            <MessageSquare className="h-4 w-4" />
          </button>
          {!isDone ? (
            <button
              type="button"
              disabled={locked}
              onClick={snooze}
              onKeyDown={stopRowKeyDownPropagation}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-amber-50 hover:text-amber-600"
              aria-label={`Snooze ${taskTitle}`}
            >
              <Clock className="h-4 w-4" />
            </button>
          ) : null}
          {/*
            An ANCHOR now, not a button, and it opens a new tab. It was drawn with a RefreshCw glyph —
            the universal "reload" icon — on a control that navigates, and it replaced the page you
            were triaging from. Both were wrong in the same direction.
          */}
          {linkedRecordHref ? (
            <a
              href={linkedRecordHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-blue-50 hover:text-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
              aria-label={`Open linked record for ${taskTitle} in a new tab`}
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          ) : null}
        </div>
      </div>
      <TaskEditDialog task={task} open={editOpen} onOpenChange={setEditOpen} onUpdated={onUpdate} />
      <TaskResolutionDialog
        action="complete"
        taskTitle={taskTitle}
        open={completeOpen}
        onOpenChange={setCompleteOpen}
        onResolve={complete}
      />
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
            tasks.map((task) => <TaskRow key={task.id} task={task} onUpdate={onUpdate} refreshing={loading} />)
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

const MY_TASKS_LABEL = "Assigned to me";
const EVERYONE_LABEL = "Everyone";

/**
 * Who the list is scoped to, defaulting to YOU.
 *
 * The page used to open on every task in the office — 15,409 of them, 99.7% machine-generated — with
 * the assignee control sitting on "All assignees". Opening on your own work is the whole of the ask
 * and needs no interaction to get there.
 *
 * `me` is pinned to the top and labelled rather than shown as the user's own name: a trigger that
 * reads "Adam Shaw" makes the reader recognise themselves before they can tell what the list is
 * showing, and gets it wrong the moment two people share a first name.
 */
function AssigneeFilter({
  selection,
  currentUserId,
  onChange,
}: {
  /** `"all"` or a user id. Never empty — absence of a URL param means the current user, not everyone. */
  selection: string;
  currentUserId: string;
  onChange: (value: string) => void;
}) {
  const { assignees, loading } = useTaskAssignees();
  const others = assignees.filter((assignee) => assignee.id !== currentUserId);

  // Base UI resolves the trigger's label from `items`, NOT from the SelectItem children — omit it and
  // the trigger renders the raw value, which for an assignee is a bare uuid. Built from the same
  // arrays the items below are rendered from so the two cannot drift.
  const items = [
    { value: currentUserId, label: MY_TASKS_LABEL },
    { value: ALL_ASSIGNEES_VALUE, label: EVERYONE_LABEL },
    ...others.map((assignee) => ({ value: assignee.id, label: assignee.displayName })),
  ];
  const selectedLabel = items.find((item) => item.value === selection)?.label ?? "Selected assignee";

  return (
    <div data-testid="assignee-filter" className="flex items-center gap-2">
      <label htmlFor="task-assignee-filter" className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
        Assignee
      </label>
      <Select
        items={items}
        value={selection}
        onValueChange={(value) => onChange(value || currentUserId)}
        disabled={loading}
      >
        <SelectTrigger id="task-assignee-filter" className="h-9 w-56 border-slate-200 bg-slate-50">
          <SelectValue>{loading ? "Loading assignees..." : selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={currentUserId}>{MY_TASKS_LABEL}</SelectItem>
          <SelectItem value={ALL_ASSIGNEES_VALUE}>{EVERYONE_LABEL}</SelectItem>
          {others.map((assignee) => (
            <SelectItem key={assignee.id} value={assignee.id}>
              {assignee.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The assignee selection, held in the URL as `?assignee=`, defaulting to the signed-in user.
 *
 * ⚠️ REPS ARE SCOPED BY THE SERVER, NOT BY THIS. `getTasks` narrows `rep` to `assigned_to = me` and
 * IGNORES the filter entirely, as does `getTaskCounts`. So a rep gets no control and no parameter —
 * sending one would be inert, and rendering one would be a lie. Everyone else (including
 * `construction` and `estimator`, who were handed the whole office with no control at all) gets both.
 *
 * Widening the control past admin/director exposes nothing new: `GET /tasks/assignees` has no role
 * gate today, and these roles can already read every task the filter would hide. It only narrows.
 */
export function useTaskAssigneeFilter(role: string, userId: string) {
  const [searchParams, setSearchParams] = useSearchParams();
  const canFilter = role !== "rep";
  const raw = searchParams.get("assignee")?.trim();

  // What the CONTROL shows. Only ever rendered when canFilter, so it does not branch on it — a second
  // copy of the rep rule here would be dead code that makes the real one below untestable.
  const selection = raw === ALL_ASSIGNEES_VALUE ? ALL_ASSIGNEES_VALUE : raw || userId;

  // What actually goes on the wire, and the ONE place the rep rule lives. `undefined` means "don't
  // send the param": for a rep because the server ignores it, for Everyone because there is no filter.
  const assignedTo = !canFilter || selection === ALL_ASSIGNEES_VALUE ? undefined : selection;

  const setAssignee = (next: string) => {
    const params = new URLSearchParams(searchParams);
    // ALWAYS written, never deleted — see ALL_ASSIGNEES_VALUE. Deleting it to mean "everyone" would
    // hand the next render straight back to the default and pin the control on the current user.
    params.set("assignee", next);
    setSearchParams(params);
  };

  return { canFilter, selection, assignedTo, setAssignee };
}

/**
 * The automated/manual tab selection, held in the URL as `?source=`.
 *
 * DELIBERATELY TAKES NO ROLE. The `?assignee=` filter alongside this one is read behind
 * `const canAssign = role === "admin" || role === "director"`, which is right for assignee (a rep has
 * nobody else to filter by) and would be exactly wrong here: reps have the most automated noise in
 * their lists, so gating this would break the filter for the people who need it most. Taking no role
 * argument means it cannot be gated on one by accident.
 *
 * ⚠️ ABSENT NOW MEANS **MANUAL**, NOT ALL. The default view was 15,409 tasks of which 15,360 were
 * machine-generated — a list nobody could use, which is what the tabs were built for in the first
 * place. Opening on the 49 a person actually typed is the ask.
 *
 * Nothing is hidden that cannot be got back in one click, and no URL is rewritten to achieve it: the
 * default is applied by INTERPRETATION at render, so there is no history entry, no redirect flicker,
 * and every `/tasks` link ever mailed keeps working untouched.
 *
 * An unrecognised value falls back to the default rather than to All — unknown means "we don't know
 * what you asked for", and answering that with 15,000 rows is not a kindness.
 */
export function useTaskSourceFilter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("source");

  const selection: "all" | TaskSource =
    raw === ALL_SOURCES_VALUE ? "all" : isTaskSource(raw) ? raw : DEFAULT_TASK_SOURCE;
  const source = selection === "all" ? undefined : selection;

  const setSource = (next: "all" | TaskSource) => {
    const params = new URLSearchParams(searchParams);
    // ALWAYS written, including "all". Deleting the param to mean All is the one change that would
    // make the All tab unclickable: the very next render would read an absent param as the default
    // and snap the selection back to Manual.
    params.set("source", next);
    setSearchParams(params);
  };

  return { selection, source, setSource };
}

/**
 * Tab options for the automated/manual toggle.
 *
 * The counts belong to a SCOPE — the assignee and the tab — and useTaskCounts reports `stale` while a
 * scope swap is in flight. The summary cards already honour that (cardValue renders "—"); these labels
 * must too, or after an assignee change the totals go on describing the previous assignee while the
 * buckets underneath have already switched, indefinitely if the request fails.
 *
 * Counts drop to undefined rather than 0: ScopeToggle renders no number for undefined, whereas 0 would
 * assert the new scope is empty — precisely what is not yet known.
 */
export function buildTaskSourceToggleOptions(
  bySource: { manual: number; automated: number; all: number },
  countsStale: boolean
): ScopeToggleOption<"all" | TaskSource>[] {
  const count = (value: number) => (countsStale ? undefined : value);
  return [
    { value: "all", label: "All", count: count(bySource.all) },
    { value: "manual", label: "Manual", count: count(bySource.manual) },
    { value: "automated", label: "Automated", count: count(bySource.automated) },
  ];
}

/**
 * "Needs your attention" — the tasks YOU assigned that have been answered and not acknowledged.
 *
 * Rendered ABOVE the date buckets and outside the GROUP_META loop, because it is not a date bucket:
 * its rows are assigned to somebody else, are fed by a different endpoint (/tasks/awaiting-me), and
 * are not filtered by the source/assignee controls — the whole point is that they appear NOWHERE in
 * the assigner's own list today, since /tasks scopes reps to `assigned_to = me`.
 *
 * Hidden entirely when empty rather than shown as a zero: a permanently-present empty section trains
 * people to stop looking at it, and this one is only useful when it has something in it.
 */
function NeedsAttentionGroup({
  tasks,
  loading,
  onUpdate,
}: {
  tasks: Task[];
  loading: boolean;
  onUpdate: () => void;
}) {
  if (loading || tasks.length === 0) return null;

  return (
    <section
      data-testid="needs-attention-group"
      className="overflow-hidden rounded-lg border border-brand-red/40 bg-white"
    >
      <div className="flex w-full flex-wrap items-center justify-between gap-3 border-b border-brand-red/20 bg-brand-red/5 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-brand-red" />
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-brand-red">
              You assigned these
            </p>
            <h2 className="text-sm font-black uppercase text-slate-950">Needs your attention</h2>
          </div>
        </div>
        <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-black tabular-nums text-brand-red ring-1 ring-brand-red/30">
          {tasks.length}
        </span>
      </div>
      <div>
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} onUpdate={onUpdate} showUnreadReplies />
        ))}
      </div>
    </section>
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

  return <TaskListPageContent role={user.role} userId={user.id} />;
}

function TaskListPageContent({ role, userId }: { role: string; userId: string }) {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  // Defaults to YOU, and is rendered for every role the server does not already scope — see
  // useTaskAssigneeFilter for why `rep` is the exception rather than the rule.
  const {
    canFilter: canAssign,
    selection: assigneeSelection,
    assignedTo: assigneeFilter,
    setAssignee,
  } = useTaskAssigneeFilter(role, userId);
  // Read for EVERY role — see useTaskSourceFilter. Defaults to Manual.
  const { selection: sourceSelection, source: sourceFilter, setSource } = useTaskSourceFilter();
  // Per-bucket sort selection (ephemeral view preference, kept in local state — not URL).
  const [sortByGroup, setSortByGroup] = useState<Record<GroupKey, string>>(DEFAULT_SORT);
  const setGroupSort = (groupKey: GroupKey) => (value: string) =>
    setSortByGroup((prev) => ({ ...prev, [groupKey]: value }));

  const overdueSort = parseSortValue(sortByGroup.overdue);
  const todaySort = parseSortValue(sortByGroup.today);
  const thisWeekSort = parseSortValue(sortByGroup.this_week);
  const laterSort = parseSortValue(sortByGroup.later);
  const completedSort = parseSortValue(sortByGroup.completed);

  const { counts, loading: countsLoading, stale: countsStale, refetch: refetchCounts } = useTaskCounts(assigneeFilter, sourceFilter);
  // Each displayed bucket is now exactly one server query, sorted server-side over its full set.
  const { tasks: overdueTasks, loading: overdueLoading, error: overdueError, refetch: refetchOverdue } = useTasks({ section: "overdue", source: sourceFilter, assignedTo: assigneeFilter, sortBy: overdueSort.sortBy, sortDir: overdueSort.sortDir });
  const { tasks: todayTasks, loading: todayLoading, error: todayError, refetch: refetchToday } = useTasks({ section: "today", source: sourceFilter, assignedTo: assigneeFilter, sortBy: todaySort.sortBy, sortDir: todaySort.sortDir });
  const { tasks: thisWeekTasks, loading: thisWeekLoading, error: thisWeekError, refetch: refetchThisWeek } = useTasks({ section: "this_week", source: sourceFilter, assignedTo: assigneeFilter, sortBy: thisWeekSort.sortBy, sortDir: thisWeekSort.sortDir });
  // limit 200 preserves the prior display ceiling: "Later" used to be two fetches (scheduled ≤100 +
  // the >7-day tail of upcoming ≤100); it's now a single unified server query. The default sort is by
  // effective date (due_date ?? scheduled_for), so near-term scheduled follow-ups are kept even when
  // the bucket is busy — the limit drops the furthest-out rows, not scheduled tasks categorically.
  const { tasks: laterTasks, loading: laterLoading, error: laterError, refetch: refetchLater } = useTasks({ section: "later", source: sourceFilter, limit: 200, assignedTo: assigneeFilter, sortBy: laterSort.sortBy, sortDir: laterSort.sortDir });
  const { tasks: completedTasks, loading: completedLoading, error: completedError, refetch: refetchCompleted } = useTasks({ section: "completed", source: sourceFilter, limit: 20, assignedTo: assigneeFilter, sortBy: completedSort.sortBy, sortDir: completedSort.sortDir });
  const { task: linkedTask, loading: linkedTaskLoading, error: linkedTaskError, refetch: refetchLinkedTask } = useTask(taskId);
  const {
    tasks: awaitingMeTasks,
    loading: awaitingMeLoading,
    error: awaitingMeError,
    refetch: refetchAwaitingMe,
  } = useTasksAwaitingMe();

  const groupLoading: Record<GroupKey, boolean> = {
    overdue: overdueLoading,
    today: todayLoading,
    this_week: thisWeekLoading,
    later: laterLoading,
    completed: completedLoading,
  };
  const loading = countsLoading || overdueLoading || todayLoading || thisWeekLoading || laterLoading || completedLoading || linkedTaskLoading;
  // awaitingMeError is FIRST, and that ordering is the point. NeedsAttentionGroup hides itself when
  // it has nothing, so a failed /tasks/awaiting-me renders byte-identically to "nothing needs you" —
  // the assigner is told they are clear when the truth is that we could not find out. Silence and
  // zero must never look the same on a surface whose whole job is to say what is waiting.
  const error =
    awaitingMeError ?? linkedTaskError ?? overdueError ?? todayError ?? thisWeekError ?? laterError ?? completedError;

  const refetchAll = () => {
    refetchCounts();
    refetchOverdue();
    refetchToday();
    refetchThisWeek();
    refetchLater();
    refetchCompleted();
    refetchLinkedTask();
    // Acknowledging, replying and completing all change what belongs in this bucket, so it refetches
    // with everything else rather than only on mount.
    refetchAwaitingMe();
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

      {/*
        THE TASK DETAIL SURFACE. `/tasks/:taskId` used to render one TaskRow in a "Linked task"
        banner — no thread, no composer, no history — which is what both of this feature's emails
        deep-linked to. It is now the conversation drawer, at the same URL, so every link that has
        ever been mailed keeps working and no route had to change.
      */}
      {taskId && linkedTask ? (
        <TaskConversationDrawer
          task={linkedTask}
          currentUserId={userId}
          // The reply email's "Mark complete" CTA lands here as ?complete=1. It focuses the action;
          // it never performs it — an emailed link is a GET, and a GET that mutates is one
          // mail-scanner prefetch away from closing tasks nobody touched.
          completeRequested={searchParams.get("complete") === "1"}
          onClose={() => {
            // Keep the filters, drop the one-shot ?complete flag so a re-open does not re-focus it.
            const next = new URLSearchParams(searchParams);
            next.delete("complete");
            const qs = next.toString();
            navigate(`/tasks${qs ? `?${qs}` : ""}`);
          }}
          onChanged={refetchAll}
        />
      ) : null}

      <NeedsAttentionGroup
        tasks={awaitingMeTasks}
        loading={awaitingMeLoading}
        onUpdate={refetchAll}
      />

      {/* Not folded into `refetchAll`'s spinner set on purpose: this bucket hides itself when empty,
          so gating the whole page's first paint on it would delay the list for no visible gain. */}

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
          <div className="flex flex-wrap items-center gap-2">
            {/*
              Rendered for every role, unlike the assignee filter beside it. Counts come from
              /tasks/counts rather than the loaded rows: the buckets are independently paginated, so a
              client-side .length would understate exactly the busy lists this filter is for. They
              describe OPEN work, which is what the four open buckets show, and they blank while a
              scope swap is in flight rather than describing the scope the user just left.

              size="touch" rather than the default "sm": the default pill is px-3.5 py-1.5 text-xs,
              which is under the WCAG target-size minimum that #1100/#1101 just went through the app
              fixing. Adding a new control below that bar would walk it straight back.
            */}
            <ScopeToggle<"all" | TaskSource>
              ariaLabel="Filter tasks by who created them"
              size="touch"
              value={sourceSelection}
              onChange={setSource}
              options={buildTaskSourceToggleOptions(counts.bySource, countsStale)}
            />
            {canAssign ? (
              <AssigneeFilter
                selection={assigneeSelection}
                currentUserId={userId}
                onChange={setAssignee}
              />
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
