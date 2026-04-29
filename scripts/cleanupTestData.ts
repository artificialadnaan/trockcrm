import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

export const TEST_DATA_MARKER = "[TEST DATA]";
const MARKER_LIKE = `${TEST_DATA_MARKER}%`;

type CleanupRow = Record<string, unknown> & { table?: string; id?: string };

export function isMarkedTestDataRow(row: Record<string, unknown>): boolean {
  if (row.is_test_data === true || row.isTestData === true) return true;
  for (const key of ["description", "notes", "title"]) {
    const value = row[key];
    if (typeof value === "string" && value.startsWith(TEST_DATA_MARKER)) return true;
  }
  return false;
}

export function summarizeCleanupRows(rows: CleanupRow[]) {
  const marked = rows.filter(isMarkedTestDataRow);
  const byTable: Record<string, number> = {};
  const ids: string[] = [];
  for (const row of marked) {
    const table = String(row.table ?? "unknown");
    byTable[table] = (byTable[table] ?? 0) + 1;
    if (row.id) ids.push(String(row.id));
  }
  return { total: marked.length, byTable, ids };
}

function connectionString(): string {
  const publicUrl = process.env.DATABASE_PUBLIC_URL?.trim();
  const privateUrl = process.env.DATABASE_URL?.trim();
  const selected = publicUrl || privateUrl;
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  if (!publicUrl && /railway\.internal/.test(selected)) {
    throw new Error("DATABASE_URL points at railway.internal. Export DATABASE_PUBLIC_URL in .env and retry.");
  }
  return selected;
}

function validateSchemaName(schemaName: string) {
  if (!/^office_[a-z0-9_]+$/.test(schemaName)) throw new Error(`Invalid schema name ${schemaName}`);
  return schemaName;
}

async function tenantSchemas(client: pg.Client): Promise<string[]> {
  const result = await client.query(`
    SELECT nspname
      FROM pg_namespace
     WHERE nspname LIKE 'office\\_%' ESCAPE '\\'
     ORDER BY nspname
  `);
  return result.rows.map((row) => validateSchemaName(row.nspname));
}

async function tableExists(client: pg.Client, schemaName: string, tableName: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    [schemaName, tableName]
  );
  return result.rowCount > 0;
}

async function columnExists(client: pg.Client, schemaName: string, tableName: string, columnName: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [schemaName, tableName, columnName]
  );
  return result.rowCount > 0;
}

async function selectMarked(client: pg.Client, schemaName: string, tableName: string, textColumn: string, label: string) {
  if (!(await tableExists(client, schemaName, tableName))) return [];
  const hasFlag = await columnExists(client, schemaName, tableName, "is_test_data");
  const flagPredicate = hasFlag ? `COALESCE(is_test_data, false) = true OR ` : "";
  const result = await client.query(
    `SELECT $1::text AS table, id::text, ${textColumn}::text AS ${label}, COALESCE(is_test_data, false) AS is_test_data
       FROM ${schemaName}.${tableName}
      WHERE ${flagPredicate}${textColumn} ILIKE $2`,
    [`${schemaName}.${tableName}`, MARKER_LIKE]
  );
  return result.rows;
}

async function deleteReturning(client: pg.Client, sqlText: string, params: unknown[], table: string) {
  const result = await client.query(sqlText, params);
  return result.rows.map((row) => ({ table, ...row }));
}

export async function collectMarkedTestData(client: pg.Client, schemaName: string): Promise<CleanupRow[]> {
  const rows: CleanupRow[] = [];
  rows.push(...await selectMarked(client, schemaName, "tasks", "title", "title"));
  rows.push(...await selectMarked(client, schemaName, "leads", "description", "description"));
  rows.push(...await selectMarked(client, schemaName, "deals", "description", "description"));
  rows.push(...await selectMarked(client, schemaName, "contacts", "notes", "notes"));
  rows.push(...await selectMarked(client, schemaName, "properties", "notes", "notes"));
  rows.push(...await selectMarked(client, schemaName, "companies", "notes", "notes"));
  return rows;
}

export async function cleanupMarkedTestDataInSchema(client: pg.Client, schemaName: string, apply: boolean): Promise<CleanupRow[]> {
  const markedRows = await collectMarkedTestData(client, schemaName);
  if (!apply) return markedRows.filter(isMarkedTestDataRow);

  const deleted: CleanupRow[] = [];
  await client.query("BEGIN");
  try {
    if (await tableExists(client, schemaName, "contact_deal_associations")) {
      deleted.push(...await deleteReturning(client, `
        DELETE FROM ${schemaName}.contact_deal_associations cda
        USING ${schemaName}.contacts c, ${schemaName}.deals d
        WHERE cda.contact_id = c.id
          AND cda.deal_id = d.id
          AND (COALESCE(c.is_test_data, false) = true OR COALESCE(d.is_test_data, false) = true)
        RETURNING cda.id::text, true AS is_test_data
      `, [], `${schemaName}.contact_deal_associations`));
    }

    if (await tableExists(client, schemaName, "lead_stage_history")) {
      deleted.push(...await deleteReturning(client, `
        DELETE FROM ${schemaName}.lead_stage_history lsh
        USING ${schemaName}.leads l
        WHERE lsh.lead_id = l.id AND COALESCE(l.is_test_data, false) = true
        RETURNING lsh.id::text, true AS is_test_data
      `, [], `${schemaName}.lead_stage_history`));
    }

    if (await tableExists(client, schemaName, "deal_stage_history")) {
      deleted.push(...await deleteReturning(client, `
        DELETE FROM ${schemaName}.deal_stage_history dsh
        USING ${schemaName}.deals d
        WHERE dsh.deal_id = d.id AND COALESCE(d.is_test_data, false) = true
        RETURNING dsh.id::text, true AS is_test_data
      `, [], `${schemaName}.deal_stage_history`));
    }

    if (await tableExists(client, schemaName, "deal_approvals")) {
      deleted.push(...await deleteReturning(client, `
        DELETE FROM ${schemaName}.deal_approvals da
        USING ${schemaName}.deals d
        WHERE da.deal_id = d.id AND COALESCE(d.is_test_data, false) = true
        RETURNING da.id::text, true AS is_test_data
      `, [], `${schemaName}.deal_approvals`));
    }

    deleted.push(...await deleteReturning(client, `
      DELETE FROM ${schemaName}.tasks
      WHERE COALESCE(is_test_data, false) = true OR title ILIKE $1 OR description ILIKE $1
      RETURNING id::text, title, description, COALESCE(is_test_data, false) AS is_test_data
    `, [MARKER_LIKE], `${schemaName}.tasks`));

    deleted.push(...await deleteReturning(client, `
      DELETE FROM ${schemaName}.leads
      WHERE COALESCE(is_test_data, false) = true OR description ILIKE $1
      RETURNING id::text, description, COALESCE(is_test_data, false) AS is_test_data
    `, [MARKER_LIKE], `${schemaName}.leads`));

    deleted.push(...await deleteReturning(client, `
      DELETE FROM ${schemaName}.deals
      WHERE COALESCE(is_test_data, false) = true OR description ILIKE $1
      RETURNING id::text, description, COALESCE(is_test_data, false) AS is_test_data
    `, [MARKER_LIKE], `${schemaName}.deals`));

    deleted.push(...await deleteReturning(client, `
      DELETE FROM ${schemaName}.contacts
      WHERE COALESCE(is_test_data, false) = true OR notes ILIKE $1
      RETURNING id::text, notes, COALESCE(is_test_data, false) AS is_test_data
    `, [MARKER_LIKE], `${schemaName}.contacts`));

    deleted.push(...await deleteReturning(client, `
      DELETE FROM ${schemaName}.properties
      WHERE COALESCE(is_test_data, false) = true OR notes ILIKE $1
      RETURNING id::text, notes, COALESCE(is_test_data, false) AS is_test_data
    `, [MARKER_LIKE], `${schemaName}.properties`));

    deleted.push(...await deleteReturning(client, `
      DELETE FROM ${schemaName}.companies
      WHERE COALESCE(is_test_data, false) = true OR notes ILIKE $1
      RETURNING id::text, notes, COALESCE(is_test_data, false) AS is_test_data
    `, [MARKER_LIKE], `${schemaName}.companies`));

    await client.query("COMMIT");
    return deleted.filter(isMarkedTestDataRow);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    const rows: CleanupRow[] = [];
    for (const schemaName of await tenantSchemas(client)) {
      rows.push(...await cleanupMarkedTestDataInSchema(client, schemaName, apply));
    }
    const summary = summarizeCleanupRows(rows);
    console.log(`${apply ? "APPLY" : "DRY-RUN"} TEST DATA CLEANUP`);
    console.log(`total=${summary.total}`);
    for (const [table, count] of Object.entries(summary.byTable).sort()) {
      console.log(`${table}: ${count}`);
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
