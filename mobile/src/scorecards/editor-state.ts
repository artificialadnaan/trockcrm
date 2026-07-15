import { MAX_SCORECARD_PHOTOS } from "./draft";

export const SCORECARD_EDIT_CONFLICT_CODE = "SCORECARD_EDIT_CONFLICT";
export const SCORECARD_EDIT_PHOTO_LIMIT_CODE = "SCORECARD_EDIT_PHOTO_LIMIT";

export interface ScorecardEditorBusyState {
  submitting: boolean;
  savingPhotos: boolean;
  voiceBusy: boolean;
}

/** User-facing reason an editor cannot safely be left right now. */
export function scorecardEditorBusyMessage(state: ScorecardEditorBusyState): string | null {
  if (state.submitting) return "Saving this scorecard — please wait.";
  if (state.savingPhotos) return "Saving a photo — one moment…";
  if (state.voiceBusy) return "Finishing dictation — please wait before leaving.";
  return null;
}

/** Explain a conflict rebase that preserved more evidence than the server accepts. */
export function scorecardPhotoOverflowMessage(photoCount: number): string | null {
  const overflow = Math.max(0, photoCount - MAX_SCORECARD_PHOTOS);
  if (overflow === 0) return null;
  return `This edit now has ${photoCount} photos after loading the latest revision. Remove ${overflow} photo${overflow === 1 ? "" : "s"} before saving; no evidence was removed automatically.`;
}

export interface ScorecardEditorSubmitError {
  hasEditConflict: boolean;
  message: string;
}

/**
 * Decide whether a failed save should expose conflict/rebase recovery. HTTP 409 alone is not sufficient:
 * scorecard edits also use 409 for actionable constraints such as the preserved-evidence photo limit.
 */
export function scorecardEditorSubmitError(
  error: unknown,
  editingSubmitted: boolean,
): ScorecardEditorSubmitError {
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown } | null | undefined;
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;
  const code = typeof candidate?.code === "string" ? candidate.code : undefined;
  const serverMessage = typeof candidate?.message === "string" ? candidate.message.trim() : "";

  if (status === 409 && code === SCORECARD_EDIT_CONFLICT_CODE) {
    return {
      hasEditConflict: true,
      message: "This scorecard changed in another session. Your local work is safe. Reload the latest revision to retry with your changes.",
    };
  }

  if (status === 409) {
    const actionableMessage = serverMessage && !serverMessage.startsWith("Request failed (")
      ? serverMessage
      : code === SCORECARD_EDIT_PHOTO_LIMIT_CODE
        ? "This scorecard contains too many evidence photos. Remove photos and try again."
        : "Couldn’t save the scorecard changes. Your work is saved — try again.";
    return { hasEditConflict: false, message: actionableMessage };
  }

  return {
    hasEditConflict: false,
    message: editingSubmitted
      ? "Couldn’t save the scorecard changes. Your work is saved — try again."
      : "Couldn’t submit the scorecard. Your work is saved — try again.",
  };
}
