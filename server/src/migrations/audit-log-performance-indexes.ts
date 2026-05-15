import type pg from "pg";

export const AUDIT_LOG_PERFORMANCE_MIGRATION = "0120_audit_log_dedup_partial_index.sql";
export const OFFICE_SCHEMA_DISCOVERY_SQL = `
  SELECT schema_name
  FROM information_schema.schemata
  WHERE schema_name LIKE 'office\\_%' ESCAPE '\\'
  ORDER BY schema_name
`;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function validateOfficeSchemaName(schemaName: string): string {
  if (!/^office_[a-z][a-z0-9_]*$/.test(schemaName)) {
    throw new Error(`Invalid office schema name: ${schemaName}`);
  }
  return schemaName;
}

export function buildAuditLogPerformanceIndexStatements(schemaName: string): string[] {
  const safeSchemaName = quoteIdentifier(validateOfficeSchemaName(schemaName));

  return [
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_dedup_rich_lookup_idx
      ON ${safeSchemaName}.audit_log (table_name, record_id, action, created_at DESC)
      WHERE actor_system_process IS NOT NULL
         OR actor_name IS NOT NULL
         OR entity_name_snapshot IS NOT NULL
         OR field_changes_jsonb IS NOT NULL`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_actor_system_process_created_at_idx
      ON ${safeSchemaName}.audit_log (actor_system_process, created_at DESC)
      WHERE actor_system_process IS NOT NULL`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_entity_or_table_created_at_idx
      ON ${safeSchemaName}.audit_log ((COALESCE(entity_type, table_name)), created_at DESC)`,
  ];
}

export async function runAuditLogPerformanceIndexMigration(client: pg.Client): Promise<void> {
  const schemaResult = await client.query<{ schema_name: string }>(OFFICE_SCHEMA_DISCOVERY_SQL);
  for (const row of schemaResult.rows) {
    for (const statement of buildAuditLogPerformanceIndexStatements(row.schema_name)) {
      await client.query(statement);
    }
  }
}
