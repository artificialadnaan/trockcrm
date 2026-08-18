// Making the report's LAST step survive a lost response, the way its first step already does.
//
// `POST /reports` carries a `clientSubmissionId` precisely so that a create whose reply never arrives can
// be retried without producing a second report for the week. The transition that FILES the report had no
// equivalent, and the failure it left behind was terminal:
//
//   the transition commits server-side → the response is lost on the jobsite's LTE → the wizard catches,
//   never records the new status, and says "No connection — your report is saved on this phone" → the
//   super retries → the PATCH and the photo PUT land (the author may still edit at pending_review) → the
//   transition answers 409 "A pending_review report cannot move to pending_review" → every later retry
//   answers the same.
//
// The report was filed. The phone insisted it had failed, the draft never cleared, and the only way out
// was "Discard", whose dialog reads like it destroys the report.
//
// The rule below is the whole fix: if the server refuses the move and the report is ALREADY AT OR PAST the
// state we were asking for, the move we wanted has happened. Anything else is a real conflict and is
// rethrown untouched.

import type { WeeklyReportStatusValue } from "../api/types";

/** The status ladder, in order. Nothing here depends on it beyond comparing two positions. */
const WEEKLY_REPORT_STATUS_ORDER: WeeklyReportStatusValue[] = [
  "draft",
  "pending_review",
  "approved",
  "sent",
];

/**
 * Has `current` reached `target`?
 *
 * At-or-PAST, not equal: while the response was in flight the PM may have approved the report, or sent it.
 * The submit still succeeded — insisting on an exact match would strand the draft for the one case where
 * the work moved fastest.
 *
 * An unrecognised status (an older or newer build's) answers false, so an unknown value can never be read
 * as success.
 */
export function weeklyReportStatusReached(
  current: WeeklyReportStatusValue | null | undefined,
  target: WeeklyReportStatusValue,
): boolean {
  const at = WEEKLY_REPORT_STATUS_ORDER.indexOf(current as WeeklyReportStatusValue);
  const wanted = WEEKLY_REPORT_STATUS_ORDER.indexOf(target);
  if (at < 0 || wanted < 0) return false;
  return at >= wanted;
}

/**
 * Ask for a transition, and treat "it is already there" as the success it is.
 *
 * Only a 409 is investigated. A 403 is a permission answer, a 400 is a validation answer, and a transport
 * failure (ApiError 0/408) means the request may never have been received — none of those may be resolved
 * by re-reading, and all of them are rethrown so the wizard's banner says what actually went wrong.
 *
 * If the re-read itself fails the ORIGINAL 409 is rethrown, not the read error: the user is being told
 * about the operation they asked for, and a second failure on a diagnostic call is noise.
 */
export async function transitionWeeklyReportIdempotently(input: {
  to: WeeklyReportStatusValue;
  transition: () => Promise<WeeklyReportStatusValue>;
  readStatus: () => Promise<WeeklyReportStatusValue | null | undefined>;
}): Promise<{ status: WeeklyReportStatusValue; alreadyThere: boolean }> {
  try {
    return { status: await input.transition(), alreadyThere: false };
  } catch (error) {
    const status = (error as { status?: unknown } | null | undefined)?.status;
    if (status !== 409) throw error;

    let current: WeeklyReportStatusValue | null | undefined;
    try {
      current = await input.readStatus();
    } catch {
      throw error;
    }
    if (!weeklyReportStatusReached(current, input.to)) throw error;
    return { status: current as WeeklyReportStatusValue, alreadyThere: true };
  }
}
