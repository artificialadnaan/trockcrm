// What "open this week" resolves to, kept out of the hub screen so the ordering rules are testable.
//
// The discriminator is WHETHER A SERVER ROW IS INVOLVED, and nothing else:
//
//   • Any draft that names a report on the server is RECONCILED against it before a byte of it is opened
//     or written — see reconcile.ts, which owns that decision for every door. This used to key on
//     `mode === "review"`, and an author-mode draft therefore skipped the read entirely. The chain that
//     made that a silent revert: a PM taps "Open week of Aug 13" on a `draft` report, which seeds an
//     AUTHOR draft and saves it; they back out; the superintendent finishes the week and submits; the PM
//     taps "Review week of Aug 13", the local draft is found, its mode is `author`, so it opens with no
//     server read — and its submit PATCHes the PM's stale text and PUTs the PM's stale photo set over the
//     super's submitted report. Mode was never a freshness property.
//   • A LOCAL-ONLY draft — no report id anywhere — is the durability unit. It may hold text typed with no
//     signal that the server has never seen, so it opens straight from disk.
//   • …unless the week has since acquired a row from ANOTHER DEVICE, in which case it is reconciled too.
//     Without this the phone's draft is unfilable: its create 409s on "A report already exists for this
//     week" forever, and the only exit is Discard.
//   • Only a week with nothing on either side gets a fresh local draft.

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
  /**
   * Re-read the report and reconcile before opening. The one door onto anything the server knows about,
   * whichever mode the draft is in and whether or not there is a local draft at all (`draftId: null` is
   * the case that used to be a separate `resume-server` branch — same read, same gate, one code path).
   */
  | { kind: "reconcile"; reportId: string; draftId: string | null }
  /** Resume a purely local draft as it stands: no server row exists, so there is nothing to reconcile. */
  | { kind: "resume-local"; draftId: string }
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
  // A draft that names a report is reconciled against it. NOT keyed on mode — see the header.
  if (local?.reportId) {
    return { kind: "reconcile", reportId: local.reportId, draftId: local.id };
  }

  const serverReportId = weeklyReportServerReportId(project, weekOf);
  // The server has a row this local draft has never heard of, i.e. the week was started somewhere else.
  // Reconciling adopts that row (keeping whatever is on this phone when the row is still empty, asking
  // when it is not); resuming the draft as-is would leave it posting a create that 409s for ever.
  if (local && serverReportId) {
    return { kind: "reconcile", reportId: serverReportId, draftId: local.id };
  }
  if (local) return { kind: "resume-local", draftId: local.id };

  if (serverReportId) return { kind: "reconcile", reportId: serverReportId, draftId: null };
  return { kind: "create-local" };
}
