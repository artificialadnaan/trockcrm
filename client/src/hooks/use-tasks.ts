import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";

export type TaskStatus =
  | "pending"
  | "scheduled"
  | "in_progress"
  | "waiting_on"
  | "blocked"
  | "completed"
  | "dismissed";

/** Mirrors the server allowlist — anything else is treated as "no filter" on both sides. */
export type TaskSource = "manual" | "automated";
export const TASK_SOURCES: readonly TaskSource[] = ["manual", "automated"];

export function isTaskSource(value: unknown): value is TaskSource {
  return typeof value === "string" && (TASK_SOURCES as readonly string[]).includes(value);
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  status: TaskStatus;
  /** Who created it: a person ('manual') or the system ('automated'). Recorded, never derived. */
  source: TaskSource;
  assignedTo: string;
  assignedToName: string | null;
  createdBy: string | null;
  dealId: string | null;
  dealName?: string | null;
  /** `deals.is_change_order` — the AUTHORITY for the change-order display relabel. */
  dealIsChangeOrder?: boolean | null;
  dealNumber?: string | null;
  projectNumber?: string | null;
  contactId: string | null;
  emailId: string | null;
  dueDate: string | null;
  dueTime: string | null;
  remindAt: string | null;
  scheduledFor: string | null;
  waitingOn: Record<string, unknown> | null;
  blockedBy: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  isOverdue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskTransitionInput {
  nextStatus: TaskStatus;
  scheduledFor?: string | null;
  waitingOn?: TaskLifecycleReference | Record<string, unknown> | null;
  blockedBy?: TaskLifecycleReference | Record<string, unknown> | null;
}

export interface TaskLifecycleReference {
  schema_version: number;
  kind: string;
  label: string;
  ref_type: string;
  ref_id: string;
  note?: string;
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "Pending",
  scheduled: "Scheduled",
  in_progress: "In Progress",
  waiting_on: "Waiting On",
  blocked: "Blocked",
  completed: "Completed",
  dismissed: "Dismissed",
};

export function getTaskStatusLabel(status: string) {
  return TASK_STATUS_LABELS[status as TaskStatus] ?? status.replace(/_/g, " ");
}

export function isTerminalTaskStatus(status: string) {
  return status === "completed" || status === "dismissed";
}

export const TASK_ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["scheduled", "in_progress", "waiting_on", "blocked", "completed", "dismissed"],
  scheduled: ["pending", "dismissed"],
  in_progress: ["scheduled", "waiting_on", "blocked", "completed", "dismissed"],
  waiting_on: ["scheduled", "pending", "in_progress", "blocked", "completed", "dismissed"],
  blocked: ["scheduled", "pending", "in_progress", "waiting_on", "completed", "dismissed"],
  completed: [],
  dismissed: [],
};

export function canTransitionTask(status: TaskStatus, nextStatus: TaskStatus) {
  return TASK_ALLOWED_TRANSITIONS[status].includes(nextStatus);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function formatLifecycleDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function getLifecycleReferenceLabel(value: unknown) {
  const record = asRecord(value);
  return asString(record?.label) ?? asString(record?.note) ?? asString(record?.kind) ?? null;
}

function getLifecycleReferenceBase(task: Pick<Task, "id" | "dealId" | "contactId" | "emailId">) {
  if (task.dealId) {
    return { ref_type: "deal", ref_id: task.dealId };
  }
  if (task.contactId) {
    return { ref_type: "contact", ref_id: task.contactId };
  }
  if (task.emailId) {
    return { ref_type: "email", ref_id: task.emailId };
  }
  return { ref_type: "task", ref_id: task.id };
}

export function buildTaskLifecycleReference(
  task: Pick<Task, "id" | "dealId" | "contactId" | "emailId">,
  kind: string,
  label: string,
  existing?: unknown
): TaskLifecycleReference {
  const record = asRecord(existing);
  const base = getLifecycleReferenceBase(task);
  const resolvedLabel = label.trim() || asString(record?.label) || asString(record?.note) || asString(record?.kind) || kind;
  return {
    schema_version: 1,
    kind: asString(record?.kind) ?? kind,
    label: resolvedLabel,
    ref_type: asString(record?.ref_type) ?? base.ref_type,
    ref_id: asString(record?.ref_id) ?? base.ref_id,
    note: resolvedLabel,
  };
}

export function getTaskLifecycleSummary(task: Pick<Task, "status" | "scheduledFor" | "waitingOn" | "blockedBy" | "startedAt">) {
  if (task.status === "scheduled") {
    const scheduledAt = formatLifecycleDate(task.scheduledFor);
    return scheduledAt ? `Scheduled for ${scheduledAt}` : "Scheduled";
  }

  if (task.status === "waiting_on") {
    const label = getLifecycleReferenceLabel(task.waitingOn);
    return label ? `Waiting on ${label}` : "Waiting on dependency";
  }

  if (task.status === "blocked") {
    const label = getLifecycleReferenceLabel(task.blockedBy);
    return label ? `Blocked by ${label}` : "Blocked by dependency";
  }

  if (task.status === "in_progress") {
    const startedAt = formatLifecycleDate(task.startedAt);
    return startedAt ? `Started ${startedAt}` : "In progress";
  }

  return null;
}

export function getTaskTimelineLabel(task: Pick<Task, "status" | "scheduledFor" | "dueDate">) {
  if (task.status === "scheduled") {
    return task.scheduledFor ? `Scheduled: ${formatLifecycleDate(task.scheduledFor) ?? task.scheduledFor}` : "Scheduled";
  }

  return task.dueDate ? `Due: ${new Date(task.dueDate + "T00:00:00").toLocaleDateString()}` : "No date";
}

export interface TaskCounts {
  overdue: number;
  today: number;
  upcoming: number;
  completed: number;
  // Resolved (completed or dismissed) in the last 7 days — authoritative source for the
  // "Completed this week" summary card (server-computed, not derived from the limited bucket).
  completedThisWeek: number;
  /**
   * Open-work totals for the tab labels, from the same request as everything else. Counted server-side
   * over the full set: the buckets are independently paginated (later caps at 200, completed at 20), so
   * a client-side .length would be wrong for exactly the polluted lists this filter exists for.
   */
  bySource: { manual: number; automated: number; all: number };
}

export type TaskSection = "overdue" | "today" | "this_week" | "later" | "upcoming" | "completed";
export type TaskSortBy = "due_date" | "priority" | "assignee" | "created_at" | "completed_at";
export type TaskSortDir = "asc" | "desc";

export interface TaskFilters {
  section?: TaskSection;
  assignedTo?: string;
  status?: string;
  type?: string;
  dealId?: string;
  contactId?: string;
  /** Omitted means BOTH — "All" is the default and hides nothing. */
  source?: TaskSource;
  // Per-bucket sort wired through to the server so the FULL bucket sorts in the DB.
  sortBy?: TaskSortBy;
  sortDir?: TaskSortDir;
  page?: number;
  limit?: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ProjectTaskCreateInput {
  title: string;
  description?: string;
  type?: string;
  priority?: string;
  assignedTo: string;
  dueDate?: string;
  dueTime?: string;
  remindAt?: string;
}

export function useTasks(filters: TaskFilters = {}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 100, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Last-write-wins: a scope/sort/filter change can leave an earlier request in flight; only the
  // latest request may write results, so a slow earlier response (e.g. the previous assignee's) can't
  // land and resurrect stale rows.
  const requestIdRef = useRef(0);

  // Drop stale rows the instant the SCOPE (assignedTo) changes — synchronously, before paint — so an
  // in-flight refetch never shows the previous assignee's interactive rows (a stray complete/snooze
  // on a task outside the newly selected filter). Same-scope changes (sort, search, page) keep the
  // rows so re-sorting doesn't flicker. React's "adjust state during render" pattern; the ref guard
  // makes it fire once per scope change. We ALSO invalidate the request token here so a previous-scope
  // response that resolves before the passive refetch effect starts can't repopulate the cleared rows.
  // The SCOPE is the assignee AND the source: both change WHICH tasks may be shown, as opposed to
  // sort/search/page which only reorder or narrow the same set. Tracking only the assignee meant
  // switching Manual/Automated advertised the new tab while leaving the previous tab's rows on screen
  // and interactive until the request landed -- and indefinitely if it failed, so a stray
  // complete/snooze could hit a task that is not in the tab the user is looking at.
  const scopeKey = `${filters.assignedTo ?? ""}|${filters.source ?? ""}`;
  const scopeRef = useRef(scopeKey);
  if (scopeRef.current !== scopeKey) {
    scopeRef.current = scopeKey;
    setTasks([]);
    requestIdRef.current++;
  }

  const fetchTasks = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.section) params.set("section", filters.section);
      if (filters.assignedTo) params.set("assignedTo", filters.assignedTo);
      if (filters.status) params.set("status", filters.status);
      if (filters.type) params.set("type", filters.type);
      if (filters.dealId) params.set("dealId", filters.dealId);
      if (filters.contactId) params.set("contactId", filters.contactId);
      if (filters.source) params.set("source", filters.source);
      if (filters.sortBy) params.set("sortBy", filters.sortBy);
      if (filters.sortDir) params.set("sortDir", filters.sortDir);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const data = await api<{ tasks: Task[]; pagination: Pagination }>(
        `/tasks${qs ? `?${qs}` : ""}`
      );
      if (requestId !== requestIdRef.current) return; // a newer request superseded this one
      setTasks(data.tasks);
      setPagination(data.pagination);
    } catch (err: unknown) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load tasks");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [
    filters.section,
    filters.assignedTo,
    filters.status,
    filters.type,
    filters.dealId,
    filters.contactId,
    filters.source,
    filters.sortBy,
    filters.sortDir,
    filters.page,
    filters.limit,
  ]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  return { tasks, pagination, loading, error, refetch: fetchTasks };
}

export function useTask(taskId: string | undefined) {
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(Boolean(taskId));
  const [error, setError] = useState<string | null>(null);

  const fetchTask = useCallback(async () => {
    if (!taskId) {
      setTask(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const data = await api<{ task: Task }>(`/tasks/${encodeURIComponent(taskId)}`);
      setTask(data.task);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load task");
      setTask(null);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchTask();
  }, [fetchTask]);

  return { task, loading, error, refetch: fetchTask };
}

export function useTaskCounts(userId?: string, source?: TaskSource) {
  const [counts, setCounts] = useState<TaskCounts>({
    overdue: 0, today: 0, upcoming: 0, completed: 0, completedThisWeek: 0,
    bySource: { manual: 0, automated: 0, all: 0 },
  });
  const [loading, setLoading] = useState(true);
  // The scope (userId) the loaded counts belong to; updated only when a response actually lands, so
  // a scope change is detectable synchronously at render without an effect-timing race.
  // The scope is the assignee AND the source: both change WHICH tasks the numbers describe. Tracking
  // only the assignee left the previous tab's card values eligible for display while the new request
  // was in flight — and indefinitely if it failed — so the cards could contradict the buckets under
  // them. Same combined key as useTasks, so the two cannot drift apart.
  const scopeKey = `${userId ?? ""}|${source ?? ""}`;
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | undefined>(undefined);
  const loadedOnceRef = useRef(false);
  const requestIdRef = useRef(0);

  const fetchCounts = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (userId) params.set("userId", userId);
      if (source) params.set("source", source);
      const qs = params.toString();
      const data = await api<{ counts: TaskCounts }>(`/tasks/counts${qs ? `?${qs}` : ""}`);
      if (requestId !== requestIdRef.current) return; // superseded by a newer scope's request
      // The API deploys separately from this bundle, so a response from a server that predates
      // bySource is a real state, not a hypothetical. Default it rather than letting the tab labels
      // read through an undefined.
      setCounts({
        ...data.counts,
        bySource: data.counts?.bySource ?? { manual: 0, automated: 0, all: 0 },
      });
      setLoadedScopeKey(scopeKey);
      loadedOnceRef.current = true;
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      console.error("Failed to load task counts:", err);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [userId, source, scopeKey]);

  useEffect(() => {
    fetchCounts();
  }, [fetchCounts]);

  // The loaded counts belong to a different assignee or a different tab than the active filter → an
  // in-flight scope swap. Callers should not display these numbers; they describe a filter the user
  // has already left.
  const stale = loadedOnceRef.current && loadedScopeKey !== scopeKey;

  return { counts, loading, stale, refetch: fetchCounts };
}

export function useProjectTasks(projectId: string | undefined) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProjectTasks = useCallback(async () => {
    if (!projectId) {
      setTasks([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const data = await api<{ tasks: Task[] }>(`/procore/my-projects/${projectId}/tasks`);
      setTasks(data.tasks);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load project tasks");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchProjectTasks();
  }, [fetchProjectTasks]);

  return { tasks, loading, error, refetch: fetchProjectTasks };
}

export async function createTask(input: Partial<Task> & { title: string }) {
  return api<{ task: Task }>("/tasks", { method: "POST", json: input });
}

export async function createProjectTask(projectId: string, input: ProjectTaskCreateInput) {
  return api<{ task: Task }>(`/procore/my-projects/${projectId}/tasks`, {
    method: "POST",
    json: input,
  });
}

export async function updateTask(taskId: string, input: Partial<Task>) {
  return api<{ task: Task }>(`/tasks/${taskId}`, { method: "PATCH", json: input });
}

export async function transitionTask(taskId: string, input: TaskTransitionInput) {
  return api<{ task: Task }>(`/tasks/${taskId}/transition`, { method: "POST", json: input });
}

export async function completeTask(taskId: string) {
  return api<{ task: Task }>(`/tasks/${taskId}/complete`, { method: "POST" });
}

export async function dismissTask(taskId: string) {
  return api<{ task: Task }>(`/tasks/${taskId}/dismiss`, { method: "POST" });
}

export async function snoozeTask(taskId: string, dueDate: string) {
  return api<{ task: Task }>(`/tasks/${taskId}/snooze`, { method: "POST", json: { dueDate } });
}
