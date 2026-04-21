import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../migrations/0034_estimating_market_rate_repair.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

describe("estimating market-rate repair migration", () => {
  it("repairs already-upgraded tenant schemas without changing the fallback geography seed", () => {
    const repairSectionEnd = migrationSql.indexOf("-- TENANT_SCHEMA_START");
    const repairSection = migrationSql.slice(0, repairSectionEnd);

    const dropScopeIndex = repairSection.indexOf(
      "DROP CONSTRAINT IF EXISTS estimate_market_adjustment_rules_scope_type_check"
    );
    const dropFallbackIndex = repairSection.indexOf(
      "DROP CONSTRAINT IF EXISTS estimate_market_adjustment_rules_fallback_scope_type_check"
    );
    const repairUpdateIndex = repairSection.indexOf(
      "SET scope_type = ''general'',"
    );
    const legacyDeleteIndex = repairSection.indexOf(
      "scope_type IN (''global'', ''metro'', ''state'', ''region'')"
    );
    const addScopeConstraintIndex = repairSection.indexOf(
      "ADD CONSTRAINT estimate_market_adjustment_rules_scope_type_check"
    );
    const repairInsertIndex = repairSection.indexOf("INSERT INTO %I.estimate_market_adjustment_rules");

    expect(migrationSql).toContain("INSERT INTO %I.estimate_market_fallback_geographies");
    expect(migrationSql).toContain("SELECT id, 'global', 'default', TRUE");
    expect(migrationSql).toContain("INSERT INTO %I.estimate_market_adjustment_rules");
    expect(migrationSql).toContain("scope_type = ''general''");
    expect(migrationSql).toContain("scope_type = ''global''");
    expect(migrationSql).toContain("DROP CONSTRAINT IF EXISTS estimate_market_adjustment_rules_scope_type_check");
    expect(migrationSql).toContain("CHECK (scope_type IN ('general', 'division', 'trade'))");
    expect(migrationSql).toContain("DROP CONSTRAINT IF EXISTS estimate_market_adjustment_rules_fallback_scope_type_check");
    expect(migrationSql).toContain("CHECK (fallback_scope_type IS NULL OR fallback_scope_type IN ('general', 'division', 'trade'))");
    expect(dropScopeIndex).toBeGreaterThanOrEqual(0);
    expect(dropFallbackIndex).toBeGreaterThanOrEqual(0);
    expect(legacyDeleteIndex).toBeGreaterThan(dropFallbackIndex);
    expect(repairUpdateIndex).toBeGreaterThan(dropFallbackIndex);
    expect(repairUpdateIndex).toBeLessThan(repairInsertIndex);
    expect(repairUpdateIndex).toBeLessThan(addScopeConstraintIndex);
    expect(legacyDeleteIndex).toBeLessThan(addScopeConstraintIndex);
    expect(repairInsertIndex).toBeGreaterThan(legacyDeleteIndex);
    expect(repairInsertIndex).toBeLessThan(addScopeConstraintIndex);
  });

  it("is safe to run on tenants that are already correct", () => {
    expect(migrationSql).toContain("ON CONFLICT (resolution_type, resolution_key)");
    expect(migrationSql).toContain("ON CONFLICT (scope_type, scope_key, effective_from) WHERE market_id IS NULL");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_END");
  });
});
