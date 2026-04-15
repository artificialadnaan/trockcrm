import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../../migrations/0021_activity_email_attribution_expansion.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

function getTenantSection(sql: string) {
  const startMarker = "-- TENANT_SCHEMA_START";
  const endMarker = "-- TENANT_SCHEMA_END";
  const start = sql.indexOf(startMarker);
  const end = sql.indexOf(endMarker);

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Could not extract tenant migration section from 0021 SQL");
  }

  return sql.slice(start + startMarker.length, end);
}

describe("0021 activity attribution migration", () => {
  it("updates all existing office schemas through the tenant migration loop", () => {
    expect(migrationSql).toContain("FROM pg_namespace");
    expect(migrationSql).toContain("WHERE nspname LIKE 'office\\_%' ESCAPE '\\'");
    expect(migrationSql).toContain("ALTER TABLE %I.activities RENAME COLUMN user_id TO responsible_user_id");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS performed_by_user_id UUID");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS source_entity_type public.activity_source_entity");
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS activities_responsible_user_idx");
  });

  it("keeps the mixed-state rename guard schema-scoped and idempotent", () => {
    expect(migrationSql).toContain("WHERE table_schema = schema_name");
    expect(migrationSql).toContain("AND table_name = 'activities'");
    expect(migrationSql).toContain("AND column_name = 'user_id'");
  });

  it("includes tenant provisioning DDL for new office schemas", () => {
    const tenantSql = getTenantSection(migrationSql);

    expect(tenantSql).toContain("table_schema = current_schema()");
    expect(tenantSql).toContain("ALTER TABLE activities RENAME COLUMN user_id TO responsible_user_id");
    expect(tenantSql).toContain("ADD COLUMN IF NOT EXISTS performed_by_user_id UUID");
    expect(tenantSql).toContain("ADD COLUMN IF NOT EXISTS source_entity_type public.activity_source_entity");
    expect(tenantSql).toContain("CREATE INDEX IF NOT EXISTS activities_lead_idx");
  });
});
