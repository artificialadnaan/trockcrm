import type pg from "pg";
import { runPerOfficeTransactionalStep, validateOfficeSchemaName } from "./per-office-step.js";

// Existing-office half of migration 0235, deliberately outside the SQL file.
//
// `CREATE TABLE ... REFERENCES tasks` takes a write-conflicting lock on the referenced tasks table,
// and the seed reads that same hot table. A migration file is one implicit transaction, so its former
// DO loop held office A's tasks lock while it created and seeded every later office. The generic runner
// below is the established repair: one explicit transaction per office, committed before the next schema
// is touched. The runner executes the SQL file first because it installs the durable deferred
// public.offices fence for an old API image that provisions during this scan. That fence records offices
// it repaired at COMMIT, so this helper seeds only the pre-fence historical set; otherwise a retry could
// mistake a just-created office's first task for history. The SQL file must not regain an
// existing-office loop.
export const TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_MIGRATION = "0235_task_assignment_acknowledgements.sql";
export const TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_FENCED_OFFICES_TABLE =
  "public._task_assignment_acknowledgements_fenced_offices";

// This is deliberately ONE statement rather than loading fence rows and then doing ordinary discovery.
// PostgreSQL takes one statement snapshot: an office committed by the deferred fence is visible with its
// marker and excluded, while one committed after the snapshot is absent from both. Splitting those reads
// can discover a newly committed schema using a stale marker set and historically seed its first task.
export const TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_HISTORICAL_SCHEMA_DISCOVERY_SQL = `
  SELECT schemas.schema_name
  FROM information_schema.schemata AS schemas
  WHERE schemas.schema_name LIKE 'office\\_%' ESCAPE '\\'
    AND NOT EXISTS (
      SELECT 1
      FROM ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_FENCED_OFFICES_TABLE} AS fenced_offices
      WHERE fenced_offices.schema_name = schemas.schema_name
    )
  ORDER BY schemas.schema_name
`;

export const TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_STEP = {
  label: "0235 task assignment acknowledgement setup",
  table: "tasks",
  // 0235 creates a separate table; it does not add a tasks column that could establish ordering. `id`
  // is the minimal invariant for a real tasks table and preserves the old migration's skip for an
  // incomplete office schema with no tasks table.
  requiredColumn: "id",
  schemaDiscoverySql: TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_HISTORICAL_SCHEMA_DISCOVERY_SQL,
  buildStatements: (schema: string) => [
    `
      CREATE TABLE IF NOT EXISTS ${schema}.task_assignment_acknowledgements (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id         uuid NOT NULL REFERENCES ${schema}.tasks(id) ON DELETE CASCADE,
        user_id         uuid NOT NULL,
        acknowledged_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT task_assignment_ack_uq UNIQUE (task_id, user_id)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS task_assignment_ack_user_idx
        ON ${schema}.task_assignment_acknowledgements (user_id, acknowledged_at DESC)
    `,
    // Seed only historical, non-terminal assignments. Absence of an acknowledgement means "never
    // shown", so failing to do this would turn the full pre-deploy backlog into consecutive modals.
    `
      INSERT INTO ${schema}.task_assignment_acknowledgements (task_id, user_id, acknowledged_at)
      SELECT id, assigned_to, now()
        FROM ${schema}.tasks
       WHERE status NOT IN ('completed', 'dismissed')
      ON CONFLICT (task_id, user_id) DO NOTHING
    `,
  ],
} as const;

/** Create, index and seed 0235's historical offices one transaction at a time. */
export async function runTaskAssignmentAcknowledgementsMigration(client: pg.Client): Promise<void> {
  await runPerOfficeTransactionalStep(client, TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_STEP);
}

export { validateOfficeSchemaName };
