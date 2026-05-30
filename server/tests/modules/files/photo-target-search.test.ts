import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * Tests for the photo-capture target picker search.
 *
 * The picker (searchPhotoUploadTargets) must let ANYONE find ANY lead/deal to
 * attach photos. Two correctness fixes are covered here:
 *  1. Widened search columns — the picker must match the same columns the main
 *     leads/deals search matches (property address/city/state, contact name,
 *     source), not just name/company/stage. See .audit/trockcam-leads-photos.md.
 *  2. Relevance ordering — a strong (exact/prefix) match must not be hidden
 *     behind merely more-recently-updated weak matches.
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
  type PhotoUploadTarget,
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

  it("matches property address and contact name and source", () => {
    const text = sqlText();
    expect(text).toContain('"properties"."address"');
    expect(text).toContain('"contacts"."first_name"');
    expect(text).toContain('"deals"."source"');
  });
});

describe("sortPhotoTargetsByRelevance", () => {
  const target = (over: Partial<PhotoUploadTarget>): PhotoUploadTarget => ({
    id: over.id ?? "id",
    type: over.type ?? "lead",
    name: over.name ?? "",
    recordNumber: over.recordNumber ?? null,
    stageName: null,
    companyName: null,
    lastUpdatedAt: over.lastUpdatedAt ?? new Date("2024-01-01T00:00:00Z"),
  });

  it("ranks an exact-name match above a more-recently-updated substring match", () => {
    const exactButOld = target({ id: "exact", name: "Acme", lastUpdatedAt: new Date("2020-01-01T00:00:00Z") });
    const substringButRecent = target({ id: "sub", name: "Acme Roofing of Dallas", lastUpdatedAt: new Date("2025-01-01T00:00:00Z") });

    const sorted = sortPhotoTargetsByRelevance([substringButRecent, exactButOld], "Acme");

    expect(sorted.map((t) => t.id)).toEqual(["exact", "sub"]);
  });

  it("ranks a prefix match above a plain substring match", () => {
    const prefix = target({ id: "prefix", name: "Oakwood Plaza" });
    const substring = target({ id: "sub", name: "North Oak Tower" });

    const sorted = sortPhotoTargetsByRelevance([substring, prefix], "Oak");

    expect(sorted.map((t) => t.id)).toEqual(["prefix", "sub"]);
  });

  it("ranks a deal-number match (recordNumber) ahead of a name-only substring match", () => {
    const byNumber = target({ id: "num", type: "deal", name: "Unrelated Deal", recordNumber: "D-1042", lastUpdatedAt: new Date("2020-01-01T00:00:00Z") });
    const byNameSubstring = target({ id: "name", name: "Project 1042 East", lastUpdatedAt: new Date("2025-01-01T00:00:00Z") });

    const sorted = sortPhotoTargetsByRelevance([byNameSubstring, byNumber], "D-1042");

    expect(sorted[0].id).toBe("num");
  });

  it("falls back to most-recently-updated when there is no search term", () => {
    const older = target({ id: "older", name: "Alpha", lastUpdatedAt: new Date("2020-01-01T00:00:00Z") });
    const newer = target({ id: "newer", name: "Beta", lastUpdatedAt: new Date("2025-01-01T00:00:00Z") });

    const sorted = sortPhotoTargetsByRelevance([older, newer], "");

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

  it("orders a non-empty search by relevance (CASE) first, then recency", async () => {
    const { db, orderByCalls } = makeOrderByCapturingDb();

    await searchPhotoUploadTargets(db as never, { search: "oak" });

    expect(orderByCalls.length).toBeGreaterThan(0);
    for (const call of orderByCalls) {
      const text = call.join(" | ");
      expect(text).toContain("case");
      expect(text).toContain("updated_at");
    }
  });
});
