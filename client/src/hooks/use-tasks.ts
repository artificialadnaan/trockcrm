import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface Task {
  id: string;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  status: string;
  assignedTo: string;
  assignedToName: string | null;
  createdBy: string | null;
  dealId: string | null;
  contactId: string | null;
  emailId: string | null;
  dueDate: string | null;
  dueTime: string | null;
  remindAt: string | null;
  completedAt: string | null;
  isOverdue: boolean;
  createdAt: string;
  updatedAt: string;
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

export function useTaskCounts() {
  const [counts, setCounts] = useState<TaskCounts>({ overdue: 0, today: 0, upcoming: 0, completed: 0 });
  const [loading, setLoading] = useState(true);

  const fetchCounts = useCallback(async () => {
    try {
      const data = await api<{ counts: TaskCounts }>("/tasks/counts");
      setCounts(data.counts);
    } catch (err) {
      console.error("Failed to load task counts:", err);
    } finally {
      setLoading(false);
    }
  }, []);

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

export async function completeTask(taskId: string) {
  return api<{ task: Task }>(`/tasks/${taskId}/complete`, { method: "POST" });
}

export async function dismissTask(taskId: string) {
  return api<{ task: Task }>(`/tasks/${taskId}/dismiss`, { method: "POST" });
}

export async function snoozeTask(taskId: string, dueDate: string) {
  return api<{ task: Task }>(`/tasks/${taskId}/snooze`, { method: "POST", json: { dueDate } });
}
