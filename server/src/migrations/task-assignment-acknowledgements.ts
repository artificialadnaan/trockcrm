import type pg from "pg";
import {
  runPerOfficeTransactionalStep,
  validateOfficeSchemaName,
  type PerOfficeStep,
} from "./per-office-step.js";

// Existing-office half of migration 0235, deliberately outside the SQL file.
//
// `CREATE TABLE ... REFERENCES tasks` takes a write-conflicting lock on the referenced tasks table,
// and the historical seed reads that same hot table. A migration file is one implicit transaction, so
// its former DO loop held office A's tasks lock while it created and seeded every later office. The two
// short passes below are the established repair: each office commits its cheap snapshot before DDL, and
// commits its DDL/seed before another office is touched. The runner holds a #0235-only session advisory
// lock around the SQL file, both passes and the migration ledger; that serializes migration runners, not
// ordinary task writes.
export const TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_MIGRATION = "0235_task_assignment_acknowledgements.sql";
export const TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_CUTOVERS_TABLE =
  "public._task_assignment_acknowledgements_cutovers";
export const TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_BASELINE_PAIRS_TABLE =
  "public._task_assignment_acknowledgements_baseline_pairs";

export type TaskAssignmentAcknowledgementCutoverState = "captured" | "seeded" | "post_fence";

// This is deliberately ONE statement rather than loading cutover rows and then doing ordinary discovery.
// PostgreSQL takes one statement snapshot: an office committed by the deferred post-fence trigger is
// visible with its `post_fence` header and excluded, while one committed after the snapshot is absent
// from both. A separate header lookup followed by schema discovery can seed a newly committed office's
// first task as history. Captured historical offices stay in this result so a retry can materialize their
// immutable pairs; seeded offices are terminal and must never be sampled again.
export const TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_HISTORICAL_SCHEMA_DISCOVERY_SQL = `
  SELECT schemas.schema_name
  FROM information_schema.schemata AS schemas
  LEFT JOIN ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_CUTOVERS_TABLE} AS cutovers
    ON cutovers.schema_name = schemas.schema_name
  WHERE schemas.schema_name LIKE 'office\\_%' ESCAPE '\\'
    AND (cutovers.state IS NULL OR cutovers.state = 'captured')
  ORDER BY schemas.schema_name
`;

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function acknowledgementTableStatements(schema: string): readonly string[] {
  return [
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
  ];
}

/**
 * Phase 1 is the cutover point for an existing office. The header and every eligible (task, assignee)
 * pair commit together BEFORE any acknowledgement-table DDL takes a lock. A retry seeing `captured`
 * preserves those exact rows rather than re-reading tasks created after this transaction.
 */
export const TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_CAPTURE_STEP: PerOfficeStep = {
  label: "0235 task assignment acknowledgement baseline capture",
  table: "tasks",
  // `id` establishes that the tenant's tasks table is real; the two capabilities are separately
  // guarded legacy shape requirements for the exact baseline query below.
  requiredColumn: "id",
  capabilityColumns: ["assigned_to", "status"],
  schemaDiscoverySql: TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_HISTORICAL_SCHEMA_DISCOVERY_SQL,
  buildStatements: (schema: string, schemaName: string) => {
    const schemaLiteral = quoteSqlLiteral(schemaName);
    return [
      `
        WITH newly_captured AS (
          INSERT INTO ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_CUTOVERS_TABLE} (schema_name, state)
          VALUES (${schemaLiteral}, 'captured')
          ON CONFLICT (schema_name) DO NOTHING
          RETURNING schema_name
        )
        INSERT INTO ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_BASELINE_PAIRS_TABLE}
          (schema_name, task_id, user_id, baseline_ack_at)
        SELECT newly_captured.schema_name, tasks.id, tasks.assigned_to, CURRENT_TIMESTAMP
          FROM newly_captured
          CROSS JOIN ${schema}.tasks AS tasks
         WHERE tasks.status NOT IN ('completed', 'dismissed')
           AND tasks.assigned_to IS NOT NULL
        ON CONFLICT (schema_name, task_id, user_id) DO NOTHING
      `,
    ];
  },
};

/** Lock the durable row before phase 2 so a stale discovery result cannot make it seed current tasks. */
async function claimCapturedCutover(
  client: pg.Client,
  _schema: string,
  schemaName: string
): Promise<boolean> {
  const result = await client.query<{ state: TaskAssignmentAcknowledgementCutoverState }>(
    `
      SELECT state
      FROM ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_CUTOVERS_TABLE}
      WHERE schema_name = $1
      FOR UPDATE
    `,
    [schemaName]
  );
  const state = result.rows[0]?.state;

  if (state === "captured") return true;
  if (state === "seeded" || state === "post_fence") return false;

  // Phase 1 must have inserted this row before phase 2 begins. Continuing without it would turn a
  // broken retry into a fresh, current-table seed, which is the data-loss outcome this state machine
  // prevents. Fail loudly and leave the office untouched instead.
  throw new Error(
    `0235 task assignment acknowledgement setup: ${schemaName} has no durable captured cutover`
  );
}

/**
 * Phase 2 materializes a captured office. It deliberately joins baseline pairs to the current table
 * only by task id: a reassignment after capture must leave the new assignee unacknowledged. The captured
 * timestamp is preserved too, so a reassignment away and back to the same user leaves this old
 * acknowledgement older than the new assigned_at value it did not historically acknowledge.
 */
export const TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_MATERIALIZE_STEP: PerOfficeStep = {
  label: "0235 task assignment acknowledgement materialization",
  table: "tasks",
  requiredColumn: "id",
  capabilityColumns: ["assigned_to", "status"],
  schemaDiscoverySql: TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_HISTORICAL_SCHEMA_DISCOVERY_SQL,
  beforeStatements: claimCapturedCutover,
  buildStatements: (schema: string, schemaName: string) => {
    const schemaLiteral = quoteSqlLiteral(schemaName);
    return [
      ...acknowledgementTableStatements(schema),
      `
        INSERT INTO ${schema}.task_assignment_acknowledgements (task_id, user_id, acknowledged_at)
        SELECT baseline.task_id, baseline.user_id, baseline.baseline_ack_at
          FROM ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_BASELINE_PAIRS_TABLE} AS baseline
          JOIN ${schema}.tasks AS tasks ON tasks.id = baseline.task_id
         WHERE baseline.schema_name = ${schemaLiteral}
        ON CONFLICT (task_id, user_id) DO NOTHING
      `,
      `
        DELETE FROM ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_BASELINE_PAIRS_TABLE}
        WHERE schema_name = ${schemaLiteral}
      `,
      `
        UPDATE ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_CUTOVERS_TABLE}
        SET state = 'seeded'
        WHERE schema_name = ${schemaLiteral} AND state = 'captured'
      `,
    ];
  },
};

/** Capture every historical office's immutable baseline in short, per-office transactions. */
export async function captureTaskAssignmentAcknowledgementBaselines(
  client: pg.Client
): Promise<void> {
  await runPerOfficeTransactionalStep(client, TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_CAPTURE_STEP);
}

/** Materialize captured baselines one office at a time, retaining state/pairs if an office rolls back. */
export async function materializeTaskAssignmentAcknowledgementBaselines(
  client: pg.Client
): Promise<void> {
  await runPerOfficeTransactionalStep(client, TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_MATERIALIZE_STEP);
}

/** Run 0235's durable historical cutover: snapshot first, then materialize only those snapshots. */
export async function runTaskAssignmentAcknowledgementsMigration(client: pg.Client): Promise<void> {
  await captureTaskAssignmentAcknowledgementBaselines(client);
  await materializeTaskAssignmentAcknowledgementBaselines(client);
}

export { validateOfficeSchemaName };
