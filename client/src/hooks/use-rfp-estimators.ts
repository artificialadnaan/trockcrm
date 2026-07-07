import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

export interface RfpEstimatorOption {
  name: string;
  email: string;
}

export interface UseRfpEstimatorsOptions {
  /**
   * When `false`, suppresses the fetch. The RFP vote form loads estimators only
   * when a first approver could actually edit the round. Defaults to `true`.
   */
  enabled?: boolean;
}

/**
 * Estimator suggestions for the RFP vote form. Server-side this mirrors SyncHub's estimator
 * roster (HMAC-signed proxy, cached) and falls back to the active office's CRM roster when
 * SyncHub is unreachable — so the datalist matches the SyncHub review form's estimator list.
 */
export function useRfpEstimators(officeId?: string, options: UseRfpEstimatorsOptions = {}) {
  const { enabled = true } = options;
  const [estimators, setEstimators] = useState<RfpEstimatorOption[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    // Abort any in-flight request before issuing a new one so a stale response cannot
    // overwrite the latest result on rapid officeId changes.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const headers = officeId && officeId !== "all" ? { "x-office-id": officeId } : undefined;
      const data = await api<{ estimators: RfpEstimatorOption[] }>("/deals/estimators", {
        ...(headers ? { headers } : {}),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setEstimators(Array.isArray(data.estimators) ? data.estimators : []);
    } catch (err) {
      if (controller.signal.aborted || (err as { name?: string })?.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to load estimators");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [officeId, enabled]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  return { estimators, loading, error, refetch: load };
}
