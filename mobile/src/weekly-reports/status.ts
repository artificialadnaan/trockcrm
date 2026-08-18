// Presentation mirror of shared/src/types/weekly-report.ts.
//
// `mobile/` is a non-workspace Expo app and cannot import @trock-crm/shared, so the labels the CRM, the
// worker and the API all read from one module have to be restated here. This is the same deliberate
// mirror as scorecards/scoring.ts, and it is held in step by weekly-report-status-mirror.test.ts.
//
// What is mirrored is deliberately ONLY labels and colours. None of the cadence arithmetic is: the field
// `assignments` payload already returns `currentWeekOf`, `outstandingWeeks` and `daysLate` computed by the
// server's copy of `weeklyReportWeekOf`, so a second implementation on the phone could only ever disagree
// with the board about which week a report belongs to — the exact failure the shared module exists to
// prevent.

import { theme } from "../theme/theme";
import type { WeeklyReportStatusValue, WeeklyReportWeekStateValue } from "../api/types";

/** Mirrors WEEK_STATE_LABELS in shared/src/types/weekly-report.ts. */
const WEEK_STATE_LABELS: Record<WeeklyReportWeekStateValue, string> = {
  not_started: "Not started",
  draft: "With super",
  pending_review: "Pending PM review",
  approved: "Approved, not sent",
  sent: "Sent",
  dismissed: "Dismissed",
};

export function weeklyReportWeekStateLabel(state: WeeklyReportWeekStateValue | null | undefined): string {
  if (!state) return "Not started";
  return WEEK_STATE_LABELS[state] ?? state;
}

/**
 * Chip colouring. Only the states the app can actually reach are coloured: `sent` is the finished case,
 * anything still owed reads as attention-worthy, and a state this build does not know falls through to
 * neutral rather than rendering an unstyled chip.
 */
export function weeklyReportWeekStateTone(
  state: WeeklyReportWeekStateValue | null | undefined,
  daysLate = 0,
): { background: string; text: string } {
  if (state === "sent") return { background: theme.color.surfaceMuted, text: theme.color.success };
  if (state === "approved" || state === "pending_review") {
    return { background: theme.color.surfaceMuted, text: theme.color.warning };
  }
  if (daysLate > 0) return { background: theme.color.surfaceMuted, text: theme.color.danger };
  return { background: theme.color.surfaceMuted, text: theme.color.textMuted };
}

/**
 * What the wizard's final button says and which transition it asks for.
 *
 * `transitionTo: null` is the case that matters. The status ladder has NO self-transition — asking to
 * move an already-`approved` report to `approved` is refused with "an approved report cannot move to
 * approved" — so a PM who opens an approved report from their queue, fixes a caption and taps the button
 * would get a 409 on work that saved perfectly well. When the report is already in the state the button
 * would ask for, the button saves and stops.
 */
export function weeklyReportFinalAction(draft: {
  mode: "author" | "review";
  serverStatus: WeeklyReportStatusValue | null;
}): { label: string; transitionTo: WeeklyReportStatusValue | null } {
  const target: WeeklyReportStatusValue = draft.mode === "review" ? "approved" : "pending_review";
  if (draft.serverStatus === target) return { label: "Save changes", transitionTo: null };
  return {
    label: draft.mode === "review" ? "Approve report" : "Submit for PM review",
    transitionTo: target,
  };
}

/**
 * What a project card on the hub offers for its current week, and in which mode the wizard opens.
 *
 * Derived rather than always showing "Open" because the server's edit rules are not symmetric: once a
 * report is APPROVED only the PM may still touch it, and a submitted report is the PM's move, not the
 * superintendent's. A card that offered the action anyway would walk the super into a 403 for a report
 * that is simply not theirs any more — and a button that fails is worse than a line of text saying who
 * has it.
 */
export type WeeklyReportProjectAction =
  | { kind: "start"; mode: "author" }
  | { kind: "resume"; mode: "author" }
  | { kind: "review"; mode: "review" }
  /** Submitted or approved, and the viewer is not the PM — there is nothing for them to do. */
  | { kind: "waiting" }
  /** Sent (immutable — corrections are a new version) or dismissed. */
  | { kind: "done" };

export function weeklyReportProjectAction(project: {
  currentState: WeeklyReportWeekStateValue;
  isPm: boolean;
  /** Absent on an older API build; treat that as filable, which is what it was before the field existed. */
  currentWeekFilable?: boolean;
}): WeeklyReportProjectAction {
  // Reporting has ENDED while earlier weeks are still owed. The current week is past the cadence end
  // date, so `assertValidWeekOf` refuses it — offering it would be a button that always 400s. The
  // outstanding weeks below it are still perfectly fileable, so the card stays.
  if (project.currentWeekFilable === false) return { kind: "done" };
  switch (project.currentState) {
    case "sent":
    case "dismissed":
      return { kind: "done" };
    case "pending_review":
    case "approved":
      return project.isPm ? { kind: "review", mode: "review" } : { kind: "waiting" };
    case "draft":
      return { kind: "resume", mode: "author" };
    default:
      return { kind: "start", mode: "author" };
  }
}

/**
 * What to say when the review queue came back capped, or null when the list is complete.
 *
 * The server sends the newest rows and the true depth. Saying nothing would present somebody's partial
 * workload as all of it, and this queue does not drain by being worked: an approved report stays on it
 * until it is SENT, which is a CRM action. So the note names the count AND where the rest live, rather
 * than implying a pull-to-refresh will surface them.
 */
export function weeklyReportQueueTruncationNote(shown: number, total: number | undefined): string | null {
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  const hidden = Math.max(0, Math.trunc(total) - shown);
  if (hidden <= 0) return null;
  return `Showing the ${shown} most recent of ${Math.trunc(total)}. The ${hidden} older report${hidden === 1 ? "" : "s"} ${hidden === 1 ? "is" : "are"} on the weekly report board in the CRM.`;
}

/**
 * What to say when the photo window came back capped, or null when the grid holds all of it.
 *
 * Same standard as the review queue above, and for a sharper reason. The window is anchored on the
 * report's `week_of`, not on today, and it is ordered newest-first — so what the cap removes is the
 * EARLIEST days of the fortnight the report is about. For a report filed late that is exactly the range
 * the super is looking for, and saying nothing would present a partial fortnight as the fortnight.
 *
 * Names the way out (the device library) rather than suggesting a refresh, which cannot change the cap.
 */
export function weeklyReportCandidateTruncationNote(
  shown: number,
  total: number | undefined,
): string | null {
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  const hidden = Math.max(0, Math.trunc(total) - shown);
  if (hidden <= 0) return null;
  return `Showing the ${shown} newest of ${Math.trunc(total)}. The ${hidden} oldest ${hidden === 1 ? "is" : "are"} not listed — import from the device if you need ${hidden === 1 ? "it" : "one of them"}.`;
}

/** yyyy-mm-dd → "Aug 13". Parsed at LOCAL midnight so a date-only string never shifts a day westward. */
export function formatWeekOf(isoDate: string): string {
  const parsed = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "3 days late" / "Due today" / "Due Thursday" — the line a super actually reads on the hub. */
export function weeklyReportDueLabel(weekOf: string, daysLate: number): string {
  if (daysLate > 0) return `${daysLate} day${daysLate === 1 ? "" : "s"} late`;
  return `Due ${formatWeekOf(weekOf)}`;
}
