/**
 * The identity a walk-upload drain runs under, and the fetcher that speaks for it.
 *
 * Four places drain the walkthrough queue — the authenticated shell (on mount and on foreground
 * resume), the walk screen (the moment a walk reaches a terminal state), Profile's failed-walk
 * retry, and the background task. The first three each used to build this inline, identically, and
 * each carried the same defect. This is that logic in one place so a fix lands in all of them.
 *
 * TWO rules are bundled here deliberately, because getting either wrong produces a bug that only
 * shows up at a session boundary and looks like something else entirely:
 *
 * 1. OFFICE RESOLUTION (`activeOfficeId ?? primary office`) must match owner-key.ts and the
 *    background task exactly. A caller that resolves it differently reads and drains a manifest
 *    namespace no walk was ever written into — it finds nothing, reports nothing wrong, and the
 *    real queue sits untouched.
 *
 * 2. SIGN-OUT AUTHORITY is scoped to the session generation that started the drain. A drain
 *    deliberately outlives the screen that started it: abandoning a multi-gigabyte upload at
 *    sign-out is the failure the shell's resume effect exists to prevent, so the drain keeps
 *    running with the fetcher it was handed. That fetcher holds THIS token and THIS signOut. Once
 *    a different user signs in, both are obsolete — the old token is revoked, so the abandoned
 *    drain's next API call 401s, and an unguarded `onUnauthorized` would clear the in-memory auth
 *    state and the persisted session, signing out the user who just signed IN. `retired` draws the
 *    line: a 401 on a live session still ends it (that token really is dead), a 401 on a superseded
 *    one is only ever news about a token nobody is using anymore.
 */
import React from "react";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../api/client";
import type { Fetcher } from "../api/endpoints";
import { walkOwnerKey } from "./owner-key";

export type WalkQueueSession = {
  /** Manifest namespace for this user+office, or null when not signed in far enough to have one. */
  ownerKey: string | null;
  /** Office the queue's API calls are scoped to — exposed for callers that pass it on separately. */
  resolvedOfficeId: string | null;
  /** Authenticated fetcher whose 401 handling is bound to the session that created it. */
  queueFetcher: Fetcher;
};

export function useWalkQueueSession(): WalkQueueSession {
  const { user, activeOfficeId, token, signOut } = useAuth();
  const resolvedOfficeId = activeOfficeId ?? user?.tenantId ?? null;
  const ownerKey = walkOwnerKey(user?.id, resolvedOfficeId);

  // ONE object whose identity changes whenever the session does, so the effect below has something
  // stable to retire. Holding token/signOut in a ref-like object rather than closing over them
  // directly is what lets an already-dispatched drain keep using its own generation's values while
  // this hook moves on to the next.
  const session = React.useMemo(
    () => ({ token, officeId: resolvedOfficeId, signOut, retired: false }),
    [token, resolvedOfficeId, signOut],
  );

  React.useEffect(() => {
    // Re-arm rather than assume: StrictMode and Fast Refresh run cleanup-then-effect against the
    // SAME object, and a session left retired by that would silently stop honouring real 401s.
    session.retired = false;
    return () => {
      session.retired = true;
    };
  }, [session]);

  const queueFetcher = React.useCallback<Fetcher>(
    (path, opts) =>
      apiFetch(path, {
        ...opts,
        token: session.token ?? undefined,
        officeId: session.officeId,
        onUnauthorized: () => {
          if (!session.retired) void session.signOut();
        },
      }),
    [session],
  );

  return { ownerKey, resolvedOfficeId, queueFetcher };
}
