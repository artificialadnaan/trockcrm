import { describe, expect, it, vi } from "vitest";
import {
  buildContactSortOrder,
} from "../../../src/modules/contacts/service.js";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));

function flattenSqlChunks(value: unknown): string {
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.map((chunk) => {
    if (typeof chunk === "string") return chunk;
    if (chunk && typeof chunk === "object" && "value" in chunk) {
      return String((chunk as { value: unknown }).value);
    }
    if (chunk && typeof chunk === "object" && "queryChunks" in chunk) {
      return flattenSqlChunks(chunk);
    }
    return String(chunk);
  }).join(" ");
}

describe("contacts linked_deals_count sorting", () => {
  it("orders by the same COUNT subquery used for the displayed Linked Deals count (DESC NULLS LAST)", () => {
    const sortSql = flattenSqlChunks(buildContactSortOrder("linked_deals_count", "desc"));

    // Sort key IS buildContactLinkedDealsCountSql — byte-identical to the displayed count.
    expect(sortSql).toContain("contact_deal_associations");
    expect(sortSql).toContain("COUNT(*)");
    expect(sortSql).toContain("DESC NULLS LAST");
  });

  it("sinks nulls last on ascending (ASC NULLS LAST)", () => {
    const sortSql = flattenSqlChunks(buildContactSortOrder("linked_deals_count", "asc"));

    expect(sortSql).toContain("contact_deal_associations");
    expect(sortSql).toContain("COUNT(*)");
    expect(sortSql).toContain("ASC NULLS LAST");
  });
});
