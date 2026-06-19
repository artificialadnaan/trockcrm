import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0166 root-cause fix: partial per-office indexes on emails(contact_id, sent_at DESC) and
 * tasks(contact_id, updated_at DESC) so the contacts last_touch_at sort's SubPlan 6/7 become Index Only
 * Scans instead of full Seq Scans (~3.2s -> sub-second on prod office_dallas). This asserts the SQL file
 * shape so the per-office DO-loop, partial predicates, and "no CONCURRENTLY in a txn" rule cannot regress.
 */
const migrationPath = resolve(
  import.meta.dirname,
  "../../../../migrations/0166_contacts_touch_indexes.sql"
);

describe("migration 0166 — contacts touch indexes", () => {
  const sql = readFileSync(migrationPath, "utf8");

  it("creates both partial touch indexes mirroring activities_contact_idx", () => {
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS emails_contact_sent_at_idx ON %I.emails (contact_id, sent_at DESC) WHERE contact_id IS NOT NULL"
    );
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS tasks_contact_updated_at_idx ON %I.tasks (contact_id, updated_at DESC) WHERE contact_id IS NOT NULL"
    );
  });

  it("iterates per-office tenant schemas, skipping system schemas", () => {
    expect(sql).toContain("information_schema.schemata");
    expect(sql).toContain("'public', 'information_schema', 'pg_catalog', 'migration'");
    expect(sql).toContain("NOT LIKE 'pg_%'");
  });

  it("guards each table with to_regclass so tenant schemas missing the table are skipped", () => {
    expect(sql).toContain("to_regclass(format('%I.emails', tenant_schema))");
    expect(sql).toContain("to_regclass(format('%I.tasks', tenant_schema))");
  });

  it("uses plain CREATE INDEX (CONCURRENTLY is illegal inside a DO/txn block)", () => {
    expect(sql).not.toContain("CONCURRENTLY");
  });
});
