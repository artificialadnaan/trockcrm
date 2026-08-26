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
// WHAT STAYS IN 0239: its global functions/provisioner fence and the new-office tenant template. The
// existing-office nullable ADD COLUMN, DEFAULT now() and compatibility triggers are below, because they
// must share a short per-office transaction. The column is nullable for this migration window so an old
// API reassignment can stamp it before the later NULL-only history fill restores NOT NULL. A newly
// provisioned office has no history, so the tenant block applies the strict contract directly.
export const TASKS_ASSIGNED_AT_BACKFILL_MIGRATION = "0239_tasks_assigned_at.sql";

/**
 * The safe, global portion of 0239 which has to exist before an existing-office scan begins.
 *
 * The migration file keeps these markers around the functions and deferred public.offices fence so
 * runner.ts can install them BEFORE the per-office stage below.  It must not run the new-office
 * template at that point: applying the template's NOT NULL DEFAULT to an already-live Dallas table
 * would date historical rows from the default and erase the NULL-only backfill discriminator.
 */
export const TASKS_ASSIGNED_AT_VERSIONING_GLOBALS_START =
  "-- TASKS_ASSIGNED_AT_VERSIONING_GLOBALS_START";
export const TASKS_ASSIGNED_AT_VERSIONING_GLOBALS_END =
  "-- TASKS_ASSIGNED_AT_VERSIONING_GLOBALS_END";

/** Extract only 0239's global functions/provisioning fence, never its tenant template. */
export function extractTasksAssignedAtVersioningGlobals(migrationSql: string): string {
  const start = migrationSql.indexOf(TASKS_ASSIGNED_AT_VERSIONING_GLOBALS_START);
  const end = migrationSql.indexOf(
    TASKS_ASSIGNED_AT_VERSIONING_GLOBALS_END,
    start + TASKS_ASSIGNED_AT_VERSIONING_GLOBALS_START.length
  );
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `${TASKS_ASSIGNED_AT_BACKFILL_MIGRATION} is missing its tasks.assigned_at versioning-global markers`
    );
  }
  return migrationSql
    .slice(start + TASKS_ASSIGNED_AT_VERSIONING_GLOBALS_START.length, end)
    .trim();
}

/**
 * Existing-office half of 0239's deploy-window compatibility surface.
 *
 * `DROP/CREATE TRIGGER` conflicts with task writes.  It is deliberately a per-office runner step,
 * rather than a `DO` loop in the SQL file, so each office releases its lock before the next is touched.
 * The nullable column/default and both triggers share one short transaction: an old API can never see
 * the new column without the trigger that stamps a handoff it does not name.
 */
export const TASKS_ASSIGNED_AT_VERSIONING_STEP = {
  label: "0239 tasks.assigned_at versioning",
  table: "tasks",
  // A real tenant tasks table always has its primary key.  Keeping the ordering guard on this stable
  // pre-existing column prevents a broken caller from recording 0239 after silently visiting nothing.
  requiredColumn: "id",
  // Some historical half-built schemas have a tasks table but no assignment field. They cannot support
  // this feature, so skip them before opening a DDL transaction; 0235's capability check likewise
  // treats them as a legacy compatibility skip rather than aborting healthy offices.
  capabilityColumns: ["assigned_to"],
  buildStatements: (schema: string) => [
    `
      ALTER TABLE ${schema}.tasks
        ADD COLUMN IF NOT EXISTS assigned_at timestamptz`,
    `
      ALTER TABLE ${schema}.tasks
        ALTER COLUMN assigned_at SET DEFAULT now()`,
    `DROP TRIGGER IF EXISTS stamp_tasks_assigned_at ON ${schema}.tasks`,
    `
      CREATE TRIGGER stamp_tasks_assigned_at
        BEFORE UPDATE OF assigned_to ON ${schema}.tasks
        FOR EACH ROW
        WHEN (OLD.assigned_to IS DISTINCT FROM NEW.assigned_to)
        EXECUTE FUNCTION public.stamp_task_assigned_at()`,
    `DROP TRIGGER IF EXISTS stabilize_tasks_assignment_actor ON ${schema}.tasks`,
    `
      CREATE TRIGGER stabilize_tasks_assignment_actor
        BEFORE UPDATE OF assigned_to ON ${schema}.tasks
        FOR EACH ROW
        EXECUTE FUNCTION public.stabilize_task_assignment_actor()`,
  ],
} as const;

/** Stage the nullable column/default and compatibility triggers one office transaction at a time. */
export async function runTasksAssignedAtVersioning(client: pg.Client): Promise<void> {
  await runPerOfficeTransactionalStep(client, TASKS_ASSIGNED_AT_VERSIONING_STEP);
}

/**
 * Install 0239's global fence first, then stage existing tenants one at a time.
 *
 * The fence closes the provisioner race while discovery is running: an old office committed before the
 * fence DDL drains into the scan, and one committed afterwards repairs itself at COMMIT.
 */
export async function installTasksAssignedAtVersioning(
  client: pg.Client,
  migrationSql: string
): Promise<void> {
  await client.query(extractTasksAssignedAtVersioningGlobals(migrationSql));
  await runTasksAssignedAtVersioning(client);
}

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
 * NULL is the deploy-safe discriminator. The migration's compatibility trigger stamps any assignment
 * written by an old API after the column appears, while untouched historical rows remain NULL. Updating
 * only NULLs means this backfill cannot erase a real handoff that races the deployment. It also makes a
 * converged schema a no-op.
 *
 * @param schema an ALREADY validated and quoted schema identifier.
 */
export function buildAssignedAtBackfillStatement(schema: string): string {
  return `
    UPDATE ${schema}.tasks SET assigned_at = created_at
     WHERE assigned_at IS NULL`;
}

/** Restore the final NOT NULL contract after history has a value; 0239 already installed the default. */
export function buildAssignedAtConstraintStatement(schema: string): string {
  return `
    ALTER TABLE ${schema}.tasks
      ALTER COLUMN assigned_at SET NOT NULL`;
}

export const TASKS_ASSIGNED_AT_BACKFILL_STEP = {
  label: "0239 tasks.assigned_at backfill",
  table: "tasks",
  requiredColumn: "assigned_at",
  // A malformed legacy tasks table can carry a stray assigned_at column while lacking either the field
  // whose handoffs it would version or the historical timestamp this backfill reads. Skip it before
  // trigger suspension; normal tables still fail loudly if either required row trigger is absent.
  capabilityColumns: ["assigned_to", "created_at"],
  suspendTriggers: ASSIGNED_AT_SUSPENDED_TRIGGERS,
  buildStatements: (schema: string) => [
    buildAssignedAtBackfillStatement(schema),
    buildAssignedAtConstraintStatement(schema),
  ],
} as const;

/** Dates existing tasks from their creation, one transaction per office. */
export async function runTasksAssignedAtBackfill(client: pg.Client): Promise<void> {
  await runPerOfficeTransactionalStep(client, TASKS_ASSIGNED_AT_BACKFILL_STEP);
}

export { validateOfficeSchemaName };
