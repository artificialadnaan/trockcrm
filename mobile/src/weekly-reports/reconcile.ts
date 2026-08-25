// What happens when a local weekly-report draft meets the server copy of the same report.
//
// Every door onto a report that already has a row — the PM's review queue, the project card, the
// In-progress "Resume" link, and a local draft whose week turns out to have been started on another
// device — asks this module the same question, and it is the only place the answer is decided.
//
// The rule this replaces was "reseed a REVIEW draft, resume an AUTHOR draft", and both halves were wrong
// in a way that destroyed work:
//
//   • Reseeding unconditionally threw away every un-submitted local edit. A PM who rewrote Issues and
//     fixed six captions, backed out, and tapped Resume lost the lot — no prompt, no diff, and the row
//     that promised "Resume" is what deleted it. The wizard had just told them "your report is saved on
//     this phone".
//   • Resuming unconditionally filed a stale snapshot over newer server content. An AUTHOR-mode draft
//     seeded from a report and left for an hour would, on the next open, PATCH its old text and PUT its
//     old photo set over whatever the superintendent submitted in the meantime.
//
// Neither is a freshness question, and mode was never the discriminator. The question is whether the
// SERVER has moved since this draft last looked, and whether the USER has typed anything since. Those are
// independent, and only one of the four combinations is a genuine conflict:
//
//   no local edits                 → reseed. There is nothing to lose and the server is authoritative.
//   local edits, server unmoved    → keep local. Nobody else has touched it; the draft is a superset.
//   local edits, server moved      → ASK. Whichever way this is resolved, somebody's work is replaced,
//                                    and the person holding the phone is the only one who can choose.
//
// `seededFrom` is what makes the two questions answerable at all — see draft.ts.

import type { WeeklyReportStatusValue } from "../api/types";
import { WEEKLY_REPORT_EMPTY_SIGNATURE, type WeeklyReportSeedState } from "./draft";

/** The server state a door is reconciling against, reduced to what the decision reads. */
export interface WeeklyReportServerState {
  status: WeeklyReportStatusValue;
  /** `weeklyReportDraftSignature` of a draft seeded from this report — see draft.ts. */
  signature: string;
  permissions: { canEdit: boolean; canApprove: boolean };
}

/** The local draft this door found, reduced likewise. Null when there is none. */
export interface WeeklyReportLocalState {
  seededFrom: WeeklyReportSeedState | null;
  signature: string;
}

/**
 * WHY a door refused, which is not a presentation detail.
 *
 *   unwritable   → the server will reject every write this user could make (sent, or approved and they
 *                  are not the PM). Opening the local copy read-only is therefore SAFE: the wizard can
 *                  render it and the text can be copied out, and the worst a mistaken Submit can do is
 *                  earn a 403 that changes nothing.
 *   bounced-back → a review door onto a report sent back to the superintendent. The PM still has
 *                  `canEdit` here, so opening anything is NOT safe: the final tap PATCHes content and
 *                  REPLACES the photo set before the illegal draft → approved 409s, and those mutations
 *                  stick. There is also no lockout to relieve — the project card offers the same week in
 *                  AUTHOR mode, which this gate deliberately allows.
 */
export type WeeklyReportRefusalReason = "unwritable" | "bounced-back";

export type WeeklyReportReconciliation =
  /** The report cannot be acted on from this door at all — nothing is opened. */
  | { kind: "refuse"; title: string; message: string; reason: WeeklyReportRefusalReason }
  /** Take the server's copy. Safe: the local draft holds nothing the user has not already seen. */
  | { kind: "reseed" }
  /** Open the local draft as it stands, re-stamped with the server state it has now been shown. */
  | { kind: "keep-local" }
  /** Both sides changed. The user picks, and is told what each choice costs. */
  | {
      kind: "conflict";
      title: string;
      message: string;
      keepLocalLabel: string;
      useServerLabel: string;
    };

/**
 * Why this door must not open the report at all, or null.
 *
 * Shared by every entry point, because they were NOT applying the same rule. `openReviewFresh` refused a
 * report that had gone back to `draft` — Approve would land the PATCH and the whole-set photo PUT and only
 * THEN 409 on the illegal draft → approved, so the mutations stick and only the transition fails — while
 * the review door taken when the PM had no local draft checked `canEdit` alone and walked straight into
 * it. One gate, one place.
 *
 * The three cases:
 *
 *   !canEdit           → sent, or approved and the viewer is not the PM. Nothing can be written.
 *   review + draft     → bounced back to the superintendent. A PM still has canEdit here, so an
 *                        edit-only check opens review mode and ends on a button that cannot complete.
 *   approved (review)  → OPENS. The final action is "Save changes", not Approve: the ladder has no
 *                        approved → approved self-transition, so canApprove is false and gating on it
 *                        would lock the PM out of the approved-but-unsent reports this queue carries.
 */
export function weeklyReportOpenRefusal(input: {
  mode: "author" | "review";
  status: WeeklyReportStatusValue;
  permissions: { canEdit: boolean; canApprove: boolean };
}): { title: string; message: string; reason: WeeklyReportRefusalReason } | null {
  if (!input.permissions.canEdit) {
    return {
      reason: "unwritable",
      title: "This report has moved on",
      message: "It has already been sent, or somebody else reviewed it. Pull down to refresh.",
    };
  }
  if (input.mode === "review" && input.status === "draft" && !input.permissions.canApprove) {
    return {
      reason: "bounced-back",
      title: "This report has moved on",
      message: "It went back to the superintendent for changes. Pull down to refresh.",
    };
  }
  return null;
}

export function weeklyReportReconcile(input: {
  mode: "author" | "review";
  server: WeeklyReportServerState;
  local: WeeklyReportLocalState | null;
}): WeeklyReportReconciliation {
  const refusal = weeklyReportOpenRefusal({
    mode: input.mode,
    status: input.server.status,
    permissions: input.server.permissions,
  });
  if (refusal) return { kind: "refuse", ...refusal };

  if (!input.local) return { kind: "reseed" };

  // A draft that has never been reconciled is compared against an EMPTY report in `draft` — which is
  // exactly what `POST /reports` leaves behind. So a local draft and the row it is about to adopt compare
  // equal when nobody else has typed into that row, and differ the moment somebody has.
  const baseline = input.local.seededFrom ?? {
    status: "draft" as WeeklyReportStatusValue,
    signature: WEEKLY_REPORT_EMPTY_SIGNATURE,
  };
  const localEdits = input.local.signature !== baseline.signature;
  if (!localEdits) return { kind: "reseed" };

  const serverMoved =
    input.server.status !== baseline.status || input.server.signature !== baseline.signature;
  if (!serverMoved) return { kind: "keep-local" };

  // Both sides moved, TO THE SAME PLACE. This is the ordinary shape of a submit whose PATCH and photo PUT
  // landed and whose transition did not: the server now holds exactly what the phone holds, and the
  // baseline is simply out of date. There is nothing to choose between, and a prompt here would appear on
  // the most common retry path there is — which is how people learn to dismiss the prompt unread.
  if (input.server.signature === input.local.signature) return { kind: "keep-local" };

  return {
    kind: "conflict",
    title: "This report changed while you had it open",
    // Names BOTH costs. Either answer replaces somebody's writing, and a dialog that only warned about one
    // of them would just move the silent loss to the other button.
    message:
      input.mode === "review"
        ? "Somebody else has changed this report since you started reviewing it. Keep your version and it replaces theirs; load theirs and the edits you made on this phone are gone."
        : "Somebody else has changed this report since you started it. Keep this phone's version and it replaces theirs; load theirs and the work you did on this phone is gone.",
    keepLocalLabel: "Keep my version",
    useServerLabel: "Load theirs",
  };
}

// ── The week was started somewhere else ──────────────────────────────────────
//
// A superintendent can type a whole report on their phone without ever reaching the photos step, so no
// server row exists and the draft carries no report id. Reach the photos step for the same week on the
// iPad and the row is created there, under the iPad's `clientSubmissionId`. Back on the phone, Submit
// POSTs with the phone's key: the idempotency lookup misses, the per-week lookup hits, and the answer is
// 409 "A report already exists for this week" — surfaced verbatim, on every retry, for ever. The wizard
// had no way to adopt that row, so Discard was the only exit and its dialog says nothing about the text
// being unrecoverable.
//
// The primary fix is at the hub: a local draft whose week has since acquired a row is now RECONCILED
// against it before the wizard is ever opened (see hub.ts), which adopts the row when it is untouched and
// asks when it is not. What follows is the backstop for the row that appears in between — the phone can
// still adopt an empty row on the spot, and when it cannot, it says what happened and what it costs.

/** Mirrors WEEKLY_REPORT_WEEK_EXISTS_CODE in server/src/modules/weekly-reports/reports-service.ts. */
export const WEEKLY_REPORT_WEEK_EXISTS_CODE = "WEEKLY_REPORT_WEEK_EXISTS";

/**
 * Is this the "somebody else already started this week" 409, as opposed to the other one `POST /reports`
 * can answer ("Weekly reporting is paused for this project")?
 *
 * The two want opposite handling — the first is recoverable by adopting the existing row, the second is
 * not recoverable at all — so they must not be conflated. Prefers the error CODE; the message match is a
 * fallback for an API build that predates it, and is the only reason the copy above is worth keeping
 * stable.
 */
export function isWeeklyReportWeekTakenError(error: unknown): boolean {
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown } | null | undefined;
  if (candidate?.status !== 409) return false;
  // A DELETED SUBMISSION IS NOT A TAKEN WEEK, and it is checked first because the prose fallback below
  // is a loose match — one wording change on the server and a stranded draft would start reading as an
  // adoptable row again. See isWeeklyReportSubmissionDeletedError.
  if (isWeeklyReportSubmissionDeletedError(candidate)) return false;
  if (candidate.code === WEEKLY_REPORT_WEEK_EXISTS_CODE) return true;
  return typeof candidate.message === "string" && /already exists for this week/i.test(candidate.message);
}

/** Mirrors WEEKLY_REPORT_SUBMISSION_DELETED_CODE in server/src/modules/weekly-reports/reports-service.ts. */
export const WEEKLY_REPORT_SUBMISSION_DELETED_CODE = "WEEKLY_REPORT_SUBMISSION_DELETED";

/** Mirrors WEEKLY_REPORT_DELETED_CODE in server/src/modules/weekly-reports/reports-service.ts. */
export const WEEKLY_REPORT_DELETED_CODE = "WEEKLY_REPORT_DELETED";

/** Mirrors WEEKLY_REPORT_AUTHOR_DELETED_CODE in server/src/modules/weekly-reports/reports-service.ts. */
export const WEEKLY_REPORT_AUTHOR_DELETED_CODE = "WEEKLY_REPORT_AUTHOR_DELETED";

/**
 * Did the field read conclusively say this actor authored the deleted row and may still replace it?
 *
 * A bare 404 is NOT enough: the field router intentionally uses 404 to conceal a live report from a user
 * who is no longer assigned to its project. The generic deleted 410 is not enough either: an assigned PM
 * can view another person's draft. Only this server-authoritative tag may drive a durable replacement.
 */
export function isWeeklyReportAuthorDeletedError(error: unknown): boolean {
  const candidate = error as { status?: unknown; code?: unknown } | null | undefined;
  return candidate?.status === 410 && candidate.code === WEEKLY_REPORT_AUTHOR_DELETED_CODE;
}

/**
 * Is this the THIRD 409 — "the report you are retrying was deleted"?
 *
 * Kept apart from the week-taken conflict because the two want opposite moves. That one is recovered by
 * ADOPTING the row somebody else created; there is no row here, so `adoptWeeklyReportWeekRow` finds
 * nothing and raises its permanent "unlisted" error with the superintendent's unsent writing still on
 * the device and no id it can ever be filed under.
 *
 * `weekly_reports_client_submission_id_key` is a plain UNIQUE constraint, not a partial one, so the key
 * this draft is holding can never produce a row again however many times it retries. The recovery is a
 * FRESH `clientSubmissionId` over the same local draft. This predicate is the half of that the phone can
 * ship today; acting on it — minting the new id and keeping the writing — is a change to the submit
 * sequence and belongs with a mobile build, not with a server PR.
 */
export function isWeeklyReportSubmissionDeletedError(error: unknown): boolean {
  const candidate = error as { status?: unknown; code?: unknown } | null | undefined;
  return candidate?.status === 409 && candidate.code === WEEKLY_REPORT_SUBMISSION_DELETED_CODE;
}

/**
 * May this phone take over the row that already exists for its week, without asking?
 *
 * Only when that row holds NOTHING — which is the overwhelmingly common case, because the row is created
 * empty on the photos step and stays empty until somebody submits. Adopting an empty row costs nobody
 * anything: the phone's draft is the only writing that exists. Adopting a row that already has content
 * would be the silent revert this whole change is about, so that case is handed back to the user.
 */
export function weeklyReportWeekRowIsUntouched(server: {
  status: WeeklyReportStatusValue;
  signature: string;
}): boolean {
  return server.status === "draft" && server.signature === WEEKLY_REPORT_EMPTY_SIGNATURE;
}

/**
 * Why the week could not be adopted, which is also which sentence the user gets.
 *
 *   has-work   → the hub names that week's row and it has content on it. Reconciling is a real next step:
 *                the week is on screen and opening it asks which version to keep.
 *   unreadable → the hub names the row, but THIS attempt could not read it. Same next step, different
 *                cause, so the copy says "could not read" rather than implying a choice is waiting.
 *   unlisted   → the hub does not name that week's row AT ALL, and there is therefore no button anywhere
 *                to send anybody to. `weeklyReportServerReportId` resolves only the current week and the
 *                capped `outstandingWeekReportIds` map, and the server drops a past week from that map the
 *                moment its report moves past `draft` — which is exactly what has just happened here. The
 *                previous copy told these users to "pull down to refresh, then open that week", which
 *                refreshes into the same screen with nothing on it to tap.
 */
export type WeeklyReportWeekTakenOutcome = "has-work" | "unreadable" | "unlisted";

/**
 * What to tell somebody whose week was started elsewhere and cannot be adopted on the spot.
 *
 * Says the three things the old verbatim 409 did not: what happened, that nothing they typed has left the
 * phone, and where the way forward actually is — which is NOT the same place in all three cases, and
 * naming a route the hub does not render is how the previous copy dead-ended people.
 */
export function weeklyReportWeekTakenMessage(
  weekLabel: string,
  outcome: WeeklyReportWeekTakenOutcome,
): string {
  const unsent = "Nothing you typed here has been sent yet.";
  switch (outcome) {
    case "has-work":
      return `The week of ${weekLabel} was already started on another device and has work on it. ${unsent} Go back to Reports, pull down to refresh, then open that week — you will be asked which version to keep.`;
    case "unreadable":
      return `The week of ${weekLabel} already has a report, started on another device, and this phone could not read it. ${unsent} Go back to Reports, pull down to refresh, then open that week.`;
    default:
      // NO "open that week": there is nothing to open. Points at the two places the report can actually be
      // seen, and says the copy on this phone is still here, because Discard is the only control left.
      return `The week of ${weekLabel} was already reported from another device, and this phone cannot open that report from Reports. ${unsent} What you wrote is still on this phone — check the weekly report board in the CRM, or with whoever filed it, before you discard it.`;
  }
}

/**
 * Thrown by the wizard when the week cannot be adopted. Carries the explanation as its message so
 * `weeklyReportSubmitErrorMessage` shows it verbatim rather than the generic "try again" copy.
 */
export class WeeklyReportWeekTakenError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "WeeklyReportWeekTakenError";
  }
}

/**
 * The extra sentence Discard needs, or null when there is nothing unsent to warn about.
 *
 * The dialog used to talk only about imported photos surviving in the gallery, which reads like it is
 * removing a shortcut. For a draft holding writing the server has never seen — the ordinary state of this
 * feature, since nothing is sent until submit — Discard is the only destructive action in the app and it
 * said so nowhere. That mattered most exactly where the user had no other exit.
 *
 * Silent when the local draft matches what the server already holds: there, Discard really does only
 * remove the local copy, and a warning that cried wolf would be ignored when it counted.
 */
export function weeklyReportDiscardWarning(draft: {
  seededFrom: WeeklyReportSeedState | null;
  signature: string;
}): string | null {
  const baselineSignature = draft.seededFrom?.signature ?? WEEKLY_REPORT_EMPTY_SIGNATURE;
  if (draft.signature === baselineSignature) return null;
  return "What you have written here has not been sent yet, so discarding deletes it for good.";
}
