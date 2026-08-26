import type pg from "pg";
import {
  runPerOfficeTransactionalStep,
  validateOfficeSchemaName,
  type PerOfficeStep,
} from "./per-office-step.js";

// Existing-office half of migration 0235, deliberately outside the SQL file.
//
// `CREATE TABLE ... REFERENCES tasks` takes a write-conflicting lock on the referenced tasks table,
// while the historical seed reads that same hot table. A migration file is one implicit transaction, so
// its former DO loop held office A's tasks lock while it created and seeded every later office. Phase 1
// below therefore takes ONE repeatable-read snapshot and writes only durable public metadata/pairs; it
// never takes tenant DDL locks. Phase 2 then creates/indexes/seeds one office at a time and commits
// before touching the next. The runner holds a #0235-only session advisory lock around the SQL file,
// both phases and the migration ledger; that serializes migration runners, not ordinary task writes.
export const TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_MIGRATION = "0235_task_assignment_acknowledgements.sql";
export const TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_CUTOVERS_TABLE =
  "public._task_assignment_acknowledgements_cutovers";
export const TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_BASELINE_PAIRS_TABLE =
  "public._task_assignment_acknowledgements_baseline_pairs";
export const TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_GLOBAL_CUTOVER_TABLE =
  "public._task_assignment_acknowledgements_global_cutover";

export type TaskAssignmentAcknowledgementCutoverState = "captured" | "seeded" | "post_fence";

// This is deliberately ONE statement rather than loading cutover rows and then doing ordinary discovery.
// PostgreSQL takes one statement snapshot: an office committed by the deferred post-fence trigger is
// visible with its `post_fence` header and excluded, while one committed after the snapshot is absent
// from both. A separate header lookup followed by schema discovery can seed a newly committed office's
// first task as history. Captured historical offices stay in this result so phase 2 can materialize their
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

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

const CAPTURE_REQUIRED_COLUMNS = ["id", "assigned_to", "status"] as const;

async function taskTableExists(client: pg.Client, schemaName: string): Promise<boolean> {
  const result = await client.query<{ n: number }>(
    `
      SELECT COUNT(*)::int AS n
      FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = 'tasks'
    `,
    [schemaName]
  );
  return Number(result.rows[0]?.n ?? 0) > 0;
}

async function taskColumnExists(
  client: pg.Client,
  schemaName: string,
  columnName: string
): Promise<boolean> {
  const result = await client.query<{ n: number }>(
    `
      SELECT COUNT(*)::int AS n
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'tasks' AND column_name = $2
    `,
    [schemaName, columnName]
  );
  return Number(result.rows[0]?.n ?? 0) > 0;
}

function baselineCaptureStatement(schema: string, schemaName: string): string {
  const schemaLiteral = quoteSqlLiteral(schemaName);
  return `
    WITH newly_captured AS (
      INSERT INTO ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_CUTOVERS_TABLE} (schema_name, state)
      VALUES (${schemaLiteral}, 'captured')
      ON CONFLICT (schema_name) DO NOTHING
      RETURNING schema_name
    )
    INSERT INTO ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_BASELINE_PAIRS_TABLE}
      (schema_name, task_id, user_id, baseline_assigned_at, baseline_ack_at)
    SELECT newly_captured.schema_name,
           tasks.id,
           tasks.assigned_to,
           tasks.assigned_at,
           CASE
             -- Acknowledgements cover assignment versions only when their timestamp is at least the
             -- version timestamp. A restored/future version can legitimately lead the capture clock;
             -- NULL is the pre-0239-backfill historical version and falls back to the capture instant.
             WHEN tasks.assigned_at > $1::timestamptz THEN tasks.assigned_at
             ELSE $1::timestamptz
           END
      FROM newly_captured
      CROSS JOIN ${schema}.tasks AS tasks
     WHERE tasks.status NOT IN ('completed', 'dismissed')
       AND tasks.assigned_to IS NOT NULL
    ON CONFLICT (schema_name, task_id, user_id) DO NOTHING
  `;
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
 * Phase 2 materializes a captured office only while its exact assignment still exists. A handoff after
 * capture must not seed either the new recipient or someone the task later returns to: both the assignee
 * and nullable assignment version must match the durable snapshot. The captured acknowledgement timestamp
 * is preserved for the unchanged assignment.
 */
export const TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_MATERIALIZE_STEP: PerOfficeStep = {
  label: "0235 task assignment acknowledgement materialization",
  table: "tasks",
  requiredColumn: "id",
  capabilityColumns: ["assigned_to", "assigned_at", "status"],
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
          JOIN ${schema}.tasks AS tasks
            ON tasks.id = baseline.task_id
           AND tasks.assigned_to = baseline.user_id
           AND tasks.assigned_at IS NOT DISTINCT FROM baseline.baseline_assigned_at
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

/**
 * Freeze every historical office in ONE repeatable-read transaction before phase 2 takes any tenant DDL
 * lock. A per-office capture lets a task written after the first office commits slip into a later
 * office's baseline, permanently classifying a genuinely new assignment as already seen.
 *
 * The singleton marker is committed with every header/pair. It is intentionally not a best-effort
 * progress row: marker absent means the transaction left no capture behind; marker present means retries
 * must materialize only these frozen rows. Older per-office captured/seeded rows without that marker are
 * an unsafe mixed baseline, so fail closed rather than silently inventing a new cutoff around them.
 */
export async function captureTaskAssignmentAcknowledgementBaselines(
  client: pg.Client
): Promise<void> {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    // This first query establishes the repeatable-read snapshot. Every discovery, capability check and
    // tasks read below therefore sees the same deployment-wide history, even though statements execute
    // one office at a time to interpolate their validated schema identifiers.
    const completed = await client.query(
      `
        SELECT baseline_ack_at
        FROM ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_GLOBAL_CUTOVER_TABLE}
        WHERE singleton = true
      `
    );
    if (completed.rows.length > 0) {
      await client.query("COMMIT");
      return;
    }

    // This PR's earlier unledgered revisions captured offices independently. Do not make a hybrid
    // baseline by accepting their rows then globally sampling the rest; we cannot reconstruct a single
    // snapshot around them. Production has not ledgered 0235, so a loud failure here is recoverable.
    const legacyPartial = await client.query<{ schema_name: string; state: string }>(
      `
        SELECT schema_name, state
        FROM ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_CUTOVERS_TABLE}
        WHERE state IN ('captured', 'seeded')
        ORDER BY schema_name
        LIMIT 1
      `
    );
    if (legacyPartial.rows[0]) {
      const { schema_name: schemaName, state } = legacyPartial.rows[0];
      throw new Error(
        `0235 task assignment acknowledgement setup: found legacy ${state} cutover for ${schemaName} ` +
          "without a global baseline marker; refusing to mix per-office and global snapshots"
      );
    }

    // Use one database clock value as every pair's minimum acknowledgement instant. A captured
    // assignment version ahead of that clock raises its own acknowledgement to that version; a retry
    // uses the durable values rather than sampling again.
    const timestamp = await client.query<{ baseline_ack_at: Date }>(
      "SELECT clock_timestamp() AS baseline_ack_at"
    );
    const baselineAckAt = timestamp.rows[0]?.baseline_ack_at;
    if (!baselineAckAt) {
      throw new Error("0235 task assignment acknowledgement setup: could not establish baseline timestamp");
    }

    const schemas = await client.query<{ schema_name: string }>(
      TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_HISTORICAL_SCHEMA_DISCOVERY_SQL
    );
    for (const row of schemas.rows) {
      const schemaName = validateOfficeSchemaName(row.schema_name);
      if (!(await taskTableExists(client, schemaName))) continue;

      // Preserve the established legacy-shape behaviour for the columns the baseline itself reads. A
      // partially provisioned office must not abort every healthy tenant, and the permanent office fence
      // supplies the current shape for new offices after this cutover. Check this BEFORE assigned_at:
      // a malformed table cannot ever process a handoff, so 0239 intentionally skips it rather than
      // adding a column that would make its later backfill attempt to suspend absent row triggers.
      let capable = true;
      for (const columnName of CAPTURE_REQUIRED_COLUMNS) {
        if (!(await taskColumnExists(client, schemaName, columnName))) {
          capable = false;
          break;
        }
      }
      if (!capable) continue;

      // 0239's nullable column + old-image compatibility trigger must already be in place before this
      // snapshot. Without it, an A→B→A handoff after capture is indistinguishable from self-created
      // history when 0239 later backfills created_at.
      if (!(await taskColumnExists(client, schemaName, "assigned_at"))) {
        throw new Error(
          `0235 task assignment acknowledgement setup: ${schemaName}.tasks lacks assigned_at; ` +
            "install 0239 assignment versioning before the acknowledgement cutover"
        );
      }

      await client.query(baselineCaptureStatement(quoteIdentifier(schemaName), schemaName), [baselineAckAt]);
    }

    // This is deliberately last. If any office fails above, ROLLBACK removes every earlier header/pair
    // too; a future boot gets a fresh all-office snapshot rather than a partial baseline plus new work.
    await client.query(
      `
        INSERT INTO ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_GLOBAL_CUTOVER_TABLE}
          (singleton, baseline_ack_at)
        VALUES (true, $1::timestamptz)
      `,
      [baselineAckAt]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
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
