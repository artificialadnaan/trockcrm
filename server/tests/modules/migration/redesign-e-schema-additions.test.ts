import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(__dirname, "../../../../migrations/0105_redesign_e_schema_additions.sql");
const migrationSql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const companiesSchema = readFileSync(
  resolve(__dirname, "../../../../shared/src/schema/tenant/companies.ts"),
  "utf8"
);
const propertiesSchema = readFileSync(
  resolve(__dirname, "../../../../shared/src/schema/tenant/properties.ts"),
  "utf8"
);

describe("redesign E schema additions migration", () => {
  it("uses the tenant schema replay pattern", () => {
    expect(migrationSql).toContain("WHERE nspname LIKE 'office\\_%' ESCAPE '\\'");
    expect(migrationSql).toContain("to_regclass(format('%I.companies', tenant_schema))");
    expect(migrationSql).toContain("to_regclass(format('%I.properties', tenant_schema))");
  });

  it("adds nullable company metadata columns and indexes", () => {
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS region text");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS domain text");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS hubspot_company_id text");
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS companies_owner_user_idx");
    expect(migrationSql).toContain("WHERE owner_user_id IS NOT NULL");
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS companies_region_idx");
    expect(migrationSql).toContain("WHERE region IS NOT NULL");
  });

  it("adds nullable property metadata columns and check constraint", () => {
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS property_type text");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS procore_property_id text");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS companycam_project_id text");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS hubspot_property_id text");
    expect(migrationSql).toContain("properties_property_type_check");
    expect(migrationSql).toContain("''school'', ''office'', ''industrial'', ''retail'', ''healthcare'', ''government'', ''mixed-use''");
  });

  it("keeps Drizzle declarations aligned with the migration contract", () => {
    expect(companiesSchema).toContain('ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" })');
    expect(companiesSchema).toContain('hubspotCompanyId: text("hubspot_company_id")');
    expect(companiesSchema).toContain('index("companies_owner_id_idx").on(table.ownerId).where');
    expect(companiesSchema).toContain('index("companies_region_idx").on(table.region).where');
    expect(propertiesSchema).toContain('propertyType: text("property_type")');
    expect(propertiesSchema).toContain('procorePropertyId: text("procore_property_id")');
    expect(propertiesSchema).toContain('companycamProjectId: text("companycam_project_id")');
    expect(propertiesSchema).toContain('hubspotPropertyId: text("hubspot_property_id")');
    expect(propertiesSchema).toContain('"properties_property_type_check"');
  });
});
