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
  it("applies to all existing office schemas", () => {
    expect(migrationSql).toContain("FROM information_schema.schemata");
    expect(migrationSql).toContain("WHERE schema_name LIKE 'office_%'");
    expect(migrationSql).toContain("SET LOCAL search_path = %I, public");
    expect(migrationSql).toContain("EXECUTE tenant_sql");
  });

  it("keeps the mixed-state rename guard schema-scoped and idempotent", () => {
    expect(migrationSql).toContain("table_schema = current_schema()");
    expect(migrationSql).toContain("AND table_name = 'activities'");
    expect(migrationSql).toContain("AND column_name = 'user_id'");
  });

  it("backfills through direct and email-linked lineage before enforcing not-null columns", () => {
    expect(migrationSql).toContain("SELECT e.deal_id FROM emails e WHERE e.id = activities.email_id");
    expect(migrationSql).toContain("SELECT e.contact_id FROM emails e WHERE e.id = activities.email_id");
    expect(migrationSql).toContain("JOIN deals d ON d.id = e.deal_id");
    expect(migrationSql).toContain("JOIN contacts c ON c.id = e.contact_id");
    expect(migrationSql).toContain("source_entity_id = COALESCE(");
    expect(migrationSql).toContain("source_entity_type = COALESCE(source_entity_type, 'company'::activity_source_entity)");
    expect(migrationSql).toContain("source_entity_id = COALESCE(source_entity_id, company_id, contact_id, deal_id, id)");
  });

  it("includes tenant provisioning DDL for new office schemas", () => {
    const tenantSql = getTenantSection(migrationSql);

    expect(tenantSql).toContain("table_schema = current_schema()");
    expect(tenantSql).toContain("ADD COLUMN IF NOT EXISTS performed_by_user_id UUID");
    expect(tenantSql).toContain("ADD COLUMN IF NOT EXISTS source_entity_type activity_source_entity");
    expect(tenantSql).toContain("CREATE INDEX IF NOT EXISTS activities_lead_idx");
  });
});
