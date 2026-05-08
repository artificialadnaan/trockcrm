import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(__dirname, "../../../../migrations/0104_redesign_a2_tier2_schema.sql");
const migrationSql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const dealContactsSchemaPath = resolve(__dirname, "../../../../shared/src/schema/tenant/deal-contacts.ts");
const dealContactsSchema = existsSync(dealContactsSchemaPath) ? readFileSync(dealContactsSchemaPath, "utf8") : "";
const estimateLineItemsSchemaPath = resolve(__dirname, "../../../../shared/src/schema/tenant/estimate-line-items.ts");
const estimateLineItemsSchema = existsSync(estimateLineItemsSchemaPath) ? readFileSync(estimateLineItemsSchemaPath, "utf8") : "";
const dealsSchemaPath = resolve(__dirname, "../../../../shared/src/schema/tenant/deals.ts");
const dealsSchema = existsSync(dealsSchemaPath) ? readFileSync(dealsSchemaPath, "utf8") : "";

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

  it("locks office_code with the lead office immutability trigger", () => {
    expect(migrationSql).toContain("office_code cannot be changed once set");
    expect(migrationSql).toContain("BEFORE UPDATE OF office, office_code");
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
    expect(migrationSql).toContain("UNIQUE (deal_id, contact_id)");
    expect(migrationSql).not.toContain("UNIQUE (deal_id, contact_id, role_on_deal)");
    expect(migrationSql).not.toContain("deal_contacts_one_primary_per_deal_uidx");
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

  it("estimate_line_items.deal_id has FK to deals.id with ON DELETE CASCADE", () => {
    expect(migrationSql).toContain("ADD CONSTRAINT estimate_line_items_deal_id_fkey");
    expect(migrationSql).toContain(
      "FOREIGN KEY (deal_id) REFERENCES %I.deals(id) ON DELETE CASCADE"
    );
    expect(migrationSql).toContain(
      "FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE"
    );
    expect(estimateLineItemsSchema).toContain(
      'dealId: uuid("deal_id").references(() => deals.id, { onDelete: "cascade" })'
    );
  });

  it("estimate alias backfill preserves legacy values before adding defaults", () => {
    const tenantStart = migrationSql.indexOf("ALTER TABLE %I.estimate_line_items");
    const tenantEnd = migrationSql.indexOf("CREATE INDEX IF NOT EXISTS estimate_line_items_deal_sort_idx", tenantStart);
    const tenantSql = migrationSql.slice(tenantStart, tenantEnd);

    expect(tenantSql).toContain("ADD COLUMN IF NOT EXISTS qty numeric(12, 2)");
    expect(tenantSql).toContain("ADD COLUMN IF NOT EXISTS rate numeric(14, 2)");
    expect(tenantSql).toContain("ADD COLUMN IF NOT EXISTS total numeric(14, 2)");
    expect(tenantSql).toContain("ADD COLUMN IF NOT EXISTS sort_order integer");
    expect(tenantSql).not.toContain("ADD COLUMN IF NOT EXISTS qty numeric(12, 2) DEFAULT 1");
    expect(tenantSql).not.toContain("qty = COALESCE(eli.qty");
    expect(tenantSql).toContain("qty = round(eli.quantity, 2)");
    expect(tenantSql).toContain("rate = eli.unit_price");
    expect(tenantSql).toContain("total = eli.total_price");
    expect(tenantSql).toContain("sort_order = eli.display_order");
    expect(tenantSql).toContain("WHERE eli.section_id = es.id");
    expect(tenantSql).toContain("AND eli.qty IS NULL");
    expect(tenantSql).toContain("ALTER COLUMN qty SET DEFAULT 1");
    expect(tenantSql).toContain("ALTER COLUMN rate SET DEFAULT 0");
    expect(tenantSql).toContain("ALTER COLUMN total SET DEFAULT 0");
    expect(tenantSql).toContain("ALTER COLUMN sort_order SET DEFAULT 0");
  });

  it("estimate alias backfill skips orphan sections without violating FK", () => {
    expect(migrationSql).toContain("LEFT JOIN %I.deals d ON d.id = es.deal_id");
    expect(migrationSql).toContain("LEFT JOIN deals d ON d.id = es.deal_id");
    expect(migrationSql).toContain("AND (es.deal_id IS NULL OR d.id IS NOT NULL)");
    expect(migrationSql).toContain("label = COALESCE(eli.label, eli.description)");
    expect(migrationSql).toContain("qty = round(eli.quantity, 2)");
    expect(migrationSql).toContain("rate = eli.unit_price");
    expect(migrationSql).toContain("total = eli.total_price");
    expect(migrationSql).toContain("sort_order = eli.display_order");
  });

  it("rate column matches unit_price precision", () => {
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS rate numeric(14, 2)");
    expect(migrationSql).not.toContain("ADD COLUMN IF NOT EXISTS rate numeric(12, 2)");
    expect(estimateLineItemsSchema).toContain('rate: numeric("rate", { precision: 14, scale: 2 })');
    expect(estimateLineItemsSchema).toContain('unitPrice: numeric("unit_price", { precision: 14, scale: 2 })');
  });

  it("deal_contacts dedupes across primary and association backfill passes", () => {
    expect(migrationSql).toContain("UNIQUE (deal_id, contact_id)");
    expect(migrationSql).not.toContain("UNIQUE (deal_id, contact_id, role_on_deal)");
    expect(migrationSql).toContain("ON CONFLICT (deal_id, contact_id) DO NOTHING");
    expect(migrationSql).not.toContain("ON CONFLICT (deal_id, contact_id, role_on_deal) DO NOTHING");
    expect(migrationSql).not.toContain("deal_contacts_one_primary_per_deal_uidx");
  });

  it("keeps the Drizzle deal_contacts schema aligned with the migrated unique key", () => {
    expect(dealContactsSchema).toContain(
      'unique("deal_contacts_deal_id_contact_id_key").on(table.dealId, table.contactId)'
    );
    expect(dealContactsSchema).not.toContain("unique().on(table.dealId, table.contactId, table.roleOnDeal)");
    expect(dealContactsSchema).not.toContain("deal_contacts_one_primary_per_deal_uidx");
  });

  it("deal_contacts has expected btree indexes from migration", () => {
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS deal_contacts_deal_idx ON %I.deal_contacts (deal_id, role_on_deal)");
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS deal_contacts_contact_idx ON %I.deal_contacts (contact_id)");
    expect(dealContactsSchema).toContain(
      'index("deal_contacts_deal_idx").on(table.dealId, table.roleOnDeal)'
    );
    expect(dealContactsSchema).toContain(
      'index("deal_contacts_contact_idx").on(table.contactId)'
    );
  });

  it("keeps the Drizzle deals schema aligned with the project_number partial unique index", () => {
    expect(dealsSchema).toContain(
      'uniqueIndex("deals_project_number_uidx").on(table.projectNumber).where(sql`${table.projectNumber} IS NOT NULL`)'
    );
  });
});
