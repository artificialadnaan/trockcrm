import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { getOfficeRequestOptions } from "@/lib/office-selection";

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

/**
 * Priority values paired with their display labels.
 *
 * ⚠️ THE `items` PROP IS NOT OPTIONAL ON A `<Select>` WHOSE TRIGGER SHOWS A VALUE. Base UI resolves
 * the trigger's label from `items` and never from the `SelectItem` children, so a select without it
 * renders the raw enum — `urgent` in lowercase, next to an item labelled `Urgent`. One exported pair
 * list, fed to both `items` and the items themselves, is what stops the two from drifting.
 */
export const TASK_PRIORITY_SELECT_ITEMS: { value: string; label: string }[] = [
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
];

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
  /**
   * WHO handed this work over — `last_assigned_by ?? created_by`, resolved server-side by the same
   * rule the outcome email uses to pick its recipient. Optional so a row from an API that predates
   * the field still types; null on machine-generated tasks, which have no assigner at all.
   */
  assignedByName?: string | null;
  /** When it was handed over. Re-stamped on reassignment, not on an ordinary edit. */
  assignedAt?: string | null;
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
  // ---- Closed loop (F4). Optional so a row from an API that predates them still types. ----
  /** Head of the task's thread — set only by a reply from the ASSIGNEE. */
  lastReplyAt?: string | null;
  lastReplyBy?: string | null;
  lastReplyByName?: string | null;
  lastReplyBody?: string | null;
  /** How far up the thread the assigner has confirmed reading. Monotonic; never cleared. */
  assignerAckAt?: string | null;
  /** Replies made since `assignerAckAt`. Server-computed — never derived from a loaded page. */
  unreadReplyCount?: number;
  /**
   * May THIS viewer close this task? The SERVER's verdict, carried on every task projection.
   *
   * Not re-derived here on purpose: task visibility and close authority are different rules -- the
   * list only scopes reps, so construction and field_contractor users are handed every task in the
   * office -- and a second copy of the authority rule in the browser is how the two drift apart.
   *
   * `undefined` means an API that predates the field; treated as ALLOWED so a deploy window does not
   * disable every control. The server still refuses what it refuses.
   */
  canClose?: boolean;
}

/**
 * Does a task you assigned have something you have not read?
 *
 * The SAME predicate the server's /tasks/awaiting-me query and the partial index use, restated once
 * here so the affordance on a row and the bucket it belongs to cannot disagree. Note the `<`: an
 * acknowledgement is monotonic, so a reply landing after one leaves `assignerAckAt < lastReplyAt` and
 * re-raises the task — that branch is reachable, and it is the one that carries the behaviour.
 */
export function taskHasUnreadReply(
  task: Pick<Task, "lastReplyAt" | "assignerAckAt">
): boolean {
  if (!task.lastReplyAt) return false;
  if (!task.assignerAckAt) return true;
  return new Date(task.assignerAckAt).getTime() < new Date(task.lastReplyAt).getTime();
}

export type TaskCommentKind = "reply" | "note" | "system";

export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  kind: TaskCommentKind | string;
  createdAt: string;
}

/**
 * Whether a reply on this task reaches anybody, and if not why.
 *
 * Both negative states are structural rather than rare: `created_by` is NULL on every rules-engine and
 * AI-disconnect task, and the app deactivates departing employees rather than deleting them. The
 * composer says so instead of posting into a void.
 */
export interface TaskLoopDescriptor {
  assignerId: string | null;
  assignerName: string | null;
  assignerIsActive: boolean;
  notifiesAssigner: boolean;
  reason: "ok" | "no_assigner" | "assigner_inactive";
}

export interface TaskTimelineFieldChange {
  key: string;
  label: string;
  fromDisplay: string | null;
  toDisplay: string | null;
  transition: "changed" | "set" | "cleared";
}

export interface TaskTimelineEntry {
  id: string;
  kind: "audit" | "comment";
  occurredAt: string;
  actorId: string | null;
  actorLabel: string;
  actorType: "user" | "system";
  action: string;
  summary: string;
  body: string | null;
  fieldChanges: TaskTimelineFieldChange[];
}

export interface TaskTransitionInput {
  nextStatus: TaskStatus;
  /** Required by the API when a person transitions a task to a terminal state. */
  resolutionNote?: string;
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

export async function completeTask(taskId: string, resolutionNote: string) {
  return api<{ task: Task }>(`/tasks/${taskId}/complete`, {
    method: "POST",
    json: { resolutionNote },
  });
}

export async function dismissTask(taskId: string, resolutionNote: string) {
  return api<{ task: Task }>(`/tasks/${taskId}/dismiss`, {
    method: "POST",
    json: { resolutionNote },
  });
}

export async function snoozeTask(taskId: string, dueDate: string) {
  return api<{ task: Task }>(`/tasks/${taskId}/snooze`, { method: "POST", json: { dueDate } });
}

// -------------------------------------------------------------------------------------------------
// F4 — task closed loop
// -------------------------------------------------------------------------------------------------

export function useTaskComments(taskId: string | undefined) {
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [loop, setLoop] = useState<TaskLoopDescriptor | null>(null);
  const [unreadReplyCount, setUnreadReplyCount] = useState(0);
  /**
   * Whether the SERVER will accept a comment from this viewer. Not re-derived here: opening a task and
   * speaking on it are two different permissions, and a client copy of the second rule drifts from it.
   * `undefined` until the first response, so the composer can render optimistically rather than
   * flickering closed on every open.
   */
  const [canComment, setCanComment] = useState<boolean | undefined>(undefined);
  const [loading, setLoading] = useState(Boolean(taskId));
  const [error, setError] = useState<string | null>(null);

  /**
   * Last-write-wins, matching useTasks/useTaskCounts.
   *
   * Not cosmetic here: the drawer derives its acknowledgement timestamp from whatever comments are in
   * state, so a slow response for the PREVIOUS task landing after the drawer switched would show one
   * task's thread while the ack was POSTed against another — recording an assigner as having read
   * replies that were never on screen.
   */
  const requestIdRef = useRef(0);

  const fetchComments = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!taskId) {
      setComments([]);
      setLoop(null);
      setUnreadReplyCount(0);
      setCanComment(undefined);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const data = await api<{
        comments: TaskComment[];
        loop: TaskLoopDescriptor;
        unreadReplyCount: number;
        canComment?: boolean;
      }>(`/tasks/${encodeURIComponent(taskId)}/comments`);
      if (requestId !== requestIdRef.current) return; // a newer request superseded this one
      setComments(data.comments);
      setLoop(data.loop);
      setUnreadReplyCount(data.unreadReplyCount ?? 0);
      setCanComment(data.canComment);
    } catch (err: unknown) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load the conversation");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  return { comments, loop, unreadReplyCount, canComment, loading, error, refetch: fetchComments };
}

export function useTaskTimeline(taskId: string | undefined) {
  const [entries, setEntries] = useState<TaskTimelineEntry[]>([]);
  const [loading, setLoading] = useState(Boolean(taskId));
  const [error, setError] = useState<string | null>(null);

  // Same last-write-wins guard as useTaskComments — the two are fetched together and a stale timeline
  // rendered against the current task is the same lie in a different pane.
  const requestIdRef = useRef(0);

  const fetchTimeline = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!taskId) {
      setEntries([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const data = await api<{ entries: TaskTimelineEntry[] }>(
        `/tasks/${encodeURIComponent(taskId)}/timeline`
      );
      if (requestId !== requestIdRef.current) return;
      setEntries(data.entries);
    } catch (err: unknown) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load the timeline");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchTimeline();
  }, [fetchTimeline]);

  return { entries, loading, error, refetch: fetchTimeline };
}

/**
 * Tasks YOU assigned that are waiting on you.
 *
 * A separate endpoint rather than a `useTasks` filter, because these tasks are by construction
 * assigned to somebody ELSE — `/tasks` scopes reps to `assigned_to = me`, which is exactly why they
 * appear nowhere in the assigner's list today.
 */
export function useTasksAwaitingMe() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAwaitingMe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ tasks: Task[] }>("/tasks/awaiting-me");
      setTasks(data.tasks);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load replies awaiting you");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAwaitingMe();
  }, [fetchAwaitingMe]);

  return { tasks, loading, error, refetch: fetchAwaitingMe };
}

export async function postTaskComment(taskId: string, body: string) {
  return api<{ comment: TaskComment; loop: TaskLoopDescriptor }>(
    `/tasks/${encodeURIComponent(taskId)}/comments`,
    { method: "POST", json: { body } }
  );
}

/**
 * Acknowledge replies up to the timestamp the UI actually RENDERED — never `now()`.
 *
 * Sending the render point is what stops a reply that lands between the render and the click from
 * being marked read by somebody who never saw it. The server refuses a `seenUpTo` ahead of the newest
 * reply, and takes GREATEST() with the existing value, so a stale or duplicated call can neither
 * over-acknowledge nor walk the acknowledgement backwards.
 */
export async function ackTaskReplies(taskId: string, seenUpTo: string) {
  return api<{ acknowledged: boolean; lastReplyAt: string | null; assignerAckAt: string | null }>(
    `/tasks/${encodeURIComponent(taskId)}/ack`,
    { method: "POST", json: { seenUpTo } }
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// F6 — new-assignment login modal
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A row in the login modal. Deliberately NOT `Task`: the endpoint returns the five fields the modal
 * renders and nothing else, and widening it to the full task shape would invite the modal to grow into
 * a second task list — which is the wall-of-tasks outcome the five-row cap exists to prevent.
 */
export interface PendingAssignmentTask {
  id: string;
  /** Opaque assigned_at version for the exact handoff this modal rendered. */
  assignmentVersion: string;
  /** Server-signed receipt proving this exact card was rendered to this user. */
  acknowledgementToken: string;
  title: string;
  priority: string;
  dueDate: string | null;
  /**
   * Who last handed this task to the recipient, or its creator before the first reassignment.
   * Null only when neither resolved user has a display name.
   */
  assignedByName: string | null;
  /**
   * True when this person has never been shown this task. False for a repeat — urgent, high or overdue
   * work the server returns again on every login until it leaves pending. The modal groups on it, so a
   * repeat is never counted or captioned as a new assignment.
   */
  isNew: boolean;
}

export interface PendingAssignmentTasksResponse {
  tasks: PendingAssignmentTask[];
  /** Everything matching, not just what was returned — feeds the "and N more" line. */
  total: number;
  /** How many of those have never been shown. What the headline is allowed to call "new". */
  newTotal: number;
}

/**
 * `officeId` is PINNED on the request rather than left to api()'s ambient fallback.
 *
 * Office scope is URL-driven: api() reads ?officeId out of window.location on every call and turns it
 * into x-office-id, which decides the tenant schema the request lands in. Leaving it ambient means the
 * tenant is whatever the URL happens to say at the moment the request fires, which is not necessarily
 * the office the caller meant — an in-app navigation between the decision and the call silently
 * redirects it. Naming the office makes the request self-contained; hasOfficeHeader() in api() then
 * leaves the explicit header alone.
 */
export async function fetchPendingAssignmentTasks(
  officeId?: string | null,
  signal?: AbortSignal
) {
  return api<PendingAssignmentTasksResponse>(
    "/tasks/pending-acknowledgement",
    { ...getOfficeRequestOptions(officeId), signal }
  );
}

/**
 * Record that the modal has shown these assignments to the signed-in user.
 *
 * Fire-and-forget by design: the server filters each displayed id/version pair to the caller's CURRENT
 * assignment and answers 204 whatever happens, and the modal must close on the user's click rather than
 * on a round trip. Rejections are the caller's to swallow — a failed acknowledgement costs one repeat of
 * the modal, whereas a dialog that stays open because the network blinked is a trapped user.
 */
export type PendingAssignmentAcknowledgement = Pick<
  PendingAssignmentTask,
  "id" | "assignmentVersion" | "acknowledgementToken"
>;

export async function acknowledgeTaskAssignments(
  assignments: PendingAssignmentAcknowledgement[],
  officeId?: string | null
) {
  return api<void>("/tasks/acknowledge", {
    method: "POST",
    // `assignmentVersion` is the server-issued, lossless assigned_at value from the card, and the
    // receipt is scoped to this person and office. Together they prove the acknowledgement belongs to
    // the exact card the modal rendered; a task that leaves and comes back before close cannot have its
    // newer assignment acknowledged by this stale card.
    json: {
      assignments: assignments.map(({ id, assignmentVersion, acknowledgementToken }) => ({
        taskId: id,
        assignmentVersion,
        acknowledgementToken,
      })),
    },
    // MUST be the office the ids were READ from, not the one in the URL now. Ids belong to exactly one
    // tenant schema; posted against another, the server's ownership re-derivation matches nothing and
    // the write is a silent no-op that still answers 204. The user sees the modal close and the tasks
    // come back at the next login with nothing anywhere explaining why.
    ...getOfficeRequestOptions(officeId),
  });
}
