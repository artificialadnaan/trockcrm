import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(__dirname, "../../../..", "migrations/0077_photo_schema_foundation.sql"),
  "utf8"
);

describe("0077_photo_schema_foundation migration", () => {
  it("is idempotent and uses the coordinated post-lead migration number", () => {
    expect(migrationSql).toContain("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'field_contractor'");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS %I.photo_audit_log");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS %I.field_user_starred_projects");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS latitude numeric(10,7)");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS longitude numeric(10,7)");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS photo_category %I.photo_category");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS procore_sync_status %I.procore_photo_sync_status");
  });

  it("creates separate photo enums instead of extending broad file categories", () => {
    expect(migrationSql).toContain("CREATE TYPE %I.photo_category AS ENUM");
    for (const value of ["before", "after", "progress", "site_visit", "damage", "safety", "delivery", "other"]) {
      expect(migrationSql).toContain(`'${value}'`);
    }
    expect(migrationSql).not.toContain("ALTER TYPE file_category ADD VALUE");
  });

  it("creates audit and starred-project constraints needed by follow-on features", () => {
    expect(migrationSql).toContain("photo_id uuid NOT NULL REFERENCES %I.files(id) ON DELETE CASCADE");
    expect(migrationSql).toContain("event_type %I.photo_audit_event_type NOT NULL");
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS photo_audit_log_photo_created_idx");
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS photo_audit_log_user_created_idx");
    expect(migrationSql).toContain("CONSTRAINT field_user_starred_projects_user_id_deal_id_pk PRIMARY KEY (user_id, deal_id)");
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS field_user_starred_projects_user_idx");
  });
});
