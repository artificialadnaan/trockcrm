import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { getOfficeRequestOptions, type OfficeRequestOptions } from "@/lib/office-selection";

export interface TaskAssignee {
  id: string;
  displayName: string;
}

export function useTaskAssignees(options: OfficeRequestOptions = {}) {
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
      const data = await api<{ users: TaskAssignee[] }>(
        "/tasks/assignees",
        getOfficeRequestOptions(options.officeId)
      );
      if (requestId !== requestRef.current) return;
      setAssignees(data.users);
    } catch (err: unknown) {
      if (requestId !== requestRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load assignees");
    } finally {
      if (requestId === requestRef.current) {
        setLoading(false);
      }
    }
  }, [options.officeId]);

  useEffect(() => {
    load();
  }, [load]);

  return { assignees, loading, error, refetch: load };
}
