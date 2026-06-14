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
// caused the bugs. Enum types are created in `public` (their prod namespace — verified: audit_action,
// activity_type et al. live in public, not the tenant schema) and referenced as public."<enum>".

import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";

const dialect = new PgDialect();

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
  const enums = new Map<string, readonly string[]>(); // enum SQL name -> values, deduped across tables
  const tableDDL: string[] = [];

  for (const table of tables) {
    const cfg = getTableConfig(table);
    const colDDL: string[] = [];

    for (const column of cfg.columns) {
      let sqlType = column.getSQLType();
      // Enum columns: in prod the shared business enums live in `public` (e.g. public.audit_action,
      // public.activity_type — verified against office_dallas), NOT the tenant schema, so create and
      // reference them there to preserve the production type namespace. getSQLType() returns either a
      // bare name or an already-qualified "schema.name"; normalize to the bare name. (The rare
      // genuinely-per-office enum like lead_office also lands in public here — a minor, functionally
      // inert divergence, since value enforcement is identical regardless of namespace.)
      if (column.enumValues && column.enumValues.length > 0) {
        const bareName = sqlType.includes(".") ? sqlType.split(".").pop()!.replace(/"/g, "") : sqlType;
        enums.set(bareName, column.enumValues);
        sqlType = `public."${bareName}"`;
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

  // Enums are created in `public` (prod namespace) and guarded against duplicate_object so multiple
  // per-schema calls (office_dallas, office_atlanta, …) can each request the same shared enum.
  const enumDDL = [...enums].map(
    ([name, values]) =>
      `DO $$ BEGIN CREATE TYPE public."${name}" AS ENUM (${values
        .map((v) => `'${v.replace(/'/g, "''")}'`)
        .join(", ")}); EXCEPTION WHEN duplicate_object THEN null; END $$;`,
  );

  return [`CREATE SCHEMA IF NOT EXISTS ${schemaName};`, ...enumDDL, ...tableDDL].join("\n");
}
