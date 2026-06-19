import { describe, expect, it, vi } from "vitest";
import { buildCompanySortOrder } from "../../../src/modules/companies/service.js";

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

// The leading column reference embedded in the ORDER BY SQL (its DB column name).
function leadingColumnName(value: unknown): string {
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks ?? [];
  for (const c of chunks) {
    if (c && typeof c === "object" && "name" in c && typeof (c as { name: unknown }).name === "string") {
      return (c as { name: string }).name;
    }
  }
  return "";
}

describe("buildCompanySortOrder", () => {
  it("maps each sortBy to the right direct column", () => {
    expect(leadingColumnName(buildCompanySortOrder("name", "asc"))).toBe("name");
    expect(leadingColumnName(buildCompanySortOrder("owner", "asc"))).toBe("display_name"); // users.displayName
    expect(leadingColumnName(buildCompanySortOrder("last_activity", "desc"))).toContain("last_activity");
  });

  it("defaults to company name ascending (preserves the directory's default order)", () => {
    const def = buildCompanySortOrder();
    expect(leadingColumnName(def)).toBe("name");
    expect(flatten(def)).toContain("ASC NULLS LAST");
  });

  it("always sinks nulls last, in both directions", () => {
    expect(flatten(buildCompanySortOrder("owner", "asc"))).toContain("ASC NULLS LAST");
    expect(flatten(buildCompanySortOrder("owner", "desc"))).toContain("DESC NULLS LAST");
    expect(flatten(buildCompanySortOrder("last_activity", "desc"))).toContain("DESC NULLS LAST");
  });

  it("falls back to name for an unknown sortBy", () => {
    expect(leadingColumnName(buildCompanySortOrder("not_a_column", "asc"))).toBe("name");
  });

  // The 4 folded aggregate columns are now sortable over the FULL filtered set via the per-relation
  // derived-table LEFT JOINs (p=properties, ct=contacts, d=deals). The ORDER BY references the derived
  // output columns by name, NUMERIC (not lexical), NULLS LAST in both directions. The asc(companies.id)
  // tiebreak is appended separately by listCompanies' .orderBy() (heavy ties at value 0).
  describe("folded aggregate sort keys", () => {
    it("properties_count → COALESCE(p.cnt, 0), nulls last both directions", () => {
      expect(flatten(buildCompanySortOrder("properties_count", "asc"))).toContain("COALESCE(p.cnt, 0)");
      expect(flatten(buildCompanySortOrder("properties_count", "asc"))).toContain("ASC NULLS LAST");
      expect(flatten(buildCompanySortOrder("properties_count", "desc"))).toContain("DESC NULLS LAST");
    });

    it("contacts_count → COALESCE(ct.cnt, 0), nulls last both directions", () => {
      expect(flatten(buildCompanySortOrder("contacts_count", "asc"))).toContain("COALESCE(ct.cnt, 0)");
      expect(flatten(buildCompanySortOrder("contacts_count", "asc"))).toContain("ASC NULLS LAST");
      expect(flatten(buildCompanySortOrder("contacts_count", "desc"))).toContain("DESC NULLS LAST");
    });

    it("active_deals_count → COALESCE(d.active_cnt, 0), nulls last both directions", () => {
      expect(flatten(buildCompanySortOrder("active_deals_count", "asc"))).toContain("COALESCE(d.active_cnt, 0)");
      expect(flatten(buildCompanySortOrder("active_deals_count", "desc"))).toContain("DESC NULLS LAST");
    });

    it("pipeline_value → NUMERIC (not lexical) cast of d.pipeline, nulls last both directions", () => {
      // The folded pipeline column is ::text; the sort casts it back to numeric so $900 < $1,000
      // (a lexical sort would place '1000' before '900').
      expect(flatten(buildCompanySortOrder("pipeline_value", "desc"))).toContain("COALESCE(d.pipeline::numeric, 0)");
      expect(flatten(buildCompanySortOrder("pipeline_value", "desc"))).toContain("DESC NULLS LAST");
      expect(flatten(buildCompanySortOrder("pipeline_value", "asc"))).toContain("ASC NULLS LAST");
    });
  });
});
