import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: {} as any,
  pool: {} as any,
}));

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

describe("buildPropertySearchCondition — unified property search field set", () => {
  it("matches a property by its own address fields + the owning company name", async () => {
    const { buildPropertySearchCondition } = await import("../../../src/modules/search/unified-search.js");

    const queryText = extractSqlText(buildPropertySearchCondition("downtown")).toLowerCase();

    expect(queryText).toContain("name ilike");
    expect(queryText).toContain("address ilike");
    expect(queryText).toContain("city ilike");
    expect(queryText).toContain("state ilike");
    expect(queryText).toContain("zip ilike");
    expect(queryText).toContain("company_id"); // EXISTS join to companies
    expect(queryText).toContain("escape");
  });
});
