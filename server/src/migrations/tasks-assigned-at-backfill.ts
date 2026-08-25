import type pg from "pg";

// THE SAME INVARIANT task-source-backfill.ts exists to hold, for the same table:
//
//   Nothing that takes a lock on `tasks` may run inside a migration file's single transaction
//   across every office.
//
// runner.ts sends each .sql file as ONE client.query(sql), which Postgres runs as one implicit
// transaction. A `DO` block looping every office_% schema therefore holds every lock it takes until the
// LAST office finishes — per-tenant transactions are not expressible inside a migration file at all, so
// this cannot be fixed by rearranging the SQL. 0233 hit this exact wall and the answer is settled; this
// is that answer reused, not a second approach to the same problem.
//
// 0239's backfill has to disable the same two triggers around itself, for the same reasons:
//
//   * set_tasks_updated_at (0001:858) sets NEW.updated_at = NOW() on every UPDATE, unconditionally, and
//     the contacts list reads MAX(tasks.updated_at) straight through as a contact's "Last touch" —
//     with the "Untouched 30d+" card, its ?card=untouched drill and the aggregate ALL derived from that
//     one expression. Letting it fire would stamp every contact that has ever had a task with the
//     migration's timestamp, and the original values are not recoverable.
//   * audit_tasks fires ~30 dynamic EXECUTEs per row and would write an audit entry per task, in every
//     office, for a column no person edited.
//
// `ALTER TABLE ... DISABLE TRIGGER` takes a lock that conflicts with INSERT/UPDATE/DELETE on the table,
// so inside the migration file the lock taken for the first office would be held while every remaining
// office was processed — task writes blocking progressively across ALL tenants, on the deploy that
// ships the feature, potentially past the app's 30/45s timeouts.
//
// So the backfill lives here, where each office gets its OWN transaction and releases its locks at its
// own COMMIT. 0239 keeps only the additive `ALTER TABLE ... ADD COLUMN`, which is metadata-only in
// PG11+ and cannot be moved out of the file anyway — the office provisioner replays that block for
// schemas created after this deploy.
//
// Ordering: the runner executes 0239's file FIRST and calls this afterwards, because the column has to
// exist before it can be written.
export const TASKS_ASSIGNED_AT_BACKFILL_MIGRATION = "0239_tasks_assigned_at.sql";

const OFFICE_SCHEMA_DISCOVERY_SQL = `
  SELECT schema_name
  FROM information_schema.schemata
  WHERE schema_name LIKE 'office\\_%' ESCAPE '\\'
  ORDER BY schema_name
`;

/** The two triggers disabled around the backfill, in the order they are disabled. */
export const ASSIGNED_AT_SUSPENDED_TRIGGERS = ["set_tasks_updated_at", "audit_tasks"] as const;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function validateOfficeSchemaName(schemaName: string): string {
  if (!/^office_[a-z][a-z0-9_]*$/.test(schemaName)) {
    throw new Error(`Invalid office schema name: ${schemaName}`);
  }
  return schemaName;
}

/**
 * Date every existing task from its creation.
 *
 * History does not record when a task changed hands, so any value is a guess and the DIRECTION of the
 * guess is the whole decision. created_at is the earliest defensible one, and being too early is the
 * safe error: an existing acknowledgement still covers the assignment and nothing pops. now() would
 * post-date every acknowledgement in the table at a stroke and re-notify the entire company about work
 * they have already seen — the failure 0235's own seed exists to prevent, reintroduced by its
 * neighbour.
 *
 * Guarded on the value actually differing, so a converged schema is not rewritten at all and a re-run
 * touches nothing.
 */
export function buildAssignedAtBackfillStatement(schemaName: string): string {
  const schema = quoteIdentifier(validateOfficeSchemaName(schemaName));
  return `
    UPDATE ${schema}.tasks SET assigned_at = created_at
     WHERE assigned_at <> created_at`;
}

async function tenantHasTasks(client: pg.Client, schemaName: string): Promise<boolean> {
  const result = await client.query<{ n: number }>(
    `
      SELECT COUNT(*)::int AS n
      FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = 'tasks'
    `,
    [schemaName]
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

async function tenantIsReady(client: pg.Client, schemaName: string): Promise<boolean> {
  const result = await client.query<{ n: number }>(
    `
      SELECT COUNT(*)::int AS n
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'tasks' AND column_name = 'assigned_at'
    `,
    [schemaName]
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

/**
 * Dates existing tasks from their creation, per office, ONE TRANSACTION PER OFFICE.
 *
 * The DISABLE/ENABLE pair is deliberately unconditional rather than wrapped in an "if the trigger
 * exists" test. If a tenant schema somehow lacks these triggers the right outcome is a loud failure —
 * visible, and fully recoverable because that office's transaction rolls back having written nothing.
 * The alternative, skipping the disable and backfilling with set_tasks_updated_at live, is the
 * irreversible one. Given the choice between failing loudly and corrupting a metric silently, fail
 * loudly.
 */
export async function runTasksAssignedAtBackfill(client: pg.Client): Promise<void> {
  const schemaResult = await client.query<{ schema_name: string }>(OFFICE_SCHEMA_DISCOVERY_SQL);

  let officesWithTasks = 0;
  let officesBackfilled = 0;

  for (const row of schemaResult.rows) {
    const schemaName = validateOfficeSchemaName(row.schema_name);
    const schema = quoteIdentifier(schemaName);

    if (await tenantHasTasks(client, schemaName)) officesWithTasks += 1;

    // A schema with no tasks table never received 0239's column either. Skip rather than raising on the
    // undefined column and taking every other office down with it. A schema that HAS tasks but not the
    // column is a partially-provisioned tenant and is skipped for the same reason — but see the
    // ordering check after the loop, which catches the case where that is true of EVERY office.
    if (!(await tenantIsReady(client, schemaName))) continue;
    officesBackfilled += 1;

    await client.query("BEGIN");
    try {
      for (const trigger of ASSIGNED_AT_SUSPENDED_TRIGGERS) {
        await client.query(`ALTER TABLE ${schema}.tasks DISABLE TRIGGER ${trigger}`);
      }

      await client.query(buildAssignedAtBackfillStatement(schemaName));

      for (const trigger of [...ASSIGNED_AT_SUSPENDED_TRIGGERS].reverse()) {
        await client.query(`ALTER TABLE ${schema}.tasks ENABLE TRIGGER ${trigger}`);
      }

      // Releases this office's locks before the next one is touched — the whole reason this is not a
      // DO block in the migration file.
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }

  // ORDERING GUARD. This step must run AFTER 0239's file, which adds the column. Called before it,
  // every office would fail the tenantIsReady test, the loop would date nothing, and the migration
  // would be recorded as applied — a silent no-op, which is precisely how the task-source index
  // pre-step's first-deploy bug survived review. A single tenant with a tasks table and no column is
  // legitimate (a partially-provisioned office); ALL of them being in that state is not.
  if (officesWithTasks > 0 && officesBackfilled === 0) {
    throw new Error(
      `tasks.assigned_at backfill ran before the column existed: ${officesWithTasks} office schema(s) ` +
        `have a tasks table and none has an "assigned_at" column. It must run AFTER ` +
        `0239_tasks_assigned_at.sql.`
    );
  }
}
