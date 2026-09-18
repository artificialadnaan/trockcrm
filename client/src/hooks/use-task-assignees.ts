import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { getOfficeRequestOptions, type OfficeRequestOptions } from "@/lib/office-selection";

export interface TaskAssignee {
  id: string;
  displayName: string;
}

export interface UseTaskAssigneesOptions extends OfficeRequestOptions {
  /**
   * When false, no request is issued and `assignees` stays empty.
   *
   * Mirrors useRepRoster's gate, and exists for the same reason: a component that mounts this hook
   * unconditionally but is nested under a page that ALREADY loaded the same feed makes the page issue
   * /tasks/assignees twice per load. The deals list section sits under the /deals board, which resolves
   * owner names for its own header controls — so it takes the parent's list instead of fetching a second
   * copy. `loadedOfficeId` still settles to the requested office when disabled, so a caller gating on it
   * is not left waiting for a load that will never happen.
   */
  enabled?: boolean;
}

export function useTaskAssignees(options: UseTaskAssigneesOptions = {}) {
  const { enabled = true } = options;
  const [assignees, setAssignees] = useState<TaskAssignee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The office the CURRENT `assignees` belong to. Until a load settles it stays at the previous office's
  // value, so callers switching offices can tell that the list is stale (loading may briefly still read
  // false during the office-change render) and defer decisions until `loadedOfficeId === the requested office`.
  const [loadedOfficeId, setLoadedOfficeId] = useState<string | null | undefined>(undefined);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    const requestOfficeId = options.officeId ?? null;
    if (!enabled) {
      setAssignees([]);
      setError(null);
      setLoading(false);
      setLoadedOfficeId(requestOfficeId);
      return;
    }
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
        setLoadedOfficeId(requestOfficeId);
      }
    }
  }, [options.officeId, enabled]);

  useEffect(() => {
    load();
  }, [load]);

  return { assignees, loading, error, loadedOfficeId, refetch: load };
}
