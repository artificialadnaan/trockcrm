import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../../migrations/0027_hubspot_lineage_repair.sql"
);

describe("0027 hubspot lineage repair migration", () => {
  it("exists as the next hierarchy repair migration", () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it("repairs legacy deal lineage from promoted HubSpot staging records", () => {
    const migrationSql = readFileSync(migrationPath, "utf8");

    expect(migrationSql).toContain("migration.staged_deals");
    expect(migrationSql).toContain("migration.staged_contacts");
    expect(migrationSql).toContain("jsonb_array_elements");
    expect(migrationSql).toContain("promoted_deal_id");
    expect(migrationSql).toContain("promoted_contact_id");
    expect(migrationSql).toContain("SET primary_contact_id = candidates.primary_contact_id");
    expect(migrationSql).toContain("SET company_id = candidates.company_id");
    expect(migrationSql).not.toContain("ARRAY_AGG(DISTINCT");
    expect(migrationSql).toContain("ALTER TABLE %I.deals DISABLE TRIGGER USER");
    expect(migrationSql).toContain("ALTER TABLE %I.deals ENABLE TRIGGER USER");
  });

  it("recreates synthesized properties and converted leads after repairing company linkage", () => {
    const migrationSql = readFileSync(migrationPath, "utf8");

    expect(migrationSql).toContain("INSERT INTO %I.properties");
    expect(migrationSql).toContain("UPDATE %I.deals SET property_id = $1");
    expect(migrationSql).toContain("INSERT INTO %I.leads");
    expect(migrationSql).toContain("UPDATE %I.deals SET source_lead_id = $1");
  });
});
