// Executes migration 0202 FROM DISK against 0062-shaped DDL on a real Postgres (PGlite).
//
// 0202 drops deal_signed_commissions' amount / source_value_amount non-negative CHECKs so a DEDUCTIVE
// change order can mint its NEGATIVE owner commission row (the claw-back). Before it, that INSERT raised
// SQLSTATE 23514 inside the deal-signing transaction, which ABORTED the transaction — so the whole change
// order rolled back even though addDealChangeOrder caught the JS error.
//
// Three things are checked here that a fixture-level test cannot:
//   1. The migration FILE carries BOTH required blocks — the `DO $tenant$` loop over office_% schemas AND
//      the `-- TENANT_SCHEMA_START/END` section the office provisioner clones for a NEW tenant. A migration
//      with only one of the two is a latent bug: either existing offices or all future ones miss the change.
//   2. Running it TWICE is a no-op (idempotent / replayable).
//   3. It drops exactly the two intended constraints and leaves the rate-bounds + source-value-kind CHECKs
//      standing — the claw-back opens up the sign on the MONEY, never on the rate.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION_PATH = join(
  __dirname,
  "../../../migrations/0202_dsc_drop_non_negative_checks.sql",
);
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf-8");

const START_MARKER = "-- TENANT_SCHEMA_START";
const END_MARKER = "-- TENANT_SCHEMA_END";

/** The office provisioner's own extraction, mirrored: the block between the markers with the
 *  office_dallas placeholder rewritten to the target schema. (server/src/modules/office/service.ts) */
function tenantBlockFor(schema: string): string {
  const startIdx = MIGRATION_SQL.indexOf(START_MARKER);
  const endIdx = MIGRATION_SQL.indexOf(END_MARKER);
  return MIGRATION_SQL.substring(startIdx + START_MARKER.length, endIdx)
    .trim()
    .replaceAll("office_dallas", schema);
}

/** Migration 0062's deal_signed_commissions, verbatim in the constraints that matter. */
async function seed0062Schema(pg: PGlite, schema: string) {
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS ${schema};
    CREATE TABLE ${schema}.deals (id uuid PRIMARY KEY);
    CREATE TABLE ${schema}.deal_signed_commissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid NOT NULL REFERENCES ${schema}.deals(id) ON DELETE CASCADE,
      rep_user_id uuid NOT NULL,
      source_value_kind TEXT NOT NULL,
      source_value_amount NUMERIC(14,2) NOT NULL,
      applied_rate NUMERIC(7,6) NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      contract_signed_date_at_signing DATE NOT NULL,
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT deal_signed_commissions_dedup UNIQUE (deal_id, rep_user_id),
      CONSTRAINT deal_signed_commissions_amount_non_negative_chk CHECK (amount >= 0),
      CONSTRAINT deal_signed_commissions_source_value_non_negative_chk CHECK (source_value_amount >= 0),
      CONSTRAINT deal_signed_commissions_rate_bounds_chk CHECK (applied_rate >= 0 AND applied_rate <= 1),
      CONSTRAINT deal_signed_commissions_source_value_kind_chk CHECK (
        source_value_kind IN ('awarded_amount', 'bid_estimate', 'dd_estimate')
      )
    );
  `);
}

async function checkNames(pg: PGlite, schema: string): Promise<string[]> {
  const { rows } = await pg.query<{ conname: string }>(
    `SELECT c.conname FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = '${schema}' AND t.relname = 'deal_signed_commissions' AND c.contype = 'c'
     ORDER BY c.conname`,
  );
  return rows.map((r) => r.conname);
}

const DEAL = "00000000-0000-4000-8000-0000000000d1";
const REP = "00000000-0000-4000-8000-0000000000a1";

/** The claw-back row a deductive change order mints: negative money at a positive rate. */
async function insertClawBack(pg: PGlite, schema: string) {
  await pg.exec(`INSERT INTO ${schema}.deals (id) VALUES ('${DEAL}') ON CONFLICT DO NOTHING;`);
  await pg.exec(
    `INSERT INTO ${schema}.deal_signed_commissions
       (deal_id, rep_user_id, source_value_kind, source_value_amount, applied_rate, amount, contract_signed_date_at_signing)
     VALUES ('${DEAL}', '${REP}', 'awarded_amount', -50000, 0.100000, -5000, '2027-05-01')`,
  );
}

let pg: PGlite;
beforeEach(async () => {
  pg = new PGlite();
});
afterEach(async () => {
  await pg?.close();
});

describe("migration 0202 — deal_signed_commissions non-negative CHECKs", () => {
  it("carries BOTH required blocks: the office_% DO-loop AND the TENANT_SCHEMA provisioner section", () => {
    expect(MIGRATION_SQL).toContain("DO $tenant$");
    expect(MIGRATION_SQL).toContain(`nspname LIKE 'office\\_%' ESCAPE '\\'`);
    expect(MIGRATION_SQL).toContain(START_MARKER);
    expect(MIGRATION_SQL).toContain(END_MARKER);
    // The provisioner clones ONLY the marker block, so the drops must appear inside it — not just in the loop.
    const block = tenantBlockFor("office_dallas");
    expect(block).toContain("deal_signed_commissions_amount_non_negative_chk");
    expect(block).toContain("deal_signed_commissions_source_value_non_negative_chk");
  });

  it("REPRODUCES the blocker on the pre-0202 schema: the claw-back row raises 23514", async () => {
    await seed0062Schema(pg, "office_dallas");
    await expect(insertClawBack(pg, "office_dallas")).rejects.toThrow(
      /deal_signed_commissions_amount_non_negative_chk/,
    );
  });

  it("applied to an EXISTING office_% schema, drops the two sign CHECKs and lets the claw-back land", async () => {
    await seed0062Schema(pg, "office_dallas");
    await pg.exec(MIGRATION_SQL);

    expect(await checkNames(pg, "office_dallas")).toEqual([
      "deal_signed_commissions_rate_bounds_chk",
      "deal_signed_commissions_source_value_kind_chk",
    ]);
    await insertClawBack(pg, "office_dallas");
    const { rows } = await pg.query<{ amount: string; source_value_amount: string }>(
      `SELECT amount, source_value_amount FROM office_dallas.deal_signed_commissions`,
    );
    expect(Number(rows[0].amount)).toBeCloseTo(-5000, 2);
    expect(Number(rows[0].source_value_amount)).toBeCloseTo(-50000, 2);
  });

  it("reaches EVERY office_% schema, and skips a schema without the table", async () => {
    await seed0062Schema(pg, "office_dallas");
    await seed0062Schema(pg, "office_atlanta");
    // An office schema that predates the table — the loop's to_regclass guard must CONTINUE past it.
    await pg.exec(`CREATE SCHEMA office_empty;`);

    await pg.exec(MIGRATION_SQL);

    for (const schema of ["office_dallas", "office_atlanta"]) {
      expect(await checkNames(pg, schema)).toEqual([
        "deal_signed_commissions_rate_bounds_chk",
        "deal_signed_commissions_source_value_kind_chk",
      ]);
    }
  });

  it("is IDEMPOTENT: applying it twice is a no-op and leaves the same constraint set", async () => {
    await seed0062Schema(pg, "office_dallas");
    await pg.exec(MIGRATION_SQL);
    const afterFirst = await checkNames(pg, "office_dallas");
    await pg.exec(MIGRATION_SQL); // replay — must not throw
    expect(await checkNames(pg, "office_dallas")).toEqual(afterFirst);
    await insertClawBack(pg, "office_dallas");
  });

  it("the TENANT_SCHEMA block runs standalone on a FRESH schema (what the office provisioner clones)", async () => {
    // The provisioner replays every migration's marker block against a brand-new office schema. Here the
    // constraints were never created, so the block must still succeed (DROP ... IF EXISTS) — twice.
    await seed0062Schema(pg, "office_houston");
    const block = tenantBlockFor("office_houston");
    await pg.exec(block);
    await pg.exec(block);
    expect(await checkNames(pg, "office_houston")).toEqual([
      "deal_signed_commissions_rate_bounds_chk",
      "deal_signed_commissions_source_value_kind_chk",
    ]);
    await insertClawBack(pg, "office_houston");
  });

  it("KEEPS the rate-bounds and source-value-kind CHECKs — the sign opens on the money, never the rate", async () => {
    await seed0062Schema(pg, "office_dallas");
    await pg.exec(MIGRATION_SQL);
    await pg.exec(`INSERT INTO office_dallas.deals (id) VALUES ('${DEAL}');`);
    const insert = (kind: string, rate: string) =>
      pg.exec(
        `INSERT INTO office_dallas.deal_signed_commissions
           (deal_id, rep_user_id, source_value_kind, source_value_amount, applied_rate, amount, contract_signed_date_at_signing)
         VALUES ('${DEAL}', '${REP}', '${kind}', -50000, ${rate}, -5000, '2027-05-01')`,
      );
    await expect(insert("awarded_amount", "-0.100000")).rejects.toThrow(
      /deal_signed_commissions_rate_bounds_chk/,
    );
    await expect(insert("not_a_real_kind", "0.100000")).rejects.toThrow(
      /deal_signed_commissions_source_value_kind_chk/,
    );
  });
});
