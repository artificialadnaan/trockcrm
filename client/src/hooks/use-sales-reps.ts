import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

export interface SalesRepOption {
  id: string;
  displayName: string;
  email?: string | null;
}

export interface UseSalesRepsOptions {
  /**
   * When `false`, suppresses the initial fetch. Use this when the caller
   * cannot yet provide a fully-resolved `officeId` (e.g., while accessible
   * offices are still loading and a legacy slug needs to be canonicalized).
   * Defaults to `true`.
   */
  enabled?: boolean;
}

export function useSalesReps(officeId?: string, options: UseSalesRepsOptions = {}) {
  const { enabled = true } = options;
  const [salesReps, setSalesReps] = useState<SalesRepOption[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    // Abort any in-flight request before issuing a new one so that a stale
    // response cannot overwrite the latest result (Codex finding: race on
    // rapid officeId changes).
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const headers = officeId && officeId !== "all"
        ? { "x-office-id": officeId }
        : undefined;
      const data = await api<{ users: SalesRepOption[] }>(
        "/users/sales-reps",
        { ...(headers ? { headers } : {}), signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setSalesReps(data.users);
    } catch (err) {
      if (controller.signal.aborted || (err as { name?: string })?.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to load sales reps");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [officeId, enabled]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  return { salesReps, loading, error, refetch: load };
}
