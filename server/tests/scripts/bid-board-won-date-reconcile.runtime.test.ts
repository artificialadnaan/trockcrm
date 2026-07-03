import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  planWonDateReconcile,
  applyWonDateReconcile,
  type Queryable,
} from "../../../scripts/lib/bid-board-won-date-reconcile.js";

/**
 * Runtime (PGlite) proof of the bidirectional won_closed_date reconcile used by the gated backfill:
 *   FILL  — bid-board-owned, genuinely Won per Bid Board, missing won_closed_date  -> stamp the REAL
 *           per-deal won date (contract_signed ?? stage_entered_at::date), never today/blanket.
 *   CLEAR — bid-board-owned, has won_closed_date but NOT genuinely Won per Bid Board -> null it.
 * Correctly-Won and non-bid-board deals are left untouched, and the plan is idempotent.
 */

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const SCHEMA = "office_test";
const ST_WON = U("57e1");
const ST_ESTIMATING = U("57e2");

let pg: PGlite;
let client: Queryable;

beforeAll(async () => {
  pg = new PGlite();
  client = { query: (text, params) => pg.query(text, params) as any };
  await pg.exec(`
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL);
    CREATE SCHEMA office_test;
    CREATE TABLE office_test.deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid, deal_number text, name text, stage_id uuid NOT NULL,
      is_active boolean NOT NULL DEFAULT true, is_bid_board_owned boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false, bid_board_status text,
      stage_entered_at timestamptz, won_closed_date date, contract_signed_date date, contract_signed_at timestamptz,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric,
      updated_at timestamptz DEFAULT now()
    );
    INSERT INTO public.pipeline_stage_config (id, slug, name) VALUES
      ('${ST_WON}','won','Won'), ('${ST_ESTIMATING}','estimating','Estimating');
    INSERT INTO office_test.deals
      (id, deal_number, name, stage_id, is_active, is_bid_board_owned, bid_board_status, stage_entered_at,
       won_closed_date, contract_signed_date, contract_signed_at, awarded_amount, bid_estimate) VALUES
      -- FILL via stage_entered_at (no contract date): won + missing date
      ('${U("f01")}','DFW-FILL-01','Woods of Five Mile', '${ST_WON}', true, true, 'Won', '2026-06-03T10:00:00Z', NULL, NULL, NULL, NULL, 39340.17),
      -- FILL but contract_signed_date overrides the stage date
      ('${U("f02")}','DFW-FILL-02','Contract Override',  '${ST_WON}', true, true, 'Won', '2026-06-03T10:00:00Z', NULL, '2026-05-20', NULL, 1000, NULL),
      -- FILL via contract_signed_at (timestamptz) when contract_signed_date is absent
      ('${U("f03")}','DFW-FILL-03','ContractAt Override','${ST_WON}', true, true, 'Won', '2026-06-03T10:00:00Z', NULL, NULL, '2026-02-10T18:00:00Z', 2000, NULL),
      -- CLEAR: has a won date but Bid Board says Lost
      ('${U("c01")}','DFW-CLR-01','Adair', '${ST_WON}', true, true, 'Lost', '2026-04-16T10:00:00Z', '2026-05-01', NULL, NULL, 937.50, NULL),
      -- CONTROL correctly-won: keep
      ('${U("e01")}','DFW-KEEP-01','Good Won', '${ST_WON}', true, true, 'Won', '2026-04-01T10:00:00Z', '2026-04-01', NULL, NULL, 5000, NULL),
      -- CONTROL inactive bid-board-owned won + missing date: NOT filled (is_active guard)
      ('${U("b01")}','DFW-INACTIVE-01','Inactive Won','${ST_WON}', false, true, 'Won', '2026-04-01T10:00:00Z', NULL, NULL, NULL, NULL, 8000),
      -- CONTROL won + missing date with NO resolvable real date (NULL stage_entered_at, no contract dates): NOT filled
      ('${U("d09")}','DFW-NODATE-01','No Resolvable Date','${ST_WON}', true, true, 'Won', NULL, NULL, NULL, NULL, NULL, 4000),
      -- CONTROL not bid-board-owned: never touched
      ('${U("a01")}','DFW-NONBB-01','Manual Won', '${ST_WON}', true, false, NULL, '2026-04-01T10:00:00Z', NULL, NULL, NULL, NULL, 9999);
  `);
});

afterAll(async () => {
  await pg?.close?.();
});

async function wonDate(id: string): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT won_closed_date::text AS d FROM office_test.deals WHERE id = $1`,
    [id]
  );
  return rows[0]?.d ?? null;
}

describe("bid-board won_closed_date reconcile (runtime)", () => {
  it("plans the FILL and CLEAR sets with the real per-deal date and net $ impact", async () => {
    const plan = await planWonDateReconcile(client, SCHEMA);

    expect(plan.fill.map((d) => d.dealNumber).sort()).toEqual(["DFW-FILL-01", "DFW-FILL-02", "DFW-FILL-03"]);
    // a genuinely-won deal with NO resolvable real date is NOT a fill candidate (stays excluded)
    expect(plan.fill.map((d) => d.dealNumber)).not.toContain("DFW-NODATE-01");
    expect(plan.clear.map((d) => d.dealNumber)).toEqual(["DFW-CLR-01"]);
    // FILL-01 uses stage_entered_at::date; FILL-02 contract_signed_date; FILL-03 contract_signed_at::date
    expect(plan.fill.find((d) => d.dealNumber === "DFW-FILL-01")?.newWonClosedDate).toBe("2026-06-03");
    expect(plan.fill.find((d) => d.dealNumber === "DFW-FILL-02")?.newWonClosedDate).toBe("2026-05-20");
    expect(plan.fill.find((d) => d.dealNumber === "DFW-FILL-03")?.newWonClosedDate).toBe("2026-02-10");
    // $ impact via the Won-revenue chain (awarded -> bid_board_total_sales -> bid_estimate -> dd)
    expect(plan.entersWon).toBeCloseTo(39340.17 + 1000 + 2000, 2);
    expect(plan.leavesWon).toBeCloseTo(937.5, 2);
  });

  it("applies the reconcile, then is idempotent (a second plan is empty)", async () => {
    const result = await applyWonDateReconcile(client, SCHEMA);
    expect(result.filled).toBe(3);
    expect(result.cleared).toBe(1);

    expect(await wonDate(U("f01"))).toBe("2026-06-03");
    expect(await wonDate(U("f02"))).toBe("2026-05-20");
    expect(await wonDate(U("f03"))).toBe("2026-02-10");
    expect(await wonDate(U("c01"))).toBeNull();
    // controls untouched
    expect(await wonDate(U("e01"))).toBe("2026-04-01");
    expect(await wonDate(U("a01"))).toBeNull();
    expect(await wonDate(U("b01"))).toBeNull(); // inactive deal NOT filled
    expect(await wonDate(U("d09"))).toBeNull(); // no resolvable date -> NOT filled

    const replan = await planWonDateReconcile(client, SCHEMA);
    expect(replan.fill).toHaveLength(0);
    expect(replan.clear).toHaveLength(0);
  });
});
