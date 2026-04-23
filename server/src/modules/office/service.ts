import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { eq } from "drizzle-orm";
import { db, pool } from "../../db.js";
import { offices } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { getOfficeTimezone } from "../../lib/office-timezone.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Defense-in-depth validator for schema names used in dynamic SQL.
 * This is a second guard after the slug regex check — it ensures
 * any schema name interpolated into SQL is strictly in the expected format.
 */
function validateSchemaName(name: string): string {
  if (!/^office_[a-z][a-z0-9_]*$/.test(name)) {
    throw new AppError(400, "Invalid schema name");
  }
  return name;
}
const MIGRATIONS_DIR = join(__dirname, "../../../../migrations");

export async function getAllOffices() {
  return db.select().from(offices).where(eq(offices.isActive, true));
}

export async function getOfficeById(id: string) {
  const result = await db.select().from(offices).where(eq(offices.id, id)).limit(1);
  return result[0] ?? null;
}

export async function getOfficeBySlug(slug: string) {
  const result = await db.select().from(offices).where(eq(offices.slug, slug)).limit(1);
  return result[0] ?? null;
}

export async function createOffice(
  name: string,
  slug: string,
  address?: string,
  phone?: string,
  timezone?: string | null
) {
  // Validate slug format (SQL injection prevention)
  if (!/^[a-z][a-z0-9_]*$/.test(slug)) {
    throw new AppError(400, "Slug must be lowercase alphanumeric with underscores, starting with a letter");
  }

  // Check slug uniqueness
  const existing = await getOfficeBySlug(slug);
  if (existing) {
    throw new AppError(409, `Office with slug '${slug}' already exists`);
  }

  // Issue #18 fix: atomic operation — insert + provision in a single transaction
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Create office record
    const insertResult = await client.query(
      `INSERT INTO public.offices (name, slug, address, phone, timezone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, slug, address ?? null, phone ?? null, getOfficeTimezone({ timezone })]
    );
    const office = insertResult.rows[0];

    // Provision tenant schema (Issue #19 fix: run migrations, not a static PG function)
    await provisionOfficeSchema(client, slug);

    await client.query("COMMIT");
    console.log(`[Office] Created office '${name}' with schema office_${slug}`);
    return office;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[Office] Failed to create office '${name}':`, err);
    if (err instanceof AppError) throw err;
    throw new AppError(500, `Failed to create office: ${(err as Error).message}`);
  } finally {
    client.release();
  }
}

/**
 * Provision a new office schema by creating the schema and running all
 * tenant-related DDL from migration files.
 *
 * Issue #19 fix: Instead of a static PG function (which would go stale as
 * new migrations add columns/tables), this reads the tenant DDL section from
 * each migration file. For the initial migration, the tenant DDL is the
 * section between markers `-- TENANT_SCHEMA_START` and `-- TENANT_SCHEMA_END`.
 * The runner replaces the placeholder schema name with the actual office schema.
 */
async function provisionOfficeSchema(client: import("pg").PoolClient, slug: string) {
  const schemaName = validateSchemaName(`office_${slug}`);

  // Create the schema
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);

  // Read migration files and extract tenant DDL sections
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");

    // Extract tenant DDL between markers
    const startMarker = "-- TENANT_SCHEMA_START";
    const endMarker = "-- TENANT_SCHEMA_END";
    const startIdx = sql.indexOf(startMarker);
    const endIdx = sql.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1) continue;

    let tenantSql = sql.substring(startIdx + startMarker.length, endIdx).trim();

    // Replace placeholder schema name with actual office schema
    tenantSql = tenantSql.replace(/office_dallas/g, schemaName);

    // Set search path for this schema
    await client.query(`SET LOCAL search_path = '${schemaName}', 'public'`);
    await client.query(tenantSql);
  }

  console.log(`[Office] Provisioned schema: ${schemaName}`);
}
