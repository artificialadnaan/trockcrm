/**
 * The walk queue's owner identity = user + ACTIVE OFFICE — same shape as
 * ../capture/upload-queue-core.ts's `uploadOwnerKey`, deliberately duplicated rather than imported.
 * Matches upload-core.ts's `sanitizeWalkOwnerKey`: see that module's header for why this queue is a
 * deliberate parallel implementation, not a shared one with ../capture.
 *
 * The FOREGROUND enqueue/drain (walk screen) and the BACKGROUND drain task must derive the exact same
 * string for the same signed-in user, or the background task would drain under a namespace the
 * foreground never wrote to — this is the single source of truth both import.
 *
 * Returns "" when there's no signed-in user; callers should skip enqueueing/draining for that case
 * (upload-core.ts's sanitizeWalkOwnerKey would otherwise fold every signed-out session into "anon").
 */
export function walkOwnerKey(userId: string | null | undefined, officeId: string | null | undefined): string {
  if (!userId) return "";
  return `${userId}:${officeId ?? ""}`;
}
