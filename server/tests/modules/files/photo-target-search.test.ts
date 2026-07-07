import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * Tests for the photo-capture target picker search.
 *
 * The picker (searchPhotoUploadTargets) must let ANYONE find ANY lead/deal to
 * attach photos. Covered here:
 *  1. Widened search columns — property address/city/state, contact name, source
 *     (leads via the joined property; deals also via the denormalized deal-row
 *     propertyAddress/City/State, since direct deals may have no property record).
 *  2. Relevance ordering — a strong match on ANY searched column (incl. address)
 *     must outrank a merely more-recently-updated weak match, before truncation.
 * See .audit/trockcam-leads-photos.md.
 */

// The service imports the R2 client at module load; mock it like service.test.ts.
vi.mock("../../../src/lib/r2-client.js", () => ({
  generateUploadUrl: vi.fn().mockResolvedValue("https://mock-upload-url.com"),
  generateDownloadUrl: vi.fn().mockResolvedValue("https://mock-download-url.com"),
  generateMockUploadUrl: vi.fn(() => "https://mock-upload-url.com"),
  generateMockDownloadUrl: vi.fn(() => "https://mock-download-url.com"),
  headObject: vi.fn().mockResolvedValue({ contentLength: 1024 }),
  isR2Configured: vi.fn(() => true),
}));

import {
  buildPhotoTargetLeadSearchCondition,
  buildPhotoTargetDealSearchCondition,
  sortPhotoTargetsByRelevance,
  searchPhotoUploadTargets,
} from "../../../src/modules/files/service.js";

const dialect = new PgDialect();
const renderSql = (condition: SQL) => dialect.sqlToQuery(condition).sql.toLowerCase();

/**
 * Build a chainable mock tenantDb that records the SQL handed to .orderBy() for
 * each query and resolves the awaited chain to an empty result set.
 */
function makeOrderByCapturingDb() {
  const orderByCalls: string[][] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "from", "leftJoin", "where", "limit"]) {
    builder[method] = () => builder;
  }
  builder.orderBy = (...args: SQL[]) => {
    orderByCalls.push(args.map((arg) => dialect.sqlToQuery(arg).sql.toLowerCase()));
    return builder;
  };
  builder.then = (resolve: (rows: unknown[]) => unknown) => resolve([]);
  return { db: builder, orderByCalls };
}

describe("buildPhotoTargetLeadSearchCondition", () => {
  const sqlText = () => renderSql(buildPhotoTargetLeadSearchCondition("oak street"));

  it("matches the lead name and company name", () => {
    const text = sqlText();
    expect(text).toContain('"name"');
    expect(text).toContain('"companies"."name"');
  });

  it("matches the property site address, city and state (the 'couldn't find by site address' cause)", () => {
    const text = sqlText();
    expect(text).toContain('"properties"."address"');
    expect(text).toContain('"properties"."city"');
    expect(text).toContain('"properties"."state"');
  });

  it("matches the on-site contact name", () => {
    const text = sqlText();
    expect(text).toContain('"contacts"."first_name"');
    expect(text).toContain('"contacts"."last_name"');
  });

  it("matches the lead source", () => {
    expect(sqlText()).toContain('"leads"."source"');
  });
});

describe("buildPhotoTargetDealSearchCondition", () => {
  const sqlText = () => renderSql(buildPhotoTargetDealSearchCondition("oak street"));

  it("matches deal name and deal number", () => {
    const text = sqlText();
    expect(text).toContain('"deals"."name"');
    expect(text).toContain('"deals"."deal_number"');
  });

  it("matches the joined property address and contact name and source", () => {
    const text = sqlText();
    expect(text).toContain('"properties"."address"');
    expect(text).toContain('"contacts"."first_name"');
    expect(text).toContain('"deals"."source"');
  });

  it("also matches the denormalized deal-row address (direct deals with no property record)", () => {
    const text = sqlText();
    expect(text).toContain('"deals"."property_address"');
    expect(text).toContain('"deals"."property_city"');
    expect(text).toContain('"deals"."property_state"');
  });
});

describe("sortPhotoTargetsByRelevance", () => {
  const item = (relevance: number, iso: string, id: string) => ({
    id,
    relevance,
    lastUpdatedAt: new Date(iso),
  });

  it("ranks a higher-relevance match ahead of a more-recently-updated lower-relevance one", () => {
    const strongButOld = item(3, "2020-01-01T00:00:00Z", "strong");
    const weakButRecent = item(1, "2025-01-01T00:00:00Z", "weak");

    const sorted = sortPhotoTargetsByRelevance([weakButRecent, strongButOld]);

    expect(sorted.map((t) => t.id)).toEqual(["strong", "weak"]);
  });

  it("falls back to most-recently-updated within the same relevance band", () => {
    const older = item(1, "2020-01-01T00:00:00Z", "older");
    const newer = item(1, "2025-01-01T00:00:00Z", "newer");

    const sorted = sortPhotoTargetsByRelevance([older, newer]);

    expect(sorted.map((t) => t.id)).toEqual(["newer", "older"]);
  });
});

describe("searchPhotoUploadTargets ORDER BY", () => {
  it("orders an empty (browse-all) search by recency only — never by a bare 0 ordinal", async () => {
    const { db, orderByCalls } = makeOrderByCapturingDb();

    await searchPhotoUploadTargets(db as never, { search: "" });

    expect(orderByCalls.length).toBeGreaterThan(0);
    for (const call of orderByCalls) {
      const text = call.join(" | ");
      // Postgres reads `ORDER BY 0 DESC` as an out-of-range column ordinal and
      // errors — the relevance term must be omitted entirely when there's no search.
      expect(text).not.toContain("0 desc");
      expect(text).toContain("updated_at");
    }
  });

  it("ranks by relevance that includes the widened columns (e.g. address), then recency", async () => {
    const { db, orderByCalls } = makeOrderByCapturingDb();

    await searchPhotoUploadTargets(db as never, { search: "oak" });

    expect(orderByCalls.length).toBeGreaterThan(0);
    for (const call of orderByCalls) {
      const text = call.join(" | ");
      expect(text).toContain("greatest");
      expect(text).toContain("case");
      // The relevance expression embeds the full search predicate, so a match on
      // a secondary column (address) contributes to the rank — not just name.
      expect(text).toContain("address");
      expect(text).toContain("updated_at");
    }
  });

  it("gives the site address its own exact/prefix rank tier (not just the flat any-match)", async () => {
    const { db, orderByCalls } = makeOrderByCapturingDb();

    await searchPhotoUploadTargets(db as never, { search: "oak" });

    const leadOrder = orderByCalls.map((c) => c.join(" ")).find((t) => t.includes('"leads"."updated_at"'));
    expect(leadOrder).toBeDefined();
    // A prefix match on the site address must outrank a mere substring mention in
    // source/description, so properties.address needs a dedicated exact-rank
    // ("then 3") CASE — not only the flat "any column matched" tier (which would
    // collapse address, city, source, etc. all to 1). [^)] keeps it in one CASE.
    expect(leadOrder!).toMatch(/"properties"\."address" ilike \$\d+[^)]*?then 3/);
  });

  it("ranks a full contact-name (CONCAT) match by exact/prefix tier, for leads and deals", async () => {
    const { db, orderByCalls } = makeOrderByCapturingDb();

    await searchPhotoUploadTargets(db as never, { search: "jane smith" });

    const joined = orderByCalls.map((c) => c.join(" "));
    const leadOrder = joined.find((t) => t.includes('"leads"."updated_at"'));
    const dealOrder = joined.find((t) => t.includes('"deals"."updated_at"'));
    expect(leadOrder).toBeDefined();
    expect(dealOrder).toBeDefined();
    // "jane smith" is a prefix of neither first_name nor last_name alone, so the
    // concatenated full name needs its own exact-rank CASE — otherwise an exact
    // full-name hit collapses to the flat any-match tier (1) and can be truncated.
    // (The concat closes with `"...last_name")`, then ` ilike $N escape ... then 3`.)
    const concatThen3 = /concat\([^)]*first_name[^)]*last_name[^)]*\) ilike \$\d+ escape[^)]*then 3/;
    expect(leadOrder!).toMatch(concatThen3);
    expect(dealOrder!).toMatch(concatThen3);
  });
});

// The picker must DISPLAY the canonical DFW/ATL project number, never the raw deals.deal_number (which is
// the HubSpot import id for HubSpot deals, and a change order's own generated number). This mirrors the
// resolver the field project LIST and NEARBY paths already use — the search path was the one PR #784 missed.
// For dealsOnly=true only the single deal query is awaited, so a queue-returning chainable mock is enough.
function makeDealRowsDb(dealRows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "from", "leftJoin", "where", "orderBy", "limit"]) {
    builder[method] = () => builder;
  }
  builder.then = (resolve: (rows: unknown[]) => unknown) => resolve(dealRows);
  return builder;
}

describe("searchPhotoUploadTargets — canonical recordNumber (never the raw deal_number)", () => {
  const dealRow = (o: Record<string, unknown>) => ({
    id: "d",
    name: "Denton Student Housing Exterior",
    dealNumber: "HS-1",
    projectNumber: null,
    pipelineDisposition: "won",
    stageName: "Won",
    companyName: "B.HOM Student Living",
    lastUpdatedAt: new Date("2026-06-01T00:00:00Z"),
    relevance: 1,
    ...o,
  });

  it("HubSpot-imported deal: recordNumber is the project_number, never the HS- deal_number", async () => {
    const db = makeDealRowsDb([dealRow({ id: "parent", dealNumber: "HS-275293729528", projectNumber: "DFW-1-04726-ab" })]);
    const { targets } = await searchPhotoUploadTargets(db as never, { search: "denton", dealsOnly: true });
    expect(targets.find((t) => t.id === "parent")?.recordNumber).toBe("DFW-1-04726-ab");
  });

  it("change order: recordNumber is the canonical project_number, not its own generated deal_number", async () => {
    const db = makeDealRowsDb([dealRow({ id: "co", dealNumber: "DFW-9-17426-aa", projectNumber: "DFW-1-04726-ab" })]);
    const { targets } = await searchPhotoUploadTargets(db as never, { search: "denton", dealsOnly: true });
    expect(targets.find((t) => t.id === "co")?.recordNumber).toBe("DFW-1-04726-ab");
  });

  it("bid-board deal with empty project_number: falls back to its (non-HS) deal_number", async () => {
    const db = makeDealRowsDb([dealRow({ id: "bb", dealNumber: "DFW-3-16726-aa", projectNumber: null })]);
    const { targets } = await searchPhotoUploadTargets(db as never, { search: "x", dealsOnly: true });
    expect(targets.find((t) => t.id === "bb")?.recordNumber).toBe("DFW-3-16726-aa");
  });

  it("never leaks an HS- prefixed number to the picker (pending resolves to null)", async () => {
    const db = makeDealRowsDb([
      dealRow({ id: "a", dealNumber: "HS-275293729528", projectNumber: "DFW-1-04726-ab" }),
      dealRow({ id: "b", dealNumber: "HS-9999", projectNumber: null }),
    ]);
    const { targets } = await searchPhotoUploadTargets(db as never, { search: "denton", dealsOnly: true });
    for (const t of targets) expect(t.recordNumber ?? "").not.toMatch(/^HS-/i);
  });
});
