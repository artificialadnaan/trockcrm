import type pg from "pg";

// A REUSABLE MIGRATION STEP THAT TAKES ONE TRANSACTION PER OFFICE.
//
// ── THE RULE THIS EXISTS TO ENFORCE ────────────────────────────────────────────────────────────────
//   NOTHING THAT TAKES A LOCK ON A TENANT TABLE MAY RUN INSIDE A MIGRATION FILE'S SINGLE TRANSACTION
//   ACROSS EVERY OFFICE.
//
// runner.ts sends each .sql file as ONE client.query(sql), which Postgres runs as one implicit
// transaction. A `DO` block looping every office_% schema therefore holds every lock it takes until the
// LAST office finishes — so a statement that conflicts with writes blocks them progressively across all
// tenants, on API boot, for as long as the whole migration takes. Per-tenant transactions are NOT
// expressible inside a migration file, so this cannot be fixed by rearranging SQL. The work has to move
// out of the file, and once out it has to commit per office or it has merely relocated the problem.
//
// Statements that trip this: `ALTER TABLE ... DISABLE/ENABLE TRIGGER`, any sizeable `UPDATE`, and
// `CREATE INDEX` (including `IF NOT EXISTS`, which opens the table with a write-conflicting SHARE lock
// BEFORE it evaluates the condition). What is safe to leave in the file: `ADD COLUMN` with a constant
// default, which is metadata-only in PG11+, and `ADD CONSTRAINT ... CHECK` guarded on pg_constraint.
//
// ── HOW TO USE IT ──────────────────────────────────────────────────────────────────────────────────
// Define the step, then dispatch on it in runner.ts AFTER executing the migration file that adds
// whatever `requiredColumn` names:
//
//   const MY_STEP = {
//     label: "widget kinds",
//     table: "widgets",
//     requiredColumn: "kind",
//     suspendTriggers: ["set_widgets_updated_at"],
//     buildStatements: (schema) => [`UPDATE ${schema}.widgets SET kind = 'derived' WHERE kind IS NULL`],
//   };
//   // in runner.ts:
//   const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
//   await client.query(sql);                              // adds the column
//   await runPerOfficeTransactionalStep(client, MY_STEP);  // then the locking work, per office
//
// `buildStatements` receives the schema name ALREADY validated and quoted, so interpolating it is safe;
// nothing else from the database is interpolated anywhere in this file.
//
// Index builds are the one case this does NOT cover: `CREATE INDEX CONCURRENTLY` cannot run inside a
// transaction at all, so it needs the sibling pattern in task-source-index.ts (no BEGIN/COMMIT, one
// statement per office, plus an INVALID-stub retry). Use that for indexes and this for everything else.

export const OFFICE_SCHEMA_DISCOVERY_SQL = `
  SELECT schema_name
  FROM information_schema.schemata
  WHERE schema_name LIKE 'office\\_%' ESCAPE '\\'
  ORDER BY schema_name
`;

export interface PerOfficeStep {
  /** Named in error messages so a failure says which migration's step it was. */
  label: string;
  /** Tenant table the step operates on, e.g. "tasks". */
  table: string;
  /**
   * Column whose presence means the migration file has already run for this office. An office missing
   * it is skipped; EVERY office missing it is the ordering error below.
   */
  requiredColumn: string;
  /**
   * Columns this step reads but which do not establish its migration ordering. An office that has
   * `requiredColumn` but lacks any capability column is deliberately skipped before a transaction is
   * opened. This is for legacy schema variation: it must not turn a safe compatibility skip into the
   * "migration ran too early" error reserved for a missing `requiredColumn`.
   */
  capabilityColumns?: readonly string[];
  /**
   * Triggers suspended for the duration of each office's transaction, in this order (they are restored
   * in reverse). Suspension is transactional, so a failure rolls it back with everything else.
   *
   * Unconditional by design — not wrapped in an "if the trigger exists" test. A schema missing one
   * should fail loudly, having written nothing, rather than quietly running the work with the trigger
   * live. When the trigger is what protects a derived metric, silent success is the irreversible
   * outcome and a loud failure is the recoverable one.
   */
  suspendTriggers?: readonly string[];
  /**
   * Omit an office schema that has already received this migration's provisioner-only shape.
   *
   * This is evaluated after the schema name has been validated but before the readiness counters or
   * a tenant-table lock. It lets a migration keep a durable cutover boundary without making a new
   * office look like a partially applied historical office on a retry.
   */
  skipSchema?: (schemaName: string) => boolean;
  /** Statements run inside each office's transaction. `schema` is already validated and quoted. */
  buildStatements: (schema: string) => readonly string[];
}

export interface PerOfficeStepResult {
  officesWithTable: number;
  officesProcessed: number;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function validateOfficeSchemaName(schemaName: string): string {
  if (!/^office_[a-z][a-z0-9_]*$/.test(schemaName)) {
    throw new Error(`Invalid office schema name: ${schemaName}`);
  }
  return schemaName;
}

async function countMatching(
  client: pg.Client,
  sql: string,
  params: unknown[]
): Promise<number> {
  const result = await client.query<{ n: number }>(sql, params);
  return Number(result.rows[0]?.n ?? 0);
}

const TABLE_EXISTS_SQL = `
  SELECT COUNT(*)::int AS n
  FROM information_schema.tables
  WHERE table_schema = $1 AND table_name = $2
`;

const COLUMN_EXISTS_SQL = `
  SELECT COUNT(*)::int AS n
  FROM information_schema.columns
  WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
`;

/**
 * Runs `step` against every office_% schema, each in its OWN transaction, committing before moving on.
 *
 * Returns the counts rather than nothing so a caller (or a test) can distinguish an office that lacks the
 * table from one intentionally skipped for a missing compatibility capability.
 */
export async function runPerOfficeTransactionalStep(
  client: pg.Client,
  step: PerOfficeStep
): Promise<PerOfficeStepResult> {
  const schemaResult = await client.query<{ schema_name: string }>(OFFICE_SCHEMA_DISCOVERY_SQL);

  let officesWithTable = 0;
  let officesWithRequiredColumn = 0;
  let officesProcessed = 0;

  for (const row of schemaResult.rows) {
    const schemaName = validateOfficeSchemaName(row.schema_name);
    if (step.skipSchema?.(schemaName)) continue;
    const schema = quoteIdentifier(schemaName);

    if ((await countMatching(client, TABLE_EXISTS_SQL, [schemaName, step.table])) === 0) continue;
    officesWithTable += 1;

    // An office with the table but not the column is a partially-provisioned tenant: skip it rather
    // than raising on the undefined column and taking every other office down with it. The guard after
    // the loop catches the case where that is true of ALL of them.
    const ready = await countMatching(client, COLUMN_EXISTS_SQL, [
      schemaName,
      step.table,
      step.requiredColumn,
    ]);
    if (ready === 0) continue;
    officesWithRequiredColumn += 1;

    // Capability columns are deliberately distinct from `requiredColumn`: their absence is a known
    // legacy shape, so skip it before opening a transaction or taking trigger locks. The ordering guard
    // below still keys only on `requiredColumn`, which is what the migration file actually adds.
    let capable = true;
    for (const column of step.capabilityColumns ?? []) {
      if ((await countMatching(client, COLUMN_EXISTS_SQL, [schemaName, step.table, column])) === 0) {
        capable = false;
        break;
      }
    }
    if (!capable) continue;
    officesProcessed += 1;

    await client.query("BEGIN");
    try {
      for (const trigger of step.suspendTriggers ?? []) {
        await client.query(`ALTER TABLE ${schema}.${step.table} DISABLE TRIGGER ${trigger}`);
      }

      for (const statement of step.buildStatements(schema)) {
        await client.query(statement);
      }

      for (const trigger of [...(step.suspendTriggers ?? [])].reverse()) {
        await client.query(`ALTER TABLE ${schema}.${step.table} ENABLE TRIGGER ${trigger}`);
      }

      // Releases this office's locks before the next office is touched. This single line is the whole
      // reason the work is not a DO block in the migration file.
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }

  // ORDERING GUARD. This step must run AFTER the migration file that adds `requiredColumn`. Called
  // before it, every office fails the readiness test, the loop does nothing, and the migration is
  // recorded as applied — a silent no-op. That is precisely how the first-deploy bug in the concurrent
  // index pre-step survived review, so this refuses instead of returning quietly.
  if (officesWithTable > 0 && officesWithRequiredColumn === 0) {
    throw new Error(
      `${step.label}: ran before the required column existed — ${officesWithTable} office schema(s) ` +
        `have a "${step.table}" table and none has a "${step.requiredColumn}" column. This step must ` +
        `run AFTER the migration that adds it.`
    );
  }

  return { officesWithTable, officesProcessed };
}
