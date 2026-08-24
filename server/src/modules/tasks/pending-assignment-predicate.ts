import { sql, type SQL } from "drizzle-orm";
import { tasks } from "@trock-crm/shared/schema";

/**
 * "Which assignments should the login modal put in front of this person right now?"
 *
 * ONE definition, TWO callers, and the duplication this avoids is not cosmetic. The modal's list comes
 * from the tenant-scoped tasks service; the `hasPendingTaskAssignments` boolean on every auth response
 * comes from `auth/service.ts`, which is mounted BEFORE the tenant router and therefore has no
 * `tenantDb` at all (it reaches the office schema by name, the way getUserOnboardingGateStatus does).
 * Two hand-written copies of this predicate would drift the moment either side changed, and the drift is
 * silent in both directions: a flag that is broader than the list opens an EMPTY modal, and a flag that
 * is narrower than the list means the modal never fires for exactly the tasks the repeat rule exists to
 * re-surface. So both sides import this.
 *
 * THE TABLE IS REFERENCED UNALIASED ON PURPOSE. `taskPriorityRankSql()` in service.ts renders Drizzle
 * column refs as `"tasks"."priority"`, so the caller's FROM clause must leave the relation named
 * `tasks`. That still works schema-qualified -- `FROM office_atlanta.tasks` exposes its columns as
 * `tasks.*` -- which is what lets the auth side share this fragment verbatim.
 */
export type PendingAssignmentPredicateOptions = {
  /** The person the modal is for. Always the authenticated caller; never taken from a payload. */
  userId: string;
  /**
   * Today's date as YYYY-MM-DD in America/Chicago. Passed in rather than computed here so the caller's
   * date bucketing and this predicate cannot disagree about what "overdue" means, and so a test can pin
   * it. Matches the CT bucketing the rest of the task surface uses (service.ts getTaskCounts).
   */
  todayCt: string;
  /**
   * Office schema to qualify the acknowledgement table with, e.g. `office_dallas`. Omit when the caller
   * runs inside a tenant connection whose search_path already resolves it.
   */
  schema?: string;
};

const SCHEMA_NAME = /^office_[a-z][a-z0-9_]*$/;

/**
 * Priorities that re-show on every login until the task leaves `pending`.
 *
 * Held as a constant so the modal, the flag and the tests all read the same list, and so mutating it is
 * a single edit that a test can be pointed at.
 */
export const REPEATING_TASK_PRIORITIES = ["urgent", "high"] as const;

export function buildPendingAssignmentPredicate({
  userId,
  todayCt,
  schema,
}: PendingAssignmentPredicateOptions): SQL {
  if (schema !== undefined && !SCHEMA_NAME.test(schema)) {
    // The value reaches here from public.offices.slug, so it is not user input -- but it IS
    // interpolated rather than bound (an identifier cannot be a parameter), and a schema name is
    // exactly the shape that stops being trusted the day somebody adds an office-creation form.
    throw new Error(`Refusing to build a tenant predicate for schema name: ${schema}`);
  }

  const ackTable = sql.raw(
    schema
      ? `"${schema}".task_assignment_acknowledgements`
      : "task_assignment_acknowledgements"
  );

  const repeatingPriorities = sql.join(
    REPEATING_TASK_PRIORITIES.map((priority) => sql.raw(`'${priority}'`)),
    sql`, `
  );

  /**
   * NO `--` COMMENTS INSIDE THE TEMPLATE. This fragment is rendered to a string and executed both by
   * Drizzle and, on the auth side, by node-postgres directly. A line comment survives only as long as
   * the newline after it does, so anything that collapsed this fragment to one line would comment out
   * the entire rest of the query — and the failure mode of a predicate that silently disappears is a
   * modal that fires for every task in the office. The explanation lives here instead:
   *
   *   assigned_to      the caller, always; never a value from a payload.
   *   status='pending' the decision was once-per-task, with repeats running "until the task leaves
   *                    pending". A task somebody has already started, or parked as waiting_on, has
   *                    visibly been seen and stops interrupting them.
   *   source='manual'  C4. created_by is NULL on every rules-engine and AI-disconnect task, and those
   *                    are the bulk of the volume — without this the modal is mostly machine output
   *                    under a blank "assigned by", and "who assigned it" is why the feature exists.
   *   is_test_data     mirrors excludeTestTasks() on the list projections. A demo task greeting
   *                    somebody at login is the worst possible place for one. COALESCE because the auth
   *                    demo seed used to omit the column from its INSERT entirely.
   *   NOT EXISTS       "never shown". Migration 0235 seeds this table so it means new, not unread.
   *   priority IN      the repeat rule.
   *   due_date <       the overdue repeat. A NULL due_date yields NULL rather than true, so an undated
   *                    task is never treated as overdue.
   */
  return sql`
    ${tasks.assignedTo} = ${userId}
    AND ${tasks.status} = 'pending'
    AND ${tasks.source} = 'manual'
    AND COALESCE(${tasks.isTestData}, false) = false
    AND (
      NOT EXISTS (
        SELECT 1 FROM ${ackTable} a
         WHERE a.task_id = ${tasks.id} AND a.user_id = ${userId}
      )
      OR ${tasks.priority} IN (${repeatingPriorities})
      OR ${tasks.dueDate} < ${todayCt}
    )
  `;
}

/** YYYY-MM-DD in America/Chicago — the office timezone the whole task surface buckets against. */
export function pendingAssignmentTodayCt(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}
