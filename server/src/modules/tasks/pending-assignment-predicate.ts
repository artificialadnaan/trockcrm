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

/**
 * Statuses a FIRST-TIME assignment can arrive in.
 *
 * Wider than `pending` on purpose. The PATCH flow changes `assigned_to` without touching `status`, so a
 * task the previous assignee had already started lands on the new person's list as `in_progress` --
 * still a brand-new assignment to them, and "somebody assigned me something" is the whole reason this
 * feature exists. Gating first-time visibility on `pending` drops it before ever asking whether the new
 * assignee has seen it.
 *
 * `scheduled` is deliberately absent: it carries an explicit future surfacing date, so interrupting
 * somebody at login about work they deferred is the opposite of what the status means, and it comes
 * back on its own date regardless. Mirrors ACTIVE_BUCKET_STATUSES in service.ts, restated here rather
 * than imported because service.ts imports THIS module and the cycle would be worse than the echo.
 */
export const NEW_ASSIGNMENT_STATUSES = ["pending", "in_progress", "waiting_on", "blocked"] as const;

function quotedList(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `
  );
}

function assertSchemaName(schema: string | undefined) {
  if (schema !== undefined && !SCHEMA_NAME.test(schema)) {
    // The value reaches here from public.offices.slug, so it is not user input -- but it IS
    // interpolated rather than bound (an identifier cannot be a parameter), and a schema name is
    // exactly the shape that stops being trusted the day somebody adds an office-creation form.
    throw new Error(`Refusing to build a tenant predicate for schema name: ${schema}`);
  }
}

/**
 * "This person has never been shown this task."
 *
 * ONE definition, used in three places that must agree: the eligibility predicate below, the `is_new`
 * column the modal groups by, and the ORDER BY that keeps unseen work ahead of repeats. If the flag the
 * UI labels a row with could ever disagree with the predicate that selected it, the modal would file a
 * row under "New" that it was only returning as a reminder.
 *
 * AN ACK ANSWERS ONE ASSIGNMENT, NOT A TASK FOREVER. The row is keyed (task, user) and so cannot say
 * WHICH assignment it answered; `acknowledged_at >= assigned_at` supplies the missing half. Without it,
 * a task taken away from somebody and later handed back is still covered by the acknowledgement they
 * gave the first time, and they are never told about the second handoff.
 */
export function buildUnseenAssignmentSql({
  userId,
  schema,
}: {
  userId: string;
  schema?: string;
}): SQL {
  assertSchemaName(schema);
  const ackTable = sql.raw(
    schema
      ? `"${schema}".task_assignment_acknowledgements`
      : "task_assignment_acknowledgements"
  );
  return sql`NOT EXISTS (
    SELECT 1 FROM ${ackTable} a
     WHERE a.task_id = ${tasks.id}
       AND a.user_id = ${userId}
       AND a.acknowledged_at >= ${tasks.assignedAt}
  )`;
}

export function buildPendingAssignmentPredicate({
  userId,
  todayCt,
  schema,
}: PendingAssignmentPredicateOptions): SQL {
  assertSchemaName(schema);

  const unseen = buildUnseenAssignmentSql({ userId, schema });

  /**
   * NO `--` COMMENTS INSIDE THE TEMPLATE. This fragment is rendered to a string and executed both by
   * Drizzle and, on the auth side, by node-postgres directly. A line comment survives only as long as
   * the newline after it does, so anything that collapsed this fragment to one line would comment out
   * the entire rest of the query — and the failure mode of a predicate that silently disappears is a
   * modal that fires for every task in the office. The explanation lives here instead:
   *
   *   assigned_to    the caller, always; never a value from a payload.
   *   source         C4. created_by is NULL on every rules-engine and AI-disconnect task, and those are
   *                  the bulk of the volume — without this the modal is mostly machine output under a
   *                  blank "assigned by", and "who assigned it" is why the feature exists.
   *   created_by     somebody ELSE put this on your list — OR you wrote it and it came back to you.
   *                  The New Task form defaults assignedTo to the creator, so without the first test a
   *                  person who types their own task is greeted at their next login by a dialog
   *                  informing them of it. But the first test alone then suppresses the opposite case:
   *                  Alice writes a task, gives it to Bob, Bob gives it back, and created_by once
   *                  again equals assigned_to even though she has just been handed something. The
   *                  `assigned_at > created_at` arm separates them — a task that never changed hands
   *                  still carries the assigned_at it was created with.
   *
   *                  IS NOT NULL is load-bearing here and is tested. Without it a row with no recorded
   *                  creator is rescued by the second arm whenever it has ever been reassigned, and it
   *                  has nobody to attribute the task to — which is the one thing the modal exists to
   *                  say. (It was briefly removed when the clause was a bare `<>`, where three-valued
   *                  logic already excluded NULL and mutation testing proved it dead. Adding the OR
   *                  brought it back to life.)
   *   is_test_data   mirrors excludeTestTasks() on the list projections. A demo task greeting somebody
   *                  at login is the worst possible place for one. COALESCE because the auth demo seed
   *                  used to omit the column from its INSERT entirely.
   *
   * THEN ONE OF TWO BRANCHES, and the asymmetry between them is the design:
   *
   *   NEVER SHOWN    any non-terminal, non-scheduled status. A reassignment does not reset status, so
   *                  a first-time assignment routinely arrives as in_progress. Migration 0235 seeds the
   *                  ack table, so "no row" means new rather than merely unread.
   *   STILL PENDING  the repeat rule — urgent/high, or overdue — and only while the task is still
   *                  `pending`. Once the assignee has moved it themselves it has visibly been seen and
   *                  has no business interrupting them again. A NULL due_date yields NULL rather than
   *                  true, so an undated task is never treated as overdue.
   */
  return sql`
    ${tasks.assignedTo} = ${userId}
    AND ${tasks.source} = 'manual'
    AND ${tasks.createdBy} IS NOT NULL
    AND (
      ${tasks.createdBy} <> ${tasks.assignedTo}
      OR ${tasks.assignedAt} > ${tasks.createdAt}
    )
    AND COALESCE(${tasks.isTestData}, false) = false
    AND (
      (
        ${unseen}
        AND ${tasks.status} IN (${quotedList(NEW_ASSIGNMENT_STATUSES)})
      )
      OR (
        ${tasks.status} = 'pending'
        AND (
          ${tasks.priority} IN (${quotedList(REPEATING_TASK_PRIORITIES)})
          OR ${tasks.dueDate} < ${todayCt}
        )
      )
    )
  `;
}

/** YYYY-MM-DD in America/Chicago — the office timezone the whole task surface buckets against. */
export function pendingAssignmentTodayCt(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}
