import type pg from "pg";
import { runPerOfficeTransactionalStep, validateOfficeSchemaName } from "./per-office-step.js";

// The 0239 assigned_at backfill, expressed as a per-office transactional step.
//
// WHY IT IS NOT IN THE MIGRATION FILE. It has to disable two triggers around itself, and
// `ALTER TABLE ... DISABLE TRIGGER` takes a lock that conflicts with task inserts, updates and deletes.
// runner.ts sends each .sql file as ONE client.query(sql), so a DO block doing this per office would
// hold the first office's lock until the LAST office finished — task writes blocking progressively
// across every tenant, during API startup. See per-office-step.ts for the general rule and the
// mechanism; this file is only the configuration for it, exactly as task-source-backfill.ts is.
//
// WHY THOSE TWO TRIGGERS — the same pair, for the same reasons, on the same table. set_tasks_updated_at
// sets NEW.updated_at = NOW() on every UPDATE, and the contacts list reads MAX(tasks.updated_at)
// straight through as a contact's "Last touch", with the "Untouched 30d+" card, its ?card=untouched
// drill and the aggregate ALL derived from that one expression; letting it fire would stamp every
// contact that has ever had a task with the migration's timestamp, unrecoverably. audit_tasks would
// write an audit row per task, in every office, for a column no person edited.
//
// WHAT STAYS IN 0239: the `ALTER TABLE ... ADD COLUMN assigned_at timestamptz NOT NULL DEFAULT now()`,
// which is metadata-only in PG11+ and has to be in the file regardless — the office provisioner replays
// that marked block for schemas created after this deploy.
export const TASKS_ASSIGNED_AT_BACKFILL_MIGRATION = "0239_tasks_assigned_at.sql";

/** The two triggers suspended around the backfill, in the order they are suspended. */
export const ASSIGNED_AT_SUSPENDED_TRIGGERS = ["set_tasks_updated_at", "audit_tasks"] as const;

/**
 * Date every existing task from its creation.
 *
 * History does not record when a task changed hands, so any value is a guess and the DIRECTION of the
 * guess is the whole decision. created_at is the earliest defensible one, and too early is the safe
 * error: an existing acknowledgement still covers the assignment and nothing pops. now() would
 * post-date every acknowledgement 0235 seeded and re-notify the entire company about work they have
 * already seen — the failure that seed exists to prevent, reintroduced by its neighbour.
 *
 * Guarded on the value actually differing, so a converged schema is not rewritten and a re-run touches
 * nothing.
 *
 * @param schema an ALREADY validated and quoted schema identifier.
 */
export function buildAssignedAtBackfillStatement(schema: string): string {
  return `
    UPDATE ${schema}.tasks SET assigned_at = created_at
     WHERE assigned_at <> created_at`;
}

export const TASKS_ASSIGNED_AT_BACKFILL_STEP = {
  label: "0239 tasks.assigned_at backfill",
  table: "tasks",
  requiredColumn: "assigned_at",
  suspendTriggers: ASSIGNED_AT_SUSPENDED_TRIGGERS,
  buildStatements: (schema: string) => [buildAssignedAtBackfillStatement(schema)],
} as const;

/** Dates existing tasks from their creation, one transaction per office. */
export async function runTasksAssignedAtBackfill(client: pg.Client): Promise<void> {
  await runPerOfficeTransactionalStep(client, TASKS_ASSIGNED_AT_BACKFILL_STEP);
}

export { validateOfficeSchemaName };
