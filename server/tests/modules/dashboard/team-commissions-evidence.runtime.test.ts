import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  getDirectorCommissionWorkspace,
  getDirectorCommissionEvidence,
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
const FROM = "2026-01-01";
const TO = "2026-12-31";

const ST = {
  opportunity: U("510"),
  estimating: U("520"),
  leadNew: U("530"),
  leadQual: U("540"),
  leadOpp: U("550"),
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

    INSERT INTO users (id, display_name, role) VALUES ('${REP}','Kaleb','rep'), ('${OTHER}','Owner','rep');
    INSERT INTO user_commission_settings (user_id, is_active, commission_rate, rolling_floor, override_rate)
      VALUES ('${REP}', true, 0.05, 0, 0);
    INSERT INTO companies (id, name) VALUES ('${CO}','Acme');
    INSERT INTO pipeline_stage_config (id, slug, name, workflow_family) VALUES
      ('${ST.opportunity}','opportunity','Opportunity','pipeline'),
      ('${ST.estimating}','estimating','Estimating','pipeline'),
      ('${ST.leadNew}','new_lead','New Lead','lead'),
      ('${ST.leadQual}','qualified_lead','Qualified Lead','lead'),
      ('${ST.leadOpp}','opportunity_lead_placeholder','Opp','lead');
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

    -- EARNED: a signed deal (D-4 above, opportunity stage, not lost) with a dsc row for REP.
    INSERT INTO deal_signed_commissions (id, deal_id, rep_user_id, amount, source_value_amount, attribution_role, contract_signed_date_at_signing)
      VALUES ('${U("dc1")}','${U("d04")}','${REP}', 2500, 50000, 'owner', '2026-03-01');

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

    // sanity on the concrete fixture numbers
    expect(row.activeDeals).toBe(3); // D1 + D2(estimator) + D3
    expect(row.pipelineValue).toBe(220000); // 100k + 50k(40k+10kCO) + 70k
    expect(row.estimating).toBe(1); // D3 only
    expect(row.leads).toBe(2);
    expect(row.qualifiedLeads).toBe(1);
    expect(row.opportunities).toBe(1);
    expect(row.calls).toBe(3);
    expect(row.emails).toBe(2);
    expect(row.meetings).toBe(1);
    expect(row.totalEarnedCommission).toBe(2500);
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

  it("activity records navigate to the linked deal when present, else are non-navigable", async () => {
    const ev = await getDirectorCommissionEvidence(tdb, { repId: REP, metric: "calls", from: FROM, to: TO });
    expect(ev.records).toHaveLength(3);
    const linked = ev.records.find((r) => r.navId === U("d01"));
    expect(linked?.navKind).toBe("deal");
    expect(ev.records.filter((r) => r.navId === null)).toHaveLength(2);
  });
});
