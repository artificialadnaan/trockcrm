import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { searchDeals } from "../../../src/modules/search/service.js";

/**
 * REAL-SQL (PGlite) proof that a global-search deal result prices a change-order child from
 * awarded_amount VERBATIM. Search already badges a CO (isChangeOrder is selected on the same row), so
 * before this the UI showed a DEDUCTIVE CO with its CO badge and NO amount at all: every candidate in the
 * positive-gated chain dropped the negative, and the helper returned null.
 */

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const ST = { won: U("57a1"), opp: U("57a2") };
const D = {
  normal: U("d01"),
  coPos: U("d02"),
  coNeg: U("d03"),
  coZero: U("d04"),
  coEmpty: U("d05"),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text);
    CREATE TABLE companies (id uuid PRIMARY KEY, name text);
    CREATE TABLE contacts (id uuid PRIMARY KEY, first_name text, last_name text);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid, name text, deal_number text, project_number text, description text,
      property_address text, property_city text, property_state text, bid_board_customer_name text,
      company_id uuid, primary_contact_id uuid, assigned_rep_id uuid,
      on_hold boolean DEFAULT false, is_change_order boolean DEFAULT false,
      is_active boolean NOT NULL DEFAULT true, stage_id uuid,
      awarded_amount numeric(14,2), bid_board_total_sales numeric(14,2),
      bid_estimate numeric(14,2), dd_estimate numeric(14,2),
      updated_at timestamptz DEFAULT now()
    );

    INSERT INTO pipeline_stage_config (id, slug) VALUES ('${ST.won}','won'), ('${ST.opp}','opportunity');

    -- all share the token 'Marabout' so buildDealSearchCondition matches each by name
    INSERT INTO deals (id, name, stage_id, is_change_order, awarded_amount, bid_board_total_sales, bid_estimate, dd_estimate) VALUES
      ('${D.normal}', 'Marabout Parent',    '${ST.opp}', false, NULL,      NULL, 7500.00, 9000.00),
      -- CO children mirror prod: awarded_amount is the ONLY populated value column.
      ('${D.coPos}',  'Marabout CO Add',    '${ST.won}', true,  25000.00,  NULL, NULL,    NULL),
      ('${D.coNeg}',  'Marabout CO Deduct', '${ST.won}', true, -50000.00,  NULL, NULL,    NULL),
      ('${D.coZero}', 'Marabout CO Zero',   '${ST.won}', true,  0.00,      NULL, NULL,    NULL),
      ('${D.coEmpty}','Marabout CO Blank',  '${ST.won}', true,  NULL,      NULL, NULL,    NULL);
  `);
  tdb = drizzle(pg);
  // Give PGlite setup explicit headroom over Vitest's default 10s hook timeout for parallel batches.
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

describe("searchDeals — change-order results are priced from awarded_amount verbatim", () => {
  it("shows a deductive CO's NEGATIVE amount instead of no amount at all", async () => {
    const byId = new Map((await searchDeals(tdb, "Marabout", 50)).map((r) => [r.id, r]));

    expect(byId.get(D.coNeg)?.isChangeOrder).toBe(true);
    expect(Number(byId.get(D.coNeg)?.dealValue)).toBe(-50000);
  });

  it("is INERT for a normal deal (still falls through to bid_estimate) and a positive CO", async () => {
    const byId = new Map((await searchDeals(tdb, "Marabout", 50)).map((r) => [r.id, r]));

    expect(Number(byId.get(D.normal)?.dealValue)).toBe(7500);
    expect(Number(byId.get(D.coPos)?.dealValue)).toBe(25000);
  });

  it("shows a zero CO as 0 and a CO with no amount at all as no value", async () => {
    const byId = new Map((await searchDeals(tdb, "Marabout", 50)).map((r) => [r.id, r]));

    // Assert non-null FIRST: `Number(null)` is 0, so a bare numeric check here would pass on a dropped value.
    expect(byId.get(D.coZero)?.dealValue).not.toBeNull();
    expect(Number(byId.get(D.coZero)?.dealValue)).toBe(0);
    expect(byId.get(D.coEmpty)?.dealValue).toBeNull();
  });
});
