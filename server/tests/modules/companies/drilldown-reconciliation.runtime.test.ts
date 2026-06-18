import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { companies, users } from "@trock-crm/shared/schema";
import { listCompanies } from "../../../src/modules/companies/service.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

/**
 * REAL-SQL (PGlite) reconciliation proof for the Companies drillable summary cards.
 *
 * "Active pipeline" ($ sum) and "Untouched 30d+" (count) used to be computed client-side over the visible
 * 50-row page. They now read SERVER aggregates (pagination.pipelineTotal / staleCount) over the FULL
 * filtered set, and the ?card= drills (hasActivePipeline / stale) reuse the SAME per-company predicates,
 * so each card reconciles with the list it drills to. These tests prove that on real SQL and prove the
 * aggregates survive a limit=1 page (the page-only bug being fixed).
 *
 * companies is created from the real Drizzle definition (listCompanies selects all of its columns);
 * deals/contacts/properties are minimal islands carrying only the columns the service's raw subqueries
 * read. Per-company pipeline = SUM over active deals of forecast→awarded→…→bid_estimate, on-hold = 0.
 */
const U = (s: string) => {
  const hex = [...s].map((c) => (/[0-9a-f]/i.test(c) ? c : (c.charCodeAt(0) % 16).toString(16))).join("");
  return `00000000-0000-0000-0000-${hex.padStart(12, "0").slice(-12)}`;
};

const CO = {
  pipelineFresh: U("co1"), // pipeline 50k, touched 5d → not stale
  pipelineStale: U("co2"), // pipeline 30k, never active → stale
  emptyStale: U("co3"), // no deals → pipeline 0, 60d → stale
  onHoldFresh: U("co4"), // only an on-hold deal → pipeline 0, 3d → not stale
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(tenantSchemaSql("public", [companies, users]));
  // Minimal islands for the service's raw count/pipeline subqueries.
  await pg.exec(`
    CREATE TABLE deals (
      id uuid PRIMARY KEY, company_id uuid, is_active boolean NOT NULL DEFAULT true,
      on_hold boolean NOT NULL DEFAULT false, forecast_revenue numeric, awarded_amount numeric,
      bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric
    );
    CREATE TABLE contacts (id uuid PRIMARY KEY, company_id uuid, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE properties (id uuid PRIMARY KEY, company_id uuid, is_active boolean NOT NULL DEFAULT true);

    INSERT INTO companies (id, name, slug, category, last_activity_at) VALUES
      ('${CO.pipelineFresh}','Co One','co-one','client', NOW() - interval '5 days'),
      ('${CO.pipelineStale}','Co Two','co-two','client', NULL),
      ('${CO.emptyStale}','Co Three','co-three','client', NOW() - interval '60 days'),
      ('${CO.onHoldFresh}','Co Four','co-four','client', NOW() - interval '3 days');

    INSERT INTO deals (id, company_id, is_active, on_hold, bid_estimate) VALUES
      ('${U("dd1")}','${CO.pipelineFresh}', true, false, 50000),
      ('${U("dd2")}','${CO.pipelineStale}', true, false, 30000),
      ('${U("dd4")}','${CO.onHoldFresh}', true, true, 99000);
  `);
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const isStaleRow = (lastActivityAt: string | null | undefined) =>
  lastActivityAt == null || Date.now() - new Date(lastActivityAt).getTime() > THIRTY_DAYS;

describe("companies drilldown — card === drilled-list (reconcile by construction)", () => {
  it("Active-pipeline $ and Untouched count reconcile with the lists they drill to", async () => {
    const all = await listCompanies(tdb, {});
    expect(all.total).toBe(4);
    expect(all.pipelineTotal).toBe(80000); // 50k + 30k (+0 on-hold +0 no-deal)
    expect(all.staleCount).toBe(2); // co2 (null) + co3 (60d)

    const pipelineDrill = await listCompanies(tdb, { hasActivePipeline: true });
    expect(pipelineDrill.total).toBe(2); // co1, co2 (co4's only deal is on-hold → 0)
    const drilledPipelineSum = pipelineDrill.companies.reduce((sum, c) => sum + Number(c.pipelineValue ?? 0), 0);
    expect(drilledPipelineSum).toBe(all.pipelineTotal); // the $ on the card === sum over the drilled list
    expect(pipelineDrill.companies.every((c) => Number(c.pipelineValue ?? 0) > 0)).toBe(true);

    const staleDrill = await listCompanies(tdb, { stale: true });
    expect(staleDrill.total).toBe(all.staleCount);
    expect(staleDrill.companies.every((c) => isStaleRow(c.lastActivityAt))).toBe(true);
  });

  it("aggregates are FULL-SET, not page-only (the bug): they hold even when limit=1 returns one row", async () => {
    const page = await listCompanies(tdb, { limit: 1 });
    expect(page.companies.length).toBe(1);
    expect(page.total).toBe(4);
    expect(page.pipelineTotal).toBe(80000); // NOT just the one visible company's pipeline
    expect(page.staleCount).toBe(2);
  });
});
