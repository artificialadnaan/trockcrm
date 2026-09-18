/**
 * WHO HANDED A TASK OVER — the one definition, in a module with no imports.
 *
 * `last_assigned_by` records every reassignment and is NULL until the first one; before that the
 * creator is necessarily the assigner. Everything that needs to answer "who is waiting on this"
 * resolves it this way: reply delivery, acknowledgement authority, the awaiting-me bucket, the
 * outcome email, and `0240`'s expression index — which the bucket's query silently stops using if
 * the two ever disagree.
 *
 * IT LIVES IN A LEAF ON PURPOSE. It used to sit in closed-loop-service.ts, which imports service.ts,
 * which is a ~110KB module graph to drag in for one pure line — and worse, notifications.ts importing
 * it from there put a cycle one edit away: the moment service.ts or closed-loop-service.ts wants to
 * send an email, `notifications -> closed-loop-service -> service -> notifications` closes. Function
 * declarations survive that (hoisted), but `TaskTransactionUnusableError` is a `class`, and a class
 * read during module evaluation on the wrong side of a cycle throws on the TDZ. A leaf cannot form
 * one. closed-loop-service.ts re-exports it so every existing import path keeps working.
 */
export function resolveTaskAssignerId(
  task: { lastAssignedBy: string | null; createdBy: string | null }
): string | null {
  return task.lastAssignedBy ?? task.createdBy;
}

/**
 * WHO, IF ANYONE, ACTUALLY HANDED THIS TASK TO A PERSON — narrower than the above, on purpose.
 *
 * `resolveTaskAssignerId` answers "whose loop is this", which for the reply thread is right even on a
 * machine task: somebody has to be able to close it. This one answers "did a human give this to you",
 * which is a different question and the one an outcome email and an "Assigned by" label are making a
 * claim about.
 *
 * ⚠️ `created_by` IS NOT NULL ON EVERY AUTOMATED TASK. It is easy to assume it is — only the 25-rule
 * engine leaves it unset. Two machine writers stamp a real person:
 *   - assignment-tasks/service.ts    createAssignmentTaskIfNeeded → created_by = the director who
 *                                    reassigned the DEAL, on a task they never typed;
 *   - deals/scoping-service.ts       routeRevisionToEstimating → created_by = whoever's edit
 *                                    triggered the routing.
 * Resolving those two through `created_by` puts "Assigned by Sarah" on a row Sarah never wrote, and
 * mails her "the task you assigned was completed" for a task the system raised. That is the exact
 * misattribution #1105 introduced the `source` column to end — one layer up.
 *
 * So: a reassignment always counts (somebody deliberately handed the work over, whatever raised it),
 * and otherwise only a `manual` task has a human assigner at all.
 */
export function resolveHumanTaskAssignerId(
  task: { lastAssignedBy: string | null; createdBy: string | null; source?: string | null }
): string | null {
  if (task.lastAssignedBy) return task.lastAssignedBy;
  return task.source === "manual" ? task.createdBy : null;
}
