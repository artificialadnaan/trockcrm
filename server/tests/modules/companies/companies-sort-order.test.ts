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
});
