// Runs the service-classification audit against a real Postgres (PGlite).
//
// The audit's whole value is that it tells you what the REPORTS will say. That only holds if it asks the
// same question they do, so the census imports `aliasedIsServiceProjectSql` rather than restating it —
// and the tests below check the consequences of that, not just that the SQL parses.
//
// The counts that matter most here are the STAGE-FAMILY MISMATCH ones. The repair changes which pipeline a
// deal travels and whether it skips RFP voting; a census that reported only "N deals disagree" would make a
// behaviour change look like a typo fix.
import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  buildCensusSql,
  buildUpdateSql,
  canonicalServicePredicate,
  censusForSchema,
  discoverOfficeSchemas,
  formatCensus,
  parseAuditArgs,
} from "./audit-service-classification.js";

const U = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, "0")}`;
const ST = { openStd: U("1"), openSvc: U("2") };
const PT = { service: U("11"), roofing: U("12") };

let pg: PGlite;

/** A thin adapter: the script's QueryClient is node-postgres shaped, PGlite is close enough. */
const client = () => ({
  query: (text: string, values?: unknown[]) =>
    pg.query(text, values as any[]).then((r) => ({ rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length })),
});

beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA office_dallas;
    CREATE TABLE public.project_type_config (id uuid PRIMARY KEY, name text NOT NULL, code text);
    CREATE TABLE office_dallas.pipeline_stage_config (
      id uuid PRIMARY KEY, slug text NOT NULL, workflow_family text NOT NULL
    );
    CREATE TABLE office_dallas.deals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      stage_id uuid NOT NULL,
      project_number text,
      project_type text,
      project_type_id uuid,
      workflow_route text NOT NULL DEFAULT 'normal',
      -- Provenance: a route these systems chose is not a silently-defaulted one.
      is_bid_board_owned boolean NOT NULL DEFAULT false,
      synchub_bid_board_id text,
      source_lead_id uuid,
      sales_source_user_id uuid,
      is_change_order boolean NOT NULL DEFAULT false,
      parent_deal_id uuid,
      awarded_amount numeric,
      bid_board_total_sales numeric,
      bid_estimate numeric,
      dd_estimate numeric,
      is_active boolean NOT NULL DEFAULT true,
      is_test_data boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    INSERT INTO public.project_type_config (id, name, code) VALUES
      ('${PT.service}', 'Service', '4'),
      ('${PT.roofing}', 'Roofing', '3');
    INSERT INTO office_dallas.pipeline_stage_config (id, slug, workflow_family) VALUES
      ('${ST.openStd}', 'opportunity', 'standard_deal'),
      ('${ST.openSvc}', 'service_estimating', 'service_deal');

    INSERT INTO office_dallas.deals (name, stage_id, project_number, project_type, project_type_id, workflow_route, awarded_amount) VALUES
      -- MISCLASSIFIED: typed service, routed normal, sitting in a STANDARD stage. The headline population,
      -- and the one whose repair is a behaviour change.
      ('typed-service routed-normal std-stage', '${ST.openStd}', 'DFW-4-04126-AE', 'service', NULL, 'normal', 100),
      -- MISCLASSIFIED but already in the service stage family: repairing this one is route-only.
      ('typed-service routed-normal svc-stage', '${ST.openSvc}', 'DFW-4-04127-AF', 'service', NULL, 'normal', 200),
      -- MISCLASSIFIED and carrying NO project number: proves classification never needed one.
      ('typed-service no-number', '${ST.openStd}', NULL, 'service', NULL, 'normal', 300),
      -- MISCLASSIFIED via the configured code only (no project_type text) -- the HubSpot import shape.
      ('config-coded-service', '${ST.openSvc}', 'PENDING', NULL, '${PT.service}', 'normal', 400),
      -- The OPPOSITE error: routed service, but typed roofing. project_type wins, so it should be normal.
      ('typed-roofing routed-service', '${ST.openSvc}', 'DFW-3-04128-AG', 'roofing', NULL, 'service', 500),
      -- Correct already, both ways.
      ('typed-service routed-service', '${ST.openSvc}', 'DFW-4-04129-AH', 'service', NULL, 'service', 600),
      ('typed-roofing routed-normal', '${ST.openStd}', 'DFW-3-04130-AI', 'roofing', NULL, 'normal', 700),
      -- Excluded populations: a report never counts these, so the census must not either.
      ('inactive typed-service', '${ST.openStd}', NULL, 'service', NULL, 'normal', 800),
      ('test-data typed-service', '${ST.openStd}', NULL, 'service', NULL, 'normal', 900);
    UPDATE office_dallas.deals SET is_active = false WHERE name = 'inactive typed-service';
    UPDATE office_dallas.deals SET is_test_data = true WHERE name = 'test-data typed-service';

    -- PROVENANCE ROWS. Each is misclassified in exactly the same way as the rows above, so the ONLY thing
    -- keeping them out of the repair is who chose their route. If the exclusions regress, these flip.
    INSERT INTO office_dallas.deals (name, stage_id, project_type, workflow_route, awarded_amount, is_bid_board_owned) VALUES
      ('bid-board-owned typed-service', '${ST.openStd}', 'service', 'normal', 1000, true);
    INSERT INTO office_dallas.deals (name, stage_id, project_type, workflow_route, awarded_amount, synchub_bid_board_id) VALUES
      ('synchub-linked typed-service', '${ST.openStd}', 'service', 'normal', 2000, 'SH-123');
    INSERT INTO office_dallas.deals (name, stage_id, project_type, workflow_route, awarded_amount, source_lead_id) VALUES
      ('converted-lead typed-service', '${ST.openStd}', 'service', 'normal', 3000, '${U("99")}');
    -- A demotion candidate carrying a sales source: service route, roofing type, sales-source attribution.
    INSERT INTO office_dallas.deals (name, stage_id, project_type, workflow_route, awarded_amount, sales_source_user_id) VALUES
      ('sales-sourced typed-roofing routed-service', '${ST.openSvc}', 'roofing', 'service', 4000, '${U("98")}');

    -- A demotion candidate whose stage ALREADY belongs to the target (standard) family, so the repair can
    -- safely move it. Without this row the to-normal direction would be vacuous once the stage-family
    -- guard landed, and a guard that blocks everything looks identical to a guard that works.
    INSERT INTO office_dallas.deals (name, stage_id, project_type, workflow_route, awarded_amount) VALUES
      ('typed-roofing routed-service std-stage', '${ST.openStd}', 'roofing', 'service', 250);

    -- A CHANGE-ORDER CHILD of the Bid Board-owned parent. It copies the parent's project type and route
    -- but NOT its provenance columns, so on its own row it looks like an ordinary silently-defaulted deal.
    -- Its route is inherited by invariant, so flipping it while its parent is skipped would diverge them.
    INSERT INTO office_dallas.deals (name, stage_id, project_type, workflow_route, awarded_amount, is_change_order, parent_deal_id)
    SELECT 'CO child of bid-board parent', '${ST.openStd}', 'service', 'normal', 500, true, p.id
      FROM office_dallas.deals p WHERE p.name = 'bid-board-owned typed-service';
  `);
});

describe("parseAuditArgs", () => {
  it("defaults to a DRY RUN in the to-service direction", () => {
    // Dry-run by default because the alternative is a script that rewrites production on a typo.
    // to-service by default because it is the direction that fixes the reported symptom; to-normal
    // demotes deals somebody may have routed deliberately, so it must be asked for.
    expect(parseAuditArgs(["node", "s"])).toEqual({ execute: false, direction: "to-service" });
  });

  it("accepts the three directions and --execute", () => {
    expect(parseAuditArgs(["node", "s", "--execute", "--direction=both"]))
      .toEqual({ execute: true, direction: "both" });
    expect(parseAuditArgs(["node", "s", "--direction=to-normal"]).direction).toBe("to-normal");
  });

  it("rejects an unknown direction instead of silently falling back", () => {
    // A typo'd --direction that quietly became the default would run the wrong repair under --execute.
    expect(() => parseAuditArgs(["node", "s", "--direction=to-srevice"])).toThrow(/--direction must be one of/);
  });
});

describe("the audit asks the same question the reports do", () => {
  it("uses the imported canonical predicate in BOTH the census and the repair", () => {
    const predicate = canonicalServicePredicate("d").text;
    expect(buildCensusSql().text).toContain(predicate);
    expect(buildUpdateSql("to-service").text).toContain(predicate);
    expect(buildUpdateSql("to-normal").text).toContain(predicate);
    // Not vacuous: the predicate is the real multi-tier resolution, not a stub.
    expect(predicate).toContain("project_type");
    expect(predicate).toContain("project_type_config");
    expect(predicate).toContain("workflow_route");
  });

  it("scopes the repair to exactly the population the census counted", () => {
    // The classic version of this bug is an UPDATE whose WHERE is looser than the census that justified it.
    for (const direction of ["to-service", "to-normal"] as const) {
      const update = buildUpdateSql(direction).text;
      expect(update).toContain("d.is_active = true");
      expect(update).toContain("COALESCE(d.is_test_data, false) = false");
    }
  });
});

describe("census", () => {
  it("finds the office schemas", async () => {
    expect(await discoverOfficeSchemas(client())).toEqual(["office_dallas"]);
  });

  it("counts the disagreement in both directions, and never counts inactive or test deals", async () => {
    const census = await censusForSchema(client(), "office_dallas");

    // 13 seeded, minus the inactive and the test-data row.
    expect(census.activeDeals).toBe(13);
    // Canonically service: the 4 plainly misclassified, the 3 provenance-protected ones (which are
    // misclassified in exactly the same way), and the already-correct one.
    expect(census.canonicalService).toBe(9);
    // By the raw column today: the already-correct one, plus the two wrongly-routed roofing deals.
    expect(census.routeService).toBe(4);

    // The census COUNTS every disagreement, including rows the repair will refuse to touch. Counting only
    // the repairable ones would understate the problem and make the exclusions invisible.
    expect(census.toServiceCount).toBe(8);
    expect(census.toServiceValue).toBe(100 + 200 + 300 + 400 + 1000 + 2000 + 3000 + 500);
    expect(census.toNormalCount).toBe(3);
    expect(census.toNormalValue).toBe(500 + 4000 + 250);
  });

  it("separates the rows whose repair is a BEHAVIOUR change from the rows where it is not", async () => {
    const census = await censusForSchema(client(), "office_dallas");
    // Six of the eight to-service rows sit in a standard_deal stage; flipping their route puts them in a
    // family their stage does not belong to. That is the number a human has to accept before --execute.
    expect(census.toServiceStageMismatch).toBe(6);
    // Both to-normal rows sit in a service_deal stage, so they have the same problem in reverse.
    expect(census.toNormalStageMismatch).toBe(2);
    // Strictly fewer than the totals -- otherwise this column would be telling us nothing.
    expect(census.toServiceStageMismatch).toBeLessThan(census.toServiceCount);
  });

  it("reports how many misclassified deals have no project number", async () => {
    const census = await censusForSchema(client(), "office_dallas");
    // Five NULLs. 'PENDING' is a real stored value, not an absent number, so it is deliberately NOT
    // counted here -- the point of the figure is that classification worked without generating any
    // number at all.
    expect(census.toServiceMissingProjectNumber).toBe(5);
  });

  it("renders a census a human can act on", async () => {
    const lines = formatCensus(await censusForSchema(client(), "office_dallas")).join("\n");
    expect(lines).toContain("office_dallas");
    expect(lines).toContain("behaviour change");
    expect(lines).toContain("$7,500"); // the to-service value, formatted
  });
});

describe("repair", () => {
  async function routesByName(): Promise<Record<string, string>> {
    const { rows } = await pg.query<{ name: string; workflow_route: string }>(
      `SELECT name, workflow_route FROM office_dallas.deals ORDER BY name`
    );
    return Object.fromEntries(rows.map((r) => [r.name, r.workflow_route]));
  }

  beforeEach(async () => {
    await pg.exec(`SET search_path TO office_dallas, public`);
  });

  it("never overwrites a route an upstream system chose", async () => {
    const { text, params } = buildUpdateSql("to-service");
    await pg.query(text, params as any[]);
    const routes = await routesByName();

    // All three are typed service on a normal route — identical to the rows the repair DOES flip. Only
    // provenance separates them. A repair that ignored it would fight the Bid Board / SyncHub sync, or
    // re-route a converted lead away from the workflow its lead chose.
    expect(routes["bid-board-owned typed-service"]).toBe("normal");
    expect(routes["synchub-linked typed-service"]).toBe("normal");
    expect(routes["converted-lead typed-service"]).toBe("normal");

    // ...and the change-order CHILD of a protected parent, whose own row carries no provenance at all.
    // A guard that only looked at the row being updated would flip this one and diverge it from a parent
    // it is required to match.
    expect(routes["CO child of bid-board parent"]).toBe("normal");
  });

  it("never demotes a deal carrying a sales source", async () => {
    const { text, params } = buildUpdateSql("to-normal");
    await pg.query(text, params as any[]);
    const routes = await routesByName();

    // Demotion out of the service workflow must run clearSalesSource (updateDeal and the resolved-fields
    // route both do). A raw UPDATE would leave the attribution live with no valid commission basis, so
    // the row is left for a human to move through the ORM path.
    expect(routes["sales-sourced typed-roofing routed-service"]).toBe("service");
    // ...while the demotion candidate WITHOUT a sales source, in a compatible stage, still moves — so
    // this test is measuring the sales-source guard rather than the stage guard blocking everything.
    expect(routes["typed-roofing routed-service std-stage"]).toBe("normal");
  });

  it("reports both exclusions rather than silently dropping them", async () => {
    const census = await censusForSchema(client(), "office_dallas");
    // Silent truncation is what makes an audit lie: a repair that skipped rows without saying so reads as
    // "everything is handled" when it is not.
    expect(census.authoritativeRouteSkipped).toBe(4);
    expect(census.toNormalSalesSourceSkipped).toBe(1);
    const rendered = formatCensus(census).join("\n");
    expect(rendered).toContain("SKIPPED, upstream owns the route");
    expect(rendered).toContain("SKIPPED, carries a sales source");
  });

  it("to-service flips exactly the misclassified rows and nothing else", async () => {
    const { text, params } = buildUpdateSql("to-service");
    await pg.query(text, params as any[]);
    const routes = await routesByName();

    // Only the rows whose stage ALREADY belongs to the service family move. The other two are correctly
    // misclassified but sit in standard_deal stages, so flipping the route alone would leave a pair the
    // pipeline cannot resolve — they are deferred, not silently rewritten.
    expect(routes["typed-service routed-normal svc-stage"]).toBe("service");
    expect(routes["config-coded-service"]).toBe("service");
    expect(routes["typed-service routed-normal std-stage"]).toBe("normal");
    expect(routes["typed-service no-number"]).toBe("normal");
    // Untouched: correct already, or the other direction's problem.
    expect(routes["typed-roofing routed-normal"]).toBe("normal");
    expect(routes["typed-roofing routed-service"]).toBe("service");
    // Untouched: excluded populations stay excluded even under --execute.
    expect(routes["inactive typed-service"]).toBe("normal");
    expect(routes["test-data typed-service"]).toBe("normal");
  });

  it("to-normal demotes only the wrongly-routed row", async () => {
    const { text, params } = buildUpdateSql("to-normal");
    await pg.query(text, params as any[]);
    const routes = await routesByName();
    // The stage-compatible one moves...
    expect(routes["typed-roofing routed-service std-stage"]).toBe("normal");
    // ...the one sitting in a service_deal stage does not, for the same reason as above.
    expect(routes["typed-roofing routed-service"]).toBe("service");
    expect(routes["typed-service routed-service"]).toBe("service");
  });

  it("is idempotent — a second run changes nothing", async () => {
    const { text, params } = buildUpdateSql("to-service");
    await pg.query(text, params as any[]);
    const after = await routesByName();
    const second = await pg.query(text, params as any[]);
    expect(second.affectedRows ?? 0).toBe(0);
    expect(await routesByName()).toEqual(after);
  });

  it("leaves behind EXACTLY the rows it deliberately refused, and says so", async () => {
    const before = await censusForSchema(client(), "office_dallas");
    const { text, params } = buildUpdateSql("to-service");
    await pg.query(text, params as any[]);
    const after = await censusForSchema(client(), "office_dallas");

    // The residual is not "some rows failed" — it is exactly the two sets the census reported up front:
    // rows an upstream system owns, and rows whose stage belongs to the other workflow family. Anything
    // else would mean the repair and the census disagree about their own scope, which is the failure an
    // audit exists to prevent.
    // NOT the sum of the two counts: a row can be BOTH upstream-owned and stage-mismatched (the Bid
    // Board rows here are), so adding them would double-count. What must hold is that every remaining row
    // is covered by at least one reported reason, and that the count is stable.
    expect(after.toServiceCount).toBe(6);
    expect(after.toServiceCount).toBeLessThanOrEqual(
      before.authoritativeRouteSkipped + before.toServiceStageMismatch
    );
    // Not vacuous: the repair genuinely moved the rows it could move safely.
    expect(before.toServiceCount).toBe(8);
    // ...and both reasons are still reported, so a second reader sees why it stopped.
    expect(after.authoritativeRouteSkipped).toBe(4);
    // Every remaining row is stage-mismatched, which is exactly why the repair refused them.
    expect(after.toServiceStageMismatch).toBe(6);
  });
});
