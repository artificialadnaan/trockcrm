import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../migrations/0033_estimating_market_rate.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

describe("estimating market-rate migration contract", () => {
  it("keeps the tenant replay markers and default seed statements", () => {
    expect(migrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_END");
    expect(migrationSql).toContain("INSERT INTO %I.estimate_markets");
    expect(migrationSql).toContain("VALUES (''Default Market'', ''default'', ''global'', NULL, NULL, TRUE)");
    expect(migrationSql).toContain("INSERT INTO %I.estimate_market_fallback_geographies");
    expect(migrationSql).toContain("resolution_type,\n         resolution_key,\n         is_active");
    expect(migrationSql).toContain("INSERT INTO %I.estimate_market_adjustment_rules");
    expect(migrationSql).toContain("ON CONFLICT (scope_type, scope_key, effective_from) WHERE market_id IS NULL");
    expect(migrationSql).toContain("deal_id UUID NOT NULL REFERENCES %I.deals(id) ON DELETE CASCADE");
  });
});
