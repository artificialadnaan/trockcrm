import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus,
  Search,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Phone,
  Mail,
  Calendar,
  FileText,
  CheckCircle2,
  Clock,
  AlertTriangle,
  MoreHorizontal,
  Briefcase,
  Building2,
  Users,
  ClipboardList,
  MapPin,
  Flag,
  ArrowDown,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EYEBROW, MetricCard, ScopeToggle } from "./preview-shared";

type LinkType = "deal" | "lead" | "contact" | "company" | "property";

type LinkedRecord = { type: LinkType; id: string; name: string };

type TaskKind = "call" | "email" | "meeting" | "follow_up" | "doc" | "review";

type Priority = "high" | "medium" | "low";

type Bucket = "overdue" | "today" | "week" | "later" | "done";

type TaskItem = {
  id: string;
  title: string;
  kind: TaskKind;
  priority: Priority;
  dueLabel: string;
  bucket: Bucket;
  ownerInitials: string;
  linked?: LinkedRecord;
  notes?: string;
  completedAt?: string;
};

const tasks: TaskItem[] = [
  // OVERDUE
  { id: "t1", title: "Call Marcus re: SOV revision", kind: "call", priority: "high", dueLabel: "Yesterday, 4pm", bucket: "overdue", ownerInitials: "BR", linked: { type: "deal", id: "1", name: "Dallas ISD Roof Replacement" }, notes: "Confirm phasing window before board meeting" },
  { id: "t2", title: "Send revised pricing to Frisco PM", kind: "email", priority: "high", dueLabel: "2 days ago", bucket: "overdue", ownerInitials: "BR", linked: { type: "deal", id: "2", name: "Frisco Distribution Center" } },
  { id: "t3", title: "Submit pre-qual to Arlington Civic", kind: "doc", priority: "medium", dueLabel: "Yesterday, EOD", bucket: "overdue", ownerInitials: "BR", linked: { type: "deal", id: "4", name: "Arlington Civic Center" } },

  // TODAY
  { id: "t4", title: "Site walk at Plano Office Tower", kind: "meeting", priority: "high", dueLabel: "10:00 AM", bucket: "today", ownerInitials: "BR", linked: { type: "property", id: "3", name: "Plano Office Tower" } },
  { id: "t5", title: "Email Karen about PO cost code", kind: "email", priority: "medium", dueLabel: "11:00 AM", bucket: "today", ownerInitials: "BR", linked: { type: "company", id: "1", name: "Dallas ISD" } },
  { id: "t6", title: "Call back Frisco DC project manager", kind: "call", priority: "medium", dueLabel: "2:30 PM", bucket: "today", ownerInitials: "BR", linked: { type: "deal", id: "2", name: "Frisco DC" } },
  { id: "t7", title: "Review McKinney scope draft v2", kind: "review", priority: "low", dueLabel: "3:00 PM", bucket: "today", ownerInitials: "BR", linked: { type: "lead", id: "1", name: "McKinney Medical Plaza" } },
  { id: "t8", title: "Follow up on Westlake intro email", kind: "follow_up", priority: "low", dueLabel: "End of day", bucket: "today", ownerInitials: "BR", linked: { type: "lead", id: "2", name: "Westlake Industrial Park" } },

  // THIS WEEK
  { id: "t9", title: "Send weekly deal update to Brett", kind: "email", priority: "medium", dueLabel: "Fri, 5pm", bucket: "week", ownerInitials: "BR" },
  { id: "t10", title: "Walkthrough at Carrollton Logistics", kind: "meeting", priority: "high", dueLabel: "Wed, 9am", bucket: "week", ownerInitials: "BR", linked: { type: "deal", id: "8", name: "Carrollton Logistics Hub" } },
  { id: "t11", title: "Re-engage McKinney Health Group", kind: "call", priority: "low", dueLabel: "Thu", bucket: "week", ownerInitials: "BR", linked: { type: "company", id: "6", name: "McKinney Health Group" } },
  { id: "t12", title: "Update SOV for Bid #1234", kind: "doc", priority: "medium", dueLabel: "Fri", bucket: "week", ownerInitials: "BR" },
  { id: "t13", title: "Confirm Garland scope items", kind: "follow_up", priority: "low", dueLabel: "Thu", bucket: "week", ownerInitials: "BR", linked: { type: "deal", id: "9", name: "Garland Warehouse 14" } },
  { id: "t14", title: "Send NDA to Lewisville prospect", kind: "email", priority: "low", dueLabel: "Wed", bucket: "week", ownerInitials: "BR" },

  // LATER
  { id: "t15", title: "Q3 territory planning review", kind: "meeting", priority: "medium", dueLabel: "May 14", bucket: "later", ownerInitials: "BR" },
  { id: "t16", title: "Draft Q3 outreach campaign", kind: "doc", priority: "low", dueLabel: "May 18", bucket: "later", ownerInitials: "BR" },
  { id: "t17", title: "Reconnect with Allen ISD facilities", kind: "call", priority: "low", dueLabel: "May 20", bucket: "later", ownerInitials: "BR", linked: { type: "company", id: "10", name: "Allen ISD" } },
  { id: "t18", title: "Site walk follow-up: Mesquite", kind: "follow_up", priority: "low", dueLabel: "May 22", bucket: "later", ownerInitials: "BR", linked: { type: "lead", id: "3", name: "Mesquite Retail Center" } },

  // DONE
  { id: "t19", title: "Sent revised SOV to Marcus", kind: "email", priority: "high", dueLabel: "yesterday", bucket: "done", ownerInitials: "BR", linked: { type: "deal", id: "1", name: "Dallas ISD Roof Replacement" }, completedAt: "yesterday, 4pm" },
  { id: "t20", title: "Site walk completed at Building A", kind: "meeting", priority: "high", dueLabel: "2 days ago", bucket: "done", ownerInitials: "BR", linked: { type: "property", id: "1", name: "Building A - Main Campus" }, completedAt: "2 days ago" },
  { id: "t21", title: "Reviewed Frisco DC RFP", kind: "review", priority: "medium", dueLabel: "3 days ago", bucket: "done", ownerInitials: "BR", linked: { type: "deal", id: "2", name: "Frisco DC" }, completedAt: "3 days ago" },
];

const linkTypeMeta: Record<LinkType, { icon: typeof Briefcase; route: (id: string) => string; tone: string }> = {
  deal: { icon: Briefcase, route: (id) => `/deals/${id}`, tone: "bg-brand-red/10 text-brand-red ring-brand-red/20" },
  lead: { icon: ClipboardList, route: (id) => `/leads/${id}`, tone: "bg-blue-50 text-blue-700 ring-blue-200" },
  contact: { icon: Users, route: (id) => `/contacts/${id}`, tone: "bg-violet-50 text-violet-700 ring-violet-200" },
  company: { icon: Building2, route: (id) => `/companies/${id}`, tone: "bg-amber-50 text-amber-700 ring-amber-200" },
  property: { icon: MapPin, route: (id) => `/properties/${id}`, tone: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
};

const kindMeta: Record<TaskKind, { icon: typeof Phone; tone: string; label: string }> = {
  call: { icon: Phone, tone: "bg-emerald-50 text-emerald-700 ring-emerald-200", label: "Call" },
  email: { icon: Mail, tone: "bg-blue-50 text-blue-700 ring-blue-200", label: "Email" },
  meeting: { icon: Calendar, tone: "bg-violet-50 text-violet-700 ring-violet-200", label: "Meeting" },
  follow_up: { icon: ArrowDown, tone: "bg-amber-50 text-amber-700 ring-amber-200", label: "Follow-up" },
  doc: { icon: FileText, tone: "bg-slate-100 text-slate-700 ring-slate-200", label: "Doc" },
  review: { icon: ClipboardList, tone: "bg-slate-100 text-slate-700 ring-slate-200", label: "Review" },
};

const bucketMeta: Record<
  Bucket,
  { label: string; tone: string; defaultOpen: boolean; icon: typeof AlertTriangle }
> = {
  overdue: { label: "Overdue", tone: "text-brand-red", defaultOpen: true, icon: AlertTriangle },
  today: { label: "Today", tone: "text-amber-700", defaultOpen: true, icon: Clock },
  week: { label: "This week", tone: "text-blue-700", defaultOpen: true, icon: Calendar },
  later: { label: "Later", tone: "text-slate-600", defaultOpen: false, icon: ChevronDown },
  done: { label: "Completed recently", tone: "text-emerald-700", defaultOpen: false, icon: CheckCircle2 },
};

function PriorityFlag({ priority }: { priority: Priority }) {
  if (priority === "high") return <Flag className="h-3 w-3 fill-brand-red stroke-brand-red" aria-label="High priority" />;
  if (priority === "medium") return <Flag className="h-3 w-3 fill-amber-400 stroke-amber-500" aria-label="Medium priority" />;
  return <Flag className="h-3 w-3 stroke-slate-400" aria-label="Low priority" />;
}

function LinkChip({ link, onClick }: { link: LinkedRecord; onClick: () => void }) {
  const meta = linkTypeMeta[link.type];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex max-w-[200px] items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 transition-opacity hover:opacity-80 ${meta.tone}`}
    >
      <Icon className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{link.name}</span>
    </button>
  );
}

function TaskRow({
  task,
  onToggle,
  onOpenLink,
}: {
  task: TaskItem;
  onToggle: (id: string) => void;
  onOpenLink: (link: LinkedRecord) => void;
}) {
  const kind = kindMeta[task.kind];
  const KindIcon = kind.icon;
  const isDone = task.bucket === "done";
  const isOverdue = task.bucket === "overdue";
  return (
    <div className="group flex items-start gap-3 px-5 py-3 transition-colors hover:bg-slate-50">
      <button
        type="button"
        onClick={() => onToggle(task.id)}
        className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border-2 transition-colors ${
          isDone
            ? "border-emerald-500 bg-emerald-500 text-white"
            : "border-slate-300 hover:border-brand-red"
        }`}
        aria-label={isDone ? "Mark incomplete" : "Mark complete"}
      >
        {isDone ? <CheckCircle2 className="h-3 w-3" /> : null}
      </button>

      <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1 ${kind.tone}`}>
        <KindIcon className="h-3 w-3" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p
            className={`truncate text-sm ${
              isDone
                ? "font-semibold text-slate-500 line-through"
                : "font-bold text-slate-950"
            }`}
          >
            {task.title}
          </p>
          <PriorityFlag priority={task.priority} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {task.linked ? <LinkChip link={task.linked} onClick={() => onOpenLink(task.linked!)} /> : null}
          {task.notes ? <p className="truncate text-xs text-slate-500">{task.notes}</p> : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <p
          className={`text-xs font-bold tabular-nums ${
            isOverdue ? "text-brand-red" : isDone ? "text-slate-400" : "text-slate-700"
          }`}
        >
          {isDone ? task.completedAt : task.dueLabel}
        </p>
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Snooze"
          >
            <Clock className="h-3 w-3" />
          </button>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="More"
          >
            <MoreHorizontal className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function TasksPreview() {
  const navigate = useNavigate();
  const [scope, setScope] = useState<"Mine" | "Team" | "All">("Mine");
  const [search, setSearch] = useState("");
  const [openSections, setOpenSections] = useState<Record<Bucket, boolean>>(() => ({
    overdue: bucketMeta.overdue.defaultOpen,
    today: bucketMeta.today.defaultOpen,
    week: bucketMeta.week.defaultOpen,
    later: bucketMeta.later.defaultOpen,
    done: bucketMeta.done.defaultOpen,
  }));
  const [taskState, setTaskState] = useState<TaskItem[]>(tasks);

  const filtered = useMemo(() => {
    return taskState.filter((t) => {
      if (search.trim()) {
        const q = search.toLowerCase();
        if (
          !t.title.toLowerCase().includes(q) &&
          !(t.linked?.name.toLowerCase().includes(q) ?? false) &&
          !(t.notes?.toLowerCase().includes(q) ?? false)
        )
          return false;
      }
      return true;
    });
  }, [taskState, search]);

  const grouped = useMemo(() => {
    const map: Record<Bucket, TaskItem[]> = { overdue: [], today: [], week: [], later: [], done: [] };
    for (const t of filtered) map[t.bucket].push(t);
    return map;
  }, [filtered]);

  const toggleTask = (id: string) => {
    setTaskState((current) =>
      current.map((t) => {
        if (t.id !== id) return t;
        if (t.bucket === "done") {
          return { ...t, bucket: "today", completedAt: undefined };
        }
        return { ...t, bucket: "done", completedAt: "just now" };
      })
    );
  };

  const toggleSection = (bucket: Bucket) =>
    setOpenSections((current) => ({ ...current, [bucket]: !current[bucket] }));

  const overdueCount = grouped.overdue.length;
  const todayCount = grouped.today.length;
  const thisWeekCount = grouped.week.length;
  const overdueHigh = grouped.overdue.filter((t) => t.priority === "high").length;
  const completedThisWeek = grouped.done.length;

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-black uppercase tracking-tight text-slate-950 md:text-5xl">Tasks</h1>
          <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">
            {overdueCount > 0 ? `${overdueCount} overdue · ` : ""}
            {todayCount} today · {thisWeekCount} this week
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ScopeToggle options={["Mine", "Team", "All"] as const} value={scope} onChange={setScope} />
          <Button size="lg">
            <Plus className="mr-1.5 h-4 w-4" />
            New task
          </Button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MetricCard
          eyebrow="Overdue"
          value={String(overdueCount)}
          badge={`${overdueHigh} high priority`}
          badgeTone="green"
          caption={overdueCount > 0 ? "Past due" : "Caught up"}
          drenched={overdueCount > 0}
          accent="red"
        />
        <MetricCard
          eyebrow="Due today"
          value={String(todayCount)}
          badge={`${grouped.today.filter((t) => t.priority === "high").length} high priority`}
          badgeTone="green"
          caption="Action queue"
          accent="red"
        />
        <MetricCard
          eyebrow="Completed"
          value={String(completedThisWeek)}
          badge="this week"
          badgeTone="blue"
          caption="Closing rate"
          accent="green"
        />
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2">
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-slate-950">Task queue</p>
            <button
              type="button"
              onClick={() => {
                const allOpen = Object.values(openSections).every(Boolean);
                const next: Record<Bucket, boolean> = {
                  overdue: !allOpen,
                  today: !allOpen,
                  week: !allOpen,
                  later: !allOpen,
                  done: !allOpen,
                };
                setOpenSections(next);
              }}
              className="text-[11px] font-bold uppercase tracking-wide text-slate-500 hover:text-brand-red"
            >
              {Object.values(openSections).every(Boolean) ? "Collapse all" : "Expand all"}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-md bg-slate-100 px-3 py-2 lg:max-w-sm">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tasks"
                className="flex-1 bg-transparent text-sm placeholder:text-slate-500 focus:outline-none"
              />
            </div>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Group: due date
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
            </button>
          </div>
        </div>

        <div className="divide-y divide-slate-100">
          {(["overdue", "today", "week", "later", "done"] as Bucket[]).map((bucket) => {
            const meta = bucketMeta[bucket];
            const Icon = meta.icon;
            const items = grouped[bucket];
            if (items.length === 0 && bucket !== "today" && bucket !== "overdue") return null;
            const isOpen = openSections[bucket];
            return (
              <section key={bucket}>
                <button
                  type="button"
                  onClick={() => toggleSection(bucket)}
                  className="flex w-full items-center justify-between gap-3 bg-slate-50/40 px-5 py-3 transition-colors hover:bg-slate-100"
                >
                  <div className="flex items-center gap-2">
                    {isOpen ? (
                      <ChevronUp className="h-3.5 w-3.5 text-slate-400" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                    )}
                    <Icon className={`h-3.5 w-3.5 ${meta.tone}`} />
                    <p className={`text-[11px] font-bold uppercase tracking-[0.16em] ${meta.tone}`}>
                      {meta.label}
                    </p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-black tabular-nums ${
                        bucket === "overdue"
                          ? "bg-brand-red/10 text-brand-red"
                          : bucket === "today"
                            ? "bg-amber-50 text-amber-700"
                            : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {items.length}
                    </span>
                  </div>
                </button>

                {isOpen ? (
                  items.length === 0 ? (
                    <p className="px-5 py-6 text-center text-sm text-slate-500">
                      {bucket === "overdue" ? "Nothing past due. Nice." : "Queue clear."}
                    </p>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {items.map((task) => (
                        <TaskRow
                          key={task.id}
                          task={task}
                          onToggle={toggleTask}
                          onOpenLink={(link) => navigate(linkTypeMeta[link.type].route(link.id))}
                        />
                      ))}
                    </div>
                  )
                ) : null}
              </section>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
