import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: {} as any,
  pool: {} as any,
}));

// Flattens a drizzle SQL object so we can assert on the columns + literal SQL a builder emits,
// without a live database (mirrors the deals/leads/companies field-set tests).
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

describe("buildContactSearchCondition — unified contact search field set", () => {
  it("preserves every legacy contacts-list search field (superset, no regression)", async () => {
    const { buildContactSearchCondition } = await import("../../../src/modules/search/unified-search.js");

    const queryText = extractSqlText(buildContactSearchCondition("acme")).toLowerCase();

    expect(queryText).toContain("first_name ilike");
    expect(queryText).toContain("last_name ilike");
    expect(queryText).toContain("concat(first_name, ' ', last_name) ilike");
    expect(queryText).toContain("email ilike");
    expect(queryText).toContain("company_name ilike");
    expect(queryText).toContain("phone ilike");
    expect(queryText).toContain("mobile ilike");
    expect(queryText).toContain("job_title ilike");
  });

  it("adds the intended new fields (city + owner display name)", async () => {
    const { buildContactSearchCondition } = await import("../../../src/modules/search/unified-search.js");

    const queryText = extractSqlText(buildContactSearchCondition("acme")).toLowerCase();

    expect(queryText).toContain("city ilike");
    expect(queryText).toContain("owner_id");
    expect(queryText).toContain("display_name ilike");
  });

  it("escapes LIKE metacharacters and pairs ESCAPE so the term matches literally", async () => {
    const { buildContactSearchCondition } = await import("../../../src/modules/search/unified-search.js");

    const queryText = extractSqlText(buildContactSearchCondition("50%")).toLowerCase();

    expect(queryText).toContain("escape");
  });
});
