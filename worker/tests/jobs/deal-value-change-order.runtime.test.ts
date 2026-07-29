import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// rep-performance-rollup imports the worker pool at module load; nothing in this file executes a job, so a
// stub is enough to reach its value-chain constant (same idiom as at-risk-close-target.test.ts).
vi.mock("../../src/db.js", () => ({ pool: { connect: vi.fn() }, db: {} }));

import {
  workerCurrentDealValueSql,
  workerEffectiveCurrentDealValueSql,
} from "../../src/jobs/deal-value-sql.js";
import { awardedFirstDealValueSql } from "../../src/jobs/rep-performance-rollup.js";

/**
 * REAL-SQL (PGlite) proof that the three WORKER value chains resolve a change-order child deal from
 * awarded_amount VERBATIM — so a DEDUCTIVE (negative) CO reports its negative instead of falling through
 * every `> 0` candidate to $0 — while staying byte-for-byte INERT for a normal deal and a positive CO.
 *
 * The chains under test are the PRODUCTION builders/strings, not reproductions: a hand-copied paste would
 * keep passing while the real worker SQL drifted, which is exactly the class of bug this branch retires.
 */

const D = {
  normal: "normal",
  coPos: "co_pos",
  coNeg: "co_neg",
  coZero: "co_zero",
  coNegFarOut: "co_neg_far_out",
};

let db: PGlite;

/** The large-loss alert's inline chain, read out of the PRODUCTION source rather than retyped. */
function largeLossDealValueExpression(): string {
  const source = fs.readFileSync(fileURLToPath(new URL("../../src/jobs/index.ts", import.meta.url)), "utf8");
  // `[^\`]` keeps the match inside ONE template literal, so an earlier query in the file can't be
  // stitched onto this one's tail.
  const match = source.match(/`SELECT\s+([^`]*?)::numeric AS deal_value/);
  if (!match) {
    throw new Error("could not locate the large-loss deal_value expression in worker/src/jobs/index.ts");
  }
  return match[1];
}

async function evaluate(expression: string): Promise<Map<string, number>> {
  const { rows } = await db.query<{ id: string; v: string }>(
    `SELECT d.id, (${expression})::numeric::text AS v FROM deals d ORDER BY d.id`
  );
  return new Map(rows.map((r) => [r.id, Number(r.v)]));
}

/** The unaliased large-loss chain reads bare column names, so it needs its own (alias-free) projection. */
async function evaluateUnaliased(expression: string): Promise<Map<string, number>> {
  const { rows } = await db.query<{ id: string; v: string }>(
    `SELECT id, (${expression})::numeric::text AS v FROM deals ORDER BY id`
  );
  return new Map(rows.map((r) => [r.id, Number(r.v)]));
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`SET TimeZone='UTC';`);
  await db.exec(`
    CREATE TABLE pipeline_stage_config (id text PRIMARY KEY, slug text NOT NULL);
    INSERT INTO pipeline_stage_config (id, slug) VALUES ('won', 'won'), ('estimating', 'estimating');
    CREATE TABLE deals (
      id text PRIMARY KEY,
      stage_id text NOT NULL,
      bid_board_stage_slug text,
      is_change_order boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false,
      expected_close_date date,
      bid_due_date timestamptz,
      awarded_amount numeric(14,2),
      bid_board_total_sales numeric(14,2),
      bid_estimate numeric(14,2),
      dd_estimate numeric(14,2),
      is_active boolean NOT NULL DEFAULT true
    );
    -- A normal deal whose awarded and bid-board amounts DIFFER, so the two worker chains stay
    -- distinguishable: the digest/rollup chain is deliberately bid-board-FIRST, the rollup's
    -- closed-value chain is awarded-first. Nothing here may flatten that divergence.
    INSERT INTO deals (id, stage_id, is_change_order, awarded_amount, bid_board_total_sales, bid_estimate, dd_estimate)
    VALUES ('${D.normal}', 'won', false, 1000.00, 2000.00, 3000.00, 4000.00);
    -- CO children mirror prod: awarded_amount is the ONLY populated value column (all 30 in prod).
    INSERT INTO deals (id, stage_id, is_change_order, awarded_amount) VALUES
      ('${D.coPos}',  'won', true,  25000.00),
      ('${D.coNeg}',  'won', true, -50000.00),
      ('${D.coZero}', 'won', true,      0.00);
    -- Same deductive CO, but with a far-out close target: the effective wrapper must still zero it.
    INSERT INTO deals (id, stage_id, is_change_order, awarded_amount, expected_close_date)
    VALUES ('${D.coNegFarOut}', 'won', true, -50000.00, '2099-12-31');
  `);
}, 30000);

afterAll(async () => {
  await db?.close();
});

describe("workerCurrentDealValueSql — the digest/rollup chain", () => {
  it("keeps its deliberate BID-BOARD-FIRST order for a normal deal", async () => {
    const values = await evaluate(workerCurrentDealValueSql("d"));
    // 2000 (bid_board_total_sales), NOT 1000 (awarded) — the documented divergence from the server chain.
    expect(values.get(D.normal)).toBe(2000);
  });

  it("is INERT for a POSITIVE change order", async () => {
    const values = await evaluate(workerCurrentDealValueSql("d"));
    expect(values.get(D.coPos)).toBe(25000);
  });

  it("returns the NEGATIVE amount for a deductive change order", async () => {
    const values = await evaluate(workerCurrentDealValueSql("d"));
    expect(values.get(D.coNeg)).toBe(-50000);
  });

  it("returns 0 for a zero-amount change order", async () => {
    const values = await evaluate(workerCurrentDealValueSql("d"));
    expect(values.get(D.coZero)).toBe(0);
  });
});

describe("workerEffectiveCurrentDealValueSql — the auto-park wrapper still applies", () => {
  it("carries the deductive CO's negative through when the close target is not far out", async () => {
    const values = await evaluate(workerEffectiveCurrentDealValueSql("d"));
    expect(values.get(D.coNeg)).toBe(-50000);
  });

  it("still zeroes a far-out (auto-parked) deal, change order or not", async () => {
    const values = await evaluate(workerEffectiveCurrentDealValueSql("d"));
    expect(values.get(D.coNegFarOut)).toBe(0);
  });
});

describe("rep-performance-rollup awardedFirstDealValueSql — the closed-value chain", () => {
  it("stays awarded-first for a normal deal", async () => {
    const values = await evaluate(awardedFirstDealValueSql);
    expect(values.get(D.normal)).toBe(1000); // awarded, NOT the bid-board 2000
  });

  it("is INERT for a POSITIVE change order and returns the NEGATIVE for a deductive one", async () => {
    const values = await evaluate(awardedFirstDealValueSql);
    expect(values.get(D.coPos)).toBe(25000);
    expect(values.get(D.coNeg)).toBe(-50000);
    expect(values.get(D.coZero)).toBe(0);
  });
});

describe("large-loss alert deal_value chain (worker/src/jobs/index.ts)", () => {
  it("stays awarded-first for a normal deal", async () => {
    const values = await evaluateUnaliased(largeLossDealValueExpression());
    expect(values.get(D.normal)).toBe(1000);
  });

  it("is INERT for a POSITIVE change order and returns the NEGATIVE for a deductive one", async () => {
    const values = await evaluateUnaliased(largeLossDealValueExpression());
    expect(values.get(D.coPos)).toBe(25000);
    expect(values.get(D.coNeg)).toBe(-50000);
  });
});
