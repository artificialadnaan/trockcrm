import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  getDirectorCommissionWorkspace,
  getDirectorCommissionEvidence,
  getCommissionOfficeTotals,
  getRepDealPipelineSummary,
  getRepCommissionSummary,
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
const HELD = U("f07"); // below their OWN floor with earned commission but NO override -> held-only earned cell
const XMGR = U("f08"); // office A manager: below own floor (held direct) + override rate, only report is cross-office
const XREP = U("f09"); // office B rep reporting to XMGR -> OFF the roster when the view is scoped to office A
const SRCDIR = U("f10"); // a DIRECTOR (Chase Kelly) who SOURCES: owns nothing, holds only a sales_source dsc row
const OFF_A = U("0a1");
const OFF_B = U("0b1");
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
      estimator_user_id uuid, sales_source_user_id uuid, stage_id uuid NOT NULL, company_id uuid, property_id uuid,
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
    CREATE TABLE user_office_access (user_id uuid, office_id uuid);

    INSERT INTO users (id, display_name, role, reports_to) VALUES
      ('${REP}','Kaleb','rep', NULL), ('${OTHER}','Owner','rep', NULL),
      ('${MGR}','Manager','rep', NULL), ('${REPORT}','Report','rep','${MGR}'), ('${BOOKED}','Booked','rep', NULL),
      ('${NONREP}','Director Dana','director', NULL), ('${EST2}','Estimator Two','rep', NULL), ('${OWN2}','Owner Two','rep', NULL),
      ('${HELD}','Held Rep','rep', NULL);
    INSERT INTO users (id, display_name, role, reports_to, office_id) VALUES
      ('${XMGR}','XMgr A','rep', NULL, '${OFF_A}'),
      ('${XREP}','XRep B','rep','${XMGR}','${OFF_B}'),
      -- Chase Kelly is a director homed in office B: unscoped he's on the earned roster (his sales_source
      -- cut), but scoped to office A he must be EXCLUDED (no A membership) — the security boundary.
      ('${SRCDIR}','Chase Kelly','director', NULL, '${OFF_B}');
    INSERT INTO user_commission_settings (user_id, is_active, commission_rate, rolling_floor, override_rate) VALUES
      ('${REP}', true, 0.05, 0, 0),
      ('${MGR}', true, 0.05, 1000000, 0.10),  -- MGR below their own $1M floor -> direct earned $0
      ('${REPORT}', true, 0.05, 0, 0),
      ('${BOOKED}', true, 0.05, 0, 0),
      ('${HELD}', true, 0.05, 1000000, 0),  -- below their own $1M floor, NO override -> held-only earned cell
      ('${XMGR}', true, 0.05, 1000000, 0.10),  -- office A; below own $1M floor (held direct) + override on reports
      ('${XREP}', true, 0.05, 0, 0);  -- office B; floor 0 -> earns $5000 (XMGR's override base only if same office)
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
    -- SRCDIR (a director) SOURCED D-4 (owned by REP): an additive sales_source cut of $250. This is what
    -- makes a NON-rep appear on the earned roster; REP's owner earned (2500) and every deal-VALUE total are
    -- unchanged (a sales_source row carries no deal-VALUE and REP still owns D-4).
    INSERT INTO deal_signed_commissions (id, deal_id, rep_user_id, amount, source_value_amount, attribution_role, contract_signed_date_at_signing)
      VALUES ('${U("dc20")}','${U("d04")}','${SRCDIR}', 250, 50000, 'sales_source', '2026-03-01');
    -- NONREP (Director Dana) ALSO OWNS D-12 ($45k). Give them a sales_source cut so they're a rostered
    -- non-rep earner who additionally owns a deal — proving their owned deal is NOT counted in their row's
    -- deal-VALUE columns (which would otherwise break rows-vs-footer reconciliation, Codex P2).
    INSERT INTO deal_signed_commissions (id, deal_id, rep_user_id, amount, source_value_amount, attribution_role, contract_signed_date_at_signing)
      VALUES ('${U("dc21")}','${U("d01")}','${NONREP}', 300, 60000, 'sales_source', '2026-03-01');

    -- REPORT's signed deal (owned by REPORT) + dsc -> REPORT direct earned $5000 (floor met). MGR earns
    -- override 0.10 * 5000 = $500 and NOTHING direct (below their own $1M floor).
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, awarded_amount, contract_signed_at) VALUES
      ('${U("d07")}','D-7','Report Signed','${REPORT}','${ST.opportunity}', 100000, '2026-03-01T00:00:00Z');
    INSERT INTO deal_signed_commissions (id, deal_id, rep_user_id, amount, source_value_amount, attribution_role, contract_signed_date_at_signing)
      VALUES ('${U("dc2")}','${U("d07")}','${REPORT}', 5000, 100000, 'owner', '2026-03-01');

    -- HELD's signed deal (owned by HELD) + dsc -> direct earned $5000, but HELD is below their $1M floor and
    -- has NO override, so the team Earned cell shows the HELD GROSS ($5000), totalEarnedCommission = $0. The
    -- earned drill must reconcile to the displayed $5000 (gross), not the gated $0. Opportunity stage +
    -- contract-signed -> excluded from pipeline + won·unsigned, so it doesn't perturb the office totals.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, awarded_amount, contract_signed_at) VALUES
      ('${U("d14")}','D-14','Held Signed','${HELD}','${ST.opportunity}', 100000, '2026-03-01T00:00:00Z');
    INSERT INTO deal_signed_commissions (id, deal_id, rep_user_id, amount, source_value_amount, attribution_role, contract_signed_date_at_signing)
      VALUES ('${U("dc5")}','${U("d14")}','${HELD}', 5000, 100000, 'owner', '2026-03-01');

    -- Cross-office override scoping: XMGR (office A) owns a signed deal -> \$5000 direct, held below their \$1M
    -- floor. XREP (office B) owns a signed deal -> \$5000 earned (floor 0). XREP reports to XMGR but sits in a
    -- DIFFERENT office, so scoped to office A the override roster excludes XREP -> XMGR's override is \$0
    -- in-office (held-only); unscoped it's \$500. Opportunity-stage + signed -> excluded from pipeline/won totals.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, awarded_amount, contract_signed_at) VALUES
      ('${U("d15")}','D-15','XMgr Signed','${XMGR}','${ST.opportunity}', 100000, '2026-03-01T00:00:00Z'),
      ('${U("d16")}','D-16','XRep Signed','${XREP}','${ST.opportunity}', 100000, '2026-03-01T00:00:00Z');
    INSERT INTO deal_signed_commissions (id, deal_id, rep_user_id, amount, source_value_amount, attribution_role, contract_signed_date_at_signing) VALUES
      ('${U("dc6")}','${U("d15")}','${XMGR}', 5000, 100000, 'owner', '2026-03-01'),
      ('${U("dc7")}','${U("d16")}','${XREP}', 5000, 100000, 'owner', '2026-03-01');

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

  it("a NON-rep source (a director like Chase Kelly) with a sales_source cut is ON the roster and reconciles", async () => {
    const { rows, officeTotals } = await getDirectorCommissionWorkspace(tdb, { from: FROM, to: TO });
    const dir = rows.find((r) => r.repId === SRCDIR);
    // The director now appears on the Team Commissions roster because they EARNED a sales_source cut —
    // previously the roster was rep-only, so their cut was invisible + non-drillable here even though the
    // report-builder aggregate and the evidence drawer both already included it.
    expect(dir).toBeTruthy();
    expect(dir!.totalEarnedCommission).toBe(250);
    // They own no deal, so every deal-VALUE column is 0 — a clean earned-only row.
    expect(dir!.pipelineValue).toBe(0);
    expect(dir!.activeDeals).toBe(0);
    expect(dir!.wonUnsignedValue).toBe(0);
    // The earned drawer reconciles to the cell (roster row + drawer + aggregate now move together).
    const ev = await getDirectorCommissionEvidence(tdb, { repId: SRCDIR, metric: "earned", from: FROM, to: TO });
    expect(ev.total.value).toBe(dir!.totalEarnedCommission);
    expect(ev.total.value).toBe(250);
    // Deal-VALUE office totals are unaffected by the additive sales_source row (still 220k pipeline).
    expect(officeTotals.pipelineValue).toBe(220000);
  });

  it("a non-rep source's OWNED deals do NOT bleed into its deal-VALUE / funnel / potential columns (Codex P2)", async () => {
    // NONREP (Director Dana) OWNS D-12 ($45k, active) AND earned a $300 sales_source cut. On the roster as a
    // non-rep earner, their EARNED column shows the cut, but their deal-VALUE/funnel/potential columns are 0
    // — their owned deal must NOT appear (the deal-VALUE footer counts reps only, so it would otherwise
    // inflate the visible rows above the footer, breaking reconciliation).
    const { rows, officeTotals } = await getDirectorCommissionWorkspace(tdb, { from: FROM, to: TO });
    const dana = rows.find((r) => r.repId === NONREP)!;
    expect(dana).toBeTruthy();
    expect(dana.totalEarnedCommission).toBe(300); // the sales_source cut IS shown (why they're rostered)
    expect(dana.activeDeals).toBe(0);              // owns D-12 but it's excluded from their row
    expect(dana.pipelineValue).toBe(0);
    expect(dana.potentialCommission).toBe(0);      // pipeline-derived → zeroed for a non-rep
    // Footer still counts reps only — D-12 (non-rep-owned) stays excluded, so it reconciles with the rows.
    expect(officeTotals.pipelineValue).toBe(220000);

    // The drawer reconciles with the zeroed cells: a deal-VALUE metric for a non-rep is EMPTY, earned matches.
    expect((await getDirectorCommissionEvidence(tdb, { repId: NONREP, metric: "pipeline", from: FROM, to: TO })).total.value).toBe(0);
    expect((await getDirectorCommissionEvidence(tdb, { repId: NONREP, metric: "active", from: FROM, to: TO })).total.count).toBe(0);
    expect((await getDirectorCommissionEvidence(tdb, { repId: NONREP, metric: "earned", from: FROM, to: TO })).total.value).toBe(300);

    // P: the row exposes isRep so the client can suppress the rep-detail link for a non-rep source row.
    expect(dana.isRep).toBe(false);
    expect(rows.find((r) => r.repId === REP)!.isRep).toBe(true);
  });

  it("O: a non-rep source row surfaces its OWN earned commission only, NOT a manager override", async () => {
    // MGR is a below-floor manager (direct earned $0) who collects a $500 override on their report REPORT.
    // Rep rows include that override; a non-rep source row must NOT (includeManagerOverride=false) — the
    // manager-override roll-up is deliberately rep-only, so a director's row shows their source cut only.
    const withOverride = await getRepCommissionSummary(tdb, MGR, FROM, TO, undefined, true);
    const withoutOverride = await getRepCommissionSummary(tdb, MGR, FROM, TO, undefined, false);
    expect(withOverride.summary.totalEarnedCommission).toBe(500);   // override included (rep row behavior)
    expect(withoutOverride.summary.totalEarnedCommission).toBe(0);  // override excluded (non-rep source row)
  });

  it("SECURITY: a non-rep earner is admitted only as an active-office MEMBER — a foreign-office director is excluded when scoped", async () => {
    // Chase Kelly (SRCDIR) is a director homed in office B with a sales_source cut. The tenant schema is
    // shared across offices, so the earned-row EXISTS alone is NOT office-bound — the non-rep roster branch
    // must apply the SAME active-office membership check as reps, or a director viewing office A could pull a
    // foreign-office earner into the A-scoped roster and drill their totals.
    const unscoped = await getDirectorCommissionWorkspace(tdb, { from: FROM, to: TO });
    expect(unscoped.rows.some((r) => r.repId === SRCDIR)).toBe(true); // on the roster with no office scope

    const scopedA = await getDirectorCommissionWorkspace(tdb, { from: FROM, to: TO, officeId: OFF_A });
    expect(scopedA.rows.some((r) => r.repId === SRCDIR)).toBe(false); // office-B member excluded from office A

    // ...but INCLUDED when scoped to their HOME office (member of OFF_B) — the boundary admits members, it
    // doesn't over-exclude a legitimate home-office director (the other side of the office-scope boundary).
    const scopedB = await getDirectorCommissionWorkspace(tdb, { from: FROM, to: TO, officeId: OFF_B });
    expect(scopedB.rows.some((r) => r.repId === SRCDIR)).toBe(true);

    // N: the EARNED drawer must enforce the same boundary — a non-rep off the scoped roster returns EMPTY
    // (no deal names/amounts leak) when scoped to a foreign office, but drills normally unscoped / in-office.
    expect((await getDirectorCommissionEvidence(tdb, { repId: SRCDIR, metric: "earned", from: FROM, to: TO, officeId: OFF_A })).total.value).toBe(0);
    expect((await getDirectorCommissionEvidence(tdb, { repId: SRCDIR, metric: "earned", from: FROM, to: TO })).total.value).toBe(250);
    expect((await getDirectorCommissionEvidence(tdb, { repId: SRCDIR, metric: "earned", from: FROM, to: TO, officeId: OFF_B })).total.value).toBe(250);
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

  it("below-floor rep with NO override: earned drawer shows HELD GROSS, reconciling with the held cell (not $0)", async () => {
    const { rows } = await getDirectorCommissionWorkspace(tdb, { from: FROM, to: TO });
    const held = rows.find((r) => r.repId === HELD)!;
    // Below their $1M floor with $5k earned and NO override -> nothing payable, so the team cell shows the
    // HELD GROSS ($5k), not the gated $0.
    expect(held.floorMet).toBe(false);
    expect(held.totalEarnedCommission).toBe(0);
    expect(held.heldEarnedCommission).toBe(5000);

    const ev = await getDirectorCommissionEvidence(tdb, { repId: HELD, metric: "earned", from: FROM, to: TO });
    // The drawer reconciles to the DISPLAYED held figure ($5k), and the per-deal rows carry the gross held
    // commission so Σ records === the clicked number (the page contract). No override summary row here.
    expect(ev.total.value).toBe(5000);
    expect(ev.records.reduce((s, r) => s + (r.value ?? 0), 0)).toBe(5000);
    expect(ev.records.some((r) => r.id === "manager-override")).toBe(false);
    expect(ev.subtitle.toLowerCase()).toContain("held");
  });

  it("held-only detection is OFFICE-SCOPED: a manager with only a cross-office report stays held in-office (Codex P2)", async () => {
    // XMGR (office A) is below their $1M floor with $5k held direct; their only report XREP is in office B.
    // Scoped to office A, XREP is off-roster -> override $0 -> the row is held-only. The earned drawer, scoped
    // to the SAME office, must also see override $0 and show the held gross ($5k) — not the cross-office override.
    const { rows } = await getDirectorCommissionWorkspace(tdb, { from: FROM, to: TO, officeId: OFF_A });
    const xmgr = rows.find((r) => r.repId === XMGR)!;
    expect(xmgr.floorMet).toBe(false);
    expect(xmgr.totalEarnedCommission).toBe(0); // override scoped out -> nothing payable
    expect(xmgr.heldEarnedCommission).toBe(5000);

    const evScoped = await getDirectorCommissionEvidence(tdb, { repId: XMGR, metric: "earned", from: FROM, to: TO, officeId: OFF_A });
    expect(evScoped.total.value).toBe(5000); // held gross, reconciles with the in-office row
    expect(evScoped.records.some((r) => r.id === "manager-override")).toBe(false);
    expect(evScoped.subtitle.toLowerCase()).toContain("held");

    // Without the office scope (the bug being fixed), the unscoped override pulls in the cross-office report,
    // so heldOnly flips off and the drawer surfaces the foreign $500 override — contradicting the held-only row.
    const evUnscoped = await getDirectorCommissionEvidence(tdb, { repId: XMGR, metric: "earned", from: FROM, to: TO });
    expect(evUnscoped.total.value).toBe(500);
    expect(evUnscoped.records.some((r) => r.id === "manager-override")).toBe(true);
  });

  it("activity records navigate to the linked deal when present, else are non-navigable", async () => {
    const ev = await getDirectorCommissionEvidence(tdb, { repId: REP, metric: "calls", from: FROM, to: TO });
    expect(ev.records).toHaveLength(3);
    const linked = ev.records.find((r) => r.navId === U("d01"));
    expect(linked?.navKind).toBe("deal");
    expect(ev.records.filter((r) => r.navId === null)).toHaveLength(2);
  });
});
