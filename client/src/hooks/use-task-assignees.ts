import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface TaskAssignee {
  id: string;
  displayName: string;
}

export function useTaskAssignees() {
  const [assignees, setAssignees] = useState<TaskAssignee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ users: TaskAssignee[] }>("/tasks/assignees");
      setAssignees(data.users);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load assignees");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { assignees, loading, error, refetch: load };
}
