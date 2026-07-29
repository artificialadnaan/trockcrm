import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

/**
 * REAL-SQL (PGlite) proof for scripts/verify-won-closed-date-parity.ts's VALUE_EXPR, lifted out of the
 * PRODUCTION source rather than retyped.
 *
 * That script is a read-only prod audit with no other coverage in the repo, and its VALUE_EXPR comment
 * claims to mirror aliasedEffectiveWonDealValueSql — so a drift there makes the audit disagree with the
 * app it is auditing, silently. This pins both halves of the claim: the change-order branch (a CO child is
 * valued from awarded_amount VERBATIM, negative included) AND the on-hold zeroing that wraps it.
 */

function parityValueExpression(): string {
  const source = readFileSync(
    resolve(__dirname, "../../../scripts/verify-won-closed-date-parity.ts"),
    "utf8"
  );
  const match = source.match(/const VALUE_EXPR = `([^`]*)`/);
  if (!match) {
    throw new Error("could not locate VALUE_EXPR in scripts/verify-won-closed-date-parity.ts");
  }
  return match[1];
}

const D = {
  normal: "normal",
  coPos: "co_pos",
  coNeg: "co_neg",
  coZero: "co_zero",
  coNegOnHold: "co_neg_on_hold",
};

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`SET TimeZone='UTC';`);
  await db.exec(`
    CREATE TABLE deals (
      id text PRIMARY KEY,
      is_change_order boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false,
      awarded_amount numeric(14,2),
      bid_board_total_sales numeric(14,2),
      bid_estimate numeric(14,2),
      dd_estimate numeric(14,2)
    );
    INSERT INTO deals (id, is_change_order, on_hold, awarded_amount, bid_estimate, dd_estimate) VALUES
      ('${D.normal}',      false, false, NULL,      7500.00, 9000.00),
      -- CO children mirror prod: awarded_amount is the ONLY populated value column.
      ('${D.coPos}',       true,  false,  25000.00, NULL,    NULL),
      ('${D.coNeg}',       true,  false, -50000.00, NULL,    NULL),
      ('${D.coZero}',      true,  false,      0.00, NULL,    NULL),
      ('${D.coNegOnHold}', true,  true,  -50000.00, NULL,    NULL);
  `);
}, 30000);

afterAll(async () => {
  await db?.close();
});

async function valueFor(id: string): Promise<number> {
  const { rows } = await db.query<{ v: string | null }>(
    `SELECT (${parityValueExpression()})::numeric::text AS v FROM deals d WHERE d.id = $1`,
    [id]
  );
  expect(rows[0]?.v, `row ${id} produced no value`).not.toBeNull();
  return Number(rows[0].v);
}

describe("verify-won-closed-date-parity VALUE_EXPR — the Won-value basis it audits against", () => {
  it("is INERT for a normal deal (still falls through to bid_estimate) and a positive CO", async () => {
    expect(await valueFor(D.normal)).toBe(7500);
    expect(await valueFor(D.coPos)).toBe(25000);
  });

  it("reports a deductive change order's NEGATIVE amount instead of $0", async () => {
    expect(await valueFor(D.coNeg)).toBe(-50000);
  });

  it("returns 0 for a zero-amount change order", async () => {
    expect(await valueFor(D.coZero)).toBe(0);
  });

  it("still zeroes an on-hold deal, change order or not", async () => {
    expect(await valueFor(D.coNegOnHold)).toBe(0);
  });
});
