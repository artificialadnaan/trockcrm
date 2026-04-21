import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../migrations/0033_estimating_market_rate.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

function getTenantReplaySection(sql: string): string {
  const startMarker = "-- TENANT_SCHEMA_START";
  const endMarker = "-- TENANT_SCHEMA_END";
  const startIndex = sql.indexOf(startMarker);
  const endIndex = sql.indexOf(endMarker);

  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);

  return sql.slice(startIndex, endIndex);
}

describe("estimating market-rate migration contract", () => {
  it("keeps the tenant replay markers and default seed statements", () => {
    expect(migrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_END");

    const tenantSql = getTenantReplaySection(migrationSql);
    expect(tenantSql).toContain("CREATE TABLE IF NOT EXISTS estimate_markets");
    expect(tenantSql).toContain("VALUES ('Default Market', 'default', 'global', NULL, NULL, TRUE)");
    expect(tenantSql).toContain("CREATE TABLE IF NOT EXISTS estimate_market_fallback_geographies");
    expect(tenantSql).toContain("CREATE TABLE IF NOT EXISTS estimate_market_adjustment_rules");
    expect(tenantSql).toContain("ON CONFLICT (scope_type, scope_key, effective_from) WHERE market_id IS NULL");
    expect(tenantSql).toContain("deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE");
    expect(tenantSql).not.toContain("estimate_deals(id)");
  });
});
