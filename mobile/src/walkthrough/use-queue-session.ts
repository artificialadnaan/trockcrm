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
 * 2. THE DRAIN HAS NO SIGN-OUT AUTHORITY AT ALL. This is the important one, and it is deliberate.
 *
 *    A 401 on a background upload is NOT evidence the user's session is dead. It is evidence that
 *    one request was not authorised, which has several causes that have nothing to do with the
 *    session: the endpoint does not exist on the deployed server (an app newer than the API), the
 *    endpoint exists but rejects this CLASS of session, or the route simply moved. Every one of
 *    those is a server-shape problem, and the user is meanwhile perfectly authenticated for
 *    everything they can actually see.
 *
 *    Getting this wrong is not a small bug — it is a total lockout, and it was observed on real
 *    hardware: the shell drains the queue the moment the authenticated tree mounts, so a single
 *    undeliverable walk produced sign in -> drain -> 401 -> signed out -> sign in, forever, with no
 *    way out of the loop from inside the app. One stuck recording made the app unusable.
 *
 *    So the queue's fetcher passes NO `onUnauthorized`. A 401 surfaces to the drain as an ordinary
 *    request failure, which the queue already models: the attempt is counted, the walk is retried,
 *    and after enough attempts it lands on the failed-walk card the user can see and act on. That
 *    is the honest report — "this walk could not be sent" — rather than a wrong inference about
 *    the session.
 *
 *    A genuinely dead token still ends the session promptly, just not from here: every INTERACTIVE
 *    screen uses the auth context's own fetcher, and the first real call the user makes signs them
 *    out through the normal path. Sign-out authority belongs to requests the user is waiting on.
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
  /** Authenticated fetcher for background queue work. Deliberately cannot end the session — see 2 above. */
  queueFetcher: Fetcher;
};

export function useWalkQueueSession(): WalkQueueSession {
  const { user, activeOfficeId, token } = useAuth();
  const resolvedOfficeId = activeOfficeId ?? user?.tenantId ?? null;
  const ownerKey = walkOwnerKey(user?.id, resolvedOfficeId);

  // Captured per session generation so a drain that outlives this hook keeps using the token it was
  // dispatched with, rather than reading a newer one it was never authorised under.
  const session = React.useMemo(
    () => ({ token, officeId: resolvedOfficeId }),
    [token, resolvedOfficeId],
  );

  const queueFetcher = React.useCallback<Fetcher>(
    (path, opts) =>
      apiFetch(path, {
        ...opts,
        token: session.token ?? undefined,
        officeId: session.officeId,
        // No onUnauthorized, deliberately. A 401 here becomes an ordinary failed attempt the queue
        // already knows how to count and surface. See rule 2 in this module's header for why giving
        // background work the power to end a session produced an unbreakable sign-in loop.
      }),
    [session],
  );

  return { ownerKey, resolvedOfficeId, queueFetcher };
}
