import type pg from "pg";

// Mirrors the project-number / audit-log / bid-board index-migration pattern.
//
// Migration 0221 adds a (created_at, to_stage_id) index to EVERY existing office's deal_stage_history —
// a table that grows with every stage move and is written on the deal hot path. A plain CREATE INDEX
// inside the file's DO block takes a write-blocking SHARE lock, and because the whole loop is one
// statement those locks are all held until the last tenant's index finishes: stage transitions across
// every office would queue behind it and start failing on the app's 30/45s timeouts.
//
// CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so the runner intercepts 0221 and
// builds each tenant's index here first, one statement at a time. The file's plain
// `CREATE INDEX IF NOT EXISTS` then no-ops on existing tenants, while still serving as the marker the
// office provisioner replays for schemas created after this deploy.
export const DEAL_STAGE_HISTORY_CREATED_AT_MIGRATION =
  "0221_deal_stage_history_created_at_index.sql";

export const DEAL_STAGE_HISTORY_CREATED_AT_INDEX_NAME = "deal_stage_history_created_at_idx";

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

/** Kept in lockstep with the plain CREATE INDEX in 0221, which no-ops once this has built it. */
export function buildDealStageHistoryCreatedAtIndexStatement(schemaName: string): string {
  const safeSchemaName = quoteIdentifier(validateOfficeSchemaName(schemaName));
  return `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${DEAL_STAGE_HISTORY_CREATED_AT_INDEX_NAME}
      ON ${safeSchemaName}.deal_stage_history (created_at, to_stage_id)`;
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
    [schemaName, DEAL_STAGE_HISTORY_CREATED_AT_INDEX_NAME]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].is_valid;
}

export async function runDealStageHistoryCreatedAtIndexMigration(client: pg.Client): Promise<void> {
  const schemaResult = await client.query<{ schema_name: string }>(OFFICE_SCHEMA_DISCOVERY_SQL);
  for (const row of schemaResult.rows) {
    const schemaName = validateOfficeSchemaName(row.schema_name);
    const safeSchemaName = quoteIdentifier(schemaName);
    const validity = await getIndexValidity(client, schemaName);

    if (validity === false) {
      // An interrupted CONCURRENTLY build leaves an INVALID stub, which IF NOT EXISTS would then skip
      // forever — the index would exist, never be used, and nothing would say so. Drop before retrying.
      await client.query(
        `DROP INDEX CONCURRENTLY IF EXISTS ${safeSchemaName}.${DEAL_STAGE_HISTORY_CREATED_AT_INDEX_NAME}`
      );
    }

    await client.query(buildDealStageHistoryCreatedAtIndexStatement(schemaName));
  }
}
