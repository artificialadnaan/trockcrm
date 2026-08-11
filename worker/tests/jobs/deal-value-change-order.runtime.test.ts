import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  workerAwardedFirstDealValueSql,
  workerCurrentDealValueSql,
  workerEffectiveCurrentDealValueSql,
} from "../../src/jobs/deal-value-sql.js";

/**
 * REAL-SQL (PGlite) proof that the WORKER value chains resolve a change-order child deal from
 * awarded_amount VERBATIM — so a DEDUCTIVE (negative) CO reports its negative instead of falling through
 * every `> 0` candidate to $0 — while staying byte-for-byte INERT for a normal deal and a positive CO.
 *
 * The chains under test are the PRODUCTION builders, not reproductions: a hand-copied paste would keep
 * passing while the real worker SQL drifted, which is exactly the class of bug this branch retires.
 * deal-value-sql.ts is a leaf module (no pool/db import), so importing it here needs no mocks.
 */

const D = {
  normal: "normal",
  coPos: "co_pos",
  coNeg: "co_neg",
  coZero: "co_zero",
  coNegFarOut: "co_neg_far_out",
};

let db: PGlite;

/** Raw text per row, so a NULL stays distinguishable from 0 (`Number(null)` is 0 — a silent false pass). */
async function evaluate(expression: string): Promise<Map<string, string | null>> {
  const { rows } = await db.query<{ id: string; v: string | null }>(
    `SELECT d.id, (${expression})::numeric::text AS v FROM deals d ORDER BY d.id`
  );
  return new Map(rows.map((r) => [r.id, r.v]));
}

/** Assert the expression produced a value at all, THEN compare it numerically. */
function valueOf(values: Map<string, string | null>, id: string): number {
  const raw = values.get(id);
  expect(raw, `row ${id} missing from the result set`).toBeDefined();
  expect(raw, `row ${id} produced no value`).not.toBeNull();
  return Number(raw);
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
    -- distinguishable: the open/digest chain is deliberately bid-board-FIRST, the closed chain is
    -- awarded-first. Nothing here may flatten that divergence.
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

describe("workerCurrentDealValueSql — the OPEN/digest/rollup chain", () => {
  it("keeps its deliberate BID-BOARD-FIRST order for a normal deal", async () => {
    const values = await evaluate(workerCurrentDealValueSql("d"));
    // 2000 (bid_board_total_sales), NOT 1000 (awarded) — the documented divergence from the server chain.
    expect(valueOf(values, D.normal)).toBe(2000);
  });

  it("is INERT for a POSITIVE change order", async () => {
    const values = await evaluate(workerCurrentDealValueSql("d"));
    expect(valueOf(values, D.coPos)).toBe(25000);
  });

  it("returns the NEGATIVE amount for a deductive change order", async () => {
    const values = await evaluate(workerCurrentDealValueSql("d"));
    expect(valueOf(values, D.coNeg)).toBe(-50000);
  });

  it("returns 0 for a zero-amount change order", async () => {
    const values = await evaluate(workerCurrentDealValueSql("d"));
    expect(valueOf(values, D.coZero)).toBe(0);
  });
});

describe("workerEffectiveCurrentDealValueSql — the auto-park wrapper still applies", () => {
  it("carries the deductive CO's negative through when the close target is not far out", async () => {
    const values = await evaluate(workerEffectiveCurrentDealValueSql("d"));
    expect(valueOf(values, D.coNeg)).toBe(-50000);
  });

  it("still zeroes a far-out (auto-parked) deal, change order or not", async () => {
    const values = await evaluate(workerEffectiveCurrentDealValueSql("d"));
    expect(valueOf(values, D.coNegFarOut)).toBe(0);
  });
});

describe("workerAwardedFirstDealValueSql — the CLOSED chain (rollup closed_value + large-loss alert)", () => {
  it("stays awarded-first for a normal deal", async () => {
    const values = await evaluate(workerAwardedFirstDealValueSql("d"));
    expect(valueOf(values, D.normal)).toBe(1000); // awarded, NOT the bid-board 2000
  });

  it("is INERT for a POSITIVE change order and returns the NEGATIVE for a deductive one", async () => {
    const values = await evaluate(workerAwardedFirstDealValueSql("d"));
    expect(valueOf(values, D.coPos)).toBe(25000);
    expect(valueOf(values, D.coNeg)).toBe(-50000);
    expect(valueOf(values, D.coZero)).toBe(0);
  });
});

describe("the closed-chain CONSUMERS compose the shared builder rather than re-pasting it", () => {
  // ROT GUARD: the value assertions above run the builder directly, so they would stay green if a job
  // quietly went back to an inline chain. These pin that each consumer still routes through it.
  it("the large-loss alert query interpolates the shared builder on an aliased deals table", () => {
    const source = fs.readFileSync(fileURLToPath(new URL("../../src/jobs/index.ts", import.meta.url)), "utf8");

    expect(source).toContain('${workerAwardedFirstDealValueSql("d")})::numeric AS deal_value');
    expect(source).toContain(".deals d WHERE d.id = $1");
    // No inline `awarded_amount > 0` chain left anywhere in the job registry.
    expect(source).not.toMatch(/awarded_amount\s*>\s*0/);
  });

  it("the rep-performance rollup's closed_value uses the shared builder", () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL("../../src/jobs/rep-performance-rollup.ts", import.meta.url)),
      "utf8"
    );

    expect(source).toContain('workerAwardedFirstDealValueSql("d")');
    expect(source).not.toMatch(/awarded_amount\s*>\s*0/);
  });
});
