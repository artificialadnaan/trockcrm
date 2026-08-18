// Pure editor-state helpers for the weekly-report wizard, kept out of the screen so they are unit-testable
// in the one suite `mobile/` actually runs. Mirrors scorecards/editor-state.ts.

export interface WeeklyReportEditorBusyState {
  submitting: boolean;
  importing: boolean;
  voiceBusy: boolean;
}

/**
 * Why the wizard cannot safely be left right now, or null.
 *
 * Each case is a way to LOSE work rather than a cosmetic guard: leaving mid-submit abandons a request the
 * server may already have committed, leaving mid-import abandons a photo that is being uploaded into the
 * project gallery, and leaving mid-dictation unmounts the recorder before the transcript comes back — the
 * user's spoken paragraph, gone with no trace that it existed.
 */
export function weeklyReportEditorBusyMessage(state: WeeklyReportEditorBusyState): string | null {
  if (state.submitting) return "Saving this report — please wait.";
  if (state.importing) return "Importing a photo — one moment…";
  if (state.voiceBusy) return "Finishing dictation — please wait before leaving.";
  return null;
}

/**
 * Turn a failed save into something a superintendent can act on.
 *
 * The server's own message is preferred whenever it has one, because the actionable cases all carry it —
 * "A sent report cannot be edited", "This report changed while you were working on it", "Add the work
 * completed before submitting". The generic fallback exists for transport failures, where the only true
 * statement is that the local draft survived and the operation can be retried.
 */
export function weeklyReportSubmitErrorMessage(error: unknown): string {
  const candidate = error as { status?: unknown; message?: unknown } | null | undefined;
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;
  const serverMessage = typeof candidate?.message === "string" ? candidate.message.trim() : "";

  // ApiError(0) is a transport failure and ApiError(408) a timeout; both carry a message about the socket,
  // not about the report, so neither is worth showing to someone standing on a jobsite.
  //
  // "YOUR REPORT IS SAVED ON THIS PHONE" IS A PROMISE, and for a while it was a false one: the draft did
  // survive the failed save, and then the Resume link that led back to it reseeded from the server and
  // deleted every un-submitted edit. What keeps this sentence true is weekly-reports/reconcile.ts — no
  // door reseeds a draft that holds local edits without the user choosing it. If that ever changes, this
  // copy has to change with it.
  if (status === 0 || status === 408) {
    return "No connection — your report is saved on this phone. Try again once you have a signal.";
  }
  if (serverMessage && !serverMessage.startsWith("Request failed (")) return serverMessage;
  return "Couldn’t save this report. Your work is saved on this phone — try again.";
}

/** Progress text for the step indicator: "Step 2 of 6". */
export function weeklyReportStepLabel(index: number, total: number): string {
  return `Step ${index + 1} of ${total}`;
}
