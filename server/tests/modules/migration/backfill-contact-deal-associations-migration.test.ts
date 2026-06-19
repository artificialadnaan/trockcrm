import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0169 backfills the empty contact_deal_associations (cda) join table from
 * deals.primary_contact_id (HubSpot held the edges; migration 0027 repaired the deal-side column but
 * never re-seeded cda, so worker jobs reading cda run dry). This asserts the SQL file shape so the
 * per-office DO-loop, the active-deal + active-contact filters (matching the createAssociation writer),
 * the promote-on-conflict (DO UPDATE SET is_primary) behavior, the TENANT_SCHEMA block, and the
 * "no CONCURRENTLY in a txn" rule cannot regress.
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

  it("FK-guards the insert against ACTIVE contacts (mirrors createAssociation requiring an active contact)", () => {
    expect(sql).toContain(
      "EXISTS (SELECT 1 FROM %I.contacts c WHERE c.id = d.primary_contact_id AND c.is_active = true)"
    );
  });

  it("skips inactive/archived deals AND contacts in both blocks (active-only, matching app semantics)", () => {
    // An archived deal or contact must not resurface a primary edge on the Primary Contacts card / APIs.
    expect((sql.match(/d\.is_active = true/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((sql.match(/c\.is_active = true/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("promotes conflicting pairs to primary (idempotent) via ON CONFLICT DO UPDATE SET is_primary = true", () => {
    // Both the DO-loop and the TENANT_SCHEMA block promote an existing edge to primary rather than skip it,
    // so the deal's one primary is always marked; re-running sets the same true (idempotent). No DO NOTHING.
    const matches = sql.match(/ON CONFLICT \(contact_id, deal_id\) DO UPDATE SET is_primary = true/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(sql).not.toContain("DO NOTHING");
  });

  it("demotes any OTHER existing primary on the deal before promoting (one primary per deal, both blocks)", () => {
    // Without this, a deal with a different cda primary + a matching deals.primary_contact_id would end
    // with TWO is_primary=true rows; readers join on is_primary=true. The demote clears the others first.
    const demotes = sql.match(/SET is_primary = false/g) ?? [];
    expect(demotes.length).toBeGreaterThanOrEqual(2); // DO-loop + TENANT_SCHEMA block
    const otherPrimary = sql.match(/cda\.contact_id <> d\.primary_contact_id/g) ?? [];
    expect(otherPrimary.length).toBeGreaterThanOrEqual(2);
    // (Demote-before-promote ordering + the actual single-primary outcome are proven by the companion
    // PGlite runtime test backfill-contact-deal-associations.runtime.test.ts, which executes both statements.)
  });

  it("includes a TENANT_SCHEMA block (office_dallas literal) for newly provisioned tenants", () => {
    expect(sql).toContain("-- TENANT_SCHEMA_START");
    expect(sql).toContain("-- TENANT_SCHEMA_END");
    expect(sql).toContain(
      "INSERT INTO office_dallas.contact_deal_associations (contact_id, deal_id, is_primary)"
    );
    expect(sql).toContain(
      "EXISTS (SELECT 1 FROM office_dallas.contacts c WHERE c.id = d.primary_contact_id AND c.is_active = true)"
    );
  });

  it("does not misuse CREATE INDEX CONCURRENTLY inside the DO/txn block", () => {
    expect(sql).not.toContain("CONCURRENTLY");
  });
});
