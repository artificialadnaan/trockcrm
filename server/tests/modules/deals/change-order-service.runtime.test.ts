import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  assertDealEligibleForChangeOrder,
  normalizeChangeOrderAmount,
} from "../../../src/modules/deals/change-order-service.js";

/**
 * REAL-SQL (PGlite) guard for the change-order service's pure + eligibility units: decimal-safe
 * positive-amount normalization and the Won-family / Bid-Board-Owned eligibility gate.
 *
 * The CRUD + counted-once behavior of the CHILD-DEAL model (create, list/sum/CCV union, update/delete
 * dual-path, the disjoint base+CO invariant) is covered in change-order-child-deal.runtime.test.ts,
 * which carries the full deals/deal_number_daily_sequences/audit harness the child-create path needs.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON_STAGE = U("a1");
const ESTIMATING_STAGE = U("a2");
const OPP_STAGE = U("a3");
const DEAL_WON = U("d01");
const DEAL_BBO = U("d02"); // bid-board-owned, NOT won
const DEAL_PLAIN = U("d03"); // not won, not bid-board-owned -> ineligible

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug varchar(100) NOT NULL);
    CREATE TABLE deals (
      id uuid PRIMARY KEY,
      stage_id uuid NOT NULL,
      workflow_route text NOT NULL DEFAULT 'normal',
      is_bid_board_owned boolean NOT NULL DEFAULT false,
      awarded_amount numeric(14,2)
    );
    INSERT INTO pipeline_stage_config (id, slug) VALUES
      ('${WON_STAGE}', 'won'),
      ('${ESTIMATING_STAGE}', 'estimating'),
      ('${OPP_STAGE}', 'opportunity');
    INSERT INTO deals (id, stage_id, workflow_route, is_bid_board_owned, awarded_amount) VALUES
      ('${DEAL_WON}', '${WON_STAGE}', 'normal', false, 100000.00),
      ('${DEAL_BBO}', '${ESTIMATING_STAGE}', 'normal', true, 50000.00),
      ('${DEAL_PLAIN}', '${OPP_STAGE}', 'normal', false, NULL);
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("normalizeChangeOrderAmount", () => {
  it("accepts a positive number/string and normalizes to 2 decimals", () => {
    expect(normalizeChangeOrderAmount(1500)).toBe("1500.00");
    expect(normalizeChangeOrderAmount("250.5")).toBe("250.50");
  });
  it("rejects zero, negative, and non-numeric", () => {
    expect(() => normalizeChangeOrderAmount(0)).toThrow();
    expect(() => normalizeChangeOrderAmount(-5)).toThrow();
    expect(() => normalizeChangeOrderAmount("abc")).toThrow();
    expect(() => normalizeChangeOrderAmount(null)).toThrow();
  });
  it("rejects sub-cent / extra-precision amounts (no silent float rounding into the DB)", () => {
    expect(() => normalizeChangeOrderAmount(0.004)).toThrow();
    expect(() => normalizeChangeOrderAmount("0.001")).toThrow();
    expect(() => normalizeChangeOrderAmount(0.005)).toThrow(); // >2 decimals -> rejected, not rounded
    expect(() => normalizeChangeOrderAmount("1500.005")).toThrow();
    // Decimal-safe at the ceiling: 999999999999.995 must NOT silently store 999999999999.99.
    expect(() => normalizeChangeOrderAmount("999999999999.995")).toThrow();
  });
  it("rejects an amount past the NUMERIC(14,2) ceiling (would overflow the column as a 500)", () => {
    expect(() => normalizeChangeOrderAmount(10000000000000)).toThrow();
    expect(() => normalizeChangeOrderAmount("10000000000000.00")).toThrow();
    // The exact ceiling is allowed.
    expect(normalizeChangeOrderAmount("999999999999.99")).toBe("999999999999.99");
  });
});

describe("assertDealEligibleForChangeOrder", () => {
  it("allows a Won deal", async () => {
    await expect(assertDealEligibleForChangeOrder(tdb, DEAL_WON)).resolves.toBeTruthy();
  });
  it("allows a Bid-Board-Owned deal even when not Won", async () => {
    await expect(assertDealEligibleForChangeOrder(tdb, DEAL_BBO)).resolves.toBeTruthy();
  });
  it("rejects a non-Won, non-Bid-Board-Owned deal", async () => {
    await expect(assertDealEligibleForChangeOrder(tdb, DEAL_PLAIN)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
  it("404s for a missing deal", async () => {
    await expect(assertDealEligibleForChangeOrder(tdb, U("dead"))).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
