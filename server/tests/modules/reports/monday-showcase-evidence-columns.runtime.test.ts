import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getMondayShowcaseEvidence } from "../../../src/modules/reports/monday-showcase-service.js";
import { getWonCloseSummary } from "../../../src/modules/dashboard/service.js";
import { getWtdPeriod } from "../../../src/lib/period.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) proof for the enriched drill-down columns (Feedback 2). The drawer now shows, per
 * record, Company/account, Region, Type, and Days-in-stage on top of name/owner/value/date. This drives
 * the LIVE getMondayShowcaseEvidence and asserts:
 *   - the new columns are populated from the deal's company / region_config / project_type / stage_entered_at,
 *     INCLUDING the region fallback (company.region empty -> the deal's region_config name);
 *   - leads get company/type/age too (region via the company);
 *   - the additive LEFT JOINs DON'T change the cohort: the Won evidence count/$ still reconcile to the
 *     protected getWonCloseSummary.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const REP = U("a01");
const ST = { won: U("57001"), leadNew: U("57005") };
const CO = { acme: U("c0001"), beta: U("c0002") };
const RC = { northTx: U("d0001") };
const PT = { commercial: U("e0001") };
const D = { won1: U("11001"), won2: U("11002") };
const L = { l1: U("41001") };
const NOW = new Date("2026-05-27T18:00:00Z");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`); // deterministic CURRENT_DATE day-diff for days_in_stage
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text NOT NULL);
    CREATE TABLE pipeline_stage_config (
      id uuid PRIMARY KEY, name text NOT NULL, slug text UNIQUE NOT NULL,
      workflow_family text NOT NULL DEFAULT 'standard_deal', is_terminal boolean NOT NULL DEFAULT false
    );
    CREATE TABLE companies (id uuid PRIMARY KEY, name text NOT NULL, region text);
    CREATE TABLE region_config (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE project_type_config (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, deal_number text, project_number text, name text NOT NULL, stage_id uuid NOT NULL,
      assigned_rep_id uuid, is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true, won_closed_date date, expected_close_date date,
      dd_estimate numeric, bid_estimate numeric, awarded_amount numeric, bid_board_total_sales numeric,
      company_id uuid, region_id uuid, project_type text, project_type_id uuid, stage_entered_at timestamptz,
      win_probability integer
    );
    CREATE TABLE leads (
      id uuid PRIMARY KEY, name text NOT NULL, stage_id uuid NOT NULL, assigned_rep_id uuid,
      status text NOT NULL DEFAULT 'open', is_active boolean NOT NULL DEFAULT true,
      is_test_data boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
      company_id uuid, project_type text, project_type_id uuid, stage_entered_at timestamptz
    );

    INSERT INTO users (id, display_name) VALUES ('${REP}', 'Alice Rep');
    INSERT INTO pipeline_stage_config (id, name, slug, workflow_family, is_terminal) VALUES
      ('${ST.won}', 'Won', '${WON_STAGE_SLUGS[0]}', 'standard_deal', true),
      ('${ST.leadNew}', 'New', 'lead_new', 'lead', false);
    INSERT INTO companies (id, name, region) VALUES
      ('${CO.acme}', 'Acme Roofing', 'DFW'),       -- has its own region text
      ('${CO.beta}', 'Beta Builders', NULL);       -- no company region -> falls back to region_config
    INSERT INTO region_config (id, name) VALUES ('${RC.northTx}', 'North Texas');
    INSERT INTO project_type_config (id, name) VALUES ('${PT.commercial}', 'Commercial');

    -- won1: Acme, region from the COMPANY ('DFW'); Type from the CANONICAL project_type_config ('Commercial')
    -- even though the legacy project_type text is stale; 12 days in stage.
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, won_closed_date, awarded_amount,
                       company_id, region_id, project_type, project_type_id, stage_entered_at, win_probability) VALUES
      ('${D.won1}','W-1','Won Acme','${ST.won}','${REP}','2026-05-26', 100000,
       '${CO.acme}', NULL, 'Comm (stale)', '${PT.commercial}', now() - interval '12 days', 65);
    -- won2: Beta (no company region) but region_id -> region_config 'North Texas' (FALLBACK); Type falls back
    -- to the legacy text ('Residential') since project_type_id is null.
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, won_closed_date, awarded_amount,
                       company_id, region_id, project_type, project_type_id, stage_entered_at) VALUES
      ('${D.won2}','W-2','Won Beta','${ST.won}','${REP}','2026-05-25', 50000,
       '${CO.beta}', '${RC.northTx}', 'Residential', NULL, now() - interval '3 days');

    -- lead: company Acme -> region 'DFW' via the company, Residential, 5 days in stage
    INSERT INTO leads (id, name, stage_id, assigned_rep_id, status, is_active, company_id, project_type, project_type_id, stage_entered_at) VALUES
      ('${L.l1}','Lead Acme','${ST.leadNew}','${REP}','open', true, '${CO.acme}', 'Residential', NULL, now() - interval '5 days');
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("enriched drill-down columns populate and stay reconciled", () => {
  it("Won evidence carries company/region/type/age AND still reconciles to getWonCloseSummary", async () => {
    const ev = await getMondayShowcaseEvidence(tdb, { metric: "won", mode: "to_date", now: NOW });
    const { from, to } = getWtdPeriod("to_date", NOW);
    const card = await getWonCloseSummary(tdb, { from, to });

    // Additive joins did NOT change the cohort: count + $ tie to the protected aggregate.
    expect(ev.total.count).toBe(card.count);
    expect(ev.total.value).toBeCloseTo(card.totalValue, 2);
    expect(ev.total.count).toBe(2);
    expect(ev.total.value).toBeCloseTo(150000, 2);

    const acme = ev.records.find((r) => r.dealNumber === "W-1")!;
    expect(acme.companyName).toBe("Acme Roofing");
    expect(acme.region).toBe("DFW"); // from the company
    expect(acme.dealType).toBe("Commercial"); // canonical project_type_config name, NOT the stale "Comm (stale)" legacy text
    expect(acme.daysInStage).toBeGreaterThanOrEqual(11);
    expect(acme.daysInStage).toBeLessThanOrEqual(13);
    expect(acme.winProbability).toBe(65); // the deal's real win_probability, surfaced as-is

    // region FALLBACK: Beta has no company region, so the deal's region_config name is used.
    const beta = ev.records.find((r) => r.dealNumber === "W-2")!;
    expect(beta.companyName).toBe("Beta Builders");
    expect(beta.region).toBe("North Texas");
    expect(beta.dealType).toBe("Residential"); // legacy fallback: no project_type_id, so the legacy text is used
    expect(beta.winProbability).toBeNull(); // blank win_probability stays null (unknown, NOT zero)
  });

  it("lead evidence carries company/region(via company)/type/age, with no deal value", async () => {
    const ev = await getMondayShowcaseEvidence(tdb, { metric: "leads", mode: "to_date", now: NOW });
    const lead = ev.records.find((r) => r.name === "Lead Acme")!;
    expect(lead.companyName).toBe("Acme Roofing");
    expect(lead.region).toBe("DFW"); // via the company
    expect(lead.dealType).toBe("Residential");
    expect(lead.daysInStage).toBeGreaterThanOrEqual(4);
    expect(lead.daysInStage).toBeLessThanOrEqual(6);
    expect(lead.value).toBeNull();
    expect(lead.winProbability).toBeNull(); // leads have no win probability
  });
});
