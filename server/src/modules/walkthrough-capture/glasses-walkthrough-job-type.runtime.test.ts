// REAL-SQL (PGlite) proof for `resolveGlassesWalkthroughJobTypeForDeal` — the one part of the job-type
// decision that is not a pure function.
//
// The mapping itself is covered exhaustively as a table in ./glasses-walkthrough-job-type.test.ts. What
// can only be checked here is the READ that feeds it, and it has one property no unit test can see: the
// configured project-type code arrives through a scalar subquery against `public.project_type_config`,
// a table in a DIFFERENT SCHEMA from the tenant `deals` row that points at it. That is the tier that
// decides for roughly half of active deals (646 of 1,351 carry no `project_type` TEXT at all), so a
// subquery that silently returned NULL — a typo'd column, a table that is not reachable from this
// connection — would not fail: every walk would quietly fall through to the residential default, and the
// symptom would be the exact 86%-uncatalogued outcome this change exists to fix.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deals, projectTypeConfig } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../../tests/helpers/tenant-schema-from-drizzle.js";
import { resolveGlassesWalkthroughJobTypeForDeal } from "./glasses-walkthrough-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("11111");
const STAGE = U("55555");
const TYPE_ROOFING = U("30000");
const TYPE_SERVICE = U("40000");

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tenantDb: any;

beforeAll(async () => {
  pg = new PGlite();
  // Both tables in `public`, which is what makes the cross-schema subquery in the function under test
  // resolvable here: it names `public.project_type_config` explicitly, exactly as it does in production
  // where `deals` lives in an `office_*` schema and the config table does not.
  await pg.exec(tenantSchemaSql("public", [deals, projectTypeConfig]));
  tenantDb = drizzle(pg);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec("DELETE FROM deals");
  await pg.exec("DELETE FROM project_type_config");
  await tenantDb.insert(projectTypeConfig).values([
    { id: TYPE_ROOFING, name: "Roofing", slug: "roofing", code: "3", displayOrder: 3 },
    { id: TYPE_SERVICE, name: "Service", slug: "service", code: "4", displayOrder: 4 },
  ]);
});

/** A deal with only the columns the resolver reads stated; everything else takes its schema default. */
async function insertDeal(overrides: Record<string, unknown> = {}) {
  await tenantDb.insert(deals).values({
    id: DEAL,
    dealNumber: "DFW-3-001",
    name: "North wing re-roof",
    stageId: STAGE,
    ...overrides,
  });
}

describe("resolveGlassesWalkthroughJobTypeForDeal", () => {
  it("reads the configured project-type code through the FK and maps it", async () => {
    // The shape most deals actually have: no `project_type` TEXT, typed only by `project_type_id`.
    await insertDeal({ projectTypeId: TYPE_ROOFING });

    expect(await resolveGlassesWalkthroughJobTypeForDeal(tenantDb, DEAL, null)).toBe("roofing_envelope");
  });

  it("prefers the project-type TEXT over the FK, as the platform's own resolver does", async () => {
    await insertDeal({ projectType: "service", projectTypeId: TYPE_ROOFING });

    expect(await resolveGlassesWalkthroughJobTypeForDeal(tenantDb, DEAL, null)).toBe("service_repair");
  });

  it("falls back to the workflow route when the deal is typed by nothing else", async () => {
    await insertDeal({ workflowRoute: "service" });

    expect(await resolveGlassesWalkthroughJobTypeForDeal(tenantDb, DEAL, null)).toBe("service_repair");
  });

  it("answers the default for an untyped deal", async () => {
    // `workflow_route` defaults to 'normal', which has never meant "not service" — it means nobody said.
    await insertDeal();

    expect(await resolveGlassesWalkthroughJobTypeForDeal(tenantDb, DEAL, null)).toBe("interior_finish_out");
  });

  it("lets a job type the CLIENT stated win, without reading the deal at all", async () => {
    // The column is an override, not a cache of the deal. A capture app that grows a picker must be able
    // to correct a mis-typed deal from the field, where the person can actually see the building.
    await insertDeal({ projectTypeId: TYPE_ROOFING });

    expect(await resolveGlassesWalkthroughJobTypeForDeal(tenantDb, DEAL, "commercial_ti")).toBe(
      "commercial_ti"
    );
  });

  it("ignores a stated value outside the vocabulary rather than trusting it", async () => {
    // Belt and braces: the ingest validator already 400s such a value, so reaching here means a caller
    // bypassed it. Falling through to the deal is the safe reading — forwarding an unknown string would
    // be a 422 from TROCK Scope and a walk that never lands.
    await insertDeal({ projectTypeId: TYPE_ROOFING });

    expect(await resolveGlassesWalkthroughJobTypeForDeal(tenantDb, DEAL, "exterior")).toBe(
      "roofing_envelope"
    );
  });

  it("answers the default for a deal that is not there, rather than throwing", async () => {
    // Unreachable from the route — `assertGlassesWalkthroughDealAccess` has already 404'd — but a walk's
    // delivery must not hang on a read that is only ever an optimisation of a value TROCK Scope would
    // have defaulted anyway.
    expect(await resolveGlassesWalkthroughJobTypeForDeal(tenantDb, U("99999"), null)).toBe(
      "interior_finish_out"
    );
  });
});
