// Loads the active field-responder roster (supers + PMs) for a deal's office and hands it to the scorecard
// Super/PM picker. Two pickers render on one screen (Super + PM) and the wizard re-mounts step components,
// so a MODULE-LEVEL cache keyed by dealId + in-flight-promise dedup collapses all of that to ONE request per
// deal for the life of the JS session. Failure NEVER throws — the picker degrades to free-text entry — so the
// hook returns `{ responders: [], loading: false, error }` on any fetch error instead of surfacing it.

import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { getFieldResponders } from "../api/endpoints";
import type { FieldResponderOption } from "../api/types";

type Loaded = { responders: FieldResponderOption[]; error: string | null };

// Resolved rosters (or a resolved error) per dealId. A resolved entry short-circuits future mounts with no
// network. In-flight requests are deduped separately so the two pickers share one fetch.
const cache = new Map<string, Loaded>();
const inflight = new Map<string, Promise<Loaded>>();

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Could not load the responder list.";
}

/**
 * Fetch-and-cache the roster for `dealId`, sharing one in-flight promise across concurrent callers. Always
 * resolves to a `Loaded` (never rejects): a failed fetch resolves to `{ responders: [], error }` and is cached
 * so a transient failure doesn't hammer the endpoint on every re-mount. `fetcher` is passed per-call (it's
 * bound to the current auth/office) but the result is keyed only by dealId.
 */
function loadResponders(
  dealId: string,
  fetcher: ReturnType<typeof useAuth>["fetcher"],
): Promise<Loaded> {
  const cached = cache.get(dealId);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(dealId);
  if (existing) return existing;
  const promise = getFieldResponders(fetcher, dealId)
    .then((res): Loaded => {
      const responders = Array.isArray(res?.responders) ? res.responders : [];
      const result: Loaded = { responders, error: null };
      cache.set(dealId, result);
      return result;
    })
    .catch((err): Loaded => {
      const result: Loaded = { responders: [], error: errorMessage(err) };
      cache.set(dealId, result);
      return result;
    })
    .finally(() => {
      inflight.delete(dealId);
    });
  inflight.set(dealId, promise);
  return promise;
}

export function useFieldResponders(dealId: string): {
  responders: FieldResponderOption[];
  loading: boolean;
  error: string | null;
} {
  const { fetcher } = useAuth();
  const cached = cache.get(dealId);
  const [responders, setResponders] = useState<FieldResponderOption[]>(cached?.responders ?? []);
  const [error, setError] = useState<string | null>(cached?.error ?? null);
  // A blank dealId has no roster to load; a cache hit is already resolved. Otherwise we start loading.
  const [loading, setLoading] = useState<boolean>(Boolean(dealId) && !cached);

  useEffect(() => {
    if (!dealId) {
      setResponders([]);
      setError(null);
      setLoading(false);
      return;
    }
    const hit = cache.get(dealId);
    if (hit) {
      setResponders(hit.responders);
      setError(hit.error);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    void loadResponders(dealId, fetcher).then((result) => {
      if (!active) return;
      setResponders(result.responders);
      setError(result.error);
      setLoading(false);
    });
    return () => {
      active = false;
    };
    // `fetcher` identity changes when token/office change; we intentionally key the load on dealId and reuse
    // the cache, so we don't want a new fetcher reference alone to re-trigger a load. dealId is the real key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId]);

  return { responders, loading, error };
}
