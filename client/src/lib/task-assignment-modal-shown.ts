/**
 * The temporary, per-tab suppression set for the assignment login modal.
 *
 * This is deliberately separate from the modal component because a successful login may immediately
 * follow a cross-origin `returnTo`. The AuthProvider must remove the old user's set BEFORE it returns
 * that URL to the login screen; waiting for the modal to mount loses the race to `window.location.replace`.
 */
export const TASK_ASSIGNMENT_MODAL_SHOWN_STORAGE_PREFIX = "trock:task-assignment-modal:shown:";

export function taskAssignmentModalShownStorageKey(userId: string) {
  return `${TASK_ASSIGNMENT_MODAL_SHOWN_STORAGE_PREFIX}${userId}`;
}

/**
 * Forget only this person's temporary shown-set.
 *
 * Storage can throw in private browsing and under quota pressure. That must never turn a successful
 * login into an error, and the modal's in-memory guard still covers the current mount in that case.
 */
export function clearTaskAssignmentModalShownTasks(userId: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(taskAssignmentModalShownStorageKey(userId));
  } catch {
    // A repeat is preferable to blocking login on unavailable browser storage.
  }
}
