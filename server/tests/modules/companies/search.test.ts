import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: {} as any,
  pool: {} as any,
}));

// Walks a drizzle SQL object into a flat string so we can assert on the columns + literal SQL a
// builder emits, without a live database (mirrors the deals/leads field-set tests).
function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }
  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }
  if ("name" in (value as Record<string, unknown>) && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name;
  }
  return "";
}

describe("buildCompanySearchCondition — unified company search field set", () => {
  it("preserves the legacy companies-list search field (name) — superset, no regression", async () => {
    const { buildCompanySearchCondition } = await import("../../../src/modules/search/unified-search.js");

    const queryText = extractSqlText(buildCompanySearchCondition("acme")).toLowerCase();

    expect(queryText).toContain("name ilike");
  });

  it("adds the intended new fields (address, city, state, domain, website, owner)", async () => {
    const { buildCompanySearchCondition } = await import("../../../src/modules/search/unified-search.js");

    const queryText = extractSqlText(buildCompanySearchCondition("acme")).toLowerCase();

    expect(queryText).toContain("address ilike");
    expect(queryText).toContain("city ilike");
    expect(queryText).toContain("state ilike");
    expect(queryText).toContain("domain ilike");
    expect(queryText).toContain("website ilike");
    // Owner match via EXISTS on public.users (join-independent, so it also works in the COUNT query).
    expect(queryText).toContain("owner_id");
    expect(queryText).toContain("display_name ilike");
  });

  it("escapes LIKE metacharacters and pairs ESCAPE so the term matches literally", async () => {
    const { buildCompanySearchCondition } = await import("../../../src/modules/search/unified-search.js");

    const queryText = extractSqlText(buildCompanySearchCondition("100%")).toLowerCase();

    expect(queryText).toContain("escape");
  });
});
