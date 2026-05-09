import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("commission deal snapshots migration", () => {
  const migrationSql = readFileSync(
    join(process.cwd(), "migrations/0107_commission_deal_snapshots.sql"),
    "utf8"
  );
  const compositePkMigrationSql = readFileSync(
    join(process.cwd(), "migrations/0108_commission_deal_snapshots_composite_pk.sql"),
    "utf8"
  );

  it("creates the persisted snapshot table for existing and future tenant schemas", () => {
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS");
    expect(migrationSql).toContain("commission_deal_snapshots");
    expect(migrationSql).toContain("last_commission_amount numeric(14,2)");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_END");
  });

  it("moves persisted snapshots to a deal-and-rep composite primary key", () => {
    expect(compositePkMigrationSql).toContain("DROP CONSTRAINT IF EXISTS commission_deal_snapshots_pkey");
    expect(compositePkMigrationSql).toContain("PRIMARY KEY (deal_id, rep_user_id)");
    expect(compositePkMigrationSql).toContain("GROUP BY deal_id, rep_user_id");
    expect(compositePkMigrationSql).toContain("RAISE EXCEPTION");
    expect(compositePkMigrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(compositePkMigrationSql).toContain("-- TENANT_SCHEMA_END");
  });
});
