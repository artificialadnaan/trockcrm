import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(__dirname, "../../../../migrations/0133_ownership_schema_reconciliation.sql");
const migrationSql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const companiesSchema = readFileSync(
  resolve(__dirname, "../../../../shared/src/schema/tenant/companies.ts"),
  "utf8"
);
const contactsSchema = readFileSync(
  resolve(__dirname, "../../../../shared/src/schema/tenant/contacts.ts"),
  "utf8"
);

describe("ownership schema reconciliation migration", () => {
  it("replays across all tenant schemas using the inline startup migration pattern", () => {
    expect(migrationSql).toContain("WHERE nspname LIKE 'office\\_%' ESCAPE '\\'");
    expect(migrationSql).toContain("to_regclass(format('%I.companies', tenant_schema))");
    expect(migrationSql).toContain("to_regclass(format('%I.contacts', tenant_schema))");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_END");
  });

  it("consolidates company ownership onto owner_id without overwriting live values", () => {
    expect(migrationSql).toContain("ALTER TABLE %I.companies ADD COLUMN IF NOT EXISTS owner_id uuid");
    expect(migrationSql).toContain("UPDATE %I.companies");
    expect(migrationSql).toContain("SET owner_id = owner_user_id");
    expect(migrationSql).toContain("WHERE owner_id IS NULL AND owner_user_id IS NOT NULL");
    expect(migrationSql).toContain("owner_id IS NOT NULL");
    expect(migrationSql).toContain("owner_user_id IS NOT NULL");
    expect(migrationSql).toContain("owner_id <> owner_user_id");
    expect(migrationSql).toContain("DROP COLUMN IF EXISTS owner_user_id");
  });

  it("models one owner_id column for companies and contacts with users-table references", () => {
    expect(migrationSql).toContain("companies_owner_id_users_id_fk");
    expect(migrationSql).toContain("contacts_owner_id_users_id_fk");
    expect(migrationSql).toContain("REFERENCES public.users(id) ON DELETE SET NULL");
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS companies_owner_id_idx");
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS contacts_owner_id_idx");
    expect(companiesSchema).toContain('ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" })');
    expect(companiesSchema).not.toContain("ownerUserId");
    expect(companiesSchema).toContain('index("companies_owner_id_idx").on(table.ownerId).where');
    expect(contactsSchema).toContain('ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" })');
    expect(contactsSchema).toContain('index("contacts_owner_id_idx").on(table.ownerId).where');
  });
});
