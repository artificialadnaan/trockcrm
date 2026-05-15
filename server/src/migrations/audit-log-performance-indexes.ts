import type pg from "pg";

export const AUDIT_LOG_PERFORMANCE_MIGRATION = "0120_audit_log_dedup_partial_index.sql";
export const OFFICE_SCHEMA_DISCOVERY_SQL = `
  SELECT schema_name
  FROM information_schema.schemata
  WHERE schema_name LIKE 'office\\_%' ESCAPE '\\'
  ORDER BY schema_name
`;

export const AUDIT_LOG_INDEX_SPECS = [
  {
    name: "audit_log_dedup_rich_lookup_idx",
    createSql: (safeSchemaName: string) => `CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_dedup_rich_lookup_idx
      ON ${safeSchemaName}.audit_log (table_name, record_id, action, created_at DESC)
      WHERE actor_system_process IS NOT NULL
         OR actor_name IS NOT NULL
         OR entity_name_snapshot IS NOT NULL
         OR field_changes_jsonb IS NOT NULL`,
  },
  {
    name: "audit_log_actor_system_process_created_at_idx",
    createSql: (safeSchemaName: string) => `CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_actor_system_process_created_at_idx
      ON ${safeSchemaName}.audit_log (actor_system_process, created_at DESC)
      WHERE actor_system_process IS NOT NULL`,
  },
  {
    name: "audit_log_entity_or_table_created_at_idx",
    createSql: (safeSchemaName: string) => `CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_entity_or_table_created_at_idx
      ON ${safeSchemaName}.audit_log ((COALESCE(entity_type, table_name)), created_at DESC)`,
  },
] as const;

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

  return AUDIT_LOG_INDEX_SPECS.flatMap((spec) => [
    `DROP INDEX CONCURRENTLY IF EXISTS ${safeSchemaName}.${spec.name}`,
    spec.createSql(safeSchemaName),
  ]);
}

async function getAuditLogIndexValidity(
  client: pg.Client,
  schemaName: string
): Promise<Map<string, boolean>> {
  const result = await client.query<{ index_name: string; is_valid: boolean }>(
    `
      SELECT c.relname AS index_name, i.indisvalid AS is_valid
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = ANY($2::text[])
    `,
    [schemaName, AUDIT_LOG_INDEX_SPECS.map((spec) => spec.name)]
  );

  return new Map(result.rows.map((row) => [row.index_name, row.is_valid]));
}

export async function runAuditLogPerformanceIndexMigration(client: pg.Client): Promise<void> {
  const schemaResult = await client.query<{ schema_name: string }>(OFFICE_SCHEMA_DISCOVERY_SQL);
  for (const row of schemaResult.rows) {
    const safeSchemaName = quoteIdentifier(validateOfficeSchemaName(row.schema_name));
    const validityByIndex = await getAuditLogIndexValidity(client, row.schema_name);

    for (const spec of AUDIT_LOG_INDEX_SPECS) {
      if (validityByIndex.get(spec.name) === false) {
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${safeSchemaName}.${spec.name}`);
      }
      await client.query(spec.createSql(safeSchemaName));
    }
  }
}
