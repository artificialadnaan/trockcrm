import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0169 backfills the empty contact_deal_associations (cda) join table from
 * deals.primary_contact_id (HubSpot held the edges; migration 0027 repaired the deal-side column but
 * never re-seeded cda, so worker jobs reading cda run dry). This asserts the SQL file shape so the
 * per-office DO-loop, the contacts EXISTS FK guard, ON CONFLICT DO NOTHING idempotency, the
 * TENANT_SCHEMA block, and the "no CONCURRENTLY in a txn" rule cannot regress.
 */
const migrationPath = resolve(
  import.meta.dirname,
  "../../../../migrations/0169_backfill_contact_deal_associations.sql"
);

describe("migration 0169 — backfill contact_deal_associations", () => {
  const sql = readFileSync(migrationPath, "utf8");

  it("iterates per-office tenant schemas, skipping system schemas", () => {
    expect(sql).toContain("DO $mig$");
    expect(sql).toContain("FOR tenant_schema IN");
    expect(sql).toContain("information_schema.schemata");
    expect(sql).toContain("'public', 'information_schema', 'pg_catalog', 'migration'");
    expect(sql).toContain("NOT LIKE 'pg_%'");
  });

  it("guards both the source and target tables with to_regclass before inserting", () => {
    expect(sql).toContain("to_regclass(format('%I.deals', tenant_schema))");
    expect(sql).toContain(
      "to_regclass(format('%I.contact_deal_associations', tenant_schema))"
    );
    expect(sql).toContain("CONTINUE;");
  });

  it("inserts the primary edge (is_primary=true) keyed off deals.primary_contact_id", () => {
    expect(sql).toContain(
      "INSERT INTO %I.contact_deal_associations (contact_id, deal_id, is_primary)"
    );
    expect(sql).toContain("SELECT d.primary_contact_id, d.id, true");
    expect(sql).toContain("WHERE d.primary_contact_id IS NOT NULL");
  });

  it("FK-guards the insert with an EXISTS check against contacts so dangling pointers are skipped", () => {
    expect(sql).toContain(
      "EXISTS (SELECT 1 FROM %I.contacts c WHERE c.id = d.primary_contact_id)"
    );
  });

  it("is idempotent / replayable via ON CONFLICT (contact_id, deal_id) DO NOTHING", () => {
    // Matches the UNIQUE(contact_id, deal_id) constraint; both the DO-loop and TENANT_SCHEMA block use it.
    const matches = sql.match(/ON CONFLICT \(contact_id, deal_id\) DO NOTHING/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("includes a TENANT_SCHEMA block (office_dallas literal) for newly provisioned tenants", () => {
    expect(sql).toContain("-- TENANT_SCHEMA_START");
    expect(sql).toContain("-- TENANT_SCHEMA_END");
    expect(sql).toContain(
      "INSERT INTO office_dallas.contact_deal_associations (contact_id, deal_id, is_primary)"
    );
    expect(sql).toContain(
      "EXISTS (SELECT 1 FROM office_dallas.contacts c WHERE c.id = d.primary_contact_id)"
    );
  });

  it("does not misuse CREATE INDEX CONCURRENTLY inside the DO/txn block", () => {
    expect(sql).not.toContain("CONCURRENTLY");
  });
});
