// REAL-SQL (PGlite) reconciliation proof for the DEDUCTIVE change order.
//
// A deductive CO is a real child deal carrying a NEGATIVE amount, which reduces the parent's contract
// value. The locked product decision is that commission CLAWS BACK: a rep's earned commission always
// equals their rate applied to the CURRENT contract value. The CO child mints its own owner
// deal_signed_commissions row at a NEGATIVE source_value_amount (resolveSourceValue takes the first
// NON-NULL candidate, not the first positive one), so the claw-back rides the ordinary earned path.
//
// Two independent engines read those rows, and they must agree:
//   • Engine A — getRepCommissionDashboard (the rep's own /commissions page).
//   • Engine B — getRepCommissionSummary  (the dashboard / Team-Commissions total).
//
// The reconciliation these tests pin: for ANY sign, Engine A's `earned` === Engine B's
// `directEarnedCommission`, and both equal rate × current contract value. Engine A used to apply a
// trailing `WHERE deal_value > 0` to the UNION, which dropped the claw-back row outright — the rep's own
// page kept showing the pre-CO commission while the dashboard showed the reduced one. The predicate is
// display hygiene for VALUELESS rows, not a sign gate, so it is now `<> 0`.
//
// NOTE ON SHAPE: the pre-existing negative fixtures in
// server/tests/modules/dashboard/rep-commission-drilldown.runtime.test.ts model a claw-back as a NEGATIVE
// RATE over a positive source value, which Engine A's `> 0` filter never dropped (its filter reads
// source_value_amount). A deductive CO is the opposite shape — NEGATIVE source value, positive rate — and
// that is the shape exercised here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { dealSignedCommissions } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { getRepCommissionDashboard } from "../../../src/modules/commissions/reporting-service.js";
import { getRepCommissionSummary } from "../../../src/modules/dashboard/service.js";

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;

const REP = U("d01"); // rate .10, floor 0 — owns the parent AND the deductive CO child.
const ST_OPEN = U("d8001"); // 'opportunity'

const D = {
  parent: U("f01"), // awarded 100000 -> owner dsc +10000
  deductiveCo: U("f02"), // awarded -20000 (deductive CO child) -> owner dsc -2000
};

const RANGE = { from: "2026-01-01", to: "2026-12-31" };

// The locked identity: rate × CURRENT contract value.
const CONTRACT_VALUE_AFTER_CO = 100000 - 20000; // 80000
const RATE = 0.1;
const EXPECTED_EARNED = CONTRACT_VALUE_AFTER_CO * RATE; // 8000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL);
    CREATE TABLE companies (id uuid PRIMARY KEY, name text);
    CREATE TABLE properties (id uuid PRIMARY KEY, name text, address text);
    CREATE TABLE users (
      id uuid PRIMARY KEY, display_name text, is_active boolean NOT NULL DEFAULT true,
      role text NOT NULL DEFAULT 'rep', reports_to uuid, is_test_data boolean NOT NULL DEFAULT false
    );
    CREATE TABLE user_commission_settings (
      user_id uuid PRIMARY KEY, commission_rate numeric NOT NULL DEFAULT 0,
      rolling_floor numeric NOT NULL DEFAULT 0, override_rate numeric NOT NULL DEFAULT 0,
      estimated_margin_rate numeric NOT NULL DEFAULT 0.30, min_margin_percent numeric NOT NULL DEFAULT 0.20,
      new_customer_share_floor numeric NOT NULL DEFAULT 0.10, new_customer_window_months integer NOT NULL DEFAULT 6,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE commission_deal_snapshots (
      deal_id uuid, rep_user_id uuid, last_commission_amount numeric, last_computed_at timestamptz,
      PRIMARY KEY (deal_id, rep_user_id)
    );
    CREATE TABLE deals (
      id uuid PRIMARY KEY, deal_number text, name text, assigned_rep_id uuid, estimator_user_id uuid, sales_source_user_id uuid,
      company_id uuid, property_id uuid, property_address text, stage_id uuid NOT NULL,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      is_change_order boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false, contract_signed_at timestamptz, contract_signed_date date,
      won_closed_date date, actual_close_date date, project_number text, expected_close_date date,
      bid_due_date timestamptz, stage_entered_at timestamptz, updated_at timestamptz,
      created_at timestamptz, awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric,
      dd_estimate numeric, change_order_total numeric
    );
  `);
  // deal_signed_commissions from the REAL Drizzle table, so the negative rows seeded below are proved
  // LEGAL against prod's actual constraint set rather than against a permissive hand-rolled island. The
  // hand-rolled version this replaces modelled none of migration 0062's CHECKs, so it could not have
  // shown that `amount >= 0` was rejecting the very claw-back row this suite reconciles (dropped in 0204).
  await pg.exec(tenantSchemaSql("public", [dealSignedCommissions]));
  await pg.exec(`
    INSERT INTO pipeline_stage_config (id, slug) VALUES ('${ST_OPEN}', 'opportunity');

    INSERT INTO users (id, display_name, role) VALUES ('${REP}', 'Deductive Rep', 'rep');
    INSERT INTO user_commission_settings (user_id, commission_rate, rolling_floor, override_rate) VALUES
      ('${REP}', ${RATE}, 0, 0);

    -- Parent deal: awarded 100000, signed in window -> owner cut 10000.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, is_change_order, contract_signed_at, awarded_amount, created_at) VALUES
      ('${D.parent}', 'DCO-1', 'Parent contract', '${REP}', '${ST_OPEN}', false, '2026-03-15T00:00:00Z', 100000, '2026-01-10T00:00:00Z');
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, source_value_kind, source_value_amount, applied_rate, amount, attribution_role, contract_signed_date_at_signing) VALUES
      ('${D.parent}', '${REP}', 'awarded_amount', 100000, ${RATE}, 10000, 'owner', '2026-03-15');

    -- Deductive CO child: awarded -20000 -> owner cut -2000 (the claw-back row). Same positive rate as the
    -- parent; only the SOURCE VALUE is negative, which is what a deductive CO produces.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, is_change_order, contract_signed_at, awarded_amount, created_at) VALUES
      ('${D.deductiveCo}', 'DCO-1-CO1', 'Deductive change order', '${REP}', '${ST_OPEN}', true, '2026-03-20T00:00:00Z', -20000, '2026-03-20T00:00:00Z');
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, source_value_kind, source_value_amount, applied_rate, amount, attribution_role, contract_signed_date_at_signing) VALUES
      ('${D.deductiveCo}', '${REP}', 'awarded_amount', -20000, ${RATE}, -2000, 'owner', '2026-03-20');
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("deductive change order: the two earned-commission engines reconcile", () => {
  it("Engine A earned === Engine B directEarnedCommission === rate × current contract value", async () => {
    const dash = await getRepCommissionDashboard(tdb, { role: "rep", userId: REP, ...RANGE });
    const { summary } = await getRepCommissionSummary(tdb, REP, RANGE.from, RANGE.to);

    // The break this test exists to close: with Engine A's trailing `deal_value > 0`, the claw-back row is
    // dropped and Engine A reports 10000 while Engine B reports 8000.
    expect(dash.summary.earned).toBeCloseTo(summary.directEarnedCommission, 2);
    expect(dash.summary.earned).toBeCloseTo(EXPECTED_EARNED, 2);
    expect(summary.directEarnedCommission).toBeCloseTo(EXPECTED_EARNED, 2);
  });

  it("Engine A LISTS the claw-back row (not merely nets it into the total)", async () => {
    const dash = await getRepCommissionDashboard(tdb, { role: "rep", userId: REP, ...RANGE });
    const earnedRows = dash.deals.filter((d) => d.isEarned);
    expect(earnedRows).toHaveLength(2);

    const clawback = earnedRows.find((d) => d.dealId === D.deductiveCo);
    expect(clawback).toBeDefined();
    expect(clawback!.dealValue).toBeCloseTo(-20000, 2);
    expect(clawback!.commission).toBeCloseTo(-2000, 2);

    // The listed rows must sum to the page total — a row shown but not summed (or vice versa) is the same
    // class of drift as the engine split.
    const listed = earnedRows.reduce((sum, d) => sum + d.commission, 0);
    expect(listed).toBeCloseTo(dash.summary.earned, 2);
  });

  it("Engine B's per-deal breakdown carries the claw-back too, so both engines list the same rows", async () => {
    const { summary, deals } = await getRepCommissionSummary(tdb, REP, RANGE.from, RANGE.to);
    expect(deals).toHaveLength(2);
    const clawback = deals.find((d) => d.dealId === D.deductiveCo);
    expect(clawback).toBeDefined();
    expect(clawback!.earnedCommission).toBeCloseTo(-2000, 2);
    const listed = deals.reduce((sum, d) => sum + d.earnedCommission, 0);
    expect(listed).toBeCloseTo(summary.directEarnedCommission, 2);
  });
});
