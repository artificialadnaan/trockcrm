import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export type TaskStatus =
  | "pending"
  | "scheduled"
  | "in_progress"
  | "waiting_on"
  | "blocked"
  | "completed"
  | "dismissed";

export interface Task {
  id: string;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  status: TaskStatus;
  assignedTo: string;
  assignedToName: string | null;
  createdBy: string | null;
  dealId: string | null;
  dealName?: string | null;
  dealNumber?: string | null;
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
}

export interface TaskFilters {
  section?: "overdue" | "today" | "upcoming" | "completed";
  assignedTo?: string;
  status?: string;
  type?: string;
  dealId?: string;
  contactId?: string;
  page?: number;
  limit?: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function useTasks(filters: TaskFilters = {}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 100, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTasks = useCallback(async () => {
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
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const data = await api<{ tasks: Task[]; pagination: Pagination }>(
        `/tasks${qs ? `?${qs}` : ""}`
      );
      setTasks(data.tasks);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }, [
    filters.section,
    filters.assignedTo,
    filters.status,
    filters.type,
    filters.dealId,
    filters.contactId,
    filters.page,
    filters.limit,
  ]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  return { tasks, pagination, loading, error, refetch: fetchTasks };
}

export function useTaskCounts(userId?: string) {
  const [counts, setCounts] = useState<TaskCounts>({ overdue: 0, today: 0, upcoming: 0, completed: 0 });
  const [loading, setLoading] = useState(true);

  const fetchCounts = useCallback(async () => {
    try {
      const qs = userId ? `?userId=${encodeURIComponent(userId)}` : "";
      const data = await api<{ counts: TaskCounts }>(`/tasks/counts${qs}`);
      setCounts(data.counts);
    } catch (err) {
      console.error("Failed to load task counts:", err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchCounts();
  }, [fetchCounts]);

  return { counts, loading, refetch: fetchCounts };
}

export async function createTask(input: Partial<Task> & { title: string }) {
  return api<{ task: Task }>("/tasks", { method: "POST", json: input });
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
