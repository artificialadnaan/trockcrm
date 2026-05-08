import "dotenv/config";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import {
  assertSafeIdentifier,
  assertWriteAllowed,
  getTenantSchemas,
  printDbTarget,
} from "../../scripts/lib/db-safety.js";

type CsvRow = Record<string, string>;

const IMPORT_DIR = "migration-snapshot/import-ready";
const TABLE_FILES = [
  { table: "companies", file: "companies.csv", conflictColumn: "id" },
  { table: "contacts", file: "contacts.csv", conflictColumn: "id" },
  { table: "deals", file: "deals.csv", conflictColumn: "id" },
  { table: "leads", file: "leads.csv", conflictColumn: "id" },
  { table: "activities", file: "engagements.csv", conflictColumn: "id" },
] as const;

const ADMIN_USER_ID = "1cc88c3f-a5f9-5f97-857c-73d97ac0762e";
const USER_FK_COLUMNS = new Set(["assigned_rep_id", "sales_rep_id", "responsible_user_id", "performed_by_user_id"]);

const JSON_COLUMNS = new Set([
  "source_refs",
  "hubspot_extra_properties",
  "qualification_payload",
  "project_type_question_payload",
]);

const UUID_COLUMNS = new Set([
  "id",
  "stage_id",
  "assigned_rep_id",
  "sales_rep_id",
  "primary_contact_id",
  "company_id",
  "property_id",
  "responsible_user_id",
  "performed_by_user_id",
  "source_entity_id",
  "lead_id",
  "deal_id",
  "contact_id",
  "email_id",
  "assigned_approver_user_id",
]);

const NUMERIC_COLUMNS = new Set([
  "dd_estimate",
  "bid_estimate",
  "awarded_amount",
  "pre_qual_value",
  "touchpoint_count",
  "duration_minutes",
]);

const BOOLEAN_COLUMNS = new Set([
  "is_active",
  "is_test_data",
  "first_outreach_completed",
]);

const STATE_ABBREVIATIONS: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  illinois: "IL",
  indiana: "IN",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  nebraska: "NE",
  nevada: "NV",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  ohio: "OH",
  oklahoma: "OK",
  pennsylvania: "PA",
  "south carolina": "SC",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  virginia: "VA",
  washington: "WA",
};

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\"") {
      if (quoted && next === "\"") {
        cell += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  const [headers, ...dataRows] = rows;
  if (!headers) return [];
  return dataRows.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function readRows(file: string, limit: number | null) {
  const rows = parseCsv(await readFile(join(IMPORT_DIR, file), "utf8"));
  return limit === null ? rows : rows.slice(0, limit);
}

async function getColumns(client: pg.Client, schema: string, table: string) {
  const result = await client.query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `,
    [schema, table],
  );
  return new Set(result.rows.map((row) => row.column_name));
}

async function getColumnCharacterLimits(client: pg.Client, schema: string, table: string) {
  const result = await client.query<{ column_name: string; character_maximum_length: number | null }>(
    `
      SELECT column_name, character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
        AND character_maximum_length IS NOT NULL
      ORDER BY ordinal_position
    `,
    [schema, table],
  );
  return new Map(
    result.rows
      .filter((row) => row.character_maximum_length !== null)
      .map((row) => [row.column_name, Number(row.character_maximum_length)]),
  );
}

async function stageSlugMap(client: pg.Client) {
  const result = await client.query<{ slug: string; id: string }>(
    `
      SELECT slug, id
      FROM public.pipeline_stage_config
      WHERE is_active_pipeline = true
    `,
  );
  return new Map(result.rows.map((row) => [row.slug, row.id]));
}

async function userIdSet(client: pg.Client) {
  const result = await client.query<{ id: string }>("SELECT id FROM public.users");
  return new Set(result.rows.map((row) => row.id));
}

function normalizeUserForeignKey(value: string | undefined, validUserIds: Set<string>, fallback: string | null) {
  if (!value) return fallback ?? "";
  return validUserIds.has(value) ? value : fallback ?? "";
}

function normalizeUserForeignKeyValue(value: string | undefined, validUserIds: Set<string>, fallback: string | null) {
  const normalized = normalizeUserForeignKey(value, validUserIds, fallback);
  return normalized === "" ? null : normalized;
}

function normalizeValue(column: string, value: string, stages: Map<string, string>, characterLimit?: number) {
  if (value === "") return null;
  if (column === "state" || column === "property_state") {
    const normalized = STATE_ABBREVIATIONS[value.trim().toLowerCase()] ?? value.trim().toUpperCase();
    return normalized.slice(0, 2);
  }
  if (column === "zip" || column === "property_zip") return value.slice(0, 10);
  if (column === "phone" || column === "mobile" || column === "normalized_phone") return value.slice(0, 20);
  if (column === "stage_id" && !isUuid(value)) {
    const stageId = stages.get(value);
    if (!stageId) throw new Error(`No CRM stage UUID found for slug ${value}`);
    return stageId;
  }
  if (JSON_COLUMNS.has(column)) return JSON.parse(value);
  if (BOOLEAN_COLUMNS.has(column)) return value === "true";
  if (NUMERIC_COLUMNS.has(column)) return value;
  if (UUID_COLUMNS.has(column) && !isUuid(value)) {
    throw new Error(`Column ${column} expected UUID, received ${value}`);
  }
  return characterLimit ? value.slice(0, characterLimit) : value;
}

function stablePropertyId(recordId: string) {
  // The CSV generator creates stable UUIDs for records. Reusing a deterministic
  // namespace keeps placeholder properties idempotent without another source file.
  return recordId.replace(/^(.{8})-/, "11111111-");
}

async function assertEmptyTargets(client: pg.Client, schema: string, allowExisting: boolean) {
  const counts: Record<string, number> = {};
  for (const { table } of TABLE_FILES) {
    assertSafeIdentifier(table, "table");
    const result = await client.query<{ count: string }>(`SELECT count(*)::int AS count FROM ${schema}.${table}`);
    counts[table] = Number(result.rows[0]?.count ?? 0);
  }
  const nonEmpty = Object.entries(counts).filter(([, count]) => count > 0);
  if (nonEmpty.length > 0 && !allowExisting) {
    throw new Error(
      `Refusing import because target tables already contain records: ${JSON.stringify(counts)}. Use --already-seeded only after verifying this is intentional.`,
    );
  }
  return counts;
}

async function insertRows(
  client: pg.Client,
  schema: string,
  table: string,
  rows: CsvRow[],
  stages: Map<string, string>,
  validUserIds: Set<string>,
) {
  const existingColumns = await getColumns(client, schema, table);
  const characterLimits = await getColumnCharacterLimits(client, schema, table);
  const headers = Object.keys(rows[0] ?? {}).filter((column) => existingColumns.has(column));
  const missing = Object.keys(rows[0] ?? {}).filter((column) => !existingColumns.has(column));
  if (missing.length > 0) {
    throw new Error(`${schema}.${table} is missing import columns: ${missing.join(", ")}`);
  }
  if (headers.length === 0) return 0;

  for (const row of rows) {
    if (table === "leads") {
      row.assigned_rep_id = normalizeUserForeignKey(row.assigned_rep_id, validUserIds, ADMIN_USER_ID);
      row.sales_rep_id = normalizeUserForeignKey(row.sales_rep_id, validUserIds, row.assigned_rep_id);
    }
    if (table === "deals") {
      row.assigned_rep_id = normalizeUserForeignKey(row.assigned_rep_id, validUserIds, null);
    }
    if (table === "activities") {
      row.responsible_user_id = normalizeUserForeignKey(row.responsible_user_id, validUserIds, ADMIN_USER_ID);
      row.performed_by_user_id = normalizeUserForeignKey(row.performed_by_user_id, validUserIds, row.responsible_user_id);
      if (!row.source_entity_id) {
        row.source_entity_id = row.deal_id || row.lead_id || row.contact_id || row.company_id || row.responsible_user_id || ADMIN_USER_ID;
      }
      if (!row.source_entity_type && row.source_entity_id === row.responsible_user_id) row.source_entity_type = "contact";
    }
    const values = headers.map((column) => {
      const value = row[column] ?? "";
      if (USER_FK_COLUMNS.has(column)) {
        const fallback = column === "assigned_rep_id" && table === "deals" ? null : ADMIN_USER_ID;
        return normalizeUserForeignKeyValue(value, validUserIds, fallback);
      }
      return normalizeValue(column, value, stages, characterLimits.get(column));
    });
    const placeholders = headers.map((_, index) => `$${index + 1}`).join(", ");
    const quotedColumns = headers.map((column) => `"${assertSafeIdentifier(column, "column")}"`).join(", ");
    const updates = headers
      .filter((column) => column !== "id")
      .map((column) => `"${column}" = EXCLUDED."${column}"`)
      .join(", ");
    try {
      await client.query(
        `
          INSERT INTO ${schema}.${assertSafeIdentifier(table, "table")} (${quotedColumns})
          VALUES (${placeholders})
          ON CONFLICT (id) DO UPDATE SET ${updates}
        `,
        values,
      );
    } catch (error) {
      const sourceRef = row.source_ref || row.hubspot_deal_id || row.hubspot_owner_id || row.id || "unknown";
      throw new Error(`Failed importing ${schema}.${table} row ${sourceRef}: ${(error as Error).message}`);
    }
  }
  return rows.length;
}

async function ensurePlaceholderProperties(client: pg.Client, schema: string, rows: CsvRow[]) {
  const leadAndDealRows = rows.filter((row) => row.company_id && !row.property_id);
  for (const row of leadAndDealRows) {
    const propertyId = stablePropertyId(row.id);
    row.property_id = propertyId;
    await client.query(
      `
        INSERT INTO ${schema}.properties (
          id, company_id, name, address, city, state, zip, notes, is_test_data, is_active
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, true)
        ON CONFLICT (id) DO UPDATE
        SET
          company_id = EXCLUDED.company_id,
          name = EXCLUDED.name,
          address = EXCLUDED.address,
          city = EXCLUDED.city,
          state = EXCLUDED.state,
          zip = EXCLUDED.zip,
          notes = EXCLUDED.notes
      `,
      [
        propertyId,
        row.company_id,
        row.name ? `${row.name} Property`.slice(0, 500) : "HubSpot Migration Property",
        row.property_address ? row.property_address.slice(0, 500) : null,
        row.property_city ? row.property_city.slice(0, 255) : null,
        row.property_state
          ? (STATE_ABBREVIATIONS[row.property_state.trim().toLowerCase()] ?? row.property_state.trim().toUpperCase()).slice(0, 2)
          : null,
        row.property_zip ? row.property_zip.slice(0, 10) : null,
        "Placeholder property generated for HubSpot migration because leads require property_id.",
      ],
    );
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const dryRun = process.argv.includes("--dry-run");
  const alreadySeeded = process.argv.includes("--already-seeded");
  const confirmProduction = process.argv.includes("--confirm-production");
  const tenantArg = process.argv.find((arg) => arg.startsWith("--tenant="));
  const targetTenant = tenantArg?.split("=")[1] ?? "office_dallas";
  const smokeLimitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = smokeLimitArg ? Number(smokeLimitArg.split("=")[1]) : null;
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) throw new Error("--limit must be a positive integer");

  if (dryRun) {
    printDbTarget(databaseUrl, "cleanup:import:dry-run");
  } else {
    assertWriteAllowed(databaseUrl, process.argv, "cleanup:import");
  }
  if (!confirmProduction && describeProductionMessage(databaseUrl)) {
    // assertWriteAllowed handles write mode. Dry-run still prints context but is allowed.
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const tenantSchemas = await getTenantSchemas(client);
    if (!tenantSchemas.includes(targetTenant)) {
      throw new Error(`Target tenant ${targetTenant} not found. Available tenant schemas: ${tenantSchemas.join(", ")}`);
    }
    const schema = assertSafeIdentifier(targetTenant, "tenant schema");

    const existingCounts = await assertEmptyTargets(client, schema, alreadySeeded || dryRun);
    const stages = await stageSlugMap(client);
    const validUserIds = await userIdSet(client);

    await client.query("BEGIN");
    const inserted: Record<string, number> = {};
    for (const { table, file } of TABLE_FILES) {
      const rows = await readRows(file, limit && (table === "companies" || table === "contacts") ? null : limit);
      if (table === "deals" || table === "leads") {
        await ensurePlaceholderProperties(client, schema, rows);
      }
      inserted[table] = await insertRows(client, schema, table, rows, stages, validUserIds);
    }
    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }
    console.log(
      JSON.stringify(
        {
          dryRun,
          schema,
          limit,
          existingCounts,
          inserted,
          committed: !dryRun,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

function describeProductionMessage(databaseUrl: string) {
  return /railway|rlwy\.net|proxy\.rlwy\.net/i.test(new URL(databaseUrl).hostname);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
