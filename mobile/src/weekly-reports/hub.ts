// What "open this week" resolves to, kept out of the hub screen so the ordering rules are testable.
//
// There are four ways into the wizard and they are NOT interchangeable — picking the wrong one is a
// data-loss bug in one direction and a duplicate report in the other:
//
//   • A REVIEW draft must never be opened from the local copy. The authoritative report belongs to the
//     superintendent; a day-old review draft replays a PATCH of explicit nulls and a whole-set photo PUT
//     over work they rewrote in the meantime, and the PM approves, in good faith, something other than
//     what they just read.
//   • An AUTHORING draft is the exact opposite. It is the durability unit, it may hold text typed with no
//     signal that the server has never seen, and reseeding it from the server would discard precisely the
//     work the local store exists to protect.
//   • A week that already has a report ROW on the server must resume THAT row rather than start a new
//     one, or the wizard posts a second create for the same week.
//   • Only a week with neither gets a fresh local draft.

/** The local drafts the hub is holding, reduced to what the decision actually reads. */
export interface WeeklyReportHubDraft {
  id: string;
  weeklyReportProjectId: string;
  weekOf: string;
  mode: "author" | "review";
  reportId: string | null;
}

/** The assignment row, reduced likewise. */
export interface WeeklyReportHubProject {
  weeklyReportProjectId: string;
  currentWeekOf: string;
  currentReportId: string | null;
  /** weekOf → report id for outstanding weeks that already have a row. Absent on an older API build. */
  outstandingWeekReportIds?: Record<string, string> | null;
}

export type WeeklyReportOpenTarget =
  /** Re-read from the server before opening — every door onto a review draft goes through this. */
  | { kind: "review-fresh"; reportId: string }
  /** Resume the local authoring draft as it stands. */
  | { kind: "resume-local"; draftId: string }
  /** No local draft, but the server has a row for this week: seed from it. */
  | { kind: "resume-server"; reportId: string }
  /** Nothing anywhere: a fresh local draft. */
  | { kind: "create-local" };

/**
 * The report id the SERVER holds for a given week of a project, or null.
 *
 * The current week's id has always travelled on the assignment. An outstanding week's did not, and the app
 * passed `null` for every one of them — so a missed week whose row already existed (the wizard creates it
 * on the photos step) could only ever be re-created, and once the local draft was discarded the week
 * vanished from the hub altogether. The server now keeps such a week outstanding and names its row.
 */
export function weeklyReportServerReportId(
  project: WeeklyReportHubProject,
  weekOf: string,
): string | null {
  if (weekOf === project.currentWeekOf) return project.currentReportId ?? null;
  return project.outstandingWeekReportIds?.[weekOf] ?? null;
}

export function weeklyReportOpenTarget(input: {
  project: WeeklyReportHubProject;
  weekOf: string;
  drafts: readonly WeeklyReportHubDraft[];
}): WeeklyReportOpenTarget {
  const { project, weekOf, drafts } = input;
  const local = drafts.find(
    (draft) =>
      draft.weeklyReportProjectId === project.weeklyReportProjectId && draft.weekOf === weekOf,
  );
  if (local?.mode === "review" && local.reportId) {
    return { kind: "review-fresh", reportId: local.reportId };
  }
  if (local) return { kind: "resume-local", draftId: local.id };

  const serverReportId = weeklyReportServerReportId(project, weekOf);
  if (serverReportId) return { kind: "resume-server", reportId: serverReportId };
  return { kind: "create-local" };
}
