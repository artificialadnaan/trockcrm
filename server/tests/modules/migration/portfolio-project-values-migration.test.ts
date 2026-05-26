import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(__dirname, "../../../../migrations/0136_portfolio_project_values.sql"),
  "utf8"
);

describe("0136 portfolio project values migration", () => {
  it("adds value fields to each tenant portfolio_projects table idempotently", () => {
    expect(migrationSql).toContain("ALTER TABLE %I.portfolio_projects ADD COLUMN IF NOT EXISTS total_value numeric(14,2)");
    expect(migrationSql).toContain("ALTER TABLE %I.portfolio_projects ADD COLUMN IF NOT EXISTS value_synced_at timestamptz");
    expect(migrationSql).toContain("WHERE nspname LIKE 'office\\_%'");
  });

  it("includes the tenant schema block for future office provisioning", () => {
    expect(migrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(migrationSql).toContain("ALTER TABLE office_dallas.portfolio_projects");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_END");
  });

  it("does not touch the legacy projects table", () => {
    expect(migrationSql).not.toContain("office_dallas.projects");
    expect(migrationSql).not.toContain("%I.projects");
  });
});
