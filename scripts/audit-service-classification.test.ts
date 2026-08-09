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

    expect(census.activeDeals).toBe(7); // 9 seeded, minus the inactive and the test-data row
    // Canonically service: the 4 misclassified + the already-correct one.
    expect(census.canonicalService).toBe(5);
    // By the raw column today: the already-correct one + the wrongly-routed roofing deal.
    expect(census.routeService).toBe(2);

    expect(census.toServiceCount).toBe(4);
    expect(census.toServiceValue).toBe(100 + 200 + 300 + 400);
    expect(census.toNormalCount).toBe(1);
    expect(census.toNormalValue).toBe(500);
  });

  it("separates the rows whose repair is a BEHAVIOUR change from the rows where it is not", async () => {
    const census = await censusForSchema(client(), "office_dallas");
    // Two of the four to-service rows sit in a standard_deal stage; flipping their route puts them in a
    // family their stage does not belong to. That is the number a human has to accept before --execute.
    expect(census.toServiceStageMismatch).toBe(2);
    // The one to-normal row sits in a service_deal stage, so it has the same problem in reverse.
    expect(census.toNormalStageMismatch).toBe(1);
    // Strictly fewer than the totals -- otherwise this column would be telling us nothing.
    expect(census.toServiceStageMismatch).toBeLessThan(census.toServiceCount);
  });

  it("reports how many misclassified deals have no project number", async () => {
    const census = await censusForSchema(client(), "office_dallas");
    // One NULL. 'PENDING' is a real stored value, not an absent number, so it is deliberately NOT counted
    // here -- the point of the figure is that classification worked without generating any number at all.
    expect(census.toServiceMissingProjectNumber).toBe(1);
  });

  it("renders a census a human can act on", async () => {
    const lines = formatCensus(await censusForSchema(client(), "office_dallas")).join("\n");
    expect(lines).toContain("office_dallas");
    expect(lines).toContain("behaviour change");
    expect(lines).toContain("$1,000"); // the to-service value, formatted
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

  it("to-service flips exactly the misclassified rows and nothing else", async () => {
    const { text, params } = buildUpdateSql("to-service");
    await pg.query(text, params as any[]);
    const routes = await routesByName();

    expect(routes["typed-service routed-normal std-stage"]).toBe("service");
    expect(routes["typed-service routed-normal svc-stage"]).toBe("service");
    expect(routes["typed-service no-number"]).toBe("service");
    expect(routes["config-coded-service"]).toBe("service");
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
    expect(routes["typed-roofing routed-service"]).toBe("normal");
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

  it("leaves the census with nothing left to do in that direction", async () => {
    const { text, params } = buildUpdateSql("to-service");
    await pg.query(text, params as any[]);
    const census = await censusForSchema(client(), "office_dallas");
    expect(census.toServiceCount).toBe(0);
    // ...and the raw column now agrees with the canonical definition for the service population.
    expect(census.routeService).toBe(census.canonicalService + census.toNormalCount);
  });
});
