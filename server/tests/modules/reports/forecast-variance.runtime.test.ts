import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { deals, dealForecastMilestones, dealScopingIntake } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { getForecastVarianceOverview } from "../../../src/modules/reports/service.js";

/**
 * RUNTIME (PGlite) cover for the forecast-variance reader.
 *
 * Its sibling `forecast-variance-change-order.test.ts` mocks `execute`: it proves the SELECT and the
 * mapper agree, and it cannot prove the SQL is legal. That distinction is not academic here — this exact
 * reader shipped with the outer SELECT naming `deal_is_change_order` while the CTE it reads from never
 * projected it, which Postgres rejects outright, and the mocked test was perfectly happy.
 *
 * The two hazards a mock is blind to are CTE/alias scope (this one) and GROUP BY completeness. Both go
 * live the moment a column is added to a query, so anything with a CTE or an aggregate needs to actually
 * run.
 */
const DEAL = "22222222-2222-2222-2222-222222222221";
const DEAL_CO = "22222222-2222-2222-2222-222222222222";
const REP = "33333333-3333-3333-3333-333333333331";
const STAGE = "44444444-4444-4444-4444-444444444441";

let tdb: any;

beforeAll(async () => {
  const pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, slug text, name text, is_terminal boolean NOT NULL DEFAULT false);
  `);
  // Real column sets from the drizzle schema — the value chain in this query touches many deal columns,
  // and a hand-written subset would only prove the subset.
  await pg.exec(tenantSchemaSql("public", [deals, dealForecastMilestones, dealScopingIntake]));
  await pg.exec(`
    SET search_path TO public;
    INSERT INTO public.users (id, display_name) VALUES ('${REP}','Alice');
    INSERT INTO public.pipeline_stage_config (id, slug, name, is_terminal) VALUES ('${STAGE}','closed_won','Won', true);
    INSERT INTO deals (id, deal_number, name, is_change_order, stage_id, awarded_amount, is_test_data)
      VALUES ('${DEAL}','D-1','Tides Park Lane', false, '${STAGE}', 120000, false),
             ('${DEAL_CO}','D-2','Tides Park Lane — Change Order 2', true, '${STAGE}', 30000, false);
    INSERT INTO deal_forecast_milestones (id, deal_id, milestone_key, forecast_amount, workflow_route, assigned_rep_id, captured_at, expected_close_date)
      VALUES (gen_random_uuid(), '${DEAL}', 'initial', 100000, 'normal', '${REP}', now(), CURRENT_DATE),
             (gen_random_uuid(), '${DEAL}', 'closed_won', 100000, 'normal', '${REP}', now(), CURRENT_DATE),
             (gen_random_uuid(), '${DEAL_CO}', 'initial', 25000, 'normal', '${REP}', now(), CURRENT_DATE),
             (gen_random_uuid(), '${DEAL_CO}', 'closed_won', 25000, 'normal', '${REP}', now(), CURRENT_DATE);
  `);
  tdb = drizzle(pg);
});

describe("getForecastVarianceOverview against real Postgres", () => {
  it("executes — the outer SELECT only names columns its CTE actually projects", async () => {
    // Removing `d.is_change_order` from the CTE (while the outer SELECT still lists
    // `deal_is_change_order`) makes Postgres reject this outright. The mocked sibling cannot see that.
    const result = await getForecastVarianceOverview(tdb, {});
    expect(Array.isArray(result.deals)).toBe(true);
  });

  it("returns the real flag per deal rather than inferring it from the name", async () => {
    const result = await getForecastVarianceOverview(tdb, {});
    // Asserted, not guarded. An `if (result.deals.length === 0) return` here would let a reader that
    // stopped returning rows at all pass silently, and the fixture above genuinely qualifies — both
    // milestones and a won stage — so an empty result is a regression, not a shape the test tolerates.
    expect(result.deals.length).toBeGreaterThan(0);
    const co = result.deals.find((d) => d.dealId === DEAL_CO);
    const plain = result.deals.find((d) => d.dealId === DEAL);
    expect(co?.dealIsChangeOrder).toBe(true);
    expect(plain?.dealIsChangeOrder).toBe(false);
  });
});
