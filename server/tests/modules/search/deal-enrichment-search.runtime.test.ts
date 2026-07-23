import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { searchDeals } from "../../../src/modules/search/service.js";

/**
 * REAL-SQL (PGlite) proof that searchDeals returns the assigned rep's display name and the
 * best-value deal amount (canonical awarded > bid_board_total_sales > bid > dd), and degrades
 * cleanly when rep/values are null.
 */

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const ST = { opp: U("57a1") };
const REP = U("ee01"); // hex-only (r/e-typo would be an invalid uuid and crash beforeAll)
const D = { withRep: U("d01"), noRep: U("d02"), bidOnly: U("d03"), bbOnly: U("d04"), zeroAwarded: U("d05") };

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

    INSERT INTO pipeline_stage_config (id, slug) VALUES ('${ST.opp}','opportunity');
    INSERT INTO users (id, display_name) VALUES ('${REP}','Caleb Stone');

    INSERT INTO deals (id, name, stage_id, is_active, assigned_rep_id, awarded_amount, bid_board_total_sales, bid_estimate, dd_estimate) VALUES
      ('${D.withRep}', 'Zephyr Awarded',  '${ST.opp}', true, '${REP}', 12322.86, NULL,     12322.86, 12155.00),
      ('${D.noRep}',   'Zephyr No Rep',   '${ST.opp}', true, NULL,      50000.00, NULL,     NULL,     NULL),
      ('${D.bidOnly}', 'Zephyr Bid Only', '${ST.opp}', true, '${REP}',  NULL,      NULL,     7500.00,  7000.00),
      ('${D.bbOnly}',  'Zephyr BB Only',  '${ST.opp}', true, '${REP}',  NULL,      31000.00, 8000.00,  NULL),
      ('${D.zeroAwarded}', 'Zephyr Zero Awarded', '${ST.opp}', true, '${REP}', 0, NULL, 80000.00, NULL);
  `);
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

describe("searchDeals — rep name + best-value amount enrichment", () => {
  it("returns the assigned rep name and awarded>bbts>bid>dd best value; null-safe", async () => {
    const results = await searchDeals(tdb, "Zephyr", 50);
    const byId = new Map(results.map((r) => [r.id, r]));

    const awarded = byId.get(D.withRep)!;
    expect(awarded.assignedRepName).toBe("Caleb Stone");
    expect(Number(awarded.dealValue)).toBe(12322.86); // awarded wins

    const noRep = byId.get(D.noRep)!;
    expect(noRep.assignedRepName ?? null).toBeNull();
    expect(Number(noRep.dealValue)).toBe(50000); // awarded present, rep null

    const bidOnly = byId.get(D.bidOnly)!;
    expect(bidOnly.assignedRepName).toBe("Caleb Stone");
    expect(Number(bidOnly.dealValue)).toBe(7500); // awarded+bbts null -> bid_estimate

    const bbOnly = byId.get(D.bbOnly)!;
    expect(Number(bbOnly.dealValue)).toBe(31000); // bid_board_total_sales beats bid_estimate

    const zeroAwarded = byId.get(D.zeroAwarded)!;
    expect(Number(zeroAwarded.dealValue)).toBe(80000); // awarded=0 is skipped (>0 gate), falls to bid
  });
});
