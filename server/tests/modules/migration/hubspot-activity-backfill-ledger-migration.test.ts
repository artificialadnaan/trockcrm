import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../../migrations/0126_hubspot_activity_backfill_ledger.sql"
);

describe("0126 hubspot activity backfill ledger migration", () => {
  const migrationSql = readFileSync(migrationPath, "utf8");

  it("creates the public ledger with the expected uniqueness contract", () => {
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS public.hubspot_activity_backfill_ledger");
    expect(migrationSql).toContain("tenant_schema TEXT NOT NULL");
    expect(migrationSql).toContain("hubspot_object_type TEXT NOT NULL");
    expect(migrationSql).toContain("hubspot_object_id TEXT NOT NULL");
    expect(migrationSql).toContain("UNIQUE (tenant_schema, hubspot_object_type, hubspot_object_id)");
  });

  it("tracks imported and skipped states with supporting indexes", () => {
    expect(migrationSql).toContain("status TEXT NOT NULL");
    expect(migrationSql).toContain("source_payload JSONB");
    expect(migrationSql).toContain(
      "CREATE INDEX IF NOT EXISTS hubspot_activity_backfill_ledger_tenant_status_idx"
    );
  });
});
