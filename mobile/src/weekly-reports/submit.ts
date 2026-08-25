// Filing a weekly report: the three writes, in order, and what the phone records between them.
//
// Lifted out of app/(app)/reports/weekly/[draftId].tsx for the reason door.ts was — `mobile/` is not in CI
// and the app has no OTA, and nothing in the suite executed a line of that screen. The pure pieces
// (transition.ts, reconcile.ts, draft.ts) were well covered; what was not covered is that the screen calls
// them, in this order, with these arguments. Three mutations to the screen's copy of this sequence changed
// nothing in a green 1406-test run:
//
//   • `mayHaveCommitted = draft.pendingTransitionTo === to` → `true`, which launders somebody else's
//     transition into "my submit succeeded" and deletes the draft on top of it;
//   • `if (!mayHaveCommitted) await markPendingTransition(to)` → `if (false)`, which never gets the marker
//     to disk, so lost-reply recovery is dead across an app kill;
//   • dropping the untouched-row check before adopting another device's row, so this phone PATCHes over
//     content somebody else typed.
//
// Every effect is a port method. The screen supplies fetch, the reducer and disk; the ordering lives here.

import type { WeeklyReportStatusValue } from "../api/types";
import {
  weeklyReportDraftToPhotoPayload,
  weeklyReportSeedStateFromDetail,
  type WeeklyReportContentPatch,
  type WeeklyReportDraft,
  type WeeklyReportSeedState,
  type WeeklyReportSeedableReport,
} from "./draft";
import {
  isWeeklyReportAuthorDeletedError,
  isWeeklyReportWeekTakenError,
  WeeklyReportWeekTakenError,
  isWeeklyReportSubmissionDeletedError,
  weeklyReportWeekRowIsUntouched,
  weeklyReportWeekTakenMessage,
} from "./reconcile";
import {
  transitionWeeklyReportIdempotently,
  weeklyReportTransitionOutcomeUnknown,
} from "./transition";

// ── Adopting a row another device created for this week ──────────────────────

export interface WeeklyReportAdoptPort {
  /**
   * The report id the HUB holds for this week, or null when it holds none. May throw — that is a failed
   * read, which is a different thing from "the hub does not list this week" and gets different copy.
   */
  findServerReportId(): Promise<string | null>;
  read(reportId: string): Promise<WeeklyReportSeedableReport>;
  /** Take the row over: the draft now names it, with its real provenance. */
  adopt(reportId: string, seededFrom: WeeklyReportSeedState): void;
}

/**
 * Take over the row that already exists for this week, or explain why not.
 *
 * Silent adoption is allowed only while the row holds NOTHING, which is the ordinary case: the row is
 * created empty on the photos step and stays empty until somebody submits, so there is nothing on it to
 * lose. A row that already has content is somebody's writing, and PATCHing this phone's copy over it is
 * the same silent revert this whole area exists to prevent — so that case is handed back with copy that
 * says what happened, that nothing has left the phone, and where the report can actually be seen.
 */
export async function adoptWeeklyReportWeekRow(
  input: { weekLabel: string },
  port: WeeklyReportAdoptPort,
): Promise<string> {
  let existingId: string | null;
  try {
    existingId = await port.findServerReportId();
  } catch {
    // The 409 already proved the week is taken; this phone just could not find out where. A refresh is
    // the right advice for a failed read, and it makes no promise about which weeks the hub lists.
    throw new WeeklyReportWeekTakenError(weeklyReportWeekTakenMessage(input.weekLabel, "unreadable"));
  }
  if (!existingId) {
    // The hub genuinely has no row for this week — the server drops a past week from
    // `outstandingWeekReportIds` as soon as its report moves past `draft`, and caps that map at five. So
    // there is no button to send anybody to, and the copy must not invent one.
    throw new WeeklyReportWeekTakenError(weeklyReportWeekTakenMessage(input.weekLabel, "unlisted"));
  }

  let seededFrom: WeeklyReportSeedState;
  try {
    seededFrom = weeklyReportSeedStateFromDetail(await port.read(existingId));
  } catch {
    throw new WeeklyReportWeekTakenError(weeklyReportWeekTakenMessage(input.weekLabel, "unreadable"));
  }
  if (!weeklyReportWeekRowIsUntouched(seededFrom)) {
    throw new WeeklyReportWeekTakenError(weeklyReportWeekTakenMessage(input.weekLabel, "has-work"));
  }
  port.adopt(existingId, seededFrom);
  return existingId;
}

/**
 * Create the report, and if this draft's submission key has been RETIRED, mint a new one and try again.
 *
 * `weekly_reports_client_submission_id_key` is a plain UNIQUE constraint, not a partial one. Once the
 * report a phone created is deleted, that key is spent for good — every retry answers the same 409 for
 * the rest of time, and the phone's only remaining move used to be discarding a week's writing and
 * starting the form again on a jobsite.
 *
 * The draft's CONTENT is untouched by any of this; only its key is dead. So the recovery is a fresh key
 * over the same words, and `onRenewed` is how it reaches storage — a key minted and not persisted would
 * be re-minted on the next attempt, throwing away the idempotency the key exists to provide.
 *
 * EXACTLY ONE RETRY. A second refusal means something other than a spent key is answering that way, and
 * a phone that kept minting ids against it would create a report per attempt on a flaky connection —
 * which is the failure the idempotency key was introduced to prevent, arriving from the other side.
 */
export interface WeeklyReportCreateWithRenewedSubmissionPort<T> {
  create(clientSubmissionId: string): Promise<T>;
  newClientSubmissionId(): string;
  /**
   * Persist the replacement key before the retry leaves the phone. A React dispatch by itself is not
   * enough: an app death after the renewed POST commits but before an autosave runs would lose the key
   * and make the next launch mint another one, stranding the report under the first replacement.
   */
  onRenewed(clientSubmissionId: string): Promise<void>;
}

export async function createWeeklyReportWithRenewedSubmission<T>(
  clientSubmissionId: string,
  port: WeeklyReportCreateWithRenewedSubmissionPort<T>,
): Promise<T> {
  try {
    return await port.create(clientSubmissionId);
  } catch (error) {
    if (!isWeeklyReportSubmissionDeletedError(error)) throw error;
    const renewed = port.newClientSubmissionId();
    // Do not let the replacement request out until the replacement key is durable. Its whole value is
    // that a lost response can be retried with THIS exact key after a process death.
    await port.onRenewed(renewed);
    return await port.create(renewed);
  }
}

export type WeeklyReportDraftRowResolution<T> =
  | { kind: "existing"; reportId: string }
  | { kind: "created"; created: T; replacesExistingReport: boolean }
  /** Another device recreated the deleted week; adoption must retain replacement semantics. */
  | { kind: "replacement-week-taken" };

/**
 * Resolve the row a local weekly-report draft should write to.
 *
 * A persisted `reportId` used to be treated as proof that its row still existed. Leadership can delete
 * the report after the phone reaches Photos, though, and that leaves the draft with BOTH an inactive id
 * and a submission key the database will never accept again. Returning that id sent every PATCH and photo
 * PUT into a permanent 404 instead of entering the existing key-renewal path.
 *
 * Confirm the stored id first. A field read uses 404 to conceal a live report from somebody who is no
 * longer allowed to view it, so only the server's explicit `410/WEEKLY_REPORT_AUTHOR_DELETED` answer is
 * both deletion evidence AND authority for a replacement. A UI `mode === "author"` is not enough: an
 * assigned PM can open someone else's draft in that mode. Every other deleted response keeps its local
 * work and surfaces the definite answer. The actual author may restart its own filing flow: make the
 * replacement key durable (which resets the former row's identity and lifecycle state in the reducer)
 * before its first POST leaves the device. The usual create helper remains
 * responsible for the separate "new key was itself retired" response, and still retries at most once.
 */
export async function resolveWeeklyReportDraftRow<T>(
  input: { reportId: string | null; clientSubmissionId: string },
  port: WeeklyReportCreateWithRenewedSubmissionPort<T> & {
    read(reportId: string): Promise<unknown>;
  },
): Promise<WeeklyReportDraftRowResolution<T>> {
  let replacesExistingReport = false;
  const onRenewed = async (clientSubmissionId: string): Promise<void> => {
    replacesExistingReport = true;
    await port.onRenewed(clientSubmissionId);
  };
  const create = (clientSubmissionId: string) =>
    createWeeklyReportWithRenewedSubmission(clientSubmissionId, {
      create: port.create,
      newClientSubmissionId: port.newClientSubmissionId,
      onRenewed,
    });

  if (input.reportId) {
    try {
      await port.read(input.reportId);
      return { kind: "existing", reportId: input.reportId };
    } catch (error) {
      if (!isWeeklyReportAuthorDeletedError(error)) throw error;

      const renewed = port.newClientSubmissionId();
      // `onRenewed` must reset the former row's identity and lifecycle state in durable storage before a
      // replacement row can be made. If its disk write fails, rethrow and leave the draft untouched for
      // the next explicit retry.
      await onRenewed(renewed);
      try {
        return {
          kind: "created",
          created: await create(renewed),
          replacesExistingReport,
        };
      } catch (createError) {
        // Another device may create this week's empty replacement between the deleted-row read and this
        // POST. Carry that former-row fact through adoption so a stale approved state or lost marker cannot
        // make the fresh row look already filed.
        if (isWeeklyReportWeekTakenError(createError)) return { kind: "replacement-week-taken" };
        throw createError;
      }
    }
  }

  return {
    kind: "created",
    created: await create(input.clientSubmissionId),
    replacesExistingReport,
  };
}

// ── The submit sequence ──────────────────────────────────────────────────────

export interface WeeklyReportSubmitPort {
  /** Create the row (idempotently) or return the one this draft already names. */
  ensureReport(): Promise<{ reportId: string; replacesExistingReport: boolean }>;
  updateContent(reportId: string, patch: WeeklyReportContentPatch): Promise<WeeklyReportSeedableReport>;
  replacePhotos(
    reportId: string,
    photos: Array<{ fileId: string; caption: string | null }>,
  ): Promise<WeeklyReportSeedableReport>;
  /** Re-stamp the draft's provenance from a write the server acknowledged. */
  recordSeed(seed: WeeklyReportSeedState): void;
  /** Arm (or disarm) the "I fired this and never heard back" marker, DURABLY, before the request leaves. */
  markPendingTransition(to: WeeklyReportStatusValue | null): Promise<void>;
  transition(reportId: string, to: WeeklyReportStatusValue): Promise<WeeklyReportStatusValue>;
  readStatus(reportId: string): Promise<WeeklyReportStatusValue | null | undefined>;
  /** Where the report landed, recorded before anything that can still fail. */
  recordStatus(status: WeeklyReportStatusValue): void;
}

/**
 * Content, then photos, then the transition — in that order so the PM's queue never receives a report
 * whose text or photo set is only half-written. Every step is retryable: the local draft is untouched
 * until the transition succeeds.
 *
 * This sequence RELIES on the server granting edit rights to everyone it grants the submit to. It did not:
 * `canEditWeeklyReport` recognised only the current assignments while `canTransitionAs` honoured
 * `authored_by`, so a superintendent reassigned off the project mid-draft was shown `canSubmit: true` and
 * then 403'd on the PATCH — with the transition they were entitled to make never reached, and their
 * locally persisted work permanently unsubmittable. The alignment lives in reports-service.ts (the author
 * may edit while the report is a DRAFT); if that clause is ever narrowed, this order must be revisited.
 *
 * WHAT THE PHONE RECORDS BETWEEN THE WRITES. Each acknowledged write re-stamps `seededFrom` from the
 * report the SERVER handed back. Without that, a submit whose PATCH lands and whose photo PUT does not —
 * or whose writes both land and whose transition does not, which is the commonest retry path there is —
 * leaves the baseline describing the row as it was BEFORE the submit. The next open then sees "the server
 * moved" and "I have local edits" and raises a two-way conflict dialog blaming a colleague who does not
 * exist, whose "Load theirs" button drops photos this phone had just successfully uploaded. One keystroke
 * after a failed transition is enough to reach it.
 *
 * NOTE (pre-existing, deliberately not closed here): the writes below carry no precondition. The UPDATE
 * guards in reports-service.ts condition on the status read within the same request, which catches a
 * concurrent STATUS flip but not a CONTENT change since this draft was opened — so a PM who opened a
 * review draft, had the superintendent edit the same report from their phone, and then taps Approve
 * overwrites it with no 409 and no prompt. Closing that needs an If-Match/`updated_at` precondition on the
 * PATCH and the photo PUT, which is a server-side design change beyond this file.
 */
export async function runWeeklyReportSubmit(
  input: {
    draft: WeeklyReportDraft;
    patch: WeeklyReportContentPatch;
    /** Null when the report is already in the state the final button would ask for — save and stop. */
    transitionTo: WeeklyReportStatusValue | null;
  },
  port: WeeklyReportSubmitPort,
): Promise<{ reportId: string; status: WeeklyReportStatusValue | null }> {
  const ensured = await port.ensureReport();
  const reportId = ensured.reportId;

  const patched = await port.updateContent(reportId, input.patch);
  port.recordSeed(weeklyReportSeedStateFromDetail(patched));

  const withPhotos = await port.replacePhotos(
    reportId,
    weeklyReportDraftToPhotoPayload(input.draft),
  );
  port.recordSeed(weeklyReportSeedStateFromDetail(withPhotos));

  // A deleted report is replaced by a fresh AUTHOR draft. Its previous status may have made the old
  // button read "Save changes", but a new row must still enter the normal draft -> pending_review step.
  const to = ensured.replacesExistingReport ? "pending_review" : input.transitionTo;
  if (!to) return { reportId, status: null };

  // Read BEFORE the marker is armed, so it answers "did a PREVIOUS attempt of mine go unanswered?" rather
  // than "did I just arm this?". That distinction is the whole guard: reaching the target status is only
  // evidence of MY commit if I have a move outstanding. Without it, a report somebody else advanced
  // answers 409, the re-read confirms the target, and a submit that reverted their work reports success.
  // The marker describes a request against the FORMER row. Never let it make a 409 on a replacement row
  // look like this phone's lost reply; the replacement is armed afresh immediately below instead.
  const mayHaveCommitted = !ensured.replacesExistingReport && input.draft.pendingTransitionTo === to;
  if (!mayHaveCommitted) await port.markPendingTransition(to);

  try {
    const outcome = await transitionWeeklyReportIdempotently({
      to,
      mayHaveCommitted,
      transition: () => port.transition(reportId, to),
      // Only reached on a 409. A transition that COMMITTED and then lost its response leaves the phone
      // certain it failed: `serverStatus` was never recorded, so the retry asks for the same move and is
      // refused for the rest of the draft's life.
      readStatus: () => port.readStatus(reportId),
    });
    // Recorded BEFORE anything that can still fail: everything after this point is local cleanup, and if
    // the disk delete throws the user is left holding a draft whose report has already moved.
    port.recordStatus(outcome.status);
    return { reportId, status: outcome.status };
  } catch (error) {
    // Disarm on a DEFINITE refusal. The move did not land, so a later 409 can only be somebody else's —
    // and leaving the marker armed would let that be read as a lost reply of my own.
    if (!weeklyReportTransitionOutcomeUnknown(error)) await port.markPendingTransition(null);
    throw error;
  }
}
