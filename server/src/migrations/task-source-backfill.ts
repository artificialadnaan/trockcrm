import type pg from "pg";

// THE INVARIANT THIS FILE EXISTS TO HOLD:
//
//   Nothing that takes a lock on `tasks` may run inside a migration file's single transaction
//   across every office.
//
// runner.ts sends each .sql file as ONE client.query(sql), which Postgres runs as one implicit
// transaction. A `DO` block looping every office_% schema therefore holds every lock it takes until the
// LAST office finishes — per-tenant transactions are not expressible inside a migration file at all, so
// this cannot be fixed by rearranging the SQL.
//
// That matters here because the 0233 backfill has to disable two triggers around itself:
//
//   * set_tasks_updated_at (0001:858) sets NEW.updated_at = NOW() on every UPDATE, unconditionally, and
//     the contacts list reads MAX(tasks.updated_at) straight through as a contact's "Last touch" —
//     with the "Untouched 30d+" card, its ?card=untouched drill and the aggregate ALL derived from that
//     one expression. Letting it fire would stamp every contact that has ever had a task with the
//     migration's timestamp. The card, the drill and the aggregate would move together, so nothing
//     would look inconsistent enough to notice, and the original values are not recoverable.
//   * audit_tasks fires ~30 dynamic EXECUTEs per row and would write an audit entry per task, in every
//     office, for a column no person edited.
//
// `ALTER TABLE ... DISABLE TRIGGER` takes a lock that conflicts with INSERT/UPDATE/DELETE on the table.
// Inside a migration file, the lock taken for the first office would be held while every remaining
// office was processed, so task writes would progressively block across ALL tenants — on the very
// deploy that ships the feature, and potentially past the app's 30/45s timeouts.
//
// So the backfill lives here instead, where each office gets its OWN transaction and releases its locks
// at its own COMMIT before the next office is touched. 0233 keeps only the additive, effectively
// instant `ALTER TABLE ... ADD COLUMN`, which is metadata-only in PG11+ and cannot be moved out.
//
// Ordering: the runner executes 0233's file FIRST and calls this afterwards, because the column has to
// exist before it can be written. (The index in 0237 has the mirror-image constraint and is handled the
// same way — see task-source-index.ts.)
export const TASK_SOURCE_BACKFILL_MIGRATION = "0233_task_source_classification.sql";

export const OFFICE_SCHEMA_DISCOVERY_SQL = `
  SELECT schema_name
  FROM information_schema.schemata
  WHERE schema_name LIKE 'office\\_%' ESCAPE '\\'
  ORDER BY schema_name
`;

/** The two triggers disabled around the backfill, in the order they are disabled. */
export const BACKFILL_SUSPENDED_TRIGGERS = ["set_tasks_updated_at", "audit_tasks"] as const;

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
 * A task with no originating rule but a person recorded against it is a person's task.
 *
 * Every automated shape in production carries a non-null origin_rule (rules engine, email queue,
 * AI-disconnect cron, revision routing), so they are all excluded here and keep the 'automated' column
 * default without being rewritten. Reassignment tasks are the exception that has to be named: they
 * record the person who reassigned the deal, so they look hand-typed on every column, and they are
 * exactly the volume people are asking to filter away. They are excluded HERE rather than corrected in
 * a second pass so the backfill converges in ONE pass — setting them to 'manual' and putting them back
 * would rewrite every reassignment row twice to arrive where it started. Two markers identify them
 * together: the fixed title AND the assignedAt key their snapshot always carries; the title alone would
 * misfile a person's task worded the same way, and COALESCE keeps a NULL snapshot on the human side.
 *
 * Guarded on `source = 'automated'` so a row already classified correctly is never rewritten at all.
 */
export function buildClassifyStatement(schemaName: string): string {
  const schema = quoteIdentifier(validateOfficeSchemaName(schemaName));
  return `
    UPDATE ${schema}.tasks SET source = 'manual'
     WHERE origin_rule IS NULL
       AND created_by IS NOT NULL
       AND source = 'automated'
       AND NOT (
         title IN ('New Deal Assignment', 'New Lead Assignment')
         AND COALESCE(entity_snapshot ? 'assignedAt', false)
       )`;
}

/**
 * Repairs a reassignment task some earlier run left on 'manual' — a partially-applied backfill, or a
 * hand replay against a restored dump taken mid-flight. A converged schema matches nothing here, which
 * is the point: it is a repair, not part of the classification.
 */
export function buildRepairStatement(schemaName: string): string {
  const schema = quoteIdentifier(validateOfficeSchemaName(schemaName));
  return `
    UPDATE ${schema}.tasks SET source = 'automated'
     WHERE origin_rule IS NULL
       AND title IN ('New Deal Assignment', 'New Lead Assignment')
       AND entity_snapshot ? 'assignedAt'
       AND source <> 'automated'`;
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
      WHERE table_schema = $1 AND table_name = 'tasks' AND column_name = 'source'
    `,
    [schemaName]
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

/**
 * Classifies existing tasks per office, ONE TRANSACTION PER OFFICE.
 *
 * The DISABLE/ENABLE pair is deliberately unconditional rather than wrapped in an "if the trigger
 * exists" test. If a tenant schema somehow lacks these triggers the right outcome is a loud failure —
 * visible, and fully recoverable because that office's transaction rolls back having written nothing.
 * The alternative, skipping the disable and backfilling with set_tasks_updated_at live, is the
 * irreversible one. Given the choice between failing loudly and corrupting a metric silently, fail
 * loudly.
 */
export async function runTaskSourceBackfill(client: pg.Client): Promise<void> {
  const schemaResult = await client.query<{ schema_name: string }>(OFFICE_SCHEMA_DISCOVERY_SQL);

  let officesWithTasks = 0;
  let officesClassified = 0;

  for (const row of schemaResult.rows) {
    const schemaName = validateOfficeSchemaName(row.schema_name);
    const schema = quoteIdentifier(schemaName);

    if (await tenantHasTasks(client, schemaName)) officesWithTasks += 1;

    // A schema with no tasks table never received 0233's column either. Skip rather than raising on the
    // undefined column and taking every other office down with it. A schema that HAS tasks but not the
    // column is a partially-provisioned tenant, and is skipped for the same reason — but see the
    // ordering check after the loop, which catches the case where that is true of every office.
    if (!(await tenantIsReady(client, schemaName))) continue;
    officesClassified += 1;

    await client.query("BEGIN");
    try {
      for (const trigger of BACKFILL_SUSPENDED_TRIGGERS) {
        await client.query(`ALTER TABLE ${schema}.tasks DISABLE TRIGGER ${trigger}`);
      }

      await client.query(buildClassifyStatement(schemaName));
      await client.query(buildRepairStatement(schemaName));

      for (const trigger of [...BACKFILL_SUSPENDED_TRIGGERS].reverse()) {
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

  // ORDERING GUARD. This step must run AFTER 0233's file, which adds the column. Called before it, every
  // office would fail the tenantIsReady test, the loop would classify nothing, and the migration would
  // be recorded as applied — a silent no-op, which is precisely how the index pre-step's first-deploy
  // bug survived review. Tenants with a tasks table but no `source` are legitimate individually (a
  // partially-provisioned office); ALL of them being in that state is not.
  if (officesWithTasks > 0 && officesClassified === 0) {
    throw new Error(
      `task-source backfill ran before the column existed: ${officesWithTasks} office schema(s) have a ` +
        `tasks table and none has a "source" column. It must run AFTER 0233_task_source_classification.sql.`
    );
  }
}
