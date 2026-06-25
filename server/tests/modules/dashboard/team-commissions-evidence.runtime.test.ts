import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  getDirectorCommissionWorkspace,
  getDirectorCommissionEvidence,
  getCommissionOfficeTotals,
  getRepDealPipelineSummary,
} from "../../../src/modules/dashboard/service.js";

/**
 * RECONCILIATION PROOF (real PGlite): every Team Commissions drill total equals the table cell it backs.
 * For each metric we call getDirectorCommissionEvidence(repId, metric) and assert its total (count for
 * count columns, $ for value columns) equals the corresponding column on the SAME rep's
 * getDirectorCommissionWorkspace row — so the popup can never disagree with the number clicked.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const REP = U("a01"); // owner + estimator + activities
const OTHER = U("b01"); // a co-owner so an estimator-on-REP deal is owned elsewhere
const CO = U("c01"); // company
const MGR = U("f01"); // below their OWN floor, earns ONLY manager override on a report
const REPORT = U("f02"); // direct report of MGR with real earned commission
const BOOKED = U("f03"); // owns a won deal that's deal-unsigned but ALREADY booked (dsc) -> in Earned, NOT won·unsigned
const NONREP = U("f04"); // a director (NOT on the rep roster) — deals only they own must NOT inflate office totals
const EST2 = U("f05"); // estimator on a won deal whose OWNER is booked but EST2 is not -> still in EST2's won·unsigned
const OWN2 = U("f06"); // owner of that cross-booked deal (booked) — separate so it doesn't perturb REP's earned
const FROM = "2026-01-01";
const TO = "2026-12-31";

const ST = {
  opportunity: U("510"),
  estimating: U("520"),
  leadNew: U("530"),
  leadQual: U("540"),
  leadOpp: U("550"),
  won: U("560"),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text, role text NOT NULL DEFAULT 'rep',
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      reports_to uuid, office_id uuid);
    CREATE TABLE user_commission_settings (user_id uuid PRIMARY KEY, is_active boolean DEFAULT true,
      commission_rate numeric DEFAULT 0, rolling_floor numeric DEFAULT 0, override_rate numeric DEFAULT 0,
      estimated_margin_rate numeric, min_margin_percent numeric, new_customer_share_floor numeric,
      new_customer_window_months int);
    CREATE TABLE companies (id uuid PRIMARY KEY, name text, region text);
    CREATE TABLE properties (id uuid PRIMARY KEY, name text);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text,
      workflow_family text NOT NULL DEFAULT 'pipeline');
    CREATE TABLE deals (id uuid PRIMARY KEY, deal_number text, name text, assigned_rep_id uuid,
      estimator_user_id uuid, stage_id uuid NOT NULL, company_id uuid, property_id uuid,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false, contract_signed_at timestamptz, contract_signed_date date,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric,
      change_order_total numeric, expected_close_date date, stage_entered_at timestamptz DEFAULT now());
    CREATE TABLE leads (id uuid PRIMARY KEY, name text, assigned_rep_id uuid, stage_id uuid NOT NULL,
      company_id uuid, status text NOT NULL DEFAULT 'open', is_active boolean NOT NULL DEFAULT true,
      stage_entered_at timestamptz DEFAULT now());
    CREATE TABLE activities (id uuid PRIMARY KEY, responsible_user_id uuid, type text NOT NULL,
      subject text, occurred_at timestamptz NOT NULL DEFAULT now(), deal_id uuid, lead_id uuid, contact_id uuid);
    CREATE TABLE deal_signed_commissions (id uuid PRIMARY KEY, deal_id uuid, rep_user_id uuid,
      amount numeric NOT NULL, source_value_amount numeric NOT NULL, attribution_role text NOT NULL DEFAULT 'owner',
      contract_signed_date_at_signing date);

    INSERT INTO users (id, display_name, role, reports_to) VALUES
      ('${REP}','Kaleb','rep', NULL), ('${OTHER}','Owner','rep', NULL),
      ('${MGR}','Manager','rep', NULL), ('${REPORT}','Report','rep','${MGR}'), ('${BOOKED}','Booked','rep', NULL),
      ('${NONREP}','Director Dana','director', NULL), ('${EST2}','Estimator Two','rep', NULL), ('${OWN2}','Owner Two','rep', NULL);
    INSERT INTO user_commission_settings (user_id, is_active, commission_rate, rolling_floor, override_rate) VALUES
      ('${REP}', true, 0.05, 0, 0),
      ('${MGR}', true, 0.05, 1000000, 0.10),  -- MGR below their own $1M floor -> direct earned $0
      ('${REPORT}', true, 0.05, 0, 0),
      ('${BOOKED}', true, 0.05, 0, 0);
    INSERT INTO companies (id, name) VALUES ('${CO}','Acme');
    INSERT INTO pipeline_stage_config (id, slug, name, workflow_family) VALUES
      ('${ST.opportunity}','opportunity','Opportunity','pipeline'),
      ('${ST.estimating}','estimating','Estimating','pipeline'),
      ('${ST.leadNew}','new_lead','New Lead','lead'),
      ('${ST.leadQual}','qualified_lead','Qualified Lead','lead'),
      ('${ST.leadOpp}','opportunity_lead_placeholder','Opp','lead'),
      ('${ST.won}','won','Won','pipeline');
    -- lead opportunity stage must be one of the funnel 'opportunities' slugs:
    UPDATE pipeline_stage_config SET slug='sales_validation_stage' WHERE id='${ST.leadOpp}';

    -- PIPELINE deals (open, commission stages, REP involved). D1 owner, D2 estimator-only (owned by OTHER),
    -- D3 estimating-stage owner. Values via awarded_amount + change_order_total.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, estimator_user_id, stage_id, company_id, awarded_amount, change_order_total) VALUES
      ('${U("d01")}','D-1','Deal One','${REP}', NULL, '${ST.opportunity}','${CO}', 100000, 0),
      ('${U("d02")}','D-2','Deal Two','${OTHER}','${REP}','${ST.opportunity}','${CO}', 40000, 10000),
      ('${U("d03")}','D-3','Deal Three','${REP}', NULL, '${ST.estimating}','${CO}', 70000, 0);
    -- noise: signed (excluded from pipeline), on-hold (excluded), test (excluded)
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, awarded_amount, contract_signed_at) VALUES
      ('${U("d04")}','D-4','Signed','${REP}','${ST.opportunity}', 999999, '2026-03-01T00:00:00Z');
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, awarded_amount, on_hold) VALUES
      ('${U("d05")}','D-5','Held','${REP}','${ST.opportunity}', 888888, true);
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, awarded_amount, is_test_data) VALUES
      ('${U("d06")}','D-6','Test','${REP}','${ST.opportunity}', 777777, true);
    -- UNASSIGNED: no owner AND no estimator — dropped from every per-rep row (involvement unnest yields
    -- nothing), so it must NOT inflate officeTotals above the row sum either.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, estimator_user_id, stage_id, awarded_amount) VALUES
      ('${U("d10")}','D-10','Unassigned', NULL, NULL, '${ST.opportunity}', 60000);
    -- NON-ROSTERED: owned solely by a director (not on the rep roster) -> in no rep row, must be excluded
    -- from officeTotals (otherwise the footer exceeds the visible rows).
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, awarded_amount) VALUES
      ('${U("d12")}','D-12','Director-owned','${NONREP}','${ST.opportunity}', 45000);
    -- WON·UNSIGNED: REP-owned deal in a won stage with NO signed contract -> won·unsigned $80k. Plus a
    -- won-but-SIGNED deal (excluded from won·unsigned) to prove the unsigned gate.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, company_id, awarded_amount) VALUES
      ('${U("d08")}','D-8','Won Unsigned','${REP}','${ST.won}','${CO}', 80000);
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, awarded_amount, contract_signed_at) VALUES
      ('${U("d09")}','D-9','Won Signed','${REP}','${ST.won}', 95000, '2026-02-01T00:00:00Z');
    -- BOOKED's won deal: deal-level UNSIGNED but a dsc row carries contract_signed_date_at_signing, so Earned
    -- counts it -> must be EXCLUDED from won·unsigned (not awaiting signature). Owner BOOKED, $50k.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, company_id, awarded_amount) VALUES
      ('${U("d11")}','D-11','Booked Unsigned','${BOOKED}','${ST.won}','${CO}', 50000);
    INSERT INTO deal_signed_commissions (id, deal_id, rep_user_id, amount, source_value_amount, attribution_role, contract_signed_date_at_signing)
      VALUES ('${U("dc3")}','${U("d11")}','${BOOKED}', 2500, 50000, 'owner', '2026-03-01');
    -- D13: won + deal-unsigned, OWNER=OWN2 (booked) but ESTIMATOR=EST2 (NOT booked). Per-rep exclusion ->
    -- OWN2's won·unsigned drops it (booked), EST2's won·unsigned KEEPS it ($30k), office counts it once.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, estimator_user_id, stage_id, company_id, awarded_amount) VALUES
      ('${U("d13")}','D-13','Cross Booked','${OWN2}','${EST2}','${ST.won}','${CO}', 30000);
    INSERT INTO deal_signed_commissions (id, deal_id, rep_user_id, amount, source_value_amount, attribution_role, contract_signed_date_at_signing)
      VALUES ('${U("dc4")}','${U("d13")}','${OWN2}', 1500, 30000, 'owner', '2026-03-01');

    -- EARNED: a signed deal (D-4 above, opportunity stage, not lost) with a dsc row for REP.
    INSERT INTO deal_signed_commissions (id, deal_id, rep_user_id, amount, source_value_amount, attribution_role, contract_signed_date_at_signing)
      VALUES ('${U("dc1")}','${U("d04")}','${REP}', 2500, 50000, 'owner', '2026-03-01');

    -- REPORT's signed deal (owned by REPORT) + dsc -> REPORT direct earned $5000 (floor met). MGR earns
    -- override 0.10 * 5000 = $500 and NOTHING direct (below their own $1M floor).
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, awarded_amount, contract_signed_at) VALUES
      ('${U("d07")}','D-7','Report Signed','${REPORT}','${ST.opportunity}', 100000, '2026-03-01T00:00:00Z');
    INSERT INTO deal_signed_commissions (id, deal_id, rep_user_id, amount, source_value_amount, attribution_role, contract_signed_date_at_signing)
      VALUES ('${U("dc2")}','${U("d07")}','${REPORT}', 5000, 100000, 'owner', '2026-03-01');

    -- LEADS (open, assigned REP): 2 new, 1 qualified, 1 opportunity.
    INSERT INTO leads (id, name, assigned_rep_id, stage_id, company_id) VALUES
      ('${U("e01")}','Lead A','${REP}','${ST.leadNew}','${CO}'),
      ('${U("e02")}','Lead B','${REP}','${ST.leadNew}','${CO}'),
      ('${U("e03")}','Lead C','${REP}','${ST.leadQual}','${CO}'),
      ('${U("e04")}','Lead D','${REP}','${ST.leadOpp}','${CO}');

    -- ACTIVITIES by REP in window: 3 calls, 2 emails, 1 meeting (1 call linked to a deal).
    INSERT INTO activities (id, responsible_user_id, type, subject, occurred_at, deal_id) VALUES
      ('${U("ac1")}','${REP}','call','Call 1','2026-04-01T10:00:00Z','${U("d01")}'),
      ('${U("ac2")}','${REP}','call','Call 2','2026-04-02T10:00:00Z', NULL),
      ('${U("ac3")}','${REP}','call','Call 3','2026-04-03T10:00:00Z', NULL),
      ('${U("ac4")}','${REP}','email','Email 1','2026-04-04T10:00:00Z', NULL),
      ('${U("ac5")}','${REP}','email','Email 2','2026-04-05T10:00:00Z', NULL),
      ('${U("ac6")}','${REP}','meeting','Meeting 1','2026-04-06T10:00:00Z', NULL);
  `);
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

describe("Team Commissions drill evidence reconciles to the table cell", () => {
  it("every metric's evidence total equals the rep's workspace column", async () => {
    const { rows } = await getDirectorCommissionWorkspace(tdb, { from: FROM, to: TO });
    const row = rows.find((r) => r.repId === REP)!;
    expect(row).toBeTruthy();

    const ev = (metric: string) => getDirectorCommissionEvidence(tdb, { repId: REP, metric: metric as never, from: FROM, to: TO });

    // count columns: evidence.total.count === cell
    expect((await ev("active")).total.count).toBe(row.activeDeals);
    expect((await ev("estimating")).total.count).toBe(row.estimating);
    expect((await ev("leads")).total.count).toBe(row.leads);
    expect((await ev("qualified")).total.count).toBe(row.qualifiedLeads);
    expect((await ev("opportunities")).total.count).toBe(row.opportunities);
    expect((await ev("calls")).total.count).toBe(row.calls);
    expect((await ev("emails")).total.count).toBe(row.emails);
    expect((await ev("meetings")).total.count).toBe(row.meetings);

    // value columns: evidence.total.value === cell
    expect((await ev("pipeline")).total.value).toBe(row.pipelineValue);
    expect((await ev("earned")).total.value).toBe(row.totalEarnedCommission);
    expect((await ev("won_unsigned")).total.value).toBe(row.wonUnsignedValue);

    // sanity on the concrete fixture numbers
    expect(row.activeDeals).toBe(3); // D1 + D2(estimator) + D3
    expect(row.pipelineValue).toBe(220000); // 100k + 50k(40k+10kCO) + 70k
    expect(row.wonUnsignedValue).toBe(80000); // D8 (won stage, unsigned); D9 (signed) excluded
    expect(row.estimating).toBe(1); // D3 only
    expect(row.leads).toBe(2);
    expect(row.qualifiedLeads).toBe(1);
    expect(row.opportunities).toBe(1);
    expect(row.calls).toBe(3);
    expect(row.emails).toBe(2);
    expect(row.meetings).toBe(1);
    expect(row.totalEarnedCommission).toBe(2500);
  });

  it("officeTotals count each deal ONCE — de-dups the estimator double-count in the row sum", async () => {
    const ws = await getDirectorCommissionWorkspace(tdb, { from: FROM, to: TO });
    // D2 is OWNED by OTHER and ESTIMATED by REP -> it appears in BOTH rows' pipeline (involvement). The
    // per-rep sum double-counts it AND includes the non-roster director's D12: REP 220k + OTHER 50k +
    // NONREP 45k = 315k.
    const perRepPipelineSum = (await getRepDealPipelineSummary(tdb)).reduce((s, r) => s + r.pipelineValue, 0);
    expect(perRepPipelineSum).toBe(315000);
    // The office total counts each deal ONCE and only deals with a ROSTERED rep involved: D1 100k + D2 50k +
    // D3 70k = 220k — excludes the unassigned D10 AND the director-owned D12 (neither in any rep row).
    const totals = await getCommissionOfficeTotals(tdb);
    expect(totals.pipelineValue).toBe(220000);
    expect(totals.pipelineValue).toBeLessThan(perRepPipelineSum);
    expect(ws.officeTotals.pipelineValue).toBe(220000);
    // Won·unsigned office total: D8 ($80k, via REP unbooked) + D13 ($30k, via EST2 unbooked) = $110k; D9
    // (signed) and D11 (fully booked) excluded; each counted once.
    expect(totals.wonUnsignedValue).toBe(110000);
    expect(totals.wonUnsignedCount).toBe(2);
    expect(ws.officeTotals.wonUnsignedValue).toBe(110000);
  });

  it("a won deal that's already BOOKED (dsc) is in Earned, NOT in won·unsigned", async () => {
    const { rows, officeTotals } = await getDirectorCommissionWorkspace(tdb, { from: FROM, to: TO });
    const booked = rows.find((r) => r.repId === BOOKED)!;
    // D11 is won-stage + deal-unsigned but has a dsc booking -> Earned counts it, won·unsigned does NOT.
    expect(booked.totalEarnedCommission).toBe(2500);
    expect(booked.wonUnsignedValue).toBe(0);
    expect(booked.wonUnsignedCount).toBe(0);
    expect((await getDirectorCommissionEvidence(tdb, { repId: BOOKED, metric: "won_unsigned", from: FROM, to: TO })).total.value).toBe(0);
    // Office won·unsigned excludes the fully-booked D11; counts D8 ($80k) + the cross-booked D13 ($30k via EST2).
    expect(officeTotals.wonUnsignedValue).toBe(110000);
  });

  it("won·unsigned excludes a booked deal PER REP, not deal-wide (owner booked, estimator not)", async () => {
    const { rows } = await getDirectorCommissionWorkspace(tdb, { from: FROM, to: TO });
    // D13: owner OWN2 booked, estimator EST2 not. OWN2's won·unsigned drops it; EST2's keeps it.
    expect(rows.find((r) => r.repId === OWN2)!.wonUnsignedValue).toBe(0);
    expect(rows.find((r) => r.repId === EST2)!.wonUnsignedValue).toBe(30000);
    const evOwn = await getDirectorCommissionEvidence(tdb, { repId: OWN2, metric: "won_unsigned", from: FROM, to: TO });
    const evEst = await getDirectorCommissionEvidence(tdb, { repId: EST2, metric: "won_unsigned", from: FROM, to: TO });
    expect(evOwn.records.some((r) => r.navId === U("d13"))).toBe(false);
    expect(evEst.records.some((r) => r.navId === U("d13"))).toBe(true);
  });

  it("potential evidence reconciles to pipeline REVENUE (cell is revenue × rate)", async () => {
    const ev = await getDirectorCommissionEvidence(tdb, { repId: REP, metric: "potential", from: FROM, to: TO });
    // drawer total is the pipeline revenue, not the commission cell
    expect(ev.total.value).toBe(220000);
    expect(ev.records.every((r) => r.navKind === "deal")).toBe(true);
  });

  it("earned records carry per-deal earned $ and navigate to the deal", async () => {
    const ev = await getDirectorCommissionEvidence(tdb, { repId: REP, metric: "earned", from: FROM, to: TO });
    expect(ev.records).toHaveLength(1);
    expect(ev.records[0]).toMatchObject({ value: 2500, navKind: "deal", navId: U("d04"), primary: "D-4" });
  });

  it("below-floor manager's earned drawer RECONCILES to the cell via a manager-override row", async () => {
    const { rows } = await getDirectorCommissionWorkspace(tdb, { from: FROM, to: TO });
    const mgr = rows.find((r) => r.repId === MGR)!;
    // cell = direct (held at $0 below floor) + override (0.10 * 5000) = $500
    expect(mgr.totalEarnedCommission).toBe(500);

    const ev = await getDirectorCommissionEvidence(tdb, { repId: MGR, metric: "earned", from: FROM, to: TO });
    // drawer total equals the clicked cell (the whole point) — NOT $0
    expect(ev.total.value).toBe(500);
    const overrideRow = ev.records.find((r) => r.id === "manager-override");
    expect(overrideRow).toMatchObject({ value: 500, navKind: null });
    expect(ev.subtitle.toLowerCase()).toContain("override");
  });

  it("activity records navigate to the linked deal when present, else are non-navigable", async () => {
    const ev = await getDirectorCommissionEvidence(tdb, { repId: REP, metric: "calls", from: FROM, to: TO });
    expect(ev.records).toHaveLength(3);
    const linked = ev.records.find((r) => r.navId === U("d01"));
    expect(linked?.navKind).toBe("deal");
    expect(ev.records.filter((r) => r.navId === null)).toHaveLength(2);
  });
});
