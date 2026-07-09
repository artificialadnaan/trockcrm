import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getCommissionPotential, getCommissionSummary } from "../../../src/modules/commissions/reporting-service.js";

/**
 * REAL-SQL (PGlite) proof for the PR 885 codex round — POTENTIAL commission must mirror the EARNED/mint gate:
 *   - Finding #3: an estimator's potential cut counts ONLY when the estimator USER is active AND an internal
 *     CRM user (role <> 'field_contractor'), matching resolveAppliedRateForRole(…, "estimator"). A deactivated
 *     or field_contractor estimator — even with an ACTIVE user_commission_settings row + non-zero rate —
 *     contributes $0 potential, exactly the $0 they already earn.
 *   - Finding #1: getCommissionPotential (the /commissions/potential endpoint) must NOT 22P02 when repId is the
 *     "__unassigned__" sentinel; it returns the unassigned-owner bucket (owner rate 0 + estimator arm) instead
 *     of coercing the sentinel string to uuid.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const OWNER = U("a01"); // active rep, owner rate 0.10
const EST_ACTIVE = U("b01"); // active rep estimator, rate 0.05
const EST_DEACT = U("c01"); // DEACTIVATED estimator (users.is_active=false), settings row still active, rate 0.05
const EST_FC = U("d01"); // field_contractor estimator (settings active), rate 0.05
const ADMIN = U("f01"); // non-rep caller (so repId is honoured for the sentinel query)

const S = { opp: U("57001"), est: U("57002"), eur: U("57003"), con: U("57004") };
const D = { active: U("de01"), deact: U("de02"), fc: U("de03"), unassigned: U("de04") };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, name text, slug text UNIQUE NOT NULL, display_order int);
    CREATE TABLE user_commission_settings (user_id uuid PRIMARY KEY, commission_rate numeric, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text, is_active boolean NOT NULL DEFAULT true, role text NOT NULL DEFAULT 'rep');
    CREATE TABLE deals (
      id uuid PRIMARY KEY, deal_number text, name text, assigned_rep_id uuid, estimator_user_id uuid,
      stage_id uuid NOT NULL, is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false, contract_signed_at timestamptz, contract_signed_date date,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric, change_order_total numeric
    );
    -- getCommissionSummary's earned + paid CTEs reference these (empty here → earned/paid resolve to 0, so the
    -- assertion isolates the potential CTE's estimator gate).
    CREATE TABLE deal_signed_commissions (deal_id uuid, rep_user_id uuid, amount numeric, attribution_role text NOT NULL DEFAULT 'owner', contract_signed_date_at_signing date);
    CREATE TABLE deal_payment_events (deal_id uuid, is_credit_memo boolean, gross_revenue_amount numeric, paid_at timestamptz);

    INSERT INTO pipeline_stage_config (id, name, slug, display_order) VALUES
      ('${S.opp}', 'Opportunity', 'opportunity', 1),
      ('${S.est}', 'Estimating', 'estimating', 2),
      ('${S.eur}', 'Estimate Under Review', 'estimate_under_review', 3),
      ('${S.con}', 'Contract', 'contract', 4);

    -- Every estimator has an ACTIVE settings row with a non-zero rate; only users.is_active / users.role differ.
    INSERT INTO user_commission_settings (user_id, commission_rate, is_active) VALUES
      ('${OWNER}', 0.10, true), ('${EST_ACTIVE}', 0.05, true), ('${EST_DEACT}', 0.05, true), ('${EST_FC}', 0.05, true);

    INSERT INTO users (id, display_name, is_active, role) VALUES
      ('${OWNER}', 'Owen', true, 'rep'),
      ('${EST_ACTIVE}', 'Ava', true, 'rep'),
      ('${EST_DEACT}', 'Dana', false, 'rep'),
      ('${EST_FC}', 'Fred', true, 'field_contractor'),
      ('${ADMIN}', 'Adele', true, 'admin');

    -- All unsigned, active, not on-hold, $100k bid; one scenario per stage so each is its own stageGroup.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, estimator_user_id, stage_id, bid_estimate) VALUES
      ('${D.active}', 'A-1', 'Active estimator', '${OWNER}', '${EST_ACTIVE}', '${S.opp}', 100000),
      ('${D.deact}', 'A-2', 'Deactivated estimator', '${OWNER}', '${EST_DEACT}', '${S.est}', 100000),
      ('${D.fc}', 'A-3', 'Field-contractor estimator', '${OWNER}', '${EST_FC}', '${S.eur}', 100000),
      ('${D.unassigned}', 'A-4', 'Unassigned owner, active estimator', NULL, '${EST_ACTIVE}', '${S.con}', 100000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

type Group = { stageSlug: string; potentialCommission: number; dealCount: number };
const bySlug = (groups: Group[], slug: string) => groups.find((g) => g.stageSlug === slug);

describe("estimator potential is gated on active internal-CRM estimators (mirrors the earned/mint gate)", () => {
  it("counts an ACTIVE rep estimator's cut on top of the owner's", async () => {
    const { stageGroups } = await getCommissionPotential(tdb, { role: "admin", userId: ADMIN, stages: [] });
    // owner 0.10*100k + estimator 0.05*100k = 15000
    expect(bySlug(stageGroups, "opportunity")?.potentialCommission).toBe(15000);
  });

  it("EXCLUDES a DEACTIVATED estimator's cut — owner-only potential", async () => {
    const { stageGroups } = await getCommissionPotential(tdb, { role: "admin", userId: ADMIN, stages: [] });
    // owner 0.10*100k only; the deactivated estimator (active settings row) contributes 0
    expect(bySlug(stageGroups, "estimating")?.potentialCommission).toBe(10000);
  });

  it("EXCLUDES a field_contractor estimator's cut — owner-only potential", async () => {
    const { stageGroups } = await getCommissionPotential(tdb, { role: "admin", userId: ADMIN, stages: [] });
    expect(bySlug(stageGroups, "estimate_under_review")?.potentialCommission).toBe(10000);
  });

  it("office-wide summary potentialPipeline applies the same gate (getCommissionSummary potential CTE)", async () => {
    const summary = await getCommissionSummary(tdb, { role: "admin", userId: ADMIN, stages: [] });
    // Owner cuts: 3 owned deals × 0.10×100k = 30000 (the unassigned deal has a NULL owner → 0). Estimator cuts
    // ONLY for the two active-CRM estimators: dActive 5000 + dUnassigned 5000 = 10000. Total 40000. The
    // deactivated + field_contractor estimators contribute 0 — without the gate this would be 50000.
    expect(summary.potentialPipeline).toBe(40000);
  });
});

describe("getCommissionPotential handles the __unassigned__ sentinel without a uuid coercion error", () => {
  it("returns the unassigned-owner bucket (owner rate 0 + estimator arm) instead of 22P02", async () => {
    // Before the fix this threw 'invalid input syntax for type uuid: __unassigned__'.
    const potential = await getCommissionPotential(tdb, {
      role: "admin",
      userId: ADMIN,
      repId: "__unassigned__",
      stages: [],
    });
    // repSql narrows to assigned_rep_id IS NULL → only the unassigned deal; owner 0 + active estimator 0.05*100k
    const contract = bySlug(potential.stageGroups, "contract");
    expect(contract?.dealCount).toBe(1);
    expect(contract?.potentialCommission).toBe(5000);
    // deals WITH an owner are excluded from the unassigned bucket
    expect(bySlug(potential.stageGroups, "opportunity")).toBeUndefined();
  });
});
