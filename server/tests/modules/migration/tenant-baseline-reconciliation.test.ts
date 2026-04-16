import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../../migrations/0025_tenant_schema_baseline_reconciliation.sql"
);

describe("0025 tenant schema baseline reconciliation migration", () => {
  it("exists as the next tenant repair migration", () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it("repairs office schemas that missed core crm baseline tables and columns", () => {
    const migrationSql = readFileSync(migrationPath, "utf8");

    expect(migrationSql).toContain("SELECT schemata.schema_name");
    expect(migrationSql).toContain("WHERE schemata.schema_name LIKE 'office_%'");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS %I.companies");
    expect(migrationSql).toContain("ALTER TABLE %I.contacts ADD COLUMN IF NOT EXISTS company_id UUID");
    expect(migrationSql).toContain("ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS company_id UUID");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS %I.properties");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS %I.leads");
    expect(migrationSql).toContain("ALTER TABLE %I.deals\n         ADD COLUMN IF NOT EXISTS property_id UUID");
    expect(migrationSql).toContain("ALTER TABLE %I.deals\n         ADD COLUMN IF NOT EXISTS source_lead_id UUID");
  });

  it("repairs activities ownership for schemas that still have user_id", () => {
    const migrationSql = readFileSync(migrationPath, "utf8");

    expect(migrationSql).toContain("table_name = 'activities'");
    expect(migrationSql).toContain("column_name = 'user_id'");
    expect(migrationSql).toContain("ALTER TABLE %I.activities RENAME COLUMN user_id TO responsible_user_id");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS source_entity_type activity_source_entity");
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS activities_responsible_user_idx");
  });
});
