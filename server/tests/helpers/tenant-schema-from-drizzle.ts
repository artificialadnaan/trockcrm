// Build a PGlite test schema from the REAL Drizzle table definitions instead of hand-rolled DDL.
//
// Why this exists (#677): hand-written CREATE TABLE blocks in the usage tests let column types drift
// from prod — a test passes against a loose/partial schema, prod has the strict one, the query breaks
// only in prod. Three bugs shipped past a green gate that way this session (the #674 enum mismatch
// being the canonical one: activities.type was hand-rolled `text`, then a 4-value enum, while prod's
// activity_type carries all 13 ACTIVITY_TYPES; audit_log.action was `text` not the audit_action enum).
//
// Deriving the test schema from the same Drizzle objects that generate prod makes the test types
// prod-accurate BY CONSTRUCTION — enum value sets, NOT NULL, defaults and PKs come straight from the
// table definitions, so they cannot silently diverge again.
//
// Scope (deliberate): column TYPES, enum value sets, NOT NULL, column defaults and PRIMARY KEYs are
// reproduced verbatim. FOREIGN KEYS and INDEXES are intentionally omitted — test tables are islands
// (we don't stand up the users/companies/deals graph just to insert a usage row), and types are what
// caused the bugs. Enum types are created in their PROD namespace: shared business enums (audit_action,
// activity_type, …) in `public`, genuinely tenant-scoped ones (lead_office) in the tenant schema — see
// TENANT_SCOPED_BARE_ENUMS — so the type relationship matches prod rather than collapsing both.

import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";

const dialect = new PgDialect();

// Enums that Drizzle declares as BARE pgEnums (unqualified, so `getSQLType()` can't tell us their
// namespace) but that prod creates per-tenant-schema rather than in `public`. Drizzle cannot
// distinguish these from the public ones, so the set is sourced from prod: this is the EXACT set of
// enum types that exist only in office_* schemas (not public), enumerated via
//   SELECT typname, nspname FROM pg_type JOIN pg_namespace … JOIN pg_enum …
// against the live DB (53 public-only, 14 tenant-only, 1 in both → activity_source_entity, which is
// also in public so it correctly defaults there). Any bare enum NOT listed defaults to `public`; an
// already-qualified `getSQLType()` keeps its schema verbatim. Re-run that query if migrations add a
// tenant-scoped enum. (Test-only allowlist — the value-fidelity guarantee that catches #674 holds
// regardless of namespace; this only sharpens the type-relationship fidelity.)
const TENANT_SCOPED_BARE_ENUMS = new Set<string>([
  "company_industry",
  "contact_role",
  "deal_contact_role",
  "deal_scoping_intake_status",
  "forecast_milestone_capture_source",
  "forecast_milestone_key",
  "lead_office",
  "lead_scoping_intake_status",
  "photo_address_source",
  "photo_audit_event_type",
  "photo_category",
  "procore_photo_sync_status",
  "property_type",
  "workflow_route",
]);

/** True when a column default is a Drizzle SQL object (e.g. `sql\`gen_random_uuid()\``) rather than a
 *  plain JS literal — those carry a `queryChunks` array and must be rendered through the pg dialect. */
function isDrizzleSql(value: unknown): value is { queryChunks: unknown } {
  return typeof value === "object" && value !== null && "queryChunks" in value;
}

/** Render a column's DEFAULT clause from its Drizzle definition, keyed on the column's SQL type so
 *  jsonb/array/scalar/SQL-function defaults each serialize correctly. Returns "" when there is none. */
function renderDefault(column: ReturnType<typeof getTableConfig>["columns"][number]): string {
  if (!column.hasDefault) return "";
  const def = column.default as unknown;
  // SQL defaults (gen_random_uuid(), now()) are Drizzle SQL objects — render them via the pg dialect.
  if (isDrizzleSql(def)) return ` DEFAULT ${dialect.sqlToQuery(def as never).sql}`;
  if (def === undefined) return "";
  // Render the literal by the COLUMN's SQL type, not the JS value shape — a jsonb column defaulting
  // to a JS array must become a JSON literal, while a text[] column must become a PG array literal.
  const sqlType = column.getSQLType().toLowerCase();
  if (sqlType === "json" || sqlType === "jsonb") {
    return ` DEFAULT '${JSON.stringify(def).replace(/'/g, "''")}'`;
  }
  if (sqlType.endsWith("[]") && Array.isArray(def)) {
    const inner = def.map((v) => String(v).replace(/"/g, '\\"')).join(",");
    return ` DEFAULT '{${inner}}'`;
  }
  if (typeof def === "string") return ` DEFAULT '${def.replace(/'/g, "''")}'`;
  if (typeof def === "boolean" || typeof def === "number") return ` DEFAULT ${def}`;
  // Fallback for any remaining object/array default: emit as a quoted JSON literal.
  return ` DEFAULT '${JSON.stringify(def).replace(/'/g, "''")}'`;
}

/**
 * Generate `CREATE SCHEMA` + `CREATE TYPE` (enums) + `CREATE TABLE` DDL for the given Drizzle tables,
 * all under `schemaName`. Run the result with `db.exec(...)`. Call once per office schema (and once
 * with "public" for cross-schema tables like pipeline_stage_config).
 */
export function tenantSchemaSql(schemaName: string, tables: readonly PgTable[]): string {
  // enum key "schema.name" -> {schema, name, values}, deduped across tables/columns.
  const enums = new Map<string, { schema: string; name: string; values: readonly string[] }>();
  const tableDDL: string[] = [];

  for (const table of tables) {
    const cfg = getTableConfig(table);
    const colDDL: string[] = [];

    for (const column of cfg.columns) {
      let sqlType = column.getSQLType();
      // Enum columns: create+reference each enum in its PROD namespace so the type relationship matches
      // prod. If getSQLType() is already schema-qualified ("public.workflow_family"), keep that schema.
      // If it's bare, default to `public` (where the shared business enums live) unless it's a known
      // tenant-scoped enum, which goes in this tenant's schema. (See TENANT_SCOPED_BARE_ENUMS.)
      if (column.enumValues && column.enumValues.length > 0) {
        const qualified = sqlType.includes(".");
        const enumName = (qualified ? sqlType.split(".").pop()! : sqlType).replace(/"/g, "");
        const enumSchema = qualified
          ? sqlType.split(".", 1)[0].replace(/"/g, "")
          : TENANT_SCOPED_BARE_ENUMS.has(enumName)
            ? schemaName
            : "public";
        enums.set(`${enumSchema}.${enumName}`, { schema: enumSchema, name: enumName, values: column.enumValues });
        sqlType = `"${enumSchema}"."${enumName}"`;
      }
      const notNull = column.notNull ? " NOT NULL" : "";
      colDDL.push(`"${column.name}" ${sqlType}${notNull}${renderDefault(column)}`);
    }

    // Composite PK (e.g. usage_daily on user_id+date) wins; otherwise single .primary() columns.
    const pkColumns =
      cfg.primaryKeys[0]?.columns.map((c) => `"${c.name}"`) ??
      cfg.columns.filter((c) => c.primary).map((c) => `"${c.name}"`);
    if (pkColumns.length > 0) colDDL.push(`PRIMARY KEY (${pkColumns.join(", ")})`);

    tableDDL.push(`CREATE TABLE ${schemaName}."${cfg.name}" (\n  ${colDDL.join(",\n  ")}\n);`);
  }

  // Each enum created in its resolved namespace, guarded against duplicate_object so multiple per-schema
  // calls (office_dallas, office_atlanta, …) can each request the same shared `public` enum.
  const enumDDL = [...enums.values()].map(
    ({ schema, name, values }) =>
      `DO $$ BEGIN CREATE TYPE "${schema}"."${name}" AS ENUM (${values
        .map((v) => `'${v.replace(/'/g, "''")}'`)
        .join(", ")}); EXCEPTION WHEN duplicate_object THEN null; END $$;`,
  );

  return [`CREATE SCHEMA IF NOT EXISTS ${schemaName};`, ...enumDDL, ...tableDDL].join("\n");
}
