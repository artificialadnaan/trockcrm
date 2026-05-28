import type pg from "pg";

// Mirrors the audit-log performance migration pattern: pre-create the per-tenant
// unique index on audit_log CONCURRENTLY so the rest of the migration (which runs
// inside a DO block) doesn't block deal/audit writes during deployment.
export const PROJECT_NUMBER_FIRST_SET_MIGRATION =
  "0138_project_number_first_set_notification.sql";

export const OFFICE_SCHEMA_DISCOVERY_SQL = `
  SELECT schema_name
  FROM information_schema.schemata
  WHERE schema_name LIKE 'office\\_%' ESCAPE '\\'
  ORDER BY schema_name
`;

export const PROJECT_NUMBER_FIRST_SET_INDEX_NAME =
  "audit_log_project_number_first_set_uidx";

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function validateOfficeSchemaName(schemaName: string): string {
  if (!/^office_[a-z][a-z0-9_]*$/.test(schemaName)) {
    throw new Error(`Invalid office schema name: ${schemaName}`);
  }
  return schemaName;
}

export function buildProjectNumberFirstSetIndexStatement(schemaName: string): string {
  const safeSchemaName = quoteIdentifier(validateOfficeSchemaName(schemaName));
  return `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${PROJECT_NUMBER_FIRST_SET_INDEX_NAME}
      ON ${safeSchemaName}.audit_log (record_id)
      WHERE table_name = 'deals'
        AND actor_system_process = 'project_number_first_set'`;
}

async function getIndexValidity(
  client: pg.Client,
  schemaName: string
): Promise<boolean | null> {
  const result = await client.query<{ is_valid: boolean }>(
    `
      SELECT i.indisvalid AS is_valid
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2
    `,
    [schemaName, PROJECT_NUMBER_FIRST_SET_INDEX_NAME]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].is_valid;
}

export async function runProjectNumberFirstSetIndexMigration(client: pg.Client): Promise<void> {
  const schemaResult = await client.query<{ schema_name: string }>(OFFICE_SCHEMA_DISCOVERY_SQL);
  for (const row of schemaResult.rows) {
    const schemaName = validateOfficeSchemaName(row.schema_name);
    const safeSchemaName = quoteIdentifier(schemaName);
    const validity = await getIndexValidity(client, schemaName);

    if (validity === false) {
      // A prior CREATE INDEX CONCURRENTLY left an invalid stub; drop it before retrying.
      await client.query(
        `DROP INDEX CONCURRENTLY IF EXISTS ${safeSchemaName}.${PROJECT_NUMBER_FIRST_SET_INDEX_NAME}`
      );
    }

    await client.query(buildProjectNumberFirstSetIndexStatement(schemaName));
  }
}
