import { readFileSync } from "fs";
import { resolve } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

/**
 * REAL-SQL runtime proof (PGlite) of migration 0169's one-primary-per-deal semantics. Rather than hand-copy
 * the SQL (which could silently drift from the migration), this EXTRACTS the migration's own TENANT_SCHEMA
 * block — the office_dallas-literal demote + upsert the provisioner replays — rewrites the schema to the test
 * schema, and executes it, so the test proves the SHIPPED SQL. Asserts each deal ends with EXACTLY ONE
 * primary and that an inactive target never leaves a deal primary-less.
 */
const T = "office_bf";
const cid = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const did = (n: number) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, "0")}`;

// Pull the ACTUAL migration's TENANT_SCHEMA block (demote + upsert) and point it at the test schema, so this
// runtime test can never pass against SQL that differs from what migration 0169 ships.
function migrationTenantBlock(): string {
  const sql = readFileSync(
    resolve(import.meta.dirname, "../../../../migrations/0169_backfill_contact_deal_associations.sql"),
    "utf8"
  );
  const start = sql.indexOf("-- TENANT_SCHEMA_START");
  const end = sql.indexOf("-- TENANT_SCHEMA_END");
  if (start === -1 || end === -1 || end < start) throw new Error("0169 TENANT_SCHEMA block not found");
  return sql.slice(start, end).replace(/office_dallas/g, T);
}

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA ${T};
    CREATE TABLE ${T}.contacts (id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE ${T}.deals (
      id uuid PRIMARY KEY, primary_contact_id uuid, is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE ${T}.contact_deal_associations (
      contact_id uuid NOT NULL, deal_id uuid NOT NULL, role varchar(100),
      is_primary boolean NOT NULL DEFAULT false,
      UNIQUE (contact_id, deal_id)
    );
  `);
  // contacts: X1/Y1/X2/Y3/X4/X5 active; X3 INACTIVE.
  await pg.exec(`INSERT INTO ${T}.contacts (id, is_active) VALUES
    ('${cid(1)}',true),('${cid(11)}',true),('${cid(2)}',true),('${cid(3)}',false),
    ('${cid(13)}',true),('${cid(4)}',true),('${cid(5)}',true);`);
  await pg.exec(`INSERT INTO ${T}.deals (id, primary_contact_id, is_active) VALUES
    ('${did(1)}','${cid(1)}', true),   -- D1 active, primary X1; has a STALE primary (Y1) in cda
    ('${did(2)}','${cid(2)}', true),   -- D2 active, primary X2; no cda rows yet
    ('${did(3)}','${cid(3)}', true),   -- D3 active, primary X3 (INACTIVE); has a STALE primary (Y3)
    ('${did(4)}','${cid(4)}', false),  -- D4 INACTIVE deal — skipped entirely
    ('${did(5)}','${cid(5)}', true);   -- D5 active, primary X5; X5 exists in cda as NON-primary`);
  await pg.exec(`INSERT INTO ${T}.contact_deal_associations (contact_id, deal_id, is_primary) VALUES
    ('${cid(11)}','${did(1)}', true),   -- stale primary Y1 on D1
    ('${cid(13)}','${did(3)}', true),   -- stale primary Y3 on D3
    ('${cid(5)}', '${did(5)}', false);  -- manual non-primary X5 on D5`);

  // Run the ACTUAL shipped migration block (demote + upsert), schema-rewritten to the test schema.
  await pg.exec(migrationTenantBlock());
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

async function primaryContactsOf(dealNo: number): Promise<string[]> {
  const res = await pg.query<{ contact_id: string }>(
    `SELECT contact_id FROM ${T}.contact_deal_associations WHERE deal_id = $1 AND is_primary = true ORDER BY contact_id`,
    [did(dealNo)]
  );
  return res.rows.map((r) => r.contact_id);
}
async function rowCount(dealNo: number): Promise<number> {
  const res = await pg.query<{ n: number }>(
    `SELECT COUNT(*)::int n FROM ${T}.contact_deal_associations WHERE deal_id = $1`,
    [did(dealNo)]
  );
  return Number(res.rows[0]?.n ?? 0);
}

describe("migration 0169 — one-primary-per-deal (demote + upsert)", () => {
  it("D1: a STALE primary is demoted and the deal's primary_contact_id becomes the SOLE primary", async () => {
    expect(await primaryContactsOf(1)).toEqual([cid(1)]); // exactly one primary, and it is X1 (not stale Y1)
    expect(await rowCount(1)).toBe(2); // Y1 kept (demoted) + X1 (inserted)
  });

  it("D2: a deal with no prior cda rows gets its single primary inserted", async () => {
    expect(await primaryContactsOf(2)).toEqual([cid(2)]);
    expect(await rowCount(2)).toBe(1);
  });

  it("D3: an INACTIVE target contact is skipped AND the existing primary is NOT demoted (never primary-less)", async () => {
    // X3 is inactive → INSERT skips it; the demote is gated on an active target, so Y3 stays primary.
    expect(await primaryContactsOf(3)).toEqual([cid(13)]); // Y3 retained
    expect(await rowCount(3)).toBe(1); // X3 never inserted
  });

  it("D4: an inactive deal is untouched entirely", async () => {
    expect(await rowCount(4)).toBe(0);
  });

  it("D5: an existing NON-primary edge for the deal's primary_contact_id is promoted to primary", async () => {
    expect(await primaryContactsOf(5)).toEqual([cid(5)]);
    expect(await rowCount(5)).toBe(1);
  });

  it("no deal ever ends with more than one primary row", async () => {
    const res = await pg.query<{ deal_id: string; n: number }>(
      `SELECT deal_id, COUNT(*)::int n FROM ${T}.contact_deal_associations WHERE is_primary = true GROUP BY deal_id HAVING COUNT(*) > 1`
    );
    expect(res.rows).toEqual([]);
  });
});
