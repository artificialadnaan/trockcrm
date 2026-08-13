import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { getOfficeRequestOptions, type OfficeRequestOptions } from "@/lib/office-selection";

export interface RepRosterOption {
  id: string;
  displayName: string;
}

/**
 * The reps a board filter may offer — the same roster the director dashboard's cards and funnel use.
 *
 * Replaces useTaskAssignees on the deals dashboard and the leads list. Those dropdowns were listing every
 * active account in the office (field contractors, admins, dormant logins) because "who can be assigned a
 * task" was the only ready-made people feed, not because it was the right set.
 *
 * The `loadedOfficeId` contract is carried over from useTaskAssignees UNCHANGED and is load-bearing, not
 * decorative: the deals dashboard drops a saved rep filter that is not in this list, and during an office
 * switch the hook briefly reports the PREVIOUS office's list with loading already false. A caller that
 * pruned on that intermediate state would discard a perfectly valid saved filter. Callers must defer until
 * `loadedOfficeId === the office they asked for`.
 */
export interface UseRepRosterOptions extends OfficeRequestOptions {
  /**
   * When false, no request is issued and `reps` stays empty.
   *
   * For callers that mount the hook unconditionally but only render a rep control in some modes — the
   * deals list section draws its own owner dropdown only outside FilterBar mode, so on the stage page,
   * the director rep detail and the base /deals view the result was fetched and then discarded, once per
   * mount, duplicating the roster request (and its deal_owners scan) that the parent page already made.
   *
   * `loadedOfficeId` still settles to the requested office when disabled, so a caller gating on it is not
   * left waiting forever for a load that will never happen.
   */
  enabled?: boolean;
}

export function useRepRoster(options: UseRepRosterOptions = {}) {
  const { enabled = true } = options;
  const [reps, setReps] = useState<RepRosterOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedOfficeId, setLoadedOfficeId] = useState<string | null | undefined>(undefined);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    const requestOfficeId = options.officeId ?? null;
    if (!enabled) {
      setReps([]);
      setError(null);
      setLoading(false);
      setLoadedOfficeId(requestOfficeId);
      return;
    }
    setLoading(true);
    setError(null);
    setReps([]);
    try {
      const data = await api<{ users: RepRosterOption[] }>(
        "/dashboard/rep-roster",
        getOfficeRequestOptions(options.officeId)
      );
      if (requestId !== requestRef.current) return;
      // Guard the SHAPE, not just the request. `data.users` is undefined for any response that isn't the
      // one expected — an error envelope, a proxy's HTML, a future contract change — and storing that
      // undefined turns the very next render into `undefined.map(...)`, i.e. a white screen on the whole
      // deals dashboard rather than an empty dropdown on it. An empty roster is a degraded filter; a
      // thrown render is a dead page.
      setReps(Array.isArray(data?.users) ? data.users : []);
    } catch (err: unknown) {
      if (requestId !== requestRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load reps");
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

  return { reps, loading, error, loadedOfficeId, refetch: load };
}
