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
// The first version of that fix read "if the server refuses the move and the report is ALREADY AT OR PAST
// the state we were asking for, the move we wanted has happened". That is too permissive, and the case it
// swallows is worse than the one it cures:
//
//   a PM opens a stale local draft of a report the SUPERINTENDENT has since submitted → the wizard's
//   submit PATCHes the PM's older text and PUTs the PM's older photo set over it → the transition to
//   pending_review answers 409 because the report is already there → the re-read confirms
//   `pending_review` → reported as SUCCESS, draft deleted, no banner.
//
// The super's narrative and photo set have just been reverted and every surface says it worked. Reaching
// the target status is not evidence that I am the one who got it there.
//
// So the rule needs a second input: has THIS CLIENT fired this transition and never learned the outcome?
// Only then can "it is already there" be my own commit. That marker is persisted on the draft
// (`pendingTransitionTo`), because the two attempts are normally separated by a dead connection or an app
// kill, and it is armed BEFORE the request leaves the phone. Without a marker a 409 is somebody else's
// move: rethrown, and — when the re-read shows they have already advanced the report this client just
// wrote over — rethrown with copy that says so.

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
 * Somebody else advanced the report, and this client had already written to it.
 *
 * Distinct from a bare 409 because the honest sentence is not "that failed" — the PATCH and the photo PUT
 * SUCCEEDED, on top of whatever the other person had put there. The only useful thing to tell the person
 * holding the phone is that their save landed on a report that has since moved, and where to look.
 *
 * `status: 409` so `weeklyReportSubmitErrorMessage` treats it like any other server answer and shows the
 * message verbatim rather than the generic offline copy.
 */
export class WeeklyReportOvertakenError extends Error {
  readonly status = 409;
  constructor() {
    super(
      "Somebody else has already moved this report on, and what you just saved has replaced what was on it. Open the report again from Reports to see where it stands.",
    );
    this.name = "WeeklyReportOvertakenError";
  }
}

/**
 * Could this failure have left the transition COMMITTED on the server?
 *
 * The question the marker exists to answer. A definite HTTP answer from the application (a 4xx, or a 500
 * from a handler that threw and rolled back) means the move did not happen and the marker must be cleared
 * — otherwise a later 409 raised by somebody ELSE's move would be read as this client's lost reply, which
 * is the exact bug being closed here.
 *
 * Everything else is genuinely unknown: ApiError(0) is a transport failure and ApiError(408) a client-side
 * timeout — both fire on requests that reached the server and committed — and a 502/503/504 comes from a
 * proxy that may well be sitting in front of a commit. A non-numeric status is not an ApiError at all, so
 * nothing can be concluded from it.
 *
 * The bias is deliberate. Keeping the marker when the move did NOT commit costs a false success only if a
 * third party then advances the report in the same window; dropping it when the move DID commit strands
 * the draft for the rest of its life, which is the failure this whole module exists to prevent.
 */
export function weeklyReportTransitionOutcomeUnknown(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (typeof status !== "number") return true;
  if (status === 0 || status === 408) return true;
  return status === 502 || status === 503 || status === 504;
}

/**
 * Ask for a transition, and treat "it is already there" as success ONLY when it can be this client's own
 * commit coming back late.
 *
 * Only a 409 is investigated. A 403 is a permission answer, a 400 is a validation answer, and a transport
 * failure (ApiError 0/408) means the request may never have been received — none of those may be resolved
 * by re-reading, and all of them are rethrown so the wizard's banner says what actually went wrong.
 *
 * `mayHaveCommitted` is the caller's persisted answer to "have I fired exactly this transition on exactly
 * this report and never learned how it went?". False means any 409 is somebody else's doing:
 *
 *   • if the re-read shows they have already reached the state we wanted, this client's content writes
 *     have just landed on top of theirs — WeeklyReportOvertakenError, which is a failure, not a success;
 *   • otherwise the original 409 stands ("this report changed while you were working on it").
 *
 * If the re-read itself fails the ORIGINAL 409 is rethrown, not the read error: the user is being told
 * about the operation they asked for, and a second failure on a diagnostic call is noise.
 */
export async function transitionWeeklyReportIdempotently(input: {
  to: WeeklyReportStatusValue;
  /** Has this client already fired this transition without learning the outcome? */
  mayHaveCommitted: boolean;
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
    if (!input.mayHaveCommitted) throw new WeeklyReportOvertakenError();
    return { status: current as WeeklyReportStatusValue, alreadyThere: true };
  }
}
