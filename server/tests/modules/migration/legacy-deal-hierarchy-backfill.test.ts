import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../../migrations/0026_legacy_deal_hierarchy_backfill.sql"
);

describe("0026 legacy deal hierarchy backfill migration", () => {
  it("exists as the next hierarchy repair migration", () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it("backfills missing company and primary contact linkage from existing contact associations", () => {
    const migrationSql = readFileSync(migrationPath, "utf8");

    expect(migrationSql).toContain("FROM %I.contact_deal_associations cda");
    expect(migrationSql).toContain("JOIN %I.contacts c ON c.id = cda.contact_id");
    expect(migrationSql).toContain("UPDATE %I.deals d");
    expect(migrationSql).toContain("SET company_id = candidates.company_id");
    expect(migrationSql).toContain("SET primary_contact_id = candidates.contact_id");
  });

  it("creates synthesized properties for legacy deals and links deals to them", () => {
    const migrationSql = readFileSync(migrationPath, "utf8");

    expect(migrationSql).toContain("INSERT INTO %I.properties");
    expect(migrationSql).toContain("legacy:%s");
    expect(migrationSql).toContain("legacy_property_key");
    expect(migrationSql).toContain("UPDATE %I.deals SET property_id = $1");
  });

  it("creates converted source leads for legacy deals that never had lead lineage", () => {
    const migrationSql = readFileSync(migrationPath, "utf8");

    expect(migrationSql).toContain("SELECT id");
    expect(migrationSql).toContain("INTO converted_stage_id");
    expect(migrationSql).toContain("workflow_family = 'lead'");
    expect(migrationSql).toContain("slug = 'converted'");
    expect(migrationSql).toContain("INSERT INTO %I.leads");
    expect(migrationSql).toContain("status,");
    expect(migrationSql).toContain("source,");
    expect(migrationSql).toContain("description,");
    expect(migrationSql).toContain("last_activity_at,");
    expect(migrationSql).toContain("UPDATE %I.deals SET source_lead_id = $1");
  });
});
