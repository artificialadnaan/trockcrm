import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { aliasedDealAwardedFirstWithFallbackSql } from "../../../src/modules/shared/deal-value-sql.js";

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const D = { normal: U("d001"), coPos: U("d002"), coNeg: U("d003"), coZeroish: U("d004") };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  tdb = drizzle(pg);
  await tdb.execute(sql`
    CREATE TABLE deals (
      id uuid PRIMARY KEY,
      is_change_order boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false,
      awarded_amount numeric(14,2),
      bid_board_total_sales numeric(14,2),
      bid_estimate numeric(14,2),
      dd_estimate numeric(14,2)
    )
  `);
  // A normal deal that must keep falling through awarded -> bid_board -> bid -> dd.
  await tdb.execute(sql`
    INSERT INTO deals (id, is_change_order, awarded_amount, bid_board_total_sales, bid_estimate, dd_estimate)
    VALUES (${D.normal}, false, NULL, NULL, 7500.00, 9000.00)
  `);
  // CO children mirror prod: awarded_amount is the ONLY populated value column.
  await tdb.execute(sql`
    INSERT INTO deals (id, is_change_order, awarded_amount) VALUES
      (${D.coPos}, true, 25000.00),
      (${D.coNeg}, true, -50000.00),
      (${D.coZeroish}, true, 0.00)
  `);
});

afterAll(async () => {
  await pg.close();
});

// The chain EXACTLY as it existed before this change — the reconciliation baseline.
const LEGACY_CHAIN = `COALESCE(
  CASE WHEN d.awarded_amount > 0 THEN d.awarded_amount END,
  CASE WHEN d.bid_board_total_sales > 0 THEN d.bid_board_total_sales END,
  CASE WHEN d.bid_estimate > 0 THEN d.bid_estimate END,
  CASE WHEN d.dd_estimate > 0 THEN d.dd_estimate END,
  0)`;

async function valueFor(id: string): Promise<{ next: number; legacy: number }> {
  const res = await tdb.execute(sql`
    SELECT ${aliasedDealAwardedFirstWithFallbackSql("d")}::numeric AS next,
           ${sql.raw(LEGACY_CHAIN)}::numeric AS legacy
    FROM deals d WHERE d.id = ${id}
  `);
  const row = (Array.isArray(res) ? res : res.rows)[0];
  return { next: Number(row.next), legacy: Number(row.legacy) };
}

describe("change-order-aware deal value chain", () => {
  it("is INERT for a normal deal (still falls through to bid_estimate)", async () => {
    const { next, legacy } = await valueFor(D.normal);
    expect(next).toBe(7500);
    expect(next).toBe(legacy);
  });

  it("is INERT for a POSITIVE change order — the reconciliation guarantee", async () => {
    const { next, legacy } = await valueFor(D.coPos);
    expect(next).toBe(25000);
    expect(next).toBe(legacy);
  });

  it("returns the NEGATIVE amount for a deductive change order", async () => {
    const { next, legacy } = await valueFor(D.coNeg);
    expect(next).toBe(-50000);
    // The whole reason this change exists: the legacy chain silently reported $0.
    expect(legacy).toBe(0);
  });

  it("returns 0 for a zero-amount change order", async () => {
    const { next } = await valueFor(D.coZeroish);
    expect(next).toBe(0);
  });
});
