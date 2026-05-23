import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { TaskAssignee } from "@/hooks/use-task-assignees";

export function useOwnerAssignees() {
  const [assignees, setAssignees] = useState<TaskAssignee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    setAssignees([]);
    try {
      const data = await api<{ users: TaskAssignee[] }>("/users/crm-owners");
      if (requestId !== requestRef.current) return;
      setAssignees(data.users);
    } catch (err: unknown) {
      if (requestId !== requestRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load owner options");
    } finally {
      if (requestId === requestRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { assignees, loading, error, refetch: load };
}
