import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../../migrations/0135_portfolio_project_relay_tracking.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

describe("0135 portfolio project relay tracking migration", () => {
  it("creates a new forward-looking model without reusing the legacy projects table", () => {
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS public.portfolio_project_stage_event_receipts");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS %I.portfolio_projects");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS %I.portfolio_project_stage_entries");
    expect(migrationSql).not.toContain("ALTER TABLE %I.projects");
    expect(migrationSql).not.toContain("CREATE TABLE IF NOT EXISTS %I.projects");
  });

  it("is tenant-replayable for new offices", () => {
    expect(migrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_END");
    expect(migrationSql).toContain("office_dallas.portfolio_projects");
    expect(migrationSql).toContain("office_dallas.portfolio_project_stage_entries");
  });

  it("encodes idempotency for SyncHub outbox retries", () => {
    expect(migrationSql).toContain("UNIQUE (event_key)");
    expect(migrationSql).not.toContain("CREATE UNIQUE INDEX IF NOT EXISTS portfolio_project_stage_entries_event_key_uidx");
    expect(migrationSql).toContain("DROP INDEX IF EXISTS");
    expect(migrationSql).toContain("portfolio_project_stage_entries_project_idx");
  });
});
