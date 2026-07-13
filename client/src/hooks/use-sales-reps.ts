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
  /**
   * Shapes which users the `/users/sales-reps` feed returns:
   *   "deal-reassignment" — active office users in any internal CRM role (owner/estimator pickers).
   *   "lead-reassignment" — active office users in any internal CRM role (lead owner picker).
   *   "sales-source"      — active office internal CRM users (any role except field_contractor),
   *                         matching the server's assertSalesSourceIsCrmUser gate, so the source picker
   *                         can't offer a choice that 422s on submit (and a plain rep sees the full office
   *                         roster, not just themselves). Same set as deal-reassignment today; kept a
   *                         distinct purpose for intent + future divergence.
   */
  purpose?: "deal-reassignment" | "lead-reassignment" | "sales-source";
}

export function useSalesReps(officeId?: string, options: UseSalesRepsOptions = {}) {
  const { enabled = true, purpose } = options;
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
      const path = purpose
        ? `/users/sales-reps?purpose=${purpose}`
        : "/users/sales-reps";
      const data = await api<{ users: SalesRepOption[] }>(
        path,
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
  }, [officeId, enabled, purpose]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  return { salesReps, loading, error, refetch: load };
}
