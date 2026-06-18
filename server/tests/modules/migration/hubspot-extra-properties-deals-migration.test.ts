import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(__dirname, "../../../../migrations/0139_hubspot_extra_properties_deals.sql"),
  "utf8"
);
describe("0139 hubspot_extra_properties deals migration", () => {
  it("adds the JSONB column idempotently to every current tenant deals table", () => {
    expect(migrationSql).toContain("WHERE nspname LIKE 'office\\_%' ESCAPE '\\'");
    expect(migrationSql).toContain("ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS hubspot_extra_properties jsonb");
  });

  it("includes the tenant schema block used when provisioning future offices", () => {
    expect(migrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(migrationSql).toContain("ALTER TABLE office_dallas.deals");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS hubspot_extra_properties jsonb");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_END");
  });

  it("does not backfill or mutate HubSpot JSON data", () => {
    expect(migrationSql.toLowerCase()).not.toContain("update ");
    expect(migrationSql.toLowerCase()).not.toContain("insert ");
  });
  // The 4th case ("documents the DB-only raw-SQL schema decision at the helper call site") was removed:
  // the helper + its doc comment it asserted were intentionally deleted as dead code in PR #560 (005ecf43),
  // so there is no call site to document. Tests 1-3 still validate the real migration SQL contract.
});
