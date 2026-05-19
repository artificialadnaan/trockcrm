import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(import.meta.dirname, "../../../../migrations/0127_photo_tags_and_reports.sql"),
  "utf8"
);

function getTenantSection(sql: string) {
  const startMarker = "-- TENANT_SCHEMA_START";
  const endMarker = "-- TENANT_SCHEMA_END";
  const start = sql.indexOf(startMarker);
  const end = sql.indexOf(endMarker);

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Could not extract tenant migration section from 0127 SQL");
  }

  return sql.slice(start + startMarker.length, end);
}

describe("0127_photo_tags_and_reports migration", () => {
  it("updates photo audit enums and creates photo_tags in each tenant schema", () => {
    const tenantSectionStart = migrationSql.indexOf("-- TENANT_SCHEMA_START");
    const existingSchemaSql = tenantSectionStart === -1 ? migrationSql : migrationSql.slice(0, tenantSectionStart);

    expect(migrationSql).toContain("FROM pg_namespace");
    expect(migrationSql).toContain("WHERE nspname LIKE 'office\\_%' ESCAPE '\\'");
    expect(migrationSql).toContain("to_regclass(format('%I.files', tenant_schema)) IS NOT NULL");
    expect(migrationSql).toContain("to_regtype(format('%I.photo_audit_event_type', tenant_schema)) IS NOT NULL");
    expect(migrationSql).toContain(
      "ALTER TYPE %I.photo_audit_event_type ADD VALUE IF NOT EXISTS ''voice_description_transcribed''"
    );
    expect(existingSchemaSql).toContain("CREATE TABLE IF NOT EXISTS %I.photo_tags");
    expect(existingSchemaSql).toContain("REFERENCES %I.files(id) ON DELETE CASCADE");
    expect(existingSchemaSql).not.toContain("CREATE TABLE IF NOT EXISTS photo_tags (");
  });

  it("includes tenant provisioning DDL for newly created office schemas", () => {
    const tenantSql = getTenantSection(migrationSql);

    expect(tenantSql).toContain("IF to_regclass('files') IS NOT NULL THEN");
    expect(tenantSql).toContain("IF to_regtype('photo_audit_event_type') IS NOT NULL THEN");
    expect(tenantSql).toContain("ALTER TYPE photo_audit_event_type ADD VALUE IF NOT EXISTS 'voice_description_transcribed'");
    expect(tenantSql).toContain("CREATE TABLE IF NOT EXISTS photo_tags");
    expect(tenantSql).toContain("REFERENCES files(id) ON DELETE CASCADE");
    expect(tenantSql).toContain("CREATE INDEX IF NOT EXISTS photo_tags_photo_created_idx");
  });
});
