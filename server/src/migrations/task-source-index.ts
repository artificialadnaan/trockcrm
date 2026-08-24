import type pg from "pg";

// Mirrors the project-number / audit-log / bid-board / deal-stage-history / activities index-migration
// pattern.
//
// Migration 0233 adds `tasks.source` and wants an (assigned_to, source, status, due_date) index to serve
// the new per-source task tabs. `tasks` is written by the rules engine, the email-assignment queue, two
// crons, deal reassignment and every person using the New Task form, so it is never idle. A plain
// CREATE INDEX inside the file's DO block takes a write-blocking SHARE lock, and because the whole loop
// is ONE statement sent as a single client.query() those locks are all held until the LAST office
// finishes: task writes across every office would queue behind it and start failing on the app's 30/45s
// timeouts — on API boot, which is exactly when the queue is deepest.
//
// CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so the runner intercepts 0233 and
// builds each tenant's index here first, one statement at a time. The file's plain
// `CREATE INDEX IF NOT EXISTS` then no-ops on existing tenants, while still serving as the marker the
// office provisioner replays for schemas created after this deploy.
//
// Note the ORDER relative to the file: this pre-step runs BEFORE the SQL file, so it must tolerate a
// tasks table that does not have the `source` column yet — hence the column check below. On the first
// deploy every office skips here and the file's own CREATE INDEX builds it (small, since the column was
// just added and the table is already locked by the ALTER in the same statement); on any subsequent
// replay the column exists and this path does the real, non-blocking work.
export const TASK_SOURCE_INDEX_MIGRATION = "0233_task_source_classification.sql";

export const TASK_SOURCE_INDEX_NAME = "tasks_assigned_source_status_idx";

export const OFFICE_SCHEMA_DISCOVERY_SQL = `
  SELECT schema_name
  FROM information_schema.schemata
  WHERE schema_name LIKE 'office\\_%' ESCAPE '\\'
  ORDER BY schema_name
`;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function validateOfficeSchemaName(schemaName: string): string {
  if (!/^office_[a-z][a-z0-9_]*$/.test(schemaName)) {
    throw new Error(`Invalid office schema name: ${schemaName}`);
  }
  return schemaName;
}

/** Kept in lockstep with the plain CREATE INDEX in 0233, which no-ops once this has built it. */
export function buildTaskSourceIndexStatement(schemaName: string): string {
  const safeSchemaName = quoteIdentifier(validateOfficeSchemaName(schemaName));
  return `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${TASK_SOURCE_INDEX_NAME}
      ON ${safeSchemaName}.tasks (assigned_to, source, status, due_date)`;
}

async function hasSourceColumn(client: pg.Client, schemaName: string): Promise<boolean> {
  const result = await client.query<{ n: number }>(
    `
      SELECT COUNT(*)::int AS n
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'tasks' AND column_name = 'source'
    `,
    [schemaName]
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

async function getIndexValidity(client: pg.Client, schemaName: string): Promise<boolean | null> {
  const result = await client.query<{ is_valid: boolean }>(
    `
      SELECT i.indisvalid AS is_valid
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2
    `,
    [schemaName, TASK_SOURCE_INDEX_NAME]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].is_valid;
}

export async function runTaskSourceIndexMigration(client: pg.Client): Promise<void> {
  const schemaResult = await client.query<{ schema_name: string }>(OFFICE_SCHEMA_DISCOVERY_SQL);
  for (const row of schemaResult.rows) {
    const schemaName = validateOfficeSchemaName(row.schema_name);
    const safeSchemaName = quoteIdentifier(schemaName);

    // The column arrives with the SQL file, which runs after this. Nothing to index yet on a first
    // deploy — skip rather than raising on the undefined column and aborting the whole migration.
    if (!(await hasSourceColumn(client, schemaName))) continue;

    const validity = await getIndexValidity(client, schemaName);

    if (validity === false) {
      // An interrupted CONCURRENTLY build leaves an INVALID stub, which IF NOT EXISTS would then skip
      // forever — the index would exist, never be used, and nothing would say so. Drop before retrying.
      await client.query(
        `DROP INDEX CONCURRENTLY IF EXISTS ${safeSchemaName}.${TASK_SOURCE_INDEX_NAME}`
      );
    }

    await client.query(buildTaskSourceIndexStatement(schemaName));
  }
}
