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
    // Type is an ENUM cast to ::text so it sorts alphabetically by value, not enum declaration order.
    expect(flatten(buildPropertySortOrder("type", "asc")[0])).toContain("::text");
    expect(flatten(buildPropertySortOrder("type", "asc")[0])).toContain("ASC NULLS LAST");
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

  it("sorts linked_value on the folded derived column, numeric, nulls last", () => {
    // Linked value sorts on the LEFT JOINed dv.linked_value derived column (folded into the main query so
    // the ORDER BY runs over the FULL filtered set before LIMIT), coerced to numeric so it sorts by money
    // value not lexically, with blanks/nulls sunk to the bottom in both directions.
    const asc = buildPropertySortOrder("linked_value", "asc");
    expect(asc).toHaveLength(1);
    expect(flatten(asc[0]!)).toContain("COALESCE(dv.linked_value::numeric, 0)");
    expect(flatten(asc[0]!)).toContain("ASC NULLS LAST");
    expect(flatten(buildPropertySortOrder("linked_value", "desc")[0]!)).toContain("DESC NULLS LAST");
  });

  it("sorts engagement on the folded active-deal count (da.active_cnt), numeric, zeros/nulls last", () => {
    // Engagement is a status from counts; per product it sorts by the active-deal count that drives it —
    // the SAME folded da.active_cnt used for the displayed Active-deals count, so sort == cell.
    const desc = buildPropertySortOrder("engagement", "desc");
    expect(desc).toHaveLength(1);
    expect(flatten(desc[0]!)).toContain("COALESCE(da.active_cnt, 0)");
    expect(flatten(desc[0]!)).toContain("DESC NULLS LAST");
    expect(flatten(buildPropertySortOrder("engagement", "asc")[0]!)).toContain("ASC NULLS LAST");
  });

  it("sorts last_touch on the folded GREATEST(property/lead/deal activity), nulls last", () => {
    // Last touch folds GREATEST(properties.last_activity_at, la.last_activity, da.last_activity) — mirrors
    // buildPropertyLastActivityAt so the sort key equals the displayed value; NULLIF('-infinity') maps a
    // property with no activity anywhere to NULL → NULLS LAST.
    const desc = buildPropertySortOrder("last_touch", "desc");
    expect(desc).toHaveLength(1);
    const sqlText = flatten(desc[0]!);
    expect(sqlText).toContain("GREATEST");
    expect(sqlText).toContain("la.last_activity");
    expect(sqlText).toContain("da.last_activity");
    expect(sqlText).toContain("DESC NULLS LAST");
    expect(flatten(buildPropertySortOrder("last_touch", "asc")[0]!)).toContain("ASC NULLS LAST");
  });
});
