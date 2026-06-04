import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  discoverDealTenants,
  fetchMissingCloseDateDeals,
  groupDealsByRep,
  type Queryable,
} from "../../../scripts/lib/close-date-workflow.js";

/**
 * REAL-SQL (PGlite) coverage of the EXPORT query: it must surface ONLY open,
 * rep-actionable deals that are missing an expected close date, across every
 * office_* tenant schema, with rep/company/stage resolved — then group one
 * bucket per rep (NULL rep -> Unassigned), spanning offices.
 */
const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const REP = { alice: U("a11ce"), bob: U("b0b"), gone: U("90e"), ghost: U("9805") };
const CO = { acme: U("c0a11e") };
const ST = { est: U("57e57"), won: U("57007") };
const D = {
  d1_alice_dallas: U("d01"),
  d2_has_date: U("d02"),
  d3_bob_dallas: U("d03"),
  d4_won_terminal: U("d04"),
  d5_test_data: U("d05"),
  d6_inactive: U("d06"),
  d7_mirror: U("d07"),
  d8_unassigned: U("d08"),
  d9_alice_atlanta: U("d09"),
  d10_bob_atlanta: U("d10"),
  d11_inactive_rep: U("d11"),
  d12_orphan_rep: U("d12"),
};

let pg: PGlite;
let client: Queryable;

function dealsDDL(schema: string): string {
  return `
    CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.companies (id uuid PRIMARY KEY, name varchar(500) NOT NULL);
    CREATE TABLE ${schema}.deals (
      id uuid PRIMARY KEY,
      deal_number varchar(50) NOT NULL,
      name varchar(500) NOT NULL,
      stage_id uuid NOT NULL,
      assigned_rep_id uuid,
      company_id uuid,
      expected_close_date date,
      awarded_amount numeric, bid_estimate numeric, dd_estimate numeric, forecast_revenue numeric,
      is_active boolean NOT NULL DEFAULT true,
      is_test_data boolean NOT NULL DEFAULT false,
      is_read_only_mirror boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `;
}

beforeAll(async () => {
  pg = new PGlite();
  client = { query: (text: string, params?: unknown[]) => pg.query(text, params) };
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text NOT NULL, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL, is_terminal boolean NOT NULL DEFAULT false);
    INSERT INTO users (id, display_name, is_active) VALUES ('${REP.alice}','Alice', true), ('${REP.bob}','Bob', true), ('${REP.gone}','Gary Gone', false);
    INSERT INTO pipeline_stage_config (id, slug, name, is_terminal) VALUES
      ('${ST.est}','estimating','Estimating', false), ('${ST.won}','won','Won', true);
    ${dealsDDL("office_dallas")}
    ${dealsDDL("office_atlanta")}
    INSERT INTO office_dallas.companies (id, name) VALUES ('${CO.acme}','Acme Property Group');

    INSERT INTO office_dallas.deals (id, deal_number, name, stage_id, assigned_rep_id, company_id, expected_close_date, bid_estimate, is_active, is_test_data, is_read_only_mirror) VALUES
      ('${D.d1_alice_dallas}','DFW-1-00001-aa','Roof A','${ST.est}','${REP.alice}','${CO.acme}', NULL, 125000, true, false, false),   -- INCLUDED
      ('${D.d2_has_date}',    'DFW-1-00002-aa','Roof B','${ST.est}','${REP.alice}', NULL,        '2026-01-01', NULL, true, false, false), -- excluded: already has a date
      ('${D.d3_bob_dallas}',  'DFW-1-00003-aa','Roof C','${ST.est}','${REP.bob}',   NULL,        NULL, NULL, true, false, false),         -- INCLUDED
      ('${D.d4_won_terminal}','DFW-1-00004-aa','Roof D','${ST.won}','${REP.alice}', NULL,        NULL, NULL, true, false, false),         -- excluded: terminal stage
      ('${D.d5_test_data}',   'DFW-1-00005-aa','Roof E','${ST.est}','${REP.alice}', NULL,        NULL, NULL, true, true,  false),         -- excluded: test data
      ('${D.d6_inactive}',    'DFW-1-00006-aa','Roof F','${ST.est}','${REP.alice}', NULL,        NULL, NULL, false, false, false),        -- excluded: inactive
      ('${D.d7_mirror}',      'DFW-1-00007-aa','Roof G','${ST.est}','${REP.alice}', NULL,        NULL, NULL, true, false, true),          -- excluded: read-only mirror
      ('${D.d8_unassigned}',  'DFW-1-00008-aa','Roof H','${ST.est}', NULL,          NULL,        NULL, NULL, true, false, false),          -- INCLUDED (unassigned)
      ('${D.d11_inactive_rep}','DFW-1-00011-aa','Roof K','${ST.est}','${REP.gone}',  NULL,        NULL, NULL, true, false, false),          -- INCLUDED -> Unassigned (rep inactive)
      ('${D.d12_orphan_rep}', 'DFW-1-00012-aa','Roof L','${ST.est}','${REP.ghost}', NULL,        NULL, NULL, true, false, false);          -- INCLUDED -> Unassigned (rep row missing)

    INSERT INTO office_atlanta.deals (id, deal_number, name, stage_id, assigned_rep_id, expected_close_date, is_active) VALUES
      ('${D.d9_alice_atlanta}', 'ATL-1-00009-aa','Roof I','${ST.est}','${REP.alice}', NULL, true),  -- INCLUDED (alice spans offices)
      ('${D.d10_bob_atlanta}',  'ATL-1-00010-aa','Roof J','${ST.est}','${REP.bob}',   NULL, true);  -- INCLUDED
  `);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("close-date export query (PGlite)", () => {
  it("discovers every office_* schema that has a deals table", async () => {
    const tenants = await discoverDealTenants(client);
    expect(tenants).toEqual(["office_atlanta", "office_dallas"]);
  });

  it("returns ONLY open rep-actionable deals missing an expected close date, across offices", async () => {
    const deals = await fetchMissingCloseDateDeals(client);
    const ids = deals.map((d) => d.dealId).sort();
    expect(ids).toEqual(
      [
        D.d1_alice_dallas,
        D.d3_bob_dallas,
        D.d8_unassigned,
        D.d9_alice_atlanta,
        D.d10_bob_atlanta,
        D.d11_inactive_rep,
        D.d12_orphan_rep,
      ].sort(),
    );
  });

  it("routes deals owned by an inactive or missing rep into the single Unassigned bucket", async () => {
    const deals = await fetchMissingCloseDateDeals(client);
    const inactive = deals.find((d) => d.dealId === D.d11_inactive_rep)!;
    const orphan = deals.find((d) => d.dealId === D.d12_orphan_rep)!;
    // both are treated as unassigned (no active owner to fill the file)
    expect(inactive.assignedRepId).toBeNull();
    expect(inactive.repName).toBe("Unassigned");
    expect(orphan.assignedRepId).toBeNull();
    expect(orphan.repName).toBe("Unassigned");

    const groups = groupDealsByRep(deals);
    const unassignedGroups = groups.filter((g) => g.repName === "Unassigned");
    expect(unassignedGroups).toHaveLength(1); // exactly one Unassigned file, not one per orphan
  });

  it("resolves rep name, company, stage and tenant schema for each row", async () => {
    const deals = await fetchMissingCloseDateDeals(client);
    const d1 = deals.find((d) => d.dealId === D.d1_alice_dallas)!;
    expect(d1).toMatchObject({
      tenantSchema: "office_dallas",
      dealNumber: "DFW-1-00001-aa",
      dealName: "Roof A",
      companyName: "Acme Property Group",
      stageName: "Estimating",
      repName: "Alice",
      assignedRepId: REP.alice,
    });
    expect(d1.estimatedValue).toBe("125000");

    const unassigned = deals.find((d) => d.dealId === D.d8_unassigned)!;
    expect(unassigned.assignedRepId).toBeNull();
    expect(unassigned.repName).toBe("Unassigned");
  });

  it("groups one bucket per rep, each spanning offices", async () => {
    const groups = groupDealsByRep(await fetchMissingCloseDateDeals(client));
    expect(groups.map((g) => g.repName)).toEqual(["Alice", "Bob", "Unassigned"]);

    const alice = groups.find((g) => g.repName === "Alice")!;
    expect(alice.deals.map((d) => d.dealId).sort()).toEqual([D.d1_alice_dallas, D.d9_alice_atlanta].sort());
    expect(new Set(alice.deals.map((d) => d.tenantSchema))).toEqual(new Set(["office_dallas", "office_atlanta"]));

    const unassigned = groups.find((g) => g.repName === "Unassigned")!;
    expect(unassigned.deals.map((d) => d.dealId).sort()).toEqual(
      [D.d8_unassigned, D.d11_inactive_rep, D.d12_orphan_rep].sort(),
    );
  });
});
