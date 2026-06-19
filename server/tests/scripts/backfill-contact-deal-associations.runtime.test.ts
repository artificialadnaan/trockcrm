import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { backfillStatements, parseArgs } from "../../../scripts/backfill-contact-deal-associations.js";

/**
 * REAL-SQL runtime proof (PGlite) of the contact_deal_associations backfill's one-primary-per-deal
 * semantics. It executes the SCRIPT'S OWN exported `backfillStatements` (demote + active-only upsert) — the
 * exact SQL `--commit` runs — so the test can never pass against SQL that differs from what ships. Asserts
 * each deal ends with EXACTLY ONE primary and that an inactive target never leaves a deal primary-less.
 *
 * Fixture (active contacts X1/Y1/X2/Y3/X4/X5; INACTIVE X3):
 *   - D1 active, primary X1; cda has a STALE primary Y1 → Y1 demoted, X1 sole primary
 *   - D2 active, primary X2; no cda rows → X2 inserted
 *   - D3 active, primary X3 (INACTIVE); cda has stale primary Y3 → X3 skipped, Y3 KEPT (not demoted)
 *   - D4 INACTIVE deal → untouched
 *   - D5 active, primary X5; cda has X5 as NON-primary → promoted to primary
 */
const T = "office_bf";
const cid = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const did = (n: number) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, "0")}`;

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
  await pg.exec(`INSERT INTO ${T}.contacts (id, is_active) VALUES
    ('${cid(1)}',true),('${cid(11)}',true),('${cid(2)}',true),('${cid(3)}',false),
    ('${cid(13)}',true),('${cid(4)}',true),('${cid(5)}',true);`);
  await pg.exec(`INSERT INTO ${T}.deals (id, primary_contact_id, is_active) VALUES
    ('${did(1)}','${cid(1)}', true),
    ('${did(2)}','${cid(2)}', true),
    ('${did(3)}','${cid(3)}', true),
    ('${did(4)}','${cid(4)}', false),
    ('${did(5)}','${cid(5)}', true);`);
  await pg.exec(`INSERT INTO ${T}.contact_deal_associations (contact_id, deal_id, is_primary) VALUES
    ('${cid(11)}','${did(1)}', true),
    ('${cid(13)}','${did(3)}', true),
    ('${cid(5)}', '${did(5)}', false);`);

  // Execute the script's own statements (what --commit runs, in order) against the test schema.
  const { lock, demote, upsert } = backfillStatements(T);
  await pg.exec(lock);
  await pg.exec(demote);
  await pg.exec(upsert);
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

describe("backfillStatements — active-only + single-primary-per-deal (demote + upsert)", () => {
  it("the exported SQL carries the deal-row lock, the active filters, the demote, and the promote", () => {
    const { lock, demote, upsert } = backfillStatements(T);
    expect(lock).toContain("FOR UPDATE"); // serializes against createAssociation's deal-row lock
    expect(demote).toContain("SET is_primary = false");
    expect(demote).toContain("cda.contact_id <> d.primary_contact_id");
    expect(demote).toContain("d.is_active = true");
    expect(demote).toContain("c.is_active = true");
    expect(upsert).toContain("d.is_active = true");
    expect(upsert).toContain("c.is_active = true");
    expect(upsert).toContain("ON CONFLICT (contact_id, deal_id) DO UPDATE SET is_primary = true");
  });

  it("D1: a STALE primary is demoted and primary_contact_id becomes the SOLE primary", async () => {
    expect(await primaryContactsOf(1)).toEqual([cid(1)]);
    expect(await rowCount(1)).toBe(2); // Y1 kept (demoted) + X1 (inserted)
  });

  it("D2: a deal with no prior cda rows gets its single primary inserted", async () => {
    expect(await primaryContactsOf(2)).toEqual([cid(2)]);
    expect(await rowCount(2)).toBe(1);
  });

  it("D3: an INACTIVE target is skipped AND the existing primary is NOT demoted (never primary-less)", async () => {
    expect(await primaryContactsOf(3)).toEqual([cid(13)]); // Y3 retained
    expect(await rowCount(3)).toBe(1); // X3 never inserted
  });

  it("D4: an inactive deal is untouched entirely", async () => {
    expect(await rowCount(4)).toBe(0);
  });

  it("D5: an existing NON-primary edge for primary_contact_id is promoted to primary", async () => {
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

describe("parseArgs — dry-run by default (writes only on explicit --commit)", () => {
  it("no flags → dry-run (honors the documented default, never an error)", () => {
    expect(parseArgs([])).toEqual({ mode: "dry-run" });
  });
  it("--dry-run → dry-run, --commit → commit", () => {
    expect(parseArgs(["--dry-run"])).toEqual({ mode: "dry-run" });
    expect(parseArgs(["--commit"])).toEqual({ mode: "commit" });
  });
  it("both flags is rejected (ambiguous)", () => {
    expect(() => parseArgs(["--dry-run", "--commit"])).toThrow();
  });
  it("rejects unknown flags so a typo can't fall through to a full-scope commit", () => {
    expect(() => parseArgs(["--force"])).toThrow();
    expect(() => parseArgs(["--commit", "--office=dallas"])).toThrow();
  });
});
