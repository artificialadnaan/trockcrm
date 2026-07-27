import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { companies, users } from "@trock-crm/shared/schema";
import { listCompanies } from "../../../src/modules/companies/service.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

/**
 * REAL-SQL (PGlite) proof for Lane 2 — the 4 company-directory aggregates (Properties / Contacts /
 * Active deals / Pipeline$) are now FOLDED into listCompanies via per-relation pre-aggregated LEFT JOIN
 * derived tables (p / ct / d), exposed as real output columns, and are therefore sortable over the FULL
 * filtered set BEFORE limit/offset — not just re-ordering the visible page. The old post-pagination
 * countRows raw query is gone (one round-trip).
 *
 * companies is created from the real Drizzle definition; deals/contacts/properties are minimal islands
 * carrying only the columns the folded subqueries read. Per-company pipeline = SUM over active deals of
 * forecast→awarded→…→bid_estimate, on-hold = 0 (shared resolver), so the folded column reconciles with
 * the summary-card aggregate.
 */

// Explicit fixed ids so the id-asc tiebreak is deterministic: A < B < C < D < E.
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const C = "00000000-0000-0000-0000-00000000000c";
const D = "00000000-0000-0000-0000-00000000000d";
const E = "00000000-0000-0000-0000-00000000000e";

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(tenantSchemaSql("public", [companies, users]));
  await pg.exec(`
    CREATE TABLE deals (
      id uuid PRIMARY KEY, company_id uuid, is_active boolean NOT NULL DEFAULT true,
      stage_id uuid, bid_board_stage_slug text, expected_close_date date, bid_due_date timestamptz,
      on_hold boolean NOT NULL DEFAULT false, forecast_revenue numeric, awarded_amount numeric,
      bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric
    );
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text NOT NULL);
    CREATE TABLE contacts (id uuid PRIMARY KEY, company_id uuid, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE properties (id uuid PRIMARY KEY, company_id uuid, is_active boolean NOT NULL DEFAULT true);

    INSERT INTO companies (id, name, slug, category) VALUES
      ('${A}','Co A','co-a','client'),
      ('${B}','Co B','co-b','client'),
      ('${C}','Co C','co-c','client'),
      ('${D}','Co D','co-d','client'),
      ('${E}','Co E','co-e','client');
  `);

  // properties: A=3, B=1, C=0, D=2, E=0  (+ one inactive on A that must NOT count)
  const props: Array<[string, boolean]> = [
    [A, true], [A, true], [A, true], [A, false],
    [B, true],
    [D, true], [D, true],
  ];
  await pg.exec(
    `INSERT INTO properties (id, company_id, is_active) VALUES ${props
      .map(([co, active], i) => `('${id(100 + i)}','${co}',${active})`)
      .join(",")};`,
  );

  // contacts: A=2, B=5, C=0, D=1, E=0  (+ one inactive on B that must NOT count)
  const cts: Array<[string, boolean]> = [
    [A, true], [A, true],
    [B, true], [B, true], [B, true], [B, true], [B, true], [B, false],
    [D, true],
  ];
  await pg.exec(
    `INSERT INTO contacts (id, company_id, is_active) VALUES ${cts
      .map(([co, active], i) => `('${id(200 + i)}','${co}',${active})`)
      .join(",")};`,
  );

  // deals (only bid_estimate set, rest null → resolver returns bid_estimate when > 0):
  //   A: 2 active non-held (10k, 20k) + 1 on-hold (99k) + 1 inactive (88k) → activeDeals 2, total 3, pipe 30k
  //   B: 1 active non-held (5k)                                            → activeDeals 1, total 1, pipe 5k
  //   C: none                                                             → activeDeals 0, total 0, pipe 0
  //   D: 1 active non-held (50k)                                          → activeDeals 1, total 1, pipe 50k
  //   E: 1 active ON-HOLD (77k)                                           → activeDeals 0, total 1, pipe 0
  await pg.exec(`
    INSERT INTO deals (id, company_id, is_active, on_hold, bid_estimate) VALUES
      ('${id(300)}','${A}', true,  false, 10000),
      ('${id(301)}','${A}', true,  false, 20000),
      ('${id(302)}','${A}', true,  true,  99000),
      ('${id(303)}','${A}', false, false, 88000),
      ('${id(304)}','${B}', true,  false, 5000),
      ('${id(305)}','${D}', true,  false, 50000),
      ('${id(306)}','${E}', true,  true,  77000);
  `);
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

const byId = (rows: Array<{ id: string }>) => new Map(rows.map((r) => [r.id, r]));

describe("listCompanies — folded aggregate columns", () => {
  it("exposes correct per-company properties/contacts/active-deals/pipeline + legacy total counts", async () => {
    const { companies: rows } = await listCompanies(tdb, { limit: 50 });
    const m = byId(rows);

    expect(m.get(A)).toMatchObject({
      propertiesCount: 3, // inactive property excluded
      contactsCount: 2,
      contactCount: 2, // legacy alias
      activeDealsCount: 2, // on-hold + inactive excluded
      dealCount: 3, // all active deals (held + non-held), inactive excluded
      pipelineValue: "30000",
    });
    expect(m.get(B)).toMatchObject({ propertiesCount: 1, contactsCount: 5, activeDealsCount: 1, dealCount: 1, pipelineValue: "5000" });
    // Edge: company with 0 of everything → zeros, pipeline '0' (not null), no fan-out.
    expect(m.get(C)).toMatchObject({ propertiesCount: 0, contactsCount: 0, activeDealsCount: 0, dealCount: 0, pipelineValue: "0" });
    expect(m.get(D)).toMatchObject({ propertiesCount: 2, contactsCount: 1, activeDealsCount: 1, dealCount: 1, pipelineValue: "50000" });
    // Edge: on-hold-only deal → counted in total dealCount but NOT active, pipeline zeroed.
    expect(m.get(E)).toMatchObject({ propertiesCount: 0, contactsCount: 0, activeDealsCount: 0, dealCount: 1, pipelineValue: "0" });
  });

  it("does NOT fan out: 5 companies in, exactly 5 rows out (per-relation derived tables, never one multi-join)", async () => {
    const { companies: rows, total } = await listCompanies(tdb, { limit: 50 });
    expect(rows.length).toBe(5);
    expect(total).toBe(5);
    // A has 3 properties × 2 contacts × 3 deals = 18 fan-out rows if mis-joined; must be exactly one.
    expect(rows.filter((r) => r.id === A).length).toBe(1);
  });
});

describe("listCompanies — full-set sort over the folded columns (page 1 = global top-N)", () => {
  it("pipeline_value desc, limit=2 → the two globally-largest pipelines, not the page's local order", async () => {
    const { companies: rows } = await listCompanies(tdb, { sortBy: "pipeline_value", sortDir: "desc", limit: 2 });
    expect(rows.map((r) => r.id)).toEqual([D, A]); // 50k, 30k (globally top 2; B=5k/E=0/C=0 excluded)
  });

  it("pipeline_value sorts NUMERIC not lexical, and asc puts the 0s first with the id tiebreak", async () => {
    const { companies: rows } = await listCompanies(tdb, { sortBy: "pipeline_value", sortDir: "asc", limit: 50 });
    // 0 (C), 0 (E) → tie broken by id asc (C<E); then 5k, 30k, 50k. Lexical would mis-order '5000' vs '50000'.
    expect(rows.map((r) => r.id)).toEqual([C, E, B, A, D]);
  });

  it("properties_count desc, limit=2 → A(3), D(2) — global top-N", async () => {
    const { companies: rows } = await listCompanies(tdb, { sortBy: "properties_count", sortDir: "desc", limit: 2 });
    expect(rows.map((r) => r.id)).toEqual([A, D]);
  });

  it("contacts_count desc, limit=2 → B(5), A(2) — global top-N", async () => {
    const { companies: rows } = await listCompanies(tdb, { sortBy: "contacts_count", sortDir: "desc", limit: 2 });
    expect(rows.map((r) => r.id)).toEqual([B, A]);
  });

  it("active_deals_count desc → A(2), then B(1)/D(1) tie broken by id asc, then 0s by id asc", async () => {
    const { companies: rows } = await listCompanies(tdb, { sortBy: "active_deals_count", sortDir: "desc", limit: 50 });
    expect(rows.map((r) => r.id)).toEqual([A, B, D, C, E]);
  });

  it("paginates the GLOBAL order: pipeline_value desc page 2 (limit 2) continues from the full sort", async () => {
    // Full desc order = [D(50k), A(30k), B(5k), C(0), E(0)] (0s tie-broken by id asc). Page 2 = indices 2,3.
    const { companies: rows } = await listCompanies(tdb, { sortBy: "pipeline_value", sortDir: "desc", limit: 2, page: 2 });
    expect(rows.map((r) => r.id)).toEqual([B, C]);
  });
});

describe("listCompanies — reconciliation + single round-trip", () => {
  it("sum of the folded pipeline_value over the full set === the summary-card pipelineTotal", async () => {
    const all = await listCompanies(tdb, { limit: 50 });
    const folded = all.companies.reduce((s, c) => s + Number(c.pipelineValue ?? 0), 0);
    expect(all.pipelineTotal).toBe(85000); // 30k + 5k + 50k
    expect(folded).toBe(all.pipelineTotal); // card === sum-of-list (byte-identical resolver, reconcile)
  });

  it("aggregates are FULL-SET even at limit=1 (folded into the main query, not a per-page second query)", async () => {
    const page = await listCompanies(tdb, { sortBy: "pipeline_value", sortDir: "desc", limit: 1 });
    expect(page.companies.length).toBe(1);
    expect(page.companies[0]?.id).toBe(D); // global top
    expect(page.companies[0]?.pipelineValue).toBe("50000"); // its own folded value, computed in-query
    expect(page.total).toBe(5);
    expect(page.pipelineTotal).toBe(85000); // summary still full-set
  });

  it("issues NO separate raw per-page count query (countRows removed): tenantDb.execute is never called", async () => {
    const spy = vi.spyOn(tdb, "execute");
    await listCompanies(tdb, { limit: 50 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
