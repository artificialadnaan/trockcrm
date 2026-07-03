import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  getRepDealPipelineSummary,
  getRepPotentialRevenue,
} from "../../../src/modules/dashboard/service.js";

/**
 * REAL-SQL (PGlite) proof that the Team Commissions pipeline/potential columns are INVOLVEMENT-based:
 * each open deal is credited to its assigned rep AND (if distinct) its assigned estimator. This is why a
 * pure estimator (owns no deals) no longer shows all-zero. The lateral unnest dedups when one person is
 * both owner and estimator (counted once), and a distinct owner+estimator deal is counted for BOTH.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const OWNER = U("a01"); // owns deals
const ESTIMATOR = U("b01"); // estimator-only — owns nothing
const SOLO = U("c01"); // both owner AND estimator on the same deal
const NOBODY = U("d01"); // uninvolved
const ST = U("57001");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, assigned_rep_id uuid, estimator_user_id uuid, sales_source_user_id uuid, stage_id uuid NOT NULL,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false, contract_signed_at timestamptz, contract_signed_date date,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric,
      change_order_total numeric
    );
    -- getRepDealPipelineSummary's won·unsigned predicate references this table (empty here).
    CREATE TABLE deal_signed_commissions (id uuid, deal_id uuid, rep_user_id uuid, attribution_role text NOT NULL DEFAULT 'owner');
    INSERT INTO pipeline_stage_config (id, slug) VALUES ('${ST}', 'estimating');
    -- D1: OWNER owns, ESTIMATOR estimates (distinct) -> both get it ($100k)
    INSERT INTO deals (id, assigned_rep_id, estimator_user_id, stage_id, awarded_amount) VALUES
      ('${U("d11")}', '${OWNER}', '${ESTIMATOR}', '${ST}', 100000);
    -- D2: OWNER owns, no estimator -> only OWNER ($40k)
    INSERT INTO deals (id, assigned_rep_id, estimator_user_id, stage_id, awarded_amount) VALUES
      ('${U("d12")}', '${OWNER}', NULL, '${ST}', 40000);
    -- D3: SOLO is BOTH owner and estimator -> counted ONCE ($70k), not twice
    INSERT INTO deals (id, assigned_rep_id, estimator_user_id, stage_id, awarded_amount) VALUES
      ('${U("d13")}', '${SOLO}', '${SOLO}', '${ST}', 70000);
    -- Excluded noise: signed (not open), and on-hold -> in nobody's open pipeline
    INSERT INTO deals (id, assigned_rep_id, estimator_user_id, stage_id, awarded_amount, contract_signed_at) VALUES
      ('${U("d14")}', '${OWNER}', '${ESTIMATOR}', '${ST}', 999999, '2026-03-01T00:00:00Z');
    INSERT INTO deals (id, assigned_rep_id, estimator_user_id, stage_id, awarded_amount, on_hold) VALUES
      ('${U("d15")}', '${OWNER}', '${ESTIMATOR}', '${ST}', 888888, true);
    -- D16: a TEST deal (is_test_data) -> excluded from every involvement column (same population as the row's
    -- other columns), so it never inflates OWNER's or ESTIMATOR's pipeline/potential.
    INSERT INTO deals (id, assigned_rep_id, estimator_user_id, stage_id, awarded_amount, is_test_data) VALUES
      ('${U("d16")}', '${OWNER}', '${ESTIMATOR}', '${ST}', 777777, true);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("getRepDealPipelineSummary is involvement-based (owner OR estimator)", () => {
  it("credits a pure estimator, double-counts a distinct owner+estimator deal, dedups same-person", async () => {
    const rows = await getRepDealPipelineSummary(tdb);
    const by = Object.fromEntries(rows.map((r) => [r.repId, r]));

    // OWNER: D1 + D2 (D14 signed and D15 on-hold are excluded) = 2 deals / $140k
    expect(by[OWNER]).toMatchObject({ activeDeals: 2, pipelineValue: 140000 });
    // ESTIMATOR (owns nothing): credited D1 as estimator = 1 deal / $100k — the whole point of the change
    expect(by[ESTIMATOR]).toMatchObject({ activeDeals: 1, pipelineValue: 100000 });
    // SOLO is owner AND estimator on D3 -> counted ONCE, not doubled
    expect(by[SOLO]).toMatchObject({ activeDeals: 1, pipelineValue: 70000 });
    // D1 appears in BOTH OWNER and ESTIMATOR (additive per-person view, by design)
    expect(by[NOBODY]).toBeUndefined();
  });
});

describe("getRepPotentialRevenue is involvement-based", () => {
  it("returns estimated-deal revenue for a pure estimator and the owner book for an owner", async () => {
    expect(await getRepPotentialRevenue(tdb, ESTIMATOR)).toBe(100000); // D1 (estimated)
    expect(await getRepPotentialRevenue(tdb, OWNER)).toBe(140000); // D1 + D2 (owned)
    expect(await getRepPotentialRevenue(tdb, SOLO)).toBe(70000); // D3 once
    expect(await getRepPotentialRevenue(tdb, NOBODY)).toBe(0);
  });
});
