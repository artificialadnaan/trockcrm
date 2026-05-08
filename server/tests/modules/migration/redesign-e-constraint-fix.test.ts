import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(__dirname, "../../../../migrations/0106_redesign_e_property_type_constraint_fix.sql");
const migrationSql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const propertiesSchema = readFileSync(
  resolve(__dirname, "../../../../shared/src/schema/tenant/properties.ts"),
  "utf8"
);
const enumsSource = readFileSync(resolve(__dirname, "../../../../shared/src/types/enums.ts"), "utf8");

function getTenantSchemaSection(sql: string) {
  const startMarker = "-- TENANT_SCHEMA_START";
  const endMarker = "-- TENANT_SCHEMA_END";
  const startIndex = sql.indexOf(startMarker);
  const endIndex = sql.indexOf(endMarker);

  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);

  return sql.slice(startIndex, endIndex);
}

describe("redesign E property type constraint fix", () => {
  it("properties_property_type_check accepts canonical mixed_use value", () => {
    expect(enumsSource).toContain('"mixed_use"');
    expect(enumsSource).not.toContain('"mixed-use"');
    expect(migrationSql).toContain("properties_property_type_check");
    expect(migrationSql).toContain("'mixed_use'");
    expect(propertiesSchema).toContain("'mixed_use'");
  });

  it("properties_property_type_check rejects 'mixed-use' (the wrong value)", () => {
    expect(migrationSql).not.toContain("'mixed-use'");
    expect(propertiesSchema).not.toContain("'mixed-use'");
  });

  it("migration 0106 includes TENANT_SCHEMA_START block with all expected columns", () => {
    const tenantSql = getTenantSchemaSection(migrationSql);

    expect(tenantSql).toContain("ALTER TABLE companies ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL");
    expect(tenantSql).toContain("ALTER TABLE companies ADD COLUMN IF NOT EXISTS region text");
    expect(tenantSql).toContain("ALTER TABLE companies ADD COLUMN IF NOT EXISTS domain text");
    expect(tenantSql).toContain("ALTER TABLE companies ADD COLUMN IF NOT EXISTS hubspot_company_id text");
    expect(tenantSql).toContain("ALTER TABLE properties ADD COLUMN IF NOT EXISTS property_type text");
    expect(tenantSql).toContain("ALTER TABLE properties ADD COLUMN IF NOT EXISTS procore_property_id text");
    expect(tenantSql).toContain("ALTER TABLE properties ADD COLUMN IF NOT EXISTS companycam_project_id text");
    expect(tenantSql).toContain("ALTER TABLE properties ADD COLUMN IF NOT EXISTS hubspot_property_id text");
    expect(tenantSql).toContain("CREATE INDEX IF NOT EXISTS companies_owner_user_idx");
    expect(tenantSql).toContain("CREATE INDEX IF NOT EXISTS companies_region_idx");
    expect(tenantSql).toContain("ADD CONSTRAINT properties_property_type_check");
    expect(tenantSql).toContain("'mixed_use'");
    expect(tenantSql).not.toContain("'mixed-use'");
  });
});
