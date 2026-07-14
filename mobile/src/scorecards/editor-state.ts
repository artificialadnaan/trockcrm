import { MAX_SCORECARD_PHOTOS } from "./draft";

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
