/**
 * The identity a PHOTO-upload drain runs under, and the fetcher that speaks for it.
 *
 * Sibling of ../walkthrough/use-queue-session.ts. The two queues are a deliberate parallel
 * implementation rather than a shared one (see ../walkthrough/owner-key.ts's header, which duplicates
 * the owner-key derivation for the same reason) — so this is the photo queue's copy of the same two
 * rules, and a fix to either belongs in both.
 *
 * 1. OFFICE RESOLUTION (`activeOfficeId ?? primary office`) must match `uploadOwnerKey` and
 *    upload-background-task.ts exactly. A caller that resolves it differently reads and drains a queue
 *    namespace no capture was ever written into: it finds nothing, reports nothing wrong, and the real
 *    backlog sits untouched.
 *
 * 2. THE DRAIN HAS NO SIGN-OUT AUTHORITY. This is why this hook exists at all.
 *
 *    capture.tsx builds its own queue fetcher WITH `onUnauthorized: () => void signOut()`. That is
 *    survivable there only because the Capture screen is somewhere the user deliberately navigated to.
 *    The moment a photo drain also runs from the authenticated SHELL — which mounts for every route and
 *    re-runs on every foreground — that same fetcher becomes the unbreakable loop the walk queue already
 *    hit on real hardware: sign in -> shell drains -> one undeliverable photo 401s -> signed out -> sign
 *    in, forever, with no way out from inside the app. One stuck capture would make the app unusable.
 *
 *    A 401 on a background upload is not evidence the session is dead. It is evidence that one request
 *    was not authorised, which happens when the app is newer than the deployed API, when the endpoint
 *    rejects this class of session, or when a route moved. The queue already models that: the attempt is
 *    counted, the item is retried, and after MAX_UPLOAD_ATTEMPTS it lands on the failed card the user can
 *    see and act on. That is the honest report — "this photo could not be sent" — instead of a wrong
 *    inference about the session.
 *
 *    A genuinely dead token still ends the session promptly, just not from here: every interactive screen
 *    uses the auth context's own fetcher, and the first real call the user makes signs them out through
 *    the normal path. Sign-out authority belongs to requests the user is waiting on.
 */
import React from "react";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../api/client";
import type { Fetcher } from "../api/endpoints";
import { uploadOwnerKey } from "./upload-queue-core";

export type PhotoQueueSession = {
  /** Queue namespace for this user+office, or "" when not signed in far enough to have one. */
  ownerKey: string;
  /** Office the queue's API calls are scoped to — exposed for callers that pass it on separately. */
  resolvedOfficeId: string | null;
  /** Authenticated fetcher for background queue work. Deliberately cannot end the session — see 2 above. */
  queueFetcher: Fetcher;
};

export function usePhotoQueueSession(): PhotoQueueSession {
  const { user, activeOfficeId, token } = useAuth();
  const resolvedOfficeId = activeOfficeId ?? user?.tenantId ?? null;
  const ownerKey = uploadOwnerKey(user?.id, resolvedOfficeId);

  // Captured per session generation so a drain that outlives this hook keeps using the token it was
  // dispatched with, rather than reading a newer one it was never authorised under.
  const session = React.useMemo(() => ({ token, officeId: resolvedOfficeId }), [token, resolvedOfficeId]);

  const queueFetcher = React.useCallback<Fetcher>(
    (path, opts) =>
      apiFetch(path, {
        ...opts,
        token: session.token ?? undefined,
        officeId: session.officeId,
        // No onUnauthorized, deliberately. See rule 2 in this module's header.
      }),
    [session],
  );

  return { ownerKey, resolvedOfficeId, queueFetcher };
}
