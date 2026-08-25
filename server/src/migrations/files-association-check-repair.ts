import type pg from "pg";
import { validateOfficeSchemaName } from "./per-office-step.js";

// This migration is deliberately split between this runner step (existing offices) and the SQL marker
// block (new offices). See migrations/0241_files_association_check_repair.sql for the schema invariant.
export const FILES_ASSOCIATION_CHECK_REPAIR_MIGRATION = "0241_files_association_check_repair.sql";

export const FILES_ASSOCIATION_CHECK_DISCOVERY_SQL = `
  SELECT n.nspname AS schema_name
  FROM pg_constraint c
  JOIN pg_class relation ON relation.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = relation.relnamespace
  WHERE c.conname = 'files_association_check'
    AND c.contype = 'c'
    AND relation.relname = 'files'
    AND relation.relkind IN ('r', 'p')
    AND n.nspname LIKE 'office\\_%' ESCAPE '\\'
  ORDER BY n.nspname
`;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** Exported for the migration test: the discovered schema name is validated before interpolation. */
export function buildDropFilesAssociationCheckStatement(schemaName: string): string {
  const safeSchemaName = quoteIdentifier(validateOfficeSchemaName(schemaName));
  return `ALTER TABLE ${safeSchemaName}.files DROP CONSTRAINT IF EXISTS files_association_check`;
}

/**
 * Drops the obsolete CHECK one office at a time.
 *
 * ALTER TABLE takes ACCESS EXCLUSIVE. Running it in a migration-file DO loop would retain the first
 * office's lock while later offices are reached; commit each short metadata operation before touching the
 * next office instead. The catalog query means already-correct offices take no table lock at all.
 */
export async function runFilesAssociationCheckRepair(client: pg.Client): Promise<void> {
  const schemaResult = await client.query<{ schema_name: string }>(FILES_ASSOCIATION_CHECK_DISCOVERY_SQL);

  for (const row of schemaResult.rows) {
    const statement = buildDropFilesAssociationCheckStatement(row.schema_name);
    await client.query("BEGIN");
    try {
      await client.query(statement);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }
}
