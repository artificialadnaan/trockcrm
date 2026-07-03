import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildCompanyCamImportPlan,
  loadDeals,
  summarizeCompanyCamPlan,
} from "../../../scripts/companycam-inventory";

/**
 * Real-SQL guard for the inventory's on-hold awareness (reporting only — no seed / no data writes).
 *
 * loadDeals must, against a real tenant-scoped deals table: select COALESCE(on_hold, false), exclude
 * inactive deals, and carry on_hold through so the plan summary reports on-hold-excluded + the
 * auto-seed-vs-manual-review split correctly. This is the load-bearing, CI-gated half; the matching /
 * bucketing maths is also covered by the pure companycam-inventory.test.ts.
 */

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA office_dallas;
    CREATE TABLE office_dallas.deals (
      id text PRIMARY KEY, sales_source_user_id uuid,
      name text,
      deal_number text,
      project_number text,
      companycam_project_id text,
      on_hold boolean,
      is_active boolean NOT NULL DEFAULT true
    );
    INSERT INTO office_dallas.deals
      (id, name, deal_number, project_number, companycam_project_id, on_hold, is_active) VALUES
      ('deal-active',   'Active Deal',  'D-1', 'DFW-2-08926-ab', NULL,        false, true),
      ('deal-onhold',   'On Hold Deal', 'D-2', 'DFW-3-00001-zz', NULL,        true,  true),
      ('deal-nullhold', 'Null Hold',    'D-3', NULL,             'cc-linked', NULL,  true),
      ('deal-inactive', 'Inactive',     'D-4', NULL,             NULL,        false, false);
  `);
});

afterAll(async () => {
  await db?.close();
});

// loadDeals only needs a `query(sql)` executor; PGlite supplies real Postgres.
const tenantClient = () => ({ query: (sql: string) => db.query(sql) }) as any;

describe("companycam inventory — on-hold from real SQL", () => {
  it("loadDeals fetches on_hold (COALESCE null -> false) and excludes inactive deals", async () => {
    const deals = await loadDeals(tenantClient(), "office_dallas");

    expect(deals.map((d) => d.id).sort()).toEqual(["deal-active", "deal-nullhold", "deal-onhold"]); // inactive excluded
    const byId = new Map(deals.map((d) => [d.id, d]));
    expect(byId.get("deal-active")?.onHold).toBe(false);
    expect(byId.get("deal-onhold")?.onHold).toBe(true);
    expect(byId.get("deal-nullhold")?.onHold).toBe(false); // COALESCE(on_hold, false)
  });

  it("routes an on-hold-matched project to manual review, not auto-seed", async () => {
    const deals = await loadDeals(tenantClient(), "office_dallas");
    const plan = buildCompanyCamImportPlan(
      [
        { id: "cc-linked", name: "Linked Project", photoCount: 10 }, // existing link to a not-on-hold deal -> auto
        { id: "cc-num-onhold", name: "DFW-3-00001-zz Siding", photoCount: 30 }, // number-in-name to an on-hold deal -> manual
      ],
      deals,
    );
    const byProject = new Map(plan.rows.map((r) => [r.companyCamProjectId, r]));

    expect(byProject.get("cc-linked")).toMatchObject({ matchReason: "existing_companycam_link", matchedDealOnHold: false });
    expect(byProject.get("cc-num-onhold")).toMatchObject({ matchReason: "project_number_in_name", matchedDealOnHold: true });

    const summary = summarizeCompanyCamPlan(plan.rows);
    expect(summary.autoSeed).toEqual({ projects: 1, photos: 10 }); // only the linked, not-on-hold project
    expect(summary.onHoldExcluded).toEqual({ projects: 1, photos: 30 });
    expect(summary.manualReview).toEqual({ projects: 1, photos: 30 });
  });
});
