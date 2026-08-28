/**
 * Temporary, per-tab state for the assignment reminder.
 *
 * This is deliberately separate from the modal component because a successful login may immediately
 * follow a cross-origin `returnTo`. The AuthProvider must remove the old user's state BEFORE it returns
 * that URL to the login screen; waiting for the modal to mount loses the race to `window.location.replace`.
 */
export const TASK_ASSIGNMENT_MODAL_SHOWN_STORAGE_PREFIX = "trock:task-assignment-modal:shown:";
export const TASK_ASSIGNMENT_MODAL_CHECKED_OFFICES_STORAGE_PREFIX =
  "trock:task-assignment-modal:checked-offices:";

export function taskAssignmentModalShownStorageKey(userId: string) {
  return `${TASK_ASSIGNMENT_MODAL_SHOWN_STORAGE_PREFIX}${userId}`;
}

export function taskAssignmentModalCheckedOfficesStorageKey(userId: string) {
  return `${TASK_ASSIGNMENT_MODAL_CHECKED_OFFICES_STORAGE_PREFIX}${userId}`;
}

/**
 * Offices for which this browser session has already received an authoritative pending-assignment
 * answer. It prevents the reminder from turning every ordinary click into a database request while
 * still allowing an explicit new sign-in to begin a fresh reminder session.
 */
export function readTaskAssignmentModalCheckedOffices(userId: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(taskAssignmentModalCheckedOfficesStorageKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function persistTaskAssignmentModalCheckedOffices(userId: string, officeIds: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      taskAssignmentModalCheckedOfficesStorageKey(userId),
      JSON.stringify([...officeIds]),
    );
  } catch {
    // A repeat after reload is preferable to blocking the reminder on unavailable browser storage.
  }
}

/** Forget all browser-session reminder state for this person after a real interactive sign-in. */
export function clearTaskAssignmentModalSessionState(userId: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(taskAssignmentModalShownStorageKey(userId));
    window.sessionStorage.removeItem(taskAssignmentModalCheckedOfficesStorageKey(userId));
  } catch {
    // A repeat is preferable to blocking login on unavailable browser storage.
  }
}
