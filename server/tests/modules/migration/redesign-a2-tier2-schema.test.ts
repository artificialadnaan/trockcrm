import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(__dirname, "../../../../migrations/0104_redesign_a2_tier2_schema.sql");
const migrationSql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

describe("redesign A2 tier 2 schema migration", () => {
  it("replays against current and future tenant schemas", () => {
    expect(migrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_END");
    expect(migrationSql).toContain("WHERE nspname LIKE 'office\\_%' ESCAPE '\\'");
  });

  it("adds lead office as an immutable enum and pins trigger search_path", () => {
    expect(migrationSql).toContain("CREATE TYPE %I.lead_office AS ENUM");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS office %I.lead_office");
    expect(migrationSql).toContain("CREATE OR REPLACE FUNCTION %I.prevent_leads_office_update()");
    expect(migrationSql).toContain("SET search_path = pg_catalog, public");
    expect(migrationSql).toContain("office cannot be changed once set");
  });

  it("adds project number support without inventing the product-owner format", () => {
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS project_number text");
    expect(migrationSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS deals_project_number_uidx");
    expect(migrationSql).toContain("CREATE OR REPLACE FUNCTION %I.generate_project_number_placeholder");
    expect(migrationSql).toContain("TODO: format spec pending from product owner.");
    expect(migrationSql).toContain("RETURN NULL;");
  });

  it("creates deal_contacts with a per-deal primary contact invariant", () => {
    expect(migrationSql).toContain("CREATE TYPE %I.deal_contact_role AS ENUM");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS %I.deal_contacts");
    expect(migrationSql).toContain("role_on_deal %I.deal_contact_role NOT NULL");
    expect(migrationSql).toContain("ON DELETE CASCADE");
    expect(migrationSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS deal_contacts_one_primary_per_deal_uidx");
    expect(migrationSql).toContain("WHERE role_on_deal = 'primary'");
  });

  it("creates email and file junctions plus current-user starred files with cascade deletes", () => {
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS %I.email_links");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS %I.file_links");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS %I.user_starred_files");
    expect(migrationSql).toContain("UNIQUE (email_id, entity_type, entity_id)");
    expect(migrationSql).toContain("UNIQUE (file_id, entity_type, entity_id)");
    expect(migrationSql).toContain("PRIMARY KEY (user_id, file_id)");
  });

  it("extends existing estimate_line_items instead of recreating the table", () => {
    expect(migrationSql).toContain("ALTER TABLE %I.estimate_line_items");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS deal_id UUID");
    expect(migrationSql).toContain("estimate_line_items_deal_id_fkey");
    expect(migrationSql).toContain("estimate_line_items_deal_sort_idx");
  });
});
