import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0168 backs the Properties Linked Value fold with a partial index on
 * deals(property_id) WHERE is_active. It must (a) retrofit EXISTING offices via the per-office DO-loop at
 * deploy, AND (b) provision NEW offices via a `-- TENANT_SCHEMA_START/END` block — provisionOfficeSchema
 * (office/service.ts) ONLY replays marker blocks (office_dallas -> the new schema). Without the block,
 * offices created after this deploy would silently miss the index and the linked-value fold would scan
 * unindexed as their data grows (Codex P3). Mirrors the 0159 convention.
 */
const migrationPath = resolve(
  import.meta.dirname,
  "../../../../migrations/0168_deals_property_active_idx.sql"
);

describe("migration 0168 — deals_property_active_idx", () => {
  const sql = readFileSync(migrationPath, "utf8");

  it("retrofits existing tenants via a per-office DO-loop over schemata", () => {
    expect(sql).toContain("information_schema.schemata");
    expect(sql).toContain("to_regclass(format('%I.deals', tenant_schema))");
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS deals_property_active_idx ON %I\.deals \(property_id\) WHERE is_active = TRUE/
    );
  });

  it("provisions NEW tenants via a TENANT_SCHEMA marker block (office_dallas -> cloned schema)", () => {
    const start = sql.indexOf("-- TENANT_SCHEMA_START");
    const end = sql.indexOf("-- TENANT_SCHEMA_END");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = sql.slice(start, end);
    expect(block).toContain(
      "CREATE INDEX IF NOT EXISTS deals_property_active_idx ON office_dallas.deals (property_id) WHERE is_active = TRUE"
    );
  });

  it("uses plain CREATE INDEX (CONCURRENTLY is illegal inside a DO/txn block)", () => {
    expect(sql).not.toContain("CONCURRENTLY");
  });
});
