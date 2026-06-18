import { describe, expect, it, vi } from "vitest";
import { buildPropertySortOrder } from "../../../src/modules/properties/service.js";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));

function flatten(value: unknown): string {
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object" && "queryChunks" in chunk) return flatten(chunk);
      if (chunk && typeof chunk === "object" && "value" in chunk) return String((chunk as { value: unknown }).value);
      return String(chunk);
    })
    .join(" ");
}

function leadingColumnName(value: unknown): string {
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks ?? [];
  for (const c of chunks) {
    if (c && typeof c === "object" && "name" in c && typeof (c as { name: unknown }).name === "string") {
      return (c as { name: string }).name;
    }
  }
  return "";
}

describe("buildPropertySortOrder", () => {
  it("maps the direct columns to orderable expressions", () => {
    expect(leadingColumnName(buildPropertySortOrder("name", "asc")[0])).toBe("name"); // properties.name
    expect(leadingColumnName(buildPropertySortOrder("type", "asc")[0])).toBe("type");
    // sqft sorts on COALESCE(roof_area, unit_count) so an unset roof area falls back to unit count.
    expect(flatten(buildPropertySortOrder("sqft", "desc")[0])).toContain("COALESCE");
  });

  it("the Owner-company sort is a single ordered expression with nulls last", () => {
    const company = buildPropertySortOrder("company", "asc");
    expect(company).toHaveLength(1);
    expect(flatten(company[0]!)).toContain("ASC NULLS LAST");
  });

  it("no sortBy keeps the natural multi-key order (company → name → address)", () => {
    expect(buildPropertySortOrder(undefined, "asc")).toHaveLength(3);
    expect(buildPropertySortOrder("not_a_column", "asc")).toHaveLength(3);
  });

  it("always sinks nulls last, in both directions", () => {
    expect(flatten(buildPropertySortOrder("name", "asc")[0]!)).toContain("ASC NULLS LAST");
    expect(flatten(buildPropertySortOrder("name", "desc")[0]!)).toContain("DESC NULLS LAST");
    expect(flatten(buildPropertySortOrder("sqft", "desc")[0]!)).toContain("DESC NULLS LAST");
  });
});
