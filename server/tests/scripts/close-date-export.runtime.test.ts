import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  discoverDealTenants,
  fetchMissingCloseDateDeals,
  groupDealsByRep,
  type Queryable,
} from "../../../scripts/lib/close-date-workflow.js";

/**
 * REAL-SQL (PGlite) coverage of the v2 EXPORT query: it must surface every OPEN
 * deal whose expected close date is UN-MAINTAINED — NULL (missing) OR in the past
 * (stale) — matching the app's at-risk/coverage scope, INCLUDING Bid Board Owned
 * (read-only mirror) deals, and EXCLUDING future-dated/terminal/test/on-hold/
 * orphan-stage deals. `today` is injected so the past/future split is deterministic.
 */
const TODAY = "2026-06-04";
const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const REP = { alice: U("a11ce"), bob: U("b0b"), gone: U("90e") };
const CO = { acme: U("c0a11e") };
const ST = { est: U("57e57"), won: U("57007"), orphan: U("57bad") };
const D = {
  d1_missing: U("d01"),
  d2_stale: U("d02"),
  d3_future: U("d03"),
  d4_won: U("d04"),
  d5_test: U("d05"),
  d6_hold: U("d06"),
  d7_mirror_missing: U("d07"),
  d8_mirror_stale: U("d08"),
  d9_unassigned: U("d09"),
  d10_orphan_stage: U("d10"),
  d11_inactive_rep: U("d11"),
  d12_today: U("d12"), // expected_close_date == today -> maintained -> excluded
  d13_owned: U("d13"), // is_bid_board_owned=true, NOT a read-only mirror -> flag must be true
  a1_missing: U("a01"),
  a2_stale: U("a02"),
};

let pg: PGlite;
let client: Queryable;

function dealsDDL(schema: string): string {
  return `
    CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.companies (id uuid PRIMARY KEY, name varchar(500) NOT NULL);
    CREATE TABLE ${schema}.deals (
      id uuid PRIMARY KEY, deal_number varchar(50) NOT NULL, name varchar(500) NOT NULL, stage_id uuid NOT NULL,
      assigned_rep_id uuid, company_id uuid, expected_close_date date,
      awarded_amount numeric, bid_estimate numeric, dd_estimate numeric, forecast_revenue numeric,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      is_read_only_mirror boolean NOT NULL DEFAULT false, is_bid_board_owned boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );`;
}

beforeAll(async () => {
  pg = new PGlite();
  client = { query: (text: string, params?: unknown[]) => pg.query(text, params) };
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text NOT NULL, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL, is_terminal boolean NOT NULL DEFAULT false);
    INSERT INTO users (id, display_name, is_active) VALUES ('${REP.alice}','Alice', true), ('${REP.bob}','Bob', true), ('${REP.gone}','Gary Gone', false);
    INSERT INTO pipeline_stage_config (id, slug, name, is_terminal) VALUES ('${ST.est}','estimating','Estimating', false), ('${ST.won}','won','Won', true);
    ${dealsDDL("office_dallas")}
    ${dealsDDL("office_atlanta")}
    INSERT INTO office_dallas.companies (id, name) VALUES ('${CO.acme}','Acme Property Group');

    INSERT INTO office_dallas.deals (id, deal_number, name, stage_id, assigned_rep_id, company_id, expected_close_date, bid_estimate, is_active, is_test_data, is_read_only_mirror, on_hold) VALUES
      ('${D.d1_missing}',       'DFW-1-00001-aa','Roof A','${ST.est}','${REP.alice}','${CO.acme}', NULL,         125000, true, false, false, false),
      ('${D.d2_stale}',        'DFW-1-00002-aa','Roof B','${ST.est}','${REP.alice}', NULL,        '2026-01-01', NULL,   true, false, false, false),
      ('${D.d3_future}',       'DFW-1-00003-aa','Roof C','${ST.est}','${REP.alice}', NULL,        '2026-12-01', NULL,   true, false, false, false),
      ('${D.d4_won}',          'DFW-1-00004-aa','Roof D','${ST.won}','${REP.alice}', NULL,        NULL,         NULL,   true, false, false, false),
      ('${D.d5_test}',         'DFW-1-00005-aa','Roof E','${ST.est}','${REP.alice}', NULL,        NULL,         NULL,   true, true,  false, false),
      ('${D.d6_hold}',         'DFW-1-00006-aa','Roof F','${ST.est}','${REP.alice}', NULL,        NULL,         NULL,   true, false, false, true),
      ('${D.d7_mirror_missing}','DFW-1-00007-aa','Roof G','${ST.est}','${REP.alice}', NULL,       NULL,         NULL,   true, false, true,  false),
      ('${D.d8_mirror_stale}', 'DFW-1-00008-aa','Roof H','${ST.est}','${REP.bob}',   NULL,        '2026-02-01', NULL,   true, false, true,  false),
      ('${D.d9_unassigned}',   'DFW-1-00009-aa','Roof I','${ST.est}', NULL,          NULL,        NULL,         NULL,   true, false, false, false),
      ('${D.d10_orphan_stage}','DFW-1-00010-aa','Roof J','${ST.orphan}','${REP.alice}', NULL,     NULL,         NULL,   true, false, false, false),
      ('${D.d11_inactive_rep}','DFW-1-00011-aa','Roof K','${ST.est}','${REP.gone}',  NULL,        NULL,         NULL,   true, false, false, false);

    INSERT INTO office_dallas.deals (id, deal_number, name, stage_id, assigned_rep_id, expected_close_date) VALUES
      ('${D.d12_today}','DFW-1-00012-aa','Roof N','${ST.est}','${REP.alice}','${TODAY}'); -- excluded: dated exactly today (maintained)
    INSERT INTO office_dallas.deals (id, deal_number, name, stage_id, assigned_rep_id, expected_close_date, is_bid_board_owned) VALUES
      ('${D.d13_owned}','DFW-1-00013-aa','Roof O','${ST.est}','${REP.alice}', NULL, true); -- INCLUDED: Bid Board Owned (not a read-only mirror)

    INSERT INTO office_atlanta.deals (id, deal_number, name, stage_id, assigned_rep_id, expected_close_date, is_active) VALUES
      ('${D.a1_missing}','ATL-1-00001-aa','Roof L','${ST.est}','${REP.bob}',   NULL,         true),
      ('${D.a2_stale}',  'ATL-1-00002-aa','Roof M','${ST.est}','${REP.alice}', '2026-03-01', true);
  `);
});

afterAll(async () => {
  await pg?.close?.();
});

const INCLUDED = [
  D.d1_missing, D.d2_stale, D.d7_mirror_missing, D.d8_mirror_stale, D.d9_unassigned, D.d11_inactive_rep, D.d13_owned, D.a1_missing, D.a2_stale,
];

describe("close-date v2 export query (PGlite)", () => {
  it("discovers every office_* schema that has a deals table", async () => {
    expect(await discoverDealTenants(client)).toEqual(["office_atlanta", "office_dallas"]);
  });

  it("returns every un-maintained open deal (NULL or past), incl. Bid Board Owned; excludes future/terminal/test/on-hold/orphan-stage", async () => {
    const deals = await fetchMissingCloseDateDeals(client, undefined, TODAY);
    expect(deals.map((d) => d.dealId).sort()).toEqual([...INCLUDED].sort());
  });

  it("tags each deal with a reason (missing vs past_due) and carries the existing stale date", async () => {
    const deals = await fetchMissingCloseDateDeals(client, undefined, TODAY);
    const missing = deals.find((d) => d.dealId === D.d1_missing)!;
    expect(missing.reason).toBe("missing");
    expect(missing.currentCloseDate).toBeNull();
    expect(missing.companyName).toBe("Acme Property Group");

    const stale = deals.find((d) => d.dealId === D.d2_stale)!;
    expect(stale.reason).toBe("past_due");
    expect(stale.currentCloseDate).toBe("2026-01-01");
  });

  it("flags Bid Board Owned deals — both is_bid_board_owned and read-only mirrors", async () => {
    const deals = await fetchMissingCloseDateDeals(client, undefined, TODAY);
    expect(deals.find((d) => d.dealId === D.d7_mirror_missing)!.isBidBoardOwned).toBe(true); // read-only mirror
    expect(deals.find((d) => d.dealId === D.d8_mirror_stale)!.isBidBoardOwned).toBe(true); // read-only mirror
    expect(deals.find((d) => d.dealId === D.d13_owned)!.isBidBoardOwned).toBe(true); // is_bid_board_owned, NOT a mirror
    expect(deals.find((d) => d.dealId === D.d1_missing)!.isBidBoardOwned).toBe(false);
  });

  it("excludes a future-dated (maintained) deal, and one dated exactly today (boundary)", async () => {
    const deals = await fetchMissingCloseDateDeals(client, undefined, TODAY);
    expect(deals.find((d) => d.dealId === D.d3_future)).toBeUndefined();
    expect(deals.find((d) => d.dealId === D.d12_today)).toBeUndefined(); // == today is maintained
  });

  it("routes inactive/unassigned-rep deals into the single Unassigned group; groups others per rep across offices", async () => {
    const groups = groupDealsByRep(await fetchMissingCloseDateDeals(client, undefined, TODAY));
    expect(groups.map((g) => g.repName)).toEqual(["Alice", "Bob", "Unassigned"]);
    const unassigned = groups.find((g) => g.repName === "Unassigned")!;
    expect(unassigned.deals.map((d) => d.dealId).sort()).toEqual([D.d9_unassigned, D.d11_inactive_rep].sort());
    const alice = groups.find((g) => g.repName === "Alice")!;
    expect(new Set(alice.deals.map((d) => d.tenantSchema))).toEqual(new Set(["office_dallas", "office_atlanta"]));
  });
});
