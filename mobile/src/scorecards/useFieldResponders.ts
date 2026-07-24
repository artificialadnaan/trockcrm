// Loads the active field-responder roster (supers + PMs) for a deal's office and hands it to the scorecard
// Super/PM picker. Fetched FRESH on each mount, keyed on the deal AND the current auth fetcher. The roster is
// mutable — an admin can deactivate a responder or change a role at any time — and it carries names/emails, so
// we deliberately do NOT cache it across mounts or auth sessions: a module-level cache would keep offering a
// just-deactivated person (defeating the endpoint's active-only contract) and could serve one signed-in user's
// roster to the next user on a shared device without re-running the server's per-session authorization. Only
// ONE hook call is made per scorecard step (both pickers read its result), so there is no fan-out to dedup.
// Failure NEVER throws — the picker degrades to free-text entry — so we return `{ responders: [], error }`.

import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { getFieldResponders } from "../api/endpoints";
import type { FieldResponderOption } from "../api/types";

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Could not load the responder list.";
}

export function useFieldResponders(dealId: string): {
  responders: FieldResponderOption[];
  loading: boolean;
  error: string | null;
} {
  const { fetcher } = useAuth();
  const [responders, setResponders] = useState<FieldResponderOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(dealId));
  // Monotonic request token — drop a stale response (dealId/fetcher changed, or unmount) so a slow older
  // request can't clobber the current roster.
  const reqRef = useRef(0);

  useEffect(() => {
    if (!dealId) {
      setResponders([]);
      setError(null);
      setLoading(false);
      return;
    }
    const token = ++reqRef.current;
    setResponders([]);
    setError(null);
    setLoading(true);
    getFieldResponders(fetcher, dealId)
      .then((res) => {
        if (token !== reqRef.current) return;
        setResponders(Array.isArray(res?.responders) ? res.responders : []);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (token !== reqRef.current) return;
        setResponders([]);
        setError(errorMessage(err));
        setLoading(false);
      });
    return () => {
      reqRef.current += 1; // invalidate any in-flight response on unmount / dealId / fetcher change
    };
    // Keyed on dealId AND fetcher: a session or office change (new fetcher identity) refetches so the active-only
    // roster + authorization are re-evaluated for the current user; the previous session's roster is never reused.
  }, [dealId, fetcher]);

  return { responders, loading, error };
}
