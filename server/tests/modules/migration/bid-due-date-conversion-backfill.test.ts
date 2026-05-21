import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(__dirname, "../../../../migrations/0132_deal_bid_due_date_backfill.sql");
const migrationSql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

describe("deal bid due date backfill migration", () => {
  it("exists and replays across tenant schemas", () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(migrationSql).toContain("WHERE nspname LIKE 'office\\_%' ESCAPE '\\'");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_END");
    expect(migrationSql).toContain("to_regclass(format('%I.deals', tenant_schema)) IS NULL");
    expect(migrationSql).toContain("to_regclass(format('%I.leads', tenant_schema)) IS NULL");
    expect(migrationSql).toContain("table_name = 'deals'");
    expect(migrationSql).toContain("column_name = 'source_lead_id'");
    expect(migrationSql).toContain("table_name = 'leads'");
  });

  it("fills deal bid_due_date only when the deal is null and the source lead has a value", () => {
    expect(migrationSql).toContain("UPDATE %I.deals d");
    expect(migrationSql).toContain("SET bid_due_date = l.bid_due_date");
    expect(migrationSql).toContain("FROM %I.leads l");
    expect(migrationSql).toContain("l.id = d.source_lead_id");
    expect(migrationSql).toContain("d.bid_due_date IS NULL");
    expect(migrationSql).toContain("l.bid_due_date IS NOT NULL");
  });

  it("never overwrites an existing deal bid_due_date", () => {
    expect(migrationSql).not.toContain("SET bid_due_date = NULL");
    expect(migrationSql).not.toMatch(/SET bid_due_date = l\.bid_due_date[\s\S]*WHERE[\s\S]*d\.bid_due_date IS NOT NULL/);
  });
});
